# Changelog

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