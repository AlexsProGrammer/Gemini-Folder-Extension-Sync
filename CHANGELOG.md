# Changelog

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