// Speak As core: send user messages as another persona (an NPC) while the main persona stays selected,
// so {{user}} keeps meaning the main persona. Also keeps a per-chat NPC list ("cast").
// This file is shared: when several extensions ship it, only the first one installs the handlers,
// the others reuse globalThis.SpeakAsPersona.

const CORE_VERSION = 4;
const SETTINGS_KEY = 'speakAsPersona'; // extensionSettings: { favs }
const STATE_KEY = 'psa_speaking';       // chatMetadata: persona id the user is speaking as
const CAST_KEY = 'psa_cast';            // chatMetadata: persona ids that appear in this chat
const NOINJECT_KEY = 'psa_noinject';    // chatMetadata: NPC ids whose description is not sent to the AI
const PROMPT_KEY = 'psa_npc_personas';  // extension prompt slot
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
                return `[${name}]\n${desc || '(no description)'}`;
            });
            text = 'In addition to {{user}}, the following characters are also on the user\'s side of this roleplay. '
                + 'Some user messages are spoken by them instead of {{user}}; those messages are labeled with the speaking character\'s name. '
                + '{{user}} still refers to the main user character.\n\n'
                + blocks.join('\n\n');
        }
        // position 0 = in prompt, depth 0, no WI scan, system role
        c.setExtensionPrompt(PROMPT_KEY, text, 0, 0, false, 0);
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

    // ---- editor sheet for one persona

    function openEditor(id) {
        if (!nameOf(id)) return;
        const c = ctx();
        const { panel, close } = openLayer('psa_editor_layer');
        const img = make('img', { class: 'psa_img psa_img_big', alt: '', src: avatarOf(id), draggable: 'false' });
        panel.append(headRow(nameOf(id), close, img));

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
        const descHead = make('div', { class: 'psa_label' }, [make('span', { text: '설명 ({{user}}는 이 페르소나 자신)' }), status]);

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

        panel.append(descHead, desc, actions);
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
                        make('span', { class: 'psa_sub', text: npc ? `🎭 ${nameOf(npc)}(으)로 말하는 중` : '메인 페르소나 · {{user}}' }),
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
