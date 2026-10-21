/**
 * Part Creator, Race Creator and the per-character Race & Parts editor.
 * Ported from the tag category UI in joanboring26/SillytavernTest and extended
 * for the race / character split. Data helpers live in src/features/races/.
 */

import {
    assembleTagPrompt,
    buildRacePack,
    characterPartGroups,
    createPart,
    createRace,
    deletePart,
    deleteRace,
    findPart,
    findSimilarByName,
    getCharacterAppearance,
    getRaces,
    importRacePack,
    isAppearanceRaceStale,
    movePart,
    partUsage,
    raceAssignableParts,
    raceUsage,
    setCharacterAppearance,
    sortedParts,
    updatePart,
    updateRace,
} from '../../features/races/races-lib.js';
import { MAX_TAG_EMPHASIS, normalizeTags, parseJsonReply } from '../../features/races/tag-utils.js';
import { generateRaceFromPrompt, generateRaceParts } from '../../features/races/races-ai.js';

const TITLE = 'Races & Parts';
const TAG_PLACEHOLDER = 'tag, {important tag}, 2::weighted tag::';
const EMPHASIS_HINT = `Emphasis: {tag} or N::tag:: with N up to ${MAX_TAG_EMPHASIS}. In character parts, -tag removes one race tag.`;

/** @type {{ getSettings: () => any, saveSettings: (...a: any[]) => any, getActiveChatId: () => string, request: (sys: string, user: string) => Promise<string>, refresh?: () => void } | null} */
let deps = null;

/**
 * Wire the UI to the app (settings, persistence, the portrait LLM connection).
 * Called once from index.js.
 */
export function configureRaceManager(nextDeps) {
    deps = nextDeps;
}

function need() {
    if (!deps) throw new Error('Race manager is not configured.');
    return deps;
}

function save() {
    need().saveSettings();
}

// ── Popup helpers ────────────────────────────────────────────────────────────

/**
 * @param {JQuery} $content
 * @param {{ okButton?: string|false, cancelButton?: string|false, wide?: boolean, large?: boolean }} opts
 * @returns {Promise<boolean>} true when confirmed
 */
async function showPopup($content, opts = {}) {
    const ctx = SillyTavern.getContext();
    const popupOpts = { wide: true, allowVerticalScrolling: true, ...opts };
    if (ctx.Popup && ctx.POPUP_TYPE) {
        const type = opts.cancelButton === false ? ctx.POPUP_TYPE.TEXT : ctx.POPUP_TYPE.CONFIRM;
        const result = await new ctx.Popup($content, type, '', popupOpts).show();
        return result === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1);
    }
    const result = await ctx.callGenericPopup($content, ctx.POPUP_TYPE?.CONFIRM ?? 1, '', popupOpts);
    return result === 1;
}

async function confirmPopup(title, body) {
    const $msg = $('<div></div>').append($('<h3></h3>').text(title));
    if (body) $msg.append($('<p></p>').text(body));
    return showPopup($msg, { okButton: 'Yes', cancelButton: 'Cancel', wide: false });
}

const iconButton = (icon, title) => $(`<i class="fa-solid ${icon} menu_button interactable rt-races-icon" tabindex="0"></i>`).attr('title', title);
const textButton = (icon, label) => $(`<div class="menu_button menu_button_icon interactable"><i class="fa-solid ${icon}"></i><span></span></div>`).find('span').text(label).end();

function partSelect(parts, selectedId) {
    const $select = $('<select class="text_pole rt-races-part-select"></select>');
    for (const p of parts) $select.append($('<option></option>').val(p.id).text(p.name));
    if (selectedId) $select.val(selectedId);
    return $select;
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickJsonFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            resolve(file ? await file.text() : null);
        });
        input.click();
    });
}

// ── Part Creator ─────────────────────────────────────────────────────────────

