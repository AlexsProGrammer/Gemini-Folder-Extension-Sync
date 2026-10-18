import { libraryIcon, settingsGearIcon } from './icons';

export type PromptsBadgeElement = HTMLElement & {
  updateCount: (count: number) => void;
};

export type SettingsBadgeElement = HTMLElement;

/**
 * Header pill opening the prompt library. Mirrors the sync status pill so the
 * header reads as one row of equal badges (Prompts · Config · Settings).
 */
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

/** Header pill opening the extension settings modal (backup, restore, wipe). */
export function createSettingsBadge(onClick: () => void): SettingsBadgeElement {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'gp-sync-badge gp-settings-badge';
  badge.title = 'Settings — backup, restore and local data';
  badge.setAttribute('aria-label', 'Open extension settings');
  badge.innerHTML = `
    <span class="gp-sync-icon" aria-hidden="true">${settingsGearIcon(14)}</span>
    <span class="gp-sync-label">Settings</span>
  `;
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return badge;
}
