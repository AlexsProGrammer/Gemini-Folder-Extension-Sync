
export function insertPrompt(text: string): boolean {
    const composer = findComposer();
    if (!composer) {
        // eslint-disable-next-line no-console
        console.error('[Gemini Projects] No composer found');
        return false;
    }

    focusComposer(composer);

    const success = document.execCommand('insertText', false, text);
    if (!success) {
        insertTextAtCursor(text);
    }

    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    handlePlaceholder(composer);
    return true;
}

/* ------------------------------------------------------------------ *
 * Project system-prompt injection helpers
 * ------------------------------------------------------------------ */

/** Marker identifying the injected project-instruction block. */
export const PROJECT_INSTRUCTIONS_MARKER = '[Project Instructions:';

/**
 * Formats a project's system prompt (and optionally its notes) into the
 * instruction block that is prepended to a fresh composer. Returns '' when
 * both inputs are empty so callers can short-circuit.
 */
export function formatProjectInstructionPrefix(systemPrompt: string, notes: string = ''): string {
    const prompt = (systemPrompt || '').trim();
    const noteText = (notes || '').trim();
    const sections: string[] = [];
    if (prompt) sections.push(prompt);
    if (noteText) sections.push(`---\nProject Notes:\n${noteText}`);
    if (!sections.length) return '';
    return `${PROJECT_INSTRUCTIONS_MARKER}\n${sections.join('\n\n')}\n]\n\n`;
}

/** Raw text content of the composer (trimmed). */
export function composerText(composer: HTMLElement): string {
    return (composer.textContent || '').trim();
}

/** True when the composer contains no text at all. */
export function composerIsEmpty(composer: HTMLElement): boolean {
    return composerText(composer).length === 0;
}

/** True when the composer already carries the injected instruction block. */
export function composerContainsInstructions(composer: HTMLElement): boolean {
    return composerText(composer).includes(PROJECT_INSTRUCTIONS_MARKER);
}

/** Focuses the composer and moves the caret to the end. */
export function focusComposer(composer: HTMLElement): void {
    composer.focus();
    if (!composer.isContentEditable) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

/** Focuses the composer and places the caret at the very start. */
export function focusComposerStart(composer: HTMLElement): void {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
        composer.setSelectionRange(0, 0);
        return;
    }
    if (!composer.isContentEditable) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

/**
 * Inserts `text` at the very start of the composer, keeping any existing
 * content (used by the manual "Add instructions" action).
 */
export function prependTextIntoComposer(composer: HTMLElement, text: string): void {
    focusComposerStart(composer);
    const success = document.execCommand('insertText', false, text);
    if (!success) {
        insertTextAtCursor(text);
    }
}

/**
 * Inserts `text` into the composer using the native editing command first,
 * falling back to a DOM range insertion for engines that reject execCommand.
 */
export function insertTextIntoComposer(composer: HTMLElement, text: string): void {
    focusComposer(composer);
    const success = document.execCommand('insertText', false, text);
    if (!success) {
        insertTextAtCursor(text);
    }
}

/**
 * Dispatches synthetic input events so Gemini's Angular/Wiz state wrapper
 * re-enables the "Send" button after a programmatic insertion.
 */
export function dispatchComposerInputEvents(composer: HTMLElement): void {
    composer.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText'
    }));
    composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText'
    }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Replaces the composer content with `text`, preserving surrounding content. */
export function setComposerText(composer: HTMLElement, text: string): void {
    composer.textContent = text;
    dispatchComposerInputEvents(composer);
}

function findComposer(): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    if (isUsableComposer(active)) {
        return active;
    }

    const selectors = [
        'rich-textarea [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.ql-editor[contenteditable="true"]',
        'textarea[aria-label*="Message"]',
        'textarea[placeholder*="message"]',
        'textarea[placeholder*="Ask"]'
    ];

    for (const selector of selectors) {
        const candidate = document.querySelector(selector) as HTMLElement | null;
        if (isUsableComposer(candidate)) {
            return candidate;
        }
    }

    const candidates = Array.from(document.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"]'));
    const visible = candidates.filter((el) => isUsableComposer(el));
    if (!visible.length) return null;

    visible.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.bottom - ar.bottom;
    });

    return visible[0] || null;
}

function isUsableComposer(el: HTMLElement | null): boolean {
    if (!el) return false;
    if (el.closest('#gp-prompt-picker-root')) return false;
    const isEditable = el.isContentEditable || el.tagName === 'TEXTAREA';
    if (!isEditable) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 20) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
}

function insertTextAtCursor(text: string) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);

        // Move cursor to end
        range.setStartAfter(node);
        range.setEndAfter(node);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

function handlePlaceholder(composer: HTMLElement) {
    // Scan text content for {{...}}
    // This is a naive implementation that works if the placeholder is in a single text node.
    // Enhanced version would traverse walker.

    const text = composer.innerText;
    const match = /\{\{(.*?)\}\}/.exec(text);
    if (match) {
        // Find the text node containing this
        // Simplification: just find the first text node with this string
        const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const val = node.nodeValue || '';
            const idx = val.indexOf(match[0]);
            if (idx !== -1) {
                // Select it
                const range = document.createRange();
                range.setStart(node, idx);
                range.setEnd(node, idx + match[0].length);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                break;
            }
        }
    }
}