/** Ask the AI to turn a short idea into a part name + description. */
async function generatePartDefinition(idea) {
    const reply = await need().request(
        'You design body-part categories for describing characters with Danbooru tags. Reply with JSON only.',
        `Create one body-part category from this idea: "${idea}"

Respond with ONLY a JSON object like:
{"name": "Short Title", "description": "One sentence saying which Danbooru tags belong in this part, with a few example tags in parentheses."}`,
    );
    const parsed = parseJsonReply(reply);
    if (!parsed?.name) throw new Error('The AI reply had no part name.');
    return { name: String(parsed.name).trim(), description: String(parsed.description ?? '').trim() };
}

/** Add or edit a part. Pass a part to edit it, or nothing to create one. */
async function editPart(part = null) {
    const isNew = !part;
    const $content = $('<div class="rt-races-editor"></div>');
    $content.append($('<h3></h3>').text(isNew ? 'Add part' : `Edit part "${part.name}"`));

    const $name = $('<input class="text_pole" type="text" />').val(part?.name ?? '');
    const $desc = $('<textarea class="text_pole textarea_compact" rows="3"></textarea>').val(part?.description ?? '');

    if (isNew) {
        const $idea = $('<textarea class="text_pole textarea_compact" rows="2" placeholder="e.g. tusks and how big they are"></textarea>');
        const $ai = textButton('fa-wand-magic-sparkles', 'Generate with AI');
        $ai.on('click', async () => {
            const idea = String($idea.val()).trim();
            if (!idea) return toastr['warning']('Describe the part first.', TITLE);
            $ai.addClass('disabled');
            try {
                const def = await generatePartDefinition(idea);
                $name.val(def.name);
                $desc.val(def.description);
            } catch (err) {
                console.error('[RPG Tracker] Part generation failed', err);
                toastr['error'](`Couldn't generate the part: ${err.message || err}`, TITLE);
            } finally {
                $ai.removeClass('disabled');
            }
        });
        $content.append('<label>Describe the part for the AI (optional)</label>', $idea, $ai, '<hr class="sysHR" />');
    }

    $content.append('<label>Name</label>', $name, '<label>Description (what this part covers, used by the AI)</label>', $desc);
    if (!(await showPopup($content, { okButton: isNew ? 'Add' : 'Save', cancelButton: 'Cancel' }))) return null;

    const s = need().getSettings();
    const name = String($name.val()).trim();
    if (!name) {
        toastr['warning']('A part needs a name.', TITLE);
        return null;
    }
    if (isNew) {
        const { part: created, created: wasCreated } = createPart(s, { name, description: String($desc.val()) });
        if (!wasCreated) toastr['info'](`A part named "${created.name}" already exists.`, TITLE);
        save();
        return created;
    }
    updatePart(s, part.id, { name, description: String($desc.val()) });
    save();
    return part;
}

async function confirmDeletePart(part) {
    const s = need().getSettings();
    const usage = partUsage(s, part.id);
    const used = [];
    if (usage.races.length) used.push(`races: ${usage.races.join(', ')}`);
    if (usage.characters) used.push(`${usage.characters} character(s)`);
    const body = used.length ? `It is used by ${used.join(' and ')}. Its tags will be removed from all of them.` : 'It is not used by any race or character.';
    if (!(await confirmPopup(`Delete part "${part.name}"?`, body))) return;
    deletePart(s, part.id);
    save();
}

