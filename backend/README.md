# Gemini Sync Backend

A self-hosted, **zero-knowledge** sync backend for the Gemini Folders with Backend Sync extension. It stores nothing but opaque, client-side-encrypted blobs — one per Google account — so the server operator (even you) cannot read your projects, notes, prompts, or chats.

## How It Works

- The extension encrypts the entire workspace (projects, subfolders, system prompts, notes, prompt library) locally with **AES-GCM-256**, using a key derived from your passphrase via **PBKDF2 (310,000 iterations, SHA-256)**.
- Only `{ ciphertext, iv, version, updatedAt }` ever leaves your browser.
- The backend stores these blobs in **SQLite (WAL mode)** and enforces **optimistic concurrency**: pushes with a stale `version` are rejected with `409 Conflict` plus the server's current state, letting the client resolve conflicts (newest / merge / keep local / keep remote).
- All requests authenticate with a `Bearer` API key compared in **constant time** (SHA-256 + `crypto.timingSafeEqual`).

## Privacy / GDPR

- **No PII**: account identifiers are client-generated SHA-256 hashes. Raw emails are never sent or stored.
- **No plaintext**: the server never decrypts, parses, or logs payloads.
- **Log hygiene**: `Authorization` headers and client IPs are redacted from Fastify logs.
- **Data sovereignty**: everything lives in a single SQLite file you host.

## API

Base URL: `http://127.0.0.1:3000` (behind your reverse proxy in production). All routes require `Authorization: Bearer <API_KEY>`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/v1/sync/:accountId` | Fetch the encrypted blob. `404` if the account has never pushed. |
| `POST` | `/api/v1/sync/:accountId` | Push `{ version, ciphertext, iv, updatedAt }`. Returns `201`/`200` on success, `409` with `serverState` on stale version. |

`accountId` must be a 64-character lowercase hex string (the client's SHA-256 account hash).

## Configuration

Copy `.env.example` to `.env` and adjust:

```env
PORT=3000
DB_PATH=/app/data/sync.db
API_KEY=change_me_to_a_long_random_secret
LOG_LEVEL=info
```

The `API_KEY` must match the one entered in the extension's Sync Settings modal.

## Run with Docker (recommended)

From the `backend/` directory:

```bash
cp .env.example .env        # then edit API_KEY
docker compose up --build -d
```

- The container binds only to `127.0.0.1:3000` — put Nginx/Caddy with TLS in front for remote access.
- Data persists in `./data/sync.db` (SQLite WAL). Back it up like any file.

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

## Tests

```bash
npx vitest run
```

Covers: 401 without/with bad API key, 404 on unknown account, successful push + round-trip GET, and 409 conflict on stale version.

## Project Layout

```text
backend/
├── Dockerfile                  # Multi-stage build (node:22-alpine)
├── docker-compose.yml          # Loopback-bound deployment
├── .env.example
├── drizzle/                    # Generated migrations
├── data/                       # Persistent SQLite WAL volume
└── src/
    ├── main.ts                 # Fastify bootstrap (10 MB body limit, helmet, CORS)
    ├── app.module.ts
    ├── common/guards/api-key.guard.ts   # Constant-time Bearer validation
    ├── database/               # Drizzle + better-sqlite3 (WAL, busy_timeout 5000)
    └── sync/                   # Controller, service, DTOs, e2e specs
```
