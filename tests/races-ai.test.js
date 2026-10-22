import { describe, expect, it, vi } from 'vitest';
import { generateCharacterAppearance, generateRaceDescription, generateRaceFromPrompt, generateRaceIdentity, generateRaceParts, generateStateTags, pickRace } from '../src/features/races/races-ai.js';
import { makeDefaultAppearanceParts } from '../src/features/races/races-lib.js';

const character = { name: 'Kaede', description: 'A huge red-skinned oni woman with one broken horn.' };
const races = [
    { id: 'oni', name: 'Oni', description: 'Tall horned humanoids.' },
    { id: 'elf', name: 'Elf', description: 'Slender, pointy ears.' },
];
const reply = (obj) => vi.fn(async () => JSON.stringify(obj));

describe('pickRace', () => {
    it('accepts a listed id', async () => {
        expect(await pickRace({ request: reply({ raceId: 'oni' }), races, character })).toEqual({ raceId: 'oni', newRace: false });
    });

    it('maps a race name back to its id', async () => {
        expect(await pickRace({ request: reply({ raceId: 'Onis' }), races, character })).toEqual({ raceId: 'oni', newRace: false });
    });

    it('returns newRace for "new", unknown ids, and an empty library', async () => {
        expect((await pickRace({ request: reply({ raceId: 'new' }), races, character })).newRace).toBe(true);
        expect((await pickRace({ request: reply({ raceId: 'dragon' }), races, character })).newRace).toBe(true);
        const request = vi.fn();
        expect((await pickRace({ request, races: [], character })).newRace).toBe(true);
        expect(request).not.toHaveBeenCalled();
    });

    it('retries once on non-JSON and then fails', async () => {
        const request = vi.fn().mockResolvedValueOnce('hmm').mockResolvedValueOnce('{"raceId":"elf"}');
        expect((await pickRace({ request, races, character })).raceId).toBe('elf');
        await expect(pickRace({ request: vi.fn(async () => 'nope'), races, character })).rejects.toThrow();
    });

    it('never sends race tags to the picker', async () => {
        const request = reply({ raceId: 'oni' });
        await pickRace({ request, races: [{ ...races[0], generalParts: [{ partId: 'horns', tags: 'SECRET_TAG' }] }], character });
        expect(request.mock.calls[0][1]).not.toContain('SECRET_TAG');
    });
});

describe('race creation', () => {
    it('returns name and description', async () => {
        const out = await generateRaceIdentity({ request: reply({ name: 'Oni', description: 'Big.' }), character, races: [] });
        expect(out).toEqual({ name: 'Oni', description: 'Big.' });
    });

    it('validates parts, maps names to ids, and limits tags', async () => {
        const parts = makeDefaultAppearanceParts();
        const out = await generateRaceParts({
            request: reply({
                parts: [
                    { partId: 'horns', tags: 'a, b, c, d, e, f, g, h' },
                    { partId: 'Tails', tags: 'red tail' },
                    { newPart: { name: 'Antennae', description: 'Antenna shape.' }, tags: 'antennae' },
                    { partId: 'subject', tags: '1girl' },
                    { partId: 'horns' },
                ],
            }),
            race: { name: 'Oni', description: 'Big.' },
            parts,
        });
        expect(out.parts).toEqual([
            { partId: 'horns', tags: 'a, b, c, d, e, f' },
            { partId: 'tail', tags: 'red tail' },
            { newPart: { name: 'Antennae', description: 'Antenna shape.' }, tags: 'antennae' },
        ]);
    });
});

