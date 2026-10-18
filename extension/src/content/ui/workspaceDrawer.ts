import { Project } from '../../shared/types';
import { PANEL_TITLE_FONT_STACK, PANEL_TITLE_TYPOGRAPHY } from './typography';
import { instructionsIcon, noteIcon, renderIconSvg } from './icons';

export interface WorkspaceMeta {
  systemPrompt: string;
  notes: string;
}

export interface WorkspaceDrawerOptions {
  /** The overlay layer (inside the extension's shadow DOM) the drawer mounts into. */
  layer: HTMLElement;
  loadProjectMeta: (projectId: string) => Promise<WorkspaceMeta>;
  saveProjectMeta: (projectId: string, updates: WorkspaceMeta) => Promise<void>;
  /** Fired when the drawer is opened for a project; used to track the active project. */
  onActiveProjectChange?: (projectId: string) => void;
}

export interface WorkspaceDrawerHandle {
  open: (project: Project) => Promise<void>;
  close: () => void;
  isOpen: () => boolean;
}

const SAVE_DEBOUNCE_MS = 400;
const STYLE_ID = 'gp-workspace-drawer-style';

/**
 * Slide-over Project Workspace drawer: manages the active project's System
 * Prompt (auto-injected into new chats) and freeform Project Notes. Both
 * textareas autosave locally (debounced) and trigger the encrypted sync push
 * via the workspace save hook.
 */
