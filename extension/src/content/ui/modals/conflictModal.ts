import type { SyncResolution, SyncConflictDetail, WorkspacePayload } from '../../../shared/types';
import { isMobileEnvironment } from '../../../shared/env';

const ROOT_ID = 'gp-sync-conflict-root';
const COUNTDOWN_SECONDS = 10;
const COUNTDOWN_TICK_MS = 100;

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const WARN_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="M12 11v3.5"/><path d="M12 17.5h.01"/></svg>';

const STYLE = `
.gp-sync-conflict-root {
  all: initial;
  --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif;
  --gp-fg: #1f1f1f;
  --gp-fg-muted: #5f6368;
  --gp-muted: #747775;
  --gp-border: rgba(60, 64, 67, 0.12);
  --gp-hover: #f1f3f4;
  --gp-selected-border: rgba(60, 64, 67, 0.22);
  --gp-surface: #ffffff;
  --gp-surface-2: #f8fafd;
  --gp-shadow: 0 16px 40px rgba(60, 64, 67, 0.18), 0 1px 3px rgba(60, 64, 67, 0.16);
  --gp-accent: #1a73e8;
  --gp-on-accent: #ffffff;
  --gp-focus: #1a73e8;
  --gp-focus-ring: rgba(26, 115, 232, 0.16);
  --gp-warn: #ea4335;
}
.gp-sync-conflict-root.gp-sync-dark {
  --gp-fg: #e8eaed;
  --gp-fg-muted: #bdc1c6;
  --gp-muted: #9aa0a6;
  --gp-border: rgba(232, 234, 237, 0.16);
  --gp-hover: rgba(255, 255, 255, 0.08);
  --gp-selected-border: rgba(232, 234, 237, 0.28);
  --gp-surface: #202124;
  --gp-surface-2: #292a2d;
  --gp-shadow: 0 24px 52px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.36);
  --gp-accent: #8ab4f8;
  --gp-on-accent: #202124;
  --gp-focus: #8ab4f8;
  --gp-focus-ring: rgba(138, 180, 248, 0.22);
  --gp-warn: #f28b82;
}
.gp-sync-conflict-root,
.gp-sync-conflict-root * { box-sizing: border-box; }
.gp-sync-conflict-root .gp-sync-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(32, 33, 36, 0.5);
  backdrop-filter: blur(3px);
  font-family: var(--gp-font);
  color: var(--gp-fg);
}
.gp-sync-conflict-root .gp-sync-dialog {
  width: 520px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  background: var(--gp-surface);
  border: 1px solid var(--gp-border);
  border-radius: 24px;
  box-shadow: var(--gp-shadow);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.gp-sync-conflict-root .gp-sync-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.gp-sync-conflict-root .gp-sync-warn-icon {
  flex: 0 0 auto;
  color: var(--gp-warn);
  display: inline-flex;
  margin-top: 1px;
}
.gp-sync-conflict-root .gp-sync-warn-icon svg { width: 26px; height: 26px; }
.gp-sync-conflict-root .gp-sync-title-wrap { min-width: 0; flex: 1; }
.gp-sync-conflict-root .gp-sync-title {
  margin: 0;
  font-family: var(--gp-font);
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 0.01em;
  color: var(--gp-fg);
}
.gp-sync-conflict-root .gp-sync-subtitle {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--gp-muted);
}
.gp-sync-conflict-root .gp-sync-close {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--gp-muted);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.gp-sync-conflict-root .gp-sync-close:hover { background: var(--gp-hover); }
.gp-sync-conflict-root .gp-sync-close svg { width: 18px; height: 18px; }
.gp-sync-conflict-root .gp-sync-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.gp-sync-conflict-root .gp-sync-card {
  border: 1px solid var(--gp-border);
  border-radius: 14px;
  background: var(--gp-surface-2);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gp-sync-conflict-root .gp-sync-card.highlight {
  border-color: var(--gp-accent);
  background: var(--gp-focus-ring);
}
.gp-sync-conflict-root .gp-sync-card-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
}
.gp-sync-conflict-root .gp-sync-card-rows { display: flex; flex-direction: column; gap: 4px; }
.gp-sync-conflict-root .gp-sync-card-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  color: var(--gp-fg);
}
.gp-sync-conflict-root .gp-sync-card-row span:last-child { font-weight: 600; }
.gp-sync-conflict-root .gp-sync-countdown { display: flex; flex-direction: column; gap: 6px; }
.gp-sync-conflict-root .gp-sync-countdown-track {
  height: 4px;
  border-radius: 999px;
  background: var(--gp-hover);
  overflow: hidden;
}
.gp-sync-conflict-root .gp-sync-countdown-fill {
  height: 100%;
  width: 100%;
  background: var(--gp-warn);
  border-radius: 999px;
  transition: width 100ms linear;
}
.gp-sync-conflict-root .gp-sync-countdown-text {
  font-size: 12.5px;
  color: var(--gp-muted);
}
.gp-sync-conflict-root .gp-sync-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.gp-sync-conflict-root .gp-sync-choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px 14px;
  border-radius: 14px;
  text-align: left;
  border: 1px solid var(--gp-border);
  background: transparent;
  color: var(--gp-fg);
  cursor: pointer;
  font-family: var(--gp-font);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.gp-sync-conflict-root .gp-sync-choice:hover {
  background: var(--gp-hover);
  border-color: var(--gp-selected-border);
}
.gp-sync-conflict-root .gp-sync-choice-title { font-size: 13.5px; font-weight: 700; }
.gp-sync-conflict-root .gp-sync-choice-desc {
  font-size: 12px;
  color: var(--gp-muted);
  line-height: 15px;
}
.gp-sync-conflict-root .gp-sync-choice.primary {
  background: var(--gp-focus);
  border-color: var(--gp-focus);
  color: var(--gp-on-accent);
}
.gp-sync-conflict-root .gp-sync-choice.primary .gp-sync-choice-desc {
  color: color-mix(in srgb, var(--gp-on-accent) 78%, transparent);
}
.gp-sync-conflict-root .gp-sync-choice.primary:hover { filter: brightness(0.96); }

/* Mobile (touch-first): single-column cards/choices and a full-width dialog. */
.gp-sync-conflict-root.gp-mobile .gp-sync-backdrop {
  padding: 10px 0;
}
.gp-sync-conflict-root.gp-mobile .gp-sync-dialog {
  width: 100%;
  max-width: 100vw;
  max-height: calc(100dvh - 20px);
  border-radius: 22px;
  padding: 18px 16px calc(18px + env(safe-area-inset-bottom, 0px));
}
.gp-sync-conflict-root.gp-mobile .gp-sync-cards,
.gp-sync-conflict-root.gp-mobile .gp-sync-choices {
  grid-template-columns: 1fr;
}
.gp-sync-conflict-root.gp-mobile .gp-sync-choice {
  padding: 14px 16px;
}
.gp-sync-conflict-root.gp-mobile .gp-sync-close {
  width: 36px;
  height: 36px;
}
`;

