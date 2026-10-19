# Gemini Folders with Backend Sync

A heavily upgraded fork of [linyushuo0818/gemini-folder-extension](https://github.com/linyushuo0818/gemini-folder-extension) that adds a **zero-knowledge encrypted sync backend**, a hierarchical project workspace, per-project system prompts & notes, and a full cross-browser (Chrome / Firefox / Zen) build pipeline.

> **Credits:** The original extension — local Gemini sidebar projects, folders and prompt library — is by **[linyushuo0818](https://github.com/linyushuo0818/gemini-folder-extension)**. This fork preserves the upstream subtree under `extension/` (tracked at upstream commit `4a2f209`) so future upstream improvements can be merged via `git subtree pull`. The frontend has been substantially extended and a custom self-hosted sync backend was added.

## Installation

### 1. Browser extension

Build both targets once (`extension/dist/chrome` and `extension/dist/firefox`):

```bash
cd extension
npm install
npm run build:all
```

- **Firefox (desktop) / Zen:** the `.xpi` can be installed directly through the browser's extension settings — open `about:addons` → gear icon → *Install Add-on From File…* and pick the signed `.xpi`. Unsigned builds only load temporarily via `about:debugging#/runtime/this-firefox`; to get a permanently installable, signed `.xpi`, follow [`FIREFOX_SIGNING.md`](FIREFOX_SIGNING.md).
- **Chrome / Chromium (Chrome, Brave, Edge):** Chrome cannot install extensions from files outside the Web Store, so the build has to be loaded unpacked: open `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `extension/dist/chrome`.

### 2. Sync backend (optional)

Without the backend the extension still works — fully locally. If you want encrypted multi-device sync, the backend needs to run on a machine that is **online 24/7 and reachable from all your devices**: a VPS or an always-on home server with a **public IP or a domain** (put Nginx/Caddy with TLS in front for remote access).

Full step-by-step setup — Docker, Nginx, API keys and the `.env` file — lives in [`backend/README.md`](backend/README.md).

## What's New vs. Upstream

- **Zero-knowledge sync** — your entire workspace is AES-GCM-256 encrypted in the browser (PBKDF2, 310k iterations) before it ever touches your self-hosted NestJS backend. The server only ever sees opaque ciphertext.
- **Multi-account isolation** — every Google account (`/u/0/`, `/u/1/`, …) gets its own SHA-256-hashed, fully partitioned workspace. Raw emails never leave the browser.
- **Hierarchical projects** — nested subfolders (up to 3 levels, capped indentation), collapse state that persists per account, drag-and-drop chats into any folder, and **Move to…** reparenting.
- **Project Workspace drawer** — per-project **System Prompts** and freeform **Notes**, debounced autosave, encrypted sync. Injection is configurable: **auto** (prepended into the composer of every new chat in the project) and/or a manual **"Add instructions" button** next to the prompt-library button in the chat window.
- **Multi API keys** — the backend supports one bearer key per person, each bound to a fixed set of account hashes (or all accounts), validated in constant time; keys are generated with `openssl rand -base64 32`.
- **Import / Export** — the settings modal can export the full multi-account schema (projects, folders, prompts, sync settings) to a file and import it again; importing never overwrites account data that already exists on the device.
- **Conflict resolution modal** — a 4-way resolver (Use Newest / Merge Both / Keep This Device / Keep Other Device) with a 10-second countdown that auto-resolves with "Use Newest" and pauses while you hover.
- **Sync status badge** — live pill in the panel header: Synced / Syncing / Offline / Conflict / Error / Unconfigured.
- **Cross-browser MV3** — one manifest source, dual builds for Chromium (`service_worker`) and Firefox/Zen (`background scripts` + `browser_specific_settings`).
- **Mobile support** — touch-first adaptation for Firefox for Android and Chromium mobile forks (Kiwi/Lemur/Mises/Edge …): always-visible row actions, larger touch targets, full-width dialogs and sheets, safe-area toasts, and visibility-based sync resume. Desktop behavior is unchanged.
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
cp .env.example .env
# generate one API key per person (the printed string is a ready-to-use key):
openssl rand -base64 32
mkdir -p data
sudo chown -R 1000:1000 ./data   # container runs as uid/gid 1000 (node); without this SQLite fails to open the DB
docker compose up --build -d
# Listening on 127.0.0.1:3350 (PORT in .env) — put Nginx/Caddy with TLS in front for remote use
```

See [`backend/README.md`](backend/README.md) for the detailed install (Docker, Nginx, `.env`/API keys), local (non-Docker) setup, migrations, and the API reference.

### Extension

```bash
cd extension
npm install
npm run build:all         # outputs dist/chrome and dist/firefox
```

Then load it:

- **Chrome/Brave/Edge (desktop):** `chrome://extensions` → Developer mode → *Load unpacked* → select `extension/dist/chrome`
- **Firefox/Zen (desktop):** install the signed `.xpi` via `about:addons` → *Install Add-on From File…* (see [`FIREFOX_SIGNING.md`](FIREFOX_SIGNING.md)), or load an unsigned build temporarily via `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick any file in `extension/dist/firefox`

### Mobile

The same builds run on mobile browsers that support WebExtensions:

- **Firefox for Android:** load `dist/firefox` via `web-ext run --target=firefox-android`, or install a signed build (self-distribution) — see [`FIREFOX_SIGNING.md`](FIREFOX_SIGNING.md). Requires Firefox 121+.
- **Chromium forks (Kiwi, Lemur, Mises, Edge Canary, …):** install `dist/chrome` through the browser's own extension page/ZIP install. Plain Chrome for Android does not support extensions.

On touch devices the extension automatically switches to a mobile-tuned UI (detected via touch/pointer/UA signals — never on desktop): project/chat action buttons are always visible instead of hover-revealed, rows and menus use larger touch targets, the create/settings/conflict dialogs become full-width sheets, the workspace drawer goes edge-to-edge, toasts respect safe-area insets, and pending sync pushes are flushed immediately when the tab is backgrounded.

### Connecting the Extension to the Backend

1. Open Gemini, click the sync badge (pill) in the projects panel header.
2. Enter your server URL (e.g. `https://sync.example.com`) and **your personal API key** (`API_KEY_<NAME>` from `backend/.env`).
3. Click **Test Connection** to verify reachability and authentication.
4. Set a passphrase (global, or per-account) — this is your encryption key and is **never** sent anywhere. Losing it means losing access to synced data.
5. Hit save; the workspace pushes immediately. A refresh badge ("Sync now") next to the status pill triggers an immediate push/pull on demand.

### Multi API Keys

The backend supports one API key per person instead of a single shared secret. Each key is defined in `backend/.env` as `API_KEY_<NAME>` plus an `API_KEY_<NAME>_ACCOUNTS` binding that limits which account blobs the key may read/write (`*` = all accounts, e.g. for the server owner):

```env
API_KEY_ALICE=AbCdEf123456...          # openssl rand -base64 32
API_KEY_ALICE_ACCOUNTS=0000...00,1111...11
API_KEY_BOB=GhIjKl987654...
API_KEY_BOB_ACCOUNTS=*
```

- Generate every secret with `openssl rand -base64 32`.
- Every named key **must** have its `_ACCOUNTS` binding or the backend refuses to start (fail-closed).
- Each person enters only their own key in the extension's Sync Settings — so one person's key can never touch another person's workspace, even though all data lives in the same SQLite file.
- The legacy single `API_KEY` (allowed on all accounts) keeps working; remove it once everyone has a named key.

Details and the full key registry behavior: [`backend/README.md`](backend/README.md).

## Feature Overview

### Sync
- Local-first: every change writes locally instantly; pushes are debounced (750 ms) in the background.
- Auto-pull on window focus and on network reconnect; version-based optimistic concurrency with `409`-driven conflict flow.
- **Sync now** button in the panel header forces an immediate push/pull cycle.
- Per-account passphrases: one master passphrase or a unique one per Google account, switchable in settings.
- Multi API keys: one bearer key per person, each restricted to its bound account hashes; the legacy single key still works.
- Connection tester distinguishes unreachable server / invalid API key (401) / valid server; optional debug logging for diagnosing connectivity.
- All network traffic is proxied through the extension background worker (bypasses page CORS/CSP) and targeted strictly at your configured server — no telemetry, ever.

### Workspace UI
- Collapsible nested subfolders with persistent collapse state per account.
- Drag-and-drop chats into any folder/project (plus **Move to…** reparenting).
- Workspace drawer (slide-over) per project with autosaving System Prompt & Notes tabs.
- Prompt Library: save, search, edit, and insert reusable prompts.
- Project icons/colors, pinning, and Export/Import of the full multi-account schema (import never overwrites account data that already exists on the device).

### System Prompt Injection
- Two independent modes, both toggleable in Settings → Features: **Auto** (new blank conversations in a project automatically receive the project's system prompt in the composer) and **Button** (a manual "Add instructions" button next to the prompt-library button in the chat window).
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
