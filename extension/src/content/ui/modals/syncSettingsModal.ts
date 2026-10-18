import { requestRemotePull } from '../../../shared/syncClient';
import { syncEngine } from '../../../shared/syncEngine';
import { getSyncSettings, saveSyncSettings } from '../../../shared/storage';
import { errorMessage, storageLocalClear } from '../../../shared/webext';
import type { SyncSettings } from '../../../shared/types';

const ROOT_ID = 'gp-sync-settings-root';
const PROBE_ACCOUNT_ID = 'probe';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const EYE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="m14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m1 1 22 22"/></svg>';

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
.gp-sync-modal-root .gp-sync-field { display: flex; flex-direction: column; gap: 5px; }
.gp-sync-modal-root .gp-sync-label { font-size: 13px; font-weight: 600; color: var(--gp-fg); }
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
.gp-sync-modal-root .gp-sync-password-wrap { position: relative; }
.gp-sync-modal-root .gp-sync-password-wrap .gp-sync-input { padding-right: 44px; }
.gp-sync-modal-root .gp-sync-eye {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 32px;
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
.gp-sync-modal-root .gp-sync-eye:hover { background: var(--gp-hover); color: var(--gp-fg); }
.gp-sync-modal-root .gp-sync-eye svg { width: 16px; height: 16px; }
.gp-sync-modal-root .gp-sync-test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 20px;
}
.gp-sync-modal-root .gp-sync-test-result {
  font-size: 12.5px;
  line-height: 16px;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-sync-test-result.ok { color: var(--gp-success); }
.gp-sync-modal-root .gp-sync-test-result.error { color: var(--gp-danger); }
.gp-sync-modal-root .gp-sync-account-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  max-width: 100%;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--gp-border);
  border-radius: 999px;
  background: var(--gp-hover);
  color: var(--gp-fg);
  font-size: 12.5px;
  font-weight: 600;
}
.gp-sync-modal-root .gp-sync-account-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gp-sync-modal-root .gp-sync-account-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gp-accent);
  flex: 0 0 8px;
}
.gp-sync-modal-root .gp-sync-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13.5px;
  color: var(--gp-fg);
}
.gp-sync-modal-root .gp-sync-check-row input {
  width: 16px;
  height: 16px;
  accent-color: var(--gp-accent);
  margin: 0;
  flex: 0 0 16px;
}
.gp-sync-modal-root .gp-sync-hint {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--gp-muted);
}
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
.gp-sync-modal-root .gp-sync-ghost,
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
.gp-sync-modal-root .gp-sync-ghost:hover,
.gp-sync-modal-root .gp-sync-cancel:hover { background: var(--gp-hover); }
.gp-sync-modal-root .gp-sync-ghost:disabled { opacity: 0.6; cursor: wait; }
.gp-sync-modal-root .gp-sync-primary {
  height: 38px;
  padding: 0 20px;
  border: 1px solid var(--gp-focus);
  border-radius: 999px;
  background: var(--gp-focus);
  color: var(--gp-on-accent);
  cursor: pointer;
  font-family: var(--gp-font);
  font-size: 14px;
  font-weight: 700;
}
.gp-sync-modal-root .gp-sync-primary:disabled { opacity: 0.6; cursor: wait; }
.gp-sync-modal-root .gp-sync-primary:not(:disabled):hover { filter: brightness(0.96); }
`;

function buildMarkup(activeAccountLabel: string): string {
  return `
    <div class="gp-sync-backdrop" data-gp-sync-backdrop>
      <div class="gp-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="gp-sync-title">
        <div class="gp-sync-header">
          <div class="gp-sync-title-wrap">
            <h2 class="gp-sync-title" id="gp-sync-title">Sync settings</h2>
            <p class="gp-sync-subtitle">Connect this browser to your self-hosted sync server.</p>
          </div>
          <button class="gp-sync-close" data-gp-action="close" type="button" aria-label="Close">${CLOSE_ICON}</button>
        </div>

        <div class="gp-sync-section">
          <div class="gp-sync-section-title">Connection</div>
          <label class="gp-sync-field">
            <span class="gp-sync-label">Server URL</span>
            <input class="gp-sync-input" data-gp-server-url type="url" placeholder="https://sync.example.com" spellcheck="false" autocomplete="off" />
          </label>
          <div class="gp-sync-field">
            <span class="gp-sync-label">API Key</span>
            <div class="gp-sync-password-wrap">
              <input class="gp-sync-input" data-gp-api-key type="password" placeholder="Paste your API key" spellcheck="false" autocomplete="off" />
              <button class="gp-sync-eye" data-gp-action="toggle-key" type="button" aria-label="Show or hide API key">${EYE_ICON}</button>
            </div>
          </div>
          <div class="gp-sync-test-row">
            <button class="gp-sync-ghost" data-gp-action="test" type="button">Test Connection</button>
            <span class="gp-sync-test-result" data-gp-test-result role="status" aria-live="polite"></span>
          </div>
        </div>

        <div class="gp-sync-section">
          <div class="gp-sync-section-title">Encryption</div>
          <div class="gp-sync-account-badge">
            <span class="gp-sync-account-dot" aria-hidden="true"></span>
            <span class="gp-sync-account-label" data-gp-account-label>${activeAccountLabel}</span>
          </div>
          <label class="gp-sync-check-row">
            <input type="checkbox" data-gp-global-toggle />
            <span>Use same encryption passphrase for all Google accounts</span>
          </label>
          <div class="gp-sync-field">
            <span class="gp-sync-label" data-gp-passphrase-label>Master Encryption Passphrase</span>
            <div class="gp-sync-password-wrap">
              <input class="gp-sync-input" data-gp-passphrase type="password" placeholder="Enter passphrase" spellcheck="false" autocomplete="off" />
              <button class="gp-sync-eye" data-gp-action="toggle-passphrase" type="button" aria-label="Show or hide passphrase">${EYE_ICON}</button>
            </div>
          </div>
          <p class="gp-sync-hint" data-gp-account-hint style="display: none;"></p>
        </div>

        <div class="gp-sync-section gp-sync-danger">
          <div class="gp-sync-section-title">Danger Zone</div>
          <p class="gp-sync-danger-hint">
            Deletes <strong>everything</strong> this extension stored in the browser: all accounts'
            projects, folders, chat assignments, the prompt library and sync settings. Encrypted
            per-account data cannot be recovered afterwards. Data already synced to your server is
            not touched.
          </p>
          <div class="gp-sync-field">
            <span class="gp-sync-label">Type DELETE ALL to confirm</span>
            <input class="gp-sync-input" data-gp-danger-input type="text" placeholder="DELETE ALL" autocomplete="off" spellcheck="false" />
          </div>
          <button class="gp-sync-danger-btn" data-gp-action="danger-wipe" type="button" disabled>Delete all local data</button>
        </div>

        <div class="gp-sync-actions">
          <span class="gp-sync-error" data-gp-error role="alert"></span>
          <button class="gp-sync-cancel" data-gp-action="cancel" type="button">Cancel</button>
          <button class="gp-sync-primary" data-gp-action="save" type="button">Save &amp; Sync</button>
        </div>
      </div>
    </div>
  `;
}

function isValidServerUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openSyncSettingsModal(activeAccountId: string, activeAccountLabel: string): void {
  document.getElementById(ROOT_ID)?.remove();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'gp-sync-modal-root';
  root.innerHTML = `<style>${STYLE}</style>${buildMarkup(activeAccountLabel)}`;
  document.body.appendChild(root);

  const backdrop = root.querySelector<HTMLElement>('[data-gp-sync-backdrop]')!;
  const serverUrlInput = root.querySelector<HTMLInputElement>('[data-gp-server-url]')!;
  const apiKeyInput = root.querySelector<HTMLInputElement>('[data-gp-api-key]')!;
  const testButton = root.querySelector<HTMLButtonElement>('[data-gp-action="test"]')!;
  const testResult = root.querySelector<HTMLElement>('[data-gp-test-result]')!;
  const globalToggle = root.querySelector<HTMLInputElement>('[data-gp-global-toggle]')!;
  const passphraseInput = root.querySelector<HTMLInputElement>('[data-gp-passphrase]')!;
  const passphraseLabel = root.querySelector<HTMLElement>('[data-gp-passphrase-label]')!;
  const accountHint = root.querySelector<HTMLElement>('[data-gp-account-hint]')!;
  const errorEl = root.querySelector<HTMLElement>('[data-gp-error]')!;
  const saveButton = root.querySelector<HTMLButtonElement>('[data-gp-action="save"]')!;
  const closeButton = root.querySelector<HTMLButtonElement>('[data-gp-action="close"]')!;
  const cancelButton = root.querySelector<HTMLButtonElement>('[data-gp-action="cancel"]')!;
  const dangerInput = root.querySelector<HTMLInputElement>('[data-gp-danger-input]')!;
  const dangerButton = root.querySelector<HTMLButtonElement>('[data-gp-action="danger-wipe"]')!;

  let currentSettings: SyncSettings = {
    serverUrl: '',
    apiKey: '',
    useGlobalPassphrase: true,
    accountPassphrases: {}
  };

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

  function syncPassphraseMode(): void {
    const global = globalToggle.checked;
    passphraseLabel.textContent = global
      ? 'Master Encryption Passphrase'
      : `Passphrase for ${activeAccountLabel}`;
    passphraseInput.placeholder = global
      ? 'Master passphrase for every account'
      : `Passphrase for ${activeAccountLabel}`;
  }

  function updateAccountHint(): void {
    const global = globalToggle.checked;
    const otherCount = Object.keys(currentSettings.accountPassphrases).filter(
      (id) => id !== activeAccountId
    ).length;
    if (global || otherCount === 0) {
      accountHint.style.display = 'none';
      return;
    }
    accountHint.style.display = 'block';
    accountHint.textContent =
      otherCount === 1
        ? 'A passphrase is stored for 1 other account.'
        : `Passphrases are stored for ${otherCount} other accounts.`;
  }

  function setError(message: string): void {
    errorEl.textContent = message;
  }
  function clearError(): void {
    errorEl.textContent = '';
  }

  function showTestResult(message: string, tone: 'ok' | 'error' | ''): void {
    testResult.textContent = message;
    testResult.classList.remove('ok', 'error');
    if (tone) testResult.classList.add(tone);
  }

  function wireEyeToggle(button: HTMLButtonElement, input: HTMLInputElement): void {
    button.addEventListener('click', () => {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.innerHTML = reveal ? EYE_OFF_ICON : EYE_ICON;
      button.setAttribute('aria-label', reveal ? 'Hide' : 'Show');
    });
  }
  wireEyeToggle(
    root.querySelector<HTMLButtonElement>('[data-gp-action="toggle-key"]')!,
    apiKeyInput
  );
  wireEyeToggle(
    root.querySelector<HTMLButtonElement>('[data-gp-action="toggle-passphrase"]')!,
    passphraseInput
  );

  void getSyncSettings()
    .then((settings) => {
      currentSettings = settings;
      serverUrlInput.value = settings.serverUrl;
      apiKeyInput.value = settings.apiKey;
      globalToggle.checked = settings.useGlobalPassphrase;
      passphraseInput.value = settings.useGlobalPassphrase
        ? (settings.globalPassphrase ?? '')
        : (settings.accountPassphrases[activeAccountId] ?? '');
      syncPassphraseMode();
      updateAccountHint();
    })
    .catch(() => {
      syncPassphraseMode();
    });

  globalToggle.addEventListener('change', () => {
    syncPassphraseMode();
    updateAccountHint();
  });

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) cleanup();
  });
  closeButton.addEventListener('click', cleanup);
  cancelButton.addEventListener('click', cleanup);

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
    }
  });

  testButton.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
    const apiKey = apiKeyInput.value.trim();
    if (!isValidServerUrl(serverUrl)) {
      showTestResult('Enter a valid http(s) server URL.', 'error');
      return;
    }
    if (!apiKey) {
      showTestResult('Enter the API key first.', 'error');
      return;
    }
    clearError();
    testButton.disabled = true;
    testButton.textContent = 'Testing…';
    showTestResult('', '');
    try {
      const response = await requestRemotePull({ serverUrl, apiKey }, PROBE_ACCOUNT_ID);
      if (response.success) {
        showTestResult('Connection OK.', 'ok');
      } else if (response.error === 'not_found') {
        showTestResult('Server reachable — no data for this account yet.', 'ok');
      } else if (response.error === 'unauthorized') {
        showTestResult('Invalid API Key (401).', 'error');
      } else {
        showTestResult(`Server unreachable${response.message ? ` (${response.message})` : '.'}`, 'error');
      }
    } catch {
      showTestResult('Server unreachable.', 'error');
    } finally {
      testButton.disabled = false;
      testButton.textContent = 'Test Connection';
    }
  });

  saveButton.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
    const apiKey = apiKeyInput.value.trim();
    const passphrase = passphraseInput.value;
    const useGlobal = globalToggle.checked;

    clearError();
    if (!isValidServerUrl(serverUrl)) {
      setError('Enter a valid http(s) server URL.');
      return;
    }
    if (!apiKey) {
      setError('API key is required.');
      return;
    }
    if (!passphrase) {
      setError('Enter an encryption passphrase.');
      return;
    }

    const nextSettings: SyncSettings = {
      serverUrl,
      apiKey,
      useGlobalPassphrase: useGlobal,
      accountPassphrases: { ...currentSettings.accountPassphrases }
    };
    if (useGlobal) {
      nextSettings.globalPassphrase = passphrase;
    } else {
      nextSettings.accountPassphrases[activeAccountId] = passphrase;
    }

    saveButton.disabled = true;
    try {
      await saveSyncSettings(nextSettings);
      const derived = await syncEngine.setPassphrase(activeAccountId, passphrase);
      if (!derived) {
        setError('Could not derive the encryption key from that passphrase.');
        saveButton.disabled = false;
        return;
      }
      cleanup();
      void syncEngine.pull(activeAccountId).catch((error) =>
        console.warn('[gemini-projects] pull after settings save failed', error)
      );
    } catch (error) {
      console.warn('[gemini-projects] saving sync settings failed', error);
      setError('Could not save settings. Please try again.');
      saveButton.disabled = false;
    }
  });
}
