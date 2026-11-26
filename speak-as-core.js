// Speak As core: send user messages as another persona (an NPC) while the main persona stays selected,
// so {{user}} keeps meaning the main persona. Also keeps a per-chat NPC list ("cast").
// This file is shared: when several extensions ship it, only the first one installs the handlers,
// the others reuse globalThis.SpeakAsPersona.

const CORE_VERSION = 6;
const SETTINGS_KEY = 'speakAsPersona'; // extensionSettings: { favs }
const STATE_KEY = 'psa_speaking';       // chatMetadata: persona id the user is speaking as
const CAST_KEY = 'psa_cast';            // chatMetadata: persona ids that appear in this chat
const NOINJECT_KEY = 'psa_noinject';    // chatMetadata: NPC ids whose description is not sent to the AI
const PROMPT_KEY = 'psa_npc_personas';  // extension prompt slot
const NOTE_PROMPT_KEY = 'psa_main_note'; // extension prompt slot for the main persona's per-chat note
const NOTES_KEY = 'psa_notes';           // chatMetadata: { [personaId or MAIN_NOTE]: text } only in this chat
const NOTES_EN_KEY = 'psa_notes_en';     // chatMetadata: { [key]: { src, en } } English copy of a Korean note
const MAIN_NOTE = '@main';
const MARK_KEY = 'psa_persona';         // message.extra: persona id the message was sent as
const ORIG_KEY = 'psa_original';        // message.extra: { name, force_avatar } before the first change

let personasMod = null;

function ctx() {
    return SillyTavern.getContext();
}

function mainId() {
    return personasMod?.user_avatar || '';
}

function personaNames() {
    return ctx().powerUserSettings?.personas ?? {};
}

function nameOf(id) {
    const n = personaNames()[id];
    return n ? String(n) : '';
}

function avatarOf(id) {
    return ctx().getThumbnailUrl('persona', id);
}

function hasChat() {
    return !!ctx().getCurrentChatId?.();
}

function make(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
}

function icon(cls) {
    return make('i', { class: `fa-fw fa-solid ${cls}` });
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

/** Full-screen layer sized in viewport units (ST makes <html> 0px tall on phones). */
function openLayer(extraClass = '') {
    const overlay = make('div', { class: 'psa_overlay ' + extraClass, 'data-bl-native-ext-colors': '' });
    const panel = make('div', { class: 'psa_panel', role: 'dialog' });
    overlay.append(panel);
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    };
    function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
    }
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    // keep clicks inside from reaching outside-tap handlers of other panels
    overlay.addEventListener('click', (e) => e.stopPropagation());
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    return { overlay, panel, close };
}

function headRow(title, close, leading = null) {
    const closeBtn = make('div', { class: 'psa_close', tabindex: '0', title: '닫기' }, [icon('fa-xmark')]);
    closeBtn.addEventListener('click', close);
    const children = [];
    if (leading) children.push(leading);
    children.push(make('span', { class: 'psa_title', text: title }), closeBtn);
    return make('div', { class: 'psa_head' }, children);
}

