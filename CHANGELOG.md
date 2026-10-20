# Changelog

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