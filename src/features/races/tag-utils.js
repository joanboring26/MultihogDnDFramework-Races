/**
 * Danbooru tag helpers for the races / parts image prompt system.
 * Pure — no SillyTavern or DOM access, so everything here is unit-testable.
 *
 * Stored tags use NovelAI emphasis syntax: `{tag}` / `{{tag}}` to strengthen,
 * `[tag]` to weaken, and `N::tag::` (or `N::tag a, tag b::`) for numeric weights.
 * formatTagEmphasis() converts that to other backends at prompt assembly time.
 */

/** Maximum emphasis allowed, both for brace depth and for N::tag:: weights. */
export const MAX_TAG_EMPHASIS = 4;

export const TAG_RULES = `Rules for tags:
- Output ONLY Danbooru tags: lowercase, comma-separated. No sentences, no explanations, no character names.
- To emphasize a defining trait, wrap the tag in braces like {tag} or {{tag}}, or use the weight format N::tag:: where N is a number from 1 to ${MAX_TAG_EMPHASIS}. Never exceed ${MAX_TAG_EMPHASIS}. Only emphasize defining traits.
- Keep it short: a few precise tags beat many vague ones.`;

const WEIGHT_OPEN = /^(-?\d+(?:\.\d+)?)::/;

/**
 * Split a tag string on top-level commas. Commas inside `{…}`, `[…]` or an
 * open `N::…::` weight group belong to that group and do not split it.
 * @param {string} text
 * @returns {string[]}
 */
export function splitTags(text) {
    const src = String(text ?? '').replace(/[\r\n]+/g, ', ');
    /** @type {string[]} */
    const out = [];
    let depth = 0;
    let inWeight = false;
    let cur = '';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (!inWeight && depth === 0 && cur.trim() === '') {
            const m = src.slice(i).match(WEIGHT_OPEN);
            if (m) {
                inWeight = true;
                cur += m[0];
                i += m[0].length - 1;
                continue;
            }
        }
        if (inWeight && ch === ':' && src[i + 1] === ':') {
            inWeight = false;
            cur += '::';
            i++;
            continue;
        }
        if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && depth > 0) depth--;
        if (ch === ',' && depth === 0 && !inWeight) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out.map(t => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/**
 * Clamp one tag's emphasis to MAX_TAG_EMPHASIS.
 * @param {string} tag
 */
function clampTagEmphasis(tag) {
    return tag
        .replace(/^(-?)(\d+(?:\.\d+)?)::/, (match, sign, num) => (Number(num) > MAX_TAG_EMPHASIS ? `${sign}${MAX_TAG_EMPHASIS}::` : match))
        .replace(/\{{5,}/g, '{'.repeat(MAX_TAG_EMPHASIS))
        .replace(/\}{5,}/g, '}'.repeat(MAX_TAG_EMPHASIS))
        .replace(/\[{5,}/g, '['.repeat(MAX_TAG_EMPHASIS))
        .replace(/\]{5,}/g, ']'.repeat(MAX_TAG_EMPHASIS));
}

/**
 * Clean a tag string: one line, comma separated, emphasis capped.
 * @param {string|string[]} text
 * @returns {string}
 */
export function normalizeTags(text) {
    const joined = Array.isArray(text) ? text.join(', ') : text;
    return splitTags(joined).map(clampTagEmphasis).join(', ');
}

/**
 * Parse one tag into its bare text and emphasis.
 * @param {string} tag
 * @returns {{ text: string, weight: number, kind: 'plain'|'braces'|'brackets'|'numeric', level: number }}
 */
export function parseTag(tag) {
    const t = String(tag ?? '').trim();
    const num = t.match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)(?:::)?$/);
    if (num) {
        const value = Number(num[1]);
        return { text: num[2].trim(), weight: value, kind: 'numeric', level: value };
    }
    const braces = t.match(/^(\{+)([\s\S]*?)\}*$/);
    if (braces) {
        const level = braces[1].length;
        return { text: braces[2].trim(), weight: 1.05 ** level, kind: 'braces', level };
    }
    const brackets = t.match(/^(\[+)([\s\S]*?)\]*$/);
    if (brackets) {
        const level = brackets[1].length;
        return { text: brackets[2].trim(), weight: 1.05 ** -level, kind: 'brackets', level };
    }
    return { text: t, weight: 1, kind: 'plain', level: 0 };
}

