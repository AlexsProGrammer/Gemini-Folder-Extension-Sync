import { exportAllData, triggerImport } from '../../../shared/backup';
import { errorMessage, storageLocalClear } from '../../../shared/webext';

const ROOT_ID = 'gp-extension-settings-root';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const EXPORT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5.5 20h13"/></svg>';
const IMPORT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.35-5.65"/><path d="M4 4.5v5h5"/></svg>';

// Reuses the `.gp-sync-modal-root` design tokens shared with the sync settings
// modal so both dialogs look identical; only the content sections differ.
const STYLE = `
.gp-sync-modal-root {
  all: initial;
  --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif;
  --gp-fg: #1f1f1f;
  --gp-fg-muted: #5f6368;
  --gp-muted: #747775;
  --gp-border: rgba(60, 64, 67, 0.12);
  --gp-hover: #f1f3f4;
  --gp-surface: #ffffff;
  --gp-surface-2: #f8fafd;
  --gp-shadow: 0 16px 40px rgba(60, 64, 67, 0.18), 0 1px 3px rgba(60, 64, 67, 0.16);
  --gp-accent: #1a73e8;
  --gp-on-accent: #ffffff;
  --gp-focus: #1a73e8;
  --gp-focus-ring: rgba(26, 115, 232, 0.16);
  --gp-input-bg: #f8fafd;
  --gp-danger: #b3261e;
  --gp-success: #188038;
}
.gp-sync-modal-root.gp-sync-dark {
  --gp-fg: #e8eaed;
  --gp-fg-muted: #bdc1c6;
  --gp-muted: #9aa0a6;
  --gp-border: rgba(232, 234, 237, 0.16);
  --gp-hover: rgba(255, 255, 255, 0.08);
  --gp-surface: #202124;
  --gp-surface-2: #292a2d;
  --gp-shadow: 0 24px 52px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.36);
  --gp-accent: #8ab4f8;
  --gp-on-accent: #202124;
  --gp-focus: #8ab4f8;
  --gp-focus-ring: rgba(138, 180, 248, 0.22);
  --gp-input-bg: rgba(41, 42, 45, 0.92);
  --gp-danger: #f2b8b5;
  --gp-success: #81c995;
}
.gp-sync-modal-root,
.gp-sync-modal-root * { box-sizing: border-box; }
.gp-sync-modal-root .gp-sync-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(32, 33, 36, 0.42);
  backdrop-filter: blur(3px);
  font-family: var(--gp-font);
  color: var(--gp-fg);
}
.gp-sync-modal-root .gp-sync-dialog {
  width: 460px;
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
  gap: 18px;
}
.gp-sync-modal-root .gp-sync-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.gp-sync-modal-root .gp-sync-title-wrap { min-width: 0; }
.gp-sync-modal-root .gp-sync-title {
  margin: 0;
  font-family: var(--gp-font);
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 0.01em;
  color: var(--gp-fg);
}
.gp-sync-modal-root .gp-sync-subtitle {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-sync-close {
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
.gp-sync-modal-root .gp-sync-close:hover { background: var(--gp-hover); }
.gp-sync-modal-root .gp-sync-close svg { width: 18px; height: 18px; }
.gp-sync-modal-root .gp-sync-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gp-sync-modal-root .gp-sync-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-sync-input {
  width: 100%;
  height: 42px;
  border: 1px solid var(--gp-border);
  border-radius: 12px;
  background: var(--gp-input-bg);
  color: var(--gp-fg);
  font-family: var(--gp-font);
  font-size: 14px;
  padding: 0 12px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.gp-sync-modal-root .gp-sync-input::placeholder { color: var(--gp-muted); }
.gp-sync-modal-root .gp-sync-input:focus {
  border-color: var(--gp-accent);
  box-shadow: 0 0 0 3px var(--gp-focus-ring);
}
.gp-sync-modal-root .gp-sync-label { font-size: 13px; font-weight: 600; color: var(--gp-fg); }
.gp-sync-modal-root .gp-settings-io {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.gp-sync-modal-root .gp-io-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  padding: 10px 14px;
  border: 1px solid var(--gp-border);
  border-radius: 14px;
  background: var(--gp-surface-2);
  color: var(--gp-fg);
  cursor: pointer;
  font-family: var(--gp-font);
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.gp-sync-modal-root .gp-io-btn:hover {
  border-color: var(--gp-accent);
  box-shadow: 0 0 0 3px var(--gp-focus-ring);
}
.gp-sync-modal-root .gp-io-btn:disabled { opacity: 0.6; cursor: wait; }
.gp-sync-modal-root .gp-io-btn svg {
  flex: 0 0 20px;
  color: var(--gp-accent);
}
.gp-sync-modal-root .gp-io-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gp-sync-modal-root .gp-io-title { font-size: 13.5px; font-weight: 700; }
.gp-sync-modal-root .gp-io-desc {
  font-size: 11.5px;
  line-height: 15px;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-sync-hint {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-io-status {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-io-status.ok { color: var(--gp-success); }
.gp-sync-modal-root .gp-io-status.error { color: var(--gp-danger); }
.gp-sync-modal-root .gp-io-status:empty { display: none; }
.gp-sync-modal-root .gp-sync-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}
.gp-sync-modal-root .gp-sync-danger {
  border: 1px solid rgba(179, 38, 30, 0.4);
  background: rgba(179, 38, 30, 0.05);
  border-radius: 16px;
  padding: 14px;
}
.gp-sync-modal-root.gp-sync-dark .gp-sync-danger {
  border-color: rgba(242, 184, 181, 0.4);
  background: rgba(242, 184, 181, 0.07);
}
.gp-sync-modal-root .gp-sync-danger .gp-sync-section-title { color: var(--gp-danger); }
.gp-sync-modal-root .gp-sync-danger-hint {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--gp-fg-muted);
}
.gp-sync-modal-root .gp-sync-danger-btn {
  align-self: flex-start;
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--gp-danger);
  border-radius: 999px;
  background: transparent;
  color: var(--gp-danger);
  cursor: not-allowed;
  font-family: var(--gp-font);
  font-size: 13.5px;
  font-weight: 700;
  opacity: 0.5;
}
.gp-sync-modal-root .gp-sync-danger-btn:not(:disabled) {
  cursor: pointer;
  opacity: 1;
}
.gp-sync-modal-root .gp-sync-danger-btn:not(:disabled):hover {
  background: var(--gp-danger);
  color: var(--gp-on-accent);
}
.gp-sync-modal-root .gp-sync-error {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 16px;
  color: var(--gp-danger);
}
.gp-sync-modal-root .gp-sync-cancel {
  min-width: 88px;
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--gp-border);
  border-radius: 999px;
  background: transparent;
  color: var(--gp-fg);
  cursor: pointer;
  font-family: var(--gp-font);
  font-size: 13.5px;
  font-weight: 600;
}
.gp-sync-modal-root .gp-sync-cancel:hover { background: var(--gp-hover); }
`;

