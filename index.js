// Top Slide Bar - a collapsible top bar for SillyTavern
// Items: connection profile, model name, persona switcher, activated lorebook entries, auto retry,
// lightweight chat search, new chat, context overflow warning.

const MODULE = 'topSlideBar';
const DEFAULTS = Object.freeze({
    open: false,
    personaFavs: [],
    personaView: 'list', // 'list' | 'grid'
    chatMemory: true,
    openMode: 'both', // 'tap' | 'swipe' | 'both' | 'always'
    autoClose: true,
    retryOn: false,
    retryMax: 5,
    retryDelay: 3,
    show: {
        profile: true,
        model: true,
        persona: true,
        lorebook: true,
        autoRetry: true,
        search: true,
        newChat: true,
        ctxWarn: true,
        chatMemory: true,
    },
});

const ITEM_LABELS = {
    profile: '연결 프로필',
    model: '현재 모델명',
    persona: '페르소나 전환',
    lorebook: '발동된 로어북 항목',
    autoRetry: '자동 재시도 버튼',
    search: '채팅 내 검색',
    newChat: '새 채팅',
    ctxWarn: '컨텍스트 초과 경고',
    chatMemory: '채팅별 설정 표시 (📌)',
};

const HIGHLIGHT_NAME = 'tsb-search';
const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

/** Optional core modules. Loaded dynamically so a path change cannot break the whole bar. */
let personasMod = null;
let scriptMod = null;

const el = {};
const search = { query: '', hits: [], pos: -1 };

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(DEFAULTS);
    }
    const s = extensionSettings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (s[key] === undefined) s[key] = structuredClone(DEFAULTS[key]);
    }
    for (const key of Object.keys(DEFAULTS.show)) {
        if (s.show[key] === undefined) s.show[key] = DEFAULTS.show[key];
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
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

// ---------------------------------------------------------------- layout

function buildBar() {
    const sheld = document.getElementById('sheld');
    const chat = document.getElementById('chat');
    if (!sheld || !chat) {
        console.error('[TopSlideBar] #sheld or #chat not found');
        return false;
    }

    el.root = make('div', { id: 'tsb_root' });
    el.panel = make('div', { id: 'tsb_panel' });
    el.inner = make('div', { id: 'tsb_inner' });

    // Left: connection profile + model + warning
    el.profileSelect = make('select', { id: 'tsb_profile', title: '연결 프로필 전환' });
    el.profileLabel = make('span', { class: 'tsb_profile_label', text: '' });
    el.profileBox = make('div', { class: 'tsb_profile_box' }, [el.profileLabel, el.profileSelect]);
    el.pinBtn = make('div', { class: 'tsb_pin', title: '채팅별 설정', tabindex: '0' }, [icon('fa-thumbtack')]);
    el.profileWrap = make('div', { class: 'tsb_item tsb_profile_wrap', 'data-item': 'profile' }, [icon('fa-plug'), el.profileBox, el.pinBtn]);
    el.model = make('div', { class: 'tsb_item tsb_model', 'data-item': 'model', title: '현재 모델 (탭하면 마지막 답변 정보)', tabindex: '0' });
    el.warn = make('div', { class: 'tsb_item tsb_btn tsb_warn tsb_hidden', 'data-item': 'ctxWarn', title: '컨텍스트에 안 들어간 메시지가 있어요', tabindex: '0' }, [icon('fa-triangle-exclamation')]);
    const group1 = make('div', { class: 'tsb_group tsb_group_main' }, [el.profileWrap, el.model, el.warn]);

    // Right: icon buttons
    el.personaImg = make('img', { class: 'tsb_avatar', alt: '' });
    el.personaName = make('span', { class: 'tsb_label' });
    el.personaBtn = make('div', { class: 'tsb_item tsb_btn tsb_persona', 'data-item': 'persona', title: '페르소나 전환', tabindex: '0' }, [el.personaImg, el.personaName]);
    el.loreCount = make('span', { class: 'tsb_badge tsb_hidden', text: '0' });
    el.loreBtn = make('div', { class: 'tsb_item tsb_btn', 'data-item': 'lorebook', title: '발동된 로어북 항목 (길게 누르면 다음 생성 미리보기)', tabindex: '0' }, [icon('fa-book-atlas'), el.loreCount]);
    el.retryCount = make('span', { class: 'tsb_badge tsb_hidden', text: '' });
    el.retryBtn = make('div', { class: 'tsb_item tsb_btn', 'data-item': 'autoRetry', title: '자동 재시도', tabindex: '0' }, [icon('fa-repeat'), el.retryCount]);
    el.searchBtn = make('div', { class: 'tsb_item tsb_btn', 'data-item': 'search', title: '채팅 내 검색', tabindex: '0' }, [icon('fa-magnifying-glass')]);
    el.newChatBtn = make('div', { class: 'tsb_item tsb_btn', 'data-item': 'newChat', title: '새 채팅 (길게 누르면 분기 · 닫기 메뉴)', tabindex: '0' }, [icon('fa-comment-medical')]);
    const group2 = make('div', { class: 'tsb_group tsb_group_actions' }, [el.personaBtn, el.loreBtn, el.retryBtn, el.searchBtn, el.newChatBtn]);

    // Search row
    el.searchInput = make('input', { id: 'tsb_search_input', type: 'search', placeholder: '채팅 전체 검색', enterkeyhint: 'search' });
    el.searchCount = make('span', { class: 'tsb_search_count', text: '' });
    el.searchPrev = make('div', { class: 'tsb_btn', title: '이전 결과 (더 오래된 메시지)', tabindex: '0' }, [icon('fa-chevron-up')]);
    el.searchNext = make('div', { class: 'tsb_btn', title: '다음 결과 (더 최근 메시지)', tabindex: '0' }, [icon('fa-chevron-down')]);
    el.searchClose = make('div', { class: 'tsb_btn', title: '검색 닫기', tabindex: '0' }, [icon('fa-xmark')]);
    el.searchRow = make('div', { id: 'tsb_search_row', class: 'tsb_hidden' }, [el.searchInput, el.searchCount, el.searchPrev, el.searchNext, el.searchClose]);

    el.inner.append(group1, group2, el.searchRow);
    el.panel.append(el.inner);

    // Dropdown used by persona and lorebook lists
    el.dropdown = make('div', { id: 'tsb_dropdown', class: 'tsb_hidden' });

    // Handle
    el.handleWarn = make('span', { class: 'tsb_handle_warn tsb_hidden' }, [icon('fa-triangle-exclamation')]);
    el.handle = make('div', { id: 'tsb_handle', title: '상단 바 열기/닫기', tabindex: '0' }, [make('span', { class: 'tsb_grip' }), el.handleWarn]);

    el.root.append(el.panel, el.handle, el.dropdown);
    sheld.insertBefore(el.root, chat);
    return true;
}

function applyVisibility() {
    const s = settings();
    el.root.querySelectorAll('[data-item]').forEach(node => {
        node.classList.toggle('tsb_off', !s.show[node.getAttribute('data-item')]);
    });
    if (!s.show.search) closeSearch();
    if (el.pinBtn) updatePinButton();
    updateWarn();
}

function setOpen(open) {
    settings().open = open;
    el.root.classList.toggle('tsb_open', open);
    if (!open) closeDropdown();
    save();
}

/** 'always' keeps the bar open and hides the handle; other modes start collapsed. */
function applyOpenMode() {
    const always = settings().openMode === 'always';
    el.root.classList.toggle('tsb_always', always);
    el.root.classList.toggle('tsb_autoclose', !always && !!settings().autoClose);
    settings().open = always;
    el.root.classList.toggle('tsb_open', always);
}

/** Auto-close: when the bar is open, a tap anywhere outside it closes it. */
function bindAutoClose() {
    // Close only on a real tap: finger barely moved and was lifted quickly. Scrolling does not close.
    let down = null;
    const ignored = (target) => target instanceof Element && !!target.closest('#tsb_root, #toast-container, .popup, dialog');
    document.addEventListener('pointerdown', (e) => {
        const s = settings();
        down = (!s.autoClose || s.openMode === 'always' || !s.open || ignored(e.target))
            ? null
            : { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    }, { capture: true, passive: true });
    document.addEventListener('pointercancel', () => { down = null; }, { capture: true, passive: true });
    document.addEventListener('pointerup', (e) => {
        if (!down || e.pointerId !== down.id) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        const quick = Date.now() - down.t < 500;
        down = null;
        if (moved < 10 && quick && settings().open) setOpen(false);
    }, { capture: true, passive: true });
}

function bindSlide() {
    el.handle.addEventListener('click', () => {
        const mode = settings().openMode;
        if (mode === 'always') return;
        // Swipe-only mode still allows click on devices without touch, otherwise the bar could never be opened.
        if (mode === 'swipe' && hasTouch) return;
        setOpen(!settings().open);
    });

    let startX = 0;
    let startY = 0;
    let tracking = false;
    el.root.addEventListener('touchstart', (e) => {
        if (settings().openMode === 'tap' || settings().openMode === 'always') return;
        if (e.target instanceof Element && e.target.closest('#tsb_dropdown, select, input')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });
    el.root.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dy) < 24 || Math.abs(dy) < Math.abs(dx)) return;
        if (dy > 0 && !settings().open) setOpen(true);
        if (dy < 0 && settings().open) setOpen(false);
    }, { passive: true });
}

