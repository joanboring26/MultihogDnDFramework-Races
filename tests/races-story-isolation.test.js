import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Race / part tags are for image prompts only. The modules that build story
// context (generate interceptor, memo cleanup, Lorebook Agent, State Tracker
// prompts) must never read them.
const STORY_MODULES = [
    '../narrative-hooks.js',
    '../memo-processor.js',
    '../router.js',
    '../llm-client.js',
    '../src/state/sysprompt-content.js',
    '../src/state/module-instructions.js',
];
const RACE_DATA = /characterAppearance|appearanceParts|\.races\b|features\/races\//;

describe('races stay out of story generation', () => {
    for (const path of STORY_MODULES) {
        it(`${path} does not read race or part data`, () => {
            const source = readFileSync(new URL(path, import.meta.url), 'utf8');
            expect(source).not.toMatch(RACE_DATA);
        });
    }

    it('appearance is stored in the chat partition, not the live memo projection', () => {
        const source = readFileSync(new URL('../src/state/chat-persistence.js', import.meta.url), 'utf8');
        expect(source).toContain('characterAppearance: existing.characterAppearance');
        const loader = readFileSync(new URL('../src/features/chat/chat-state-loader.js', import.meta.url), 'utf8');
        expect(loader).not.toMatch(/characterAppearance/);
    });

    it('tag mode is used by both portrait prompt builders', () => {
        const source = readFileSync(new URL('../portraits.js', import.meta.url), 'utf8');
        expect(source.match(/s\.portraitPromptMode === 'tags'/g)?.length).toBe(2);
    });

    it('native image generation does not go through the slash parser', () => {
        const source = readFileSync(new URL('../portraits.js', import.meta.url), 'utf8');
        expect(source).not.toContain('/imagine quiet=true');
        expect(source).toContain("imagine.callback({ quiet: 'true'");
    });
});
