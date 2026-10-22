/**
 * LLM prompts for the races / parts system.
 * Every function takes `request(systemPrompt, userPrompt) => Promise<string>` so the
 * prompts and reply validation are testable without SillyTavern.
 */

import { TAG_RULES, normalizeTags, parseJsonReply, tagKey } from './tag-utils.js';
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

const NO_DUPLICATE_PARTS = 'Never create a new part that repeats or overlaps an existing one (e.g. "Horn" when "Horns" exists, "Fur" when "Skin" covers it): use the existing id instead. Use each part at most once.';

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
 * @param {{ request: RaceLlmRequest, race: { name: string, description: string }, parts: any[], instructions?: string }} args
 * @returns {Promise<{ parts: { partId?: string, newPart?: { name: string, description: string }, tags: string }[] }>}
 */
export async function generateRaceParts({ request, race, parts, instructions = '' }) {
    const prompt = `Define the body parts that EVERY member of this race always has, and tag them for an image generator.

RACE
Name: ${race.name}
${race.description}

EXISTING PARTS (use these ids whenever they fit)
${partListBlock(parts)}
${instructions ? `\nUSER INSTRUCTIONS (follow these)\n${instructions}\n` : ''}
Instructions:
1. Pick the existing parts that need race-wide tags (skip parts with nothing race-specific about them).
2. If something the race always has is not covered by an existing part (e.g. a tail, antennae), create a new part with a very short description of what it covers. ${NO_DUPLICATE_PARTS}
3. For each part, give a few Danbooru tags (max ${MAX_TAGS_PER_PART}) describing that part for ALL members of the race. Nothing individual like hair color unless the whole race shares it.${instructions ? `
4. Every feature or tag the user instructions mention must appear as tags on the matching part. Keep any emphasis the user wrote ({tag}, N::tag::) exactly as written.` : ''}

${TAG_RULES}

Respond with ONLY a JSON object in exactly this shape ("partId" is an id from the list above):
{"parts": [{"partId": "horns", "tags": "tag, tag"}, {"newPart": {"name": "Tail", "description": "Tail type, length and color."}, "tags": "tag, tag"}]}`;
    const parsed = await requestJson(request, prompt);
    const cleaned = cleanPartReplies(replyParts(parsed), parts, false);
    if (cleaned.length) return { parts: cleaned };
    // A reply in the wrong shape (or with no tags) gets one corrective retry.
    const retry = await requestJson(request, `${prompt}

Your previous reply had no usable parts with tags. Every entry needs "partId" (or "newPart") and a non-empty "tags" string.`);
    return { parts: cleanPartReplies(replyParts(retry), parts, false) };
}

/**
 * Race Creator "Generate from prompt": a whole race from the user's description or instructions.
 * Same two steps as automatic race creation (identity, then general parts), with the
 * user's text passed to both.
 * @param {{ request: RaceLlmRequest, prompt: string, races: any[], parts: any[] }} args
 * @returns {Promise<{ name: string, description: string, generalParts: { partId?: string, newPart?: { name: string, description: string }, tags: string }[] }>}
 */
export async function generateRaceFromPrompt({ request, prompt, races, parts }) {
    const instructions = String(prompt || '').trim();
    if (!instructions) throw new Error('Describe the race first.');
    const taken = races.length ? `\nThese races already exist and must not be repeated: ${races.map(r => r.name).join(', ')}.` : '';
    const parsed = await requestJson(request, `Create a race/species from the user's description or instructions.

USER INSTRUCTIONS
${instructions}
${taken}
Rules:
- name: the species name, ONE word if at all possible (e.g. "Oni", "Goblin", "Tiefling"), unless the user gave a name.
- description: one short paragraph describing the common VISUAL characteristics shared by all members of the race (size, build, skin, distinctive features). No lore or personality.

Respond with ONLY: {"name": "...", "description": "..."}`);
    const name = String(parsed.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) throw new Error('The AI did not return a race name.');
    const identity = { name, description: String(parsed.description || '').trim() };
    const { parts: generalParts } = await generateRaceParts({ request, race: identity, parts, instructions });
    return { ...identity, generalParts };
}