/** Browse, add, reorder, edit and delete parts. */
export async function openPartCreator() {
    const $content = $('<div class="rt-races-manager"></div>');
    $content.append('<h3>Part Creator</h3>');
    $content.append('<small>Parts are the body areas races and characters are tagged by. Prompt tags are grouped in this order.</small>');
    const $list = $('<div class="rt-races-list"></div>');

    const render = () => {
        const s = need().getSettings();
        const parts = sortedParts(s);
        $list.empty();
        parts.forEach((part, i) => {
            const $row = $('<div class="rt-races-row"></div>');
            const $head = $('<div class="rt-races-row-header"></div>');
            $head.append($('<b class="rt-races-row-name"></b>').text(part.name));
            if (part.kind === 'subject') $head.append('<small class="rt-races-chip">per character</small>');
            if (part.createdBy === 'ai') $head.append('<small class="rt-races-chip">AI</small>');
            const $actions = $('<div class="rt-races-row-actions"></div>');
            $actions.append(
                iconButton('fa-arrow-up', 'Move up').toggleClass('disabled', i === 0).on('click', () => { movePart(s, part.id, -1); save(); render(); }),
                iconButton('fa-arrow-down', 'Move down').toggleClass('disabled', i === parts.length - 1).on('click', () => { movePart(s, part.id, 1); save(); render(); }),
                iconButton('fa-pencil', 'Edit').on('click', async () => { await editPart(part); render(); }),
            );
            if (part.kind !== 'subject') {
                $actions.append(iconButton('fa-trash-can', 'Delete').addClass('redWarningBG').on('click', async () => { await confirmDeletePart(part); render(); }));
            }
            $head.append($actions);
            $row.append($head, $('<small class="rt-races-row-desc"></small>').text(part.description || ''));
            $list.append($row);
        });
    };

    const $add = textButton('fa-plus', 'Add part').on('click', async () => { await editPart(); render(); });
    $content.append($list, $('<div class="flex-container"></div>').append($add));
    render();
    await showPopup($content, { okButton: 'Close', cancelButton: false, large: true });
}

// ── Race Creator ─────────────────────────────────────────────────────────────

/**
 * Editable general-parts table used by the race editor and the AI race review.
 * @param {{ partId: string, tags: string }[]} initial
 * @returns {{ $el: JQuery, read: () => { partId: string, tags: string }[], set: (rows: { partId: string, tags: string }[]) => void }}
 */
function generalPartsTable(initial) {
    const $el = $('<div class="rt-races-gp"></div>');
    const $rows = $('<div class="rt-races-gp-rows"></div>');
    const addRow = (row = null) => {
        const parts = raceAssignableParts(need().getSettings());
        if (!parts.length) return;
        const $row = $('<div class="rt-races-gp-row"></div>');
        const $sel = partSelect(parts, row?.partId || parts[0].id);
        const $tags = $('<textarea class="text_pole textarea_compact" rows="1"></textarea>').attr('placeholder', TAG_PLACEHOLDER).val(row?.tags || '');
        const $hint = $('<small class="rt-races-row-desc"></small>');
        const updateHint = () => $hint.text(findPart(need().getSettings(), String($sel.val()))?.description || '');
        $sel.on('change', updateHint);
        updateHint();
        const $remove = iconButton('fa-xmark', 'Remove part').on('click', () => $row.remove());
        $row.append($('<div class="rt-races-gp-line"></div>').append($sel, $remove), $tags, $hint);
        $rows.append($row);
    };
    const set = (rows) => {
        $rows.empty();
        (rows || []).forEach(addRow);
    };
    set(initial);
    const $add = textButton('fa-plus', 'Add general part').on('click', () => addRow());
    $el.append($rows, $add);
    const read = () => $rows.children().toArray().map((row) => ({
        partId: String($(row).find('select').val()),
        tags: normalizeTags(String($(row).find('textarea').val())),
    }));
    return { $el, read, set };
}

/** Create any `newPart` entries from an AI reply and return plain { partId, tags } rows. */
function materializeParts(s, rows) {
    return rows.map((row) => {
        if (row.partId) return row;
        const { part } = createPart(s, { ...row.newPart, createdBy: 'ai' });
        const { newPart, ...rest } = row;
        return { ...rest, partId: part.id };
    });
}

/**
 * Race editor popup. Also used to review an AI-proposed race.
 * @param {{ id?: string, name: string, description: string, generalParts: { partId: string, tags: string }[] }} draft
 * @param {{ title?: string, okButton?: string }} [opts]
 * @returns {Promise<{ name: string, description: string, generalParts: { partId: string, tags: string }[] } | null>}
 */
