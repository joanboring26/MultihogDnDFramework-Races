/**
 * Races / appearance parts data model — pure helpers over the settings object.
 *
 * Global (cross-chat, like the NPC Library):
 *   settings.appearanceParts: [{ id, name, description, kind, order, builtin, createdBy }]
 *   settings.races:           [{ id, name, description, generalParts: [{ partId, tags }],
 *                                createdBy, originChatId, version, createdAt, updatedAt }]
 * Per chat, written directly into the partition (like playerCharacter):
 *   settings.chatStates[chatId].characterAppearance[key] =
 *     { name, raceId, subjectTags, parts: [{ partId, tags, mode }], raceVersionSeen, updatedAt }
 *
 * None of this is ever written into the memo, lorebooks or the Player Card, so it
 * never reaches story generation. It is only read when building image prompts.
 */

import { formatTagEmphasis, mergeTagLists, normalizeTags, splitTags, underscoresToSpaces } from './tag-utils.js';

export const RACE_PACK_FORMAT = 'multihog-races';
export const RACE_PACK_VERSION = 1;

/** Part kinds. Only `body` parts can be assigned to races; `subject` is per character. */
export const PART_KINDS = ['body', 'subject'];

/** Built-in id of the per-character subject part (1girl, solo, …). */
export const SUBJECT_PART_ID = 'subject';

const DEFAULT_PARTS = [
    { id: SUBJECT_PART_ID, kind: 'subject', name: 'Subject', description: 'Character count, gender and age group tags (e.g. 1girl, 1boy, solo, male focus, mature female, old man). Set per character, never per race.' },
    { id: 'height', name: 'Height', description: 'Height and body size (e.g. tall, very tall, giant, short, petite).' },
    { id: 'build', name: 'Build', description: 'Overall build and musculature (e.g. muscular, toned, skinny, plump, broad shoulders).' },
    { id: 'skin', name: 'Skin', description: 'Skin tone and covering (e.g. pale skin, dark skin, red skin, colored skin, scales, fur, freckles).' },
    { id: 'head', name: 'Head', description: 'Face shape, facial features and mouth (e.g. round face, sharp jawline, fangs, scar on face, beard is Hair).' },
    { id: 'ears', name: 'Ears', description: 'Ear shape and size (e.g. pointy ears, long pointy ears, animal ears, cat ears).' },
    { id: 'eyes', name: 'Eyes', description: 'Eye color, shape and details (e.g. blue eyes, slit pupils, glowing eyes, heterochromia).' },
    { id: 'hair', name: 'Hair', description: 'Hair color, length, style and facial hair (e.g. black hair, long hair, ponytail, beard).' },
    { id: 'horns', name: 'Horns', description: 'Horn count, shape, size and color (e.g. two horns, curled horns, small horns, oni horns).' },
    { id: 'chest', name: 'Chest', description: 'Chest build and size (e.g. pectorals, broad chest, flat chest, large breasts).' },
    { id: 'abs', name: 'Abs', description: 'Stomach and abdominal definition (e.g. abs, toned stomach, plump).' },
    { id: 'arms', name: 'Arms', description: 'Arm build and features (e.g. muscular arms, slender arms, claws, extra arms).' },
    { id: 'legs', name: 'Legs', description: 'Leg and thigh build and features (e.g. long legs, thick thighs, digitigrade legs, hooves).' },
    { id: 'tail', name: 'Tail', description: 'Tail type, length and color (e.g. demon tail, fox tail, lizard tail).' },
    { id: 'wings', name: 'Wings', description: 'Wing type, size and color (e.g. dragon wings, feathered wings, bat wings).' },
];

