# AI_DOCS.md — Machine contract

Version: 2.2.0 (Extension) / 0.2.0 (Backend)

## Local storage keys (webext.storage.local & storage.session)

| Key | Shape | Owned by | Notes |
| --- | --- | --- | --- |
| `gemini_projects_v1` | `StoredState` | background (`src/background.ts`) | Legacy flat project/chat state; `getState`/`upsertProject`/`moveChat` read/write this. |
| `workspace_${accountHash}` | `WorkspacePayload` (schema v3) | shared (`src/shared/storage.ts`) | Account-partitioned encrypted sync blob. Projects, prompts, assigned/pinned chats, tagMeta. Mutations serialized via `withWorkspaceLock()`. |
| `sync_meta_${accountHash}` | `{ lastSyncedVersion, dirty, etag? }` | shared (`src/shared/storage.ts`) | Per-account sync metadata for `baseVersion` concurrency, offline conflict detection, and conditional `GET` (`If-None-Match`). |
| `gp_ui_prefs_${accountHash}` | `{ projectsCollapsed, foldersCollapsed }` | shared (`src/shared/storage.ts`) | Device-local sidebar UI preferences (kept off the remote sync push path). |
| `collapsed_folders_${accountHash}` | `string[]` | content (`src/content/index.ts`) | Per-account collapsed folder ids for the sidebar tree. |
| `gemini_sync_settings` | `SyncSettings` | shared (`src/shared/storage.ts`) | Server URL, API key, opt-in disk passphrase flag (`rememberPassphraseOnDisk`). Legacy `gemini_sync_config` is deleted upon migration. |
| `gemini_sync_session_passphrases` | `{ globalPassphrase, accountPassphrases }` | shared (`src/shared/storage.ts`) | Stored in `storage.session` by default (cleared on browser exit) unless `rememberPassphraseOnDisk` is enabled. |
| `gp_pending_new_chat_project` | `string` (sessionStorage) | content (`src/content/index.ts`) | Survives the full page navigation used by "New chat in project". |

## Workspace project fields (extended)

`Project` gained `systemPrompt?: string` and `notes?: string`. Both are optional, plaintext locally, ciphertext at rest in the sync blob. Written via the Project Workspace drawer (`storage.updateProjectMetadata` path through `saveWorkspace`); also mirrored into `StoredState` via `upsertProject` for sidebar badges.

## Runtime message types (background)

- `upsertProject` — accepts the extended `Project` (parentId, systemPrompt, notes, order).
- No new message types added in 2.0.7; reparenting reuses `upsertProject`.

## Content-script hooks

- `initComposerObserver(callbacks)` — `src/content/dom/composerObserver.ts`. `onNewChatReady(composer)` fires once per blank conversation; `onConversationChanged(id|null)` on navigation. Never fires for conversations with user turns.
- `injectProjectInstructions(composer, systemPrompt, projectName)` / `removeProjectInstructions(composer)` — `src/content/prompts/injector.ts`.
- `formatProjectInstructionPrefix(systemPrompt)` — `src/content/prompts/composer.ts`.
- Synthetic events dispatched for programmatic composer writes: `beforeinput`, `input`, `change` (all `bubbles: true`).

## UI handles

- `createProjectsPanel` returns `setActiveProject(projectId|null)` and `getActiveProjectId()` in addition to previous methods.
- `src/content/ui/workspaceDrawer.ts` exports `createWorkspaceDrawer(options)` with `open(project)`, `close()`, `isOpen()`.
- `createTargetPickerModal` additionally returns `openReparent(projectId, projects, onPick)`.

## Feature settings (2.1.0)

| Key | Shape | Owned by | Notes |
| --- | --- | --- | --- |
| `gp_feature_settings` | `{ autoApplyProjectInstructions: boolean, showInstructionsButton: boolean, debugLogging: boolean }` | shared (`src/shared/storage.ts`) read/written by the settings modal | Defaults: auto `true`, button `false`, debug `false`. Changes dispatch `gemini-projects:feature-settings-changed` (`CustomEvent` with the normalized settings as `detail`). |

- `autoApplyProjectInstructions` — auto-prepend the project's system prompt & notes into the composer.
- `showInstructionsButton` — show the manual "Add instructions" header button in project chats (`configureInstructionsButton` / `setInstructionsButtonVisible`).

## Account-scoped URLs (2.1.1)

