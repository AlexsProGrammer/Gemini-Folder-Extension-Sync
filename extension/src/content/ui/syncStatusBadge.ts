import { SyncStatus } from '../../shared/types';
import {
  cloudConflictIcon,
  cloudErrorIcon,
  cloudOfflineIcon,
  cloudSyncedIcon,
  cloudSyncingIcon
} from './icons';

export type SyncStatusBadgeElement = HTMLElement & {
  updateStatus: (status: SyncStatus) => void;
};

interface BadgeState {
  label: string;
  tooltip: string;
  icon: string;
  statusClass: string;
}

const STATUS_CLASSES = [
  'status-unconfigured',
  'status-synced',
  'status-syncing',
  'status-offline',
  'status-conflict',
  'status-error'
] as const;

const BADGE_STATES: Record<SyncStatus, BadgeState> = {
  unconfigured: {
    label: 'Config',
    tooltip: 'Sync is not configured. Click to open settings.',
    icon: cloudOfflineIcon(),
    statusClass: 'status-unconfigured'
  },
  idle: {
    label: 'Config',
    tooltip: 'Sync is not configured. Click to open settings.',
    icon: cloudOfflineIcon(),
    statusClass: 'status-unconfigured'
  },
  synced: {
    label: 'Synced',
    tooltip: 'Workspace is in sync with the server.',
    icon: cloudSyncedIcon(),
    statusClass: 'status-synced'
  },
  syncing: {
    label: 'Syncing...',
    tooltip: 'Synchronizing with the server…',
    icon: cloudSyncingIcon(),
    statusClass: 'status-syncing'
  },
  offline: {
    label: 'Offline',
    tooltip: 'You are offline. Changes will sync when you reconnect.',
    icon: cloudOfflineIcon(),
    statusClass: 'status-offline'
  },
  conflict: {
    label: 'Conflict',
    tooltip: 'Conflicting changes detected. Click to resolve.',
    icon: cloudConflictIcon(),
    statusClass: 'status-conflict'
  },
  error: {
    label: 'Error',
    tooltip: 'Sync failed. Click to review settings.',
    icon: cloudErrorIcon(),
    statusClass: 'status-error'
  }
};

/**
 * Compact header pill reflecting the live sync state. Clicking it opens the
 * Sync Settings modal. The same DOM node is reused across panel re-renders;
 * only the icon, label, tooltip and state class are swapped via updateStatus.
 */
export function createSyncStatusBadge(
  onClick: () => void,
  initialStatus: SyncStatus = 'unconfigured'
): SyncStatusBadgeElement {
  function apply(status: SyncStatus): void {
    const config = BADGE_STATES[status] ?? BADGE_STATES.unconfigured;
    badge.classList.remove(...STATUS_CLASSES);
    badge.classList.add(config.statusClass);
    badge.title = config.tooltip;
    badge.setAttribute('aria-label', `Sync status: ${config.label}`);
    badge.innerHTML = `<span class="gp-sync-icon" aria-hidden="true">${config.icon}</span><span class="gp-sync-label">${config.label}</span>`;
  }

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'gp-sync-badge';
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  apply(initialStatus);

  return Object.assign(badge, { updateStatus: apply });
}