/**
 * Comparison key for dedupe: bare tag text, lowercase, underscores as spaces.
 * @param {string} tag
 */
export function tagKey(tag) {
    return parseTag(tag).text.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Merge tag lists in order, dropping duplicates. When the same tag appears
 * twice the copy with the stronger emphasis wins, at the first copy's position.
 * Tags written as `-tag` are removals: they drop that tag from earlier lists
 * and are never emitted themselves.
 * @param {...(string|string[])} lists
 * @returns {string[]}
 */
export function mergeTagLists(...lists) {
    /** @type {Map<string, { tag: string, weight: number }>} */
    const merged = new Map();
    for (const list of lists) {
        const tags = Array.isArray(list) ? list.flatMap(splitTags) : splitTags(list);
        for (const raw of tags) {
            if (raw.startsWith('-') && !WEIGHT_OPEN.test(raw)) {
                merged.delete(tagKey(raw.slice(1)));
                continue;
            }
            const tag = clampTagEmphasis(raw);
            const key = tagKey(tag);
            if (!key) continue;
            const { weight } = parseTag(tag);
            const existing = merged.get(key);
            if (!existing) merged.set(key, { tag, weight });
            else if (weight > existing.weight) {
                existing.tag = tag;
                existing.weight = weight;
            }
        }
    }
    return Array.from(merged.values()).map(v => v.tag);
}

/**
 * Bare tags written as `-tag` in a list (removal markers).
 * @param {string} text
 * @returns {string[]}
 */
export function removalTags(text) {
    return splitTags(text).filter(t => t.startsWith('-') && !WEIGHT_OPEN.test(t)).map(t => t.slice(1).trim());
}

/** @typedef {'novelai'|'sd'|'none'} TagEmphasisStyle */

/**
 * Render stored (NovelAI-syntax) emphasis for an image backend.
 * - `novelai`: unchanged.
 * - `sd`: A1111/ComfyUI style — braces become parentheses, `N::tag::` becomes `(tag:N)`.
 * - `none`: emphasis stripped.
 * @param {string[]} tags
 * @param {TagEmphasisStyle} style
 * @returns {string[]}
 */
export function formatTagEmphasis(tags, style = 'novelai') {
    if (style === 'novelai') return tags.slice();
    return tags.map((tag) => {
        const p = parseTag(tag);
        if (style === 'none' || p.kind === 'plain') return p.text;
        if (p.kind === 'numeric') return `(${p.text}:${p.level})`;
        if (p.kind === 'braces') return `${'('.repeat(p.level)}${p.text}${')'.repeat(p.level)}`;
        return `${'['.repeat(p.level)}${p.text}${']'.repeat(p.level)}`;
    });
}

/**
 * Danbooru tags use underscores; NovelAI and most models prefer spaces.
 * Only replaces underscores between word characters so emoticons like ^_^ survive.
 * @param {string} text
 */
export function underscoresToSpaces(text) {
    return String(text ?? '').replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, ' ');
}

/**
 * Pull the JSON object out of an LLM reply. Tolerates code fences, chatter
 * around the JSON, reasoning blocks (<think>…</think>) and trailing commas.
 * @param {string} reply
 * @returns {any|null}
 */
export function parseJsonReply(reply) {
    const text = String(reply ?? '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/```(?:json)?/gi, '');
    const tryParse = (slice) => {
        for (const candidate of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
            try {
                return JSON.parse(candidate);
            } catch { /* try the next form */ }
        }
        return null;
    };
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const whole = tryParse(text.slice(start, end + 1));
    if (whole !== null) return whole;
    // Chatter containing braces: try each balanced {...} block; the largest that parses wins.
    let best = null;
    let bestLength = 0;
    for (let i = start; i !== -1; i = text.indexOf('{', i + 1)) {
        let depth = 0;
        let inString = false;
        for (let j = i; j < text.length; j++) {
            const ch = text[j];
            if (inString) {
                if (ch === '\\') j++;
                else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) {
                const parsed = tryParse(text.slice(i, j + 1));
                if (parsed !== null && typeof parsed === 'object' && j + 1 - i > bestLength) {
                    best = parsed;
                    bestLength = j + 1 - i;
                }
                break;
            }
        }
    }
    return best;
}