/**
 * Race editor "Write description with AI": one visual paragraph from the user's
 * prompt and, optionally, the race's general parts and their tags.
 * @param {{ request: RaceLlmRequest, prompt: string, name?: string, parts?: { name: string, tags: string }[] | null }} args
 * @returns {Promise<string>}
 */
export async function generateRaceDescription({ request, prompt, name = '', parts = null }) {
    const instructions = String(prompt || '').trim();
    const partLines = (parts || []).filter(p => p?.name).map(p => `- ${p.name}: ${String(p.tags || '').trim() || '(no tags)'}`);
    if (!instructions && !partLines.length) throw new Error('Write a prompt or include the race\'s parts.');
    const parsed = await requestJson(request, `Write the description of a race/species for a fantasy roleplay.

${name ? `RACE NAME\n${name}\n\n` : ''}${instructions ? `USER INSTRUCTIONS\n${instructions}\n\n` : ''}${partLines.length ? `GENERAL PARTS (tags every member has; turn them into natural prose, do not list tags)\n${partLines.join('\n')}\n\n` : ''}Rules:
- One short paragraph (2 to 4 sentences) describing what members of this race commonly look like: size, build, skin, distinctive features.
- Plain prose, no Danbooru tags, no emphasis syntax, no lists.
- Visual traits only; mention habits or lore only if the user asks for them.

Respond with ONLY: {"description": "..."}`);
    const description = String(parsed.description || '').trim();
    if (!description) throw new Error('The AI did not return a description.');
    return description;
}

/**
 * Character-specific parts, subject tags and (first) equipment/state tags in one call.
 * @param {{ request: RaceLlmRequest, character: { name: string, description: string },
 *           race: any|null, raceGroups: { partId: string, name: string, tags: string[] }[],
 *           parts: any[], scene?: string, instructions?: string }} args
 * @returns {Promise<{ subject: string, parts: { partId?: string, newPart?: { name: string, description: string }, tags: string, mode: 'add'|'replace' }[], equipment: string, state: string }>}
 */
