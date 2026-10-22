import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRaceContextBlock, memoCharacterNames } from '../src/features/races/race-context.js';

// Race / part tags are for image prompts only. The modules that build story
// context (generate interceptor, memo cleanup, Lorebook Agent, State Tracker
// prompts) must never read them. The one exception is race-context.js, which
// gives the narrator race names and descriptions (no tags, no parts).
const STORY_MODULES = [
    '../narrative-hooks.js',
    '../memo-processor.js',
    '../router.js',
    '../llm-client.js',
    '../src/state/sysprompt-content.js',
    '../src/state/module-instructions.js',
];
const RACE_DATA = /characterAppearance|appearanceParts|\.races\b|features\/races\//;
const RACE_CONTEXT_IMPORT = /import \{[^}]*\} from '\.\/src\/features\/races\/race-context\.js';\n/;

describe('races stay out of story generation', () => {
    for (const path of STORY_MODULES) {
        it(`${path} does not read race or part data`, () => {
            const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(RACE_CONTEXT_IMPORT, '');
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

    it('race-context.js only reads race names and descriptions', () => {
        const source = readFileSync(new URL('../src/features/races/race-context.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/generalParts|subjectTags|appearanceParts|\.tags\b|\.parts\b/);
    });
});

describe('race descriptions in story context', () => {
    const settings = {
        races: [
            { id: 'oni', name: 'Oni', description: 'Towering red-skinned humanoids.', generalParts: [{ partId: 'horns', tags: 'SECRET_RACE_TAG' }] },
            { id: 'goblin', name: 'Goblin', description: 'Small green humanoids.', generalParts: [] },
            { id: 'blank', name: 'Blank', description: '' },
        ],
        appearanceParts: [{ id: 'horns', name: 'Horns', description: 'SECRET_PART_DESCRIPTION' }],
        chatStates: {
            c1: {
                characterAppearance: {
                    'kaede ironhorn': { raceId: 'oni', subjectTags: 'SECRET_SUBJECT', parts: [{ partId: 'horns', tags: 'SECRET_CHAR_TAG' }] },
                    goblin: { raceId: 'goblin', parts: [] },
                    ghost: { raceId: 'blank', parts: [] },
                },
            },
        },
    };

    it('lists each present race once with its characters, and nothing else', () => {
        const block = buildRaceContextBlock(settings, 'c1', ['Kaede Ironhorn (Barbarian)', 'Goblin 1', 'Goblin 2', 'Ghost', 'Ren']);
        expect(block).toBe('[RACES]\nOni (Kaede Ironhorn): Towering red-skinned humanoids.\nGoblin (Goblin 1, Goblin 2): Small green humanoids.\n[/RACES]\n\n');
        expect(block).not.toMatch(/SECRET/);
    });

    it('is empty when no present character has a described race', () => {
        expect(buildRaceContextBlock(settings, 'c1', ['Ren', 'Ghost'])).toBe('');
        expect(buildRaceContextBlock(settings, 'other', ['Kaede Ironhorn'])).toBe('');
    });

    it('reads character names from the memo blocks', () => {
        expect(memoCharacterNames({
            CHARACTER: 'Kaede Ironhorn (Barbarian): 34/34 HP\nCombat: AC 14',
            PARTY: '- Ren (Monk): 22/22 HP\nGear: staff',
            COMBAT: 'Combat Round 1\nGoblin 1: 7/7 HP | AC 13',
        })).toEqual(['Kaede Ironhorn (Barbarian)', 'Ren (Monk)', 'Goblin 1']);
    });

    it('the narrator interceptor builds the [RACES] block after [PLAYER_CHARACTER]', () => {
        const source = readFileSync(new URL('../narrative-hooks.js', import.meta.url), 'utf8');
        expect(source).toContain('buildRaceContextBlock(settings, curChatId, names)');
        expect(source.indexOf('raceBlockAt = injections.length')).toBeGreaterThan(source.indexOf('[PLAYER_CHARACTER]\\nName:'));
    });
});
