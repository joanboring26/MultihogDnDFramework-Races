/**
 * Give every character in the active campaign a race, with or without a portrait.
 * Runs after each tracker refresh and Lorebook Agent pass. Characters that already
 * have an appearance record (including a deliberate "no race") are skipped, and
 * each character is tried at most once per session so failures don't repeat.
 */

import { getSettings, getActiveChatId, getEffectiveRouterCampaignPrefix } from '../../../state-manager.js';
import { getEnemyEntities, getPartyMembers, getPrimaryCharacterBlockName, portraitLlmRequest } from '../../../portraits.js';
import { ensureCharacterAppearance } from './appearance.js';
import { archetypeName, characterKey, getCharacterAppearance } from './races-lib.js';

const attempted = new Set();

/** @returns {Promise<{ name: string, npcContent: string|null }[]>} */
async function campaignCharacters(s, chatId) {
    const list = [];
    const player = getPrimaryCharacterBlockName(s) || s.chatStates?.[chatId]?.playerCharacter?.name;
    if (player) list.push({ name: player, npcContent: null });
    for (const name of [...getPartyMembers(), ...getEnemyEntities()]) list.push({ name, npcContent: null });

    const ctx = SillyTavern.getContext();
    if (typeof ctx.loadWorldInfo === 'function') {
        const prefix = getEffectiveRouterCampaignPrefix(chatId);
        try {
            const book = await ctx.loadWorldInfo(prefix ? `${prefix}_NPCs` : 'NPCs');
            for (const entry of Object.values(book?.entries || {})) {
                const name = String(entry?.comment || '').trim();
                if (name) list.push({ name, npcContent: entry.content || '' });
            }
        } catch {
            // No NPC book for this campaign yet.
        }
    }
    return list;
}

/** Assign races to characters in the active chat that don't have one yet. */
export async function autoAssignRaces() {
    const s = getSettings();
    if (s.raceAutoAssign === false) return;
    const chatId = getActiveChatId();
    if (!chatId) return;

    for (const { name, npcContent } of await campaignCharacters(s, chatId)) {
        if (getActiveChatId() !== chatId) return;
        const key = `${chatId}::${characterKey(archetypeName(name))}`;
        if (attempted.has(key) || getCharacterAppearance(s, chatId, name)) continue;
        attempted.add(key);
        try {
            await ensureCharacterAppearance(name, { request: portraitLlmRequest(s), npcContent, chatId });
        } catch (err) {
            console.warn(`[RPG Tracker] Race auto-assignment failed for ${name}:`, err);
        }
    }
}