async function raceEditorPopup(draft, opts = {}) {
    const $content = $('<div class="rt-races-editor"></div>');
    $content.append($('<h3></h3>').text(opts.title || (draft.id ? `Edit race "${draft.name}"` : 'New race')));
    const $name = $('<input class="text_pole" type="text" placeholder="One word if possible, e.g. Oni" />').val(draft.name || '');
    const $desc = $('<textarea class="text_pole textarea_compact" rows="3" placeholder="One paragraph on what members of this race commonly look like."></textarea>').val(draft.description || '');
    const table = generalPartsTable(draft.generalParts || []);
    const $ai = textButton('fa-wand-magic-sparkles', 'Suggest general parts with AI').on('click', async () => {
        const name = String($name.val()).trim();
        const description = String($desc.val()).trim();
        if (!name || !description) return toastr['warning']('Fill in the name and description first.', TITLE);
        $ai.addClass('disabled');
        try {
            const s = need().getSettings();
            const { parts } = await generateRaceParts({ request: need().request, race: { name, description }, parts: raceAssignableParts(s) });
            table.set(materializeParts(s, parts));
            save();
        } catch (err) {
            console.error('[RPG Tracker] Race part suggestion failed', err);
            toastr['error'](`Couldn't suggest parts: ${err.message || err}`, TITLE);
        } finally {
            $ai.removeClass('disabled');
        }
    });
    $content.append(
        '<label>Name</label>', $name,
        '<label>Description (visual, shared by all members)</label>', $desc,
        '<label>General parts and their tags</label>', table.$el, $ai,
        $('<small></small>').text(EMPHASIS_HINT),
    );
    if (!(await showPopup($content, { okButton: opts.okButton || 'Save', cancelButton: 'Cancel', large: true }))) return null;
    const name = String($name.val()).trim();
    if (!name) {
        toastr['warning']('A race needs a name.', TITLE);
        return null;
    }
    return { name, description: String($desc.val()).trim(), generalParts: table.read() };
}

async function editRace(race = null) {
    const s = need().getSettings();
    const result = await raceEditorPopup(race ? JSON.parse(JSON.stringify(race)) : { name: '', description: '', generalParts: [] });
    if (!result) return;
    try {
        if (race) updateRace(s, race.id, result);
        else createRace(s, { ...result, originChatId: need().getActiveChatId() });
        save();
    } catch (err) {
        toastr['warning'](String(err.message || err), TITLE);
    }
}

async function confirmDeleteRace(race) {
    const s = need().getSettings();
    const users = raceUsage(s, race.id);
    const body = users.length
        ? `${users.length} character(s) use it (${users.slice(0, 5).map(u => u.name).join(', ')}${users.length > 5 ? '…' : ''}). They will be unassigned and get a race again at their next portrait.`
        : 'No characters use it.';
    if (!(await confirmPopup(`Delete race "${race.name}"?`, body))) return;
    deleteRace(s, race.id);
    save();
}

let lastRacePrompt = '';

/** Remove parts created since `before` that no race or character uses. */
function dropUnusedNewParts(s, before) {
    for (const p of sortedParts(s)) {
        if (before.has(p.id)) continue;
        const usage = partUsage(s, p.id);
        if (!usage.races.length && !usage.characters) deletePart(s, p.id);
    }
}