// ---------------------------------------------------------------- dropdown

let dropdownOwner = null;

function openDropdown(owner, build) {
    if (dropdownOwner === owner) {
        closeDropdown();
        return;
    }
    dropdownOwner = owner;
    el.dropdown.replaceChildren();
    build(el.dropdown);
    el.dropdown.classList.toggle('tsb_persona_dd', owner === 'persona');
    el.dropdown.classList.remove('tsb_hidden');
}

function closeDropdown() {
    if (dropdownOwner === 'newchat') clearBranchMark();
    dropdownOwner = null;
    el.dropdown.classList.add('tsb_hidden');
    el.dropdown.replaceChildren();
}

// ---------------------------------------------------------------- connection profile + model

function updateProfileLabel() {
    const option = el.profileSelect.selectedOptions?.[0];
    const name = el.profileSelect.value && option ? (option.textContent ?? '').trim() : '';
    el.profileLabel.textContent = name || '프로필 없음';
    el.profileLabel.classList.toggle('tsb_muted', !name);
}

function bindProfiles() {
    const main = /** @type {HTMLSelectElement|null} */ (document.getElementById('connection_profiles'));
    if (!main) {
        // Connection Profiles extension is disabled
        el.profileWrap.classList.add('tsb_hidden');
        return;
    }
    const sync = () => {
        el.profileSelect.innerHTML = main.innerHTML;
        el.profileSelect.value = main.value;
        updateProfileLabel();
    };
    sync();
    el.profileSelect.addEventListener('change', () => {
        main.value = el.profileSelect.value;
        main.dispatchEvent(new Event('change'));
    });
    main.addEventListener('change', () => {
        el.profileSelect.value = main.value;
        updateProfileLabel();
        updateModelDebounced();
    });
    new MutationObserver(sync).observe(main, { childList: true });
}

// ---------------------------------------------------------------- per-chat setup memory
// Each chat remembers the API, preset, model and prompt toggles it was last used with,
// and they are restored when the chat is opened again. Saved into the chat metadata only
// when something actually changed, and restored once per chat switch, so it stays light.

const MEM_KEY = 'tsb_setup';
let openaiMod = null;
const mem = { applying: false, readyFor: null };

function slash(name) {
    return ctx().SlashCommandParser?.commands?.[name];
}

async function slashGet(name) {
    try {
        const result = await slash(name)?.callback({ quiet: 'true' }, '');
        return typeof result === 'string' ? result : '';
    } catch {
        return '';
    }
}

async function slashSet(name, value) {
    try {
        await slash(name)?.callback({ quiet: 'true' }, value);
        return true;
    } catch (error) {
        console.warn(`[TopSlideBar] /${name} ${value} failed`, error);
        return false;
    }
}

function promptOrder() {
    const pm = openaiMod?.promptManager;
    if (!pm || ctx().mainApi !== 'openai') return null;
    try {
        return pm.getPromptOrderForCharacter(pm.activeCharacter) ?? null;
    } catch {
        return null;
    }
}

async function captureSetup() {
    const toggles = {};
    for (const entry of promptOrder() ?? []) {
        if (entry?.identifier) toggles[entry.identifier] = !!entry.enabled;
    }
    return {
        api: await slashGet('api'),
        preset: await slashGet('preset'),
        model: await slashGet('model'),
        toggles,
    };
}

function chatMemory() {
    const { chatMetadata, getCurrentChatId } = ctx();
    if (!getCurrentChatId?.()) return null;
    const value = chatMetadata?.[MEM_KEY];
    return value && typeof value === 'object' ? value : null;
}

function updatePinButton() {
    const saved = chatMemory();
    const on = settings().chatMemory;
    el.pinBtn.classList.toggle('tsb_on', on && !!saved);
    el.pinBtn.classList.toggle('tsb_off', !settings().show.chatMemory);
    el.pinBtn.title = !on
        ? '채팅별 설정 기억이 꺼져 있어요 (설정에서 켜기)'
        : saved
            ? `이 채팅에 기억된 설정: ${saved.preset || '-'} · ${saved.model || '-'} (누르면 지우기)`
            : '이 채팅은 아직 기억된 설정이 없어요 (누르면 지금 설정 저장)';
}

/** Saves the current setup into the open chat, only if it differs from what is stored. */
async function rememberSetup(force = false, fromGeneration = false) {
    if (!settings().chatMemory || mem.applying) return;
    // Chats without a memory only start remembering once they are actually used for a reply
    if (!force && !fromGeneration && !chatMemory()) return;
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    if (!chatId || mem.readyFor !== chatId) return;
    const setup = await captureSetup();
    // The chat may have changed while awaiting
    if (ctx().getCurrentChatId?.() !== chatId || mem.applying) return;
    const before = JSON.stringify(c.chatMetadata[MEM_KEY] ?? null);
    if (!force && before === JSON.stringify(setup)) return;
    c.chatMetadata[MEM_KEY] = setup;
    c.saveMetadataDebounced();
    updatePinButton();
}
const rememberSetupDebounced = debounce(() => rememberSetup(), 1500);

