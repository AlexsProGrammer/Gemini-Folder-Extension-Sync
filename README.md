# Gemini-Folder-Extension-Sync
Gemini Folders with Backend Sync a Fork from Gemini-Folder-Extension linyushuo0818

Credits: https://github.com/linyushuo0818/gemini-folder-extension

Chromium and Firefox extension.

## Features

- Hierarchical projects & nested subfolders with persistent per-account collapse state.
- Project Workspace drawer: per-project System Prompts (auto-injected into new chats) and Project Notes, autosaved and encrypted-synced.
- Reparent projects/folders via **Move to…**, or start a chat directly inside a project (**New chat in project**).
- Zero-knowledge encrypted sync to your own backend, isolated per Google account.



# Update from original Gemini-Folder-Extension
Init:
```bash
git subtree add --prefix=extension https://github.com/linyushuo0818/gemini-folder-extension.git main --squash
```
Update:
```bash
git subtree pull --prefix=extension upstream main --squash
```