export function createWorkspaceDrawer(options: WorkspaceDrawerOptions): WorkspaceDrawerHandle {
  const root = options.layer.getRootNode() as ShadowRoot | Document;
  ensureDrawerStyle(root);

  // A recreated panel mounts a fresh drawer; drop any previous drawer DOM that
  // the earlier panel left in the shared overlay layer.
  options.layer
    .querySelectorAll<HTMLElement>('.gp-drawer-backdrop, .gp-workspace-drawer')
    .forEach((node) => node.remove());

  const backdrop = document.createElement('div');
  backdrop.className = 'gp-drawer-backdrop';
  backdrop.setAttribute('data-gp-drawer-backdrop', 'true');

  const drawer = document.createElement('aside');
  drawer.className = 'gp-workspace-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Project workspace');
  drawer.innerHTML = `
    <header class="gp-drawer-header">
      <span class="gp-drawer-icon" data-gp-drawer-icon></span>
      <div class="gp-drawer-heading">
        <h2 class="gp-drawer-title">Project workspace</h2>
        <div class="gp-drawer-project" data-gp-drawer-project></div>
      </div>
      <button type="button" class="gp-drawer-close" data-gp-drawer-close aria-label="Close workspace">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </header>
    <div class="gp-drawer-tabs" role="tablist">
      <button type="button" class="gp-drawer-tab active" data-gp-tab="prompt" role="tab" aria-selected="true">${instructionsIcon(16)} System Prompt</button>
      <button type="button" class="gp-drawer-tab" data-gp-tab="notes" role="tab" aria-selected="false">${noteIcon(16)} Project Notes</button>
    </div>
    <div class="gp-drawer-body">
      <section class="gp-drawer-pane" data-gp-pane="prompt" role="tabpanel">
        <p class="gp-drawer-hint">These instructions will be automatically applied to new chats created in this project.</p>
        <textarea class="gp-drawer-textarea" data-gp-prompt-input rows="7" placeholder="e.g. You are a senior React engineer. Always answer with TypeScript snippets and explain trade-offs." spellcheck="false"></textarea>
      </section>
      <section class="gp-drawer-pane" data-gp-pane="notes" role="tabpanel" style="display:none">
        <p class="gp-drawer-hint">Freeform scratchpad for references, outlines, and links. Stored locally and encrypted before sync.</p>
        <textarea class="gp-drawer-textarea gp-drawer-textarea-tall" data-gp-notes-input rows="12" placeholder="# Notes&#10;- Project specification&#10;- Decisions &amp; open questions" spellcheck="false"></textarea>
      </section>
    </div>
    <footer class="gp-drawer-footer">
      <span class="gp-drawer-status" data-gp-drawer-status role="status" aria-live="polite"></span>
    </footer>
  `;

  options.layer.appendChild(backdrop);
  options.layer.appendChild(drawer);

  const promptInput = drawer.querySelector<HTMLTextAreaElement>('[data-gp-prompt-input]');
  const notesInput = drawer.querySelector<HTMLTextAreaElement>('[data-gp-notes-input]');
  const statusEl = drawer.querySelector<HTMLElement>('[data-gp-drawer-status]');
  const iconEl = drawer.querySelector<HTMLElement>('[data-gp-drawer-icon]');
  const projectEl = drawer.querySelector<HTMLElement>('[data-gp-drawer-project]');
  const closeBtn = drawer.querySelector<HTMLButtonElement>('[data-gp-drawer-close]');

  let currentProject: Project | null = null;
  let saveTimer: number | null = null;
  let statusTimer: number | null = null;
  let closed = true;

  function setStatus(text: string): void {
    if (statusEl) statusEl.textContent = text;
    if (statusTimer !== null) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (text) {
      statusTimer = window.setTimeout(() => {
        if (statusEl && statusEl.textContent === text) {
          statusEl.textContent = '';
        }
        statusTimer = null;
      }, 1800);
    }
  }

  async function persist(): Promise<void> {
    if (!currentProject || closed) return;
    try {
      await options.saveProjectMeta(currentProject.id, {
        systemPrompt: promptInput?.value ?? '',
        notes: notesInput?.value ?? ''
      });
      setStatus('Saved');
    } catch (error) {
      console.warn('[Gemini Projects] workspace save failed', error);
      setStatus('Save failed');
    }
  }

  function queueSave(): void {
    if (!currentProject) return;
    setStatus('Saving…');
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void persist();
    }, SAVE_DEBOUNCE_MS);
  }

  function show(): void {
    closed = false;
    backdrop.classList.add('open');
    drawer.classList.add('open');
  }

  function hide(): void {
    closed = true;
    backdrop.classList.remove('open');
    drawer.classList.remove('open');
  }

  function close(): void {
    // Flush any pending debounced edits before hiding.
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      void persist();
    }
    hide();
    currentProject = null;
  }

  function renderHeader(project: Project): void {
    const accent = project.color && project.color.toLowerCase() !== '#1f1f1f' ? project.color : undefined;
    if (iconEl) {
      iconEl.innerHTML = project.kind === 'folder'
        ? renderIconSvg('default', accent)
        : renderIconSvg(project.icon, accent);
      iconEl.style.color = accent ?? 'var(--gp-fg-muted)';
    }
    if (projectEl) projectEl.textContent = project.name;
  }

  async function open(project: Project): Promise<void> {
    currentProject = project;
    renderHeader(project);
    try {
      const meta = await options.loadProjectMeta(project.id);
      if (promptInput) promptInput.value = meta.systemPrompt;
      if (notesInput) notesInput.value = meta.notes;
    } catch (error) {
      console.warn('[Gemini Projects] workspace metadata load failed', error);
      if (promptInput) promptInput.value = project.systemPrompt ?? '';
      if (notesInput) notesInput.value = project.notes ?? '';
    }
    show();
    options.onActiveProjectChange?.(project.id);
  }

  promptInput?.addEventListener('input', queueSave);
  notesInput?.addEventListener('input', queueSave);

  promptInput?.addEventListener('blur', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      void persist();
    }
  });
  notesInput?.addEventListener('blur', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      void persist();
    }
  });

  closeBtn?.addEventListener('click', () => close());

  backdrop.addEventListener('click', () => close());

  drawer.querySelectorAll<HTMLButtonElement>('[data-gp-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.gpTab ?? 'prompt';
      drawer.querySelectorAll<HTMLButtonElement>('[data-gp-tab]').forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', String(isActive));
      });
      drawer.querySelectorAll<HTMLElement>('[data-gp-pane]').forEach((pane) => {
        pane.style.display = pane.dataset.gpPane === tabName ? '' : 'none';
      });
      if (tabName === 'prompt') {
        promptInput?.focus();
      } else {
        notesInput?.focus();
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !closed) {
      close();
    }
  });

  return {
    open,
    close,
    isOpen: () => !closed
  };
}

