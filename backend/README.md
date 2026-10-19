# Gemini Sync Backend

A self-hosted, **zero-knowledge** sync backend for the Gemini Folders with Backend Sync extension. It stores nothing but opaque, client-side-encrypted blobs — one per Google account — so the server operator (even you) cannot read your projects, notes, prompts, or chats.

## Install

The backend is meant to run on a machine that is **online 24/7 and reachable from all your devices** — a VPS, or an always-on home server with a **public IP or a domain** (with Nginx/Caddy providing TLS in front, see below). It binds to loopback only; never expose the raw port to the internet.

### 1. Requirements

- Docker + Docker Compose (or Node.js 22+ for a non-Docker run)
- A domain with DNS pointing at the machine (recommended) — e.g. `sync.example.com`

### 2. Configure API keys (`.env`)

```bash
cd backend
cp .env.example .env
```

Generate one secret per person with:

```bash
openssl rand -base64 32
```

Paste each generated string into `.env` as a named key (see [The `.env` File & API Keys](#the-env-file--api-keys) below for the full variable layout). At minimum, replace the placeholder values for `API_KEY` or define `API_KEY_YOURNAME` + `API_KEY_YOURNAME_ACCOUNTS`.

### 3. Create the data directory

```bash
mkdir -p data
sudo chown -R 1000:1000 ./data
```

The container runs as user `node` (uid/gid **1000**) and `./data` is a bind mount. If the directory is not writable by uid 1000, SQLite fails on boot with `unable to open database file` (`SQLITE_CANTOPEN`).

### 4. Start the container

```bash
docker compose up --build -d
docker compose logs -f        # verify startup, then Ctrl+C
```

With the shipped `.env.example` the service listens on **`127.0.0.1:3350`** (change `PORT` in `.env` if you like — keep the Nginx upstream in sync). Only loopback is exposed, so the backend is unreachable from the outside until you put a reverse proxy in front of it.

### 5. Nginx TLS reverse proxy (for remote access)

The repo ships a production-ready config: [`nginx/gemini-folder-sync.config`](nginx/gemini-folder-sync.config) — HTTP→HTTPS redirect, TLS 1.2/1.3 with Mozilla intermediate settings, HSTS, an edge API-key header gate, a strict `GET|POST /api/v1/sync/<64 hex>`-only route table, per-IP rate limiting, and privacy-safe access logs (no client IPs, no query strings, never logs the `Authorization` header).

Install it (Debian/Ubuntu):

```bash
sudo cp nginx/gemini-folder-sync.config /etc/nginx/sites-available/gemini-folder-sync.conf
sudo ln -s /etc/nginx/sites-available/gemini-folder-sync.conf /etc/nginx/sites-enabled/
sudo nano /etc/nginx/sites-available/gemini-folder-sync.conf   # replace every sync.example.com with your domain
```

Obtain a certificate and reload:

```bash
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d sync.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Notes:

- The config is written for nginx's `http {}` context (it uses `map`, `limit_req_zone`, `upstream`) — that is why it lives in `sites-available` as a plain include, and why the file suffix must be `.conf` when placed in `conf.d`-style setups.
- No secrets are needed in the nginx file. The backend validates API keys from `backend/.env` itself; nginx only checks that a `Bearer` header is present (defense in depth) and enforces the route allowlist.
- The upstream is hard-coded to `127.0.0.1:3350` — the default with the shipped `.env.example`. If you change `PORT` in `.env`, change it here too.
- Enable HSTS only after HTTPS is confirmed working (it pins browsers to HTTPS for two years).
- For Caddy users the equivalent is a two-line Caddyfile entry proxying to `127.0.0.1:3350` — Caddy handles certificates automatically.

Your sync URL is now `https://sync.example.com`. Enter it plus your personal API key in the extension's Sync Settings (panel header → sync badge).

## The `.env` File & API Keys

The backend reads its entire configuration from `backend/.env`, which is passed into the container via `env_file` in [`docker-compose.yml`](docker-compose.yml). Variables:

```env
PORT=3350                     # listen port (must match the reverse-proxy upstream)
DB_PATH=/app/data/sync.db     # SQLite file inside the container (bind-mounted ./data)
LOG_LEVEL=info                # Fastify log level

API_KEY=<secret>              # legacy single key; allowed on ALL accounts

API_KEY_ALICE=<secret>        # per-person bearer token
API_KEY_ALICE_ACCOUNTS=0000…0 # which account hashes this key may access
API_KEY_BOB=<secret>
API_KEY_BOB_ACCOUNTS=*        # * = all accounts (server owner)
```

How the key registry works — the backend scans the environment for `API_KEY_*` variables at startup:

- `API_KEY_<NAME>=<secret>` — the bearer token this person enters in the extension. The `<NAME>` label is for your own bookkeeping/audit only; it is never sent by clients.
- `API_KEY_<NAME>_ACCOUNTS` — which `accountId` hash(es) the key may access: `*` for all accounts (server owner), or a comma-separated list of 64-char hex account hashes (shown in the extension's sync settings modal). Every named key **must** have this variable, otherwise startup fails (fail-closed).
- Keys are compared in **constant time** via SHA-256 digest lookup (see `src/common/guards/api-key.registry.ts`).
- The legacy `API_KEY` remains valid and is allowed on all accounts; remove it once everyone has a named key.
- Account hashes are client-generated SHA-256 digests — each Google account gets its own blob, and a person's key can only touch the blobs it is bound to.

Generate all secrets with `openssl rand -base64 32`. Rotating or revoking a key is an edit to `.env` plus `docker compose restart` — no database changes, and nginx never needs touching.

## How It Works

- The extension encrypts the entire workspace (projects, subfolders, system prompts, notes, prompt library) locally with **AES-GCM-256**, using a key derived from your passphrase via **PBKDF2 (310,000 iterations, SHA-256)**.
- Only `{ ciphertext, iv, version, updatedAt }` ever leaves your browser.
- The backend stores these blobs in **SQLite (WAL mode)** and enforces **optimistic concurrency**: pushes with a stale `version` are rejected with `409 Conflict` plus the server's current state, letting the client resolve conflicts (newest / merge / keep local / keep remote).
- All requests authenticate with a `Bearer` API key compared in **constant time** (SHA-256 digest lookup). Multiple per-person keys are supported, each bound to a fixed set of account hashes (or all accounts).

## Privacy / GDPR

- **No PII**: account identifiers are client-generated SHA-256 hashes. Raw emails are never sent or stored.
- **No plaintext**: the server never decrypts, parses, or logs payloads.
- **Log hygiene**: `Authorization` headers and client IPs are redacted from Fastify logs; the shipped nginx config applies the same policy at the edge.
- **Data sovereignty**: everything lives in a single SQLite file you host.

## API

Base URL: `http://127.0.0.1:3350` locally (your HTTPS domain behind the reverse proxy in production). All routes require `Authorization: Bearer <API_KEY>`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/v1/sync/:accountId` | Fetch the encrypted blob. `404` if the account has never pushed. |
| `POST` | `/api/v1/sync/:accountId` | Push `{ version, ciphertext, iv, updatedAt }`. Returns `201`/`200` on success, `409` with `serverState` on stale version. |

`accountId` must be a 64-character lowercase hex string (the client's SHA-256 account hash). Keys bound to a subset of accounts get `403` on accounts outside their binding.

## Run Locally (Node 22+)

```bash
npm install
npm run build
API_KEY=my_secret npm start          # or: node dist/main.js
```

Development with hot reload:

```bash
npm run start:dev
```

## Database Migrations

Schema is managed with Drizzle Kit:

```bash
npm run db:generate    # generate migration SQL into ./drizzle
npm run db:migrate     # apply migrations
```

The table is also auto-created on boot if missing.

## Backups

Everything lives in `backend/data/sync.db` (SQLite WAL). Stop the container (`docker compose stop`), copy the `data/` directory (or the single `.db` file plus `-wal`/`-shm` sidecars), and start it again.

## Tests

```bash
npx vitest run
```

Covers: 401 without/with bad API key, 404 on unknown account, successful push + round-trip GET, 409 conflict on stale version, plus per-key account authorization (403 on unbound accounts, wildcard key access) and the API key registry itself.

## Project Layout

```text
backend/
├── Dockerfile                  # Multi-stage build (node:22-alpine), runs as uid 1000
├── docker-compose.yml          # Loopback-bound deployment, passes the whole .env through
├── .env.example
├── drizzle/                    # Generated migrations
├── data/                       # Persistent SQLite WAL volume (chown 1000:1000)
├── nginx/gemini-folder-sync.config   # Production reverse proxy (TLS, edge key gate, rate limits)
└── src/
    ├── main.ts                 # Fastify bootstrap (10 MB body limit, helmet, CORS)
    ├── app.module.ts
    ├── common/guards/api-key.guard.ts            # Constant-time Bearer validation
    ├── common/guards/api-key.registry.ts         # API_KEY_* env scan + per-key account bindings
    ├── database/               # Drizzle + better-sqlite3 (WAL, busy_timeout 5000)
    └── sync/                   # Controller, service, DTOs, e2e specs
```
