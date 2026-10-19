import { Prompt, promptStore } from './store';
import { PANEL_TITLE_FONT_STACK, PANEL_TITLE_TYPOGRAPHY } from '../ui/typography';
import { isMobileEnvironment } from '../../shared/env';

const PICKER_ID = 'gp-prompt-picker-root';

// Icons share the stroke weight and geometry of the project modal / sidebar
// actions so the library reads as part of the same UI family.
const ICONS = {
  search: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 4 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/></svg>`
};

export class PromptPicker {
  private static instance: PromptPicker;
  private shadow: ShadowRoot;
  private host: HTMLElement;
  private isOpen = false;
  private searchQuery = '';
  private triggerRect: DOMRect | null = null;
  private selectedPromptId: string | null = null;
  private visiblePromptIds: string[] = [];
  private lastVisibleCount = 0;
  private themeObserver: MutationObserver | null = null;
  private modalDeleteConfirm = false;
  private modalDeleteTimer: number | null = null;
  // External toggle buttons (e.g. the sidebar prompt badge) that may open the
  // picker; mousedown on them must not close the picker, and Escape refocuses
  // the trigger that opened it last.
  private externalTriggers: Set<HTMLElement> = new Set();
  private lastExternalTrigger: HTMLElement | null = null;

  // Modal state
  private editingPrompt: Prompt | null = null;

  private constructor() {
    this.host = document.createElement('div');
    this.host.id = PICKER_ID;
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483647';
    this.host.style.display = 'none';
    this.host.style.pointerEvents = 'none';
    document.body.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.render();
    this.syncTheme();
    this.syncMobile();
    this.startThemeObserver();

    promptStore.subscribe(() => this.updateList());

    // Global close listener
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen) {
        const path = e.composedPath();
        const inHost = path.includes(this.host);
        const inTrigger = Array.from(this.externalTriggers).some((el) => el.isConnected && path.includes(el));
        if (!inHost && !inTrigger && !(e.target as HTMLElement).closest('[data-gp-prompt-btn]')) {
          // When the editor modal is open, keep the picker behind it alive.
          const modal = this.shadow.querySelector('.modal-overlay');
          if (modal && (modal as HTMLElement).style.display !== 'none') return;
          this.close();
        }
      }
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      const modal = this.shadow.querySelector('.modal-overlay') as HTMLElement | null;
      const modalOpen = !!modal && modal.style.display !== 'none';

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (modalOpen) {
          this.closeModal();
        } else {
          this.close();
          this.refocusTrigger();
        }
        return;
      }
      if (modalOpen) {
        if (e.key === 'Tab') {
          const controls = Array.from(modal!.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea'))
            .filter((el) => el.getBoundingClientRect().height > 0);
          const active = e.composedPath()[0];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
            e.preventDefault(); last?.focus();
          } else if (!e.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
            e.preventDefault(); first?.focus();
          }
        }
        return;
      }
      const target = e.composedPath()[0] as HTMLElement;
      if (!target.closest('.search-input, .item-insert')) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        const active = e.composedPath()[0] as HTMLElement | null;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && !active.classList.contains('search-input')) {
          return;
        }
        if (active?.closest('button')) return;
        e.preventDefault();
        this.insertSelectedPrompt(e.ctrlKey || e.metaKey);
      }
    });

    window.addEventListener('resize', () => {
      if (this.isOpen) {
        this.syncMobile();
        this.updatePosition();
        this.applyDynamicHeight(this.lastVisibleCount);
      }
    });
  }

  public static getInstance(): PromptPicker {
    if (!PromptPicker.instance) {
      PromptPicker.instance = new PromptPicker();
    }
    return PromptPicker.instance;
  }

  public toggle(rect: DOMRect, trigger?: HTMLElement) {
    if (this.isOpen) {
      this.close();
    } else {
      this.lastExternalTrigger = trigger ?? null;
      this.open(rect);
    }
  }

  /**
   * Registers an external toggle (e.g. the sidebar prompt badge) so a
   * mousedown on it does not close the picker before its click toggles it.
   */
  public registerTrigger(element: HTMLElement): void {
    Array.from(this.externalTriggers).forEach((el) => {
      if (!el.isConnected) this.externalTriggers.delete(el);
    });
    this.externalTriggers.add(element);
  }

  public open(rect: DOMRect) {
    this.syncTheme();
    this.syncMobile();
    this.isOpen = true;
    this.triggerRect = rect;
    this.selectedPromptId = null;
    this.visiblePromptIds = [];
    this.searchQuery = '';

    this.host.style.display = 'block';
    this.host.style.pointerEvents = 'auto';

    // Animate in
    const picker = this.shadow.querySelector('.picker');
    if (picker) {
      // Force reflow
      void (picker as HTMLElement).offsetWidth;
      picker.classList.add('open');
    }

    this.updatePosition();
    this.updateList();
    const input = this.shadow.querySelector('.search-input') as HTMLInputElement;
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  public close() {
    this.isOpen = false;

    const picker = this.shadow.querySelector('.picker');
    if (picker) picker.classList.remove('open');

    // Wait for animation
    setTimeout(() => {
      if (!this.isOpen) {
        this.host.style.display = 'none';
        this.host.style.pointerEvents = 'none';
      }
    }, 200);
  }

  /** Closes the library and hands focus back to the badge that opened it. */
  private dismissAndRefocus() {
    this.close();
    this.refocusTrigger();
  }

  private refocusTrigger() {
    const trigger = this.lastExternalTrigger;
    if (trigger?.isConnected) {
      trigger.focus();
    } else {
      document.querySelector<HTMLButtonElement>('[data-gp-prompt-btn]')?.focus();
    }
  }

  private updatePosition() {
    if (!this.triggerRect) return;
    const margin = 12;
    const gap = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const mobile = isMobileEnvironment();
    const picker = this.shadow.querySelector('.picker') as HTMLElement | null;

    const width = Math.min(400, viewportWidth - margin * 2);
    const height = Math.min(picker?.offsetHeight || 400, viewportHeight - margin * 2);

    if (picker) {
      picker.style.width = `${width}px`;
      picker.style.maxHeight = `${viewportHeight - margin * 2}px`;
    }

    let left = this.triggerRect.left;
    let top = this.triggerRect.bottom + gap;
    let pointerSide: 'left' | 'right' | 'none' = 'none';

    if (mobile) {
      left = margin;
      top = viewportHeight - height - 16;
    } else {
      const rightSide = this.triggerRect.right + gap;
      const leftSide = this.triggerRect.left - width - gap;
      const canShowRight = rightSide + width <= viewportWidth - margin;
      const canShowLeft = leftSide >= margin;

      if (canShowRight) {
        left = rightSide;
        pointerSide = 'left';
      } else if (canShowLeft) {
        left = leftSide;
        pointerSide = 'right';
      } else {
        const centered = this.triggerRect.left + this.triggerRect.width / 2 - width / 2;
        left = Math.max(margin, Math.min(centered, viewportWidth - width - margin));
        pointerSide = 'none';
      }

      const preferredTop = this.triggerRect.top - 12;
      top = Math.max(margin, Math.min(preferredTop, viewportHeight - height - margin));
    }

    if (left + width > viewportWidth - margin) {
      left = viewportWidth - width - margin;
    }
    if (left < margin) {
      left = margin;
    }
    if (top < margin) {
      top = margin;
    }

    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
    if (picker) {
      picker.classList.remove('anchor-left', 'anchor-right', 'anchor-none');
      picker.classList.add(pointerSide === 'left' ? 'anchor-left' : pointerSide === 'right' ? 'anchor-right' : 'anchor-none');
      const pointerTop = Math.max(
        28,
        Math.min(
          this.triggerRect.top + this.triggerRect.height / 2 - top,
          height - 28
        )
      );
      picker.style.setProperty('--gp-pointer-top', `${Math.round(pointerTop)}px`);
    }
  }

  private applyDynamicHeight(itemCount: number) {
    const picker = this.shadow.querySelector('.picker') as HTMLElement | null;
    const list = this.shadow.getElementById('list-container') as HTMLElement | null;
    if (!picker || !list) return;

    const header = picker.querySelector('.header') as HTMLElement | null;
    const footer = picker.querySelector('.footer-action') as HTMLElement | null;
    const headerHeight = header?.offsetHeight || 130;
    const footerHeight = footer?.offsetHeight || 62;
    const visibleItems = Array.from(list.querySelectorAll<HTMLElement>('.item')).slice(0, 4);
    const listTarget = itemCount <= 0 ? 120 : visibleItems.reduce((height, item) => height + item.offsetHeight + 2, 8);
    const viewportMax = Math.max(0, Math.min(window.innerHeight - 24, 580));
    const target = Math.min(headerHeight + footerHeight + listTarget, viewportMax);
    picker.style.height = `${Math.round(target)}px`;
    picker.style.maxHeight = `${Math.round(viewportMax)}px`;
    this.updatePosition();
  }

  private startThemeObserver() {
    if (this.themeObserver) return;
    this.themeObserver = new MutationObserver(() => this.syncTheme());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    });
    if (document.body) {
      this.themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme']
      });
    }
  }

  private syncTheme() {
    this.host.dataset.gpTheme = this.resolveTheme();
  }

  /** Mirrors the panel/overlay hosts: `.gp-mobile` switches touch-first styles. */
  private syncMobile() {
    this.host.classList.toggle('gp-mobile', isMobileEnvironment());
  }

  private resolveTheme(): 'light' | 'dark' {
    const html = document.documentElement;
    const body = document.body;
    const classes = `${html.className} ${body?.className || ''}`.toLowerCase();

    if (/\b(light|theme-light)\b/.test(classes)) return 'light';
    if (/\b(dark|theme-dark|dark-theme)\b/.test(classes)) return 'dark';

    const sample = [body, html]
      .map((node) => (node ? getComputedStyle(node).backgroundColor : ''))
      .find((c) => c && c !== 'transparent');
    if (!sample) return 'light';

    const rgb = sample.match(/\d+(\.\d+)?/g);
    if (!rgb || rgb.length < 3) return 'light';
    const [r, g, b] = rgb.slice(0, 3).map(Number);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance < 0.45 ? 'dark' : 'light';
  }

  private getStyles(): string {
    return `
      :host {
        --gp-font: ${PANEL_TITLE_FONT_STACK};
        --gp-font-title: ${PANEL_TITLE_FONT_STACK};
        --gp-fg: #1f1f1f;
        --gp-fg-muted: #5f6368;
        --gp-muted: #747775;
        --gp-border: rgba(60, 64, 67, 0.12);
        --gp-hover: #f1f3f4;
        --gp-selected: rgba(60, 64, 67, 0.06);
        --gp-selected-border: rgba(60, 64, 67, 0.22);
        --gp-surface: #ffffff;
        --gp-surface-2: #f8fafd;
        --gp-shadow: 0 16px 40px rgba(60, 64, 67, 0.18), 0 1px 3px rgba(60, 64, 67, 0.16);
        --gp-accent: #1a73e8;
        --gp-on-accent: #ffffff;
        --gp-accent-hover: #1967d2;
        --gp-focus: #1a73e8;
        --gp-focus-ring: rgba(26, 115, 232, 0.16);
        --gp-input-bg: #f8fafd;
        --gp-danger: #b3261e;
        --gp-danger-weak: rgba(179, 38, 30, 0.06);
        --gp-on-danger: #ffffff;
        --gp-scrim: rgba(32, 33, 36, 0.42);
        --gp-radius-sm: 8px;
        --gp-radius: 12px;
        --gp-radius-lg: 22px;
        --gp-radius-xl: 28px;
        --gp-radius-pill: 999px;
        --gp-transition: .15s ease;
        font-family: var(--gp-font);
        color: var(--gp-fg);
        color-scheme: light;
      }
      :host([data-gp-theme="dark"]) {
        --gp-fg: #e8eaed;
        --gp-fg-muted: #bdc1c6;
        --gp-muted: #9aa0a6;
        --gp-border: rgba(232, 234, 237, 0.16);
        --gp-hover: rgba(255, 255, 255, 0.08);
        --gp-selected: rgba(255, 255, 255, 0.08);
        --gp-selected-border: rgba(232, 234, 237, 0.28);
        --gp-surface: #202124;
        --gp-surface-2: #292a2d;
        --gp-shadow: 0 24px 52px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.36);
        --gp-accent: #8ab4f8;
        --gp-on-accent: #202124;
        --gp-accent-hover: #aecbfa;
        --gp-focus: #8ab4f8;
        --gp-focus-ring: rgba(138, 180, 248, 0.22);
        --gp-input-bg: rgba(41, 42, 45, 0.92);
        --gp-danger: #f2b8b5;
        --gp-danger-weak: rgba(242, 184, 181, 0.07);
        --gp-on-danger: #202124;
        color-scheme: dark;
      }
      * { box-sizing: border-box; }
      button, input, textarea { font: inherit; color: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: default; opacity: .5; }
      button:focus-visible { outline: 2px solid var(--gp-focus); outline-offset: 2px; }

      /* ---------- Library panel (anchored popover) ---------- */
      .picker {
        width: 400px; max-height: calc(100dvh - 24px); position: relative;
        display: flex; flex-direction: column; overflow: hidden;
        background: var(--gp-surface); color: var(--gp-fg);
        border: 1px solid var(--gp-border); border-radius: var(--gp-radius-xl);
        box-shadow: var(--gp-shadow);
        font-family: var(--gp-font); font-size: 14px;
        opacity: 0; transform: translateY(6px); pointer-events: none;
        transition: opacity var(--gp-transition), transform var(--gp-transition);
      }
      .picker.open { opacity: 1; transform: translateY(0); pointer-events: auto; }

      .header { flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; padding: 18px 16px 14px; }
      .header-top { display: flex; flex-direction: column; gap: 3px; }
      .library-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .library-title, .modal-title { margin: 0; ${PANEL_TITLE_TYPOGRAPHY} }
      .library-count { font-size: 13px; line-height: 18px; color: var(--gp-muted); }
      .panel-close, .modal-close {
        flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; padding: 0; margin: 1px -4px 0 0;
        border: none; border-radius: 50%; background: transparent;
        color: var(--gp-muted); transition: background var(--gp-transition), color var(--gp-transition);
      }
      .panel-close:hover, .modal-close:hover { background: var(--gp-hover); color: var(--gp-fg); }
      .panel-close svg, .modal-close svg { width: 18px; height: 18px; }

      .search-row {
        display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px;
        border: 1px solid var(--gp-border); border-radius: var(--gp-radius-pill);
        background: var(--gp-input-bg); color: var(--gp-muted);
        transition: border-color var(--gp-transition), box-shadow var(--gp-transition), color var(--gp-transition);
      }
      .search-row:focus-within {
        border-color: var(--gp-accent); box-shadow: 0 0 0 3px var(--gp-focus-ring); color: var(--gp-fg);
      }
      .search-icon { display: flex; flex: 0 0 auto; }
      .search-input { min-width: 0; flex: 1; border: 0; background: transparent; padding: 0; outline: none; font-size: 14px; font-family: var(--gp-font); color: var(--gp-fg); }
      .search-input:focus-visible { outline: none; }
      .search-input::placeholder { color: var(--gp-muted); }

      .list {
        flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
        padding: 2px 8px 8px; scrollbar-width: thin; scrollbar-color: var(--gp-selected-border) transparent;
      }
      .empty-box { min-height: 110px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 20px 16px; text-align: center; }
      .empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--gp-fg); }
      .empty-hint { margin: 0; font-size: 12.5px; line-height: 17px; color: var(--gp-muted); }

      .item { position: relative; border-radius: var(--gp-radius); margin-bottom: 2px; transition: background var(--gp-transition); }
      .item:hover, .item:focus-within { background: var(--gp-hover); }
      .item.selected { background: var(--gp-selected); }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) { background: transparent; }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) .item-actions { opacity: 0; pointer-events: none; }
      .item-insert { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 10px 12px; border-radius: var(--gp-radius); color: inherit; }
      .item-insert:focus-visible { outline: 2px solid var(--gp-focus); outline-offset: -2px; }
      .item-content { min-width: 0; }
      .item-head { display: flex; align-items: center; min-height: 18px; padding-right: 40px; margin-bottom: 3px; }
      .item-title { font-size: 13.5px; line-height: 18px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item-preview { font-size: 12.5px; line-height: 17px; color: var(--gp-fg-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      .item-actions { position: absolute; top: 7px; right: 7px; display: flex; gap: 2px; opacity: 0; pointer-events: none; transition: opacity var(--gp-transition); }
      .item:hover .item-actions, .item.selected .item-actions, .item:focus-within .item-actions { opacity: 1; pointer-events: auto; }
      .item-action-btn {
        width: 32px; height: 32px; display: grid; place-items: center; padding: 0;
        border: none; border-radius: 50%; background: transparent; color: var(--gp-muted);
        transition: background var(--gp-transition), color var(--gp-transition);
      }
      .item-action-btn:hover { background: var(--gp-hover); color: var(--gp-fg); }
      .item-action-btn svg { width: 18px; height: 18px; }

      .footer-action { flex-shrink: 0; display: flex; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--gp-border); }
      .btn-new {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 96px;
        height: 38px; padding: 0 18px; border: 1px solid var(--gp-accent); border-radius: var(--gp-radius-pill);
        background: var(--gp-accent); color: var(--gp-on-accent);
        font-family: var(--gp-font); font-size: 13.5px; font-weight: 700;
        transition: background var(--gp-transition), border-color var(--gp-transition);
      }
      .btn-new:hover { background: var(--gp-accent-hover); border-color: var(--gp-accent-hover); }
      .btn-new svg { width: 16px; height: 16px; }

      /* ---------- Prompt editor dialog ---------- */
      .modal-overlay {
        position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        padding: 16px; background: var(--gp-scrim); backdrop-filter: blur(3px);
      }
      .modal {
        width: min(480px, 100%); max-height: calc(100dvh - 32px);
        display: flex; flex-direction: column;
        background: var(--gp-surface); border: 1px solid var(--gp-border); border-radius: var(--gp-radius-lg);
        box-shadow: var(--gp-shadow); font: 14px var(--gp-font); color: var(--gp-fg);
        animation: modalFadeIn .18s ease;
      }
      @keyframes modalFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 0; }
      .modal-title-wrap { min-width: 0; }
      .modal-title { font-family: var(--gp-font); font-size: 19px; line-height: 26px; font-weight: 800; letter-spacing: .01em; }
      .modal-subtitle { margin: 2px 0 0; font-size: 13px; line-height: 18px; color: var(--gp-muted); }
      .modal-close { margin: 1px -4px 0 0; }
      .modal-body { min-height: 0; overflow-y: auto; padding: 18px 24px; display: flex; flex-direction: column; gap: 16px; }
      .form-group { display: flex; flex-direction: column; gap: 6px; }
      .form-label { font-size: 13px; line-height: 18px; font-weight: 600; }
      .form-input, .form-textarea {
        width: 100%; border: 1px solid var(--gp-border); border-radius: var(--gp-radius);
        background: var(--gp-input-bg); color: var(--gp-fg);
        font-family: var(--gp-font); font-size: 14px; outline: none;
        transition: border-color var(--gp-transition), box-shadow var(--gp-transition), background var(--gp-transition);
      }
      .form-input { height: 42px; padding: 0 12px; }
      .form-input::placeholder, .form-textarea::placeholder { color: var(--gp-muted); }
      .form-input:focus, .form-textarea:focus {
        border-color: var(--gp-accent); box-shadow: 0 0 0 3px var(--gp-focus-ring); background: var(--gp-surface);
      }
      .textarea-shell { position: relative; }
      .form-textarea { display: block; height: clamp(140px, 26vh, 240px); resize: vertical; padding: 12px 14px 34px; line-height: 1.5; }
      .textarea-token { position: absolute; right: 14px; bottom: 10px; font-size: 11px; line-height: 14px; color: var(--gp-muted); pointer-events: none; }
      .modal-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 0 24px 20px; }
      .modal-footer-start { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; }
      .modal-footer-end { display: flex; align-items: center; gap: 10px; }
      .form-status { flex: 1 1 auto; min-width: 0; min-height: 16px; font-size: 12.5px; line-height: 16px; color: var(--gp-danger); }
      .form-status:empty { display: none; }
      .btn {
        min-width: 88px; height: 38px; padding: 0 16px; border: 1px solid var(--gp-border); border-radius: var(--gp-radius-pill);
        background: transparent; color: var(--gp-fg);
        font-family: var(--gp-font); font-size: 13.5px; font-weight: 600;
        transition: background var(--gp-transition), border-color var(--gp-transition), color var(--gp-transition);
      }
      .btn:hover { background: var(--gp-hover); }
      .btn-save {
        min-width: 96px; padding: 0 20px; border-color: var(--gp-accent); background: var(--gp-accent); color: var(--gp-on-accent); font-weight: 700;
      }
      .btn-save:hover { background: var(--gp-accent-hover); border-color: var(--gp-accent-hover); }
      .btn-delete { min-width: 88px; border-color: transparent; color: var(--gp-danger); }
      .btn-delete:hover { background: var(--gp-danger-weak); }
      .btn-delete.confirming { background: var(--gp-danger); border-color: var(--gp-danger); color: var(--gp-on-danger); }

      /* ---------- Mobile (touch-first) ---------- */
      :host(.gp-mobile) .picker { border-radius: var(--gp-radius-lg); }
      :host(.gp-mobile) .header { padding: 16px 16px 12px; }
      :host(.gp-mobile) .library-count { font-size: 13.5px; }
      :host(.gp-mobile) .search-input { font-size: 16px; }
      :host(.gp-mobile) .search-row { height: 46px; }
      :host(.gp-mobile) .item-title { font-size: 14.5px; line-height: 19px; }
      :host(.gp-mobile) .item-preview { font-size: 13px; line-height: 17.5px; }
      :host(.gp-mobile) .item-action-btn { width: 38px; height: 38px; }
      :host(.gp-mobile) .item-head { padding-right: 46px; }
      :host(.gp-mobile) .footer-action { padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px)); }
      :host(.gp-mobile) .btn-new { height: 44px; flex: 1 1 auto; }
      :host(.gp-mobile) .panel-close { width: 36px; height: 36px; margin-right: -8px; }
      :host(.gp-mobile) .modal-overlay { padding: 10px 0; }
      :host(.gp-mobile) .modal { width: 100%; max-height: calc(100dvh - 20px); padding-bottom: env(safe-area-inset-bottom, 0px); }
      :host(.gp-mobile) .modal-header { padding: 16px 16px 0; }
      :host(.gp-mobile) .modal-close { width: 36px; height: 36px; }
      :host(.gp-mobile) .modal-body { padding: 14px 16px; }
      :host(.gp-mobile) .form-input { height: 46px; font-size: 16px; }
      :host(.gp-mobile) .form-textarea { font-size: 16px; height: clamp(140px, 30vh, 260px); }
      :host(.gp-mobile) .textarea-token { right: 14px; bottom: 10px; }
      :host(.gp-mobile) .modal-footer { flex-wrap: wrap; padding: 0 16px calc(16px); }
      :host(.gp-mobile) .modal-footer-start { order: 2; flex: 1 1 100%; }
      :host(.gp-mobile) .modal-footer-end { order: 1; margin-left: auto; flex: 1 1 auto; justify-content: flex-end; }
      :host(.gp-mobile) .btn { height: 44px; }
      :host(.gp-mobile) .btn-save { flex: 1 1 auto; }

      @media (hover: none) { .item-actions { opacity: 1; pointer-events: auto; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
    `;
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="picker" role="dialog" aria-label="Prompt Library">
        <div class="header">
          <div class="header-top">
            <div class="library-heading">
              <h2 class="library-title">Prompt Library</h2>
              <button class="panel-close" id="panel-close" type="button" title="Close" aria-label="Close Prompt Library">${ICONS.close}</button>
            </div>
            <span class="library-count" id="library-count"></span>
          </div>
          <div class="search-row">
            <span class="search-icon" aria-hidden="true">${ICONS.search}</span>
            <input class="search-input" type="text" placeholder="Search prompts…" spellcheck="false" aria-label="Search prompts" />
          </div>
        </div>
        <div class="list" id="list-container"></div>
        <div class="footer-action">
          <button class="btn-new" id="btn-primary-action" type="button" title="New Prompt">
            ${ICONS.plus} <span>New Prompt</span>
          </button>
        </div>
      </div>
      <div class="modal-overlay" id="modal-overlay" style="display:none;"></div>
    `;

    const input = this.shadow.querySelector('.search-input') as HTMLInputElement;
    input?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.updateList();
    });
    // Clicks inside the panel must not bubble to the document close listener.
    const header = this.shadow.querySelector('.header');
    header?.addEventListener('mousedown', (e) => e.stopPropagation());

    this.shadow.getElementById('panel-close')?.addEventListener('click', () => this.dismissAndRefocus());
    this.shadow.getElementById('btn-primary-action')?.addEventListener('click', () => {
      this.showModal();
      this.updateList();
    });
  }

  // ===================== Modal Methods =====================
  private showModal(prompt?: Prompt) {
    this.editingPrompt = prompt || null;
    this.modalDeleteConfirm = false;
    if (this.modalDeleteTimer) {
      window.clearTimeout(this.modalDeleteTimer);
      this.modalDeleteTimer = null;
    }
    const safeTitle = this.escapeHtml(prompt?.title || '');
    const safeContent = this.escapeHtml(prompt?.content || '');

    const overlay = this.shadow.getElementById('modal-overlay') as HTMLElement;
    overlay.style.display = 'flex';
    this.shadow.querySelector('.picker')?.setAttribute('inert', '');
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title">
        <div class="modal-header">
          <div class="modal-title-wrap">
            <h2 class="modal-title" id="prompt-editor-title">${prompt ? 'Edit Prompt' : 'New Prompt'}</h2>
            <p class="modal-subtitle">${prompt ? 'Update this prompt. Changes apply wherever it is inserted.' : 'Reusable text you can insert into any chat input.'}</p>
          </div>
          <button class="modal-close" id="modal-close" type="button" title="Close" aria-label="Close prompt editor">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="prompt-title">Name</label>
            <input class="form-input" id="prompt-title" type="text" placeholder="e.g. Code Review" value="${safeTitle}" spellcheck="false" autocomplete="off" />
          </div>
          <div class="form-group">
            <label class="form-label" for="prompt-content">Prompt Content</label>
            <div class="textarea-shell">
              <textarea class="form-textarea" id="prompt-content" placeholder="Write the prompt you want to reuse…" spellcheck="false">${safeContent}</textarea>
              <span class="textarea-token" id="content-token-estimate">~0 tokens</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <div class="modal-footer-start">
            ${prompt ? '<button class="btn btn-delete" id="modal-delete" type="button">Delete</button>' : ''}
            <span class="form-status" id="form-status" role="alert"></span>
          </div>
          <div class="modal-footer-end">
            <button class="btn btn-cancel" id="modal-cancel" type="button">Cancel</button>
            <button class="btn btn-save" id="modal-save" type="button">Save</button>
          </div>
        </div>
      </div>
    `;

    // Bind events
    const titleInput = overlay.querySelector('#prompt-title') as HTMLInputElement | null;
    const contentInput = overlay.querySelector('#prompt-content') as HTMLTextAreaElement | null;
    const tokenEstimateEl = overlay.querySelector('#content-token-estimate') as HTMLElement | null;
    const saveBtn = overlay.querySelector('#modal-save') as HTMLButtonElement | null;
    const statusEl = overlay.querySelector('#form-status') as HTMLElement | null;
    const setStatus = (message: string) => {
      if (statusEl) statusEl.textContent = message;
    };
    const updateContentMeta = () => {
      const chars = (contentInput?.value || '').length;
      const tokenEstimate = Math.ceil(chars / 4);
      if (tokenEstimateEl) tokenEstimateEl.textContent = `~${tokenEstimate} tokens`;
    };
    const updateSaveEnabled = () => {
      const currentTitle = (titleInput?.value || '').trim();
      const currentContent = (contentInput?.value || '').trim();
      if (saveBtn) {
        saveBtn.disabled = !(currentTitle.length > 0 && currentContent.length > 0);
      }
    };

    titleInput?.addEventListener('input', () => {
      setStatus('');
      updateSaveEnabled();
    });
    contentInput?.addEventListener('input', () => {
      setStatus('');
      updateContentMeta();
      updateSaveEnabled();
    });
    updateContentMeta();
    updateSaveEnabled();

    overlay.querySelector('#modal-close')?.addEventListener('click', () => this.closeModal());
    overlay.querySelector('#modal-cancel')?.addEventListener('click', () => this.closeModal());
    overlay.querySelector('#modal-save')?.addEventListener('click', () => this.savePrompt());
    overlay.querySelector('#modal-delete')?.addEventListener('click', async () => {
      const deleteBtn = overlay.querySelector('#modal-delete') as HTMLButtonElement | null;
      if (!this.editingPrompt || !deleteBtn) return;

      if (!this.modalDeleteConfirm) {
        this.modalDeleteConfirm = true;
        deleteBtn.textContent = 'Confirm delete';
        deleteBtn.classList.add('confirming');
        if (this.modalDeleteTimer) {
          window.clearTimeout(this.modalDeleteTimer);
        }
        this.modalDeleteTimer = window.setTimeout(() => {
          this.modalDeleteConfirm = false;
          this.modalDeleteTimer = null;
          deleteBtn.textContent = 'Delete';
          deleteBtn.classList.remove('confirming');
        }, 2200);
        return;
      }

      if (this.modalDeleteTimer) {
        window.clearTimeout(this.modalDeleteTimer);
        this.modalDeleteTimer = null;
      }
      const deletingId = this.editingPrompt.id;
      await promptStore.delete(deletingId);
      this.closeModal();
      this.updateList();
    });

    // Clicking the scrim closes the editor
    overlay.onclick = (e) => {
      if (e.target === overlay) this.closeModal();
    };

    // Focus Name
    setTimeout(() => {
      titleInput?.focus();
    }, 50);
  }

  private closeModal() {
    const overlay = this.shadow.getElementById('modal-overlay') as HTMLElement;
    overlay.style.display = 'none';
    overlay.innerHTML = '';
    this.shadow.querySelector('.picker')?.removeAttribute('inert');
    this.shadow.querySelector<HTMLButtonElement>('.item.selected .item-action-btn, .btn-new')?.focus();
    this.editingPrompt = null;
    this.modalDeleteConfirm = false;
    if (this.modalDeleteTimer) {
      window.clearTimeout(this.modalDeleteTimer);
      this.modalDeleteTimer = null;
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async savePrompt() {
    const title = (this.shadow.getElementById('prompt-title') as HTMLInputElement)?.value.trim();
    const content = (this.shadow.getElementById('prompt-content') as HTMLTextAreaElement)?.value.trim();
    const status = this.shadow.getElementById('form-status');

    if (!title || !content) {
      if (status) status.textContent = 'Add a name and prompt content before saving.';
      return;
    }

    const now = Date.now();
    const promptData: Prompt = {
      id: this.editingPrompt?.id || crypto.randomUUID(),
      title,
      content,
      tags: [],
      createdAt: this.editingPrompt?.createdAt || now,
      updatedAt: now,
      usageCount: this.editingPrompt?.usageCount || 0,
      lastUsedAt: this.editingPrompt?.lastUsedAt || 0,
      isFavorite: this.editingPrompt?.isFavorite || false
    };

    const saveButton = this.shadow.getElementById('modal-save') as HTMLButtonElement | null;
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Saving…'; }
    if (status) status.textContent = '';
    try {
      await promptStore.save(promptData);
      this.closeModal();
      this.updateList();
      this.shadow.querySelector<HTMLButtonElement>('.btn-new')?.focus();
    } catch {
      if (status) status.textContent = 'Could not save this prompt. Your draft is still here; please try again.';
    } finally {
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Save'; }
    }
  }

  private moveSelection(step: number) {
    if (!this.visiblePromptIds.length) return;
    const currentIndex = this.selectedPromptId ? this.visiblePromptIds.indexOf(this.selectedPromptId) : -1;
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + step + this.visiblePromptIds.length) % this.visiblePromptIds.length;
    this.selectedPromptId = this.visiblePromptIds[nextIndex];

    const list = this.shadow.getElementById('list-container') as HTMLElement | null;
    if (!list) return;
    list.querySelectorAll('.item').forEach((el) => {
      const row = el as HTMLElement;
      row.classList.toggle('selected', row.dataset.id === this.selectedPromptId);
      if (row.dataset.id === this.selectedPromptId) {
        row.scrollIntoView({ block: 'nearest' });
        if (this.shadow.activeElement?.classList.contains('item-insert')) {
          row.querySelector<HTMLButtonElement>('.item-insert')?.focus();
        }
      }
    });
  }

  private insertSelectedPrompt(keepOpen: boolean) {
    if (!this.selectedPromptId) return;
    const list = promptStore.getAll();
    const prompt = list.find((item) => item.id === this.selectedPromptId);
    if (!prompt) return;
    this.onSelect(prompt, keepOpen);
  }

  // ===================== List Methods =====================
  private updateList() {
    const list = this.shadow.getElementById('list-container');
    if (!list) return;

    const allPrompts = promptStore.getAll();
    const filtered = allPrompts.filter(p => {
      const matchesSearch = p.title.toLowerCase().includes(this.searchQuery) ||
        p.content.toLowerCase().includes(this.searchQuery);
      return matchesSearch;
    });

    list.replaceChildren();
    const displayPrompts = filtered;
    this.visiblePromptIds = displayPrompts.map((prompt) => prompt.id);
    this.lastVisibleCount = displayPrompts.length;
    const count = this.shadow.getElementById('library-count');
    if (count) count.textContent = `${displayPrompts.length} ${displayPrompts.length === 1 ? 'prompt' : 'prompts'}`;

    if (displayPrompts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-box';
      const emptyTitle = document.createElement('p');
      emptyTitle.className = 'empty-title';
      emptyTitle.textContent = this.searchQuery ? 'No prompts match your search' : 'No prompts yet';
      const emptyHint = document.createElement('p');
      emptyHint.className = 'empty-hint';
      emptyHint.textContent = this.searchQuery ? 'Try a different keyword.' : 'Create your first prompt to reuse it in any chat.';
      empty.append(emptyTitle, emptyHint);
      list.appendChild(empty);
      this.selectedPromptId = null;
      this.applyDynamicHeight(0);
      return;
    }

    if (!this.selectedPromptId || !this.visiblePromptIds.includes(this.selectedPromptId)) {
      this.selectedPromptId = this.visiblePromptIds[0];
    }

    displayPrompts.forEach((prompt) => {
      const item = document.createElement('div');
      item.className = 'item';
      if (this.selectedPromptId === prompt.id) {
        item.classList.add('selected');
      }
      item.dataset.id = prompt.id;

      const content = document.createElement('div');
      content.className = 'item-content';
      const head = document.createElement('div');
      head.className = 'item-head';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = prompt.title;
      head.appendChild(title);

      const preview = document.createElement('div');
      preview.className = 'item-preview';
      preview.textContent = prompt.content.replace(/\s+/g, ' ').trim();
      content.appendChild(head);
      content.appendChild(preview);

      const insertButton = document.createElement('button');
      insertButton.type = 'button';
      insertButton.className = 'item-insert';
      insertButton.setAttribute('aria-label', `Insert ${prompt.title}`);
      insertButton.appendChild(content);
      item.appendChild(insertButton);
      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'item-action-btn';
      editBtn.dataset.action = 'edit';
      editBtn.dataset.id = prompt.id;
      editBtn.title = 'Edit prompt';
      editBtn.setAttribute('aria-label', `Edit ${prompt.title}`);
      editBtn.type = 'button';
      editBtn.innerHTML = ICONS.edit;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showModal(prompt);
      });

      actions.appendChild(editBtn);
      item.appendChild(actions);
      item.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.item-actions')) return;
        this.selectedPromptId = prompt.id;
        this.onSelect(prompt, false);
      });
      item.addEventListener('mouseenter', () => {
        if (this.selectedPromptId === prompt.id) return;
        this.selectedPromptId = prompt.id;
        this.moveSelection(0);
      });

      list.appendChild(item);
    });
    this.applyDynamicHeight(displayPrompts.length);
  }

  private async insertPromptContent(text: string): Promise<boolean> {
    try {
      const mod = await import('./composer');
      const inserted = mod.insertPrompt(text);
      if (inserted === false) {
        return this.insertPromptFallback(text);
      }
      return true;
    } catch {
      return this.insertPromptFallback(text);
    }
  }

  private insertPromptFallback(text: string): boolean {
    const composer = document.querySelector('rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea') as HTMLElement | null;
    if (!composer) return false;
    composer.focus();
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
      }
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  private async onSelect(prompt: Prompt, keepOpen: boolean) {
    promptStore.trackUsage(prompt.id).catch(() => undefined);
    const inserted = await this.insertPromptContent(prompt.content);
    if (!inserted) {
      return;
    }
    if (keepOpen) {
      this.searchQuery = '';
      const input = this.shadow.querySelector('.search-input') as HTMLInputElement | null;
      if (input) {
        input.value = '';
        input.focus();
      }
      this.updateList();
      return;
    }
    this.close();
  }
}