export async function generateCharacterAppearance({ request, character, race, raceGroups, parts, scene = '', instructions = '' }) {
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
${scene ? `\nCURRENT SCENE\n${scene}\n` : ''}${instructions ? `\nUSER INSTRUCTIONS (follow these)\n${String(instructions).trim()}\n` : ''}
Base every tag on what the CHARACTER text${scene ? ' and the scene' : ''} actually say${instructions ? ' and on the user instructions' : ''}. Do not invent features they don't mention.
${instructions ? 'Every feature or tag the user instructions mention must appear on the matching part, keeping any emphasis exactly as written.\n' : ''}
Instructions:
1. subject: Danbooru subject tags for this character (e.g. "1girl", "1boy, mature male", "1other"). Do not add "solo" or framing tags.
2. parts: ONLY where this character adds detail to, or differs from, the race tags (hair color and style, eye color, scars, a tail the base race lacks…). Do not repeat race tags. Skip parts that need nothing extra.
   - mode "add" (default): tags are added to the race tags. Prefix a tag with "-" to drop one race tag, e.g. "-two horns, one horn, broken horn".
   - mode "replace": the race tags for that part are wrong for this character and are dropped entirely.
   - If the character has a body part the race does not, use an existing part id, or create one with newPart. ${NO_DUPLICATE_PARTS}
3. equipment: what the character currently wears and carries (clothing, armor, weapons, accessories). Empty string if unknown.
4. state: current visible state (expression, injuries, dirt, pose-neutral). Empty string if nothing notable.
Keep every list short (max ${MAX_TAGS_PER_PART} tags per part).

${TAG_RULES}

Respond with ONLY:
{"subject": "1girl", "parts": [{"partId": "hair", "tags": "white hair, long hair", "mode": "add"}], "equipment": "tag, tag", "state": "tag"}`);
    return {
        subject: limitTags(parsed.subject || ''),
        parts: cleanPartReplies(replyParts(parsed), parts, true),
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
 * The parts list of an AI reply, whatever shape the model chose: `parts`,
 * `generalParts` and similar keys, a bare array, or an object map
 * `{ "horns": "tag, tag" }`.
 * @returns {any[]}
 */
function replyParts(parsed) {
    if (Array.isArray(parsed)) return parsed;
    const raw = parsed?.parts ?? parsed?.generalParts ?? parsed?.general_parts ?? parsed?.bodyParts ?? parsed?.characterParts ?? parsed?.race?.parts;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
        return Object.entries(raw).map(([partId, value]) => (value && typeof value === 'object' && !Array.isArray(value) ? { partId, ...value } : { partId, tags: value }));
    }
    return [];
}

/** Find a part by id or name, also trying "Name (id)" and "snake_case" spellings. */
function matchPart(parts, ref) {
    const text = String(ref || '').trim();
    if (!text) return null;
    const inner = text.match(/\(([^)]+)\)/)?.[1] || '';
    const outer = text.replace(/\s*\(.*?\)/g, '').trim();
    for (const candidate of [text, inner, outer, text.replace(/[_-]+/g, ' ')]) {
        const c = candidate.trim();
        if (!c) continue;
        const part = parts.find(p => p.id === c || p.id === c.toLowerCase()) || findSimilarByName(parts, c)?.item;
        if (part) return part;
    }
    return null;
}

const titleCase = (text) => String(text).replace(/[_-]+/g, ' ').replace(/\s*\(.*?\)/g, '').trim().replace(/\b\w/g, c => c.toUpperCase());

/**
 * Validate the `parts` array of an AI reply. Part references (`partId`, `id`,
 * `part`, `name`…) are matched by id or name against existing parts first. In
 * race replies a reference to a part that does not exist comes back as `newPart`;
 * character replies need an explicit `newPart` for that.
 * Rows for the same part (or the same new part) are merged into one, so the AI
 * cannot add a part twice.
 */
function cleanPartReplies(list, parts, withMode) {
    const assignable = parts.filter(p => p.kind !== 'subject');
    const subjectIds = new Set(parts.filter(p => p.kind === 'subject').map(p => p.id));
    /** @type {Map<string, any>} */
    const out = new Map();
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== 'object') continue;
        const mode = withMode && item.mode === 'replace' ? 'replace' : 'add';
        const newPartObj = item.newPart && typeof item.newPart === 'object' ? item.newPart : null;
        const ref = item.partId ?? item.part_id ?? item.id ?? item.part ?? item.partName ?? item.name
            ?? (typeof item.newPart === 'string' ? item.newPart : newPartObj?.name);
        if (subjectIds.has(String(ref || '').trim().toLowerCase())) continue;
        let part = matchPart(assignable, ref);
        if (!part && newPartObj?.name) part = matchPart(assignable, newPartObj.name);
        // Character replies only add parts through an explicit newPart, so a stray
        // "clothing" or "weapon" reference cannot become a permanent body part.
        if (!part && withMode && !newPartObj && typeof item.newPart !== 'string') continue;
        const newName = part ? '' : titleCase(newPartObj?.name || ref || '');
        if (!part && (!newName || matchPart(parts, newName)?.kind === 'subject')) continue;
        const key = part ? `id:${part.id}` : `new:${findSimilarByName(newPartsOf(out), newName)?.item.name.toLowerCase() ?? newName.toLowerCase()}`;
        const prev = out.get(key);
        const tags = joinTags(prev?.tags, item.tags ?? item.tag ?? item.danbooruTags);
        const entry = prev || (part
            ? { partId: part.id }
            : { newPart: { name: newName.slice(0, 40), description: String(newPartObj?.description || item.description || '').trim() } });
        entry.tags = tags;
        if (withMode) entry.mode = prev?.mode === 'replace' ? 'replace' : mode;
        out.set(key, entry);
    }
    return Array.from(out.values())
        .map(e => (withMode ? e : { ...e, tags: limitTags(e.tags) }))
        .filter(e => e.tags || e.mode === 'replace')
        .map(e => (withMode ? { ...e, tags: normalizeTags(e.tags) } : e));
}

function newPartsOf(entries) {
    return Array.from(entries.values()).filter(e => e.newPart).map(e => e.newPart);
}

/** Concatenate two tag strings, dropping exact repeats. */
function joinTags(a, b) {
    const list = normalizeTags([a, b].flat().filter(Boolean).map(String).join(', ')).split(', ').filter(Boolean);
    const seen = new Set();
    return list.filter(t => !seen.has(tagKey(t)) && seen.add(tagKey(t))).join(', ');
}
