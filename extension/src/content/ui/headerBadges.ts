import { SyncStatus } from '../../shared/types';
import { libraryIcon, settingsGearIcon } from './icons';

export type PromptsBadgeElement = HTMLElement & {
  updateCount: (count: number) => void;
};

export type SettingsBadgeElement = HTMLElement & {
  updateStatus: (status: SyncStatus) => void;
};

/**
 * Tooltip copy per sync state; the dot color mirrors the same mapping below.
 */
const STATUS_TOOLTIPS: Record<SyncStatus, string> = {
  unconfigured: 'Sync is not configured. Click to open settings.',
  idle: 'Sync is not configured. Click to open settings.',
  synced: 'Workspace is in sync. Click to open settings.',
  syncing: 'Synchronizing with the server…',
  offline: 'You are offline. Changes will sync when you reconnect.',
  conflict: 'Conflicting changes detected. Click to resolve.',
  error: 'Sync failed. Click to review settings.'
};

const STATUS_DOT_CLASSES = [
  'dot-unconfigured',
  'dot-idle',
  'dot-synced',
  'dot-syncing',
  'dot-offline',
  'dot-conflict',
  'dot-error'
] as const;

/**
 * The single header settings badge: an icon-only gear button that opens the
 * combined settings dialog (Sync + Settings tabs). A tiny status dot in the
 * corner mirrors the live sync state so problems stay visible at a glance.
 */
export function createSettingsBadge(
  onClick: () => void,
  initialStatus: SyncStatus = 'unconfigured'
): SettingsBadgeElement {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'gp-settings-badge';
  badge.setAttribute('aria-label', 'Open settings');
  badge.innerHTML = `
    <span class="gp-sync-icon" aria-hidden="true">${settingsGearIcon(16)}</span>
    <span class="gp-status-dot" aria-hidden="true"></span>
  `;
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  function apply(status: SyncStatus): void {
    badge.classList.remove(...STATUS_DOT_CLASSES);
    badge.classList.add(`dot-${status}`);
    badge.title = STATUS_TOOLTIPS[status] ?? STATUS_TOOLTIPS.unconfigured;
    badge.setAttribute('aria-label', `Open settings (sync status: ${status})`);
  }

  apply(initialStatus);

  return Object.assign(badge, { updateStatus: apply });
}

/** Header pill opening the prompt library (icon, label and a count chip). */
export function createPromptsBadge(onClick: () => void, initialCount = 0): PromptsBadgeElement {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'gp-sync-badge gp-prompts-badge';
  badge.title = 'Prompt library — view, add and edit prompts';
  badge.setAttribute('aria-label', 'Open prompt library');
  badge.innerHTML = `
    <span class="gp-sync-icon" aria-hidden="true">${libraryIcon(14)}</span>
    <span class="gp-sync-label">Prompts</span>
    <span class="gp-prompts-count" data-gp-count>${initialCount}</span>
  `;
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  return Object.assign(badge, {
    updateCount(count: number) {
      const chip = badge.querySelector<HTMLElement>('[data-gp-count]');
      if (chip) chip.textContent = String(count);
    }
  });
}
