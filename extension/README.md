# Synced Projects for Gemini

Add local Projects, a Prompt Library, and encrypted multi-device sync to Gemini.

English

> Fork of [linyushuo0818/gemini-folder-extension](https://github.com/linyushuo0818/gemini-folder-extension) — the original local Projects & Prompt Library extension — heavily extended with hierarchical workspaces, per-project System Prompts & Notes, and zero-knowledge encrypted sync to your own backend.

## What It Does

Gemini Projects helps you organize Gemini chats into local project folders in the sidebar. It is useful when you work across topics, clients, classes, writing projects, research threads, or anything else that needs a cleaner history than one long chat list.

It also includes a local Prompt Library, so you can save prompts you reuse often and insert them quickly while writing in Gemini.

## Highlights

- Create local Projects in the Gemini sidebar
- **Nested subfolders** inside projects and folders (up to 3 levels), with collapsible trees whose expand/collapse state persists per Google account
- **Move to…** context action to reparent projects and folders, and drag-and-drop chats into any subfolder
- Move existing chats into Projects
- Remove a chat from a Project without deleting the original Gemini chat
- See when a Project chat is missing because it was deleted from Gemini history on another device
- Choose Project icons and colors
- Use the compact Project menu to pin, edit, or delete a Project. Pinned Projects stay above other Projects after reload; unpinning restores their original order.
- Back up and restore your local Projects and prompts
- Save, search, edit, and reuse prompts from a local Prompt Library
- Keep your organization data in browser-local storage

## Project Workspace (New)

Every project now has a **Workspace drawer** (open it via the instructions icon on a project row):

- **System Prompt** — freeform instructions that are automatically injected into the composer when you start a new chat inside the project. An in-composer pill confirms "Instructions Applied" with a one-click Remove; ongoing multi-turn conversations are never touched.
- **Project Notes** — a freeform scratchpad for references, outlines, and links. Both fields autosave 400 ms after you stop typing and are included in encrypted sync.

## Encrypted Multi-Device Sync (New)

Optional, self-hosted, zero-knowledge sync of your entire workspace across devices and browsers:

- **How it works** — the workspace (projects, subfolders, notes, system prompts, prompt library) is encrypted in the browser with AES-GCM-256 using a key derived from your passphrase (PBKDF2, 310,000 iterations, SHA-256). Only opaque ciphertext and IV are sent to the server — the backend can never read your data, and your passphrase is never transmitted or stored.
- **Multi-account isolation** — each Google account (`/u/0/`, `/u/1/`, …) gets its own workspace, identified only by a locally computed SHA-256 hash. Raw email addresses never leave the browser.
- **Local-first** — every change saves locally immediately; pushes are debounced (750 ms) in the background. Pulls happen automatically on window focus and on network reconnect.
- **Conflict resolution** — when two devices change the same workspace, a modal offers *Use Newest*, *Merge Both*, *Keep This Device*, or *Keep Other Device*. A 10-second countdown auto-resolves with "Use Newest" and pauses while you hover.
- **Sync status badge** — a live pill in the panel header shows Synced / Syncing / Offline / Conflict / Error / Unconfigured; click it to open settings.
- **Header badges** — the panel header carries three pills: **Prompts** (opens the prompt library with a live count of saved prompts), **Config** (sync settings) and **Settings** (backup/restore and local-data wipe).
- **Settings** — server URL, API key, a Test Connection button (distinguishes unreachable server vs. invalid key), and a global-or-per-account passphrase switcher with masked inputs and reveal toggles.
- **No telemetry** — network requests go only to the server URL you configure. No external CDNs, fonts, or trackers are ever contacted.

To use sync you need a backend; see the repository root README and `backend/README.md` for a one-command Docker setup. Without a backend the extension works exactly as before, fully locally.

## Cross-Browser Builds

- `npm run build:chrome` → `dist/chrome` (Chromium: Chrome, Brave, Edge)
- `npm run build:firefox` → `dist/firefox` (Firefox & Zen Browser)
- `npm run build:all` → both

## Mobile Support (New)

The extension also runs on mobile browsers that support WebExtensions — **Firefox for Android** (121+, use `dist/firefox`) and **Chromium mobile forks with extension support** such as Kiwi, Lemur, Mises or Edge Canary (use `dist/chrome`; plain Chrome for Android does not support extensions).

On touch-first devices the UI automatically adapts (detected via UA, touch and pointer signals; desktop behavior is never altered):

- Project/folder/chat action buttons are **always visible** instead of hover-revealed.
- Larger touch targets: 40px rows, 36px row actions, 44px menu items, 32px header badges.
- Create/edit, project-details and picker dialogs render as **full-width scrollable sheets**; the icon grid wraps to 5 columns per row.
- The **Sync settings** and **conflict resolution** dialogs become full-width bottom-sheet-like dialogs with 16px inputs (no focus zoom) and safe-area padding; conflict countdown also pauses on touch.
- The **Project Workspace drawer** goes edge-to-edge with safe-area padding.
- Toasts are bottom-centered and respect `env(safe-area-inset-bottom)`.
- Sync is mobile-robust: pulls resume on `visibilitychange`/`pageshow` (not just window focus), and pending debounced pushes are flushed immediately when the tab is hidden or unloaded so app switching never loses edits.

Everything else — encryption, per-account workspaces, hierarchy, prompt library and injection — behaves identically to desktop.

## Install (from source)

1. Build: `npm install && npm run build:all`.
2. Open `chrome://extensions` (or Zen/Firefox `about:debugging#/runtime/this-firefox`).
3. Enable `Developer mode`.
4. Click `Load unpacked` (Chrome) or `Load Temporary Add-on` (Firefox/Zen).
5. Select `dist/chrome` or `dist/firefox`.

## Install from Upstream Releases

Download the latest zip from the [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases) page of the original project, extract it, then follow steps 3–5 above with the extracted folder. Note that the upstream release does not include this fork's sync, workspace drawer, or subfolder features — build from source for those.

## Privacy

- Projects, notes, prompts, and system prompts are stored locally with browser extension storage.
- When sync is configured, all data is AES-GCM-256 encrypted client-side before leaving the browser; only ciphertext reaches your backend. Your passphrase never leaves the device.
- Account identifiers are SHA-256 hashed locally; raw emails are never stored or transmitted by the extension.
- The extension does not require a separate account and contacts only the server URL you explicitly configure — no telemetry or third-party calls.
- Gemini itself still runs on Google's website, so Gemini account activity is governed by Google's own policies.

## Build and package

Run `npm ci`, `npm run lint`, then `npm run package:store`. Packaging uses Node.js and the system `zip` utility on macOS/Linux, or PowerShell on Windows. The release ZIP contains only manifest-referenced runtime scripts and icons; source maps, unused legacy scripts, local data and development notes are excluded. Generated files stay under `release/` and are not committed.

For local testing, build first and load the folder containing the generated `manifest.json`. In this development workspace, the built runtime is synchronized to the sibling `chrome/` folder. Disable the Web Store installation before enabling the unpacked build to avoid duplicate injections. The two extension IDs have separate local storage; disabling the store build preserves its data. After local validation, create a separate upload ZIP with `npm run package:store`.

The Prompt Library uses the color roles, typography scale, and form structure from the [MCP Apps for Claude UI kit](https://www.figma.com/community/file/1597641111449594397/mcp-apps-for-claude): 14px body text, 40px inputs, 36px buttons, and 16px textarea padding. Forms use the Primary surface with separate container, control, and secondary-button border strengths. Fonts use system fallbacks when Google Sans Flex or JetBrains Mono is unavailable; no font files are bundled. Peer headings in the library, prompt editors, and project dialogs share the same 24px sans-serif type with weight 600. The unified sans headings and 28px panel, 16px row, and 12px control corners are project adaptations rather than the kit's default desktop component specifications.

## Current Version

### Fork additions (this repository)

- Mobile support for Firefox for Android and Chromium-based mobile browsers, with a touch-tuned UI (`src/shared/env.ts` detection; always-visible actions, full-width sheets, safe-area insets, visibility-driven sync).
- Hierarchical projects & nested subfolders with persistent per-account collapse state and Move to… reparenting.
- Project Workspace drawer with autosaving System Prompts (auto-injected into new chats, with in-composer Remove pill) and Project Notes.
- Zero-knowledge AES-GCM-256 sync engine (PBKDF2 key derivation) with debounced local-first pushes, auto-pull on focus/reconnect, and a 4-way conflict modal with 10-second auto-resolution countdown.
- Multi-account identity engine: SHA-256-hashed, fully partitioned workspaces per Google account, with legacy flat-data auto-migration.
- Sync Settings modal (server URL, API key with masked inputs, connection tester, global/per-account passphrase switcher) and live sync status badge in the panel header.
- Panel header badge row: **Prompts** pill (opens the prompt library, live saved-prompt count, add/edit/search), **Config** pill (sync settings) and a **Settings** gear pill with data Export/Import and the Delete-all-local-data danger zone (moved out of the sync modal; Backup/Restore buttons also left the project dialog for the new home).
- Cross-browser Manifest V3 builds for Chrome and Firefox/Zen.

### v2.0.6

- Fixed the Prompt Library entry being inserted into Gemini's relocated Chat/Task switch during initial page rendering. The input toolbar's Upload & tools control is now preferred, and mode switches are excluded.
- Refreshed the Prompt Library and editor with neutral light/dark surfaces, unified stronger serif headings, generous concentric corners and equal button insets, full two-line previews, an explicit New Prompt action, keyboard focus states, and save feedback. Peer headings in new/edit prompt and new/edit project dialogs share the same typography.
- Switched the entry button to native, theme-aware hover styling and added a subtle surface and border to the edit control.
- Kept the picker within the viewport when its search results or window size change.

### v2.0.4

- Added persistent Project pinning and compact Project menus with action icons.
- Made chat action menus and Project destinations fit their labels, with viewport bounds and scrolling for large lists.
- Fixed an idle response-folding scan loop caused by repeated DOM writes.

### v2.0.3

- Renamed the extension to `Gemini Folders — Projects & Prompt Library`.
- Added the Conversation Index icon to the Chrome toolbar and extension management page, matching the store listing.

### v2.0.2

- Fixed sidebar jitter caused by Projects being mounted beside Gemini's native navigation.
- Updated chat-history detection for Gemini's current Chat and Spark sidebar layout.
- Kept Projects visible when Recents is collapsed or the account has no chat history.
- Restored Projects reliably after switching from Spark back to Chat.
- Fixed duplicated response-fold controls and Project/chat menus that closed immediately.

### v2.0.1

- Narrowed website access to Gemini only for Chrome Web Store compliance.
- Removed unused ChatGPT and legacy ChatGPT host access from the extension manifest.

### v2.0.0

- Restores Project support for Gemini's updated sidebar.
- Improves the New Project window with icon and color selection.
- Adds clearer handling for chats deleted from Gemini history on another device.
- Marks missing Project chats instead of breaking the Project list.
- Improves Project and chat menus for moving, removing, editing, and deleting items.
- Adds backup and restore controls for local data.
- Polishes the Prompt Library layout and controls.

## Notes

Gemini Projects is an unofficial extension and is not affiliated with Google or Gemini.
