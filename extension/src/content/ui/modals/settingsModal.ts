import { ensureServerHostPermission, requestRemotePull } from '../../../shared/syncClient';
import { syncEngine } from '../../../shared/syncEngine';
import { getFeatureSettings, getSyncSettings, saveFeatureSettings, saveSyncSettings } from '../../../shared/storage';
import type { SyncSettings } from '../../../shared/types';
import { exportAllData, triggerImport } from '../../../shared/backup';
import { errorMessage, storageLocalClear } from '../../../shared/webext';

const ROOT_ID = 'gp-settings-root';
const PROBE_ACCOUNT_ID = 'probe';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const EYE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="m14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m1 1 22 22"/></svg>';
const EXPORT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5.5 20h13"/></svg>';
const IMPORT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.35-5.65"/><path d="M4 4.5v5h5"/></svg>';

// Single dialog shared by the Sync and Settings tabs. All sections reuse the
// `.gp-sync-modal-root` design tokens so every tab looks identical.
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
.gp-sync-modal-root .gp-sync-tabs {
  display: flex;
  gap: 6px;
}
.gp-sync-modal-root .gp-sync-tab {
  flex: 0 0 auto;
  height: 34px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--gp-muted);
  cursor: pointer;
  font-family: var(--gp-font);
  font-size: 13.5px;
  font-weight: 600;
  transition: background 0.15s ease, color 0.15s ease;
}
.gp-sync-modal-root .gp-sync-tab:hover { background: var(--gp-hover); color: var(--gp-fg); }
.gp-sync-modal-root .gp-sync-tab.active {
  background: var(--gp-focus-ring);
  border-color: var(--gp-accent);
  color: var(--gp-accent);
}
.gp-sync-modal-root .gp-tab-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.gp-sync-modal-root .gp-tab-panel[hidden] { display: none; }
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
.gp-sync-modal-root .gp-io-status {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--gp-muted);
}
.gp-sync-modal-root .gp-io-status.ok { color: var(--gp-success); }
.gp-sync-modal-root .gp-io-status.error { color: var(--gp-danger); }
.gp-sync-modal-root .gp-io-status:empty { display: none; }
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
.gp-sync-modal-root .gp-sync-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
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

function isValidServerUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Combined settings dialog. The "Sync" tab (default) configures the sync
 * backend, the "Settings" tab holds backup/restore and the local-data wipe.
 */
export function openSettingsModal(activeAccountId: string, activeAccountLabel: string): void {
  document.getElementById(ROOT_ID)?.remove();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'gp-sync-modal-root';
  root.innerHTML = `<style>${STYLE}</style>${buildMarkup(activeAccountLabel)}`;
  document.body.appendChild(root);

  const backdrop = root.querySelector<HTMLElement>('[data-gp-settings-backdrop]')!;
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-gp-tab]'));
  const syncPanel = root.querySelector<HTMLElement>('[data-gp-tab-panel="sync"]')!;
  const settingsPanel = root.querySelector<HTMLElement>('[data-gp-tab-panel="settings"]')!;

  const serverUrlInput = root.querySelector<HTMLInputElement>('[data-gp-server-url]')!;
  const apiKeyInput = root.querySelector<HTMLInputElement>('[data-gp-api-key]')!;
  const testButton = root.querySelector<HTMLButtonElement>('[data-gp-action="test"]')!;
  const testResult = root.querySelector<HTMLElement>('[data-gp-test-result]')!;
  const globalToggle = root.querySelector<HTMLInputElement>('[data-gp-global-toggle]')!;
  const passphraseInput = root.querySelector<HTMLInputElement>('[data-gp-passphrase]')!;
  const passphraseLabel = root.querySelector<HTMLElement>('[data-gp-passphrase-label]')!;
  const accountHint = root.querySelector<HTMLElement>('[data-gp-account-hint]')!;
  const syncErrorEl = root.querySelector<HTMLElement>('[data-gp-sync-error]')!;
  const saveButton = root.querySelector<HTMLButtonElement>('[data-gp-action="save"]')!;

  const exportButton = root.querySelector<HTMLButtonElement>('[data-gp-action="export"]')!;
  const importButton = root.querySelector<HTMLButtonElement>('[data-gp-action="import"]')!;
  const ioStatus = root.querySelector<HTMLElement>('[data-gp-io-status]')!;
  const ioErrorEl = root.querySelector<HTMLElement>('[data-gp-io-error]')!;
  const dangerInput = root.querySelector<HTMLInputElement>('[data-gp-danger-input]')!;
  const dangerButton = root.querySelector<HTMLButtonElement>('[data-gp-action="danger-wipe"]')!;

  const autoInstructionsToggle = root.querySelector<HTMLInputElement>('[data-gp-feature-auto-instructions]')!;
  const instructionsButtonToggle = root.querySelector<HTMLInputElement>('[data-gp-feature-instructions-button]')!;

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

  function selectTab(name: 'sync' | 'settings'): void {
    for (const tab of tabs) {
      const active = tab.dataset.gpTab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    syncPanel.hidden = name !== 'sync';
    settingsPanel.hidden = name !== 'settings';
  }
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => selectTab((tab.dataset.gpTab as 'sync' | 'settings') ?? 'sync'));
  });
  selectTab('sync');

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

  function setSyncError(message: string): void {
    syncErrorEl.textContent = message;
  }
  function clearSyncError(): void {
    syncErrorEl.textContent = '';
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

  // Behavior toggles persist immediately and broadcast the change so live
  // features (auto-injection, the header badge) react without a reload.
  const persistFeatureSettings = () => {
    saveFeatureSettings({
      autoApplyProjectInstructions: autoInstructionsToggle.checked,
      showInstructionsButton: instructionsButtonToggle.checked
    }).catch((error) => console.warn('[gemini-projects] feature settings save failed', error));
  };
  autoInstructionsToggle.addEventListener('change', persistFeatureSettings);
  instructionsButtonToggle.addEventListener('change', persistFeatureSettings);

  void getFeatureSettings()
    .then((featureSettings) => {
      autoInstructionsToggle.checked = featureSettings.autoApplyProjectInstructions;
      instructionsButtonToggle.checked = featureSettings.showInstructionsButton;
    })
    .catch(() => undefined);

  globalToggle.addEventListener('change', () => {
    syncPassphraseMode();
    updateAccountHint();
  });

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) cleanup();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-gp-action="close"]').forEach((button) => {
    button.addEventListener('click', cleanup);
  });
  root.querySelector<HTMLButtonElement>('[data-gp-action="cancel"]')
    ?.addEventListener('click', cleanup);

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
    clearSyncError();
    testButton.disabled = true;
    testButton.textContent = 'Testing…';
    showTestResult('', '');
    try {
      const permission = await ensureServerHostPermission(serverUrl);
      if (!permission.granted) {
        showTestResult('Host access to the sync server was denied. Grant it to test the connection.', 'error');
        return;
      }
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

    clearSyncError();
    if (!isValidServerUrl(serverUrl)) {
      setSyncError('Enter a valid http(s) server URL.');
      return;
    }
    if (!apiKey) {
      setSyncError('API key is required.');
      return;
    }
    if (!passphrase) {
      setSyncError('Enter an encryption passphrase.');
      return;
    }

    const permission = await ensureServerHostPermission(serverUrl);
    if (!permission.granted) {
      setSyncError('Host access to the sync server was denied. Grant it to enable sync.');
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
        setSyncError('Could not derive the encryption key from that passphrase.');
        saveButton.disabled = false;
        return;
      }
      cleanup();
      void syncEngine.pull(activeAccountId).catch((error) =>
        console.warn('[gemini-projects] pull after settings save failed', error)
      );
    } catch (error) {
      console.warn('[gemini-projects] saving sync settings failed', error);
      setSyncError('Could not save settings. Please try again.');
      saveButton.disabled = false;
    }
  });

  function setIoStatus(message: string, tone: 'ok' | 'error' | ''): void {
    ioStatus.textContent = message;
    ioStatus.classList.remove('ok', 'error');
    if (tone) ioStatus.classList.add(tone);
  }
  function setIoError(message: string): void {
    ioErrorEl.textContent = message;
  }

  exportButton.addEventListener('click', async () => {
    setIoError('');
    exportButton.disabled = true;
    try {
      await exportAllData();
      setIoStatus('Backup file downloaded.', 'ok');
    } catch (error) {
      setIoStatus(`Export failed: ${errorMessage(error)}`, 'error');
    } finally {
      exportButton.disabled = false;
    }
  });

  importButton.addEventListener('click', () => {
    setIoError('');
    setIoStatus('', '');
    triggerImport((result) => {
      setIoStatus(result.message, result.success ? 'ok' : 'error');
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
      setIoError(`Could not clear storage: ${errorMessage(error)}`);
      dangerButton.textContent = 'Delete all local data';
      dangerButton.disabled = false;
    }
  });
}

