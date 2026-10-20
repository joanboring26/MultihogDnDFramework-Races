/**
 * LLM prompts for the races / parts system.
 * Every function takes `request(systemPrompt, userPrompt) => Promise<string>` so the
 * prompts and reply validation are testable without SillyTavern.
 */

import { TAG_RULES, normalizeTags, parseJsonReply } from './tag-utils.js';
import { findSimilarByName } from './races-lib.js';

/** @typedef {(systemPrompt: string, userPrompt: string) => Promise<string>} RaceLlmRequest */

const SYSTEM = 'You are a character design assistant for an AI image generator that uses Danbooru tags. You only describe visual appearance. Reply with a single JSON object and nothing else.';

const MAX_TAGS_PER_PART = 6;

/** Ask once, retry once when the reply is not JSON. */
async function requestJson(request, userPrompt) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await request(SYSTEM, attempt === 0 ? userPrompt : `${userPrompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`);
        const parsed = parseJsonReply(reply);
        if (parsed && typeof parsed === 'object') return parsed;
    }
    throw new Error('The AI reply was not valid JSON.');
}

function limitTags(tags) {
    const list = normalizeTags(Array.isArray(tags) ? tags.join(', ') : String(tags ?? ''));
    return list.split(', ').filter(Boolean).slice(0, MAX_TAGS_PER_PART).join(', ');
}

function characterBlock(character) {
    return `Name: ${character.name}\n${String(character.description || '').trim() || '(no description available)'}`;
}

function partListBlock(parts) {
    return parts.map(p => `- "${p.id}" (${p.name}): ${p.description}`).join('\n');
}

/**
 * Pick a race for a character from the library.
 * @param {{ request: RaceLlmRequest, races: any[], character: { name: string, description: string } }} args
 * @returns {Promise<{ raceId: string|null, newRace: boolean }>}
 */
export async function pickRace({ request, races, character }) {
    if (!races.length) return { raceId: null, newRace: true };
    const list = races.map(r => `- "${r.id}" (${r.name}): ${r.description}`).join('\n');
    const parsed = await requestJson(request, `Assign a race/species to this character, using the list of existing races.

CHARACTER
${characterBlock(character)}

EXISTING RACES
${list}

Pick the existing race that matches this character's species. Variants, subtypes and individuals with unusual features still belong to their base race (an evolved goblin is still a goblin). Only answer "new" when none of the races is the same species.

Respond with ONLY: {"raceId": "<id from the list>"} or {"raceId": "new"}`);
    const raw = String(parsed.raceId ?? parsed.race ?? '').trim();
    if (!raw || raw.toLowerCase() === 'new') return { raceId: null, newRace: true };
    const byId = races.find(r => r.id === raw);
    if (byId) return { raceId: byId.id, newRace: false };
    const byName = findSimilarByName(races, raw);
    if (byName) return { raceId: byName.item.id, newRace: false };
    return { raceId: null, newRace: true };
}

/**
 * Step 1 of race creation: name and description.
 * @param {{ request: RaceLlmRequest, character: { name: string, description: string }, races: any[] }} args
 * @returns {Promise<{ name: string, description: string }>}
 */
