/**
 * Race / parts pipeline for tag-mode portraits.
 *
 * ensureCharacterAppearance(): assign a race (creating one with the AI if needed)
 * and generate character-specific parts, stored per chat.
 * buildTagPortraitPrompt(): the above, plus per-image equipment/state tags,
 * assembled into the final Danbooru prompt.
 *
 * Nothing here writes to the memo, lorebooks or Player Card: the tags never
 * reach story generation.
 */

import { getSettings, getActiveChatId, getEffectiveRouterCampaignPrefix } from '../../../state-manager.js';
import { saveSettings } from '../../app/runtime-bridge.js';
import { parseMemoBlocks } from '../../../renderer.js';
import { buildPortraitStoryContext, portraitStoryLookbackCount } from '../../state/portrait-story-lookback.js';
import {
    archetypeName,
    assembleTagPrompt,
    characterKey,
    characterPartGroups,
    createPart,
    createRace,
    findRace,
    findSimilarByName,
    getCharacterAppearance,
    getRaces,
    raceAssignableParts,
    setCharacterAppearance,
    sortedParts,
} from './races-lib.js';
import { generateCharacterAppearance, generateRaceIdentity, generateRaceParts, generateStateTags, pickRace } from './races-ai.js';
import { reviewAiRace, reviewCharacterAppearance } from '../../ui/races/race-manager.js';

/** @typedef {(systemPrompt: string, userPrompt: string) => Promise<string>} RaceLlmRequest */

const MAX_DESCRIPTION_CHARS = 3000;

// Appearance passes run one at a time so two new characters of the same new
// species cannot each create their own copy of the race.
let appearanceChain = Promise.resolve();
function serialized(task) {
    const run = appearanceChain.then(task, task);
    appearanceChain = run.catch(() => {});
    return run;
}

