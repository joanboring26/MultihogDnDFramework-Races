import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../portraits.js', import.meta.url), 'utf8');
function install(context, name) {
    const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
    runInContext(source.slice(start, source.indexOf('\n}', start) + 2).replace(/^export /, ''), context);
    return context[name];
}

describe('image preview prompt editor', () => {
    it('shows the full prompt, escaped, in an editable textarea', () => {
        const context = createContext({ escapeHtml: (t) => String(t).replace(/</g, '&lt;') });
        const html = install(context, 'previewPromptEditor')('p1', 'solo, <lora:x>, ' + 'tag, '.repeat(40));
        expect(html).toContain('<textarea id="p1"');
        expect(html).toContain('&lt;lora:x>');
        expect(html).toContain('tag, '.repeat(40).trimEnd());
        expect(html).toContain('Regenerate');
    });

    it('passes edits on, but not an emptied prompt', () => {
        const listeners = {};
        const ta = { value: 'old', addEventListener: (ev, fn) => { listeners[ev] = fn; } };
        const context = createContext({ setTimeout: (fn) => fn(), document: { getElementById: () => ta } });
        const onEdit = vi.fn();
        install(context, 'bindPreviewPromptEditor')('p1', onEdit);
        ta.value = 'new prompt'; listeners.input();
        ta.value = '   '; listeners.input();
        expect(onEdit.mock.calls).toEqual([['new prompt']]);
    });

    it.each(['generateWithPollinations', 'generateWithNativeExtension', 'generateWithHorde'])('%s regenerates with the edited prompt', (name) => {
        const start = source.indexOf(`export async function ${name}(`);
        const body = source.slice(start, source.indexOf('\n}', start));
        expect(body).toContain('previewPromptEditor(promptId, prompt)');
        expect(body).toContain('bindPreviewPromptEditor(promptId, (text) => { prompt = text; })');
        // The edited prompt feeds the next generation in the same preview loop.
        expect(body).toContain('generatePortraitDirect(prompt, entityName)');
        expect(body.indexOf('bindPreviewPromptEditor')).toBeLessThan(body.indexOf('await showPreview(); // Regenerate'));
    });
});
