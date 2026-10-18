import { ChatRef, Project, ProjectIcon, RuntimeState, SyncStatus, WorkspacePayload } from '../../shared/types';
import { resolveAccountRawIdentifier } from '../../shared/account';
import { getActiveAccountHash } from '../accountWatcher';
import { getWorkspace, saveWorkspace } from '../../shared/storage';
import { SYNC_CONFLICT_EVENT, syncEngine } from '../../shared/syncEngine';
import {
  ICON_OPTIONS,
  COLOR_OPTIONS,
  IconOption,
  chevronDownIcon,
  chevronRightIcon,
  getIconLabel,
  instructionsIcon,
  renderIconSvg
} from './icons';
import { PANEL_TITLE_FONT_STACK, PANEL_TITLE_TYPOGRAPHY } from './typography';
import { createPromptsBadge, createSettingsBadge } from './headerBadges';
import { openSettingsModal } from './modals/settingsModal';
import { openConflictModal } from './modals/conflictModal';
import { createWorkspaceDrawer, WorkspaceDrawerHandle } from './workspaceDrawer';
import { PromptPicker } from '../prompts/picker';
import { promptStore } from '../prompts/store';

export type PanelSection = 'projects' | 'folders';
export type TargetPickerMode = 'project' | 'folder' | 'all';

/** Persists the latest sync status so a recreated panel restores its pill. */
let lastSyncStatus: SyncStatus = 'unconfigured';
/** Registers the conflict listener exactly once per page load. */
let syncConflictListenerAttached = false;

interface ProjectsPanelOptions {
  shadow: ShadowRoot;
  overlayShadow: ShadowRoot;
  onSaveProject: (project: Project) => void;
  onToggleProjectPin: (projectId: string, isPinned: boolean) => Promise<void>;
  onToggleProjectExpand: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onToggleCollapse: (section: PanelSection, collapsed: boolean) => void;
  onRemoveChatFromProject: (conversationId: string) => void;
  onMoveChatToProject: (conversationId: string, projectId: string) => void;
  onAddSubfolder: (parentId: string) => void;
  onEditDetails: (project: Project) => void;
  onAddCurrentChat: (projectId: string) => void;
  /** Moves an existing project/folder into another container or back to root. */
  onMoveProject: (projectId: string, targetParentId: string | null) => void;
  /** Creates a brand-new chat inside the given project (with auto-assignment). */
  onNewChat: (projectId: string) => void;
  /** Fired when a project chat row is opened from the panel. */
  onNavigateToChat: (conversationId: string, projectId: string | null) => void;
  /** Opens Gemini's native chat menu (falls back to the panel menu). */
  onChatMenuOpen: (conversationId: string, anchorRect: DOMRect) => void;
}

export const CHAT_DRAG_MIME = 'application/x-gp-chat-id';

type ModalMode = 'create' | 'edit';
const PANEL_COLLAPSE_ANIMATION_MS = 190;

const PROJECT_ACTION_PATHS = {
  pin: '<path d="M9 3h6v5l3 4v3H6v-3l3-4V3Z"/><path d="M12 15v6"/>',
  unpin: '<path d="m3 3 18 18M9 3h6v5l3 4v3h-3M9 9l-3 3v3h5M12 15v6"/>',
  edit: '<path d="m16 4 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
  addChat: '<circle cx="9" cy="7" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M18 8v6"/><path d="M15 11h6"/>',
  subfolder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 11v5"/><path d="M9.5 13.5h5"/>',
  details: '<path d="M8 3h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9.5 8h5"/><path d="M9.5 12h5"/><path d="M9.5 16h3"/>'
};

const FOLDER_ROW_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';

