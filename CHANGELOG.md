# Changelog

## 2.2.0 (Extension) / 0.2.0 (Backend) — Security, Performance & Sync Hardening

### Performance & Memory (Slow-Tab Fixes)
- **Eliminated streaming CPU spikes & layout thrashing:** Debounced `prompts/injector.ts` (250 ms) and `responseFolding.ts` (350 ms, scoped to `main`, without `characterData` or $O(N^2)$ root checks), disconnected `rootObserver` once `sidebarRoot` is mounted, throttled `accountWatcher.ts` and skipped redundant `storage.local` identity writes, and removed `characterData: true` from `composerObserver.ts`.
- **Eliminated scroll/click `TreeWalker` jank:** `cleanupMenuArtifacts()` in `dom/menus.ts` now short-circuits immediately when no menu is open, and `positionMenuToAnchor()` bounds its `requestAnimationFrame` loop.
- **Fixed memory & listener leaks:** Added `destroy()` with `AbortController` cleanup to `createProjectsPanel()` and `createWorkspaceDrawer()` (cleaning up observers, global listeners, `promptStore` subscriptions, and overlay DOM nodes on sidebar re-mount). Fixed stale observer/listener/`setInterval` leaks when re-opening `conflictModal` or `settingsModal`.
- **Reduced render-path overhead:** Cached `featureSettings` in memory and gated Firefox Xray `JSON.parse(JSON.stringify())` sanitization to Firefox content scripts only.

### Sync Reliability, Multi-Tab Coordination & Payload Efficiency
- **Optimistic concurrency & offline conflict detection:** Added `baseVersion` tracking (`sync_meta_${accountHash}` `lastSyncedVersion` + `dirty`) and SQLite `IMMEDIATE` transactions so concurrent or offline edits on two devices never silently overwrite each other.
- **Multi-tab coordination:** Subscribed `index.ts` to `storage.onChanged` for live cross-tab sidebar updates and passphrase-rotation key invalidation, and coordinated sync pulls/pushes with `navigator.locks` to prevent N-tab sync storms.
- **Payload size & bandwidth reduction:** Added pre-encryption `gzip` compression (`CompressionStream`, backward-compatible with uncompressed blobs), conditional `GET` via `ETag` / `If-None-Match` (`304 Not Modified`), canonical `/app/<id>` URL normalization (stopping `/u/<n>/` ping-pong loops), pruning of unassigned/unpinned chats from `workspace.chats`, and moving device-local `uiPrefs` (`gp_ui_prefs_${accountHash}`) and prompt usage stats off the remote sync push path.
- **Conflict resolution & Sync Now fixes:** Fixed the manual "Sync Now" pull/push race, fixed `conflictModal` chat counting for schema v3, paused auto-resolve countdowns in background tabs, refreshed the sidebar immediately after `'merge'` (with `Math.max` version math), and made dismissed conflicts re-openable from the conflict badge.
- **Actionable sync errors & circuit breakers:** Surfaced `429`, `413`, `5xx`, timeout, `permission_denied`, and `decryption_failed` errors in the status badge tooltip/modals, added bounded exponential backoff retries for transient failures, added an auth/passphrase circuit breaker for `401`/`403`/`decryption_failed`, and verified passphrases via `testPassphrase()` on save.

### Security, Permissions & MV3 Proxy
- **Session-first passphrase storage:** Passphrases are now stored in `storage.session` by default (cleared on browser exit) with an explicit opt-in for persistent disk storage; legacy `gemini_sync_config` is deleted immediately after migration.
- **Locked local storage & backup hardening:** Serialized `workspace_${accountHash}` mutations via `navigator.locks` (`withWorkspaceLock`), removed the duplicate drawer `saveWorkspace()` write, validated `accountHash` keys and legacy payloads on backup import, and flushed pending sync pushes before post-import reload.
- **MV3 host permissions & background proxy hardening:** Fixed `{ origins }` argument shape in `webext.ts`, added a dedicated `grant-permission.html` extension page so Chrome and Firefox MV3 host-permission prompts retain user-gesture activation, stopped masking permission IPC failures, validated sender/URL/`accountId` in `background.ts`, removed `Content-Type` from `GET` pulls, added bounded `GET` retries, and re-checked revoked host permissions.
- **Shadow DOM XSS & inspector gating:** Escaped `project.id` and `conversationId` attributes with `escapeAttr()`, enforced a strict Gemini URL allowlist (`sanitizeGeminiUrl()`) on `chat.lastUrl` and navigation, and gated `sidebarInspector.ts` behind debug mode without unsolicited clipboard writes.

### Gemini SPA & Manifest Hygiene
- **MAIN-world SPA navigation bridge:** Added `gp-spa-navigation` event emission in `pageBridge.js` to replace dead isolated-world `history.pushState`/`replaceState` monkey-patches.
- **SPA & DOM edge cases:** Stabilized `responseFolding.ts` keys during streaming and across SPA route changes, fixed Project Instructions pill cleanup, `activeProjectId` clearing, the "New chat in project" auto-assign race, mid-stream reload detection, and `[/Project Instructions]` sentinel parsing. Tightened `getConversationId()`, fixed missed native `isPinned` sync, improved structural selectors, removed the `body *` layout scan, and fixed UTF-8 mojibake.
- **Manifest & package cleanup:** Removed unused `"tabs"` permission, redundant `web_accessible_resources`, dead ChatGPT modules, `gemini-response-fold-lite.js`, `[gp-debug]` wrappers, and API key suffix logging.

