# AI_DOCS.md — Machine contract

Version: 2.0.7

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

## External calls

- None added: icons are inline SVG, drawer is in-extension shadow DOM, no CDNs.