const DETAILS_BADGE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function renderProjectActionIcon(action: keyof typeof PROJECT_ACTION_PATHS): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PROJECT_ACTION_PATHS[action]}</svg>`;
}

export function createProjectsPanel(options: ProjectsPanelOptions) {
  const panelRoot = ensurePanelRoot(options.shadow);
  const overlayLayer = ensureOverlayLayer(options.overlayShadow);
  const modal = createModal(overlayLayer);
  const projectMenu = createProjectMenu(overlayLayer);
  const toast = createToast(overlayLayer);
  const targetPicker = createTargetPickerModal(overlayLayer);
  const detailsModal = createDetailsModal(overlayLayer, (project, systemPrompt, notes) => {
    options.onSaveProject({ ...project, systemPrompt, notes, updatedAt: Date.now() });
    showToast(systemPrompt || notes ? 'Project details saved' : 'Project details cleared');
  });

  // Tracks the project that should receive system-prompt injection for new chats.
  let activeProjectId: string | null = null;
  let currentState: RuntimeState | null = null;

  // Slide-over Project Workspace drawer (system prompt + notes) with autosave.
  // Metadata is persisted into the account-partitioned workspace (which fires
  // the encrypted sync push) and mirrored into the sidebar state for badges.
  const drawer: WorkspaceDrawerHandle = createWorkspaceDrawer({
    layer: overlayLayer,
    loadProjectMeta: async (projectId) => {
      const accountHash = getActiveAccountHash();
      if (accountHash) {
        try {
          const workspace = await getWorkspace(accountHash);
          const project = workspace.projects[projectId];
          if (project) {
            return { systemPrompt: project.systemPrompt ?? '', notes: project.notes ?? '' };
          }
        } catch (error) {
          console.warn('[Gemini Projects] workspace metadata load failed', error);
        }
      }
      const local = currentState?.projects.find((item) => item.id === projectId);
      return { systemPrompt: local?.systemPrompt ?? '', notes: local?.notes ?? '' };
    },
    saveProjectMeta: async (projectId, updates) => {
      const local = currentState?.projects.find((item) => item.id === projectId);
      if (local) {
        options.onSaveProject({ ...local, ...updates, updatedAt: Date.now() });
      }
      const accountHash = getActiveAccountHash();
      if (!accountHash) return;
      const workspace = await getWorkspace(accountHash);
      const existing = workspace.projects[projectId];
      workspace.projects[projectId] = existing
        ? { ...existing, ...updates, updatedAt: Date.now() }
        : {
            id: projectId,
            name: local?.name ?? 'Untitled',
            kind: local?.kind ?? 'project',
            parentId: local?.parentId ?? null,
            icon: local?.icon ?? 'default',
            color: local?.color,
            chatIds: local?.chatIds,
            isPinned: local?.isPinned,
            createdAt: local?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            sortIndex: local?.sortIndex ?? 0,
            order: local?.order ?? 0,
            ...updates
          };
      await saveWorkspace(accountHash, workspace);
    },
    onActiveProjectChange: (projectId) => {
      activeProjectId = projectId;
    }
  });

  // Initialize theme observer
  attachThemeObserver(panelRoot, overlayLayer);

  // Settings badge: the single combined badge (sync state dot + gear icon)
  // that opens the tabbed Sync/Settings modal, plus the conflict resolver.
  function openSettings() {
    const activeAccountId = getActiveAccountHash() ?? '';
    const activeAccountLabel = resolveAccountRawIdentifier();
    openSettingsModal(activeAccountId, activeAccountLabel);
  }

  const initialSyncStatus: SyncStatus = getActiveAccountHash()
    ? syncEngine.getSyncStatus(getActiveAccountHash() ?? '')
    : 'unconfigured';
  const settingsBadge = createSettingsBadge(openSettings, lastSyncStatus === 'unconfigured' ? initialSyncStatus : lastSyncStatus);

  // Prompt library badge: opens the shared prompt picker anchored to the
  // badge; the count chip tracks the active account's saved prompts.
  const promptsBadge = createPromptsBadge(() => {
    PromptPicker.getInstance().toggle(promptsBadge.getBoundingClientRect(), promptsBadge);
  });
  PromptPicker.getInstance().registerTrigger(promptsBadge);
  promptStore.subscribe(() => promptsBadge.updateCount(promptStore.getAll().length));
  void promptStore.refresh().catch(() => undefined);

  function updateSyncStatus(status: SyncStatus): void {
    lastSyncStatus = status;
    settingsBadge.updateStatus(status);
  }

  if (!syncConflictListenerAttached) {
    syncConflictListenerAttached = true;
    window.addEventListener(SYNC_CONFLICT_EVENT, (event) => {
      const detail = (event as CustomEvent).detail as
        | { accountId?: string; localState?: unknown; remoteState?: unknown }
        | undefined;
      if (!detail || !detail.localState || !detail.remoteState) return;
      openConflictModal(
        {
          localState: detail.localState as WorkspacePayload,
          remoteState: detail.remoteState as WorkspacePayload
        },
        (choice) => {
          void syncEngine
            .resolveConflictResolution(
              choice,
              {
                localState: detail.localState as WorkspacePayload,
                remoteState: detail.remoteState as WorkspacePayload
              },
              detail.accountId ?? ''
            )
            .catch((error) => console.warn('[gemini-projects] conflict resolution failed', error));
        }
      );
    });
  }

  // 用于存储当前 state 以供 chatMenu 获取项目列表
  const chatMenu = createChatMenu(overlayLayer);
  targetPicker.setProjectsProvider(() => currentState?.projects ?? []);
  let panelEventsController: AbortController | null = null;

  let modalMode: ModalMode = 'create';
  let modalProjectId: string | null = null;
  let modalProject: Project | null = null;
  let modalParentId: string | null = null;
  let modalCreateKind: 'project' | 'folder' = 'project';
  let modalSelectedIcon: ProjectIcon = 'default';
  let modalSelectedColor: string = '#1f1f1f'; // Default black
  let inputDirty = false;
  let iconButton: HTMLButtonElement | null = null;

  function render(state: RuntimeState) {
    // 存储当前 state 以供 chatMenu 获取项目列表
    currentState = state;
    // Render markup based on uiPrefs (collapsed state)
    panelRoot.innerHTML = buildPanelMarkup(state);
    const syncHeader = panelRoot.querySelector<HTMLElement>('[data-gp-sync-header]');
    if (syncHeader && syncHeader !== settingsBadge.parentElement) {
      syncHeader.appendChild(promptsBadge);
      syncHeader.appendChild(settingsBadge);
    }
    attachPanelEvents(state);
  }

  function attachPanelEvents(state: RuntimeState) {
    panelEventsController?.abort();
    panelEventsController = new AbortController();

    panelRoot.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const chatMenuButton = target.closest<HTMLButtonElement>('[data-gp-action="chat-menu"]');
      if (chatMenuButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const chatRow = chatMenuButton.closest<HTMLElement>('[data-gp-chat-id]');
        if (!chatRow) return;
        const chatId = chatRow.dataset.gpChatId as string;
        // Reuse Gemini's native chat menu (rename / pin / delete / share) and
        // augment it with the extension's project actions.
        options.onChatMenuOpen(chatId, chatMenuButton.getBoundingClientRect());
        return;
      }

      const chatRow = target.closest<HTMLElement>('[data-gp-chat-id]');
      if (chatRow) {
        const mouseEvent = event as MouseEvent;
        if (mouseEvent.button !== 0 || mouseEvent.metaKey || mouseEvent.ctrlKey || mouseEvent.shiftKey || mouseEvent.altKey) {
          return;
        }
        if (chatRow.classList.contains('missing')) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          showToast('This chat is no longer in Gemini history. It may have been deleted on another device.');
          return;
        }
        const chatId = chatRow.dataset.gpChatId as string;
        const chatLink = chatRow.querySelector<HTMLAnchorElement>('.gp-chat-link');
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        options.onNavigateToChat(chatId, chatRow.dataset.gpProjectId ?? null);
        navigateToProjectChat(chatId, chatLink?.href || `/app/${chatId}`);
        return;
      }

      const workspaceButton = target.closest<HTMLButtonElement>('[data-gp-action="open-workspace"]');
      if (workspaceButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const projectRow = workspaceButton.closest<HTMLElement>('[data-gp-project-id]');
        const projectId = projectRow?.dataset.gpProjectId;
        const project = state.projects.find((item) => item.id === projectId);
        if (project) {
          openWorkspaceDrawer(project);
        }
        return;
      }

      const projectMenuButton = target.closest<HTMLButtonElement>('[data-gp-action="project-menu"]');
      if (projectMenuButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const projectRow = projectMenuButton.closest<HTMLElement>('[data-gp-project-id]');
        const projectId = projectRow?.dataset.gpProjectId;
        const project = state.projects.find((item) => item.id === projectId);
        if (project) {
          openProjectMenu(project, projectMenuButton.getBoundingClientRect());
        }
        return;
      }

      const newProjectRow = target.closest<HTMLElement>('[data-gp-action="new-project"]');
      if (newProjectRow) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openCreateModal();
        return;
      }

      const newFolderRow = target.closest<HTMLElement>('[data-gp-action="new-folder"]');
      if (newFolderRow) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openCreateModal(null, true);
        return;
      }

      const header = target.closest<HTMLElement>('[data-gp-action="toggle-section"]');
      if (header) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const section: PanelSection = header.dataset.gpSection === 'folders' ? 'folders' : 'projects';
        const currentlyCollapsed = section === 'projects'
          ? state.uiPrefs.projectsCollapsed
          : state.uiPrefs.foldersCollapsed;
        const nextCollapsed = !currentlyCollapsed;
        setSectionCollapsed(section, nextCollapsed);
        window.setTimeout(() => options.onToggleCollapse(section, nextCollapsed), PANEL_COLLAPSE_ANIMATION_MS);
        return;
      }

      const toggleRow = target.closest<HTMLElement>('[data-gp-action="toggle-project"]');
      if (toggleRow) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const projectRow = toggleRow.closest<HTMLElement>('[data-gp-project-id]');
        const projectId = projectRow?.dataset.gpProjectId;
        if (projectId) {
          options.onToggleProjectExpand(projectId);
        }
      }
    }, { capture: true, signal: panelEventsController.signal });

    panelRoot.addEventListener('dragover', (event) => {
      const types = event.dataTransfer?.types;
      if (!types || !Array.from(types).includes(CHAT_DRAG_MIME)) return;
      const dropRow = (event.target as HTMLElement | null)?.closest?.('[data-gp-droppable]') as HTMLElement | null;
      if (!dropRow) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      panelRoot.querySelectorAll<HTMLElement>('.gp-drag-over').forEach((row) => {
        if (row !== dropRow) row.classList.remove('gp-drag-over');
      });
      dropRow.classList.add('gp-drag-over');
    }, { signal: panelEventsController.signal });

    panelRoot.addEventListener('dragleave', (event) => {
      const dropRow = (event.target as HTMLElement | null)?.closest?.('[data-gp-droppable]') as HTMLElement | null;
      if (dropRow) dropRow.classList.remove('gp-drag-over');
    }, { signal: panelEventsController.signal });

    panelRoot.addEventListener('drop', (event) => {
      panelRoot.querySelectorAll<HTMLElement>('.gp-drag-over').forEach((row) => row.classList.remove('gp-drag-over'));
      const dropRow = (event.target as HTMLElement | null)?.closest?.('[data-gp-droppable]') as HTMLElement | null;
      if (!dropRow) return;
      const conversationId = event.dataTransfer?.getData(CHAT_DRAG_MIME) || event.dataTransfer?.getData('text/plain');
      if (!conversationId) return;
      event.preventDefault();
      event.stopPropagation();
      const projectId = dropRow.dataset.gpProjectId;
      if (projectId) {
        options.onMoveChatToProject(conversationId, projectId);
      }
    }, { signal: panelEventsController.signal });
  }

  function openCreateModal(parentProjectId?: string | null, forceFolder = false) {
    modalMode = 'create';
    modalProjectId = null;
    modalProject = null;
    modalParentId = parentProjectId ?? null;
    modalCreateKind = forceFolder || modalParentId ? 'folder' : 'project';
    modalSelectedIcon = 'default';
    modalSelectedColor = '#1f1f1f';
    const isFolder = modalCreateKind === 'folder';
    showModal({
      title: isFolder ? (modalParentId ? 'New subfolder' : 'New folder') : 'Create Project',
      confirmLabel: 'Done',
      name: '',
      showIcons: !isFolder,
      showColors: !isFolder,
      folderMode: isFolder
    });
  }

  function openEditModal(project: Project) {
    modalMode = 'edit';
    modalProjectId = project.id;
    modalProject = project;
    modalParentId = null;
    modalCreateKind = project.kind;
    modalSelectedIcon = project.icon;
    modalSelectedColor = project.color || '#1f1f1f';
    const isFolder = project.kind === 'folder';
    showModal({
      title: isFolder ? 'Edit folder' : 'Edit project',
      confirmLabel: 'Save',
      name: project.name,
      showIcons: !isFolder,
      showColors: !isFolder,
      folderMode: isFolder
    });
  }

  function openDetailsModal(project: Project) {
    detailsModal.open(project);
  }

  function updateIconButton() {
    if (iconButton) {
      // Use currentColor (undefined) for Black option to adapt to theme
      const color = modalSelectedColor === '#1f1f1f' ? undefined : modalSelectedColor;
      iconButton.innerHTML = renderIconSvg(modalSelectedIcon, color);
    }
  }

  function setSectionCollapsed(section: PanelSection, collapsed: boolean) {
    const title = panelRoot.querySelector<HTMLElement>(`[data-gp-action="toggle-section"][data-gp-section="${section}"]`);
    const container = panelRoot.querySelector<HTMLElement>(`[data-gp-list-container="${section}"]`);
    title?.classList.toggle('collapsed', collapsed);
    title?.setAttribute('aria-expanded', String(!collapsed));
    container?.classList.toggle('collapsed', collapsed);
  }

  function syncModalIconSelection() {
    modal.element.querySelectorAll<HTMLElement>('[data-gp-template]').forEach((option) => {
      const isSelected = option.dataset.gpTemplate === modalSelectedIcon;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  }

  function syncModalColorSelection() {
    modal.element.querySelectorAll<HTMLElement>('[data-gp-color]').forEach((option) => {
      const isSelected = option.dataset.gpColor === modalSelectedColor;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  }

  function createProjectFromTemplate(
    templateName: string,
    templateIcon: ProjectIcon,
    input?: HTMLInputElement,
    confirm?: HTMLButtonElement
  ) {
    modalSelectedIcon = templateIcon;
    updateIconButton();
    syncModalIconSelection();
    if (!inputDirty && input) {
      input.value = templateName;
    }
    if (confirm && input) {
      confirm.disabled = input.value.trim().length === 0;
    }
  }

  function showModal(config: {
    title: string;
    confirmLabel: string;
    name: string;
    showIcons: boolean;
    showColors?: boolean;
    folderMode?: boolean;
  }) {
    modal.open(config);
    inputDirty = false;
    const input = modal.element.querySelector<HTMLInputElement>('[data-gp-name-input]');
    const confirm = modal.element.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]');
    const iconRow = modal.element.querySelector<HTMLElement>('[data-gp-template-row]');
    const colorRow = modal.element.querySelector<HTMLElement>('[data-gp-color-row]');
    iconButton = modal.element.querySelector<HTMLButtonElement>('[data-gp-current-icon]');

    if (input) {
      input.value = config.name;
      input.placeholder = config.folderMode ? 'Folder name' : 'Project name';
      input.focus();
    }

    if (iconRow) {
      iconRow.style.display = config.showIcons ? 'flex' : 'none';
    }

    if (colorRow) {
      colorRow.style.display = config.showColors === false ? 'none' : 'flex';
    }

    confirm!.textContent = config.confirmLabel;
    confirm!.disabled = input?.value.trim().length === 0;
    updateIconButton();
    syncModalIconSelection();
    syncModalColorSelection();

    if (input) {
      input.oninput = () => {
        inputDirty = true;
        confirm!.disabled = input.value.trim().length === 0;
      };
    }

    confirm!.onclick = () => {
      const name = input?.value.trim() ?? '';
      if (!name) {
        return;
      }

      const now = Date.now();
      const isEdit = modalMode === 'edit';
      const projectData: Project = {
        id: isEdit ? (modalProjectId!) : crypto.randomUUID(),
        name,
        kind: isEdit ? (modalProject?.kind ?? 'project') : modalCreateKind,
        parentId: isEdit ? (modalProject?.parentId ?? null) : modalParentId,
        icon: modalSelectedIcon,
        color: modalSelectedColor,
        isPinned: isEdit ? modalProject?.isPinned === true : false,
        createdAt: isEdit ? (modalProject?.createdAt || now) : now,
        updatedAt: now,
        sortIndex: isEdit ? (modalProject?.sortIndex || now) : now,
        order: isEdit ? (modalProject?.order ?? modalProject?.sortIndex ?? now) : now
      };

      options.onSaveProject(projectData);
      modal.close();
    };

    iconRow?.querySelectorAll<HTMLElement>('[data-gp-template]').forEach((chip) => {
      chip.onclick = () => {
        const iconId = chip.dataset.gpTemplate as ProjectIcon;
        const label = chip.dataset.gpTemplateLabel || getIconLabel(iconId);
        createProjectFromTemplate(label, iconId, input ?? undefined, confirm ?? undefined);
      };
    });

    // Color picker click handlers
    colorRow?.querySelectorAll<HTMLButtonElement>('[data-gp-color]').forEach((dot) => {
      dot.onclick = () => {
        const color = dot.dataset.gpColor;
        if (color) {
          modalSelectedColor = color;
          syncModalColorSelection();
          updateIconButton();
        }
      };
    });
  }

  function openProjectMenu(project: Project, anchorRect: DOMRect) {
    projectMenu.open(anchorRect, project, {
      onTogglePin: async () => {
        const isPinned = !project.isPinned;
        await options.onToggleProjectPin(project.id, isPinned);
        showToast(isPinned ? (project.kind === 'folder' ? 'Folder pinned' : 'Project pinned') : (project.kind === 'folder' ? 'Folder unpinned' : 'Project unpinned'));
      },
      onPinError: (error) => {
        console.warn('[Gemini Projects] Pin update failed', error);
        showToast('Could not update pin. Please try again.');
      },
      onAddCurrentChat: () => options.onAddCurrentChat(project.id),
      onAddSubfolder: () => options.onAddSubfolder(project.id),
      onEditDetails: () => options.onEditDetails(project),
      onMove: () => openReparentPicker(project),
      onNewChat: () => options.onNewChat(project.id),
      onEdit: () => openEditModal(project),
      onDelete: () => options.onDeleteProject(project.id)
    });
  }

  /** Opens the slide-over workspace drawer for a project. */
  function openWorkspaceDrawer(project: Project) {
    activeProjectId = project.id;
    drawer.close();
    drawer.open(project).catch((error) =>
      console.warn('[Gemini Projects] workspace drawer failed to open', error)
    );
  }

  /**
   * Opens the hierarchical picker in reparent mode so a project/folder can be
   * moved into any other container or back to root (self and descendants are
   * excluded).
   */
  function openReparentPicker(project: Project) {
    const projects = currentState?.projects ?? [];
    targetPicker.openReparent(project.id, projects, (targetParentId) => {
      options.onMoveProject(project.id, targetParentId);
    });
  }

  /**
   * Opens the searchable hierarchical picker that lets the user choose which
   * project or folder a chat should belong to.
   */
  function openTargetPicker(conversationId: string, mode: TargetPickerMode) {
    const projects = currentState?.projects ?? [];
    const chatIndex = currentState?.chatIndex ?? new Map<string, ChatRef>();
    const currentProjectId = currentState?.chatIndex.get(conversationId)?.projectId ?? null;
    targetPicker.open({
      mode,
      projects,
      chatIndex,
      currentProjectId,
      onPick: (targetProjectId) => options.onMoveChatToProject(conversationId, targetProjectId ?? '')
    });
  }

  /** Extension fallback menu for chats whose native menu cannot be opened. */
  function showChatMenuFallback(conversationId: string, anchorRect: DOMRect) {
    const chat = currentState?.chatIndex.get(conversationId);
    const projectId = chat?.projectId ?? null;
    const projectName = projectId
      ? currentState?.projects.find((item) => item.id === projectId)?.name ?? ''
      : '';
    chatMenu.open(anchorRect, conversationId, projectId, projectName, {
      onMove: () => openTargetPicker(conversationId, 'all'),
      onRemove: () => options.onRemoveChatFromProject(conversationId)
    });
  }

  function showToast(message: string) {
    toast.show(message);
  }

  function closeAllOverlays() {
    modal.close();
    projectMenu.close();
    chatMenu.close();
    targetPicker.close();
    detailsModal.close();
    drawer.close();
    toast.hide();
  }

  return {
    render,
    closeAllOverlays,
    showToast,
    openCreateModal,
    openDetailsModal,
    openTargetPicker,
    showChatMenuFallback,
    updateSyncStatus,
    setActiveProject: (projectId: string | null) => {
      activeProjectId = projectId;
    },
    getActiveProjectId: () => activeProjectId
  };
}

const CHAT_PIN_BADGE_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none" aria-hidden="true"><path d="M16 3l5 5-5.5 1.5L13 12l-.5 4.5L9 13l-4.5 4.5L3 16l4.5-4.5L4 8l4.5-.5L11 5l2.5-2z"/></svg>';
const TWIST_CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8.1 5.7 14.4 12l-6.3 6.3-1.4-1.4L11.6 12 6.7 7.1z"/></svg>';

/**
 * Renders one hierarchy (roots with their nested subfolders and chats) as the
 * sidebar tree. Called once for the Projects section and once for the Folders
 * section so the two categories stay visually separated. `rootKind` selects
 * which containers are shown as top-level entries; nested subfolders of any
 * kind always render inside their parent.
 */
export function renderProjectsSection(
  projects: Project[],
  chatIndex: Map<string, ChatRef>,
  collapsedProjectIds: Set<string>,
  rootKind: 'project' | 'folder',
  nativeConversationIds: Set<string> = new Set(),
  nativeChatsReady = false
): string {
  const childrenOf = (parentId: string | null): Project[] =>
    projects
      .filter((project) => (project.parentId ?? null) === parentId)
      .sort((a, b) =>
        Number(b.isPinned === true) - Number(a.isPinned === true) || a.sortIndex - b.sortIndex
      );

  const chatsOf = (projectId: string): ChatRef[] =>
    Array.from(chatIndex.values())
      .filter((chat) => chat.projectId === projectId)
      // Pinned chats always float to the top of their project/folder section.
      .sort((a, b) =>
        Number(b.isPinned === true) - Number(a.isPinned === true) || b.updatedAt - a.updatedAt
      );

  const renderChatRows = (project: Project, accentColor: string, isExpanded: boolean, chats: ChatRef[]): string => {
    if (!isExpanded) return '';

    return `
          <div class="gp-project-chats">
            ${chats.length
          ? chats
            .map(
              (chat) => {
                const isMissing = nativeChatsReady && !nativeConversationIds.has(chat.conversationId);
                return `
                        <div class="gp-chat-row ${isMissing ? 'missing' : ''}" data-gp-chat-id="${chat.conversationId}" data-gp-project-id="${project.id}">
                          <a class="gp-chat-link" href="${escapeHtml(chat.lastUrl || `/app/${chat.conversationId}`)}">
                            <span class="gp-chat-color" aria-hidden="true"></span>
                            <span class="gp-chat-title">${escapeHtml(chat.title || 'Untitled chat')}</span>
                            ${isMissing ? '<span class="gp-chat-missing">Missing</span>' : ''}
                          </a>
                          ${chat.isPinned ? `<span class="gp-chat-pin" role="img" aria-label="Pinned chat" title="Pinned to top">${CHAT_PIN_BADGE_ICON}</span>` : ''}
                          <button class="gp-chat-kebab" data-gp-action="chat-menu" aria-label="Chat menu"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
                        </div>
                      `
              }
            )
            .join('')
          : '<div class="gp-chat-empty">No chats yet</div>'
        }
          </div>
        `;
  };

  const renderNode = (project: Project, depth: number): string => {
    const isExpanded = !collapsedProjectIds.has(project.id);
    const accentColor = getProjectAccentColor(project);
    const isFolder = project.kind === 'folder';
    const hasDetails = Boolean(project.systemPrompt || project.notes);
    const children = childrenOf(project.id);
    const chats = chatsOf(project.id);
    const hasDescendants = children.length > 0 || chats.length > 0;

    const chatRows = renderChatRows(project, accentColor, isExpanded, chats);
    const childRows = isExpanded && children.length
      ? `<div class="gp-project-children">${children.map((child) => renderNode(child, depth + 1)).join('')}</div>`
      : '';

    const iconMarkup = isFolder
      ? `<span class="gp-icon gp-folder-icon" style="color: ${escapeAttr(accentColor)};">${FOLDER_ROW_ICON}</span>`
      : `<span class="gp-icon">${renderIconSvg(project.icon, project.color)}</span>`;

    const twistMarkup = hasDescendants
      ? `<span class="gp-twist ${isExpanded ? 'open' : ''}" aria-hidden="true">${isExpanded ? chevronDownIcon(14) : chevronRightIcon(14)}</span>`
      : '<span class="gp-twist-spacer" aria-hidden="true"></span>';

    return `
        <div class="gp-project" data-gp-project-id="${project.id}" style="--gp-project-color: ${escapeAttr(accentColor)};">
          <div class="gp-row gp-project-row ${isExpanded ? 'active' : ''}" data-gp-action="toggle-project" data-gp-droppable="true">
            ${twistMarkup}
            ${iconMarkup}
            <span class="gp-label">${escapeHtml(project.name)}</span>
            ${hasDetails ? `<span class="gp-details-badge" role="img" aria-label="Has system prompt or notes" title="Has system prompt or notes">${DETAILS_BADGE_ICON}</span>` : ''}
            ${project.isPinned ? `<span class="gp-project-pin" role="img" aria-label="Pinned project" title="Pinned project">${renderProjectActionIcon('pin')}</span>` : ''}
            ${isFolder ? '' : `<button class="gp-workspace-btn" data-gp-action="open-workspace" aria-label="Open project workspace" title="Project workspace">${instructionsIcon(18)}</button>`}
            <button class="gp-kebab" data-gp-action="project-menu" aria-label="${isFolder ? 'Folder menu' : 'Project menu'}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
          </div>
          ${chatRows}
          ${childRows}
        </div>
      `;
  };

  const roots = childrenOf(null).filter((project) => project.kind === rootKind);
  if (!roots.length) {
    return ''; // No placeholder when empty, cleaner look
  }

  return roots.map((project) => renderNode(project, 0)).join('');
}

function ensurePanelRoot(shadow: ShadowRoot): HTMLElement {
  let root = shadow.getElementById('gp-panel-root') as HTMLElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'gp-panel-root';
    shadow.appendChild(root);
  }
  if (!shadow.querySelector('style[data-gp="panel"]')) {
    const style = document.createElement('style');
    style.dataset.gp = 'panel';
    style.textContent = `
      :host {
        all: initial;
        font-family: inherit;
        color: var(--gp-fg, #1f1f1f);
        box-sizing: border-box;

        /* Native Fonts & Colors (Gemini) */
        --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif;
        --gp-fg: #1f1f1f;
        --gp-fg-muted: #5f6368;
        --gp-section: rgba(0, 0, 0, 0.54);
        --gp-bg-hover: rgba(31, 31, 31, 0.06); 
        --gp-bg-active: #f1f3f4;

        --gp-radius: 24px;
        --gp-spacing-row: 0px;

        display: block;
        width: 100%;
        pointer-events: auto;
        position: relative;
        isolation: isolate;
        padding-top: 8px;
      }

      :host(.dark) {
        --gp-fg: #e3e3e3;
        --gp-fg-muted: #bdc1c6;
        --gp-section: rgba(255, 255, 255, 0.62);
        --gp-bg-hover: rgba(255, 255, 255, 0.08); 
        --gp-bg-active: rgba(255, 255, 255, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      .gp-panel {
        display: flex;
        flex-direction: column;
        gap: var(--gp-spacing-row);
        background: transparent;
        padding: 0;
        pointer-events: auto;
      }

      .gp-title {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 6px;
        margin: 0;
        padding: 0 14px; 
        height: 32px;
        color: var(--gp-section); 
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
        cursor: pointer;
        user-select: none;
        border-radius: 0;
        transition: background 0.1s ease;
      }

      .gp-title:hover {
        background: transparent;
        color: var(--gp-fg-muted);
      }

      .gp-chevron {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform ${PANEL_COLLAPSE_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1);
        color: var(--gp-fg-muted);
        opacity: 0.82;
      }

      .gp-chevron svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
        display: block;
      }

      .gp-title.collapsed .gp-chevron {
        transform: rotate(-90deg);
      }

      .gp-list-container {
        display: grid;
        grid-template-rows: 1fr;
        overflow: hidden;
        opacity: 1;
        transition:
          grid-template-rows ${PANEL_COLLAPSE_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1),
          opacity 120ms ease;
      }

      .gp-list-container.collapsed {
        grid-template-rows: 0fr;
        opacity: 0;
      }

      .gp-list-content {
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow: hidden;
      }

      .gp-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 0 6px;
        padding: 0 8px;
        width: calc(100% - 6px);
        height: 32px;
        border-radius: var(--gp-radius);
        text-decoration: none;
        color: var(--gp-fg);
        cursor: pointer;
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
        position: relative;
        transition: background 0.1s ease;
        pointer-events: auto;
      }

      .gp-row:hover {
        background: var(--gp-bg-hover);
      }

      .gp-row.gp-force-hover {
        background: var(--gp-bg-hover);
      }

      /* Removed: Active state background creates visual clutter with stacked pill shapes.
         Only hover is now highlighted for a cleaner look.
      .gp-row.active {
        background: var(--gp-bg-active);
      }
      */

      .gp-label {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
      }

      .gp-new .gp-icon {
        color: #3c4043;
      }

      .gp-project-pin {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        color: var(--gp-fg-muted);
      }
      .gp-project-pin svg {
        width: 14px;
        height: 14px;
      }

      .gp-icon {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--gp-fg-muted);
        line-height: 0;
      }

      .gp-icon svg {
        width: 20px;
        height: 20px;
        display: block;
        flex: 0 0 20px;
      }

      .gp-twist {
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 14px;
        color: var(--gp-fg-muted);
        opacity: 0.75;
        line-height: 0;
      }

      .gp-twist svg {
        transition: transform 160ms cubic-bezier(0.2, 0, 0, 1);
        transform: rotate(0deg);
      }

      .gp-twist.open svg {
        transform: rotate(0deg);
      }

      .gp-twist-spacer {
        width: 14px;
        flex: 0 0 14px;
      }

      .gp-kebab {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-fg-muted);
        cursor: pointer;
        opacity: 0;
        transition: background 0.15s ease, opacity 0.15s ease;
        margin-right: -8px;
        flex-shrink: 0;
      }

      .gp-workspace-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-fg-muted);
        cursor: pointer;
        opacity: 0;
        transition: background 0.15s ease, opacity 0.15s ease;
        margin-right: -4px;
        flex-shrink: 0;
      }

      .gp-workspace-btn svg {
        width: 18px;
        height: 18px;
        display: block;
      }

      .gp-kebab svg {
        width: 20px;
        height: 20px;
      }

      .gp-row:hover .gp-kebab, 
      .gp-row.gp-force-hover .gp-kebab,
      .gp-kebab:focus,
      .gp-row:hover .gp-workspace-btn,
      .gp-row.gp-force-hover .gp-workspace-btn,
      .gp-workspace-btn:focus {
        opacity: 1;
      }

      .gp-kebab:hover,
      .gp-workspace-btn:hover {
        background: var(--gp-bg-active);
        color: var(--gp-fg);
      }

      .gp-project-chats {
        display: flex;
        flex-direction: column;
        gap: 0;
        position: relative;
        /*
         * Guide-line geometry: the border drops exactly below the parent
         * row's twist chevron center (6px row margin + 8px row padding +
         * 7px half twist = 21px). .gp-project-children uses the same 20px
         * margin so the chats line and the subfolder line form one single,
         * perfectly aligned vertical spine, and every nesting level steps
         * the line by a constant 21px. Content offsets (30px padding + 12px
         * row padding) keep chat dots/titles at their established columns.
         */
        margin-left: 20px;
        padding-left: 30px;
        border-left: 1px solid color-mix(in srgb, var(--gp-project-color) 45%, transparent);
      }

      .gp-chat-row {
        height: 32px;
        padding: 0 8px 0 12px;
        margin: 0;
        display: flex;
        align-items: center;
        text-decoration: none;
        color: var(--gp-fg-muted);
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 20px;
        border-radius: var(--gp-radius);
        transition: background 0.1s;
        pointer-events: auto;
      }

      .gp-chat-row:hover {
        background: var(--gp-bg-hover);
      }

      .gp-chat-row.gp-force-hover {
        background: var(--gp-bg-hover);
      }

      .gp-chat-row.missing {
        color: var(--gp-section);
      }

      .gp-chat-row:hover .gp-chat-link {
        color: var(--gp-fg);
      }

      .gp-chat-row.missing:hover .gp-chat-link {
        color: var(--gp-fg-muted);
      }

      .gp-chat-row.gp-force-hover .gp-chat-link {
        color: var(--gp-fg);
      }

      .gp-chat-link {
        flex: 1;
        min-width: 0; /* Allow text truncation */
        display: flex;
        align-items: center;
        gap: 8px;
        height: 100%;
        text-decoration: none;
        color: inherit;
        pointer-events: auto;
      }

      .gp-chat-color {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--gp-project-color);
        flex: 0 0 6px;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--gp-project-color) 18%, transparent);
      }

      .gp-chat-title {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .gp-chat-missing {
        flex: 0 0 auto;
        margin-left: 4px;
        padding: 0 6px;
        border-radius: 999px;
        border: 1px solid rgba(95, 99, 104, 0.22);
        color: var(--gp-fg-muted);
        background: rgba(95, 99, 104, 0.06);
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      :host(.dark) .gp-chat-missing {
        border-color: rgba(189, 193, 198, 0.22);
        background: rgba(189, 193, 198, 0.1);
      }

      .gp-chat-kebab {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-fg-muted);
        cursor: pointer;
        opacity: 0;
        transition: background 0.15s ease, opacity 0.15s ease;
        margin-right: -6px; /* Scaled margin (-8px * 0.75 = -6px) */
        flex-shrink: 0;
      }

      .gp-chat-kebab svg {
        width: 18px;
        height: 18px;
      }

      .gp-chat-row:hover .gp-chat-kebab,
      .gp-chat-row.gp-force-hover .gp-chat-kebab {
        opacity: 1;
      }

      .gp-chat-kebab:hover {
        background: var(--gp-bg-active);
        color: var(--gp-fg);
      }

      .gp-chat-pin {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 14px;
        width: 14px;
        height: 14px;
        color: var(--gp-fg-muted);
      }

      .gp-chat-empty {
        /* 30px chats padding + 1px border + 26px = chat title column (dot 6px + gap 8px + 12px row padding). */
        padding: 8px 16px 8px 26px;
        margin: 0;
        font-family: var(--gp-font);
        font-size: 12px;
        color: var(--gp-section);
      }

      .gp-project-children {
        /* Same guide-line column as .gp-project-chats so the line dropping to
           chats and the line dropping to subfolders are perfectly in line. */
        margin-left: 20px;
        padding-left: 0;
        border-left: 1px solid color-mix(in srgb, var(--gp-project-color) 45%, transparent);
      }

      .gp-row.gp-drag-over {
        background: var(--gp-bg-active);
        outline: 1.5px dashed var(--gp-fg-muted);
        outline-offset: -2px;
      }

      .gp-details-badge {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        color: var(--gp-fg-muted);
      }

      .gp-details-badge svg {
        width: 14px;
        height: 14px;
      }

      .gp-sync-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        padding: 0 12px 6px;
        gap: 10px;
      }

      .gp-sync-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 10px 0 8px;
        border: 1px solid var(--gp-bg-active);
        border-radius: 999px;
        background: transparent;
        color: var(--gp-fg-muted);
        font-family: var(--gp-font);
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }

      .gp-sync-badge:hover {
        background: var(--gp-bg-hover);
        border-color: var(--gp-fg-muted);
        color: var(--gp-fg);
      }

      .gp-sync-badge .gp-sync-icon {
        display: inline-flex;
        align-items: center;
      }

      .gp-sync-badge .gp-sync-icon svg {
        width: 14px;
        height: 14px;
        display: block;
      }

      .gp-sync-badge .gp-prompts-count {
        min-width: 16px;
        height: 16px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--gp-bg-active);
        color: var(--gp-fg-muted);
        font-size: 10px;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .gp-sync-badge:hover .gp-prompts-count {
        color: var(--gp-fg);
      }

      /* Icon-only settings badge (opens the tabbed Sync/Settings modal). */
      .gp-settings-badge {
        position: relative;
        width: 26px;
        height: 26px;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: var(--gp-fg-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .gp-settings-badge:hover {
        background: var(--gp-bg-hover);
        color: var(--gp-fg);
      }

      .gp-settings-badge .gp-sync-icon {
        display: inline-flex;
        align-items: center;
      }

      .gp-settings-badge .gp-sync-icon svg {
        width: 16px;
        height: 16px;
        display: block;
      }

      .gp-settings-badge .gp-status-dot {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--gp-fg-muted);
        transition: background 0.15s ease;
      }

      .gp-settings-badge.dot-synced .gp-status-dot {
        background: #188038;
      }

      .gp-settings-badge.dot-syncing .gp-status-dot {
        background: #1a73e8;
        animation: gp-dot-pulse 1.1s ease-in-out infinite;
      }

      .gp-settings-badge.dot-offline .gp-status-dot {
        background: #9aa0a6;
      }

      .gp-settings-badge.dot-conflict .gp-status-dot,
      .gp-settings-badge.dot-error .gp-status-dot {
        background: #b3261e;
      }

      :host(.dark) .gp-settings-badge.dot-synced .gp-status-dot {
        background: #81c995;
      }

      :host(.dark) .gp-settings-badge.dot-syncing .gp-status-dot {
        background: #8ab4f8;
      }

      :host(.dark) .gp-settings-badge.dot-conflict .gp-status-dot,
      :host(.dark) .gp-settings-badge.dot-error .gp-status-dot {
        background: #f2b8b5;
      }

      @keyframes gp-dot-pulse {
        50% {
          opacity: 0.35;
        }
      }
    `;
    shadow.appendChild(style);
  }
  return root;
}

function buildPanelMarkup(state: RuntimeState): string {
  const projectsCollapsed = state.uiPrefs.projectsCollapsed;
  const foldersCollapsed = state.uiPrefs.foldersCollapsed;
  const chevronSvg = `
    <svg viewBox="0 0 24 24">
      <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
    </svg>
  `;

  const sectionTitle = (section: PanelSection, label: string, collapsed: boolean) => `
      <div class="gp-title ${collapsed ? 'collapsed' : ''}" data-gp-action="toggle-section" data-gp-section="${section}" role="button" aria-expanded="${String(!collapsed)}">
        <span>${escapeHtml(label)}</span>
        <span class="gp-chevron">${chevronSvg}</span>
      </div>
  `;

  const sectionBody = (section: PanelSection, collapsed: boolean, content: string) => `
      <div class="gp-list-container ${collapsed ? 'collapsed' : ''}" data-gp-list-container="${section}">
        <div class="gp-list-content">
          ${content}
        </div>
      </div>
  `;

  const projectsContent = `
          <div class="gp-row gp-new" data-gp-action="new-project">
            <span class="gp-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span>
            <span class="gp-label">New Project</span>
          </div>
          ${renderProjectsSection(
    state.projects,
    state.chatIndex,
    state.collapsedProjectIds,
    'project',
    state.nativeConversationIds,
    state.nativeChatsReady
  )}
  `;

  const foldersContent = `
          <div class="gp-row gp-new" data-gp-action="new-folder">
            <span class="gp-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 11v5"/><path d="M9.5 13.5h5"/><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg></span>
            <span class="gp-label">New Folder</span>
          </div>
          ${renderProjectsSection(
    state.projects,
    state.chatIndex,
    state.collapsedProjectIds,
    'folder',
    state.nativeConversationIds,
    state.nativeChatsReady
  )}
  `;

  return `
    <div class="gp-panel">
      <div class="gp-sync-header" data-gp-sync-header></div>
      ${sectionTitle('projects', 'Projects', projectsCollapsed)}
      ${sectionBody('projects', projectsCollapsed, projectsContent)}
      ${sectionTitle('folders', 'Folders', foldersCollapsed)}
      ${sectionBody('folders', foldersCollapsed, foldersContent)}
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function getProjectAccentColor(project: Project): string {
  const color = project.color || '';
  if (/^#[0-9a-f]{3,8}$/i.test(color) && color.toLowerCase() !== '#1f1f1f') {
    return color;
  }
  return 'var(--gp-fg-muted)';
}

function ProjectNameInputWithIcon(): string {
  return `
    <div class="gp-namebox" data-gp-namebox>
      <span class="gp-icon-button" data-gp-current-icon aria-hidden="true"></span>
      <input class="gp-name-input" data-gp-name-input type="text" placeholder="Project name" />
    </div>
  `;
}

function getModalIconRows(): IconOption[][] {
  const perRow = 10;
  return [
    ICON_OPTIONS.slice(0, perRow),
    ICON_OPTIONS.slice(perRow, perRow * 2),
    ICON_OPTIONS.slice(perRow * 2, perRow * 3)
  ];
}

function ensureOverlayLayer(shadow: ShadowRoot): HTMLElement {
  let layer = shadow.getElementById('gp-overlay-layer') as HTMLElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'gp-overlay-layer';
    shadow.appendChild(layer);
  }
  if (!shadow.querySelector('style[data-gp="overlay"]')) {
    const style = document.createElement('style');
    style.dataset.gp = 'overlay';
    style.textContent = `
      :host {
        all: initial;
        font-family: inherit;
        color: var(--gp-fg, #1f1f1f);
        --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif;
        --gp-font-title: ${PANEL_TITLE_FONT_STACK};
        --gp-fg: #1f1f1f;
        --gp-fg-muted: #5f6368;
        --gp-muted: #747775;
        --gp-border: rgba(60, 64, 67, 0.12);
        --gp-hover: #f1f3f4;
        --gp-hover-strong: rgba(60, 64, 67, 0.10);
        --gp-selected: rgba(60, 64, 67, 0.06);
        --gp-selected-border: rgba(60, 64, 67, 0.22);
        --gp-surface: #ffffff;
        --gp-surface-2: #f8fafd;
        --gp-shadow: 0 16px 40px rgba(60, 64, 67, 0.18), 0 1px 3px rgba(60, 64, 67, 0.16);
        --gp-radius-xs: 8px;
        --gp-radius-sm: 12px;
        --gp-radius: 16px;
        --gp-radius-lg: 18px;
        --gp-radius-xl: 28px;
        --gp-radius-pill: 999px;
        --gp-transition: .18s ease;
        --gp-accent: #1a73e8;
        --gp-on-accent: #ffffff;
        --gp-accent-hover: rgba(26, 115, 232, 0.10);
        --gp-focus: #1a73e8;
        --gp-focus-ring: rgba(26, 115, 232, 0.16);
        --gp-input-bg: #f8fafd;
      }

      :host(.dark) {
        --gp-fg: #e8eaed;
        --gp-fg-muted: #bdc1c6;
        --gp-muted: #9aa0a6;
        --gp-border: rgba(232, 234, 237, 0.16);
        --gp-hover: rgba(255, 255, 255, 0.08);
        --gp-hover-strong: rgba(255, 255, 255, 0.12);
        --gp-selected: rgba(255, 255, 255, 0.08);
        --gp-selected-border: rgba(232, 234, 237, 0.28);
        --gp-surface: #202124;
        --gp-surface-2: #292a2d;
        --gp-shadow: 0 24px 52px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.36);
        --gp-accent: #8ab4f8;
        --gp-on-accent: #202124;
        --gp-accent-hover: rgba(138, 180, 248, 0.18);
        --gp-focus: #8ab4f8;
        --gp-focus-ring: rgba(138, 180, 248, 0.22);
        --gp-input-bg: rgba(41, 42, 45, 0.92);
      }

      .gp-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(32, 33, 36, 0.24);
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      .gp-modal {
        --gp-icon-size: 48px;
        --gp-icon-gap: 12px;
        --gp-action-width: 132px;
        --gp-action-height: 44px;
        --gp-content-width: calc(var(--gp-icon-size) * 10 + var(--gp-icon-gap) * 9);
        --gp-modal-pad-x: 24px;
        --gp-modal-pad-y: 24px;
        background: var(--gp-surface);
        border-radius: var(--gp-radius-xl);
        box-sizing: border-box;
        width: calc(var(--gp-content-width) + var(--gp-modal-pad-x) * 2);
        max-width: calc(100vw - 32px);
        box-shadow: var(--gp-shadow);
        border: 1px solid var(--gp-border);
        padding: var(--gp-modal-pad-y) var(--gp-modal-pad-x);
        display: flex;
        flex-direction: column;
        gap: 16px;
        font-family: var(--gp-font);
        color: var(--gp-fg);
        position: relative;
      }
      .gp-modal,
      .gp-modal * {
        box-sizing: border-box;
      }
      .gp-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        font-size: 19px;
        font-weight: 800;
        font-family: var(--gp-font);
        letter-spacing: 0.01em;
        color: var(--gp-fg);
      }
      .gp-modal-header [data-gp-modal-title] {
        ${PANEL_TITLE_TYPOGRAPHY}
        font-style: normal;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }
      .gp-modal-close {
        border: none;
        background: transparent;
        font-size: 18px;
        cursor: pointer;
        color: var(--gp-muted);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-right: -5px;
        transition: background var(--gp-transition);
      }
      .gp-modal-close svg { width: 18px; height: 18px; }
      .gp-modal-close:hover { background: var(--gp-hover); }
      .gp-namebox {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        border: 1px solid var(--gp-border);
        border-radius: var(--gp-radius-lg);
        padding: 8px; /* Uniform padding for consistent margins */
        position: relative;
        background: var(--gp-input-bg);
        transition: border-color var(--gp-transition), box-shadow var(--gp-transition);
      }
      .gp-namebox:focus-within {
        border-color: var(--gp-fg);
        box-shadow: inset 0 0 0 1px var(--gp-fg);
      }
      .gp-icon-button {
        width: 38px;
        height: 38px;
        border: none;
        border-radius: var(--gp-radius-sm);
        background: var(--gp-input-bg);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: default;
        color: var(--gp-fg);
        flex: 0 0 38px;
      }
      .gp-icon-button svg {
        width: 22px;
        height: 22px;
        stroke-width: 2.35;
      }
      .gp-name-input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;
        font-size: 15px;
        color: var(--gp-fg);
        font-family: var(--gp-font);
      }
      .gp-name-input::placeholder { color: var(--gp-muted); }
      .gp-template-row {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
      }
      .gp-template-row-group {
        display: grid;
        grid-template-columns: repeat(10, var(--gp-icon-size));
        gap: var(--gp-icon-gap);
        width: 100%;
      }
      .gp-template-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--gp-icon-size);
        height: var(--gp-icon-size);
        padding: 0;
        border-radius: var(--gp-radius-pill);
        border: 1px solid transparent;
        cursor: pointer;
        color: var(--gp-fg);
        background: transparent;
        transition: background var(--gp-transition), border-color var(--gp-transition), box-shadow var(--gp-transition), transform var(--gp-transition);
        flex: 0 0 auto;
      }
      .gp-template-chip:hover {
        border-color: transparent;
        background: var(--gp-hover);
        transform: none;
      }
      .gp-template-chip:active { transform: translateY(0); }
      .gp-template-chip.selected {
        border-color: var(--gp-selected-border);
        background: var(--gp-selected);
        color: var(--gp-fg);
        box-shadow: inset 0 0 0 2px var(--gp-selected-border);
        border-radius: 50%;
      }
      .gp-template-chip svg {
        width: 24px;
        height: 24px;
        stroke-width: 2.15;
      }
      .gp-template-chip:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(60, 64, 67, 0.18); }

      /* Color Picker Row */
      .gp-color-row {
        display: flex;
        gap: 10px;
        align-items: center;
        width: calc(100% - 10px);
        margin-left: 10px;
        margin-bottom: 8px;
      }
      .gp-color-dot {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: transform var(--gp-transition), box-shadow var(--gp-transition);
        padding: 0;
        position: relative;
        /* 立体磨砂效果基础 */
        overflow: hidden;
      }
      .gp-color-dot:hover {
        transform: translateY(-1px);
      }
      .gp-color-dot.selected {
        box-shadow: inset 0 0 0 4px var(--gp-surface), 0 0 0 2px currentColor;
      }
      .gp-color-dot:first-child.selected {
        box-shadow: inset 0 0 0 4px var(--gp-surface), 0 0 0 2px currentColor;
      }

      /* Adaptive Color (Black/White) */
      .gp-color-adaptive {
        background-color: #1f1f1f;
        color: #1f1f1f;
      }
      :host(.dark) .gp-color-adaptive {
        background-color: #ffffff;
        color: #ffffff;
      }
      :host(.dark) .gp-color-dot:first-child.selected {
        box-shadow: inset 0 0 0 4px var(--gp-surface), 0 0 0 2px currentColor;
      }

      /* 所有颜色的立体磨砂效果 - 移除，回归扁平 */
      .gp-color-dot::before,
      .gp-color-dot::after {
        display: none;
      }
      .gp-color-dot:first-child::before,
      .gp-color-dot:first-child::after {
        display: none;
      }

      .gp-modal-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        width: 100%;
        margin-top: 6px;
      }
      .gp-primary {
        width: var(--gp-action-width);
        height: var(--gp-action-height);
        border-radius: 16px 14px 14px 16px;
        font-family: var(--gp-font);
        letter-spacing: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: none;
        -webkit-font-smoothing: antialiased;
        -webkit-text-stroke: 0 transparent;
        text-shadow: none;
        paint-order: normal;
      }
      .gp-primary {
        background: var(--gp-focus);
        color: var(--gp-on-accent);
        border: 1px solid var(--gp-focus);
        padding: 0 22px;
        font-size: 15px;
        font-weight: 800;
        transition: background var(--gp-transition), border-color var(--gp-transition), transform var(--gp-transition);
        overflow: hidden;
      }
      .gp-primary:hover {
        background: #1967d2;
        border-color: #1967d2;
        transform: none;
      }
      :host(.dark) .gp-primary:hover {
        background: #aecbfa;
        border-color: #aecbfa;
      }
      .gp-primary:disabled {
        background: var(--gp-hover);
        border-color: var(--gp-border);
        color: var(--gp-muted);
        cursor: not-allowed;
        box-shadow: none;
      }
      .gp-menu {
        position: fixed;
        min-width: 220px;
        background: var(--gp-surface);
        border-radius: 16px;
        box-shadow: 0 8px 20px rgba(60, 64, 67, 0.18);
        border: 1px solid var(--gp-border);
        padding: 8px;
        display: none;
        pointer-events: auto;
        font-family: var(--gp-font);
        color: var(--gp-fg);
        z-index: 2147483647;
      }
      .gp-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 0 12px;
        border-radius: 18px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 300;
        color: var(--gp-fg);
        line-height: 16px;
        transition: background var(--gp-transition), color var(--gp-transition);
      }
      .gp-menu-item:hover {
        background: var(--gp-hover);
        transform: none;
      }
      .gp-menu-item.danger { color: #b3261e; }
      .gp-project-menu {
        width: max-content;
        min-width: 0;
        max-width: calc(100vw - 16px);
        box-sizing: border-box;
        padding: 8px;
        border-radius: 16px;
      }
      .gp-project-menu .gp-menu-item {
        width: 100%;
        height: 36px;
        min-height: 36px;
        justify-content: flex-start;
        gap: 12px;
        padding: 0 12px;
        border: 0;
        background: transparent;
        box-sizing: border-box;
        border-radius: 18px;
        font-family: inherit;
        text-align: left;
      }
      .gp-project-menu .gp-menu-item svg {
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        stroke-width: 2;
      }
      .gp-project-menu .gp-menu-item:hover,
      .gp-project-menu .gp-menu-item:focus-visible {
        background: var(--gp-hover);
      }
      .gp-project-menu .gp-menu-item:focus-visible {
        outline: 2px solid var(--gp-focus);
        outline-offset: -2px;
      }
      .gp-project-menu .gp-menu-item:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      :host(.dark) .gp-project-menu .gp-menu-item.danger {
        color: #f2b8b5;
      }

      /* Chat menu item with icons */
      .gp-chat-menu {
        width: max-content;
        min-width: 0;
        max-width: calc(100vw - 16px);
        box-sizing: border-box;
        padding: 8px;
        border-radius: 16px;
      }
      .gp-chat-menu .gp-menu-item {
        justify-content: flex-start;
        gap: 12px;
        height: 36px;
        min-height: 36px;
        padding: 0 12px;
        border-radius: 18px;
      }
      .gp-chat-menu .gp-menu-item svg {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }
      .gp-chat-menu .gp-menu-item span {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .gp-chat-menu .gp-submenu-arrow {
        flex: 0 0 16px;
        width: 16px;
        height: 16px;
      }

      /* Submenu trigger arrow */
      .gp-submenu-arrow {
        width: 16px;
        height: 16px;
        margin-left: auto;
        opacity: 0.6;
      }

      /* Submenu panel */
      .gp-submenu {
        position: fixed;
        width: max-content;
        min-width: 0;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        box-sizing: border-box;
        background: var(--gp-surface);
        border-radius: 16px;
        box-shadow: 0 8px 20px rgba(60, 64, 67, 0.18);
        border: 1px solid var(--gp-border);
        padding: 8px;
        display: none;
        z-index: 2147483647;
        font-family: var(--gp-font);
      }
      .gp-submenu .gp-menu-item {
        justify-content: flex-start;
        gap: 12px;
        height: 36px;
        min-height: 36px;
        padding: 0 12px;
        border-radius: 18px;
      }
      .gp-submenu .gp-menu-item svg {
        width: 16px;
        height: 16px;
        stroke-width: 2;
      }
      .gp-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #202124;
        color: #ffffff;
        padding: 10px 16px;
        border-radius: var(--gp-radius-pill);
        font-size: 13px;
        display: none;
        pointer-events: auto;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
        font-family: var(--gp-font);
      }

      .gp-menu-divider {
        height: 1px;
        background: var(--gp-border);
        margin: 4px 8px;
      }

      /* ---------- System prompt & notes modal ---------- */

      .gp-details-modal {
        --gp-content-width: 560px;
        gap: 14px;
        max-width: calc(100vw - 32px);
      }

      .gp-details-body {
        display: flex;
        flex-direction: column;
        gap: 16px;
        width: 100%;
      }

      .gp-details-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
      }

      .gp-details-label-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .gp-details-label {
        font-size: 13px;
        font-weight: 600;
        color: var(--gp-fg);
        font-family: var(--gp-font);
      }

      .gp-details-hint {
        margin: 0;
        font-size: 12px;
        line-height: 16px;
        color: var(--gp-muted);
        font-family: var(--gp-font);
      }

      .gp-details-textarea {
        width: 100%;
        min-height: 96px;
        max-height: 320px;
        resize: vertical;
        border: 1px solid var(--gp-border);
        border-radius: 12px;
        background: var(--gp-input-bg);
        color: var(--gp-fg);
        font-family: var(--gp-font);
        font-size: 13.5px;
        line-height: 1.55;
        padding: 12px 14px;
        outline: none;
        box-sizing: border-box;
        overflow-y: auto;
        transition: border-color var(--gp-transition), box-shadow var(--gp-transition), background var(--gp-transition);
      }

      .gp-details-textarea-tall {
        min-height: 150px;
      }

      .gp-details-textarea::placeholder {
        color: var(--gp-muted);
        opacity: 0.9;
      }

      .gp-details-textarea:hover {
        border-color: var(--gp-selected-border);
      }

      .gp-details-textarea:focus {
        border-color: var(--gp-accent);
        box-shadow: 0 0 0 3px var(--gp-focus-ring);
        background: var(--gp-surface);
      }

      .gp-details-actions {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding-top: 2px;
      }

      .gp-details-actions .gp-primary {
        width: auto;
        min-width: 96px;
        border-radius: 999px;
      }

      .gp-ghost-button {
        min-width: 88px;
        height: 40px;
        padding: 0 18px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--gp-fg);
        font-family: var(--gp-font);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background var(--gp-transition);
      }

      .gp-ghost-button:hover {
        background: var(--gp-hover);
      }

      /* ---------- Target picker modal ---------- */

      .gp-picker-modal {
        --gp-content-width: 460px;
        gap: 12px;
        max-width: calc(100vw - 32px);
      }

      .gp-picker-search {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        border: 1px solid var(--gp-border);
        border-radius: 999px;
        padding: 0 14px;
        height: 44px;
        background: var(--gp-input-bg);
        color: var(--gp-muted);
        box-sizing: border-box;
        transition: border-color var(--gp-transition), box-shadow var(--gp-transition);
      }

      .gp-picker-search:focus-within {
        border-color: var(--gp-accent);
        box-shadow: 0 0 0 3px var(--gp-focus-ring);
        color: var(--gp-fg);
      }

      .gp-picker-search-input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;
        font-size: 14px;
        color: var(--gp-fg);
        font-family: var(--gp-font);
      }

      .gp-picker-search-input::placeholder { color: var(--gp-muted); }

      .gp-picker-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        max-height: min(52vh, 420px);
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 2px;
        box-sizing: border-box;
      }

      .gp-picker-empty {
        padding: 26px 0 18px;
        text-align: center;
        font-size: 13px;
        color: var(--gp-muted);
        font-family: var(--gp-font);
      }

      .gp-picker-node { display: block; }

      .gp-picker-row {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding-right: 10px;
        border-radius: 12px;
        cursor: pointer;
        color: var(--gp-fg);
        font-family: var(--gp-font);
        font-size: 13.5px;
        font-weight: 500;
        line-height: 18px;
        transition: background var(--gp-transition);
      }

      .gp-picker-row:hover {
        background: var(--gp-hover);
      }

      .gp-picker-row:focus-visible {
        outline: 2px solid var(--gp-focus);
        outline-offset: -2px;
      }

      .gp-picker-row.current {
        background: var(--gp-selected);
      }

      .gp-picker-twist {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 18px;
        color: var(--gp-muted);
        line-height: 0;
      }

      .gp-picker-twist svg {
        transition: transform 160ms cubic-bezier(0.2, 0, 0, 1);
        transform: rotate(0deg);
      }

      .gp-picker-twist.open svg {
        transform: rotate(90deg);
      }

      .gp-picker-twist-spacer {
        width: 18px;
        flex: 0 0 18px;
      }

      .gp-picker-icon {
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 22px;
        color: var(--gp-fg-muted);
        line-height: 0;
      }

      .gp-picker-icon.is-folder svg {
        width: 19px;
        height: 19px;
      }

      .gp-picker-name {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .gp-picker-mark {
        background: var(--gp-accent-hover);
        color: inherit;
        border-radius: 3px;
        padding: 0 1px;
      }

      .gp-picker-count {
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 600;
        color: var(--gp-muted);
        background: var(--gp-hover);
        border-radius: 999px;
        padding: 2px 8px;
        line-height: 14px;
      }

      .gp-picker-current-badge {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--gp-muted);
        border: 1px solid var(--gp-border);
        border-radius: 999px;
        padding: 2px 7px;
        line-height: 14px;
      }

      .gp-picker-children {
        display: block;
      }
    `;
    shadow.appendChild(style);
  }
  return layer;
}