async function restoreSetup() {
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    mem.readyFor = null;
    updatePinButton();
    if (!chatId) return;
    const saved = settings().chatMemory ? chatMemory() : null;
    if (!saved) {
        mem.readyFor = chatId;
        return;
    }
    mem.applying = true;
    const changed = [];
    try {
        // Order matters: API -> preset (resets toggles and may set a model) -> model -> toggles
        if (saved.api && saved.api !== await slashGet('api')) {
            if (await slashSet('api', saved.api)) changed.push('API');
        }
        if (saved.preset && saved.preset !== await slashGet('preset')) {
            if (await slashSet('preset', saved.preset)) changed.push('프리셋');
        }
        if (saved.model && saved.model !== await slashGet('model')) {
            if (await slashSet('model', saved.model)) changed.push('모델');
        }
        const order = promptOrder();
        if (order && saved.toggles) {
            let diff = 0;
            for (const entry of order) {
                const want = saved.toggles[entry.identifier];
                if (typeof want === 'boolean' && want !== !!entry.enabled) {
                    entry.enabled = want;
                    diff++;
                }
            }
            if (diff) {
                openaiMod.promptManager.render(false);
                await openaiMod.promptManager.saveServiceSettings();
                changed.push(`토글 ${diff}개`);
            }
        }
    } catch (error) {
        console.error('[TopSlideBar] Restoring chat setup failed', error);
    } finally {
        mem.applying = false;
    }
    if (ctx().getCurrentChatId?.() === chatId) mem.readyFor = chatId;
    if (changed.length) {
        toastr.info(`${changed.join(', ')}을 이 채팅 설정으로 바꿨어요.`, '채팅별 설정', { timeOut: 2500 });
        updateModelDebounced();
    }
}

async function onPinClick() {
    if (!settings().chatMemory) {
        toastr.info('확장 설정에서 "채팅별 설정 기억"을 먼저 켜 주세요.');
        return;
    }
    const c = ctx();
    if (!c.getCurrentChatId?.()) return;
    if (chatMemory()) {
        delete c.chatMetadata[MEM_KEY];
        c.saveMetadataDebounced();
        // Stop auto-saving into this chat until it is reopened or saved by hand
        mem.readyFor = null;
        updatePinButton();
        toastr.info('이 채팅에 기억된 설정을 지웠어요. 다시 열면 그때부터 새로 기억해요.');
        return;
    }
    mem.readyFor = c.getCurrentChatId();
    await rememberSetup(true);
    toastr.success('지금 설정을 이 채팅에 기억했어요.');
}

async function updateModel() {
    const { SlashCommandParser, onlineStatus } = ctx();
    if (onlineStatus === 'no_connection') {
        el.model.textContent = '연결 안 됨';
        el.model.classList.add('tsb_offline');
        return;
    }
    let model = '';
    try {
        const result = await SlashCommandParser.commands['model']?.callback({ quiet: 'true' }, '');
        if (result && typeof result === 'string') model = result;
    } catch (error) {
        console.warn('[TopSlideBar] Failed to read current model', error);
    }
    el.model.classList.remove('tsb_offline');
    el.model.textContent = model || String(onlineStatus || '');
    el.model.title = `현재 모델: ${el.model.textContent} (탭하면 마지막 답변 정보)`;
}
const updateModelDebounced = debounce(updateModel, 800);

// ---------------------------------------------------------------- persona

function currentPersonaId() {
    return personasMod?.user_avatar || '';
}

function updatePersona() {
    const c = ctx();
    const id = currentPersonaId();
    const personas = c.powerUserSettings?.personas ?? {};
    const extraCount = extraPersonas().length;
    el.personaName.textContent = (personas[id] || c.name1 || '페르소나') + (extraCount ? ` +${extraCount}` : '');
    if (id) {
        el.personaImg.src = c.getThumbnailUrl('persona', id);
        el.personaImg.classList.remove('tsb_hidden');
    } else {
        el.personaImg.classList.add('tsb_hidden');
    }
}

async function selectPersona(avatarId) {
    const { SlashCommandParser } = ctx();
    const command = SlashCommandParser.commands['persona-set'] ?? SlashCommandParser.commands['persona'];
    if (!command) {
        toastr.warning('페르소나 전환 명령을 찾지 못했어요.');
        return;
    }
    try {
        await command.callback({ mode: 'lookup' }, avatarId);
    } catch (error) {
        console.error('[TopSlideBar] Persona switch failed', error);
        toastr.error('페르소나를 바꾸지 못했어요.');
    }
    closeDropdown();
    updatePersona();
    updateExtraPrompt();
}

function isFav(avatarId) {
    return settings().personaFavs.includes(avatarId);
}

function toggleFav(avatarId) {
    const s = settings();
    s.personaFavs = isFav(avatarId) ? s.personaFavs.filter(id => id !== avatarId) : [...s.personaFavs, avatarId];
    save();
}

function lockState(type) {
    try {
        return !!personasMod?.isPersonaLocked?.(type);
    } catch {
        return false;
    }
}

async function toggleLock(type) {
    if (typeof personasMod?.togglePersonaLock !== 'function') {
        toastr.warning('이 실리태번 버전에서는 고정 기능을 찾지 못했어요.');
        return;
    }
    if (type === 'character' && ctx().characterId === undefined) {
        toastr.info('캐릭터 채팅에서만 캐릭터에 고정할 수 있어요.');
        return;
    }
    try {
        await personasMod.togglePersonaLock(type);
    } catch (error) {
        console.error('[TopSlideBar] Persona lock failed', error);
        toastr.error('고정 상태를 바꾸지 못했어요.');
    }
}

// ---- extra personas: several user characters active in one chat at the same time

const EXTRA_KEY = 'tsb_extra_personas';
const EXTRA_PROMPT_KEY = 'tsb_extra_personas';

function extraPersonas() {
    const { chatMetadata, getCurrentChatId, powerUserSettings } = ctx();
    if (!getCurrentChatId?.()) return [];
    const list = chatMetadata?.[EXTRA_KEY];
    const personas = powerUserSettings?.personas ?? {};
    // Skip deleted personas and the one that is already the main persona
    return Array.isArray(list) ? list.filter(id => personas[id] && id !== currentPersonaId()) : [];
}

function setExtraPersonas(ids) {
    const c = ctx();
    if (!c.getCurrentChatId?.()) return;
    if (ids.length) c.chatMetadata[EXTRA_KEY] = ids;
    else delete c.chatMetadata[EXTRA_KEY];
    c.saveMetadataDebounced();
    updateExtraPrompt();
    updatePersona();
}

function toggleExtra(id) {
    if (id === currentPersonaId()) {
        toastr.info('지금 쓰는 페르소나는 이미 등장 중이에요.');
        return;
    }
    const list = extraPersonas();
    setExtraPersonas(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
}

/** Injects the extra personas' descriptions into the prompt (model-facing text is English, no behavior rules). */
function updateExtraPrompt() {
    const c = ctx();
    const ids = extraPersonas();
    const descriptions = c.powerUserSettings?.persona_descriptions ?? {};
    const personas = c.powerUserSettings?.personas ?? {};
    let text = '';
    if (ids.length) {
        const blocks = ids.map(id => {
            const name = String(personas[id]);
            // {{user}} inside an extra persona's own description refers to that persona
            const desc = String(descriptions[id]?.description ?? '').replace(/\{\{user\}\}/gi, name).trim();
            return `[${name}]\n${desc || '(no description)'}`;
        });
        // Neutral wording on purpose: whether the AI may write for user characters is left to the user's preset
        text = 'In addition to {{user}}, the following characters are also on the user\'s side of this roleplay, handled the same way as {{user}}:\n\n'
            + blocks.join('\n\n');
    }
    // position 0 = in prompt, depth 0, no WI scan, system role
    c.setExtensionPrompt(EXTRA_PROMPT_KEY, text, 0, 0, false, 0);
}

// ---- current persona card with an editable description

function buildPersonaCard(box) {
    const c = ctx();
    const id = currentPersonaId();
    const personas = c.powerUserSettings?.personas ?? {};
    const name = personas[id] || c.name1 || '';
    const textarea = make('textarea', { class: 'tsb_pdesc', rows: '4', placeholder: '페르소나 설명 없음' });
    textarea.value = String(c.powerUserSettings?.persona_description ?? '');
    const status = make('span', { class: 'tsb_psaved', text: '' });
    const pushToST = debounce(() => {
        const field = document.getElementById('persona_description');
        if (!field || currentPersonaId() !== id) return;
        // Let ST's own input handler update and save the persona
        $(field).val(textarea.value).trigger('input');
        status.textContent = '저장됨';
        setTimeout(() => { status.textContent = ''; }, 1500);
        updateExtraPrompt();
    }, 600);
    textarea.addEventListener('input', () => {
        status.textContent = '…';
        pushToST();
    });

    const extras = extraPersonas();
    let extraLine = null;
    if (extras.length) {
        extraLine = make('div', { class: 'tsb_pextra_line' }, [make('span', { class: 'tsb_pextra_title', text: '함께 등장' })]);
        for (const x of extras) {
            const chip = make('div', { class: 'tsb_xchip', tabindex: '0', title: `${personas[x]} 빼기` }, [make('span', { text: String(personas[x]) }), icon('fa-xmark')]);
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleExtra(x);
                el.dropdown.replaceChildren();
                buildPersonaList(el.dropdown);
            });
            extraLine.append(chip);
        }
    }

    const img = make('img', { class: 'tsb_pimg', alt: '', src: c.getThumbnailUrl('persona', id) });
    personaImgFallback(img, id);
    const head = make('div', { class: 'tsb_pcard_head' }, [img, make('div', { class: 'tsb_pcard_name', text: name }), status]);
    const card = make('div', { class: 'tsb_pcard' }, [head, textarea]);
    if (extraLine) card.append(extraLine);
    box.append(card);
}