/** Race Creator "Generate from prompt": the AI drafts a whole race, the user reviews it. */
async function createRaceFromPrompt() {
    const $content = $('<div class="rt-races-editor"></div>');
    $content.append('<h3>Generate race from prompt</h3>');
    $content.append('<small>Describe the race or give the AI instructions. It writes the name and description, picks existing parts (or adds missing ones) and tags them. You can edit everything before it is saved.</small>');
    const $prompt = $('<textarea class="text_pole textarea_compact" rows="5"></textarea>')
        .attr('placeholder', 'e.g. Small fox people from snowy forests, with white fur, big fluffy tails and black-tipped ears. Make the tail the most important feature.')
        .val(lastRacePrompt);
    $content.append('<label>Description or instructions</label>', $prompt);
    if (!(await showPopup($content, { okButton: 'Generate', cancelButton: 'Cancel' }))) return;
    const prompt = String($prompt.val()).trim();
    lastRacePrompt = prompt;
    if (!prompt) return toastr['warning']('Describe the race first.', TITLE);

    const s = need().getSettings();
    const $toast = toastr['info']('Generating race…', TITLE, { timeOut: 0, extendedTimeOut: 0 });
    let draft;
    try {
        draft = await generateRaceFromPrompt({ request: need().request, prompt, races: getRaces(s), parts: raceAssignableParts(s) });
    } catch (err) {
        console.error('[RPG Tracker] Race generation failed', err);
        return toastr['error'](`Couldn't generate the race: ${err.message || err}`, TITLE);
    } finally {
        toastr.clear($toast);
    }

    const newParts = draft.generalParts.filter(gp => !gp.partId).map(gp => gp.newPart.name);
    // New parts must exist for the table's dropdowns; unused ones are removed again on cancel.
    const before = new Set(sortedParts(s).map(p => p.id));
    let current = { ...draft, generalParts: materializeParts(s, draft.generalParts) };
    for (;;) {
        const clash = findSimilarByName(getRaces(s), current.name)?.exact;
        const notes = [
            newParts.length ? `new parts: ${newParts.join(', ')}` : '',
            clash ? `a race named "${current.name}" already exists, rename it` : '',
        ].filter(Boolean);
        const result = await raceEditorPopup(current, {
            title: `New race from prompt${notes.length ? ` (${notes.join('; ')})` : ''}`,
            okButton: 'Create race',
        });
        if (!result) {
            dropUnusedNewParts(s, before);
            save();
            return;
        }
        try {
            const race = createRace(s, { ...result, createdBy: 'ai', originChatId: need().getActiveChatId() });
            dropUnusedNewParts(s, before);
            save();
            lastRacePrompt = '';
            toastr['success'](`Created race "${race.name}".`, TITLE);
            return;
        } catch (err) {
            // Name clash: reopen the editor with the user's edits so nothing is lost.
            toastr['warning'](String(err.message || err), TITLE);
            current = result;
        }
    }
}

/** Browse, add, edit, delete, import and export races. */
export async function openRaceCreator() {
    const $content = $('<div class="rt-races-manager"></div>');
    $content.append('<h3>Race Creator</h3>');
    $content.append('<small>Races are shared by all campaigns. Characters link to a race, so edits apply to every character of that race.</small>');
    const $filter = $('<select class="text_pole rt-races-filter"><option value="all">All races</option><option value="user">Created by me</option><option value="ai">Created by AI</option><option value="chat">Created in this campaign</option></select>');
    const $list = $('<div class="rt-races-list"></div>');

    const render = () => {
        const s = need().getSettings();
        const filter = String($filter.val());
        const chatId = need().getActiveChatId();
        const races = getRaces(s)
            .filter(r => filter === 'all' || (filter === 'chat' ? r.originChatId === chatId : r.createdBy === filter))
            .slice().sort((a, b) => a.name.localeCompare(b.name));
        $list.empty();
        if (!races.length) $list.append('<small class="rt-races-empty">No races yet. Create one, or let the AI create them when portraits are generated in tag mode.</small>');
        for (const race of races) {
            const $row = $('<div class="rt-races-row"></div>');
            const $head = $('<div class="rt-races-row-header"></div>');
            $head.append($('<b class="rt-races-row-name"></b>').text(race.name));
            if (race.createdBy === 'ai') $head.append('<small class="rt-races-chip">AI</small>');
            const users = raceUsage(s, race.id).length;
            if (users) $head.append($('<small class="rt-races-chip"></small>').text(`${users} character${users === 1 ? '' : 's'}`));
            const $actions = $('<div class="rt-races-row-actions"></div>').append(
                iconButton('fa-pencil', 'Edit').on('click', async () => { await editRace(race); render(); }),
                iconButton('fa-file-export', 'Export').on('click', () => downloadJson(`${race.id}.mraces.json`, buildRacePack(s, [race.id]))),
                iconButton('fa-trash-can', 'Delete').addClass('redWarningBG').on('click', async () => { await confirmDeleteRace(race); render(); }),
            );
            $head.append($actions);
            const tagSummary = (race.generalParts || [])
                .map(gp => `${findPart(s, gp.partId)?.name || gp.partId}: ${gp.tags || '—'}`)
                .join(' · ');
            $row.append($head, $('<small class="rt-races-row-desc"></small>').text(race.description || ''), $('<small class="rt-races-row-tags"></small>').text(tagSummary));
            $list.append($row);
        }
    };
    $filter.on('change', render);

    const $buttons = $('<div class="flex-container"></div>').append(
        textButton('fa-plus', 'New race').on('click', async () => { await editRace(); render(); }),
        textButton('fa-wand-magic-sparkles', 'Generate from prompt').on('click', async () => { await createRaceFromPrompt(); render(); }),
        textButton('fa-file-import', 'Import').on('click', async () => {
            const text = await pickJsonFile();
            if (!text) return;
            try {
                const r = importRacePack(need().getSettings(), JSON.parse(text));
                save();
                toastr['success'](`Imported ${r.racesAdded} new race(s), updated ${r.racesUpdated}, added ${r.partsAdded} part(s).`, TITLE);
                render();
            } catch (err) {
                toastr['error'](`Import failed: ${err.message || err}`, TITLE);
            }
        }),
        textButton('fa-file-export', 'Export all').on('click', () => downloadJson('races.mraces.json', buildRacePack(need().getSettings()))),
        textButton('fa-puzzle-piece', 'Part Creator').on('click', async () => { await openPartCreator(); render(); }),
    );
    $content.append($filter, $list, $buttons);
    render();
    await showPopup($content, { okButton: 'Close', cancelButton: false, large: true });
}