function createModal(layer: HTMLElement) {
  const backdrop = document.createElement('div');
  backdrop.className = 'gp-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gp-modal" role="dialog" aria-modal="true">
      <div class="gp-modal-header">
        <span data-gp-modal-title>Create Project</span>
        <button class="gp-modal-close" data-gp-action="close" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      ${ProjectNameInputWithIcon()}
      <div class="gp-color-row" data-gp-color-row>
        ${COLOR_OPTIONS.map(
    (opt, idx) => {
      const isAdaptive = idx === 0; // First one is 'Black'
      const style = isAdaptive ? '' : `background-color: ${opt.color}; color: ${opt.color};`;
      const adaptiveClass = isAdaptive ? 'gp-color-adaptive' : '';
      return `
            <button class="gp-color-dot ${idx === 0 ? 'selected' : ''} ${adaptiveClass}" 
                    data-gp-color="${opt.color}" 
                    title="${opt.label}"
                    style="${style}">
            </button>
          `;
    }
  ).join('')}
        </div>
      <div class="gp-template-row" data-gp-template-row>
        ${getModalIconRows().map((row) => `
          <div class="gp-template-row-group">
            ${row.map((icon) => `
              <button class="gp-template-chip" type="button" data-gp-template="${icon.id}" data-gp-template-label="${icon.label}" title="${icon.label}" aria-label="${icon.label}" aria-pressed="false">
                ${renderIconSvg(icon.id)}
              </button>
            `).join('')}
          </div>
        `).join('')}
      </div>
      <div class="gp-modal-actions">
        <button class="gp-primary" data-gp-action="confirm" disabled>Done</button>
      </div>
    </div>
  `;
  layer.appendChild(backdrop);

  function open(config: {
    title: string;
    confirmLabel: string;
    name: string;
    showIcons: boolean;
    showColors?: boolean;
    folderMode?: boolean;
  }) {
    const title = backdrop.querySelector<HTMLElement>('[data-gp-modal-title]');
    const confirm = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]');
    const input = backdrop.querySelector<HTMLInputElement>('[data-gp-name-input]');
    const templateRow = backdrop.querySelector<HTMLElement>('[data-gp-template-row]');
    const colorRow = backdrop.querySelector<HTMLElement>('[data-gp-color-row]');
    if (title) title.textContent = config.title;
    if (confirm) confirm.textContent = config.confirmLabel;
    if (input) {
      input.value = config.name;
      input.placeholder = config.folderMode ? 'Folder name' : 'Project name';
    }
    if (templateRow) templateRow.style.display = config.showIcons ? 'flex' : 'none';
    if (colorRow) colorRow.style.display = config.showColors === false ? 'none' : 'flex';
    backdrop.style.display = 'flex';
  }

  function close() {
    backdrop.style.display = 'none';
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });

  const closeButton = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="close"]');
  closeButton?.addEventListener('click', () => close());

  return { element: backdrop, open, close };
}

function createDetailsModal(
  layer: HTMLElement,
  onSave: (project: Project, systemPrompt: string, notes: string) => void
) {
  const backdrop = document.createElement('div');
  backdrop.className = 'gp-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gp-modal gp-details-modal" role="dialog" aria-modal="true">
      <div class="gp-modal-header">
        <span data-gp-modal-title>Project details</span>
        <button class="gp-modal-close" data-gp-action="close" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="gp-details-body">
        <div class="gp-details-field">
          <div class="gp-details-label-row">
            <label class="gp-details-label" for="gp-details-prompt">System prompt</label>
          </div>
          <p class="gp-details-hint">Custom instructions applied to every chat in this project.</p>
          <textarea class="gp-details-textarea" id="gp-details-prompt" data-gp-details-prompt rows="5" placeholder="e.g. You are a senior React engineer. Always answer with TypeScript snippets and explain trade-offs."></textarea>
        </div>
        <div class="gp-details-field">
          <div class="gp-details-label-row">
            <label class="gp-details-label" for="gp-details-notes">Notes</label>
          </div>
          <p class="gp-details-hint">Freeform markdown notes for this workspace.</p>
          <textarea class="gp-details-textarea gp-details-textarea-tall" id="gp-details-notes" data-gp-details-notes rows="8" placeholder="# Notes&#10;- Project specification&#10;- Decisions &amp; open questions"></textarea>
        </div>
      </div>
      <div class="gp-details-actions">
        <button class="gp-ghost-button" data-gp-action="details-cancel">Cancel</button>
        <button class="gp-primary" data-gp-action="details-save">Save</button>
      </div>
    </div>
  `;
  layer.appendChild(backdrop);

  const promptInput = backdrop.querySelector<HTMLTextAreaElement>('[data-gp-details-prompt]');
  const notesInput = backdrop.querySelector<HTMLTextAreaElement>('[data-gp-details-notes]');
  let currentProject: Project | null = null;

  const autoGrow = (textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
  };

  function open(project: Project) {
    currentProject = project;
    if (promptInput) promptInput.value = project.systemPrompt || '';
    if (notesInput) notesInput.value = project.notes || '';
    backdrop.style.display = 'flex';
    autoGrow(promptInput);
    autoGrow(notesInput);
    window.setTimeout(() => promptInput?.focus(), 30);
  }

  function close() {
    backdrop.style.display = 'none';
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });

  promptInput?.addEventListener('input', () => autoGrow(promptInput));
  notesInput?.addEventListener('input', () => autoGrow(notesInput));

  const closeButton = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="close"]');
  closeButton?.addEventListener('click', () => close());

  const cancelButton = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="details-cancel"]');
  cancelButton?.addEventListener('click', () => close());

  const saveButton = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="details-save"]');
  saveButton?.addEventListener('click', () => {
    if (!currentProject) return;
    onSave(currentProject, promptInput?.value ?? '', notesInput?.value ?? '');
    close();
  });

  return { open, close };
}