function personaImgFallback(img, id) {
    img.addEventListener('error', () => {
        const alt = typeof personasMod?.getUserAvatar === 'function' ? personasMod.getUserAvatar(id) : '';
        if (alt && img.src !== new URL(alt, location.href).href) img.src = alt;
    }, { once: true });
}

/** Quick-Persona style avatar grid with search, favorites, locks and extra personas. */
function buildPersonaList(box) {
    const c = ctx();
    const personas = c.powerUserSettings?.personas ?? {};
    const current = currentPersonaId();
    const ids = Object.keys(personas);
    if (!ids.length) {
        box.append(make('div', { class: 'tsb_empty', text: '저장된 페르소나가 없어요.' }));
        return;
    }

    buildPersonaCard(box);

    let extraMode = false;
    const lockBar = make('div', { class: 'tsb_pbar' });
    const hint = make('div', { class: 'tsb_phint tsb_hidden', text: '탭하면 넣고, 다시 탭하면 빠져요. 다 고르면 완료를 눌러요.' });
    const renderLocks = () => {
        lockBar.replaceChildren();
        for (const [type, label, iconCls] of [['chat', '채팅 고정', 'fa-lock'], ['character', '캐릭터 고정', 'fa-link']]) {
            const on = lockState(type);
            const chip = make('div', { class: 'tsb_chip' + (on ? ' tsb_on' : ''), tabindex: '0', title: on ? `${label} 해제` : label }, [icon(iconCls), make('span', { text: label })]);
            chip.addEventListener('click', async (e) => {
                e.stopPropagation();
                await toggleLock(type);
                renderLocks();
            });
            lockBar.append(chip);
        }
        const extraChip = make('div', { class: 'tsb_chip' + (extraMode ? ' tsb_on' : ''), tabindex: '0', title: '이 채팅에 여러 페르소나 함께 등장' }, [icon('fa-user-plus'), make('span', { text: extraMode ? '완료' : '함께 등장' })]);
        extraChip.addEventListener('click', (e) => {
            e.stopPropagation();
            extraMode = !extraMode;
            hint.classList.toggle('tsb_hidden', !extraMode);
            renderLocks();
            render();
            if (!extraMode) {
                el.dropdown.replaceChildren();
                buildPersonaList(el.dropdown);
            }
        });
        lockBar.append(extraChip);
    };

    const filter = make('input', { class: 'tsb_pfilter', type: 'search', placeholder: '이름 · 설명 검색' });
    const viewBtn = make('div', { class: 'tsb_viewbtn', tabindex: '0' });
    const grid = make('div', { class: 'tsb_pgrid' });
    const descriptions = c.powerUserSettings?.persona_descriptions ?? {};
    const snippet = (id) => {
        const d = descriptions[id] ?? {};
        const text = String(d.description ?? '').replace(/\s+/g, ' ').trim();
        return { title: String(d.title ?? '').trim(), text };
    };
    const applyView = () => {
        const list = settings().personaView !== 'grid';
        grid.classList.toggle('tsb_plist', list);
        viewBtn.replaceChildren(icon(list ? 'fa-table-cells' : 'fa-list'));
        viewBtn.title = list ? '얼굴만 보기' : '설명과 같이 보기';
    };
    viewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        settings().personaView = settings().personaView === 'grid' ? 'list' : 'grid';
        save();
        applyView();
    });
    applyView();
    const searchRow = make('div', { class: 'tsb_psearch' }, [filter, viewBtn]);

    const render = () => {
        const q = filter.value.trim().toLowerCase();
        const extras = extraPersonas();
        grid.replaceChildren();
        const sorted = ids
            .filter(id => {
                if (!q) return true;
                const sn = snippet(id);
                return `${personas[id]} ${sn.title} ${sn.text}`.toLowerCase().includes(q);
            })
            .sort((a, b) => Number(extras.includes(b)) - Number(extras.includes(a)) || Number(isFav(b)) - Number(isFav(a)) || String(personas[a]).localeCompare(String(personas[b])));
        if (!sorted.length) {
            grid.append(make('div', { class: 'tsb_empty', text: '일치하는 페르소나가 없어요.' }));
            return;
        }
        for (const id of sorted) {
            const name = String(personas[id]);
            const star = make('div', { class: 'tsb_star' + (isFav(id) ? ' tsb_on' : ''), title: isFav(id) ? '즐겨찾기 해제' : '즐겨찾기' }, [icon('fa-star')]);
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFav(id);
                render();
            });
            const img = make('img', { class: 'tsb_pimg', alt: '', loading: 'lazy', src: c.getThumbnailUrl('persona', id) });
            personaImgFallback(img, id);
            const isExtra = extras.includes(id);
            const tile = make('div', {
                class: 'tsb_ptile' + (id === current ? ' tsb_active' : '') + (isExtra ? ' tsb_extra' : '') + (extraMode ? ' tsb_pick' : ''),
                tabindex: '0',
                title: name,
            }, [img]);
            const sn = snippet(id);
            const info = make('div', { class: 'tsb_pinfo' }, [make('span', { class: 'tsb_pname', text: name })]);
            if (sn.title) info.append(make('span', { class: 'tsb_ptitle', text: sn.title }));
            info.append(make('span', { class: 'tsb_psnip', text: sn.text || '설명 없음' }));
            tile.append(info, star);
            if (isExtra) {
                const badge = make('div', { class: 'tsb_extra_badge', title: '함께 등장에서 빼기' }, [icon('fa-xmark')]);
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleExtra(id);
                    el.dropdown.replaceChildren();
                    buildPersonaList(el.dropdown);
                });
                tile.append(badge);
            }
            tile.addEventListener('click', () => {
                if (extraMode) {
                    toggleExtra(id);
                    render();
                } else {
                    selectPersona(id);
                }
            });
            grid.append(tile);
        }
    };
    filter.addEventListener('input', render);
    renderLocks();
    render();

    box.append(lockBar, hint, searchRow, grid);
}

// ---------------------------------------------------------------- last reply info (tap the model name)

function lastAiMessage() {
    const { chat } = ctx();
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return { message: m, index: i };
    }
    return null;
}