// ── AI review popups (called from the appearance pipeline) ───────────────────

/**
 * Let the user edit or reject a race the AI wants to create.
 * `draft.generalParts` may contain `{ newPart, tags }` rows; new parts are created only on accept.
 * @returns {Promise<{ name: string, description: string, generalParts: { partId: string, tags: string }[] } | null>}
 */
export async function reviewAiRace(draft, characterName) {
    const s = need().getSettings();
    const newParts = draft.generalParts.filter(gp => !gp.partId).map(gp => gp.newPart.name);
    // New parts must exist for the table's dropdowns; remove them again on reject.
    const before = new Set(sortedParts(s).map(p => p.id));
    const rows = materializeParts(s, draft.generalParts);
    const result = await raceEditorPopup({ ...draft, generalParts: rows }, {
        title: `New race for ${characterName}${newParts.length ? ` (new parts: ${newParts.join(', ')})` : ''}`,
        okButton: 'Create race',
    });
    if (!result) {
        for (const p of sortedParts(s)) if (!before.has(p.id)) deletePart(s, p.id);
    }
    return result;
}

/**
 * Character appearance rows editor (subject, race, parts with mode).
 * @returns {{ $el: JQuery, read: () => { raceId: string|null, subjectTags: string, parts: any[] } }}
 */