function countProjects(payload: WorkspacePayload): number {
  return Object.keys(payload.projects ?? {}).length;
}

function countChats(payload: WorkspacePayload): number {
  return Object.values(payload.projects ?? {}).reduce(
    (sum, project) => sum + (project.chatIds?.length ?? 0),
    0
  );
}

function formatTimestamp(ts: number): string {
  if (!ts || ts <= 0) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
    new Date(ts)
  );
}

function cardMarkup(title: string, payload: WorkspacePayload, isNewest: boolean): string {
  return `
    <div class="gp-sync-card ${isNewest ? 'highlight' : ''}">
      <div class="gp-sync-card-title">${title}${isNewest ? ' · Newest' : ''}</div>
      <div class="gp-sync-card-rows">
        <div class="gp-sync-card-row"><span>Last modified</span><span>${formatTimestamp(payload.updatedAt)}</span></div>
        <div class="gp-sync-card-row"><span>Projects</span><span>${countProjects(payload)}</span></div>
        <div class="gp-sync-card-row"><span>Chats</span><span>${countChats(payload)}</span></div>
      </div>
    </div>
  `;
}

function buildMarkup(
  newestIsRemote: boolean,
  localState: WorkspacePayload,
  remoteState: WorkspacePayload
): string {
  const newestSide = newestIsRemote ? 'Remote' : 'Local';
  return `
    <div class="gp-sync-backdrop" data-gp-sync-backdrop>
      <div class="gp-sync-dialog" data-gp-dialog role="dialog" aria-modal="true" aria-labelledby="gp-sync-conflict-title">
        <div class="gp-sync-header">
          <span class="gp-sync-warn-icon" aria-hidden="true">${WARN_ICON}</span>
          <div class="gp-sync-title-wrap">
            <h2 class="gp-sync-title" id="gp-sync-conflict-title">Workspace conflict detected</h2>
            <p class="gp-sync-subtitle">This device and the server changed since the last sync. Choose how to resolve it.</p>
          </div>
          <button class="gp-sync-close" data-gp-action="close" type="button" aria-label="Close">${CLOSE_ICON}</button>
        </div>

        <div class="gp-sync-cards">
          ${cardMarkup('Local Workspace', localState, !newestIsRemote)}
          ${cardMarkup('Remote Server Workspace', remoteState, newestIsRemote)}
        </div>

        <div class="gp-sync-countdown">
          <div class="gp-sync-countdown-track" aria-hidden="true"><div class="gp-sync-countdown-fill" data-gp-countdown-fill></div></div>
          <div class="gp-sync-countdown-text" data-gp-countdown-text role="status" aria-live="polite"></div>
        </div>

        <div class="gp-sync-choices">
          <button class="gp-sync-choice primary" type="button" data-gp-choice="newest">
            <span class="gp-sync-choice-title">Use Newest (${newestSide})</span>
            <span class="gp-sync-choice-desc">Keeps the ${newestSide.toLowerCase()} workspace, which was modified later.</span>
          </button>
          <button class="gp-sync-choice" type="button" data-gp-choice="merge">
            <span class="gp-sync-choice-title">Merge Both</span>
            <span class="gp-sync-choice-desc">Combine projects, folders and prompts from both devices.</span>
          </button>
          <button class="gp-sync-choice" type="button" data-gp-choice="local">
            <span class="gp-sync-choice-title">Keep This Device</span>
            <span class="gp-sync-choice-desc">Overwrite the server with this device's workspace.</span>
          </button>
          <button class="gp-sync-choice" type="button" data-gp-choice="remote">
            <span class="gp-sync-choice-title">Keep Other Device</span>
            <span class="gp-sync-choice-desc">Replace this device with the server workspace.</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function openConflictModal(
  detail: SyncConflictDetail,
  onResolve: (choice: SyncResolution) => void
): void {
  document.getElementById(ROOT_ID)?.remove();

  const { localState, remoteState } = detail;
  const newestIsRemote = remoteState.updatedAt > localState.updatedAt;
  const newestChoice: SyncResolution = newestIsRemote ? 'keep_remote' : 'keep_local';

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'gp-sync-conflict-root';
  if (isMobileEnvironment()) root.classList.add('gp-mobile');
  root.innerHTML = `<style>${STYLE}</style>${buildMarkup(newestIsRemote, localState, remoteState)}`;
  document.body.appendChild(root);

  const backdrop = root.querySelector<HTMLElement>('[data-gp-sync-backdrop]')!;
  const dialog = root.querySelector<HTMLElement>('[data-gp-dialog]')!;
  const fill = root.querySelector<HTMLElement>('[data-gp-countdown-fill]')!;
  const text = root.querySelector<HTMLElement>('[data-gp-countdown-text]')!;

  const applyTheme = () =>
    root.classList.toggle('gp-sync-dark', document.body.className.toLowerCase().includes('dark'));
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  let remaining = COUNTDOWN_SECONDS;
  let paused = false;
  let finished = false;
  let intervalId: number | null = null;
  let touchResumeTimer: number | null = null;

  function cleanup(): void {
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pagehide', cleanup);
    if (touchResumeTimer !== null) window.clearTimeout(touchResumeTimer);
    themeObserver.disconnect();
    root.remove();
  }

  function renderCountdown(): void {
    const pct = (remaining / COUNTDOWN_SECONDS) * 100;
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    text.textContent = `Auto-resolving with newest change in ${remaining.toFixed(1)}s…`;
  }

  function finish(choice: SyncResolution): void {
    if (finished) return;
    finished = true;
    if (intervalId !== null) window.clearInterval(intervalId);
    cleanup();
    onResolve(choice);
  }

  function cancel(): void {
    if (finished) return;
    finished = true;
    if (intervalId !== null) window.clearInterval(intervalId);
    cleanup();
  }

  function tick(): void {
    if (paused) return;
    remaining = Math.max(0, remaining - COUNTDOWN_TICK_MS / 1000);
    renderCountdown();
    if (remaining <= 0) finish(newestChoice);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cancel();
  }

  renderCountdown();
  intervalId = window.setInterval(tick, COUNTDOWN_TICK_MS);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('pagehide', cleanup);

  dialog.addEventListener('mouseenter', () => {
    paused = true;
  });
  dialog.addEventListener('mouseleave', () => {
    paused = false;
  });
  // Touch devices have no hover: a tap/hold anywhere in the dialog pauses the
  // countdown briefly so the choices can be read while deciding.
  dialog.addEventListener('pointerdown', () => {
    paused = true;
    if (touchResumeTimer !== null) window.clearTimeout(touchResumeTimer);
    touchResumeTimer = window.setTimeout(() => {
      touchResumeTimer = null;
      paused = false;
    }, 2500);
  });

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) cancel();
  });

  const bindChoice = (selector: string, choice: SyncResolution): void => {
    root.querySelector<HTMLElement>(selector)?.addEventListener('click', () => finish(choice));
  };
  bindChoice('[data-gp-choice="newest"]', newestChoice);
  bindChoice('[data-gp-choice="merge"]', 'merge');
  bindChoice('[data-gp-choice="local"]', 'keep_local');
  bindChoice('[data-gp-choice="remote"]', 'keep_remote');
  root.querySelector<HTMLElement>('[data-gp-action="close"]')?.addEventListener('click', cancel);
}