function fmtSeconds(ms) {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    return n < 60000 ? `${(n / 1000).toFixed(1)}초` : `${Math.floor(n / 60000)}분 ${Math.round((n % 60000) / 1000)}초`;
}

function fmtTime(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return (sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Turns an internal API id (e.g. 'makersuite') into the name shown in ST's API menu (e.g. 'Google AI Studio'). */
function apiDisplayName(id) {
    if (!id) return '';
    const value = CSS.escape(String(id));
    const option = document.querySelector(`#chat_completion_source option[value="${value}"], #textgen_type option[value="${value}"], #main_api option[value="${value}"]`);
    const label = option?.textContent?.replace(/[[(].*?[\])]/g, '').trim();
    return label || String(id);
}

function buildReplyInfo(box) {
    const found = lastAiMessage();
    if (!found) {
        box.append(make('div', { class: 'tsb_empty', text: '아직 AI 답변이 없어요.' }));
        return;
    }
    const { message: m, index } = found;
    const extra = m.extra ?? {};
    const rows = [];
    const add = (label, value) => {
        if (value !== undefined && value !== null && String(value) !== '') rows.push([label, String(value)]);
    };

    add('모델', extra.model);
    add('API', apiDisplayName(extra.api));
    const start = m.gen_started ? new Date(m.gen_started).getTime() : NaN;
    const finish = m.gen_finished ? new Date(m.gen_finished).getTime() : NaN;
    add('생성 시간', isFinite(start) && isFinite(finish) ? fmtSeconds(finish - start) : '');
    add('생각한 시간', fmtSeconds(extra.reasoning_duration));
    add('첫 글자까지', fmtSeconds(extra.time_to_first_token));
    const tokenValue = make('span', { class: 'tsb_info_val', text: extra.token_count ? `${extra.token_count}` : '계산 중…' });
    const swipes = Array.isArray(m.swipes) ? m.swipes.length : 1;
    add('스와이프', `${(Number(m.swipe_id) || 0) + 1} / ${swipes}`);
    add('생성 시각', fmtTime(m.gen_finished || m.send_date));
    add('메시지 번호', `#${index}`);

    box.append(make('div', { class: 'tsb_dd_head' }, [make('span', { class: 'tsb_row_text', text: `마지막 답변 · ${m.name ?? ''}` })]));
    const table = make('div', { class: 'tsb_info' });
    for (const [label, value] of rows) {
        table.append(make('span', { class: 'tsb_info_key', text: label }), make('span', { class: 'tsb_info_val', text: value }));
    }
    table.append(make('span', { class: 'tsb_info_key', text: '토큰' }), tokenValue);
    box.append(table);

    // Token count is only stored when ST's message token counter is on; otherwise count it now
    if (!extra.token_count) {
        const counter = ctx().getTokenCountAsync;
        if (typeof counter === 'function') {
            counter(String(m.mes ?? ''), 0)
                .then((n) => { tokenValue.textContent = `${n} (지금 계산)`; })
                .catch(() => { tokenValue.textContent = '알 수 없음'; });
        } else {
            tokenValue.textContent = '알 수 없음';
        }
    }
}

// ---------------------------------------------------------------- new chat button: tap = new chat, long press = menu

/** The message that takes up the most space in the chat viewport. */
function mostVisibleMessage() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return null;
    const view = chatEl.getBoundingClientRect();
    let best = null;
    let bestArea = 0;
    for (const node of chatEl.querySelectorAll('.mes[mesid]')) {
        const r = node.getBoundingClientRect();
        if (r.bottom < view.top || r.top > view.bottom) continue;
        const visible = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
        if (visible > bestArea) {
            bestArea = visible;
            best = node;
        }
    }
    return best;
}

function clearBranchMark() {
    document.querySelectorAll('#chat .mes.tsb_branch_target').forEach(n => n.classList.remove('tsb_branch_target'));
}

async function branchFrom(mesId) {
    closeDropdown();
    clearBranchMark();
    try {
        await ctx().executeSlashCommandsWithOptions(`/branch-create ${mesId}`);
    } catch (error) {
        console.error('[TopSlideBar] Branch failed', error);
        toastr.error('분기를 만들지 못했어요.');
    }
}

function buildNewChatMenu(box) {
    const { chat } = ctx();
    const node = mostVisibleMessage();
    const mesId = node ? Number(node.getAttribute('mesid')) : NaN;

    const item = (iconCls, label, sub, onClick) => {
        const text = make('div', { class: 'tsb_menu_text' }, [make('span', { text: label })]);
        if (sub) text.append(make('span', { class: 'tsb_menu_sub', text: sub }));
        const row = make('div', { class: 'tsb_row tsb_menu_row', tabindex: '0' }, [icon(iconCls), text]);
        row.addEventListener('click', onClick);
        box.append(row);
    };

    if (!isNaN(mesId) && chat?.[mesId]) {
        const m = chat[mesId];
        const preview = String(m.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        node.classList.add('tsb_branch_target');
        item('fa-code-branch', `#${mesId}에서 분기`, `${m.name ?? ''}: ${preview}${preview.length >= 40 ? '…' : ''}`, () => branchFrom(mesId));
    }
    const lastId = (chat?.length ?? 0) - 1;
    if (lastId >= 0 && lastId !== mesId) {
        item('fa-code-branch', `마지막 메시지(#${lastId})에서 분기`, '', () => branchFrom(lastId));
    }
    const parent = ctx().chatMetadata?.main_chat;
    if (parent) {
        item('fa-arrow-turn-up', '원래 채팅으로 돌아가기', String(parent), async () => {
            closeDropdown();
            try {
                await ctx().executeSlashCommandsWithOptions('/checkpoint-exit');
            } catch (error) {
                console.error('[TopSlideBar] checkpoint-exit failed', error);
                toastr.error('원래 채팅으로 돌아가지 못했어요.');
            }
        });
    }
    item('fa-comment-medical', '새 채팅', '', () => {
        closeDropdown();
        clearBranchMark();
        document.getElementById('option_start_new_chat')?.click();
    });
    item('fa-xmark', '현재 채팅 닫기', '', () => {
        closeDropdown();
        clearBranchMark();
        document.getElementById('option_close_chat')?.click();
    });
}

function bindNewChatButton() {
    const btn = el.newChatBtn;
    let timer = null;
    let longPressed = false;
    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    btn.addEventListener('pointerdown', () => {
        longPressed = false;
        cancel();
        timer = setTimeout(() => {
            longPressed = true;
            if (navigator.vibrate) navigator.vibrate(15);
            openDropdown('newchat', buildNewChatMenu);
        }, 450);
    });
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    // Right-click on PC, and stop the phone's own long-press menu
    btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!longPressed) {
            longPressed = true;
            cancel();
            openDropdown('newchat', buildNewChatMenu);
        }
    });
    btn.addEventListener('click', () => {
        if (longPressed) {
            longPressed = false;
            return;
        }
        closeDropdown();
        document.getElementById('option_start_new_chat')?.click();
    });
}

// ---------------------------------------------------------------- activated lorebook entries

/** Entries activated during the last normal (non-quiet) generation. */
const lore = { entries: [], quiet: false };

function entryTitle(entry) {
    if (entry.comment) return String(entry.comment);
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    if (keys.length) return keys.join(', ');
    return `#${entry.uid}`;
}