function createProjectMenu(layer: HTMLElement) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu gp-project-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Project actions');
  layer.appendChild(menu);

  type ProjectMenuCallbacks = {
    onTogglePin: () => Promise<void>;
    onPinError: (error: unknown) => void;
    onAddCurrentChat: () => void;
    onAddSubfolder: () => void;
    onEditDetails: () => void;
    onMove: () => void;
    onNewChat: () => void;
    onEdit: () => void;
    onDelete: () => void;
  };
  let callbacks: ProjectMenuCallbacks | null = null;
  let openedAt = 0;
  let pinPending = false;

  function open(anchorRect: DOMRect, project: Project, nextCallbacks: ProjectMenuCallbacks) {
    if (pinPending) return;
    callbacks = nextCallbacks;
    const isFolder = project.kind === 'folder';
    menu.setAttribute('aria-label', isFolder ? 'Folder actions' : 'Project actions');
    // Projects and folders get separated menus: only projects expose the
    // system prompt & notes workspace settings.
    menu.innerHTML = `
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="add-chat">${renderProjectActionIcon('addChat')}<span>Add current chat</span></button>
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="new-chat">${renderProjectActionIcon('addChat')}<span>New chat in ${isFolder ? 'folder' : 'project'}</span></button>
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="subfolder">${renderProjectActionIcon('subfolder')}<span>New subfolder</span></button>
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="move">${renderProjectActionIcon('subfolder')}<span>Move to…</span></button>
      ${isFolder ? '' : `<button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="details">${renderProjectActionIcon('details')}<span>System prompt &amp; notes</span></button>`}
      <div class="gp-menu-divider" role="separator"></div>
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="pin">${renderProjectActionIcon(project.isPinned ? 'unpin' : 'pin')}<span>${project.isPinned ? 'Unpin' : 'Pin'}</span></button>
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="edit">${renderProjectActionIcon('edit')}<span>Rename</span></button>
      <button type="button" role="menuitem" class="gp-menu-item danger" data-gp-menu="delete">${renderProjectActionIcon('delete')}<span>Delete</span></button>
    `;
    menu.style.display = 'block';
    const { width, height } = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8));
    const preferredTop = anchorRect.bottom + 6;
    const top = Math.max(8, Math.min(
      preferredTop + height <= window.innerHeight - 8 ? preferredTop : anchorRect.top - height - 6,
      window.innerHeight - height - 8
    ));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    openedAt = performance.now();
    menu.querySelector<HTMLButtonElement>('[data-gp-menu]')?.focus();
  }

  function close() {
    menu.style.display = 'none';
  }

  menu.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest('[data-gp-menu]') as HTMLElement | null;
    if (!target || !callbacks || pinPending) {
      return;
    }
    const action = target.dataset.gpMenu;
    if (action === 'pin') {
      const activeCallbacks = callbacks;
      const label = target.querySelector('span')!;
      const originalLabel = label.textContent;
      pinPending = true;
      menu.setAttribute('aria-busy', 'true');
      menu.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
      label.textContent = originalLabel === 'Unpin' ? 'Unpinning…' : 'Pinning…';
      try {
        await activeCallbacks.onTogglePin();
        close();
      } catch (error) {
        activeCallbacks.onPinError(error);
      } finally {
        pinPending = false;
        menu.removeAttribute('aria-busy');
        label.textContent = originalLabel;
        menu.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = false; });
      }
      return;
    }
    if (action === 'add-chat') callbacks.onAddCurrentChat();
    if (action === 'new-chat') callbacks.onNewChat();
    if (action === 'subfolder') callbacks.onAddSubfolder();
    if (action === 'details') callbacks.onEditDetails();
    if (action === 'move') callbacks.onMove();
    if (action === 'edit') callbacks.onEdit();
    if (action === 'delete') callbacks.onDelete();
    close();
  });

  menu.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || pinPending) return;
    event.preventDefault();
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-gp-menu]'));
    const current = items.indexOf(event.target as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  });

  document.addEventListener('click', (event) => {
    // A click originating in the panel is retargeted to the Shadow DOM host
    // before it reaches document. Ignore the opening click, then use the
    // composed path so later clicks inside the overlay remain distinguishable.
    if (performance.now() - openedAt < 50) return;
    if (!event.composedPath().includes(menu)) {
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  return { open, close };
}

// 聊天项菜单 (Chat row fallback menu, used when Gemini's native menu cannot be opened)
function createChatMenu(layer: HTMLElement) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu gp-chat-menu';
  layer.appendChild(menu);

  let callbacks: {
    onRemove: () => void;
    onMove: () => void;
  } | null = null;
  let currentProjectName: string = '';
  let openedAt = 0;

  function open(
    anchorRect: DOMRect,
    _chatId: string,
    _projectId: string | null,
    projectName: string,
    nextCallbacks: {
      onRemove: () => void;
      onMove: () => void;
    }
  ) {
    callbacks = nextCallbacks;
    currentProjectName = projectName;

    menu.innerHTML = `
      <div class="gp-menu-item" data-gp-chat-action="move">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
          <path d="M8 13h8"/><path d="m13 10 3 3-3 3"/><path d="m11 16-3-3 3-3"/>
        </svg>
        <span>Move to project or folder…</span>
      </div>
      <div class="gp-menu-item" data-gp-chat-action="remove">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
          <path d="M9.5 13.5h5"/>
        </svg>
        <span>${currentProjectName ? `Remove from ${escapeHtml(currentProjectName)}` : 'Remove from project'}</span>
      </div>
    `;

    // 显示后按实际内容尺寸定位，不再依赖固定宽度。
    menu.style.display = 'block';
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuRect.width - 8));
    const preferredTop = anchorRect.bottom + 6;
    const top = Math.max(8, Math.min(
      preferredTop + menuRect.height <= window.innerHeight - 8 ? preferredTop : anchorRect.top - menuRect.height - 6,
      window.innerHeight - menuRect.height - 8
    ));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    openedAt = performance.now();
  }

  function close() {
    menu.style.display = 'none';
  }

  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-gp-chat-action]') as HTMLElement | null;
    if (!target || !callbacks) return;

    const action = target.dataset.gpChatAction;
    if (action === 'remove') {
      callbacks.onRemove();
      close();
    } else if (action === 'move') {
      callbacks.onMove();
      close();
    }
  });

  document.addEventListener('click', (event) => {
    if (performance.now() - openedAt < 50) return;
    if (!event.composedPath().includes(menu)) {
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  return { open, close };
}

/**
 * Searchable hierarchical picker used by "Add to project", "Add to folder" and
 * "Move to project or folder…". Renders the full folder structure (projects,
 * folders and nested subfolders) with search across all levels.
 */
function createTargetPickerModal(layer: HTMLElement) {
  const backdrop = document.createElement('div');
  backdrop.className = 'gp-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gp-modal gp-picker-modal" role="dialog" aria-modal="true">
      <div class="gp-modal-header">
        <span data-gp-picker-title>Move to project or folder</span>
        <button class="gp-modal-close" data-gp-action="close" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="gp-picker-search" data-gp-picker-searchbox>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input class="gp-picker-search-input" data-gp-picker-search type="text" placeholder="Search projects and folders…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="gp-picker-list" data-gp-picker-list role="listbox" aria-label="Projects and folders"></div>
      <div class="gp-picker-empty" data-gp-picker-empty style="display: none;">No matches</div>
    </div>
  `;
  layer.appendChild(backdrop);

  const titleElement = backdrop.querySelector<HTMLElement>('[data-gp-picker-title]');
  const searchInput = backdrop.querySelector<HTMLInputElement>('[data-gp-picker-search]');
  const listElement = backdrop.querySelector<HTMLElement>('[data-gp-picker-list]');
  const emptyElement = backdrop.querySelector<HTMLElement>('[data-gp-picker-empty]');

  const TITLE_BY_MODE: Record<TargetPickerMode, string> = {
    project: 'Add to project',
    folder: 'Add to folder',
    all: 'Move to project or folder'
  };

  interface PickerEntry {
    project: Project;
    depth: number;
    children: PickerEntry[];
    chatCount: number;
  }

  let currentChatIndex: Map<string, ChatRef> = new Map();
  let expandedNodes = new Set<string>();
  let query = '';
  let pickHandler: ((projectId: string | null) => void) | null = null;
  let currentProjectId: string | null = null;
  let currentMode: TargetPickerMode = 'all';
  let currentStateProjectsProvider: (() => Project[]) | null = null;
  let reparentExcludeId: string | null = null;

  /** True when the node (or any of its ancestors) is the reparenting target. */
  function isExcludedFromReparent(projects: Project[], projectId: string | null): boolean {
    if (!reparentExcludeId || !projectId) return false;
    if (projectId === reparentExcludeId) return true;
    const project = projects.find((item) => item.id === projectId);
    return project ? isExcludedFromReparent(projects, project.parentId) : false;
  }

  function buildForest(projects: Project[], mode: TargetPickerMode): PickerEntry[] {
    const chatCountOf = (projectId: string): number =>
      Array.from(currentChatIndex.values()).filter((chat) => chat.projectId === projectId).length;

    const sortEntries = (entries: PickerEntry[]) =>
      entries.sort((a, b) =>
        Number(b.project.isPinned === true) - Number(a.project.isPinned === true) ||
        a.project.sortIndex - b.project.sortIndex
      );

    const buildChildren = (parentId: string, depth: number): PickerEntry[] => {
      const children = projects
        .filter((project) => (project.parentId ?? null) === parentId && !isExcludedFromReparent(projects, project.id))
        .map((project) => ({
          project,
          depth,
          children: buildChildren(project.id, depth + 1),
          chatCount: chatCountOf(project.id)
        }));
      return sortEntries(children);
    };

    const rootKinds: ('project' | 'folder')[] =
      mode === 'project' ? ['project'] : mode === 'folder' ? ['folder'] : ['project', 'folder'];

    const forest: PickerEntry[] = [];
    for (const kind of rootKinds) {
      forest.push(...sortEntries(projects
        .filter(
          (project) =>
            (project.parentId ?? null) === null &&
            project.kind === kind &&
            !isExcludedFromReparent(projects, project.id)
        )
        .map((project) => ({
          project,
          depth: 0,
          children: buildChildren(project.id, 1),
          chatCount: chatCountOf(project.id)
        }))));
    }
    return forest;
  }

  function matchesQuery(entry: PickerEntry, normalizedQuery: string): boolean {
    const selfMatch = (entry.project.name || '').toLowerCase().includes(normalizedQuery);
    const childMatch = entry.children.some((child) => matchesQuery(child, normalizedQuery));
    return selfMatch || childMatch;
  }

  function highlightName(name: string, normalizedQuery: string): string {
    const escaped = escapeHtml(name);
    if (!normalizedQuery) return escaped;
    const lowerName = (name || '').toLowerCase();
    const index = lowerName.indexOf(normalizedQuery);
    if (index < 0) return escaped;
    const before = escapeHtml(name.slice(0, index));
    const match = escapeHtml(name.slice(index, index + normalizedQuery.length));
    const after = escapeHtml(name.slice(index + normalizedQuery.length));
    return `${before}<mark class="gp-picker-mark">${match}</mark>${after}`;
  }

  function renderEntry(entry: PickerEntry, normalizedQuery: string): string {
    const isFolder = entry.project.kind === 'folder';
    const hasChildren = entry.children.length > 0;
    const isExpanded = expandedNodes.has(entry.project.id);
    const isCurrent = entry.project.id === currentProjectId;
    const iconMarkup = isFolder
      ? FOLDER_ROW_ICON
      : renderIconSvg(entry.project.icon, entry.project.color);
    const indent = 14 * entry.depth;
    const childrenMarkup = hasChildren && isExpanded
      ? `<div class="gp-picker-children">${entry.children
        .filter((child) => matchesQuery(child, normalizedQuery))
        .map((child) => renderEntry(child, normalizedQuery))
        .join('')}</div>`
      : '';

    return `
      <div class="gp-picker-node" data-gp-picker-id="${entry.project.id}" role="option" aria-selected="${String(isCurrent)}" tabindex="0">
        <div class="gp-picker-row ${isCurrent ? 'current' : ''}" style="padding-left: ${10 + indent}px;">
          ${hasChildren
            ? `<span class="gp-picker-twist ${isExpanded ? 'open' : ''}" data-gp-picker-twist aria-label="Toggle">${TWIST_CHEVRON_ICON}</span>`
            : '<span class="gp-picker-twist-spacer"></span>'}
          <span class="gp-picker-icon ${isFolder ? 'is-folder' : ''}">${iconMarkup}</span>
          <span class="gp-picker-name">${highlightName(entry.project.name, normalizedQuery)}</span>
          ${entry.chatCount > 0 ? `<span class="gp-picker-count">${entry.chatCount}</span>` : ''}
          ${isCurrent ? '<span class="gp-picker-current-badge">Current</span>' : ''}
        </div>
        ${childrenMarkup}
      </div>
    `;
  }

  function renderList(projects: Project[], mode: TargetPickerMode) {
    if (!listElement) return;
    const normalizedQuery = query.trim().toLowerCase();
    const forest = buildForest(projects, mode);
    const visibleForest = normalizedQuery
      ? forest.filter((entry) => matchesQuery(entry, normalizedQuery))
      : forest;

    const rootRow = reparentExcludeId
      ? `
        <div class="gp-picker-node" data-gp-picker-id="__root__" role="option" tabindex="0">
          <div class="gp-picker-row" style="padding-left: 10px;">
            <span class="gp-picker-twist-spacer"></span>
            <span class="gp-picker-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1Z"/><path d="M20 3h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1Z"/><path d="M8 15H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1Z"/><path d="M20 15h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1Z"/></svg></span>
            <span class="gp-picker-name">Root (top level)</span>
          </div>
        </div>`
      : '';

    if (!visibleForest.length && !rootRow) {
      listElement.innerHTML = '';
      if (emptyElement) emptyElement.style.display = 'block';
      return;
    }
    if (emptyElement) emptyElement.style.display = 'none';
    listElement.innerHTML = `${rootRow}${visibleForest.map((entry) => renderEntry(entry, normalizedQuery)).join('')}`;
  }

  function open(config: {
    mode: TargetPickerMode;
    projects: Project[];
    chatIndex: Map<string, ChatRef>;
    currentProjectId: string | null;
    onPick: (projectId: string | null) => void;
  }) {
    currentChatIndex = config.chatIndex;
    currentProjectId = config.currentProjectId;
    currentMode = config.mode;
    pickHandler = config.onPick;
    reparentExcludeId = null;
    query = '';
    expandedNodes = new Set(config.projects.map((project) => project.id));
    if (titleElement) titleElement.textContent = TITLE_BY_MODE[config.mode];
    if (searchInput) searchInput.value = '';
    renderList(config.projects, config.mode);
    backdrop.style.display = 'flex';
    window.setTimeout(() => searchInput?.focus(), 30);
  }

  /**
   * Opens the picker to reparent an existing project/folder. Self and its
   * subtree are hidden, and a "Root (top level)" entry lets the user return
   * the container to the top level.
   */
  function openReparent(
    projectId: string,
    projects: Project[],
    onPick: (targetParentId: string | null) => void
  ) {
    currentChatIndex = new Map();
    currentProjectId = projectId;
    currentMode = 'all';
    pickHandler = onPick;
    reparentExcludeId = projectId;
    query = '';
    expandedNodes = new Set(projects.map((project) => project.id));
    if (titleElement) titleElement.textContent = 'Move to…';
    if (searchInput) searchInput.value = '';
    renderList(projects, 'all');
    backdrop.style.display = 'flex';
    window.setTimeout(() => searchInput?.focus(), 30);
  }

  function close() {
    backdrop.style.display = 'none';
    pickHandler = null;
    reparentExcludeId = null;
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });

  backdrop.querySelector<HTMLButtonElement>('[data-gp-action="close"]')?.addEventListener('click', () => close());

  const rerender = () => {
    renderList(currentStateProjectsProvider?.() ?? [], currentMode);
  };

  searchInput?.addEventListener('input', () => {
    query = searchInput.value || '';
    // While searching, auto-expand every branch so matched subfolders stay
    // visible within their hierarchy.
    expandedNodes = new Set(
      Array.from(backdrop.querySelectorAll<HTMLElement>('.gp-picker-node'))
        .map((node) => node.dataset.gpPickerId || '')
        .filter(Boolean)
    );
    rerender();
  });

  listElement?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const twist = target.closest<HTMLElement>('[data-gp-picker-twist]');
    if (twist) {
      const node = twist.closest<HTMLElement>('.gp-picker-node');
      const id = node?.dataset.gpPickerId;
      if (id) {
        if (expandedNodes.has(id)) expandedNodes.delete(id);
        else expandedNodes.add(id);
        rerender();
      }
      return;
    }

    const row = target.closest<HTMLElement>('.gp-picker-node');
    const id = row?.dataset.gpPickerId;
    if (id && pickHandler) {
      pickHandler(id === '__root__' ? null : id);
      close();
    }
  });

  listElement?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('.gp-picker-node');
    const id = row?.dataset.gpPickerId;
    if (id && pickHandler) {
      event.preventDefault();
      pickHandler(id === '__root__' ? null : id);
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && backdrop.style.display === 'flex') {
      close();
    }
  });

  return {
    open,
    openReparent,
    close,
    setProjectsProvider: (provider: () => Project[]) => {
      currentStateProjectsProvider = provider;
    }
  };
}

function createToast(layer: HTMLElement) {
  const toast = document.createElement('div');
  toast.className = 'gp-toast';
  layer.appendChild(toast);
  let timeoutId: number | null = null;

  function show(message: string) {
    toast.textContent = message;
    toast.style.display = 'block';
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      toast.style.display = 'none';
    }, 2200);
  }

  function hide() {
    toast.style.display = 'none';
  }

  return { show, hide };
}

function navigateToProjectChat(conversationId: string, fallbackHref: string) {
  const before = window.location.href;
  const targetUrl = new URL(fallbackHref, window.location.origin).href;
  if (before === targetUrl) {
    return;
  }

  const nativeLink = findNativeChatLink(conversationId);
  if (nativeLink) {
    nativeLink.click();
    window.setTimeout(() => {
      if (window.location.href === before) {
        window.location.assign(targetUrl);
      }
    }, 200);
    return;
  }

  window.location.assign(targetUrl);
}

function findNativeChatLink(conversationId: string): HTMLAnchorElement | null {
  const nativeLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]'));
  return nativeLinks.find((link) => {
    if (!link.href.includes(`/app/${conversationId}`)) return false;
    if (!link.closest('nav, aside, [role="navigation"], [role="complementary"]')) return false;
    return true;
  }) || null;
}

function attachThemeObserver(panelRoot: HTMLElement, overlayLayer: HTMLElement) {
  const getHost = (el: HTMLElement) => (el.getRootNode() as ShadowRoot).host as HTMLElement;
  const panelHost = getHost(panelRoot);
  const overlayHost = getHost(overlayLayer);

  const applyTheme = () => {
    // Check for "dark" in class list (Gemini typically uses "dark-theme" or similar)
    // We strictly check for *presence* of likely dark classes
    const bodyClass = document.body.className.toLowerCase();
    const isDark = bodyClass.includes('dark');

    if (panelHost) panelHost.classList.toggle('dark', isDark);
    if (overlayHost) overlayHost.classList.toggle('dark', isDark);
  };

  const observer = new MutationObserver(applyTheme);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  applyTheme(); // Initial check
}