function ensureDrawerStyle(root: ShadowRoot | Document): void {
  if (root.querySelector(`style[data-gp="workspace-drawer"]`)) return;
  const style = document.createElement('style');
  style.dataset.gp = 'workspace-drawer';
  style.textContent = `
    .gp-drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(32, 33, 36, 0.32);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      z-index: 999997;
    }
    .gp-drawer-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .gp-workspace-drawer {
      position: fixed;
      top: 0;
      right: 0;
      height: 100dvh;
      width: 380px;
      max-width: calc(100vw - 24px);
      background: var(--gp-surface, #ffffff);
      color: var(--gp-fg, #1f1f1f);
      border-left: 1px solid var(--gp-border, rgba(60, 64, 67, 0.12));
      box-shadow: var(--gp-shadow, 0 16px 40px rgba(60, 64, 67, 0.18));
      z-index: 999998;
      transform: translateX(100%);
      transition: transform 0.22s cubic-bezier(0.2, 0, 0, 1);
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      font-family: var(--gp-font, "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif);
      pointer-events: auto;
    }
    .gp-workspace-drawer.open {
      transform: translateX(0);
    }
    .gp-workspace-drawer * {
      box-sizing: border-box;
    }

    .gp-drawer-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--gp-border, rgba(60, 64, 67, 0.12));
      flex-shrink: 0;
    }
    .gp-drawer-icon {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 40px;
      border-radius: 50%;
      background: var(--gp-hover, rgba(31, 31, 31, 0.06));
      color: var(--gp-fg-muted, #5f6368);
    }
    .gp-drawer-icon svg {
      width: 22px;
      height: 22px;
      display: block;
    }
    .gp-drawer-heading {
      flex: 1;
      min-width: 0;
    }
    .gp-drawer-title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      line-height: 24px;
      color: var(--gp-fg, #1f1f1f);
    }
    .gp-drawer-project {
      font-size: 13px;
      line-height: 18px;
      color: var(--gp-fg-muted, #5f6368);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .gp-drawer-close {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: var(--gp-fg-muted, #5f6368);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .gp-drawer-close svg { width: 18px; height: 18px; }
    .gp-drawer-close:hover {
      background: var(--gp-hover, rgba(31, 31, 31, 0.06));
      color: var(--gp-fg, #1f1f1f);
    }

    .gp-drawer-tabs {
      display: flex;
      gap: 4px;
      padding: 12px 16px 0;
      border-bottom: 1px solid var(--gp-border, rgba(60, 64, 67, 0.12));
      flex-shrink: 0;
    }
    .gp-drawer-tab {
      appearance: none;
      border: none;
      background: transparent;
      padding: 8px 14px;
      border-radius: 12px 12px 0 0;
      font-family: inherit;
      font-size: 13.5px;
      font-weight: 600;
      color: var(--gp-fg-muted, #5f6368);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s ease, background 0.15s ease;
    }
    .gp-drawer-tab:hover {
      color: var(--gp-fg, #1f1f1f);
      background: var(--gp-hover, rgba(31, 31, 31, 0.06));
    }
    .gp-drawer-tab.active {
      color: var(--gp-accent, #1a73e8);
      border-bottom-color: var(--gp-accent, #1a73e8);
    }
    .gp-drawer-tab svg {
      width: 16px;
      height: 16px;
      vertical-align: -2.5px;
      margin-right: 6px;
    }

    .gp-drawer-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
    }
    .gp-drawer-pane {
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 1;
      min-height: 0;
    }
    .gp-drawer-hint {
      margin: 0;
      font-size: 12.5px;
      line-height: 18px;
      color: var(--gp-fg-muted, #5f6368);
    }
    .gp-drawer-textarea {
      width: 100%;
      flex: 1;
      min-height: 120px;
      resize: vertical;
      border: 1px solid var(--gp-border, rgba(60, 64, 67, 0.12));
      border-radius: 12px;
      background: var(--gp-input-bg, #f8fafd);
      color: var(--gp-fg, #1f1f1f);
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.55;
      padding: 12px 14px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }
    .gp-drawer-textarea-tall {
      flex: 1.6;
      min-height: 200px;
    }
    .gp-drawer-textarea::placeholder {
      color: var(--gp-fg-muted, #5f6368);
      opacity: 0.8;
    }
    .gp-drawer-textarea:hover {
      border-color: var(--gp-selected-border, rgba(60, 64, 67, 0.22));
    }
    .gp-drawer-textarea:focus {
      border-color: var(--gp-accent, #1a73e8);
      box-shadow: 0 0 0 3px var(--gp-focus-ring, rgba(26, 115, 232, 0.16));
      background: var(--gp-surface, #ffffff);
    }

    .gp-drawer-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      min-height: 40px;
      padding: 6px 20px 10px;
      border-top: 1px solid var(--gp-border, rgba(60, 64, 67, 0.12));
      flex-shrink: 0;
    }
    .gp-drawer-status {
      font-size: 12px;
      color: var(--gp-fg-muted, #5f6368);
      min-height: 16px;
    }
  `;
  root.appendChild(style);
}