function updateLore() {
    const count = lore.entries.length;
    el.loreCount.textContent = String(count);
    el.loreCount.classList.toggle('tsb_hidden', count === 0);
    el.loreBtn.classList.toggle('tsb_has', count > 0);
    el.loreBtn.title = (count ? `발동된 로어북 항목 ${count}개` : '발동된 로어북 항목 없음') + ' · 길게 누르면 미리보기';
    if (dropdownOwner === 'lore') {
        el.dropdown.replaceChildren();
        buildLoreList(el.dropdown);
    }
}

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun) return;
    lore.quiet = type === 'quiet';
    if (!lore.quiet) {
        lore.entries = [];
        updateLore();
    }
}

function onWorldInfoActivated(entries) {
    if (lore.quiet || !Array.isArray(entries)) return;
    lore.entries = entries.slice();
    updateLore();
}

function buildLoreList(box) {
    renderLoreEntries(box, lore.entries, '직전 생성에서 발동된 항목이 없어요.');
}

function renderLoreEntries(box, list, emptyText) {
    if (!list.length) {
        box.append(make('div', { class: 'tsb_empty', text: emptyText }));
        return;
    }
    const byWorld = new Map();
    for (const entry of list) {
        const world = String(entry.world ?? '(이름 없음)');
        if (!byWorld.has(world)) byWorld.set(world, []);
        byWorld.get(world).push(entry);
    }
    for (const [world, entries] of byWorld) {
        box.append(make('div', { class: 'tsb_dd_head' }, [
            make('span', { class: 'tsb_row_text', text: world }),
            make('span', { class: 'tsb_dd_count', text: String(entries.length) }),
        ]));
        entries.sort((a, b) => Number(!!b.constant) - Number(!!a.constant) || (a.order ?? 0) - (b.order ?? 0));
        for (const entry of entries) {
            const dot = make('span', { class: 'tsb_dot ' + (entry.constant ? 'tsb_dot_const' : 'tsb_dot_key'), title: entry.constant ? '상시 (파란불)' : '키워드 (초록불)' });
            box.append(make('div', { class: 'tsb_row tsb_readonly', title: entryTitle(entry) }, [dot, make('span', { class: 'tsb_row_text', text: entryTitle(entry) })]));
        }
    }
}

// ---- preview: which entries would trigger on the next generation (dry run, no API call)

let wiMod = null;

async function previewLoreEntries() {
    if (typeof wiMod?.checkWorldInfo !== 'function') throw new Error('checkWorldInfo not available');
    const c = ctx();
    const includeNames = wiMod.world_info_include_names ?? true;
    const fmt = (name, mes) => (includeNames ? `${name}: ${mes}` : String(mes ?? ''));
    const lines = (c.chat ?? []).filter(m => m && !m.is_system).map(m => fmt(m.name, m.mes));
    // Include what is typed in the input box but not sent yet
    const pending = String(document.getElementById('send_textarea')?.value ?? '').trim();
    if (pending) lines.push(fmt(c.name1, pending));
    lines.reverse(); // ST scans newest first

    const ch = c.characterId !== undefined ? (c.characters?.[c.characterId] ?? {}) : {};
    const globalScanData = {
        trigger: 'normal',
        personaDescription: String(c.powerUserSettings?.persona_description ?? ''),
        characterDescription: String(ch.description ?? ''),
        characterPersonality: String(ch.personality ?? ''),
        characterDepthPrompt: String(ch.data?.extensions?.depth_prompt?.prompt ?? ''),
        scenario: String(ch.scenario ?? ''),
        creatorNotes: String(ch.data?.creator_notes ?? ''),
    };
    const result = await wiMod.checkWorldInfo(lines, Number(c.maxContext) || 8192, true, globalScanData);
    return { entries: Array.from(result?.allActivatedEntries ?? []), withInput: !!pending };
}

function buildLorePreview(box) {
    const head = make('div', { class: 'tsb_dd_head tsb_preview_head' }, [icon('fa-eye'), make('span', { class: 'tsb_row_text', text: '미리보기 · 계산 중…' })]);
    const body = make('div');
    box.append(head, body);
    previewLoreEntries()
        .then(({ entries, withInput }) => {
            if (dropdownOwner !== 'lorepreview') return;
            head.querySelector('.tsb_row_text').textContent = `미리보기 · ${entries.length}개${withInput ? ' (입력 중인 글 포함)' : ''}`;
            renderLoreEntries(body, entries, '다음 생성에서 발동될 항목이 없어요.');
            body.append(make('div', { class: 'tsb_preview_note', text: '확률·지속 효과가 있는 항목은 실제와 다를 수 있어요.' }));
        })
        .catch((error) => {
            console.error('[TopSlideBar] Lorebook preview failed', error);
            head.querySelector('.tsb_row_text').textContent = '미리보기';
            body.append(make('div', { class: 'tsb_empty', text: '미리보기를 계산하지 못했어요.' }));
        });
}

/** Tap runs onTap, long press (or right-click) runs onLong. */
function bindLongPress(btn, onTap, onLong) {
    let timer = null;
    let fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    btn.addEventListener('pointerdown', () => {
        fired = false;
        cancel();
        timer = setTimeout(() => {
            fired = true;
            if (navigator.vibrate) navigator.vibrate(15);
            onLong();
        }, 450);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(type, cancel);
    btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!fired) {
            fired = true;
            cancel();
            onLong();
        }
    });
    btn.addEventListener('click', () => {
        if (fired) {
            fired = false;
            return;
        }
        onTap();
    });
}

// ---------------------------------------------------------------- auto retry

/**
 * When enabled, a failed generation (API error such as 429, or an empty reply) is retried
 * automatically until a reply arrives or the retry limit is reached.
 * Pressing ST's stop button cancels the loop.
 */
const retry = { snap: null, attempt: 0, timer: null, userStopped: false };
const RETRY_TYPES = ['normal', 'swipe', 'regenerate'];

function updateRetryButton() {
    const s = settings();
    el.retryBtn.classList.toggle('tsb_on', !!s.retryOn);
    const waiting = retry.timer !== null || retry.attempt > 0;
    el.retryCount.textContent = String(retry.attempt);
    el.retryCount.classList.toggle('tsb_hidden', !waiting);
    el.retryBtn.title = s.retryOn
        ? `자동 재시도 켜짐 (최대 ${s.retryMax}회)` + (waiting ? ` · 지금 ${retry.attempt}번째 재시도` : '')
        : '자동 재시도 꺼짐';
}

function cancelRetry(reason) {
    if (retry.timer) clearTimeout(retry.timer);
    const wasRunning = retry.timer !== null || retry.attempt > 0;
    retry.timer = null;
    retry.attempt = 0;
    retry.snap = null;
    updateRetryButton();
    if (wasRunning && reason) toastr.info(reason, '자동 재시도');
}

function toggleRetry() {
    const s = settings();
    s.retryOn = !s.retryOn;
    save();
    if (!s.retryOn) cancelRetry('자동 재시도를 껐어요.');
    else toastr.success(`빈 응답이나 오류가 나면 최대 ${s.retryMax}회 다시 시도해요.`, '자동 재시도 켜짐');
    updateRetryButton();
}

function lastMessage() {
    const { chat } = ctx();
    return chat?.[chat.length - 1];
}

function onRetryGenStarted(type, _options, dryRun) {
    if (dryRun || !RETRY_TYPES.includes(type)) return;
    retry.userStopped = false;
    const { chat } = ctx();
    const last = lastMessage();
    // Keep the snapshot of the first attempt so later attempts compare against the original state
    if (retry.attempt === 0 || !retry.snap) {
        retry.snap = {
            type,
            length: chat.length,
            swipes: Array.isArray(last?.swipes) ? last.swipes.length : 0,
        };
    }
}