function buildMarkup(activeAccountLabel: string): string {
  return `
    <div class="gp-sync-backdrop" data-gp-settings-backdrop>
      <div class="gp-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="gp-settings-title">
        <div class="gp-sync-header">
          <div class="gp-sync-title-wrap">
            <h2 class="gp-sync-title" id="gp-settings-title">Settings</h2>
            <p class="gp-sync-subtitle">Manage the sync backend and the data stored in this browser.</p>
          </div>
          <button class="gp-sync-close" data-gp-action="close" type="button" aria-label="Close">${CLOSE_ICON}</button>
        </div>

        <div class="gp-sync-tabs" role="tablist" aria-label="Settings sections">
          <button class="gp-sync-tab active" data-gp-tab="sync" type="button" role="tab" aria-selected="true">Sync</button>
          <button class="gp-sync-tab" data-gp-tab="settings" type="button" role="tab" aria-selected="false">Settings</button>
        </div>

        <div class="gp-tab-panel" data-gp-tab-panel="sync">
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

          <div class="gp-sync-actions">
            <span class="gp-sync-error" data-gp-sync-error role="alert"></span>
            <button class="gp-sync-cancel" data-gp-action="cancel" type="button">Cancel</button>
            <button class="gp-sync-primary" data-gp-action="save" type="button">Save &amp; Sync</button>
          </div>
        </div>

        <div class="gp-tab-panel" data-gp-tab-panel="settings" hidden>
          <div class="gp-sync-section">
            <div class="gp-sync-section-title">Behavior</div>
            <label class="gp-sync-check-row">
              <input type="checkbox" data-gp-feature-auto-instructions />
              <span>Automatically add project system prompt &amp; notes to messages in project chats</span>
            </label>
            <p class="gp-sync-hint">
              Prepends the instructions into the chat input when a project chat is opened and re-adds
              them after every message. Removing the ⚡ pill disables it for that conversation.
            </p>
            <label class="gp-sync-check-row">
              <input type="checkbox" data-gp-feature-instructions-button />
              <span>Show an "Add instructions" button in the chat window, next to the prompt library button</span>
            </label>
            <p class="gp-sync-hint">
              The button only appears in projects (and their subfolders) that have a system prompt or
              notes configured, and adds them to the chat input on demand.
            </p>
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
            <span class="gp-sync-error" data-gp-io-error role="alert"></span>
            <button class="gp-sync-cancel" data-gp-action="close" type="button">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