/** Fresh copy of the default part database. */
export function makeDefaultAppearanceParts() {
    return DEFAULT_PARTS.map((p, i) => ({
        kind: 'body',
        ...p,
        order: (i + 1) * 10,
        builtin: true,
        createdBy: 'user',
    }));
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/** @param {any} s */
export function getAppearanceParts(s) {
    if (!Array.isArray(s.appearanceParts)) s.appearanceParts = makeDefaultAppearanceParts();
    return s.appearanceParts;
}

/** @param {any} s */
export function getRaces(s) {
    if (!Array.isArray(s.races)) s.races = [];
    return s.races;
}

/** Parts in prompt order. @param {any} s */
export function sortedParts(s) {
    return getAppearanceParts(s).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Parts that may be used as race general parts. @param {any} s */
export function raceAssignableParts(s) {
    return sortedParts(s).filter(p => p.kind !== 'subject');
}

/** @param {any} s @param {string} id */
export function findPart(s, id) {
    return getAppearanceParts(s).find(p => p.id === id) || null;
}

/** @param {any} s @param {string} id */
export function findRace(s, id) {
    return getRaces(s).find(r => r.id === id) || null;
}

export function slugifyId(name, fallback = 'item') {
    return String(name || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || fallback;
}

function uniqueId(base, taken) {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    return id;
}

/** Name form used for duplicate detection: lowercase letters/digits, simple plural stripped. */
export function matchName(name) {
    const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (n.length > 4 && n.endsWith('es') && !n.endsWith('ses')) return n.slice(0, -2);
    if (n.length > 3 && n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1);
    return n;
}

/** Levenshtein distance. @param {string} a @param {string} b */
export function editDistance(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * Find an item whose name is the same as, or very close to, `name`.
 * Exact (normalized) matches win; otherwise the closest name within a small edit distance.
 * @template {{ name: string }} T
 * @param {T[]} items
 * @param {string} name
 * @returns {{ item: T, exact: boolean } | null}
 */
export function findSimilarByName(items, name) {
    const target = matchName(name);
    if (!target) return null;
    let best = null;
    let bestDist = Infinity;
    for (const item of items) {
        const candidate = matchName(item.name);
        if (candidate === target) return { item, exact: true };
        const dist = editDistance(candidate, target);
        const threshold = Math.max(1, Math.floor(Math.max(candidate.length, target.length) / 4));
        if (dist <= threshold && dist < bestDist) {
            best = item;
            bestDist = dist;
        }
    }
    return best ? { item: best, exact: false } : null;
}

// ── Parts CRUD ───────────────────────────────────────────────────────────────

/**
 * Add a part. A part with the same (normalized) name is returned instead of a duplicate.
 * @param {any} s
 * @param {{ name: string, description?: string, kind?: string, createdBy?: string }} def
 * @returns {{ part: any, created: boolean }}
 */
export function createPart(s, def) {
    const parts = getAppearanceParts(s);
    const name = String(def?.name || '').trim();
    if (!name) throw new Error('A part needs a name.');
    const same = parts.find(p => matchName(p.name) === matchName(name));
    if (same) return { part: same, created: false };
    const part = {
        id: uniqueId(slugifyId(name, 'part'), new Set(parts.map(p => p.id))),
        name,
        description: String(def.description || '').trim(),
        kind: PART_KINDS.includes(def.kind) ? def.kind : 'body',
        order: parts.reduce((max, p) => Math.max(max, p.order ?? 0), 0) + 10,
        builtin: false,
        createdBy: def.createdBy === 'ai' ? 'ai' : 'user',
    };
    parts.push(part);
    return { part, created: true };
}

/** @param {any} s @param {string} id @param {{ name?: string, description?: string }} patch */
export function updatePart(s, id, patch) {
    const part = findPart(s, id);
    if (!part) return null;
    if (patch.name !== undefined && String(patch.name).trim()) part.name = String(patch.name).trim();
    if (patch.description !== undefined) part.description = String(patch.description).trim();
    return part;
}

/** Swap a part with its neighbour in prompt order. @param {any} s @param {string} id @param {number} delta */
export function movePart(s, id, delta) {
    const list = sortedParts(s);
    const i = list.findIndex(p => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    list.forEach((p, k) => { p.order = (k + 1) * 10; });
    [list[i].order, list[j].order] = [list[j].order, list[i].order];
    return true;
}

/** Every character appearance record across all chats. @param {any} s */
function* allAppearances(s) {
    for (const [chatId, state] of Object.entries(s.chatStates || {})) {
        const map = state?.characterAppearance;
        if (!map || typeof map !== 'object') continue;
        for (const [key, record] of Object.entries(map)) {
            if (record && typeof record === 'object') yield { chatId, key, record };
        }
    }
}

/**
 * Where a part is used.
 * @param {any} s @param {string} partId
 * @returns {{ races: string[], characters: number }}
 */
export function partUsage(s, partId) {
    const races = getRaces(s).filter(r => (r.generalParts || []).some(gp => gp.partId === partId)).map(r => r.name);
    let characters = 0;
    for (const { record } of allAppearances(s)) {
        if ((record.parts || []).some(cp => cp.partId === partId)) characters++;
    }
    return { races, characters };
}

/** Delete a part and remove it from every race and character. Built-in subject part cannot be deleted. */
export function deletePart(s, id) {
    if (id === SUBJECT_PART_ID) return false;
    const parts = getAppearanceParts(s);
    const i = parts.findIndex(p => p.id === id);
    if (i < 0) return false;
    parts.splice(i, 1);
    for (const race of getRaces(s)) {
        const before = (race.generalParts || []).length;
        race.generalParts = (race.generalParts || []).filter(gp => gp.partId !== id);
        if (race.generalParts.length !== before) bumpRaceVersion(race);
    }
    for (const { record } of allAppearances(s)) {
        record.parts = (record.parts || []).filter(cp => cp.partId !== id);
    }
    return true;
}

// ── Races CRUD ───────────────────────────────────────────────────────────────

function cleanGeneralParts(s, generalParts) {
    const seen = new Set();
    /** @type {{ partId: string, tags: string }[]} */
    const out = [];
    for (const gp of Array.isArray(generalParts) ? generalParts : []) {
        const part = findPart(s, gp?.partId);
        if (!part || part.kind === 'subject' || seen.has(part.id)) continue;
        seen.add(part.id);
        out.push({ partId: part.id, tags: normalizeTags(gp.tags || '') });
    }
    return out;
}

function bumpRaceVersion(race) {
    race.version = (Number(race.version) || 1) + 1;
    race.updatedAt = Date.now();
}

/**
 * Add a race. Throws when a race with the same normalized name exists.
 * @param {any} s
 * @param {{ name: string, description?: string, generalParts?: any[], createdBy?: string, originChatId?: string }} def
 */
export function createRace(s, def) {
    const races = getRaces(s);
    const name = String(def?.name || '').trim();
    if (!name) throw new Error('A race needs a name.');
    if (races.some(r => matchName(r.name) === matchName(name))) throw new Error(`A race named "${name}" already exists.`);
    const now = Date.now();
    const race = {
        id: uniqueId(slugifyId(name, 'race'), new Set(races.map(r => r.id))),
        name,
        description: String(def.description || '').trim(),
        generalParts: cleanGeneralParts(s, def.generalParts),
        createdBy: def.createdBy === 'ai' ? 'ai' : 'user',
        originChatId: def.originChatId || '',
        version: 1,
        createdAt: now,
        updatedAt: now,
    };
    races.push(race);
    return race;
}

/**
 * Update a race in place (characters link by id, so changes apply everywhere).
 * Bumps `version` when anything visual changes so characters can be flagged stale.
 * @param {any} s @param {string} id
 * @param {{ name?: string, description?: string, generalParts?: any[] }} patch
 */
export function updateRace(s, id, patch) {
    const race = findRace(s, id);
    if (!race) return null;
    let changed = false;
    if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (name && name !== race.name) {
            if (getRaces(s).some(r => r.id !== id && matchName(r.name) === matchName(name))) {
                throw new Error(`A race named "${name}" already exists.`);
            }
            race.name = name;
        }
    }
    if (patch.description !== undefined && String(patch.description).trim() !== race.description) {
        race.description = String(patch.description).trim();
        changed = true;
    }
    if (patch.generalParts !== undefined) {
        const next = cleanGeneralParts(s, patch.generalParts);
        if (JSON.stringify(next) !== JSON.stringify(race.generalParts || [])) {
            race.generalParts = next;
            changed = true;
        }
    }
    if (changed) bumpRaceVersion(race);
    else race.updatedAt = Date.now();
    return race;
}

/** Characters (across all chats) linked to a race. @returns {{ chatId: string, name: string }[]} */
export function raceUsage(s, raceId) {
    const out = [];
    for (const { chatId, key, record } of allAppearances(s)) {
        if (record.raceId === raceId) out.push({ chatId, name: record.name || key });
    }
    return out;
}

/** Delete a race; linked characters become unassigned and get a new race next time. */
export function deleteRace(s, id) {
    const races = getRaces(s);
    const i = races.findIndex(r => r.id === id);
    if (i < 0) return false;
    races.splice(i, 1);
    for (const { record } of allAppearances(s)) {
        if (record.raceId === id) record.raceId = null;
    }
    return true;
}

// ── Character appearance (per chat) ──────────────────────────────────────────

/** Storage key for a character: parenthetical class suffixes dropped, case-insensitive. */
export function characterKey(name) {
    return String(name || '').replace(/\s*\(.*?\)/g, '').trim().toLowerCase();
}

/**
 * "Goblin 2" / "Goblin #3" / "Goblin B" → "Goblin". Numbered combatants share one appearance.
 * @param {string} name
 */
export function archetypeName(name) {
    const clean = String(name || '').replace(/\s*\(.*?\)/g, '').trim();
    const base = clean.replace(/\s+(?:#?\d+|[A-H])$/, '').trim();
    return base || clean;
}

/** @param {any} s @param {string} chatId @param {boolean} [create] */
export function getAppearanceMap(s, chatId, create = false) {
    if (!chatId) return null;
    if (!s.chatStates) {
        if (!create) return null;
        s.chatStates = {};
    }
    const state = s.chatStates[chatId] || (create ? (s.chatStates[chatId] = {}) : null);
    if (!state) return null;
    if (!state.characterAppearance || typeof state.characterAppearance !== 'object') {
        if (!create) return null;
        state.characterAppearance = {};
    }
    return state.characterAppearance;
}

/**
 * Look up a character's appearance. Falls back to the archetype ("Goblin" for "Goblin 2").
 * @returns {{ key: string, record: any } | null}
 */
export function getCharacterAppearance(s, chatId, name) {
    const map = getAppearanceMap(s, chatId);
    if (!map) return null;
    for (const key of new Set([characterKey(name), characterKey(archetypeName(name))])) {
        if (key && map[key]) return { key, record: map[key] };
    }
    return null;
}

/**
 * Store a character's appearance. Numbered combatants are stored under their archetype.
 * @param {any} s @param {string} chatId @param {string} name
 * @param {{ raceId?: string|null, noRace?: boolean, subjectTags?: string, parts?: any[] }} data
 *   `noRace` marks a deliberate "no race" so it is not re-assigned later.
 */
export function setCharacterAppearance(s, chatId, name, data) {
    const map = getAppearanceMap(s, chatId, true);
    const displayName = archetypeName(name);
    const key = characterKey(displayName);
    const race = data.raceId ? findRace(s, data.raceId) : null;
    const prev = map[key] || {};
    map[key] = {
        name: displayName,
        raceId: race ? race.id : null,
        noRace: !race && !!(data.noRace ?? prev.noRace),
        subjectTags: normalizeTags(data.subjectTags ?? prev.subjectTags ?? ''),
        parts: cleanCharacterParts(s, data.parts ?? prev.parts),
        raceVersionSeen: race ? race.version || 1 : 0,
        updatedAt: Date.now(),
    };
    return map[key];
}

function cleanCharacterParts(s, parts) {
    const seen = new Set();
    const out = [];
    for (const cp of Array.isArray(parts) ? parts : []) {
        const part = findPart(s, cp?.partId);
        if (!part || part.kind === 'subject' || seen.has(part.id)) continue;
        const tags = normalizeTags(cp.tags || '');
        const mode = cp.mode === 'replace' ? 'replace' : 'add';
        if (!tags && mode === 'add') continue;
        seen.add(part.id);
        out.push({ partId: part.id, tags, mode });
    }
    return out;
}

/** Move a character's appearance when they are renamed. */
export function renameCharacterAppearance(s, chatId, oldName, newName) {
    const map = getAppearanceMap(s, chatId);
    const oldKey = characterKey(oldName);
    const newKey = characterKey(newName);
    if (!map || !oldKey || !newKey || oldKey === newKey || !map[oldKey] || map[newKey]) return false;
    map[newKey] = { ...map[oldKey], name: String(newName).replace(/\s*\(.*?\)/g, '').trim() };
    delete map[oldKey];
    return true;
}

/** True when the linked race changed since the character's tags were written. */
export function isAppearanceRaceStale(s, record) {
    if (!record?.raceId) return false;
    const race = findRace(s, record.raceId);
    return !!race && (race.version || 1) !== (record.raceVersionSeen || 0);
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

/**
 * Tags per part for a character: race general tags and character tags merged
 * per part (character `replace` mode drops the race tags for that part, `-tag`
 * removes one race tag), in part database order.
 * @returns {{ partId: string, name: string, tags: string[] }[]}
 */
export function characterPartGroups(s, record) {
    const race = record?.raceId ? findRace(s, record.raceId) : null;
    const raceTags = new Map((race?.generalParts || []).map(gp => [gp.partId, gp.tags]));
    const charParts = new Map((record?.parts || []).map(cp => [cp.partId, cp]));
    const groups = [];
    for (const part of sortedParts(s)) {
        if (part.kind === 'subject') continue;
        const cp = charParts.get(part.id);
        const base = cp?.mode === 'replace' ? '' : (raceTags.get(part.id) || '');
        const tags = mergeTagLists(base, cp?.tags || '');
        if (tags.length) groups.push({ partId: part.id, name: part.name, tags });
    }
    return groups;
}

/**
 * Build the final image prompt.
 * Order: prefix, subject, parts (grouped, part order), equipment, state, suffix.
 * @param {any} s
 * @param {any} record character appearance record
 * @param {{ prefix?: string, suffix?: string, equipment?: string, state?: string,
 *           style?: import('./tag-utils.js').TagEmphasisStyle, replaceUnderscores?: boolean }} [opts]
 * @returns {{ prompt: string, groups: { partId: string, name: string, tags: string[] }[] }}
 */
export function assembleTagPrompt(s, record, opts = {}) {
    const groups = characterPartGroups(s, record);
    const sections = [
        splitTags(opts.prefix || ''),
        splitTags(record?.subjectTags || ''),
        ...groups.map(g => g.tags),
        splitTags(opts.equipment || ''),
        splitTags(opts.state || ''),
        splitTags(opts.suffix || ''),
    ];
    // Dedupe across sections too (equipment may repeat a part tag), keeping first position.
    const tags = formatTagEmphasis(mergeTagLists(...sections), opts.style || 'novelai');
    let prompt = tags.join(', ');
    if (opts.replaceUnderscores !== false) prompt = underscoresToSpaces(prompt);
    return { prompt, groups };
}

// ── Import / export ──────────────────────────────────────────────────────────

/** Build a portable pack of races (all when `raceIds` is omitted) plus the parts they use. */
export function buildRacePack(s, raceIds = null) {
    const races = getRaces(s).filter(r => !raceIds || raceIds.includes(r.id));
    const usedPartIds = new Set(races.flatMap(r => (r.generalParts || []).map(gp => gp.partId)));
    const parts = getAppearanceParts(s).filter(p => !raceIds || usedPartIds.has(p.id));
    return {
        format: RACE_PACK_FORMAT,
        version: RACE_PACK_VERSION,
        exportedAt: new Date().toISOString(),
        parts: JSON.parse(JSON.stringify(parts)),
        races: JSON.parse(JSON.stringify(races)).map(({ originChatId, ...rest }) => rest),
    };
}

/**
 * Merge a pack into the library. Parts and races are matched by name; existing
 * races with the same name are updated, new ones are added.
 * @returns {{ partsAdded: number, racesAdded: number, racesUpdated: number }}
 */
export function importRacePack(s, pack) {
    if (!pack || pack.format !== RACE_PACK_FORMAT) throw new Error('Not a Multihog races file.');
    let partsAdded = 0;
    let racesAdded = 0;
    let racesUpdated = 0;
    /** @type {Map<string, string>} pack part id → local part id */
    const partMap = new Map();
    for (const p of Array.isArray(pack.parts) ? pack.parts : []) {
        if (!p?.name) continue;
        const local = p.id === SUBJECT_PART_ID ? findPart(s, SUBJECT_PART_ID) : null;
        const { part, created } = local ? { part: local, created: false } : createPart(s, { name: p.name, description: p.description, kind: p.kind });
        if (created) partsAdded++;
        partMap.set(p.id, part.id);
    }
    for (const r of Array.isArray(pack.races) ? pack.races : []) {
        if (!r?.name) continue;
        const generalParts = (r.generalParts || []).map(gp => ({ partId: partMap.get(gp.partId) || gp.partId, tags: gp.tags }));
        const existing = getRaces(s).find(x => matchName(x.name) === matchName(r.name));
        if (existing) {
            updateRace(s, existing.id, { description: r.description, generalParts });
            racesUpdated++;
        } else {
            createRace(s, { name: r.name, description: r.description, generalParts, createdBy: r.createdBy });
            racesAdded++;
        }
    }
    return { partsAdded, racesAdded, racesUpdated };
}