### Backend (`0.2.0`)
- Enabled `trustProxy` (default `'127.0.0.1'`, configurable via `TRUST_PROXY`) so per-IP rate limiting works behind nginx, and tightened CORS (`origin: false` by default, or `CORS_ORIGINS` allowlist).
- Added Base64 & length validation on `PushSyncDto` (`iv`, `ciphertext`) and optional `baseVersion` support inside SQLite `IMMEDIATE` transactions.
- Added `ETag` / `If-None-Match` (`304 Not Modified`) support on `GET /api/v1/sync/:accountId`.
- Added loopback `GET /health` endpoint, `PRAGMA synchronous = NORMAL`, fail-closed Drizzle migrations, `ApiKeyRegistry` cleanup, and aligned `docker-compose.yml` default port to `3350`.

## 2.1.1 — Account-Safe Navigation Fix

- **Fixed: "New chat in project/folder" switched the Google account.** The context-menu action performed a hard navigation to the bare `/app` URL. Gemini resolves URLs without the `/u/<n>/` prefix to the browser profile's *default* Google account, so the page fully reloaded and landed on the other logged-in account (Gemini's own new-chat button avoids this via client-side routing). All extension navigation targets now re-apply the active `/u/<n>/` account scope — the new-chat action, panel chat links (including middle/ctrl-click), and stored fallback URLs — so navigating stays inside the account you are working in.

## 2.1.0 — System Prompt Modes, Multi API Keys, Sync-Now Button & Import/Export

- **System prompt injection modes** (Settings → Features): *Automatically add project instructions* prepends the project's system prompt & notes into the composer for new chats in the project (existing behavior, now toggleable), and a new *Show an "Add instructions" button* toggle adds a manual inject button next to the prompt library button in the chat window.
- **Sync now button** — new refresh badge in the panel header triggers an immediate push/pull cycle with the backend, independent of the debounced auto-sync.
- **Multi API keys (backend)** — the backend now supports per-person `API_KEY_<NAME>` keys, each bound to a fixed set of account hashes (or `*` for all). Keys are validated in constant time via SHA-256 digest lookup; a key without an `_ACCOUNTS` binding fails startup (fail-closed). Generate secrets with `openssl rand -base64 32`.
- **Export / Import data** — the Settings modal gained dedicated Export/Import actions for the full multi-account schema (projects, folders, prompts, sync settings). Importing never overwrites account data that already exists on the device.
- **Drag and drop fixed** — dragging chats into folders/projects works again.
- **Prompt Library redesign** — refreshed picker and edit-prompt modal styling with the shared neutral light/dark surfaces and typography.
- **Debug logging toggle** — optional verbose sync logging in settings for diagnosing backend connectivity.
- **Sync fixes** — adding a second device no longer duplicates prompts; sync failures with the backend resolved.
- **Backend & Docker** — fixed SQLite issues on container start, added the production nginx reverse-proxy config (TLS, edge API-key gate, rate limiting, privacy-safe logging), and the `data/` volume is now created with `chown -R 1000:1000` so the container's `node` user can open the database.

## 2.0.8 — Mobile Support (Firefox for Android & Chromium mobile forks)

- New touch-first mobile detection (`src/shared/env.ts`): UA + coarse-pointer + touch + viewport signals; desktop (even with a touchscreen or a narrow window) is never misclassified.
- Sidebar panel on mobile: project/folder/chat action buttons are always visible instead of hover-revealed, 40px rows, larger kebabs/workspace buttons, bigger header badges.
- Dialogs on mobile: create/edit, project details and target picker render as full-width scrollable sheets with a 5-column icon grid; sync settings and conflict dialogs become full-width sheets with 16px inputs (no focus zoom) and safe-area padding.
- Injected items in Gemini's native chat menu use 44px touch targets on mobile (36px on desktop, unchanged).
- Project Workspace drawer goes edge-to-edge on mobile with safe-area padding; toasts are bottom-centered with `env(safe-area-inset-bottom)`.
- Sync lifecycle hardened for mobile: `visibilitychange`/`pagehide` flush pending debounced pushes immediately (no lost edits when backgrounding the tab), and pulls resume on visibility change and `pageshow`, not just window focus.
- Conflict modal countdown now also pauses on touch interaction (2.5s resume), since hover-pause is unavailable on touch devices.

## 2.0.7 — Advanced Project Workspace UI

- Hierarchical sidebar tree now persists per-account collapse state under `collapsed_folders_${accountHash}`; sync pulls and background refreshes no longer collapse opened folders.
- Project/folder context menus gained **Move to…** (reparent into any container or back to root) and **New chat in project** (creates a conversation that is auto-assigned to the project).
- New **Project Workspace drawer**: a slide-over panel per project with a **System Prompt** tab (auto-applied to new chats) and a **Project Notes** tab (local scratchpad). Both fields autosave (400 ms debounce) into the account-partitioned encrypted workspace and trigger the sync push; status badge shows Saving…/Saved.
- System prompts are automatically injected into blank conversations for the active project, with an in-composer "⚡ … Instructions Applied / Remove" pill. Multi-turn conversations are never touched.
- New icons: chevrons, subfolder, notes, and instructions; workspace button on project header rows.

## 2.0.6 — Sync Settings UI, Per-Account Passphrase Switcher & Conflict Modal

- Sync Settings modal with per-account passphrase management and connection status.
- Conflict resolution modal for encrypted-blob merge conflicts.
- Cross-browser manifests (Chromium + Firefox).