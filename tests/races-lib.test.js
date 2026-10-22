import { describe, expect, it } from 'vitest';
import {
    archetypeName,
    assembleTagPrompt,
    buildRacePack,
    characterKey,
    createPart,
    createRace,
    deletePart,
    deleteRace,
    findSimilarByName,
    getCharacterAppearance,
    importRacePack,
    isAppearanceRaceStale,
    movePart,
    partUsage,
    raceUsage,
    renameCharacterAppearance,
    setCharacterAppearance,
    sortedParts,
    updateRace,
} from '../src/features/races/races-lib.js';
import {
    formatTagEmphasis,
    mergeTagLists,
    normalizeTags,
    parseJsonReply,
    splitTags,
    tagKey,
    underscoresToSpaces,
} from '../src/features/races/tag-utils.js';

function oniSettings() {
    const s = { chatStates: { A: {} } };
    createRace(s, {
        name: 'Oni',
        description: 'Tall humanoids from the western mountains.',
        generalParts: [
            { partId: 'horns', tags: 'long thick horns, 2::two horns::' },
            { partId: 'head', tags: 'short fangs, fanged teeth' },
            { partId: 'arms', tags: 'thick arms, muscular arms' },
        ],
    });
    return s;
}

describe('tag utils', () => {
    it('splits on top-level commas only', () => {
        expect(splitTags('a, {b, c}, 2::d, e::, f')).toEqual(['a', '{b, c}', '2::d, e::', 'f']);
    });

    it('caps emphasis at 4', () => {
        expect(normalizeTags('{{{{{{big}}}}}}, 9::huge::')).toBe('{{{{big}}}}, 4::huge::');
    });

    it('dedupes by bare tag keeping the stronger copy in first position', () => {
        expect(mergeTagLists('horns, red skin', '{{horns}}, tall')).toEqual(['{{horns}}', 'red skin', 'tall']);
        expect(tagKey('2::Long_Horns::')).toBe('long horns');
    });

    it('treats -tag as a removal of an earlier tag', () => {
        expect(mergeTagLists('long thick horns, 2::two horns::', '-two horns, one horn')).toEqual(['long thick horns', 'one horn']);
    });

    it('formats emphasis per backend', () => {
        const tags = ['{{horns}}', '2::two horns::', '[blush]', 'tall'];
        expect(formatTagEmphasis(tags, 'novelai')).toEqual(tags);
        expect(formatTagEmphasis(tags, 'sd')).toEqual(['((horns))', '(two horns:2)', '[blush]', 'tall']);
        expect(formatTagEmphasis(tags, 'none')).toEqual(['horns', 'two horns', 'blush', 'tall']);
    });

    it('replaces underscores but keeps emoticons', () => {
        expect(underscoresToSpaces('long_hair, ^_^')).toBe('long hair, ^_^');
    });

    it('parses JSON out of chatty replies', () => {
        expect(parseJsonReply('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
        expect(parseJsonReply('nope')).toBeNull();
        expect(parseJsonReply('<think>maybe {"parts": []}?</think>\n{"parts": [1]}')).toEqual({ parts: [1] });
        expect(parseJsonReply('{"parts": [{"partId": "horns", "tags": "a",},],}')).toEqual({ parts: [{ partId: 'horns', tags: 'a' }] });
        expect(parseJsonReply('Use {curly} tags. Answer: {"parts": [{"partId": "tail", "tags": "{big tail}"}]} Done {x}.'))
            .toEqual({ parts: [{ partId: 'tail', tags: '{big tail}' }] });
    });
});

describe('parts and races', () => {
    it('seeds default parts and never duplicates a part by name', () => {
        const s = {};
        expect(sortedParts(s)[0].id).toBe('subject');
        const { created, part } = createPart(s, { name: 'horn' });
        expect(created).toBe(false);
        expect(part.id).toBe('horns');
        expect(createPart(s, { name: 'Antennae', description: 'x' }).created).toBe(true);
    });

    it('rejects duplicate race names and finds near matches', () => {
        const s = oniSettings();
        expect(() => createRace(s, { name: 'oni' })).toThrow();
        expect(findSimilarByName(s.races, 'Onis')?.item.id).toBe('oni');
        expect(findSimilarByName(s.races, 'Elf')).toBeNull();
    });

    it('drops unknown and subject parts from race general parts', () => {
        const s = {};
        const race = createRace(s, { name: 'Elf', generalParts: [{ partId: 'ears', tags: 'pointy ears' }, { partId: 'nope', tags: 'x' }, { partId: 'subject', tags: '1girl' }] });
        expect(race.generalParts).toEqual([{ partId: 'ears', tags: 'pointy ears' }]);
    });

    it('bumps race version on visual changes and flags linked characters stale', () => {
        const s = oniSettings();
        const rec = setCharacterAppearance(s, 'A', 'Kaede', { raceId: 'oni' });
        expect(isAppearanceRaceStale(s, rec)).toBe(false);
        updateRace(s, 'oni', { description: 'Changed.' });
        expect(isAppearanceRaceStale(s, rec)).toBe(true);
    });

    it('reorders parts', () => {
        const s = {};
        const before = sortedParts(s).map(p => p.id);
        movePart(s, before[2], -1);
        const after = sortedParts(s).map(p => p.id);
        expect(after[1]).toBe(before[2]);
        expect(after[2]).toBe(before[1]);
    });

    it('deleting a part removes it from races and characters', () => {
        const s = oniSettings();
        setCharacterAppearance(s, 'A', 'Kaede', { raceId: 'oni', parts: [{ partId: 'horns', tags: 'chipped horn' }] });
        expect(partUsage(s, 'horns')).toEqual({ races: ['Oni'], characters: 1 });
        deletePart(s, 'horns');
        expect(s.races[0].generalParts.some(gp => gp.partId === 'horns')).toBe(false);
        expect(s.chatStates.A.characterAppearance.kaede.parts).toEqual([]);
        expect(deletePart(s, 'subject')).toBe(false);
    });

    it('deleting a race unassigns its characters', () => {
        const s = oniSettings();
        setCharacterAppearance(s, 'A', 'Kaede', { raceId: 'oni' });
        expect(raceUsage(s, 'oni')).toEqual([{ chatId: 'A', name: 'Kaede' }]);
        deleteRace(s, 'oni');
        expect(s.chatStates.A.characterAppearance.kaede.raceId).toBeNull();
    });
});

describe('character appearance', () => {
    it('stores numbered combatants under their archetype', () => {
        expect(archetypeName('Goblin 2')).toBe('Goblin');
        expect(archetypeName('Goblin #3')).toBe('Goblin');
        expect(archetypeName('Goblin B')).toBe('Goblin');
        expect(archetypeName('Goblin Shaman')).toBe('Goblin Shaman');
        const s = oniSettings();
        setCharacterAppearance(s, 'A', 'Goblin 1', { raceId: null, subjectTags: '1other' });
        expect(getCharacterAppearance(s, 'A', 'Goblin 3')?.record.subjectTags).toBe('1other');
        expect(characterKey('Kaede (Fighter)')).toBe('kaede');
    });

    it('moves appearance on rename without clobbering', () => {
        const s = oniSettings();
        setCharacterAppearance(s, 'A', 'Kaede', { raceId: 'oni' });
        expect(renameCharacterAppearance(s, 'A', 'Kaede', 'Kaede Ironhorn')).toBe(true);
        expect(getCharacterAppearance(s, 'A', 'Kaede Ironhorn')?.record.raceId).toBe('oni');
        expect(getCharacterAppearance(s, 'A', 'Kaede')).toBeNull();
    });

    it('groups race and character tags per part in part order', () => {
        const s = oniSettings();
        createPart(s, { name: 'Tail' });
        const rec = setCharacterAppearance(s, 'A', 'Kaede', {
            raceId: 'oni',
            subjectTags: '1girl',
            parts: [
                { partId: 'horns', tags: '-two horns, one horn, broken horn' },
                { partId: 'hair', tags: 'white hair, long hair' },
                { partId: 'arms', tags: 'slender arms', mode: 'replace' },
                { partId: 'tail', tags: 'red tail' },
            ],
        });
        const { prompt, groups } = assembleTagPrompt(s, rec, { prefix: 'portrait', equipment: 'kimono, katana', state: 'smile' });
        expect(groups.map(g => g.partId)).toEqual(['head', 'hair', 'horns', 'arms', 'tail']);
        expect(prompt).toBe('portrait, 1girl, short fangs, fanged teeth, white hair, long hair, long thick horns, one horn, broken horn, slender arms, red tail, kimono, katana, smile');
    });

    it('formats the assembled prompt for SD backends', () => {
        const s = oniSettings();
        const rec = setCharacterAppearance(s, 'A', 'Kaede', { raceId: 'oni' });
        expect(assembleTagPrompt(s, rec, { style: 'sd' }).prompt).toContain('(two horns:2)');
    });
});

describe('race packs', () => {
    it('round-trips races into another library and updates by name', () => {
        const src = oniSettings();
        createPart(src, { name: 'Tusks', description: 'Tusk size.' });
        updateRace(src, 'oni', { generalParts: [...src.races[0].generalParts, { partId: 'tusks', tags: 'small tusks' }] });
        const pack = buildRacePack(src, ['oni']);
        const dest = {};
        expect(importRacePack(dest, pack)).toEqual({ partsAdded: 1, racesAdded: 1, racesUpdated: 0 });
        expect(dest.races[0].generalParts.find(gp => gp.partId === 'tusks')?.tags).toBe('small tusks');
        expect(importRacePack(dest, pack).racesUpdated).toBe(1);
        expect(() => importRacePack(dest, { format: 'other' })).toThrow();
    });
});