function appearanceForm(record) {
    const s = need().getSettings();
    const $el = $('<div class="rt-races-appearance"></div>');
    const $race = $('<select class="text_pole"></select>').append('<option value="">(no race)</option>');
    for (const r of getRaces(s).slice().sort((a, b) => a.name.localeCompare(b.name))) $race.append($('<option></option>').val(r.id).text(r.name));
    $race.val(record?.raceId || '');
    const $subject = $('<input class="text_pole" type="text" placeholder="1girl / 1boy / 1other" />').val(record?.subjectTags || '');
    const $raceTags = $('<small class="rt-races-row-tags"></small>');
    const showRaceTags = () => {
        const groups = characterPartGroups(s, { raceId: String($race.val()) || null, parts: [] });
        $raceTags.text(groups.length ? `Race tags: ${groups.map(g => `${g.name}: ${g.tags.join(', ')}`).join(' · ')}` : 'Race tags: none');
    };
    $race.on('change', showRaceTags);
    showRaceTags();

    const $rows = $('<div class="rt-races-gp-rows"></div>');
    const addRow = (row = null) => {
        const parts = raceAssignableParts(s);
        const $row = $('<div class="rt-races-gp-row"></div>');
        const $sel = partSelect(parts, row?.partId || parts[0]?.id);
        const $mode = $('<select class="text_pole rt-races-mode"><option value="add">Add to race tags</option><option value="replace">Replace race tags</option></select>').val(row?.mode || 'add');
        const $tags = $('<textarea class="text_pole textarea_compact" rows="1"></textarea>').attr('placeholder', TAG_PLACEHOLDER).val(row?.tags || '');
        const $remove = iconButton('fa-xmark', 'Remove part').on('click', () => $row.remove());
        $row.append($('<div class="rt-races-gp-line"></div>').append($sel, $mode, $remove), $tags);
        $rows.append($row);
    };
    (record?.parts || []).forEach(addRow);
    $el.append(
        '<label>Race</label>', $race, $raceTags,
        '<label>Subject tags</label>', $subject,
        '<label>Character-specific parts</label>', $rows,
        textButton('fa-plus', 'Add part').on('click', () => addRow()),
        $('<small></small>').text(EMPHASIS_HINT),
    );
    const read = () => ({
        raceId: String($race.val()) || null,
        noRace: !String($race.val()),
        subjectTags: normalizeTags(String($subject.val())),
        parts: $rows.children().toArray().map(row => ({
            partId: String($(row).find('.rt-races-part-select').val()),
            mode: String($(row).find('.rt-races-mode').val()),
            tags: normalizeTags(String($(row).find('textarea').val())),
        })),
    });
    return { $el, read };
}

/**
 * Review AI-generated character tags before they are saved.
 * @returns {Promise<{ raceId: string|null, subjectTags: string, parts: any[] } | null>}
 */
export async function reviewCharacterAppearance(draft, characterName) {
    const $content = $('<div class="rt-races-editor"></div>').append($('<h3></h3>').text(`Review appearance tags for ${characterName}`));
    const form = appearanceForm(draft);
    $content.append(form.$el);
    if (!(await showPopup($content, { okButton: 'Apply', cancelButton: 'Use as is', large: true }))) return draft;
    return form.read();
}

/**
 * Edit a character's race and parts by hand (from the portrait menu).
 * @param {string} name
 * @param {{ recheck?: (name: string) => Promise<void> }} [opts]
 */
export async function openCharacterAppearanceEditor(name, opts = {}) {
    const s = need().getSettings();
    const chatId = need().getActiveChatId();
    if (!chatId) return toastr['warning']('Open a chat first.', TITLE);
    const found = getCharacterAppearance(s, chatId, name);
    const record = found?.record || { raceId: null, subjectTags: '', parts: [] };
    const $content = $('<div class="rt-races-editor"></div>').append($('<h3></h3>').text(`Race & Parts — ${found?.record?.name || name}`));
    if (found && isAppearanceRaceStale(s, record)) {
        $content.append('<div class="rt-races-stale"><i class="fa-solid fa-triangle-exclamation"></i> The race was edited after these tags were written. Check that they still fit.</div>');
    }
    if (!found) $content.append('<small>No race assigned yet. Pick one here, or it will be assigned by the AI at the next portrait (tag mode).</small>');
    const form = appearanceForm(record);
    const $preview = $('<div class="rt-races-preview"></div>');
    const updatePreview = () => {
        const draft = form.read();
        $preview.text(assembleTagPrompt(s, draft, { style: s.portraitTagEmphasisStyle || 'novelai' }).prompt || '(empty)');
    };
    form.$el.on('input change', updatePreview);
    form.$el.on('click', '.menu_button', () => setTimeout(updatePreview, 0));
    updatePreview();
    $content.append(form.$el, '<label>Body tags preview (equipment and state are added per image)</label>', $preview);
    if (typeof opts.recheck === 'function' && found) {
        $content.append(textButton('fa-rotate', 'Re-check tags with AI').on('click', async (e) => {
            $(e.currentTarget).addClass('disabled');
            try {
                await opts.recheck(name);
                toastr['success']('Tags re-checked. Reopen this editor to see them.', TITLE);
            } catch (err) {
                toastr['error'](`Re-check failed: ${err.message || err}`, TITLE);
            } finally {
                $(e.currentTarget).removeClass('disabled');
            }
        }));
    }
    if (!(await showPopup($content, { okButton: 'Save', cancelButton: 'Cancel', large: true }))) return;
    setCharacterAppearance(s, chatId, found?.record?.name || name, form.read());
    save();
    need().refresh?.();
}

