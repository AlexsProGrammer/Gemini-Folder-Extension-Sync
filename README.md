# Gemini Folders with Backend Sync

A heavily upgraded fork of [linyushuo0818/gemini-folder-extension](https://github.com/linyushuo0818/gemini-folder-extension) that adds a **zero-knowledge encrypted sync backend**, a hierarchical project workspace, per-project system prompts & notes, and a full cross-browser (Chrome / Firefox / Zen) build pipeline.

> **Credits:** The original extension — local Gemini sidebar projects, folders and prompt library — is by **[linyushuo0818](https://github.com/linyushuo0818/gemini-folder-extension)**. This fork preserves the upstream subtree under `extension/` (tracked at upstream commit `4a2f209`) so future upstream improvements can be merged via `git subtree pull`. The frontend has been substantially extended and a custom self-hosted sync backend was added.

## What's New vs. Upstream

- **Zero-knowledge sync** — your entire workspace is AES-GCM-256 encrypted in the browser (PBKDF2, 310k iterations) before it ever touches your self-hosted NestJS backend. The server only ever sees opaque ciphertext.
- **Multi-account isolation** — every Google account (`/u/0/`, `/u/1/`, …) gets its own SHA-256-hashed, fully partitioned workspace. Raw emails never leave the browser.
- **Hierarchical projects** — nested subfolders (up to 3 levels, capped indentation), collapse state that persists per account, drag-and-drop chats into any folder, and **Move to…** reparenting.
- **Project Workspace drawer** — per-project **System Prompts** (auto-injected into new chats) and freeform **Notes**, debounced autosave, encrypted sync.
- **Conflict resolution modal** — a 4-way resolver (Use Newest / Merge Both / Keep This Device / Keep Other Device) with a 10-second countdown that auto-resolves with "Use Newest" and pauses while you hover.
- **Sync status badge** — live pill in the panel header: Synced / Syncing / Offline / Conflict / Error / Unconfigured.
- **Cross-browser MV3** — one manifest source, dual builds for Chromium (`service_worker`) and Firefox/Zen (`background scripts` + `browser_specific_settings`).
- **Legacy migration** — existing flat projects and prompts from the original extension are auto-migrated into the new per-account hierarchical schema with zero data loss.

## Monorepo Layout

```text
.
├── extension/     # Browser extension (upstream subtree + heavy upgrades)
├── backend/       # Zero-knowledge NestJS (Fastify) sync service + SQLite
└── docker-compose.yml → moved into backend/ for self-contained deploys
```

## Quick Start

### Backend

```bash
cd backend
cp .env.example .env      # set API keys (one per person, see backend/README.md)
docker compose up --build -d
# Listening on 127.0.0.1:3000 — put Nginx/Caddy with TLS in front for remote use
```

See [`backend/README.md`](backend/README.md) for local (non-Docker) setup, migrations, and the API reference.

### Extension

```bash
cd extension
npm install
npm run build:all         # outputs dist/chrome and dist/firefox
```

Then load it:

- **Chrome/Brave/Edge:** `chrome://extensions` → Developer mode → *Load unpacked* → select `extension/dist/chrome`
- **Firefox/Zen:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick any file in `extension/dist/firefox`

### Connecting the Extension to the Backend

1. Open Gemini, click the sync badge (pill) in the projects panel header.
2. Enter your server URL (e.g. `https://sync.example.com`) and **your personal API key** (`API_KEY_<NAME>` from `backend/.env`).
3. Click **Test Connection** to verify reachability and authentication.
4. Set a passphrase (global, or per-account) — this is your encryption key and is **never** sent anywhere. Losing it means losing access to synced data.
5. Hit save; the workspace pushes immediately.

## Feature Overview

### Sync
- Local-first: every change writes locally instantly; pushes are debounced (750 ms) in the background.
- Auto-pull on window focus and on network reconnect; version-based optimistic concurrency with `409`-driven conflict flow.
- Per-account passphrases: one master passphrase or a unique one per Google account, switchable in settings.
- Connection tester distinguishes unreachable server / invalid API key (401) / valid server.
- All network traffic is proxied through the extension background worker (bypasses page CORS/CSP) and targeted strictly at your configured server — no telemetry, ever.

### Workspace UI
- Collapsible nested subfolders with persistent collapse state per account.
- Workspace drawer (slide-over) per project with autosaving System Prompt & Notes tabs.
- Prompt Library: save, search, edit, and insert reusable prompts.
- Project icons/colors, pinning, backups/import-export of the full multi-account schema.

### System Prompt Injection
- New blank conversations in a project automatically receive the project's system prompt in the composer.
- In-composer pill shows "Instructions Applied" with a one-click Remove.
- Ongoing multi-turn conversations are never injected (idempotent).

## Privacy & GDPR

- Zero-knowledge: plaintext never leaves the browser; backend receives only Base64 ciphertext + IV.
- Account anonymization: storage keys and sync IDs use locally computed SHA-256 hashes of account identifiers.
- No external CDNs, fonts, trackers, or third-party network calls in the extension.
- Backend redacts auth headers and client IPs from logs; data stays in one SQLite file you host.

## Development

```bash
# Typecheck + tests
cd extension && npx tsc --noEmit
cd backend   && npx tsc --noEmit && npx vitest run

# Build both browser targets
cd extension && npm run build:all
```

### Updating the Upstream Subtree

```bash
git remote add upstream https://github.com/linyushuo0818/gemini-folder-extension.git
git subtree pull --prefix=extension upstream main --squash
```

## License

See [`LICENSE`](LICENSE). Original extension © linyushuo0818; fork modifications as committed in this repository.