/** Strip campaign-only lines (relationships, CORE markers) from an NPC card. */
function cleanCardText(text) {
    return String(text || '')
        .replace(/\[\/?CORE\]/gi, '')
        .replace(/^\s*(?:Friendship\/Rapport|Affection\/Interest|Relationship with[^:]*):.*$/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function loadNpcCardText(chatId, name) {
    const ctx = SillyTavern.getContext();
    if (!chatId || typeof ctx.loadWorldInfo !== 'function') return '';
    const prefix = getEffectiveRouterCampaignPrefix(chatId);
    try {
        const book = await ctx.loadWorldInfo(prefix ? `${prefix}_NPCs` : 'NPCs');
        const key = characterKey(name);
        const entry = Object.values(book?.entries || {}).find(e => characterKey(e.comment) === key
            || (Array.isArray(e.key) && e.key.some(k => characterKey(k) === key)));
        return entry?.content || '';
    } catch {
        return '';
    }
}

/**
 * Everything known about a character's identity, as prose for the AI.
 * @param {string} name
 * @param {{ npcContent?: string|null, chatId: string }} opts
 */
export async function gatherCharacterDescription(name, { npcContent = null, chatId }) {
    const s = getSettings();
    const parts = [];
    const key = characterKey(name);

    const pc = s.chatStates?.[chatId]?.playerCharacter;
    if (pc?.name && characterKey(pc.name) === key && pc.bio) parts.push(`Player character card:\n${pc.bio}`);

    const card = npcContent ?? await loadNpcCardText(chatId, name);
    if (card) parts.push(`Character card:\n${cleanCardText(card)}`);

    if (s.currentMemo && chatId === getActiveChatId()) {
        const blocks = parseMemoBlocks(s.currentMemo);
        const needle = archetypeName(name).toLowerCase();
        for (const tag of ['CHARACTER', 'PARTY', 'COMBAT']) {
            const lines = String(blocks[tag] || '').split('\n').filter(l => l.toLowerCase().includes(needle));
            if (lines.length) parts.push(`[${tag}] state lines:\n${lines.join('\n')}`);
        }
    }
    return parts.join('\n\n').slice(0, MAX_DESCRIPTION_CHARS);
}

function sceneContext(s) {
    if (!s.portraitUseStoryLookback) return '';
    return buildPortraitStoryContext(SillyTavern.getContext(), portraitStoryLookbackCount(s), { maxChars: 3000, label: 'Recent Scene' });
}

/** Create AI-proposed parts and return plain { partId, tags, mode? } rows. */
function materialize(s, rows) {
    return rows.map((row) => {
        if (row.partId) return row;
        const { part } = createPart(s, { ...row.newPart, createdBy: 'ai' });
        const { newPart, ...rest } = row;
        return { ...rest, partId: part.id };
    });
}

/**
 * Pick or create the race for a character.
 * @returns {Promise<string|null>} race id, or null when no race should be assigned
 */
async function resolveRace(s, request, character, { interactive }) {
    const races = getRaces(s);
    const picked = await pickRace({ request, races, character });
    if (picked.raceId) return picked.raceId;

    const mode = s.raceCreationMode || 'ask';
    if (mode === 'never') return null;

    const identity = await generateRaceIdentity({ request, character, races });
    const similar = findSimilarByName(races, identity.name);
    if (similar) return similar.item.id;

    const { parts } = await generateRaceParts({ request, race: identity, parts: raceAssignableParts(s) });
    let draft = { ...identity, generalParts: parts };
    if (mode === 'ask' && interactive !== false) {
        const reviewed = await reviewAiRace(draft, character.name);
        if (!reviewed) return null;
        draft = reviewed;
    } else {
        draft = { ...draft, generalParts: materialize(s, draft.generalParts) };
    }
    try {
        return createRace(s, { ...draft, createdBy: 'ai', originChatId: character.chatId }).id;
    } catch {
        // Lost a race against an identical name (e.g. the user renamed it in review).
        return findSimilarByName(getRaces(s), draft.name)?.item.id ?? null;
    }
}

/**
 * Make sure a character has a race and character parts.
 * @param {string} name
 * @param {{ request: RaceLlmRequest, npcContent?: string|null, chatId?: string, force?: boolean, interactive?: boolean }} opts
 * @returns {Promise<{ record: any, character: { name: string, description: string, chatId: string }, firstPass: { equipment: string, state: string } | null }>}
 */
export function ensureCharacterAppearance(name, opts) {
    return serialized(async () => {
        const s = getSettings();
        const chatId = opts.chatId || getActiveChatId();
        if (!chatId) throw new Error('No active chat.');
        const description = await gatherCharacterDescription(name, { npcContent: opts.npcContent ?? null, chatId });
        const character = { name: archetypeName(name), description, chatId };

        const existing = getCharacterAppearance(s, chatId, name);
        const keptRaceId = existing?.record.raceId && findRace(s, existing.record.raceId) ? existing.record.raceId : null;
        // A deliberate "no race" (user choice or declined AI race) is kept; a race
        // that was deleted from the library is re-assigned.
        if (existing && !opts.force && (keptRaceId || existing.record.noRace)) {
            return { record: existing.record, character, firstPass: null };
        }

        const raceId = keptRaceId || (existing?.record.noRace ? null : await resolveRace(s, opts.request, character, opts));
        const race = raceId ? findRace(s, raceId) : null;
        const generated = await generateCharacterAppearance({
            request: opts.request,
            character,
            race,
            raceGroups: characterPartGroups(s, { raceId, parts: [] }),
            parts: sortedParts(s),
            scene: sceneContext(s),
        });
        let draft = { raceId, noRace: !raceId, subjectTags: generated.subject, parts: materialize(s, generated.parts) };
        if (s.raceReviewCharacterTags && opts.interactive !== false) {
            draft = await reviewCharacterAppearance(draft, character.name) || draft;
        }
        const record = setCharacterAppearance(s, chatId, name, draft);
        await saveSettings();
        return { record, character, firstPass: { equipment: generated.equipment, state: generated.state } };
    });
}

/**
 * Build a tag-mode portrait prompt for a character.
 * @param {string} name
 * @param {{ request: RaceLlmRequest, npcContent?: string|null, chatId?: string, interactive?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function buildTagPortraitPrompt(name, opts) {
    const s = getSettings();
    const { record, character, firstPass } = await ensureCharacterAppearance(name, opts);
    const current = firstPass || await generateStateTags({ request: opts.request, character, scene: sceneContext(s) });
    return assembleTagPrompt(s, record, {
        prefix: s.portraitTagPrefix || '',
        suffix: s.portraitTagSuffix || '',
        equipment: current.equipment,
        state: current.state,
        style: s.portraitTagEmphasisStyle || 'novelai',
    }).prompt;
}

/**
 * Re-run the character parts step (e.g. after the race was edited), keeping the race.
 * @param {string} name
 * @param {{ request: RaceLlmRequest, npcContent?: string|null }} opts
 */
export async function recheckCharacterAppearance(name, opts) {
    await ensureCharacterAppearance(name, { ...opts, force: true });
}
