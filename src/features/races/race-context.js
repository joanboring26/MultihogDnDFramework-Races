/**
 * Story-context side of the races system: race NAMES and DESCRIPTIONS only.
 * This is the one races module the narrator prompt may use. Tags, parts and
 * part descriptions stay image-only (tests/races-story-isolation.test.js).
 */

import { findRace, getCharacterAppearance } from './races-lib.js';

const HP_LINE = /^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP/i;

/**
 * Character names from the [CHARACTER], [PARTY] and [COMBAT] memo blocks.
 * @param {Record<string, string>} blocks parsed memo blocks
 * @returns {string[]}
 */
export function memoCharacterNames(blocks) {
    const names = [];
    for (const tag of ['CHARACTER', 'PARTY', 'COMBAT']) {
        for (const line of String(blocks?.[tag] || '').split('\n')) {
            const clean = line.trim().replace(/^\s*[-*+•–—](?:\s+|(?=[A-Za-z]))/, '');
            const m = clean.match(HP_LINE);
            if (m) names.push(m[1].trim());
        }
    }
    return names;
}

const displayName = (name) => String(name || '').replace(/\s*\(.*?\)/g, '').trim();

/**
 * `[RACES]` block for the characters present this turn: each race once, with
 * the characters that have it and the race's description.
 * @param {any} s settings
 * @param {string} chatId
 * @param {string[]} names characters in the scene (player, party, combat, active NPCs)
 * @returns {string} the block, or '' when no present character has a described race
 */
export function buildRaceContextBlock(s, chatId, names) {
    /** @type {Map<string, { race: any, names: string[] }>} */
    const byRace = new Map();
    for (const name of names) {
        const label = displayName(name);
        if (!label) continue;
        const raceId = getCharacterAppearance(s, chatId, label)?.record.raceId;
        const race = raceId ? findRace(s, raceId) : null;
        if (!race || !String(race.description || '').trim()) continue;
        const group = byRace.get(race.id) || { race, names: [] };
        if (!group.names.some(n => n.toLowerCase() === label.toLowerCase())) group.names.push(label);
        byRace.set(race.id, group);
    }
    if (!byRace.size) return '';
    const lines = Array.from(byRace.values()).map(({ race, names: who }) =>
        `${race.name} (${who.join(', ')}): ${String(race.description).trim().replace(/\s+/g, ' ')}`);
    return `[RACES]\n${lines.join('\n')}\n[/RACES]\n\n`;
}