function isReplyOk(snap) {
    const { chat } = ctx();
    const last = lastMessage();
    if (!last || last.is_user || last.is_system) return false;
    if (!String(last.mes ?? '').trim()) return false;
    if (snap.type === 'normal') return chat.length > snap.length || snap.length === 0;
    // swipe / regenerate: a new swipe should exist, or the message text was replaced
    const swipes = Array.isArray(last.swipes) ? last.swipes.length : 0;
    return swipes > snap.swipes || snap.type === 'regenerate';
}

async function doRetry() {
    retry.timer = null;
    const c = ctx();
    const last = lastMessage();
    try {
        if (last && !last.is_user && !last.is_system) {
            // An AI message is last (empty reply or failed swipe): make a new swipe on it
            await c.swipe.to(null, 'right', { message: last, forceSwipeId: Array.isArray(last.swipes) ? last.swipes.length : 1 });
        } else {
            // The user's message is last (the reply never arrived): generate again
            await c.generate('normal');
        }
    } catch (error) {
        console.warn('[TopSlideBar] Retry attempt threw', error);
    }
}

function onRetryGenEnded() {
    const snap = retry.snap;
    if (!snap || !settings().retryOn) return;
    // Let ST finish saving the message first
    setTimeout(() => {
        if (retry.snap !== snap) return;
        if (retry.userStopped) {
            cancelRetry('중지 버튼을 눌러서 재시도를 멈췄어요.');
            return;
        }
        if (isReplyOk(snap)) {
            if (retry.attempt > 0) toastr.success(`${retry.attempt}번 재시도 끝에 답변을 받았어요.`, '자동 재시도');
            cancelRetry();
            return;
        }
        const s = settings();
        if (retry.attempt >= s.retryMax) {
            cancelRetry();
            toastr.error(`${s.retryMax}번 재시도했지만 답변을 받지 못했어요.`, '자동 재시도');
            return;
        }
        retry.attempt++;
        // Back off a little more on each attempt (helps with 429)
        const delay = Math.min(60, s.retryDelay * Math.pow(1.5, retry.attempt - 1));
        toastr.info(`${Math.round(delay)}초 뒤 다시 시도해요 (${retry.attempt}/${s.retryMax})`, '자동 재시도', { timeOut: delay * 1000 });
        retry.timer = setTimeout(doRetry, delay * 1000);
        updateRetryButton();
    }, 600);
}

function onRetryStopped() {
    retry.userStopped = true;
    if (retry.timer) cancelRetry('재시도를 멈췄어요.');
}

// ---------------------------------------------------------------- search

function clearHighlight() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete(HIGHLIGHT_NAME);
    document.querySelectorAll('#chat .mes.tsb_hit').forEach(node => node.classList.remove('tsb_hit'));
}

function openSearch() {
    closeDropdown();
    el.searchRow.classList.remove('tsb_hidden');
    el.searchInput.focus();
}

function closeSearch() {
    el.searchRow?.classList.add('tsb_hidden');
    if (el.searchInput) el.searchInput.value = '';
    search.query = '';
    search.hits = [];
    search.pos = -1;
    if (el.searchCount) el.searchCount.textContent = '';
    clearHighlight();
}

/** Searches the chat data in memory. No DOM work happens here, so it stays fast on long chats. */
function runSearch() {
    const query = el.searchInput.value.trim().toLowerCase();
    search.query = query;
    search.hits = [];
    search.pos = -1;
    clearHighlight();
    if (!query) {
        el.searchCount.textContent = '';
        return;
    }
    const { chat } = ctx();
    for (let i = 0; i < chat.length; i++) {
        const text = chat[i]?.mes;
        if (typeof text === 'string' && text.toLowerCase().includes(query)) search.hits.push(i);
    }
    if (!search.hits.length) {
        el.searchCount.textContent = '0건';
        return;
    }
    // Start from the most recent match
    goToHit(search.hits.length - 1);
}

async function ensureRendered(mesId) {
    const find = () => document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    let node = find();
    if (node) return node;
    const ids = Array.from(document.querySelectorAll('#chat .mes')).map(n => Number(n.getAttribute('mesid'))).filter(n => !isNaN(n));
    const first = ids.length ? Math.min(...ids) : ctx().chat.length;
    const need = first - mesId;
    if (need > 0 && typeof scriptMod?.showMoreMessages === 'function') {
        try {
            await scriptMod.showMoreMessages(need);
        } catch (error) {
            console.warn('[TopSlideBar] Could not load older messages', error);
        }
        node = find();
    }
    return node;
}

function highlightIn(node) {
    if (!(window.CSS && CSS.highlights && typeof Highlight === 'function')) return;
    const target = node.querySelector('.mes_text');
    if (!target) return;
    const ranges = [];
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = walker.currentNode;
        const text = (textNode.nodeValue ?? '').toLowerCase();
        let from = 0;
        let at = text.indexOf(search.query, from);
        while (at !== -1) {
            const range = new Range();
            range.setStart(textNode, at);
            range.setEnd(textNode, at + search.query.length);
            ranges.push(range);
            from = at + search.query.length;
            at = text.indexOf(search.query, from);
        }
    }
    if (ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

async function goToHit(pos) {
    if (!search.hits.length) return;
    const total = search.hits.length;
    search.pos = (pos + total) % total;
    el.searchCount.textContent = `${search.pos + 1}/${total}`;
    clearHighlight();
    const mesId = search.hits[search.pos];
    const node = await ensureRendered(mesId);
    if (!node) {
        toastr.info(`#${mesId} 메시지를 화면에 불러오지 못했어요. 위로 스크롤해서 이전 메시지를 불러온 뒤 다시 시도해 주세요.`);
        return;
    }
    node.classList.add('tsb_hit');
    node.scrollIntoView({ block: 'center', behavior: 'auto' });
    highlightIn(node);
}

function bindSearch() {
    const runDebounced = debounce(runSearch, 600);
    el.searchBtn.addEventListener('click', () => {
        if (el.searchRow.classList.contains('tsb_hidden')) openSearch();
        else closeSearch();
    });
    el.searchInput.addEventListener('input', runDebounced);
    el.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (el.searchInput.value.trim().toLowerCase() === search.query && search.hits.length) {
                goToHit(search.pos + (e.shiftKey ? 1 : -1));
            } else {
                runSearch();
            }
        }
        if (e.key === 'Escape') closeSearch();
    });
    el.searchPrev.addEventListener('click', () => goToHit(search.pos - 1));
    el.searchNext.addEventListener('click', () => goToHit(search.pos + 1));
    el.searchClose.addEventListener('click', closeSearch);
}

// ---------------------------------------------------------------- context warning

/** True when at least one visible (non-hidden) message did not fit into the last prompt. */
function isContextOverflowing() {
    const { chat, chatMetadata } = ctx();
    if (!Array.isArray(chat) || !chat.length) return false;

    const marker = document.querySelector('#chat .mes.lastInContext');
    const firstShown = document.querySelector('#chat .mes');
    if (marker && !(marker === firstShown && Number(marker.getAttribute('mesid')) > 0)) {
        const id = Number(marker.getAttribute('mesid'));
        if (isNaN(id)) return false;
        return chat.slice(0, id).some(m => m && !m.is_system);
    }

    // Marker is missing or sits on the first loaded message (ambiguous): fall back to saved metadata
    const lastId = Number(chatMetadata?.lastInContextMessageId);
    if (!lastId || isNaN(lastId)) return false;
    const visible = chat.filter(m => m && !m.is_system).length;
    return visible > chat.length - lastId;
}

function updateWarn() {
    if (!el.warn) return;
    const on = settings().show.ctxWarn && isContextOverflowing();
    el.warn.classList.toggle('tsb_hidden', !on);
    el.handleWarn.classList.toggle('tsb_hidden', !on);
}
const updateWarnDebounced = debounce(updateWarn, 700);

