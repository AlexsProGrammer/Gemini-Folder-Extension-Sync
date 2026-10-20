# AI_DOCS.md — Machine contract

Version: 2.1.1

## Local storage keys (webext.storage.local)

| Key | Shape | Owned by | Notes |
| --- | --- | --- | --- |
| `gemini_projects_v1` | `StoredState` | background (`src/background.ts`) | Legacy flat project/chat state; `getState`/`upsertProject`/`moveChat` read/write this. |
| `workspace_${accountHash}` | `WorkspacePayload` (schema v2) | shared (`src/shared/storage.ts`) | Account-partitioned encrypted sync blob. Projects, prompts, tagMeta. |
| `collapsed_folders_${accountHash}` | `string[]` | content (`src/content/index.ts`) | Per-account collapsed folder ids for the sidebar tree. |
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