export async function generateRaceIdentity({ request, character, races }) {
    const taken = races.length ? `\nThese races already exist and must not be repeated: ${races.map(r => r.name).join(', ')}.` : '';
    const parsed = await requestJson(request, `None of the existing races fit this character, so create the race/species they belong to.

CHARACTER
${characterBlock(character)}
${taken}
Rules:
- name: the species name, ONE word if at all possible (e.g. "Oni", "Goblin", "Tiefling"). Not the character's name.
- description: one short paragraph describing the common VISUAL characteristics shared by all members of the race (size, build, skin, distinctive features). No personality, no history of this specific character.

Respond with ONLY: {"name": "...", "description": "..."}`);
    const name = String(parsed.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('The AI did not return a race name.');
    return { name: name.slice(0, 40), description: String(parsed.description || '').trim() };
}

/**
 * Step 2 of race creation: general parts and their tags.
 * @param {{ request: RaceLlmRequest, race: { name: string, description: string }, parts: any[] }} args
 * @returns {Promise<{ parts: { partId?: string, newPart?: { name: string, description: string }, tags: string }[] }>}
 */
export async function generateRaceParts({ request, race, parts }) {
    const parsed = await requestJson(request, `Define the body parts that EVERY member of this race always has, and tag them for an image generator.

RACE
Name: ${race.name}
${race.description}

EXISTING PARTS (use these ids whenever they fit)
${partListBlock(parts)}

Instructions:
1. Pick the existing parts that need race-wide tags (skip parts with nothing race-specific about them).
2. If something the race always has is not covered by an existing part (e.g. a tail, antennae), create a new part with a very short description of what it covers.
3. For each part, give a few Danbooru tags (max ${MAX_TAGS_PER_PART}) describing that part for ALL members of the race. Nothing individual like hair color unless the whole race shares it.

${TAG_RULES}

Respond with ONLY:
{"parts": [{"partId": "horns", "tags": "tag, tag"}, {"newPart": {"name": "Tail", "description": "Tail type, length and color."}, "tags": "tag, tag"}]}`);
    return { parts: cleanPartReplies(parsed.parts, parts, false) };
}

/**
 * Character-specific parts, subject tags and (first) equipment/state tags in one call.
 * @param {{ request: RaceLlmRequest, character: { name: string, description: string },
 *           race: any|null, raceGroups: { partId: string, name: string, tags: string[] }[],
 *           parts: any[], scene?: string }} args
 * @returns {Promise<{ subject: string, parts: { partId?: string, newPart?: { name: string, description: string }, tags: string, mode: 'add'|'replace' }[], equipment: string, state: string }>}
 */
export async function generateCharacterAppearance({ request, character, race, raceGroups, parts, scene = '' }) {
    const raceText = race
        ? `Race: ${race.name}\n${race.description}\nRace tags every member already gets:\n${raceGroups.map(g => `- ${g.partId} (${g.name}): ${g.tags.join(', ')}`).join('\n') || '(none)'}`
        : 'Race: (none assigned)';
    const parsed = await requestJson(request, `Describe this specific character for an image generator, on top of their race's shared tags.

CHARACTER
${characterBlock(character)}

RACE
${raceText}

ALL PARTS
${partListBlock(parts.filter(p => p.kind !== 'subject'))}
${scene ? `\nCURRENT SCENE\n${scene}\n` : ''}
Instructions:
1. subject: Danbooru subject tags for this character (e.g. "1girl", "1boy, mature male", "1other"). Do not add "solo" or framing tags.
2. parts: ONLY where this character adds detail to, or differs from, the race tags (hair color and style, eye color, scars, a tail the base race lacks…). Do not repeat race tags. Skip parts that need nothing extra.
   - mode "add" (default): tags are added to the race tags. Prefix a tag with "-" to drop one race tag, e.g. "-two horns, one horn, broken horn".
   - mode "replace": the race tags for that part are wrong for this character and are dropped entirely.
   - If the character has a body part the race does not, use an existing part id, or create one with newPart.
3. equipment: what the character currently wears and carries (clothing, armor, weapons, accessories). Empty string if unknown.
4. state: current visible state (expression, injuries, dirt, pose-neutral). Empty string if nothing notable.
Keep every list short (max ${MAX_TAGS_PER_PART} tags per part).

${TAG_RULES}

Respond with ONLY:
{"subject": "1girl", "parts": [{"partId": "hair", "tags": "white hair, long hair", "mode": "add"}], "equipment": "tag, tag", "state": "tag"}`);
    return {
        subject: limitTags(parsed.subject || ''),
        parts: cleanPartReplies(parsed.parts, parts, true),
        equipment: normalizeTags(parsed.equipment || ''),
        state: normalizeTags(parsed.state || ''),
    };
}

/**
 * Equipment and state tags only (later portraits of a known character).
 * @param {{ request: RaceLlmRequest, character: { name: string, description: string }, scene?: string }} args
 * @returns {Promise<{ equipment: string, state: string }>}
 */
export async function generateStateTags({ request, character, scene = '' }) {
    const parsed = await requestJson(request, `List what this character currently wears and how they currently look, for an image generator. Do not describe their body or race.

CHARACTER
${characterBlock(character)}
${scene ? `\nCURRENT SCENE\n${scene}\n` : ''}
- equipment: clothing, armor, weapons and accessories currently worn or carried. Empty string if unknown.
- state: current visible state (expression, injuries, dirt). Empty string if nothing notable.

${TAG_RULES}

Respond with ONLY: {"equipment": "tag, tag", "state": "tag"}`);
    return { equipment: normalizeTags(parsed.equipment || ''), state: normalizeTags(parsed.state || '') };
}

/**
 * Validate the `parts` array of an AI reply. Unknown part ids are matched by
 * name against existing parts first; truly new parts come back as `newPart`.
 */
function cleanPartReplies(list, parts, withMode) {
    const assignable = parts.filter(p => p.kind !== 'subject');
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== 'object') continue;
        const tags = withMode ? normalizeTags(item.tags || '') : limitTags(item.tags || '');
        const mode = withMode && item.mode === 'replace' ? 'replace' : 'add';
        if (!tags && mode === 'add') continue;
        const id = String(item.partId || '').trim();
        let part = assignable.find(p => p.id === id) || (id ? findSimilarByName(assignable, id)?.item : null);
        const newName = String(item.newPart?.name || '').trim();
        if (!part && newName) part = findSimilarByName(assignable, newName)?.item || null;
        const entry = part
            ? { partId: part.id, tags }
            : newName
                ? { newPart: { name: newName.slice(0, 40), description: String(item.newPart.description || '').trim() }, tags }
                : null;
        if (!entry) continue;
        out.push(withMode ? { ...entry, mode } : entry);
    }
    return out;
}