// ---------------------------------------------------------------- settings UI

function buildSettings() {
    const host = document.getElementById('extensions_settings2');
    if (!host) return;
    const s = settings();

    const content = make('div', { class: 'inline-drawer-content' });

    const modeSelect = make('select', { class: 'text_pole', id: 'tsb_set_mode' });
    for (const [value, label] of [['both', '손잡이 탭 + 스와이프'], ['tap', '손잡이 탭만'], ['swipe', '스와이프만'], ['always', '항상 열어두기 (접지 않음)']]) {
        const option = make('option', { value, text: label });
        if (s.openMode === value) option.selected = true;
        modeSelect.append(option);
    }
    modeSelect.addEventListener('change', () => {
        settings().openMode = modeSelect.value;
        applyOpenMode();
        save();
    });
    content.append(make('label', { for: 'tsb_set_mode', text: '여는 방식' }), modeSelect);
    content.append(make('small', { text: '스와이프: 손잡이를 아래로 밀면 열리고, 바를 위로 밀면 닫혀요. PC에서는 항상 클릭으로 열 수 있어요.' }));
    const acBox = make('input', { type: 'checkbox' });
    acBox.checked = !!s.autoClose;
    acBox.addEventListener('change', () => {
        settings().autoClose = acBox.checked;
        save();
        applyOpenMode();
        if (el.root.classList.contains('tsb_open') !== settings().open) el.root.classList.toggle('tsb_open', settings().open);
    });
    content.append(make('label', { class: 'checkbox_label' }, [acBox, make('span', { text: '열어둔 뒤 바깥을 터치하면 자동으로 닫기 (열려 있는 동안 손잡이 숨김)' })]));

    content.append(make('div', { class: 'tsb_set_title', text: '채팅별 설정 기억' }));
    const memBox = make('input', { type: 'checkbox' });
    memBox.checked = !!s.chatMemory;
    memBox.addEventListener('change', () => {
        settings().chatMemory = memBox.checked;
        save();
        if (memBox.checked) mem.readyFor = ctx().getCurrentChatId?.() ?? null;
        updatePinButton();
    });
    content.append(make('label', { class: 'checkbox_label' }, [memBox, make('span', { text: '채팅마다 API · 프리셋 · 모델 · 프롬프트 토글을 기억하고 다시 열 때 되돌리기' })]));
    content.append(make('small', { text: '그 채팅에서 마지막으로 쓴 설정을 자동으로 기억해요. 처음 여는 채팅은 지금 설정 그대로 두고 기억을 시작해요. 📌을 누르면 그 채팅의 기억을 지워요.' }));

    content.append(make('div', { class: 'tsb_set_title', text: '자동 재시도' }));
    const numField = (key, label, min, max) => {
        const input = make('input', { type: 'number', class: 'text_pole', min: String(min), max: String(max), step: '1' });
        input.value = String(s[key]);
        input.addEventListener('change', () => {
            const value = Math.min(max, Math.max(min, Math.round(Number(input.value) || min)));
            input.value = String(value);
            settings()[key] = value;
            save();
            updateRetryButton();
        });
        content.append(make('label', { text: label }), input);
    };
    numField('retryMax', '최대 재시도 횟수', 1, 30);
    numField('retryDelay', '첫 재시도까지 대기 (초, 회차마다 1.5배)', 1, 60);
    content.append(make('small', { text: 'API 오류(429 등)나 빈 응답이 오면 자동으로 다시 생성해요. ST의 중지 버튼을 누르면 멈춰요. 이어쓰기와 백그라운드 생성은 건드리지 않아요.' }));

    content.append(make('div', { class: 'tsb_set_title', text: '표시할 항목' }));
    for (const [key, label] of Object.entries(ITEM_LABELS)) {
        const box = make('input', { type: 'checkbox' });
        box.checked = !!s.show[key];
        box.addEventListener('change', () => {
            settings().show[key] = box.checked;
            save();
            applyVisibility();
        });
        content.append(make('label', { class: 'checkbox_label' }, [box, make('span', { text: label })]));
    }

    const drawer = make('div', { class: 'inline-drawer' }, [
        make('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
            make('b', { text: 'Top Slide Bar' }),
            make('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
        ]),
        content,
    ]);
    host.append(make('div', { id: 'tsb_settings' }, [drawer]));
}

// ---------------------------------------------------------------- init

function onEvents(names, handler) {
    const { eventSource, event_types } = ctx();
    for (const name of names) {
        if (event_types[name]) eventSource.on(event_types[name], handler);
    }
}

async function init() {
    if (!buildBar()) return;

    // Core modules: path is relative to scripts/extensions/third-party/<folder>/
    personasMod = await import('../../../personas.js').catch(() => null);
    scriptMod = await import('../../../../script.js').catch(() => null);
    openaiMod = await import('../../../openai.js').catch(() => null);
    wiMod = await import('../../../world-info.js').catch(() => null);

    applyOpenMode();
    bindSlide();
    bindAutoClose();
    bindSearch();
    buildSettings();
    applyVisibility();

    el.personaBtn.addEventListener('click', () => openDropdown('persona', buildPersonaList));
    bindLongPress(el.loreBtn, () => openDropdown('lore', buildLoreList), () => openDropdown('lorepreview', buildLorePreview));
    el.model.addEventListener('click', () => openDropdown('info', buildReplyInfo));
    el.retryBtn.addEventListener('click', toggleRetry);
    el.pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onPinClick();
    });
    onEvents(['SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'MAIN_API_CHANGED'], rememberSetupDebounced);
    onEvents(['GENERATION_STARTED'], (type, _o, dryRun) => {
        if (!dryRun && type !== 'quiet') rememberSetup(false, true);
    });
    updateRetryButton();
    bindNewChatButton();
    el.warn.addEventListener('click', () => toastr.warning('일부 메시지가 컨텍스트에 들어가지 못했어요.'));

    // Close the dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!dropdownOwner) return;
        if (e.target instanceof Element && e.target.closest('#tsb_root')) return;
        closeDropdown();
    });

    const ready = () => {
        bindProfiles();
        restoreSetup();
        updateModel();
        updatePersona();
        updateExtraPrompt();
        updateLore();
        updateWarn();
    };
    const { eventSource, event_types } = ctx();
    eventSource.once(event_types.APP_READY, ready);

    onEvents(['ONLINE_STATUS_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED', 'MAIN_API_CHANGED'], updateModelDebounced);
    onEvents(['PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED', 'CHAT_CHANGED'], () => {
        updatePersona();
        updateExtraPrompt();
    });
    onEvents(['GENERATION_STARTED'], (type, options, dryRun) => {
        onGenerationStarted(type, options, dryRun);
        onRetryGenStarted(type, options, dryRun);
    });
    onEvents(['GENERATION_ENDED'], onRetryGenEnded);
    onEvents(['GENERATION_STOPPED'], onRetryStopped);
    onEvents(['WORLD_INFO_ACTIVATED'], onWorldInfoActivated);
    onEvents(['MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'GENERATION_ENDED'], debounce(() => {
        if (dropdownOwner !== 'info') return;
        el.dropdown.replaceChildren();
        buildReplyInfo(el.dropdown);
    }, 500));
    onEvents(['GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED', 'CHAT_CHANGED'], updateWarnDebounced);
    onEvents(['CHAT_CHANGED'], () => {
        lore.entries = [];
        updateLore();
        cancelRetry();
        closeDropdown();
        restoreSetup();
        closeSearch();
    });
}

init().catch(error => console.error('[TopSlideBar] init failed', error));