// ── Settings panel + wand menu ───────────────────────────────────────────────

/**
 * Bind the "Image prompt style" controls in the Portraits settings drawer.
 * @param {any} settings
 */
export function bindRaceSettingsUI(settings) {
    const applyModeUI = () => $('#rpg_tag_prompt_group').toggle(settings.portraitPromptMode === 'tags');
    $('#rpg_portrait_prompt_mode').val(settings.portraitPromptMode || 'prose').off('change.rtRaces').on('change.rtRaces', function () {
        settings.portraitPromptMode = String($(this).val()) === 'tags' ? 'tags' : 'prose';
        applyModeUI();
        save();
    });
    $('#rpg_tag_emphasis_style').val(settings.portraitTagEmphasisStyle || 'novelai').off('change.rtRaces').on('change.rtRaces', function () {
        settings.portraitTagEmphasisStyle = String($(this).val());
        save();
    });
    $('#rpg_tag_prompt_prefix').val(settings.portraitTagPrefix ?? '').off('input.rtRaces').on('input.rtRaces', function () {
        settings.portraitTagPrefix = String($(this).val());
        save();
    });
    $('#rpg_tag_prompt_suffix').val(settings.portraitTagSuffix ?? '').off('input.rtRaces').on('input.rtRaces', function () {
        settings.portraitTagSuffix = String($(this).val());
        save();
    });
    $('#rpg_race_creation_mode').val(settings.raceCreationMode || 'ask').off('change.rtRaces').on('change.rtRaces', function () {
        settings.raceCreationMode = String($(this).val());
        save();
    });
    $('#rpg_race_review_character_tags').prop('checked', !!settings.raceReviewCharacterTags).off('change.rtRaces').on('change.rtRaces', function () {
        settings.raceReviewCharacterTags = !!$(this).prop('checked');
        save();
    });
    $(document).off('click.rtRaces').on('click.rtRaces', '#rpg_open_part_creator', (e) => {
        e.preventDefault();
        openPartCreator();
    }).on('click.rtRaces', '#rpg_open_race_creator', (e) => {
        e.preventDefault();
        openRaceCreator();
    });
    applyModeUI();
}

/** Re-sync the settings controls after a profile load or chat switch. */
export function syncRaceSettingsUI(settings) {
    $('#rpg_portrait_prompt_mode').val(settings.portraitPromptMode || 'prose');
    $('#rpg_tag_prompt_group').toggle(settings.portraitPromptMode === 'tags');
    $('#rpg_tag_emphasis_style').val(settings.portraitTagEmphasisStyle || 'novelai');
    $('#rpg_tag_prompt_prefix').val(settings.portraitTagPrefix ?? '');
    $('#rpg_tag_prompt_suffix').val(settings.portraitTagSuffix ?? '');
    $('#rpg_race_creation_mode').val(settings.raceCreationMode || 'ask');
    $('#rpg_race_review_character_tags').prop('checked', !!settings.raceReviewCharacterTags);
}

/** Add Part Creator / Race Creator to SillyTavern's wand menu. */
export function addRaceWandButtons() {
    const wand = document.getElementById('extensionsMenu');
    if (!wand || document.getElementById('rpg_races_wand_container')) return;
    const $container = $('<div id="rpg_races_wand_container" class="extension_container"></div>');
    const item = (icon, label, onClick) => $(`<div class="list-group-item flex-container flexGap5"><div class="fa-solid ${icon} extensionsMenuExtensionButton"></div><span></span></div>`)
        .find('span').text(label).end()
        .on('click', onClick);
    $container.append(
        item('fa-dragon', 'Multihog Race Creator', () => openRaceCreator()),
        item('fa-puzzle-piece', 'Multihog Part Creator', () => openPartCreator()),
    );
    $(wand).append($container);
}