function createCore() {
    const listeners = new Set();

    const onChangeLocal = (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
    };

    const emitChange = () => {
        for (const fn of listeners) {
            try { fn(); } catch (error) { console.error('[SpeakAs] listener failed', error); }
        }
    };

    // ---- speaking-as state

    /** Persona id the user is speaking as in this chat, or '' when speaking as the main persona. */
    function get() {
        if (!hasChat()) return '';
        const id = ctx().chatMetadata?.[STATE_KEY];
        if (!id || !nameOf(id) || id === mainId()) return '';
        return id;
    }

    function set(id) {
        const c = ctx();
        if (!hasChat()) {
            toastr.info('채팅을 먼저 열어 주세요.');
            return false;
        }
        if (id && (!nameOf(id) || id === mainId())) id = '';
        if (id) c.chatMetadata[STATE_KEY] = id;
        else delete c.chatMetadata[STATE_KEY];
        c.saveMetadataDebounced?.();
        updatePrompt();
        emitChange();
        return true;
    }

    function toggleSpeak(id, quiet = false) {
        const on = get() === id;
        if (!set(on ? '' : id)) return;
        if (!quiet) toastr.info(on ? 'NPC로 말하기를 껐어요.' : `이제 ${nameOf(id)}(으)로 말해요. 메인 페르소나는 그대로예요.`);
    }

    // ---- per-chat NPC list (cast)

    function cast() {
        if (!hasChat()) return [];
        const list = ctx().chatMetadata?.[CAST_KEY];
        return Array.isArray(list) ? list.filter(id => nameOf(id) && id !== mainId()) : [];
    }

    function setCast(ids) {
        const c = ctx();
        if (!hasChat()) return false;
        const clean = [...new Set(ids)].filter(id => nameOf(id));
        if (clean.length) c.chatMetadata[CAST_KEY] = clean;
        else delete c.chatMetadata[CAST_KEY];
        c.saveMetadataDebounced?.();
        updatePrompt();
        emitChange();
        return true;
    }

    function isCast(id) {
        return cast().includes(id);
    }

    function toggleCast(id) {
        if (!hasChat()) {
            toastr.info('채팅을 먼저 열어 주세요.');
            return;
        }
        if (id === mainId()) {
            toastr.info('메인 페르소나는 이미 이 채팅에 있어요.');
            return;
        }
        const list = cast();
        if (list.includes(id)) {
            // taking someone out of the list also stops speaking as them
            if (get() === id) set('');
            setCast(list.filter(x => x !== id));
        } else {
            setCast([...list, id]);
        }
    }

    // ---- making a persona the main one

    function lockState(type) {
        try { return !!personasMod?.isPersonaLocked?.(type); } catch { return false; }
    }

    /**
     * Makes id the main persona of this chat. The old main persona moves into the NPC list,
     * and the chat / character locks move along so the switch sticks.
     */
    async function makeMain(id) {
        const c = ctx();
        const old = mainId();
        if (!nameOf(id) || id === old) return false;
        const command = c.SlashCommandParser?.commands?.['persona-set'] ?? c.SlashCommandParser?.commands?.['persona'];
        if (!command) {
            toastr.warning('페르소나 전환 명령을 찾지 못했어요.');
            return false;
        }
        const chatLocked = lockState('chat');
        const charLocked = lockState('character');
        try {
            await command.callback({ mode: 'lookup' }, id);
        } catch (error) {
            console.error('[SpeakAs] persona switch failed', error);
            toastr.error('메인 페르소나를 바꾸지 못했어요.');
            return false;
        }
        if (mainId() !== id) {
            toastr.warning('메인 페르소나가 바뀌지 않았어요.');
            return false;
        }
        const toggle = personasMod?.togglePersonaLock;
        try {
            if (typeof toggle === 'function') {
                if (chatLocked && !lockState('chat')) await toggle('chat');
                if (charLocked && c.characterId !== undefined && !lockState('character')) await toggle('character');
            }
        } catch (error) {
            console.error('[SpeakAs] lock follow failed', error);
        }
        if (hasChat()) {
            const list = cast().filter(x => x !== id);
            if (old && nameOf(old)) list.unshift(old);
            setCast(list);
            if (get() === id) set('');
        }
        toastr.info(`${nameOf(id)}을(를) 메인으로 했어요.` + (old && nameOf(old) ? ` ${nameOf(old)}은(는) 이 채팅 NPC 목록으로 옮겼어요.` : ''));
        emitChange();
        return true;
    }

    // ---- messages

    function messageEl(messageId) {
        return document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    }

    function patchDom(messageId, message) {
        const mes = messageEl(messageId);
        if (!mes) return;
        mes.setAttribute('ch_name', message.name);
        mes.setAttribute('force_avatar', String(!!message.force_avatar));
        const nameText = mes.querySelector('.name_text');
        if (nameText) nameText.textContent = message.name;
        const img = mes.querySelector('.avatar img');
        if (img && message.force_avatar) img.src = message.force_avatar;
    }

    /**
     * Changes who a user message was spoken by.
     * id = persona id to speak as, or '' to put the message back the way it was sent.
     */
    function applyTo(messageId, id) {
        const c = ctx();
        const message = c.chat?.[messageId];
        if (!message || !message.is_user) return false;
        message.extra ??= {};
        if (id && nameOf(id)) {
            if (!message.extra[ORIG_KEY]) {
                message.extra[ORIG_KEY] = { name: message.name, force_avatar: message.force_avatar ?? null };
            }
            message.name = nameOf(id);
            message.force_avatar = avatarOf(id);
            message.extra[MARK_KEY] = id;
        } else {
            const orig = message.extra[ORIG_KEY];
            if (orig) {
                message.name = orig.name;
                if (orig.force_avatar) message.force_avatar = orig.force_avatar;
                else delete message.force_avatar;
            }
            delete message.extra[ORIG_KEY];
            delete message.extra[MARK_KEY];
        }
        patchDom(messageId, message);
        return true;
    }

    /** Ids of personas that speak somewhere in this chat (sent messages + the current choice). */
    function usedIds() {
        const ids = new Set();
        for (const m of ctx().chat ?? []) {
            const id = m?.is_user ? m.extra?.[MARK_KEY] : null;
            if (id) ids.add(id);
        }
        const now = get();
        if (now) ids.add(now);
        return [...ids].filter(id => nameOf(id) && id !== mainId());
    }

    // ---- which NPC descriptions go to the AI

    /** 'always': this chat's NPCs and anyone spoken as, every turn. 'speaking': only the NPC being spoken as. */
    function injectMode() {
        return store().injectMode === 'speaking' ? 'speaking' : 'always';
    }

    function setInjectMode(mode) {
        store().injectMode = mode === 'speaking' ? 'speaking' : 'always';
        ctx().saveSettingsDebounced?.();
        updatePrompt();
        emitChange();
    }

    function noInject() {
        const list = hasChat() ? ctx().chatMetadata?.[NOINJECT_KEY] : null;
        return Array.isArray(list) ? list : [];
    }

    /** Whether this NPC's description may be sent at all (per chat; everyone is on by default). */
    function isInjected(id) {
        return !noInject().includes(id);
    }

    function toggleInject(id) {
        const c = ctx();
        if (!hasChat()) return;
        const list = noInject();
        const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
        if (next.length) c.chatMetadata[NOINJECT_KEY] = next;
        else delete c.chatMetadata[NOINJECT_KEY];
        c.saveMetadataDebounced?.();
        updatePrompt();
        emitChange();
    }

    /** NPCs whose descriptions go into the prompt right now. */
    function injectedIds() {
        const pool = injectMode() === 'speaking'
            ? [get()].filter(Boolean)
            : [...new Set([...cast(), ...usedIds()])];
        return pool.filter(id => isInjected(id));
    }

    /** Settings block for "send NPC descriptions to the AI", used by every host's settings screen. */
    function buildInjectSettings() {
        const box = make('div', { class: 'psa_inject_box', 'data-bl-native-ext-colors': '' });
        const draw = () => {
            box.replaceChildren();
            box.append(make('div', { class: 'psa_set_title' }, [icon('fa-paper-plane'), make('span', { text: 'AI에게 NPC 설명 보내기' })]));
            const chips = make('div', { class: 'psa_chips' });
            for (const [key, label] of [['always', '상시'], ['speaking', '말하는 중일 때만']]) {
                const chip = make('div', { class: 'psa_tab' + (injectMode() === key ? ' psa_on' : ''), tabindex: '0' }, [make('span', { text: label })]);
                chip.addEventListener('click', () => {
                    setInjectMode(key);
                    draw();
                });
                chips.append(chip);
            }
            box.append(chips, make('small', { class: 'psa_set_note', text: '상시: 이 채팅 NPC와 NPC로 말한 페르소나의 설명이 매번 들어가요. 말하는 중일 때만: 지금 그 NPC로 말하고 있을 때 그 NPC 설명만 들어가요.' }));

            const people = hasChat() ? [...new Set([...cast(), ...usedIds()])] : [];
            box.append(make('div', { class: 'psa_set_sub', text: '이 채팅에서 설명을 보낼 NPC' }));
            if (!hasChat()) {
                box.append(make('small', { class: 'psa_set_note', text: '채팅을 열면 NPC별로 고를 수 있어요.' }));
                return;
            }
            if (!people.length) {
                box.append(make('small', { class: 'psa_set_note', text: '아직 이 채팅 NPC가 없어요.' }));
                return;
            }
            const list = make('div', { class: 'psa_inject_list' });
            for (const id of people) {
                const check = make('input', { type: 'checkbox' });
                check.checked = isInjected(id);
                check.addEventListener('change', () => toggleInject(id));
                list.append(make('label', { class: 'psa_check psa_inject_row' }, [
                    check,
                    make('img', { class: 'psa_img psa_img_small', alt: '', src: avatarOf(id), draggable: 'false' }),
                    make('span', { class: 'psa_name', text: nameOf(id) }),
                ]));
            }
            box.append(list, make('small', { class: 'psa_set_note', text: '체크를 끈 NPC는 설명이 안 들어가요. 그 NPC로 말한 메시지의 이름은 그대로 보내져요.' }));
        };
        draw();
        return box;
    }

    /** Describes the NPC list and anyone spoken as to the model (model-facing text is English). */
    function updatePrompt() {
        const c = ctx();
        if (typeof c.setExtensionPrompt !== 'function') return;
        const ids = hasChat() ? injectedIds() : [];
        let text = '';
        if (ids.length) {
            const descriptions = c.powerUserSettings?.persona_descriptions ?? {};
            const blocks = ids.map(id => {
                const name = nameOf(id);
                // {{user}} inside this persona's own description refers to this persona
                const desc = String(descriptions[id]?.description ?? '').replace(/\{\{user\}\}/gi, name).trim();
                const note = noteForPrompt(id).replace(/\{\{user\}\}/gi, name).trim();
                return `[${name}]\n${desc || '(no description)'}` + (note ? `\n(Current details in this chat: ${note})` : '');
            });
            text = 'In addition to {{user}}, the following characters are also on the user\'s side of this roleplay. '
                + 'Some user messages are spoken by them instead of {{user}}; those messages are labeled with the speaking character\'s name. '
                + '{{user}} still refers to the main user character.\n\n'
                + blocks.join('\n\n');
        }
        // position 0 = in prompt, depth 0, no WI scan, system role
        c.setExtensionPrompt(PROMPT_KEY, text, 0, 0, false, 0);
        updateNotePrompt();
    }

    function messageIdFrom(arg) {
        const n = Number(arg);
        if (Number.isInteger(n) && n >= 0) return n;
        return (ctx().chat?.length ?? 0) - 1;
    }

    function onMessageSent(arg) {
        const id = get();
        if (!id) return;
        const messageId = messageIdFrom(arg);
        const message = ctx().chat?.[messageId];
        if (!message?.is_user || message.extra?.[MARK_KEY]) return;
        applyTo(messageId, id);
        updatePrompt();
    }

    function onMessageRendered(arg) {
        const messageId = messageIdFrom(arg);
        const message = ctx().chat?.[messageId];
        if (message?.is_user && message.extra?.[MARK_KEY]) patchDom(messageId, message);
    }

    // ---- translation (persona descriptions and per-chat notes)
    // The English text stays the source of truth: only lines that contain Korean are ever translated
    // into English, so English that is already written is never re-translated.

    const HANGUL = /[ㄱ-ㆎ가-힣]/;

    function hasHangul(text) {
        return HANGUL.test(String(text ?? ''));
    }

    function translateProfile() {
        return String(store().translateProfileId || '');
    }

    function setTranslateProfile(id) {
        store().translateProfileId = String(id || '');
        ctx().saveSettingsDebounced?.();
        translateNotesSoon();
    }

    function translateProfiles() {
        try { return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { return []; }
    }

    /** Translates a list of strings with the chosen connection profile. Returns the same number of strings. */
    async function translateList(items, toLanguage) {
        const c = ctx();
        const profileId = translateProfile();
        if (!profileId || !c.ConnectionManagerRequestService) throw new Error('NO_PROFILE');
        const system = 'You are a translator for roleplay character sheets. You translate faithfully and naturally, keeping tone, nuance and formatting.';
        const user = `Translate each item of the JSON array below into ${toLanguage}.
Rules:
- Keep macros such as {{user}} and {{char}}, names, markdown and line breaks exactly as they are.
- Do not add, drop, explain or merge anything.
- Reply with a JSON array of strings only, with exactly ${items.length} item(s), in the same order.

${JSON.stringify(items)}`;
        const res = await c.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            Math.min(8000, 400 + items.join('').length * 3),
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
        );
        const raw = String(typeof res === 'string' ? res : (res?.content ?? '')).replace(/```(?:json)?/gi, '').trim();
        const match = raw.match(/\[[\s\S]*\]/);
        let out = null;
        try { out = JSON.parse(match ? match[0] : raw); } catch { /* handled below */ }
        if (!Array.isArray(out) || out.length !== items.length) throw new Error('BAD_REPLY');
        return out.map(x => String(x ?? ''));
    }

    /** Replaces only the lines that contain Korean with their English translation. */
    async function koreanLinesToEnglish(text) {
        const lines = String(text ?? '').split('\n');
        const idx = lines.map((l, i) => (hasHangul(l) ? i : -1)).filter(i => i >= 0);
        if (!idx.length) return text;
        const done = await translateList(idx.map(i => lines[i]), 'English');
        idx.forEach((lineNo, k) => { lines[lineNo] = done[k]; });
        return lines.join('\n');
    }

    /** Korean reading view of an English text (cached until the English changes). */
    async function readingTranslation(cacheId, english) {
        const s = store();
        s.translateCache ??= {};
        if (s.translateCache[cacheId]?.en === english) return s.translateCache[cacheId].ko;
        const lines = String(english ?? '').split('\n');
        const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0);
        const done = idx.length ? await translateList(idx.map(i => lines[i]), 'Korean') : [];
        idx.forEach((lineNo, k) => { lines[lineNo] = done[k]; });
        const ko = lines.join('\n');
        s.translateCache[cacheId] = { en: english, ko };
        ctx().saveSettingsDebounced?.();
        return ko;
    }

    function translateErrorText(error) {
        if (error?.message === 'NO_PROFILE') return '번역에 쓸 연결 프로필을 설정에서 먼저 골라 주세요.';
        if (error?.message === 'BAD_REPLY') return '번역 결과를 읽지 못했어요. 다시 시도해 주세요.';
        return '번역하지 못했어요.';
    }

    // ---- per-chat notes: '' = the main persona ({{user}}), otherwise an NPC's persona id

    function notes() {
        const list = hasChat() ? ctx().chatMetadata?.[NOTES_KEY] : null;
        return list && typeof list === 'object' ? list : {};
    }

    function noteOf(id = '') {
        return String(notes()[id || MAIN_NOTE] ?? '');
    }

    function setNote(id, text) {
        const c = ctx();
        if (!hasChat()) return false;
        const key = id || MAIN_NOTE;
        const all = { ...notes() };
        if (String(text ?? '').trim()) all[key] = String(text);
        else delete all[key];
        if (Object.keys(all).length) c.chatMetadata[NOTES_KEY] = all;
        else delete c.chatMetadata[NOTES_KEY];
        c.saveMetadataDebounced?.();
        updatePrompt();
        translateNotesSoon();
        return true;
    }

    /** The note as the AI should read it: the English copy when the note is written in Korean. */
    function noteForPrompt(id = '') {
        const note = noteOf(id).trim();
        if (!note || !hasHangul(note)) return note;
        const cached = ctx().chatMetadata?.[NOTES_EN_KEY]?.[id || MAIN_NOTE];
        return cached && cached.src === note ? String(cached.en || note) : note;
    }

    /** '' (nothing to say) | 'korean' (no profile, sent as is) | 'pending' | 'english' */
    function noteSendState(id = '') {
        const note = noteOf(id).trim();
        if (!note || !hasHangul(note)) return '';
        if (!translateProfile()) return 'korean';
        const cached = ctx().chatMetadata?.[NOTES_EN_KEY]?.[id || MAIN_NOTE];
        return cached && cached.src === note ? 'english' : 'pending';
    }

    /** Translates the Korean lines of every note that changed (once per change). */
    const translateNotesSoon = debounce(async () => {
        const c = ctx();
        if (!hasChat() || !translateProfile()) return;
        const chatId = c.getCurrentChatId();
        for (const [key, raw] of Object.entries(notes())) {
            const note = String(raw).trim();
            if (!note || !hasHangul(note)) continue;
            const cached = c.chatMetadata?.[NOTES_EN_KEY]?.[key];
            if (cached && cached.src === note) continue;
            try {
                const en = await koreanLinesToEnglish(note);
                const now = ctx();
                if (now.getCurrentChatId?.() !== chatId || String(notes()[key] ?? '').trim() !== note) continue; // changed meanwhile
                now.chatMetadata[NOTES_EN_KEY] = { ...(now.chatMetadata[NOTES_EN_KEY] ?? {}), [key]: { src: note, en } };
                now.saveMetadataDebounced?.();
                updatePrompt();
                emitChange();
            } catch (error) {
                console.warn('[SpeakAs] note translation failed', error);
                return;
            }
        }
    }, 2500);

    /** Prompt slot for the main persona's per-chat note (model-facing text is English). */
    function updateNotePrompt() {
        const c = ctx();
        if (typeof c.setExtensionPrompt !== 'function') return;
        const note = hasChat() ? noteForPrompt('') : '';
        const text = note ? `[Current details about {{user}} in this chat]\n${note}` : '';
        c.setExtensionPrompt(NOTE_PROMPT_KEY, text, 0, 0, false, 0);
    }

    /** Textarea with [EN | 한] reading view and a "Korean lines to English" button. */
    function translatableField(textarea, cacheId) {
        const wrap = make('div', { class: 'psa_trwrap' });
        const koView = make('div', { class: 'psa_desc psa_kov psa_hidden' });
        const segEn = make('span', { class: 'psa_seg_btn psa_on', text: 'EN' });
        const segKo = make('span', { class: 'psa_seg_btn', text: '한' });
        const seg = make('div', { class: 'psa_seg', title: '원문 / 한글로 읽기' }, [segEn, segKo]);
        const toEn = make('div', { class: 'psa_toen psa_hidden', tabindex: '0', title: '한글이 들어간 줄만 영어로 바꿔요. 영어 줄은 그대로예요.' }, [icon('fa-language'), make('span', { text: '한글 줄만 영어로' })]);
        const refreshToEn = () => toEn.classList.toggle('psa_hidden', !hasHangul(textarea.value) || !koView.classList.contains('psa_hidden'));
        textarea.addEventListener('input', refreshToEn);
        const showKo = async (on) => {
            segEn.classList.toggle('psa_on', !on);
            segKo.classList.toggle('psa_on', on);
            textarea.classList.toggle('psa_hidden', on);
            koView.classList.toggle('psa_hidden', !on);
            refreshToEn();
            if (!on) return;
            koView.replaceChildren(make('span', { class: 'psa_wait', text: '번역하는 중…' }));
            try {
                koView.textContent = await readingTranslation(cacheId, textarea.value) || '(비어 있어요)';
            } catch (error) {
                console.warn('[SpeakAs] reading translation failed', error);
                const retry = make('div', { class: 'psa_toen', tabindex: '0' }, [icon('fa-rotate-right'), make('span', { text: '다시 번역' })]);
                retry.addEventListener('click', () => showKo(true));
                koView.replaceChildren(make('div', { class: 'psa_err', text: translateErrorText(error) }), retry);
            }
        };
        segEn.addEventListener('click', () => showKo(false));
        segKo.addEventListener('click', () => showKo(true));
        toEn.addEventListener('click', async () => {
            const before = textarea.value;
            toEn.classList.add('psa_busy');
            try {
                const after = await koreanLinesToEnglish(before);
                const popup = ctx().Popup?.show?.confirm;
                const esc = after.replace(/&/g, '&amp;').replace(/</g, '&lt;');
                const ok = popup
                    ? await popup('한글 줄을 영어로', `<div style="text-align:left;white-space:pre-wrap;max-height:50vh;overflow:auto">${esc}</div><small>바뀐 건 한글이 있던 줄뿐이에요. 이대로 저장할까요?</small>`)
                    : true;
                if (ok && textarea.value === before) {
                    textarea.value = after;
                    textarea.dispatchEvent(new Event('input'));
                }
            } catch (error) {
                toastr.error(translateErrorText(error));
            }
            toEn.classList.remove('psa_busy');
        });
        refreshToEn();
        wrap.append(textarea, koView, toEn);
        return { wrap, seg };
    }

    /** "Only in this chat" note box for the main persona ('') or an NPC. */
    function buildNoteBox(id = '') {
        const has = hasChat();
        const box = make('div', { class: 'psa_notebox' });
        const state = make('span', { class: 'psa_note_state' });
        const label = make('div', { class: 'psa_label' }, [make('span', { text: id ? '이 채팅에서만 덧붙임 (이 NPC)' : '이 채팅에서만 덧붙임' }), state]);
        const note = make('textarea', { class: 'psa_note text_pole', rows: '3', placeholder: has ? '이 채팅에서만: 지금 옷차림, 부상, 들킨 비밀 등' : '채팅을 열면 쓸 수 있어요' });
        note.value = noteOf(id);
        if (!has) note.disabled = true;
        const refreshState = () => {
            const st = noteSendState(id);
            state.textContent = st === 'english' ? 'AI에겐 영어로 보냄' : st === 'pending' ? '영어로 바꾸는 중…' : st === 'korean' ? '한글 그대로 보냄' : '';
        };
        const save = debounce(() => {
            setNote(id, note.value);
            refreshState();
        }, 600);
        note.addEventListener('input', () => {
            state.textContent = '…';
            save();
        });
        const off = onChangeLocal(refreshState);
        new MutationObserver((_m, obs) => {
            if (!box.isConnected && obs.seen) {
                off();
                obs.disconnect();
            }
            if (box.isConnected) obs.seen = true;
        }).observe(document.body, { childList: true, subtree: true });
        refreshState();
        box.append(label, note);
        return box;
    }

    /** Settings block for the translation profile, used by every host's settings screen. */
    function buildTranslateSettings() {
        const box = make('div', { class: 'psa_inject_box', 'data-bl-native-ext-colors': '' });
        box.append(make('div', { class: 'psa_set_title' }, [icon('fa-language'), make('span', { text: '한영 번역' })]));
        const select = make('select', { class: 'text_pole psa_select' });
        select.append(make('option', { value: '', text: '(번역 안 씀)' }));
        for (const p of translateProfiles()) {
            const option = make('option', { value: p.id, text: p.name });
            if (translateProfile() === p.id) option.selected = true;
            select.append(option);
        }
        select.addEventListener('change', () => setTranslateProfile(select.value));
        box.append(
            make('div', { class: 'psa_set_sub', text: '번역에 쓸 연결 프로필 (싼 모델 추천)' }),
            select,
            make('small', { class: 'psa_set_note', text: '고치기 창의 [EN | 한]으로 설명을 한글로 읽고, "한글 줄만 영어로"로 한글로 쓴 줄만 영어로 바꿔요. 이미 영어인 줄은 다시 번역하지 않아요. "이 채팅에서만 덧붙임"을 한글로 쓰면 AI에게는 영어로 바꿔서 보내요.' }),
        );
        return box;
    }

    // ---- profile pictures: several per persona (main or NPC), swap any time

    const GALLERY_MAX = 12;

    function galleryOf(id) {
        const all = store().gallery;
        return Array.isArray(all?.[id]) ? all[id] : [];
    }

    function galleryActive(id) {
        return store().galleryActive?.[id] || '';
    }

    function fileToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    /** Stores an image in the user's files folder and returns its path. */
    async function storeGalleryImage(id, blob) {
        const c = ctx();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
        const safe = String(id).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        const name = `psa_pfp_${safe}_${Date.now()}.${ext}`;
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ name, data: await fileToBase64(blob) }),
        });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        const data = await res.json();
        return String(data.path || '');
    }

    /** Reloads every picture of this persona that is on screen. */
    function refreshPictures(id) {
        const bust = `t=${Date.now()}`;
        const key = encodeURIComponent(id);
        document.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') || '';
            if (src.includes(key) || src.includes(id)) {
                img.src = src.replace(/([?&])t=\d+/, '').replace(/[?&]$/, '') + (src.includes('?') ? '&' : '?') + bust;
            }
        });
    }

    /** Makes a gallery picture the persona's real avatar (same as changing it in ST's persona panel). */
    async function useGalleryImage(id, path) {
        const c = ctx();
        const blob = await (await fetch('/' + String(path).replace(/^\/+/, ''), { cache: 'no-cache' })).blob();
        const form = new FormData();
        form.append('avatar', new File([blob], 'avatar.png', { type: blob.type || 'image/png' }));
        form.append('overwrite_name', id);
        const headers = c.getRequestHeaders();
        delete headers['Content-Type'];
        const res = await fetch('/api/avatars/upload', { method: 'POST', headers, cache: 'no-cache', body: form });
        if (!res.ok) throw new Error(`avatar upload failed: ${res.status}`);
        const s = store();
        s.galleryActive ??= {};
        s.galleryActive[id] = path;
        c.saveSettingsDebounced?.();
        try { await personasMod?.getUserAvatars?.(true, id); } catch { /* panel refresh is optional */ }
        refreshPictures(id);
        emitChange();
    }

    async function addGalleryImage(id, file) {
        const s = store();
        s.gallery ??= {};
        s.galleryActive ??= {};
        const list = galleryOf(id).slice();
        if (list.length >= GALLERY_MAX) {
            toastr.warning(`프사는 페르소나마다 ${GALLERY_MAX}장까지 넣을 수 있어요.`);
            return;
        }
        // first time: keep the current picture too, so it can be picked again later
        if (!list.length && typeof personasMod?.getUserAvatar === 'function') {
            try {
                const cur = await (await fetch(personasMod.getUserAvatar(id), { cache: 'no-cache' })).blob();
                const p = await storeGalleryImage(id, cur);
                if (p) {
                    list.push(p);
                    s.galleryActive[id] = p;
                }
            } catch (error) {
                console.warn('[SpeakAs] could not keep the current picture', error);
            }
        }
        const path = await storeGalleryImage(id, file);
        if (!path) throw new Error('no path');
        list.push(path);
        s.gallery[id] = list;
        ctx().saveSettingsDebounced?.();
    }

    async function removeGalleryImage(id, path) {
        const s = store();
        s.gallery ??= {};
        s.gallery[id] = galleryOf(id).filter(p => p !== path);
        if (s.galleryActive?.[id] === path) delete s.galleryActive[id];
        ctx().saveSettingsDebounced?.();
        try {
            await fetch('/api/files/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path }) });
        } catch { /* the file stays, nothing breaks */ }
    }

    /** Adds pictures another copy of the gallery kept (used once by hosts that had their own gallery). */
    function mergeGallery(gallery, active) {
        const s = store();
        s.gallery ??= {};
        s.galleryActive ??= {};
        for (const [id, paths] of Object.entries(gallery ?? {})) {
            if (!Array.isArray(paths)) continue;
            s.gallery[id] = [...new Set([...galleryOf(id), ...paths])].slice(0, GALLERY_MAX);
        }
        for (const [id, path] of Object.entries(active ?? {})) {
            if (!s.galleryActive[id]) s.galleryActive[id] = path;
        }
        ctx().saveSettingsDebounced?.();
    }

    /** A persona was deleted in ST: drop its pictures and what the core kept for it. */
    async function forgetPersona(id) {
        if (!id || typeof id !== 'string' || personaNames()[id]) return;
        const s = store();
        const paths = galleryOf(id).slice();
        delete s.gallery?.[id];
        delete s.galleryActive?.[id];
        delete s.translateCache?.[`persona:${id}`];
        s.favs = (s.favs ?? []).filter(x => x !== id);
        ctx().saveSettingsDebounced?.();
        for (const path of paths) {
            try {
                await fetch('/api/files/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path }) });
            } catch { /* the file stays, nothing breaks */ }
        }
    }

    /** Row of a persona's pictures: tap = use it, x = take it out, + = add one. */
    function buildGalleryRow(id, onDone = () => {}) {
        const row = make('div', { class: 'psa_gallery' });
        const draw = () => {
            row.replaceChildren();
            const activePath = galleryActive(id);
            for (const path of galleryOf(id)) {
                const img = make('img', { class: 'psa_gthumb', alt: '', loading: 'lazy', src: '/' + String(path).replace(/^\/+/, ''), draggable: 'false' });
                const del = make('span', { class: 'psa_gdel', title: '이 프사 빼기' }, [icon('fa-xmark')]);
                const tile = make('div', { class: 'psa_gtile' + (path === activePath ? ' psa_on' : ''), tabindex: '0', title: '이 프사로 바꾸기' }, [img, del]);
                tile.addEventListener('click', async (e) => {
                    if (e.target instanceof Element && e.target.closest('.psa_gdel')) {
                        const confirm = ctx().Popup?.show?.confirm;
                        const ok = confirm ? await confirm('프사 빼기', '이 사진을 목록에서 뺄까요? 지금 쓰는 프사는 그대로예요.') : true;
                        if (!ok) return;
                        await removeGalleryImage(id, path);
                        draw();
                        return;
                    }
                    tile.classList.add('psa_busy');
                    try {
                        await useGalleryImage(id, path);
                        toastr.success('프사를 바꿨어요.', '', { timeOut: 1500 });
                    } catch (error) {
                        console.error('[SpeakAs] avatar swap failed', error);
                        toastr.error('프사를 바꾸지 못했어요.');
                    }
                    draw();
                    onDone();
                });
                row.append(tile);
            }
            const input = make('input', { type: 'file', accept: 'image/*', class: 'psa_hidden' });
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                if (!file) return;
                try {
                    await addGalleryImage(id, file);
                    toastr.success('프사를 추가했어요. 눌러서 바로 바꿀 수 있어요.', '', { timeOut: 2000 });
                } catch (error) {
                    console.error('[SpeakAs] adding a picture failed', error);
                    toastr.error('사진을 추가하지 못했어요.');
                }
                draw();
            });
            const add = make('div', { class: 'psa_gtile psa_gadd', tabindex: '0', title: '프사 추가' }, [icon('fa-plus'), input]);
            add.addEventListener('click', (e) => {
                if (e.target !== input) input.click();
            });
            row.append(add);
        };
        draw();
        return row;
    }

    // ---- editor sheet for one persona

    function openEditor(id) {
        if (!nameOf(id)) return;
        const c = ctx();
        const { panel, close } = openLayer('psa_editor_layer');
        const img = make('img', { class: 'psa_img psa_img_big psa_img_tap', alt: '', src: avatarOf(id), draggable: 'false', title: '프사 바꾸기' });
        const count = galleryOf(id).length;
        const hint = make('span', { class: 'psa_ghint', text: count ? `프사 ${count}장` : '프사 바꾸기' });
        const gallery = buildGalleryRow(id, () => {
            img.src = avatarOf(id) + (avatarOf(id).includes('?') ? '&' : '?') + `t=${Date.now()}`;
            hint.textContent = `프사 ${galleryOf(id).length}장`;
        });
        gallery.classList.add('psa_hidden');
        const toggleGallery = () => gallery.classList.toggle('psa_hidden');
        img.addEventListener('click', toggleGallery);
        hint.addEventListener('click', toggleGallery);
        const head = headRow(nameOf(id), close, img);
        head.querySelector('.psa_title').after(hint);
        panel.append(head, gallery);

        const desc = make('textarea', { class: 'psa_desc text_pole', rows: '8', placeholder: '페르소나 설명 없음' });
        const store = c.powerUserSettings?.persona_descriptions ?? {};
        desc.value = String(store[id]?.description ?? '');
        const status = make('span', { class: 'psa_saved', text: '' });
        let dirty = false;
        const saveNow = () => {
            if (!dirty) return;
            dirty = false;
            const field = document.getElementById('persona_description');
            if (id === mainId() && field) {
                // the main persona: let ST's own field handler update and save it
                $(field).val(desc.value).trigger('input');
            } else {
                const s = ctx().powerUserSettings;
                if (!s?.persona_descriptions) return;
                s.persona_descriptions[id] ??= {};
                s.persona_descriptions[id].description = desc.value;
                ctx().saveSettingsDebounced?.();
            }
            updatePrompt();
            status.textContent = '저장됨';
            setTimeout(() => { status.textContent = ''; }, 1500);
        };
        const saveSoon = debounce(saveNow, 600);
        desc.addEventListener('input', () => {
            dirty = true;
            status.textContent = '…';
            saveSoon();
        });
        // closing the sheet never loses the last edit
        new MutationObserver((_m, obs) => {
            if (!panel.isConnected) {
                saveNow();
                obs.disconnect();
            }
        }).observe(document.body, { childList: true });
        const field = translatableField(desc, `persona:${id}`);
        const descHead = make('div', { class: 'psa_label' }, [make('span', { text: '설명 ({{user}}는 이 페르소나 자신)' }), status, field.seg]);
        const noteBox = buildNoteBox(id === mainId() ? '' : id);

        const actions = make('div', { class: 'psa_actions' });
        const button = (iconCls, label, onClick, extra = '') => {
            const b = make('div', { class: 'psa_btn menu_button ' + extra, tabindex: '0' }, [icon(iconCls), make('span', { text: label })]);
            b.addEventListener('click', onClick);
            return b;
        };
        const renderActions = () => {
            actions.replaceChildren();
            const isMain = id === mainId();
            if (isMain) {
                actions.append(make('div', { class: 'psa_note', text: '지금 메인 페르소나예요.' }));
                return;
            }
            const speaking = get() === id;
            actions.append(button('fa-masks-theater', speaking ? '말하기 끄기' : '이 페르소나로 말하기', () => {
                toggleSpeak(id);
                renderActions();
            }, speaking ? 'psa_on' : ''));
            const inCast = isCast(id);
            actions.append(button(inCast ? 'fa-user-minus' : 'fa-user-plus', inCast ? '이 채팅 NPC에서 빼기' : '이 채팅 NPC로 넣기', () => {
                toggleCast(id);
                renderActions();
            }));
            const sent = isInjected(id);
            actions.append(button(sent ? 'fa-paper-plane' : 'fa-ban', sent ? 'AI에게 설명 보내는 중 (끄기)' : 'AI에게 설명 안 보냄 (켜기)', () => {
                toggleInject(id);
                renderActions();
            }, sent ? '' : 'psa_off'));
            actions.append(button('fa-crown', '메인으로 지정', async () => {
                if (await makeMain(id)) close();
            }, 'psa_main_btn'));
        };
        renderActions();

        panel.append(descHead, field.wrap, noteBox, actions);
    }

    // ---- small settings shared by every copy of the core

    function store() {
        const { extensionSettings } = ctx();
        extensionSettings[SETTINGS_KEY] ??= {};
        const s = extensionSettings[SETTINGS_KEY];
        if (!Array.isArray(s.favs)) s.favs = [];
        return s;
    }

    function isFav(id) {
        return store().favs.includes(id);
    }

    function toggleFav(id) {
        const s = store();
        s.favs = isFav(id) ? s.favs.filter(x => x !== id) : [...s.favs, id];
        ctx().saveSettingsDebounced?.();
    }

    /** Plain persona switch, the same as picking one in ST's persona panel. */
    async function switchMain(id) {
        const c = ctx();
        if (!nameOf(id) || id === mainId()) return false;
        const command = c.SlashCommandParser?.commands?.['persona-set'] ?? c.SlashCommandParser?.commands?.['persona'];
        if (!command) {
            toastr.warning('페르소나 전환 명령을 찾지 못했어요.');
            return false;
        }
        try {
            await command.callback({ mode: 'lookup' }, id);
        } catch (error) {
            console.error('[SpeakAs] persona switch failed', error);
            toastr.error('페르소나를 바꾸지 못했어요.');
            return false;
        }
        if (get() === id) set('');
        emitChange();
        return true;
    }

    async function toggleLock(type) {
        const toggle = personasMod?.togglePersonaLock;
        if (typeof toggle !== 'function') {
            toastr.warning('이 실리태번 버전에서는 고정 기능을 찾지 못했어요.');
            return;
        }
        if (type === 'character' && ctx().characterId === undefined) {
            toastr.info('캐릭터 채팅에서만 캐릭터에 고정할 수 있어요.');
            return;
        }
        try {
            await toggle(type);
        } catch (error) {
            console.error('[SpeakAs] lock failed', error);
            toastr.error('고정 상태를 바꾸지 못했어요.');
        }
        emitChange();
    }

    // ---- persona panel: main card, locks, tabs (this chat / all), divider, tools per row

    /**
     * mode 'speak': the quick persona panel. NPC rows: tap = speak as. Other rows: tap = make main.
     * mode 'message': tap = the message is spoken by that persona (the first row puts it back)
     * onSettings: optional, shows a gear in the header
     */
    function openPanel({ mode = 'speak', messageId = null, onSettings = null } = {}) {
        const names = personaNames();
        const message = mode === 'message' ? ctx().chat?.[messageId] : null;
        if (mode === 'message' && !message?.is_user) return;
        const title = mode === 'message' ? '이 메시지 말한 사람 바꾸기' : '페르소나 · NPC';
        const { panel, close } = openLayer();
        const head = headRow(title, close);
        if (onSettings) {
            const gear = make('div', { class: 'psa_close', tabindex: '0', title: '설정' }, [icon('fa-gear')]);
            gear.addEventListener('click', () => onSettings());
            head.insertBefore(gear, head.lastChild);
        }
        panel.append(head);

        let tab = cast().length ? 'cast' : 'all';
        const top = make('div', { class: 'psa_top' });
        const tabs = make('div', { class: 'psa_tabs' });
        const hint = make('div', { class: 'psa_hint' });
        const filter = make('input', { class: 'psa_filter text_pole', type: 'search', placeholder: '이름 · 설명 검색' });
        const list = make('div', { class: 'psa_list' });
        const descriptions = ctx().powerUserSettings?.persona_descriptions ?? {};
        const snippet = (id) => String(descriptions[id]?.description ?? '').replace(/\s+/g, ' ').trim();

        const tapRow = async (id) => {
            if (mode === 'message') {
                applyTo(messageId, id);
                updatePrompt();
                ctx().saveChat?.();
                emitChange();
                close();
                return;
            }
            if (!id || id === mainId()) {
                if (get()) {
                    set('');
                    toastr.info('NPC로 말하기를 껐어요.');
                }
                close();
                return;
            }
            if (isCast(id)) {
                toggleSpeak(id);
                close();
                return;
            }
            if (await switchMain(id)) close();
        };

        const row = (id, opts = {}) => {
            const left = id
                ? make('img', { class: 'psa_img', alt: '', loading: 'lazy', src: avatarOf(id), draggable: 'false' })
                : make('div', { class: 'psa_img psa_img_icon' }, [icon('fa-rotate-left')]);
            const text = make('div', { class: 'psa_rowtext' }, [make('span', { class: 'psa_name', text: opts.label ?? nameOf(id) })]);
            const sub = opts.sub ?? (id ? snippet(id) : '');
            if (sub) text.append(make('span', { class: 'psa_sub', text: sub }));
            const r = make('div', { class: 'psa_row' + (opts.active ? ' psa_active' : '') + (id && isCast(id) ? ' psa_castrow' : ''), tabindex: '0' }, [left, text]);
            r.addEventListener('click', () => tapRow(id));
            r.addEventListener('keydown', (e) => { if (e.key === 'Enter') tapRow(id); });
            if (id) {
                const tools = make('div', { class: 'psa_tools' });
                const tool = (iconCls, title, on, fn) => {
                    const b = make('div', { class: 'psa_tool' + (on ? ' psa_on' : ''), tabindex: '0', title }, [icon(iconCls)]);
                    b.addEventListener('click', (e) => {
                        e.stopPropagation();
                        fn();
                    });
                    tools.append(b);
                };
                if (mode === 'speak') tool('fa-star', isFav(id) ? '즐겨찾기 해제' : '즐겨찾기', isFav(id), () => { toggleFav(id); render(); });
                if (id !== mainId()) {
                    const inCast = isCast(id);
                    tool(inCast ? 'fa-user-check' : 'fa-user-plus', inCast ? '이 채팅 NPC에서 빼기' : '이 채팅 NPC로 넣기', inCast, () => toggleCast(id));
                }
                tool('fa-pen', '설명 고치기 · 메인으로 지정', false, () => openEditor(id));
                r.append(tools);
            }
            return r;
        };

        const renderTop = () => {
            top.replaceChildren();
            if (mode !== 'speak') return;
            const main = mainId();
            const npc = get();
            if (main && nameOf(main)) {
                const card = make('div', { class: 'psa_maincard', tabindex: '0', title: '메인 페르소나 설명 고치기' }, [
                    make('img', { class: 'psa_img psa_img_big', alt: '', src: avatarOf(main), draggable: 'false' }),
                    make('div', { class: 'psa_rowtext' }, [
                        make('span', { class: 'psa_name', text: nameOf(main) }),
                        make('span', { class: 'psa_sub', text: (npc ? `🎭 ${nameOf(npc)}(으)로 말하는 중` : '메인 페르소나 · {{user}}') + (noteOf('').trim() ? ' · 📝 덧붙임' : '') }),
                    ]),
                ]);
                card.addEventListener('click', () => openEditor(main));
                if (npc) {
                    const off = make('div', { class: 'psa_offbtn', tabindex: '0', title: 'NPC로 말하기 끄기' }, [icon('fa-xmark'), make('span', { text: '끄기' })]);
                    off.addEventListener('click', (e) => {
                        e.stopPropagation();
                        set('');
                    });
                    card.append(off);
                }
                top.append(card);
            }
            const locks = make('div', { class: 'psa_locks' });
            for (const [type, label, iconCls] of [['chat', '채팅 고정', 'fa-lock'], ['character', '캐릭터 고정', 'fa-link']]) {
                const on = lockState(type);
                const chip = make('div', { class: 'psa_lock' + (on ? ' psa_on' : ''), tabindex: '0', title: on ? `${label} 해제` : label }, [icon(iconCls), make('span', { text: label })]);
                chip.addEventListener('click', () => toggleLock(type));
                locks.append(chip);
            }
            top.append(locks);
        };

        const renderTabs = () => {
            tabs.replaceChildren();
            for (const [key, label] of [['cast', `이 채팅 NPC ${cast().length}`], ['all', '전체 페르소나']]) {
                const t = make('div', { class: 'psa_tab' + (tab === key ? ' psa_on' : ''), tabindex: '0' }, [make('span', { text: label })]);
                t.addEventListener('click', () => {
                    tab = key;
                    render();
                });
                tabs.append(t);
            }
            hint.textContent = mode === 'message'
                ? '탭하면 이 메시지를 그 페르소나가 말한 걸로 바꿔요.'
                : (tab === 'cast' ? '탭하면 그 NPC로 말해요. 메인은 그대로예요.' : 'NPC는 탭하면 그 NPC로 말하고, 다른 페르소나는 탭하면 메인으로 바뀌어요.');
        };

        function render() {
            renderTop();
            renderTabs();
            const q = filter.value.trim().toLowerCase();
            const match = (id) => !q || `${names[id]} ${snippet(id)}`.toLowerCase().includes(q);
            const current = mode === 'message' ? (message.extra?.[MARK_KEY] || '') : get();
            const castIds = cast();
            list.replaceChildren();

            if (!q && mode === 'message' && message.extra?.[ORIG_KEY]) {
                list.append(row('', { label: `원래대로 (${message.extra[ORIG_KEY].name})`, sub: '' }));
            }

            const castRows = castIds.filter(match);
            for (const id of castRows) list.append(row(id, { active: id === current }));
            if (tab === 'cast') {
                if (!castIds.length) list.append(make('div', { class: 'psa_empty', text: '아직 이 채팅 NPC가 없어요. 전체 페르소나에서 ＋를 눌러 넣어 주세요.' }));
                else if (!castRows.length) list.append(make('div', { class: 'psa_empty', text: '일치하는 NPC가 없어요.' }));
                return;
            }
            // NPCs of this chat first, a line, then everyone else (main, favourites, the rest)
            const main = mainId();
            const others = Object.keys(names)
                .filter(id => !castIds.includes(id) && match(id))
                .sort((a, b) => Number(b === main) - Number(a === main)
                    || Number(isFav(b)) - Number(isFav(a))
                    || String(names[a]).localeCompare(String(names[b])));
            if (castRows.length && others.length) list.append(make('div', { class: 'psa_divider' }, [make('span', { text: '다른 페르소나' })]));
            for (const id of others) list.append(row(id, { active: mode === 'speak' ? id === main && !current : id === current, sub: id === main ? '메인 페르소나' : undefined }));
            if (!castRows.length && !others.length) list.append(make('div', { class: 'psa_empty', text: '일치하는 페르소나가 없어요.' }));
        }

        filter.addEventListener('input', render);
        const off = onChangeLocal(render);
        new MutationObserver((_m, obs) => {
            if (!panel.isConnected) {
                off();
                obs.disconnect();
            }
        }).observe(document.body, { childList: true });
        render();
        panel.append(top, tabs, hint, filter, list);
        if (!('ontouchstart' in window)) filter.focus();
    }

    // ---- message button for changing a sent message

    function addMessageButton() {
        const holder = document.querySelector('#message_template .mes_buttons .extraMesButtons');
        if (!holder || holder.querySelector('.psa_mes_btn')) return;
        const btn = make('div', { class: 'mes_button psa_mes_btn fa-solid fa-masks-theater interactable', title: '말한 사람 바꾸기 (NPC)', tabindex: '0' });
        holder.prepend(btn);
        document.addEventListener('click', (e) => {
            const b = e.target instanceof Element ? e.target.closest('.psa_mes_btn') : null;
            if (!b) return;
            const mes = b.closest('.mes');
            const messageId = Number(mes?.getAttribute('mesid'));
            if (!Number.isInteger(messageId)) return;
            e.stopPropagation();
            openPanel({ mode: 'message', messageId });
        });
    }

    // ---- slash command

    function findPersona(text) {
        const q = String(text ?? '').trim();
        if (!q) return '';
        const names = personaNames();
        if (names[q]) return q;
        const lower = q.toLowerCase();
        return Object.keys(names).find(id => String(names[id]).toLowerCase() === lower)
            || Object.keys(names).find(id => String(names[id]).toLowerCase().startsWith(lower))
            || '';
    }

    function registerCommand() {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
        if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
        const unnamedArgumentList = SlashCommandArgument?.fromProps && ARGUMENT_TYPE
            ? [SlashCommandArgument.fromProps({ description: 'persona name, or off', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })]
            : [];
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'speakas',
            callback: (_args, value) => {
                const v = String(value ?? '').trim();
                if (!v) return nameOf(get());
                if (['off', '끄기', 'none'].includes(v.toLowerCase())) {
                    set('');
                    return '';
                }
                const id = findPersona(v);
                if (!id) {
                    toastr.warning(`'${v}' 페르소나를 찾지 못했어요.`);
                    return '';
                }
                set(id);
                return nameOf(get());
            },
            unnamedArgumentList,
            returns: 'name of the persona being spoken as',
            helpString: '<div>메인 페르소나는 그대로 두고, 보내는 메시지를 다른 페르소나(NPC) 이름으로 보내요. 이름을 주면 켜고 <code>off</code>면 꺼요. 비워 두면 지금 말하는 NPC 이름을 돌려줘요.</div>',
        }));
    }

    // ---- install

    function install() {
        const { eventSource, event_types } = ctx();
        const on = (name, fn) => { if (event_types[name]) eventSource.on(event_types[name], fn); };
        on('MESSAGE_SENT', onMessageSent);
        on('USER_MESSAGE_RENDERED', onMessageRendered);
        for (const name of ['CHAT_CHANGED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED', 'MESSAGE_DELETED']) {
            on(name, () => {
                updatePrompt();
                emitChange();
            });
        }
        on('CHAT_CHANGED', () => translateNotesSoon());
        on('PERSONA_DELETED', (data) => { forgetPersona(data?.avatarId); });
        addMessageButton();
        registerCommand();
        updatePrompt();
    }

    const core = {
        version: CORE_VERSION,
        get,
        set,
        toggleSpeak,
        cast,
        setCast,
        isCast,
        toggleCast,
        makeMain,
        applyTo,
        usedIds,
        nameOf,
        avatarOf,
        mainId,
        openPanel,
        openEditor,
        switchMain,
        isFav,
        toggleFav,
        lockState,
        toggleLock,
        settings: store,
        injectMode,
        setInjectMode,
        isInjected,
        toggleInject,
        injectedIds,
        buildInjectSettings,
        buildTranslateSettings,
        buildNoteBox,
        buildGalleryRow,
        galleryOf,
        galleryActive,
        addGalleryImage,
        removeGalleryImage,
        useGalleryImage,
        mergeGallery,
        forgetPersona,
        noteOf,
        setNote,
        noteSendState,
        translateProfile,
        setTranslateProfile,
        translateList,
        koreanLinesToEnglish,
        readingTranslation,
        ui: { openLayer, headRow, make, icon },
        pickSpeaker: (opts = {}) => openPanel({ mode: 'speak', ...opts }),
        pickForMessage: (messageId) => openPanel({ mode: 'message', messageId }),
        updatePrompt,
        // kept for older callers; the NPC list now lives in the core
        setExternalPromptIds() {},
        onChange: onChangeLocal,
        install,
    };
    return core;
}

/**
 * Returns the shared core, installing it the first time. Call after APP_READY.
 * Both copies of this file may call it at once, so the promise itself is shared.
 */
export function getSpeakAs() {
    if (!globalThis.SpeakAsPersonaReady) {
        globalThis.SpeakAsPersonaReady = (async () => {
            // path is relative to scripts/extensions/third-party/<folder>/
            personasMod = await import('../../../personas.js').catch(() => null);
            const core = createCore();
            globalThis.SpeakAsPersona = core;
            core.install();
            return core;
        })();
    }
    return globalThis.SpeakAsPersonaReady;
}