function buildMarkup(): string {
  return `
    <div class="gp-sync-backdrop" data-gp-settings-backdrop>
      <div class="gp-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="gp-settings-title">
        <div class="gp-sync-header">
          <div class="gp-sync-title-wrap">
            <h2 class="gp-sync-title" id="gp-settings-title">Settings</h2>
            <p class="gp-sync-subtitle">Back up, restore or reset everything this extension stores in this browser.</p>
          </div>
          <button class="gp-sync-close" data-gp-action="close" type="button" aria-label="Close">${CLOSE_ICON}</button>
        </div>

        <div class="gp-sync-section">
          <div class="gp-sync-section-title">Backup &amp; Restore</div>
          <div class="gp-settings-io">
            <button class="gp-io-btn" data-gp-action="export" type="button">
              ${EXPORT_ICON}
              <span class="gp-io-text">
                <span class="gp-io-title">Export data</span>
                <span class="gp-io-desc">Download a JSON backup</span>
              </span>
            </button>
            <button class="gp-io-btn" data-gp-action="import" type="button">
              ${IMPORT_ICON}
              <span class="gp-io-text">
                <span class="gp-io-title">Import data</span>
                <span class="gp-io-desc">Restore from a backup file</span>
              </span>
            </button>
          </div>
          <p class="gp-sync-hint">
            The backup contains every Google account's projects, folders, chat assignments, the prompt
            library and sync settings. Importing never overwrites account data that already exists here.
          </p>
          <p class="gp-io-status" data-gp-io-status role="status" aria-live="polite"></p>
        </div>

        <div class="gp-sync-section gp-sync-danger">
          <div class="gp-sync-section-title">Danger Zone</div>
          <p class="gp-sync-danger-hint">
            Deletes <strong>everything</strong> this extension stored in the browser: all accounts'
            projects, folders, chat assignments, the prompt library and sync settings. Encrypted
            per-account data cannot be recovered afterwards. Data already synced to your server is
            not touched.
          </p>
          <div class="gp-sync-field" style="display: flex; flex-direction: column; gap: 5px;">
            <span class="gp-sync-label">Type DELETE ALL to confirm</span>
            <input class="gp-sync-input" data-gp-danger-input type="text" placeholder="DELETE ALL" autocomplete="off" spellcheck="false" />
          </div>
          <button class="gp-sync-danger-btn" data-gp-action="danger-wipe" type="button" disabled>Delete all local data</button>
        </div>

        <div class="gp-sync-actions">
          <span class="gp-sync-error" data-gp-error role="alert"></span>
          <button class="gp-sync-cancel" data-gp-action="close" type="button">Close</button>
        </div>
      </div>
    </div>
  `;
}

