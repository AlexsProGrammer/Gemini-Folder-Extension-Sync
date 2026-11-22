
import { injectPromptButton } from './injector';
import { PromptPicker } from './picker';
import { promptStore } from './store';

export function bootstrap() {
    void promptStore.refresh();
    injectPromptButton(() => {
        const btn = document.getElementById('gp-prompt-btn');
        if (btn) {
            const rect = btn.getBoundingClientRect();
            PromptPicker.getInstance().toggle(rect, btn);
        }
    });
}