describe('race from a prompt', () => {
    const prompt = 'Fox people from snowy forests with white fur and big fluffy tails.';

    it('sends the user prompt to both steps and returns a full draft', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(JSON.stringify({ name: 'Kitsune', description: 'Small fox people.' }))
            .mockResolvedValueOnce(JSON.stringify({ parts: [{ partId: 'tail', tags: 'fox tail, big tail' }, { partId: 'ears', tags: 'fox ears' }] }));
        const out = await generateRaceFromPrompt({ request, prompt, races, parts: makeDefaultAppearanceParts() });
        expect(out).toEqual({
            name: 'Kitsune',
            description: 'Small fox people.',
            generalParts: [{ partId: 'tail', tags: 'fox tail, big tail' }, { partId: 'ears', tags: 'fox ears' }],
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[0][1]).toContain(prompt);
        expect(request.mock.calls[0][1]).toContain('Oni, Elf');
        expect(request.mock.calls[1][1]).toContain(prompt);
        expect(request.mock.calls[1][1]).toContain('"tail" (Tail)');
    });

    it('refuses an empty prompt without calling the AI', async () => {
        const request = vi.fn();
        await expect(generateRaceFromPrompt({ request, prompt: '  ', races, parts: [] })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it('never duplicates existing parts, and merges repeated rows', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(JSON.stringify({ name: 'Kitsune', description: 'Fox people.' }))
            .mockResolvedValueOnce(JSON.stringify({
                parts: [
                    { partId: 'tail', tags: 'fox tail' },
                    { newPart: { name: 'Tails', description: 'Tail.' }, tags: 'fluffy tail, fox tail' },
                    { partId: 'Ear', tags: 'fox ears' },
                    { newPart: { name: 'Fur', description: 'Fur color and texture.' }, tags: 'white fur' },
                    { newPart: { name: 'fur', description: 'Again.' }, tags: 'fluffy' },
                ],
            }));
        const out = await generateRaceFromPrompt({ request, prompt, races: [], parts: makeDefaultAppearanceParts() });
        expect(out.generalParts).toEqual([
            { partId: 'tail', tags: 'fox tail, fluffy tail' },
            { partId: 'ears', tags: 'fox ears' },
            { newPart: { name: 'Fur', description: 'Fur color and texture.' }, tags: 'white fur, fluffy' },
        ]);
    });
});

describe('real-model reply shapes', () => {
    const parts = makeDefaultAppearanceParts();
    const race = { name: 'Kitsune', description: 'Fox people.' };
    const run = (reply) => generateRaceParts({ request: vi.fn(async () => reply), race, parts });

    it('accepts other key names, tag arrays and "Name (id)" references', async () => {
        const out = await run(JSON.stringify({ generalParts: [
            { part: 'Horns', tags: 'long horns' },
            { id: 'ears', tags: ['fox ears', 'animal ears'] },
            { name: 'Tail', tag: 'fox tail' },
            { partId: 'Eyes (eyes)', tags: 'amber eyes' },
        ] }));
        expect(out.parts).toEqual([
            { partId: 'horns', tags: 'long horns' },
            { partId: 'ears', tags: 'fox ears, animal ears' },
            { partId: 'tail', tags: 'fox tail' },
            { partId: 'eyes', tags: 'amber eyes' },
        ]);
    });

    it('accepts an object map of parts', async () => {
        const out = await run('{"parts": {"horns": "long horns", "tail": ["fox tail"], "fur": {"description": "Body fur.", "tags": "white fur"}}}');
        expect(out.parts).toEqual([
            { partId: 'horns', tags: 'long horns' },
            { partId: 'tail', tags: 'fox tail' },
            { newPart: { name: 'Fur', description: 'Body fur.' }, tags: 'white fur' },
        ]);
    });

    it('turns an unknown part id into a new part instead of dropping it', async () => {
        const out = await run('{"parts": [{"partId": "fur", "tags": "white fur"}, {"partId": "body_markings", "tags": "stripes"}, {"partId": "subject", "tags": "1girl"}]}');
        expect(out.parts).toEqual([
            { newPart: { name: 'Fur', description: '' }, tags: 'white fur' },
            { newPart: { name: 'Body Markings', description: '' }, tags: 'stripes' },
        ]);
    });

    it('retries once when the reply has no usable parts', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce('{"parts": [{"partId": "horns"}]}')
            .mockResolvedValueOnce('{"parts": [{"partId": "horns", "tags": "long horns"}]}');
        const out = await generateRaceParts({ request, race, parts });
        expect(out.parts).toEqual([{ partId: 'horns', tags: 'long horns' }]);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][1]).toContain('no usable parts');
    });

    it('tells the AI to keep the user\'s tags when there are instructions', async () => {
        const request = vi.fn(async () => '{"parts": [{"partId": "horns", "tags": "2::two horns::"}]}');
        await generateRaceParts({ request, race, parts, instructions: 'Horns: 2::two horns::' });
        expect(request.mock.calls[0][1]).toContain('Every feature or tag the user instructions mention');
    });

    it('character replies still need an explicit newPart for new parts', async () => {
        const out = await generateCharacterAppearance({
            request: reply({ subject: '1girl', parts: [{ partId: 'clothing', tags: 'kimono' }, { id: 'hair', tags: 'white hair' }], equipment: '', state: '' }),
            character, race: null, raceGroups: [], parts,
        });
        expect(out.parts).toEqual([{ partId: 'hair', tags: 'white hair', mode: 'add' }]);
    });
});

describe('race description', () => {
    it('uses the prompt and, when given, the parts and their tags', async () => {
        const request = reply({ description: 'Tall horned folk.' });
        const out = await generateRaceDescription({ request, prompt: 'mountain giants', name: 'Oni', parts: [{ name: 'Horns', tags: 'long horns, 2::two horns::' }] });
        expect(out).toBe('Tall horned folk.');
        const user = request.mock.calls[0][1];
        expect(user).toContain('mountain giants');
        expect(user).toContain('Oni');
        expect(user).toContain('- Horns: long horns, 2::two horns::');
    });

    it('works without parts, and refuses when there is nothing to go on', async () => {
        const request = reply({ description: 'Fox folk.' });
        await generateRaceDescription({ request, prompt: 'fox people', parts: null });
        expect(request.mock.calls[0][1]).not.toContain('GENERAL PARTS');
        const none = vi.fn();
        await expect(generateRaceDescription({ request: none, prompt: ' ', parts: [] })).rejects.toThrow();
        expect(none).not.toHaveBeenCalled();
        await expect(generateRaceDescription({ request: reply({ description: '' }), prompt: 'x' })).rejects.toThrow();
    });
});

describe('character appearance', () => {
    it('keeps modes and removal tags', async () => {
        const out = await generateCharacterAppearance({
            request: reply({
                subject: '1girl',
                parts: [{ partId: 'horns', tags: '-two horns, one horn', mode: 'add' }, { partId: 'arms', tags: '', mode: 'replace' }],
                equipment: 'kimono',
                state: 'smile',
            }),
            character,
            race: races[0],
            raceGroups: [{ partId: 'horns', name: 'Horns', tags: ['two horns'] }],
            parts: makeDefaultAppearanceParts(),
        });
        expect(out).toEqual({
            subject: '1girl',
            parts: [{ partId: 'horns', tags: '-two horns, one horn', mode: 'add' }, { partId: 'arms', tags: '', mode: 'replace' }],
            equipment: 'kimono',
            state: 'smile',
        });
    });

    it('state tags', async () => {
        expect(await generateStateTags({ request: reply({ equipment: 'armor', state: '' }), character })).toEqual({ equipment: 'armor', state: '' });
    });
});