- `src/shared/account.ts` exports `withActiveAccountScope(href)`: re-applies the active `/u/<index>/` account prefix (from `window.location.pathname`) to extension-generated navigation targets. Rules: same-origin absolute URLs and paths without a `/u/N/` segment get the current prefix; anything already scoped is returned unchanged; different-origin URLs are never touched.
- Used by `navigateToNewChat()` (`src/content/index.ts`), the `lastUrl` fallback in `syncNativeChatsFromDom()`, and the panel chat-row href fallback + `navigateToProjectChat()` (`src/content/ui/projectsPanel.ts`). Rationale: a bare `/app` URL is resolved by Google to the profile's *default* Google account, so hard-navigating to one switches accounts.

## Mobile environment detection (2.0.8)

- `src/shared/env.ts` exports `isMobileEnvironment()` / `isMobileLayout()` / `hasTouchInput()`; true only for touch-first devices (UA mobile + coarse pointer, or coarse pointer + touch + ≤720px viewport).
- The panel and overlay shadow hosts receive a `.gp-mobile` class (toggled in `projectsPanel.attachThemeObserver`, together with `.dark`); all mobile CSS in the panel/overlay/drawer is keyed on `:host(.gp-mobile)`. The page-level settings/conflict modals add a `gp-mobile` class on their root element instead.
- `syncEngine.flushPendingPushes()` runs all pending debounced pushes immediately; called from the content script on `visibilitychange → hidden` and `pagehide`.

## External calls

- None added: icons are inline SVG, drawer is in-extension shadow DOM, no CDNs.

## Sync Contract & Security Hardening (2.2.0 / 0.2.0)

- **Optimistic concurrency (`baseVersion`):** `EncryptedSyncEnvelope` and `PushSyncDto` accept an optional `baseVersion` (`number >= 0`). Backend `SyncService.upsertBlob()` runs inside a SQLite `IMMEDIATE` transaction and returns `409 Conflict` when `existing.version !== dto.baseVersion` or `dto.version <= existing.version`.
- **Conditional `GET` (`ETag` / `304`):** `GET /api/v1/sync/:accountId` returns `ETag: "v<version>-<updatedAt>"` and `304 Not Modified` when `If-None-Match` matches.
- **Pre-encryption compression:** `encryptWorkspace()` compresses UTF-8 JSON with `CompressionStream('gzip')` (when available) before AES-GCM-256 encryption; `decryptWorkspace()` supports both gzip-compressed and legacy uncompressed payloads.
- **URL & DOM sanitization:** `sanitizeGeminiUrl()` (`src/shared/schemas.ts`) restricts `chat.lastUrl` and navigation targets to relative `/...` paths or `https://gemini.google.com` origins. Synced `chat.lastUrl` is normalized to `/app/<id>` without `/u/<n>/` prefixes; `withActiveAccountScope()` re-applies the active `/u/<n>/` prefix at render/navigation time.
- **SPA navigation bridge:** `public/pageBridge.js` (`world: "MAIN"`, `document_start`) wraps `history.pushState`/`replaceState` and dispatches `gp-spa-navigation` (`CustomEvent<{ href }>`), consumed via `onSpaNavigation()` (`src/content/dom/spaNavigation.ts`).
- **Host permission grant flow:** `grant-permission.html` (`src/grantPermission.ts`) requests optional host permissions synchronously on button click to preserve user-gesture activation in Chrome & Firefox MV3.
- **Instruction block sentinel:** `formatProjectInstructionPrefix()` uses `[/Project Instructions]` (`PROJECT_INSTRUCTIONS_END_MARKER`) as the closing delimiter (with legacy `\n]` fallback).
- **Lifecycle & manifest hygiene:** `createProjectsPanel()` and `createWorkspaceDrawer()` expose `destroy()` backed by `AbortController`. Unused `"tabs"` permission, redundant `web_accessible_resources`, dead `chatgpt/` modules, `messageTimestamps.ts`, and `gemini-response-fold-lite.js` were removed; `sidebarInspector.ts` is gated behind `debugLogging`.
- **Backend endpoints & config:** Added unauthenticated loopback `GET /health` (`{ status: 'ok' }`), `TRUST_PROXY` (default `'127.0.0.1'`), `CORS_ORIGINS` (default `false`), `PRAGMA synchronous = NORMAL`, and fail-closed Drizzle migrations.