export function openExtensionSettingsModal(): void {
  document.getElementById(ROOT_ID)?.remove();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'gp-sync-modal-root';
  root.innerHTML = `<style>${STYLE}</style>${buildMarkup()}`;
  document.body.appendChild(root);

  const backdrop = root.querySelector<HTMLElement>('[data-gp-settings-backdrop]')!;
  const exportButton = root.querySelector<HTMLButtonElement>('[data-gp-action="export"]')!;
  const importButton = root.querySelector<HTMLButtonElement>('[data-gp-action="import"]')!;
  const ioStatus = root.querySelector<HTMLElement>('[data-gp-io-status]')!;
  const errorEl = root.querySelector<HTMLElement>('[data-gp-error]')!;
  const dangerInput = root.querySelector<HTMLInputElement>('[data-gp-danger-input]')!;
  const dangerButton = root.querySelector<HTMLButtonElement>('[data-gp-action="danger-wipe"]')!;

  const applyTheme = () =>
    root.classList.toggle('gp-sync-dark', document.body.className.toLowerCase().includes('dark'));
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function cleanup(): void {
    themeObserver.disconnect();
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pagehide', cleanup);
    root.remove();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cleanup();
  }
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('pagehide', cleanup);

  function setStatus(message: string, tone: 'ok' | 'error' | ''): void {
    ioStatus.textContent = message;
    ioStatus.classList.remove('ok', 'error');
    if (tone) ioStatus.classList.add(tone);
  }
  function setError(message: string): void {
    errorEl.textContent = message;
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) cleanup();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-gp-action="close"]').forEach((button) => {
    button.addEventListener('click', cleanup);
  });

  exportButton.addEventListener('click', async () => {
    setError('');
    exportButton.disabled = true;
    try {
      await exportAllData();
      setStatus('Backup file downloaded.', 'ok');
    } catch (error) {
      setStatus(`Export failed: ${errorMessage(error)}`, 'error');
    } finally {
      exportButton.disabled = false;
    }
  });

  importButton.addEventListener('click', () => {
    setError('');
    setStatus('', '');
    triggerImport((result) => {
      setStatus(result.message, result.success ? 'ok' : 'error');
      if (result.success) {
        // The reload rebuilds all state from the restored workspace
        // partitions; give the user a moment to read the summary first.
        window.setTimeout(() => window.location.reload(), 900);
      }
    });
  });

  // Danger Zone: the wipe button stays disabled until the exact confirmation
  // phrase is typed, so an accidental click can never destroy local data.
  dangerButton.disabled = true;
  dangerInput.addEventListener('input', () => {
    dangerButton.disabled = dangerInput.value !== 'DELETE ALL';
  });
  dangerButton.addEventListener('click', async () => {
    if (dangerInput.value !== 'DELETE ALL') return;
    dangerButton.disabled = true;
    dangerButton.textContent = 'Deleting…';
    try {
      await storageLocalClear();
      cleanup();
      window.location.reload();
    } catch (error) {
      setError(`Could not clear storage: ${errorMessage(error)}`);
      dangerButton.textContent = 'Delete all local data';
      dangerButton.disabled = false;
    }
  });
}
