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
    mapTarget: 'chats', // 'chats' | 'subway'
    slotAction: 'toggles', // (old, only used to migrate to barButtons)
    barButtons: null,      // [{ key, on }] order and visibility of the right-hand buttons
    newChatTap: 'new',
    recentModels: {},      // { api: [model ids] } most recent first, for the quick model switch
    barColor: '',          // '' = follow the theme
    barOpacity: 100,       // %
    barScale: 100,         // %     // what a tap on the new-chat button does: 'new' | 'menu' | 'branchVisible'
    toggleFavs: {},        // { presetName: [prompt identifiers] }
    presetFavs: [],
    personaVariants: {},   // { avatarId: [{ name, text }] }, the first one is '기본'
    personaGallery: {},
    translateProfileId: '', // connection profile used for persona translation
    translateCache: {},     // { avatarId: { en, ko } } last English -> Korean reading view    // { avatarId: [file path in user/files] } extra profile pictures
    personaGalleryActive: {}, // { avatarId: path } picture currently in use        // favourite preset names, shown when the preset pill is tapped
    toggleSets: [],        // [{ name, preset, states: { identifier: bool } }]
    retryOn: false,
    retryCleanup: true,      // remove failed swipes once a good reply arrives
    retryBackoff: false,     // false = same wait every time, true = a bit longer each time
    retryMinChars: 0,        // 0 = off; replies shorter than this count as failed
    retryRefusalOn: false,
    retryRefusals: "I can't help with that\nI cannot help with that\nI'm sorry, but\nI can't assist\n죄송하지만\n도와드릴 수 없",
    retryMax: 5,
    retryDelay: 3,
    show: {
        profile: true,
        model: true,
        persona: true,
        lorebook: true,
        autoRetry: true,
        search: true,
        chatMap: true,
        newChat: true,
        ctxWarn: true,
        chatMemory: true,
    },
});

const ITEM_LABELS = {
    profile: '연결 프로필',
    model: '현재 모델명',
    ctxWarn: '컨텍스트 초과 경고',
    chatMemory: '채팅별 설정 표시 (📌)',
};

/** Every button the right side of the bar can hold, in the default order. */
const BAR_BUTTONS = [
    { key: 'persona', label: '페르소나', hint: '탭: 페르소나 창' },
    { key: 'lore', label: '로어북', hint: '탭: 발동 항목 · 길게: 미리보기' },
    { key: 'retry', label: '자동 재시도', hint: '탭: 켜기/끄기 · 길게: 기록' },
    { key: 'toggles', label: '프롬프트 토글', hint: '탭: 프리셋 · 토글 창' },
    { key: 'chats', label: '채팅 목록', hint: '탭/길게: 채팅 목록 · 깡통 노선도 (설정에서 우선 선택)' },
    { key: 'newchat', label: '새 채팅', hint: '탭: 고른 동작 · 길게: 분기 메뉴' },
    { key: 'search', label: '채팅 검색', hint: '탭: 채팅 전체 검색' },
    { key: 'continue', label: '이어쓰기', hint: '탭: 마지막 답 이어서 쓰기' },
    { key: 'deleteMode', label: '삭제 모드', hint: '탭: 실리 삭제 모드 (누른 메시지부터 아래 전부)' },
    { key: 'deleteFrom', label: '여기부터 삭제', hint: '탭: 화면 메시지부터 끝까지 삭제 (확인 후)' },
    { key: 'deleteLast', label: '마지막 메시지 삭제', hint: '탭: 마지막 메시지 하나 삭제 (확인 후)' },
    { key: 'bottom', label: '맨 아래로', hint: '탭: 맨 아래 · 길게: 맨 위' },
    { key: 'info', label: '최근 답변 정보', hint: '탭: 모델 · 시간 · 토큰' },
    { key: 'chatfile', label: '채팅 파일', hint: '탭: 현재 채팅 내보내기 · 채팅 불러오기' },
];
const DEFAULT_ON = ['persona', 'lore', 'retry', 'toggles', 'chats', 'newchat'];

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
    el.profileSelect = make('select', { id: 'tsb_profile', class: 'tsb_profile_select', title: '연결 프로필 전환' });
    el.profileLabel = make('span', { class: 'tsb_profile_label', text: '' });
    el.profileBox = make('div', { class: 'tsb_profile_box', title: '탭하면 연결 프로필 전체 이름 · 전환', tabindex: '0' }, [el.profileLabel]);
    // Full-width row under the bar, like the search row
    // second pin inside the row: on phones the bar hides its own pin to leave room for the profile name
    el.pinBtnRow = make('div', { class: 'tsb_pin tsb_pin_row', title: '채팅별 설정', tabindex: '0' }, [icon('fa-thumbtack')]);
    el.setBtnRow = make('div', { class: 'tsb_setbtn tsb_setbtn_row', title: '상단바 설정', tabindex: '0' }, [icon('fa-sliders')]);
    el.profileRow = make('div', { id: 'tsb_profile_row', class: 'tsb_hidden' }, [icon('fa-plug'), el.profileSelect, el.pinBtnRow, el.setBtnRow]);
    el.pinBtn = make('div', { class: 'tsb_pin tsb_pin_bar', title: '채팅별 설정', tabindex: '0' }, [icon('fa-thumbtack')]);
    el.setBtn = make('div', { class: 'tsb_setbtn tsb_setbtn_bar', title: '상단바 설정', tabindex: '0' }, [icon('fa-sliders')]);
    el.profileWrap = make('div', { class: 'tsb_item tsb_profile_wrap', 'data-item': 'profile' }, [el.setBtn, el.profileBox, el.pinBtn]);
    el.model = make('div', { class: 'tsb_item tsb_model', 'data-item': 'model', title: '현재 모델 (탭하면 마지막 답변 정보)', tabindex: '0' });
    el.warn = make('div', { class: 'tsb_item tsb_btn tsb_warn tsb_hidden', 'data-item': 'ctxWarn', title: '컨텍스트에 안 들어간 메시지가 있어요', tabindex: '0' }, [icon('fa-triangle-exclamation')]);
    // shown only when the profile pill is turned off, so the settings can always be reached
    el.setBtnLone = make('div', { class: 'tsb_item tsb_btn tsb_setbtn_lone', title: '상단바 설정', tabindex: '0' }, [icon('fa-sliders')]);
    const group1 = make('div', { class: 'tsb_group tsb_group_main' }, [el.setBtnLone, el.profileWrap, el.model, el.warn]);

    // Right: icon buttons
    el.personaImg = make('img', { class: 'tsb_avatar', alt: '' });
    el.personaName = make('span', { class: 'tsb_label' });
    el.personaBtn = make('div', { class: 'tsb_item tsb_btn tsb_persona', title: '페르소나 전환', tabindex: '0' }, [el.personaImg, el.personaName]);
    el.loreCount = make('span', { class: 'tsb_badge tsb_hidden', text: '0' });
    el.loreBtn = make('div', { class: 'tsb_item tsb_btn', title: '발동된 로어북 항목 (길게 누르면 다음 생성 미리보기)', tabindex: '0' }, [icon('fa-book-atlas'), el.loreCount]);
    el.retryCount = make('span', { class: 'tsb_badge tsb_hidden', text: '' });
    el.retryBtn = make('div', { class: 'tsb_item tsb_btn', title: '자동 재시도', tabindex: '0' }, [icon('fa-repeat'), el.retryCount]);
    const btn = (cls, title, children) => make('div', { class: `tsb_item tsb_btn ${cls}`, title, tabindex: '0' }, children);
    el.slotIcon = icon('fa-magnifying-glass');
    el.searchBtn = btn('', '채팅 전체 검색', [el.slotIcon]);
    el.togglesBtn = btn('', '프리셋 · 프롬프트 토글', [icon('fa-toggle-on')]);
    el.continueBtn = btn('', '이어쓰기', [icon('fa-arrow-right')]);
    el.mapIcon = icon('fa-address-book');
    el.mapBtn = btn('', '채팅 목록', [el.mapIcon]);
    el.newChatBtn = btn('', '새 채팅 (길게 누르면 분기 · 닫기 메뉴)', [icon('fa-comment-medical')]);
    el.deleteModeBtn = btn('', '삭제 모드 (누른 메시지부터 아래 전부 삭제)', [icon('fa-eraser')]);
    el.deleteFromBtn = btn('', '화면 메시지부터 끝까지 삭제', [icon('fa-scissors')]);
    el.deleteLastBtn = btn('', '마지막 메시지 삭제', [icon('fa-delete-left')]);
    el.bottomBtn = btn('', '맨 아래로 (길게 누르면 맨 위로)', [icon('fa-angles-down')]);
    el.infoBtn = btn('', '최근 답변 정보', [icon('fa-circle-info')]);
    el.chatFileBtn = btn('', '채팅 파일 내보내기 · 불러오기', [icon('fa-file-export')]);
    el.barEls = {
        persona: el.personaBtn, lore: el.loreBtn, retry: el.retryBtn, toggles: el.togglesBtn, chats: el.mapBtn,
        newchat: el.newChatBtn, search: el.searchBtn, continue: el.continueBtn,
        deleteMode: el.deleteModeBtn, deleteFrom: el.deleteFromBtn, deleteLast: el.deleteLastBtn,
        bottom: el.bottomBtn, info: el.infoBtn, chatfile: el.chatFileBtn,
    };
    const group2 = make('div', { class: 'tsb_group tsb_group_actions' });
    el.group2 = group2;

    // Search row
    el.searchInput = make('input', { id: 'tsb_search_input', type: 'search', placeholder: '채팅 전체 검색', enterkeyhint: 'search' });
    el.searchCount = make('span', { class: 'tsb_search_count', text: '' });
    el.searchPrev = make('div', { class: 'tsb_btn', title: '이전 결과 (더 오래된 메시지)', tabindex: '0' }, [icon('fa-chevron-up')]);
    el.searchNext = make('div', { class: 'tsb_btn', title: '다음 결과 (더 최근 메시지)', tabindex: '0' }, [icon('fa-chevron-down')]);
    el.searchClose = make('div', { class: 'tsb_btn', title: '검색 닫기', tabindex: '0' }, [icon('fa-xmark')]);
    el.searchRow = make('div', { id: 'tsb_search_row', class: 'tsb_hidden' }, [el.searchInput, el.searchCount, el.searchPrev, el.searchNext, el.searchClose]);

    el.inner.append(group1, group2, el.profileRow, el.searchRow);
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

/** Order/visibility of the right-hand buttons; first run builds it from the older settings. */
function barButtons() {
    const s = settings();
    if (!Array.isArray(s.barButtons)) {
        const old = s.show || {};
        const slot = { toggles: 'toggles', search: 'search', continue: 'continue' }[s.slotAction] || 'toggles';
        const on = new Set(DEFAULT_ON.filter(k => k !== 'toggles').concat(slot));
        if (old.persona === false) on.delete('persona');
        if (old.lorebook === false) on.delete('lore');
        if (old.autoRetry === false) on.delete('retry');
        if (old.search === false) on.delete(slot);
        if (old.chatMap === false) on.delete('chats');
        if (old.newChat === false) on.delete('newchat');
        const order = ['persona', 'lore', 'retry', slot, 'chats', 'newchat'];
        for (const b of BAR_BUTTONS) if (!order.includes(b.key)) order.push(b.key);
        s.barButtons = order.map(key => ({ key, on: on.has(key) }));
        save();
    }
    // the separate 깡통 노선도 button was merged into the chat-list button
    const oldSubway = s.barButtons.find(x => x.key === 'subway');
    if (oldSubway) {
        const chats = s.barButtons.find(x => x.key === 'chats');
        if (oldSubway.on && chats && !chats.on) { chats.on = true; s.mapTarget = 'subway'; }
        s.barButtons = s.barButtons.filter(x => x.key !== 'subway');
        save();
    }
    // add buttons that newer versions introduced
    for (const b of BAR_BUTTONS) if (!s.barButtons.some(x => x.key === b.key)) s.barButtons.push({ key: b.key, on: false });
    s.barButtons = s.barButtons.filter(x => BAR_BUTTONS.some(b => b.key === x.key));
    return s.barButtons;
}

/** Colour, opacity and size of the bar (settings → 바 꾸미기). */
function applyBarLook() {
    const s = settings();
    const root = el.root;
    if (!root) return;
    const base = s.barColor || 'var(--SmartThemeBlurTintColor)';
    const alpha = Math.min(100, Math.max(20, Number(s.barOpacity) || 100));
    root.style.setProperty('--tsb-bg', `color-mix(in srgb, ${base} ${alpha}%, transparent)`);
    root.style.setProperty('--tsb-bg-solid', base);
    const scale = Math.min(130, Math.max(80, Number(s.barScale) || 100)) / 100;
    root.style.zoom = scale === 1 ? '' : String(scale);
}

/** A row of tappable choices (instead of a phone's pop-up select). */
function choiceGroup(options, current, onPick) {
    const wrap = make('div', { class: 'tsb_choices' });
    for (const [value, label] of options) {
        const chip = make('div', { class: 'tsb_choice' + (value === current ? ' tsb_choice_on' : ''), tabindex: '0', text: label });
        chip.addEventListener('click', () => {
            wrap.querySelectorAll('.tsb_choice').forEach(c => c.classList.toggle('tsb_choice_on', c === chip));
            onPick(value);
        });
        wrap.append(chip);
    }
    return wrap;
}

function arrangeButtons() {
    const list = barButtons();
    el.group2.replaceChildren(...list.filter(x => x.on).map(x => el.barEls[x.key]).filter(Boolean));
    if (!list.some(x => x.key === 'search' && x.on)) closeSearch();
}

function applyVisibility() {
    const s = settings();
    el.root.querySelectorAll('[data-item]').forEach(node => {
        node.classList.toggle('tsb_off', !s.show[node.getAttribute('data-item')]);
    });
    el.root.classList.toggle('tsb_noprofile', !s.show.profile);
    if (el.pinBtn) updatePinButton();
    updateWarn();
}

function setOpen(open) {
    settings().open = open;
    el.root.classList.toggle('tsb_open', open);
    if (!open) {
        closeDropdown();
        toggleProfileRow(false);
    }
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
        if (settings().openMode === 'always') return;
        if (e.target instanceof Element && e.target.closest('#tsb_dropdown, select, input')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });
    // react as soon as the finger has moved a little, mostly up/down (no need to lift it first)
    const judge = (touch) => {
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dy) < 12 || Math.abs(dy) < Math.abs(dx) * 0.7) return false;
        // swipe down opens (not in tap-only mode), swipe up on the bar always closes it
        if (dy > 0 && !settings().open && settings().openMode !== 'tap') setOpen(true);
        else if (dy < 0 && settings().open) setOpen(false);
        else return false;
        return true;
    };
    el.root.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        if (judge(e.touches[0])) tracking = false;
    }, { passive: true });
    el.root.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        judge(e.changedTouches[0]);
    }, { passive: true });
    el.root.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
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

function toggleProfileRow(force) {
    const show = typeof force === 'boolean' ? force : el.profileRow.classList.contains('tsb_hidden');
    if (show) {
        closeDropdown();
        if (!el.searchRow.classList.contains('tsb_hidden')) closeSearch();
    }
    el.profileRow.classList.toggle('tsb_hidden', !show);
}

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
        toggleProfileRow(false);
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
    for (const pin of [el.pinBtn, el.pinBtnRow]) if (pin) applyPinState(pin);
}

function applyPinState(pinEl) {
    const saved = chatMemory();
    const on = settings().chatMemory;
    pinEl.classList.toggle('tsb_on', on && !!saved);
    pinEl.classList.toggle('tsb_off', !settings().show.chatMemory);
    pinEl.title = !on
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
        toastr.info('상단바 설정(바 왼쪽 슬라이더 아이콘)에서 "채팅별 설정 기억"을 먼저 켜 주세요.');
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

/** Drops prefixes and date stamps that make model ids long (full id stays in the tooltip and info panel). */
function shortModelName(name) {
    let n = String(name || '').trim();
    n = n.split('/').pop() || n; // "models/x", "anthropic/x" -> "x"
    n = n.replace(/[-@](20\d{2}-?\d{2}-?\d{2}|\d{8})$/, '').replace(/-(\d{2}-\d{2})$/, '');
    return n || String(name || '');
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
    const full = model || String(onlineStatus || '');
    el.model.textContent = shortModelName(full);
    el.model.title = `현재 모델: ${full} (탭: 마지막 답변 정보 · 길게: 모델 바꾸기)`;
    if (model) rememberModel(model);
}

// ---- quick model switch (long-press the model name)

async function currentApiName() {
    return slashGet('api');
}

async function rememberModel(model) {
    const api = await currentApiName();
    if (!api || !model) return;
    const all = settings().recentModels;
    const list = (Array.isArray(all[api]) ? all[api] : []).filter(m => m !== model);
    list.unshift(model);
    all[api] = list.slice(0, 10);
    save();
}

/** Models this API offers, read from ST's model dropdown for the current Chat Completion source. */
function availableModels() {
    const c = ctx();
    if (c.mainApi !== 'openai') return [];
    const src = String(c.chatCompletionSettings?.chat_completion_source ?? '');
    const alias = { makersuite: 'google', custom: 'custom' };
    const node = document.getElementById(`model_${alias[src] || src}_select`);
    if (!node?.options?.length) return [];
    return Array.from(node.options).map(o => o.value).filter(Boolean);
}

async function buildModelSwitch(box) {
    const api = await currentApiName();
    const current = await slashGet('model');
    const recent = (settings().recentModels[api] || []).filter(Boolean);
    box.append(make('div', { class: 'tsb_dd_head' }, [make('span', { class: 'tsb_row_text', text: `모델 바꾸기 · ${apiDisplayName(api) || api}` })]));
    const pick = async (model) => {
        closeDropdown();
        if (await slashSet('model', model)) {
            toastr.info(`모델: ${model}`, '모델 바꾸기', { timeOut: 1500 });
            updateModelDebounced();
            rememberSetupDebounced();
        } else {
            toastr.error('모델을 바꾸지 못했어요.');
        }
    };
    const row = (model) => {
        const r = make('div', { class: 'tsb_row' + (model === current ? ' tsb_active' : ''), tabindex: '0', title: model }, [
            icon(model === current ? 'fa-circle-dot' : 'fa-circle'),
            make('span', { class: 'tsb_row_text', text: model }),
        ]);
        r.addEventListener('click', (e) => { e.stopPropagation(); if (model !== current) pick(model); });
        return r;
    };
    if (recent.length) {
        box.append(make('div', { class: 'tsb_dd_head' }, [make('span', { class: 'tsb_row_text', text: '최근에 쓴 모델' })]));
        for (const m of recent) box.append(row(m));
    } else {
        box.append(make('div', { class: 'tsb_empty', text: '아직 기록된 모델이 없어요. 모델을 쓰면 여기 쌓여요.' }));
    }
    const all = availableModels().filter(m => !recent.includes(m));
    if (all.length) {
        const sel = make('select', { class: 'tsb_preset_select', title: '모든 모델에서 고르기' });
        sel.append(make('option', { value: '', text: `모든 모델에서 고르기 (${all.length}개)` }));
        for (const m of all) sel.append(make('option', { value: m, text: m }));
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', () => { if (sel.value) pick(sel.value); });
        box.append(make('div', { class: 'tsb_preset_all' }, [icon('fa-list'), sel]));
    }
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

// ---- translation (persona description & per-chat note)
// The English text stays the source of truth: only lines that contain Korean are ever translated
// into English, so English that is already written is never re-translated.

const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;

function hasHangul(text) {
    return HANGUL.test(String(text ?? ''));
}

function translateProfileName() {
    const id = settings().translateProfileId;
    if (!id) return '';
    try { return ctx().ConnectionManagerRequestService?.getProfile?.(id)?.name || ''; } catch { return ''; }
}

/** Translates a list of strings with the chosen connection profile. Returns the same number of strings. */
async function translateList(items, toLanguage) {
    const c = ctx();
    const profileId = settings().translateProfileId;
    if (!profileId || !c.ConnectionManagerRequestService) {
        throw new Error('NO_PROFILE');
    }
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

/** Korean reading view of an English description (cached until the English changes). */
async function readingTranslation(id, english) {
    const cache = settings().translateCache;
    if (cache[id]?.en === english) return cache[id].ko;
    const lines = String(english ?? '').split('\n');
    const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0);
    const done = idx.length ? await translateList(idx.map(i => lines[i]), 'Korean') : [];
    idx.forEach((lineNo, k) => { lines[lineNo] = done[k]; });
    const ko = lines.join('\n');
    cache[id] = { en: english, ko };
    save();
    return ko;
}

function translateErrorText(error) {
    if (error?.message === 'NO_PROFILE') return '번역에 쓸 연결 프로필을 상단바 설정에서 먼저 골라 주세요.';
    if (error?.message === 'BAD_REPLY') return '번역 결과를 읽지 못했어요. 다시 시도해 주세요.';
    return '번역하지 못했어요.';
}

// ---- persona variants and per-chat note

const NOTE_KEY = 'tsb_persona_note';
const NOTE_PROMPT_KEY = 'tsb_persona_note';
const VARIANT_KEY = 'tsb_persona_variant';
const BASE_VARIANT = '기본';

function personaVariants(id) {
    const all = settings().personaVariants;
    return Array.isArray(all?.[id]) ? all[id] : [];
}

function chatVariantName(id) {
    const { chatMetadata, getCurrentChatId } = ctx();
    if (!getCurrentChatId?.()) return '';
    return String(chatMetadata?.[VARIANT_KEY]?.[id] ?? '');
}

function activeVariant(id) {
    const list = personaVariants(id);
    if (!list.length) return null;
    const want = chatVariantName(id) || BASE_VARIANT;
    return list.find(v => v.name === want) || list[0];
}

/** Writes a description into ST's persona field so ST saves it exactly as if typed there. */
function writePersonaDescription(text) {
    const field = document.getElementById('persona_description');
    if (!field) return false;
    $(field).val(text).trigger('input');
    return true;
}

/** On chat or persona change: use the variant this chat picked (or the base one). */
function applyVariantForChat() {
    const id = currentPersonaId();
    const v = activeVariant(id);
    if (!v) return;
    const current = String(ctx().powerUserSettings?.persona_description ?? '');
    if (current !== v.text) writePersonaDescription(v.text);
}
const applyVariantForChatDebounced = debounce(applyVariantForChat, 500);

function selectVariant(id, name) {
    const c = ctx();
    const v = personaVariants(id).find(x => x.name === name);
    if (!v) return;
    if (c.getCurrentChatId?.()) {
        const map = { ...(c.chatMetadata[VARIANT_KEY] || {}) };
        if (name === BASE_VARIANT) delete map[id]; else map[id] = name;
        if (Object.keys(map).length) c.chatMetadata[VARIANT_KEY] = map; else delete c.chatMetadata[VARIANT_KEY];
        c.saveMetadataDebounced();
    }
    writePersonaDescription(v.text);
}

function chatNote() {
    const { chatMetadata, getCurrentChatId } = ctx();
    if (!getCurrentChatId?.()) return '';
    return String(chatMetadata?.[NOTE_KEY] ?? '');
}

/** The per-chat note goes into the prompt next to the persona (model-facing text is English). */
const NOTE_EN_KEY = 'tsb_persona_note_en';

/** The note as the AI should read it: the English copy when the note is written in Korean. */
function noteForPrompt() {
    const note = chatNote().trim();
    if (!note || !hasHangul(note)) return note;
    const cached = ctx().chatMetadata?.[NOTE_EN_KEY];
    return cached && cached.src === note ? String(cached.en || note) : note;
}

function updateNotePrompt() {
    const note = noteForPrompt();
    const text = note ? `[Current details about {{user}} in this chat]\n${note}` : '';
    ctx().setExtensionPrompt(NOTE_PROMPT_KEY, text, 0, 0, false, 0);
}

/** Translates the Korean lines of the note (once per change) and uses the English copy in the prompt. */
const translateNoteDebounced = debounce(async () => {
    const c = ctx();
    if (!c.getCurrentChatId?.() || !settings().translateProfileId) return;
    const note = chatNote().trim();
    if (!note || !hasHangul(note)) return;
    const cached = c.chatMetadata?.[NOTE_EN_KEY];
    if (cached && cached.src === note) return;
    try {
        const en = await koreanLinesToEnglish(note);
        if (chatNote().trim() !== note) return; // changed meanwhile
        c.chatMetadata[NOTE_EN_KEY] = { src: note, en };
        c.saveMetadataDebounced();
        updateNotePrompt();
        noteTranslatedHook?.();
    } catch (error) {
        console.warn('[TopSlideBar] Note translation failed', error);
    }
}, 2500);
let noteTranslatedHook = null;

// ---- profile picture gallery: several pictures per persona, swap any time

const GALLERY_MAX = 12;

function galleryOf(id) {
    const all = settings().personaGallery;
    return Array.isArray(all?.[id]) ? all[id] : [];
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
    const name = `tsb_pfp_${safe}_${Date.now()}.${ext}`;
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({ name, data: await fileToBase64(blob) }),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const data = await res.json();
    return String(data.path || '');
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
    settings().personaGalleryActive[id] = path;
    save();
    // refresh every picture of this persona on screen
    try { await personasMod?.getUserAvatars?.(true, id); } catch { /* panel refresh is optional */ }
    const bust = `t=${Date.now()}`;
    const key = encodeURIComponent(id);
    document.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (src.includes(key) || src.includes(id)) img.src = src.replace(/([?&])t=\d+/, '').replace(/[?&]$/, '') + (src.includes('?') ? '&' : '?') + bust;
    });
    updatePersona();
}

async function addGalleryImage(id, file) {
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
                settings().personaGalleryActive[id] = p;
            }
        } catch (error) {
            console.warn('[TopSlideBar] Could not keep the current picture', error);
        }
    }
    const path = await storeGalleryImage(id, file);
    if (!path) throw new Error('no path');
    list.push(path);
    settings().personaGallery[id] = list;
    save();
}

async function removeGalleryImage(id, path) {
    settings().personaGallery[id] = galleryOf(id).filter(p => p !== path);
    if (settings().personaGalleryActive[id] === path) delete settings().personaGalleryActive[id];
    save();
    try {
        await fetch('/api/files/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ path }) });
    } catch { /* the file stays, nothing breaks */ }
}

const galleryUi = { open: false };

function buildGalleryRow(id, rebuild) {
    const row = make('div', { class: 'tsb_gallery' + (galleryUi.open ? '' : ' tsb_hidden') });
    const activePath = settings().personaGalleryActive[id];
    for (const path of galleryOf(id)) {
        const img = make('img', { class: 'tsb_gthumb', alt: '', loading: 'lazy', src: '/' + String(path).replace(/^\/+/, '') });
        const del = make('span', { class: 'tsb_gdel', title: '이 프사 빼기' }, [icon('fa-xmark')]);
        const tile = make('div', { class: 'tsb_gtile' + (path === activePath ? ' tsb_on' : ''), tabindex: '0', title: '이 프사로 바꾸기' }, [img, del]);
        tile.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (e.target instanceof Element && e.target.closest('.tsb_gdel')) {
                const ok = await ctx().Popup?.show?.confirm?.('프사 빼기', '이 사진을 목록에서 뺄까요? 지금 쓰는 프사는 그대로예요.');
                if (!ok) return;
                await removeGalleryImage(id, path);
                rebuild();
                return;
            }
            tile.classList.add('tsb_busy');
            try {
                await useGalleryImage(id, path);
                toastr.success('프사를 바꿨어요.', '페르소나', { timeOut: 1500 });
            } catch (error) {
                console.error('[TopSlideBar] Avatar swap failed', error);
                toastr.error('프사를 바꾸지 못했어요.');
            }
            rebuild();
        });
        row.append(tile);
    }
    const input = make('input', { type: 'file', accept: 'image/*', class: 'tsb_hidden' });
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            await addGalleryImage(id, file);
            toastr.success('프사를 추가했어요. 눌러서 바로 바꿀 수 있어요.', '페르소나', { timeOut: 2000 });
        } catch (error) {
            console.error('[TopSlideBar] Adding a picture failed', error);
            toastr.error('사진을 추가하지 못했어요.');
        }
        rebuild();
    });
    const add = make('div', { class: 'tsb_gtile tsb_gadd', tabindex: '0', title: '프사 추가' }, [icon('fa-plus'), input]);
    add.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target !== input) input.click();
    });
    row.append(add);
    return row;
}

function buildPersonaCard(box) {
    const c = ctx();
    const id = currentPersonaId();
    const personas = c.powerUserSettings?.personas ?? {};
    const name = personas[id] || c.name1 || '';
    const rebuild = () => {
        if (dropdownOwner !== 'persona') return;
        el.dropdown.replaceChildren();
        buildPersonaList(el.dropdown);
    };
    const textarea = make('textarea', { class: 'tsb_pdesc', rows: '4', placeholder: '페르소나 설명 없음' });
    textarea.value = String(c.powerUserSettings?.persona_description ?? '');
    const status = make('span', { class: 'tsb_psaved', text: '' });
    const pushToST = debounce(() => {
        if (currentPersonaId() !== id) return;
        // Let ST's own input handler update and save the persona
        writePersonaDescription(textarea.value);
        // editing while a variant is active updates that variant too
        const v = activeVariant(id);
        if (v) {
            v.text = textarea.value;
            save();
        }
        status.textContent = '저장됨';
        setTimeout(() => { status.textContent = ''; }, 1500);
        updateExtraPrompt();
    }, 600);
    textarea.addEventListener('input', () => {
        status.textContent = '…';
        pushToST();
    });
    textarea.addEventListener('click', (e) => e.stopPropagation());

    // translation: read in Korean, write Korean lines that become English
    const koView = make('div', { class: 'tsb_pdesc tsb_kov tsb_hidden' });
    const segEn = make('span', { class: 'tsb_seg_btn tsb_on', text: 'EN' });
    const segKo = make('span', { class: 'tsb_seg_btn', text: '한' });
    const seg = make('div', { class: 'tsb_seg', title: '원문(영어) / 한글로 읽기' }, [segEn, segKo]);
    const toEnBtn = make('div', { class: 'tsb_chip tsb_toen tsb_hidden', tabindex: '0', title: '한글이 들어간 줄만 영어로 바꿔요. 영어 줄은 그대로예요.' }, [icon('fa-language'), make('span', { text: '한글 줄만 영어로' })]);
    const refreshToEn = () => toEnBtn.classList.toggle('tsb_hidden', !hasHangul(textarea.value));
    textarea.addEventListener('input', refreshToEn);
    refreshToEn();
    const showKo = async (on) => {
        segEn.classList.toggle('tsb_on', !on);
        segKo.classList.toggle('tsb_on', on);
        textarea.classList.toggle('tsb_hidden', on);
        koView.classList.toggle('tsb_hidden', !on);
        if (!on) { refreshToEn(); return; }
        toEnBtn.classList.add('tsb_hidden');
        const english = textarea.value;
        koView.replaceChildren(make('span', { class: 'tsb_kov_wait', text: '번역하는 중…' }));
        try {
            koView.textContent = await readingTranslation(id, english) || '(설명 없음)';
        } catch (error) {
            console.warn('[TopSlideBar] Reading translation failed', error);
            const retryBtn = make('div', { class: 'tsb_chip tsb_kov_retry', tabindex: '0' }, [icon('fa-rotate-right'), make('span', { text: '다시 번역' })]);
            retryBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showKo(true); });
            const detail = error?.message && !['NO_PROFILE', 'BAD_REPLY'].includes(error.message) ? String(error.message).slice(0, 160) : '';
            koView.replaceChildren(
                make('div', { class: 'tsb_kov_err', text: translateErrorText(error) }),
                ...(detail ? [make('div', { class: 'tsb_kov_detail', text: detail })] : []),
                retryBtn,
            );
        }
    };
    segEn.addEventListener('click', (e) => { e.stopPropagation(); showKo(false); });
    segKo.addEventListener('click', (e) => { e.stopPropagation(); showKo(true); });
    koView.addEventListener('click', (e) => e.stopPropagation());
    toEnBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const before = textarea.value;
        toEnBtn.classList.add('tsb_busy');
        try {
            const after = await koreanLinesToEnglish(before);
            const ok = await c.Popup?.show?.confirm?.('한글 줄을 영어로', `<div style="text-align:left;white-space:pre-wrap;max-height:50vh;overflow:auto">${after.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div><small>바뀐 건 한글이 있던 줄뿐이에요. 이대로 저장할까요?</small>`);
            if (ok && textarea.value === before) {
                textarea.value = after;
                textarea.dispatchEvent(new Event('input'));
            }
        } catch (error) {
            toastr.error(translateErrorText(error));
        }
        toEnBtn.classList.remove('tsb_busy');
    });

    // variants: different versions of the same persona, picked per chat
    const variants = personaVariants(id);
    const active = activeVariant(id);
    const vRow = make('div', { class: 'tsb_vrow' });
    for (const v of variants) {
        const chip = make('div', { class: 'tsb_vchip' + (active === v ? ' tsb_on' : ''), tabindex: '0', title: `"${v.name}" 버전 쓰기` }, [make('span', { text: v.name })]);
        if (v.name !== BASE_VARIANT) {
            const del = make('span', { class: 'tsb_set_del', title: '이 버전 지우기' }, [icon('fa-xmark')]);
            chip.append(del);
        }
        chip.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (e.target instanceof Element && e.target.closest('.tsb_set_del')) {
                const ok = await c.Popup?.show?.confirm?.('버전 지우기', `"${v.name}" 버전을 지울까요?`);
                if (!ok) return;
                const list = personaVariants(id).filter(x => x !== v);
                settings().personaVariants[id] = list.length > 1 ? list : [];
                save();
                if (active === v) selectVariant(id, BASE_VARIANT);
                if (!settings().personaVariants[id].length && list[0]) writePersonaDescription(list[0].text);
                rebuild();
                return;
            }
            selectVariant(id, v.name);
            rebuild();
        });
        vRow.append(chip);
    }
    const addV = make('div', { class: 'tsb_vchip tsb_vchip_add', tabindex: '0', title: '지금 설명을 새 버전으로 저장' }, [icon('fa-plus'), make('span', { text: variants.length ? '버전 추가' : '버전 만들기' })]);
    addV.addEventListener('click', async (e) => {
        e.stopPropagation();
        const vName = await c.Popup?.show?.input?.('페르소나 버전', '새 버전 이름을 정해 주세요. 예: 학생 시절, 5년 후, 변장<br><small>지금 설명이 복사돼요. 고른 뒤 설명을 고치면 그 버전만 바뀌어요.</small>', '');
        if (typeof vName !== 'string' || !vName.trim()) return;
        const nm = vName.trim().slice(0, 20);
        const list = personaVariants(id).slice();
        const text = String(ctx().powerUserSettings?.persona_description ?? '');
        if (!list.length) list.push({ name: BASE_VARIANT, text });
        if (list.some(x => x.name === nm)) {
            toastr.warning('같은 이름의 버전이 있어요.');
            return;
        }
        list.push({ name: nm, text });
        settings().personaVariants[id] = list;
        save();
        selectVariant(id, nm);
        toastr.success(`"${nm}" 버전을 만들었어요. 이제 설명을 고치면 이 버전만 바뀌어요.`, '페르소나');
        rebuild();
    });
    vRow.append(addV);

    // per-chat note
    const hasChat = !!c.getCurrentChatId?.();
    const note = make('textarea', { class: 'tsb_pnote', rows: '2', placeholder: hasChat ? '이 채팅에서만: 지금 옷차림, 부상, 들킨 비밀 등' : '채팅을 열면 쓸 수 있어요' });
    note.value = chatNote();
    if (!hasChat) note.disabled = true;
    const saveNote = debounce(() => {
        const cc = ctx();
        if (!cc.getCurrentChatId?.()) return;
        const v = note.value.trim();
        if (v) cc.chatMetadata[NOTE_KEY] = note.value; else delete cc.chatMetadata[NOTE_KEY];
        cc.saveMetadataDebounced();
        updateNotePrompt();
        noteLabel.classList.toggle('tsb_on', !!v);
        refreshNoteState();
        translateNoteDebounced();
    }, 600);
    note.addEventListener('input', saveNote);
    note.addEventListener('click', (e) => e.stopPropagation());
    const noteState = make('span', { class: 'tsb_note_state', text: '' });
    const noteLabel = make('div', { class: 'tsb_pnote_label' + (chatNote().trim() ? ' tsb_on' : '') }, [icon('fa-note-sticky'), make('span', { text: '이 채팅에서만 덧붙임' }), noteState]);
    const refreshNoteState = () => {
        const n = chatNote().trim();
        if (!n || !hasHangul(n)) { noteState.textContent = ''; return; }
        if (!settings().translateProfileId) { noteState.textContent = '· 한글 그대로 보냄'; return; }
        const cached = ctx().chatMetadata?.[NOTE_EN_KEY];
        noteState.textContent = cached && cached.src === n ? '· AI에겐 영어로 보냄' : '· 영어로 바꾸는 중…';
    };
    noteTranslatedHook = refreshNoteState;
    refreshNoteState();

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

    const img = make('img', { class: 'tsb_pimg tsb_pimg_tap', alt: '', src: c.getThumbnailUrl('persona', id), title: '프사 바꾸기' });
    personaImgFallback(img, id);
    const count = galleryOf(id).length;
    const galleryHint = make('span', { class: 'tsb_ghint', text: count ? `프사 ${count}장` : '프사 추가' });
    const gallery = buildGalleryRow(id, rebuild);
    const toggleGallery = (e) => {
        e.stopPropagation();
        galleryUi.open = !galleryUi.open;
        gallery.classList.toggle('tsb_hidden', !galleryUi.open);
    };
    img.addEventListener('click', toggleGallery);
    galleryHint.addEventListener('click', toggleGallery);
    const head = make('div', { class: 'tsb_pcard_head' }, [img, make('div', { class: 'tsb_pcard_name_wrap' }, [make('div', { class: 'tsb_pcard_name', text: name }), galleryHint]), status, seg]);
    const card = make('div', { class: 'tsb_pcard' }, [head, gallery, vRow, textarea, koView, toEnBtn, noteLabel, note]);
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
        newChatTapAction();
    });
}

/** What a plain tap on the new-chat button does (chosen in the settings). */
function newChatTapAction() {
    let tap = settings().newChatTap || 'new';
    if (tap === 'branchLast') tap = 'branchVisible';
    if (tap === 'menu') {
        openDropdown('newchat', buildNewChatMenu);
        return;
    }
    closeDropdown();
    const { chat } = ctx();
    if (tap === 'branchVisible') {
        const node = mostVisibleMessage();
        const id = node ? Number(node.getAttribute('mesid')) : NaN;
        if (!isNaN(id)) { branchFrom(id); return; }
    }
    if (tap === 'branchVisible') {
        const last = (chat?.length ?? 0) - 1;
        if (last >= 0) { branchFrom(last); return; }
    }
    document.getElementById('option_start_new_chat')?.click();
}

// ---------------------------------------------------------------- extra buttons

async function runSlash(command, failText) {
    closeDropdown();
    try {
        await ctx().executeSlashCommandsWithOptions(command);
    } catch (error) {
        console.error('[TopSlideBar]', command, error);
        toastr.error(failText);
    }
}

/** Deletes from the message that fills most of the screen down to the end (after a confirmation). */
async function deleteFromVisible() {
    closeDropdown();
    const c = ctx();
    const node = mostVisibleMessage();
    const from = node ? Number(node.getAttribute('mesid')) : NaN;
    const last = (c.chat?.length ?? 0) - 1;
    if (isNaN(from) || last < 0) return;
    node.classList.add('tsb_branch_target');
    const m = c.chat[from];
    const preview = String(m?.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 50).replace(/</g, '&lt;');
    const count = last - from + 1;
    const ok = await c.Popup?.show?.confirm?.('여기부터 삭제', `<b>#${from}</b>부터 마지막 메시지까지 <b>${count}개</b>를 지울까요?<br><small>${String(m?.name ?? '').replace(/</g, '&lt;')}: ${preview}…</small>`);
    node.classList.remove('tsb_branch_target');
    if (!ok) return;
    await runSlash(from === last ? `/cut ${from}` : `/cut ${from}-${last}`, '메시지를 지우지 못했어요.');
}

async function deleteLastMessage() {
    closeDropdown();
    const c = ctx();
    const last = (c.chat?.length ?? 0) - 1;
    if (last < 0) return;
    const m = c.chat[last];
    const preview = String(m?.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 50).replace(/</g, '&lt;');
    const ok = await c.Popup?.show?.confirm?.('마지막 메시지 삭제', `<b>#${last}</b> 메시지를 지울까요?<br><small>${String(m?.name ?? '').replace(/</g, '&lt;')}: ${preview}…</small>`);
    if (!ok) return;
    await runSlash(`/cut ${last}`, '메시지를 지우지 못했어요.');
}

function scrollChat(toTop) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    chatEl.scrollTo({ top: toTop ? 0 : chatEl.scrollHeight, behavior: 'smooth' });
}

// ---- chat file: export the current chat, import a chat file

function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportCurrentChat(format) {
    closeDropdown();
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    if (!chatId) { toastr.info('열린 채팅이 없어요.'); return; }
    try {
        await c.saveChat?.();
        const isGroup = !!c.groupId;
        const body = {
            is_group: isGroup,
            avatar_url: isGroup ? undefined : c.characters?.[c.characterId]?.avatar,
            file: `${chatId}.jsonl`,
            exportfilename: `${chatId}.${format}`,
            format,
        };
        const res = await fetch('/api/chats/export', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || `export failed: ${res.status}`);
        downloadText(String(data.result ?? ''), body.exportfilename, format === 'txt' ? 'text/plain' : 'application/octet-stream');
        toastr.success(`${body.exportfilename} 로 내보냈어요.`, '채팅 파일', { timeOut: 2000 });
    } catch (error) {
        console.error('[TopSlideBar] Chat export failed', error);
        toastr.error('채팅을 내보내지 못했어요.');
    }
}

function importChatFile() {
    closeDropdown();
    const c = ctx();
    if (c.groupId || c.characterId === undefined) {
        toastr.info('캐릭터 채팅을 연 상태에서 불러올 수 있어요. 그 캐릭터의 새 채팅으로 들어가요.');
        return;
    }
    // ST's own import (the "Import chat" button in the chat list) does the work
    const stButton = document.getElementById('chat_import_button');
    if (stButton) { stButton.click(); return; }
    document.getElementById('chat_import_file')?.click();
}

function buildChatFileMenu(box) {
    const item = (iconCls, label, sub, onClick) => {
        const text = make('div', { class: 'tsb_menu_text' }, [make('span', { text: label })]);
        if (sub) text.append(make('span', { class: 'tsb_menu_sub', text: sub }));
        const row = make('div', { class: 'tsb_row tsb_menu_row', tabindex: '0' }, [icon(iconCls), text]);
        row.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        box.append(row);
    };
    const chatId = ctx().getCurrentChatId?.();
    item('fa-file-code', '현재 채팅 내보내기 (.jsonl)', chatId ? `${chatId}.jsonl · 다시 불러올 수 있는 원본` : '열린 채팅이 없어요', () => exportCurrentChat('jsonl'));
    item('fa-file-lines', '읽기용으로 내보내기 (.txt)', '대화 내용만 텍스트로', () => exportCurrentChat('txt'));
    item('fa-file-import', '채팅 불러오기', '.jsonl 파일을 이 캐릭터의 새 채팅으로', importChatFile);
}

function bindExtraButtons() {
    el.chatFileBtn.addEventListener('click', () => openDropdown('chatfile', buildChatFileMenu));
    el.togglesBtn.addEventListener('click', () => openDropdown('toggles', buildToggleList));
    el.searchBtn.addEventListener('click', () => {
        if (el.searchRow.classList.contains('tsb_hidden')) openSearch();
        else closeSearch();
    });
    el.continueBtn.addEventListener('click', () => runSlash('/continue', '이어쓰기를 하지 못했어요.'));
    el.deleteModeBtn.addEventListener('click', () => {
        closeDropdown();
        document.getElementById('option_delete_mes')?.click();
    });
    el.deleteFromBtn.addEventListener('click', deleteFromVisible);
    el.deleteLastBtn.addEventListener('click', deleteLastMessage);
    bindLongPress(el.bottomBtn, () => scrollChat(false), () => scrollChat(true));
    el.infoBtn.addEventListener('click', () => openDropdown('info', buildReplyInfo));
}

// ---------------------------------------------------------------- chat map button
// Opens the 깡통 노선도 extension when it is installed, otherwise ST's chat list.

function hasSubway() {
    return !!document.getElementById('option_kts_subway');
}

function useSubway() {
    return settings().mapTarget === 'subway' && hasSubway();
}

function updateMapButton() {
    const subway = useSubway();
    el.mapIcon.className = `fa-fw fa-solid ${subway ? 'fa-train-subway' : 'fa-address-book'}`;
    el.mapBtn.title = subway
        ? '깡통 노선도 (길게 누르면 채팅 목록)'
        : hasSubway() ? '채팅 목록 (길게 누르면 깡통 노선도)' : '채팅 목록';
}

function openChatList() {
    closeDropdown();
    document.getElementById('option_select_chat')?.click();
}

function openSubway() {
    closeDropdown();
    const subway = document.getElementById('option_kts_subway');
    if (subway) subway.click();
    else openChatList();
}

function onMapTap() {
    if (useSubway()) openSubway();
    else openChatList();
}

function onMapLongPress() {
    if (useSubway()) openChatList();
    else if (hasSubway()) openSubway();
    else openChatList();
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
    renderLoreEntries(box, lore.entries, '직전 생성에서 발동된 항목이 없어요.', null);
}

function keyList(value) {
    return (Array.isArray(value) ? value : []).map(k => String(k ?? '').trim()).filter(Boolean);
}

/** Keys of an entry that appear in the given text (plain keys and /regex/ keys). */
function matchedKeys(entry, text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    return keyList(entry.key).filter((k) => {
        const m = k.match(/^\/(.+)\/([a-z]*)$/);
        if (m) {
            try { return new RegExp(m[1], m[2]).test(text); } catch { return false; }
        }
        return entry.caseSensitive ? text.includes(k) : lower.includes(k.toLowerCase());
    });
}

function buildLoreDetail(entry, scanText) {
    const box = make('div', { class: 'tsb_lore_detail' });
    const line = (label, value) => {
        if (value) box.append(make('div', { class: 'tsb_ld_line' }, [make('span', { class: 'tsb_ld_key', text: label }), make('span', { text: value })]));
    };
    if (entry.constant) {
        line('발동', '상시 항목이라 항상 들어가요');
    } else {
        const hit = matchedKeys(entry, scanText);
        if (scanText !== null) line('걸린 키워드', hit.length ? hit.join(', ') : '직접 걸린 키워드 없음 (다른 항목 내용이나 설명에서 걸렸을 수 있어요)');
        line('키워드', keyList(entry.key).join(', '));
        line('보조 키워드', keyList(entry.keysecondary).join(', '));
    }
    if (entry.useProbability && entry.probability < 100) line('확률', `${entry.probability}%`);
    const content = String(entry.content ?? '').replace(/\s+/g, ' ').trim();
    if (content) box.append(make('div', { class: 'tsb_ld_content', text: content.length > 220 ? content.slice(0, 220) + '…' : content }));
    return box;
}

function renderLoreEntries(box, list, emptyText, scanText = null) {
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
            const caret = make('i', { class: 'fa-fw fa-solid fa-chevron-down tsb_caret' });
            const row = make('div', { class: 'tsb_row tsb_lore_row', tabindex: '0', title: entryTitle(entry) }, [dot, make('span', { class: 'tsb_row_text', text: entryTitle(entry) }), caret]);
            let detail = null;
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                if (detail) {
                    detail.remove();
                    detail = null;
                    row.classList.remove('tsb_expanded');
                    return;
                }
                detail = buildLoreDetail(entry, scanText);
                row.after(detail);
                row.classList.add('tsb_expanded');
            });
            box.append(row);
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
    // what the default scan depth covers (newest first), used to show which keyword matched
    const depth = Math.max(0, Number(wiMod.world_info_depth ?? 2));
    const scanText = lines.slice(0, depth).join('\n');
    return { entries: Array.from(result?.allActivatedEntries ?? []), withInput: !!pending, depth, scanText };
}

function buildLorePreview(box) {
    const head = make('div', { class: 'tsb_dd_head tsb_preview_head' }, [icon('fa-eye'), make('span', { class: 'tsb_row_text', text: '미리보기 · 계산 중…' })]);
    const body = make('div');
    box.append(head, body);
    previewLoreEntries()
        .then(({ entries, withInput, depth, scanText }) => {
            if (dropdownOwner !== 'lorepreview') return;
            head.querySelector('.tsb_row_text').textContent = `미리보기 · ${entries.length}개`;
            body.append(make('div', { class: 'tsb_preview_scope', text: `최근 메시지 ${depth}개${withInput ? '(입력 중인 글 포함)' : ''}를 검사했어요. 항목을 누르면 걸린 키워드가 보여요.` }));
            renderLoreEntries(body, entries, '다음 생성에서 발동될 항목이 없어요.', scanText);
            body.append(make('div', { class: 'tsb_preview_note', text: '실리태번 실제 검사 기능을 그대로 써요. 확률·지속 효과가 있는 항목은 실제와 다를 수 있고, 항목마다 따로 정한 검사 깊이가 있으면 그 기준을 따라요.' }));
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
const retry = { snap: null, attempt: 0, timer: null, userStopped: false, dueAt: 0, tick: null, log: [] };

// ---- 1) watch generation requests so we know which HTTP error (if any) a failed attempt got
const GEN_URL = /\/api\/(backends\/[^/]+|novelai|horde)\/.*generate/;
const lastHttp = { at: 0, status: 0, message: '' };

function watchGenerateRequests() {
    if (window.__tsbFetchWrapped) return;
    window.__tsbFetchWrapped = true;
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const response = await original(...args);
        try {
            const url = String(args[0]?.url ?? args[0] ?? '');
            if (GEN_URL.test(url) && !response.ok) {
                lastHttp.at = Date.now();
                lastHttp.status = response.status;
                lastHttp.message = '';
                // read the error text from a copy, without touching the body ST reads
                response.clone().text().then((text) => {
                    let msg = text;
                    try { const j = JSON.parse(text); msg = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : text); } catch { /* plain text */ }
                    lastHttp.message = String(msg ?? '').slice(0, 300);
                }).catch(() => {});
            }
        } catch { /* never break ST's request */ }
        return response;
    };
}

/** 429 / 5xx / timeouts are worth retrying; bad request, auth, not-found are not. */
function classifyHttp(status, message) {
    const m = String(message || '').toLowerCase();
    if (/quota|rate.?limit|overload|resource.?exhausted|try again|temporar|unavailable|timeout/.test(m)) return 'retry';
    if (status === 429 || status === 408 || status >= 500) return 'retry';
    if (status === 401 || status === 403) return 'stop-auth';
    if (status === 400 || status === 404 || status === 413 || status === 422) return 'stop-request';
    return 'retry';
}

function retryLog(kind, detail = '') {
    retry.log.push({ at: Date.now(), kind, detail: String(detail || '').slice(0, 160) });
    if (retry.log.length > 40) retry.log.splice(0, retry.log.length - 40);
}

// ---- 3) / 4) judging the text of a reply
function refusalList() {
    return String(settings().retryRefusals || '').split('\n').map(x => x.trim()).filter(Boolean);
}

/** Why a reply text counts as failed, or '' when it is fine. */
function replyProblem(text) {
    const t = String(text ?? '').trim();
    if (!t) return '빈 응답';
    const s = settings();
    const min = Number(s.retryMinChars) || 0;
    if (min > 0 && t.length < min) return `짧은 답 (${t.length}자)`;
    if (s.retryRefusalOn) {
        const head = t.slice(0, 200).toLowerCase();
        const hit = refusalList().find(p => head.includes(p.toLowerCase()));
        if (hit) return `거절 문구 ("${hit}")`;
    }
    return '';
}

// ---- 2) remove the failed swipes this retry run left behind
async function cleanupFailedSwipes(snap) {
    if (!settings().retryCleanup) return 0;
    const c = ctx();
    const m = lastMessage();
    if (!m || m.is_user || m.is_system || !Array.isArray(m.swipes) || m.swipes.length < 2) return 0;
    // only swipes created during this run: a brand-new message -> all of them; a swipe run -> the new ones
    const from = snap.type === 'normal' && c.chat.length > snap.length ? 0 : snap.swipes;
    const keep = Number(m.swipe_id) || 0;
    const drop = [];
    for (let i = from; i < m.swipes.length; i++) {
        if (i !== keep && replyProblem(m.swipes[i])) drop.push(i);
    }
    if (!drop.length) return 0;
    for (const i of drop.reverse()) {
        m.swipes.splice(i, 1);
        if (Array.isArray(m.swipe_info)) m.swipe_info.splice(i, 1);
    }
    m.swipe_id = Math.max(0, m.swipes.indexOf(m.mes));
    try {
        await c.saveChat();
        c.swipe?.refresh?.();
        // keep the "2/3" counter of the message in step
        const mesId = c.chat.length - 1;
        const counter = document.querySelector(`#chat .mes[mesid="${mesId}"] .swipes-counter`);
        if (counter) counter.textContent = `${m.swipe_id + 1}/${m.swipes.length}`;
    } catch (error) {
        console.warn('[TopSlideBar] Saving after swipe cleanup failed', error);
    }
    return drop.length;
}

const RETRY_TYPES = ['normal', 'swipe', 'regenerate'];

function updateRetryButton() {
    const s = settings();
    el.retryBtn.classList.toggle('tsb_on', !!s.retryOn);
    const waiting = retry.timer !== null || retry.attempt > 0;
    const left = retry.timer !== null && retry.dueAt ? Math.max(0, Math.ceil((retry.dueAt - Date.now()) / 1000)) : null;
    // while waiting: seconds left; while the retry is generating: which attempt it is
    el.retryCount.textContent = left !== null ? `${left}s` : String(retry.attempt);
    el.retryCount.classList.toggle('tsb_hidden', !waiting);
    el.retryBtn.classList.toggle('tsb_waiting', left !== null);
    el.retryBtn.title = !s.retryOn
        ? '자동 재시도 꺼짐'
        : left !== null
            ? `${left}초 뒤 ${retry.attempt}번째 재시도 (탭하면 취소)`
            : `자동 재시도 켜짐 (최대 ${s.retryMax}회)` + (waiting ? ` · 지금 ${retry.attempt}번째 재시도` : '');
}

function cancelRetry(reason) {
    if (retry.timer) clearTimeout(retry.timer);
    clearInterval(retry.tick);
    retry.tick = null;
    retry.dueAt = 0;
    const wasRunning = retry.timer !== null || retry.attempt > 0;
    retry.timer = null;
    retry.attempt = 0;
    retry.snap = null;
    updateRetryButton();
    if (wasRunning && reason) toastr.info(reason, '자동 재시도');
}

function toggleRetry() {
    // while a retry is counting down, a tap cancels just this retry and keeps the feature on
    if (retry.timer !== null) {
        cancelRetry('이번 재시도를 취소했어요.');
        return;
    }
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
    retry.attemptStartedAt = Date.now();
}

function isReplyOk(snap) {
    const { chat } = ctx();
    const last = lastMessage();
    if (!last || last.is_user || last.is_system) return false;
    if (replyProblem(last.mes)) return false;
    if (snap.type === 'normal') return chat.length > snap.length || snap.length === 0;
    // swipe / regenerate: a new swipe should exist, or the message text was replaced
    const swipes = Array.isArray(last.swipes) ? last.swipes.length : 0;
    return swipes > snap.swipes || snap.type === 'regenerate';
}

async function doRetry() {
    retry.timer = null;
    clearInterval(retry.tick);
    retry.tick = null;
    retry.dueAt = 0;
    updateRetryButton();
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
            const tries = retry.attempt;
            retryLog('성공', tries ? `${tries}번 재시도 끝에` : '');
            cancelRetry();
            if (tries > 0) {
                cleanupFailedSwipes(snap).then((n) => {
                    toastr.success(`${tries}번 재시도 끝에 답변을 받았어요.${n ? ` 실패한 스와이프 ${n}개는 지웠어요.` : ''}`, '자동 재시도');
                });
            }
            return;
        }
        // why did this attempt fail?
        const http = lastHttp.at >= (retry.attemptStartedAt || 0) - 50 ? { ...lastHttp } : null;
        const last = lastMessage();
        let reason;
        if (http) {
            reason = `오류 ${http.status}${http.message ? ` · ${http.message}` : ''}`;
            const kind = classifyHttp(http.status, http.message);
            if (kind !== 'retry') {
                retryLog('멈춤', reason);
                cancelRetry();
                toastr.error(
                    kind === 'stop-auth'
                        ? `API 키나 권한 문제라 다시 시도해도 안 돼서 멈췄어요. (${http.status})`
                        : `요청 자체가 거절돼서 다시 시도해도 같은 결과라 멈췄어요. (${http.status})${http.message ? `<br><small>${http.message.replace(/</g, '&lt;')}</small>` : ''}`,
                    '자동 재시도', { escapeHtml: false, timeOut: 10000 });
                return;
            }
        } else {
            reason = (last && !last.is_user && !last.is_system) ? (replyProblem(last.mes) || '답변 없음') : '답변 없음';
        }
        retryLog('실패', reason);
        const s = settings();
        if (retry.attempt >= s.retryMax) {
            retryLog('포기', `${s.retryMax}번 모두 실패`);
            cancelRetry();
            toastr.error(`${s.retryMax}번 재시도했지만 답변을 받지 못했어요.`, '자동 재시도');
            return;
        }
        retry.attempt++;
        // Same wait every time by default; optionally grow it (gentler on strict rate limits)
        const delay = s.retryBackoff
            ? Math.min(30, s.retryDelay * Math.pow(1.3, retry.attempt - 1))
            : s.retryDelay;
        toastr.info(`${Math.round(delay)}초 뒤 다시 시도해요 (${retry.attempt}/${s.retryMax})`, '자동 재시도', { timeOut: delay * 1000 });
        retry.dueAt = Date.now() + delay * 1000;
        retry.timer = setTimeout(doRetry, delay * 1000);
        clearInterval(retry.tick);
        retry.tick = setInterval(updateRetryButton, 1000);
        updateRetryButton();
    }, 600);
}

function onRetryStopped() {
    retry.userStopped = true;
    if (retry.snap) retryLog('중지', '중지 버튼');
    if (retry.timer) cancelRetry('재시도를 멈췄어요.');
}

function buildRetryLog(box) {
    box.append(make('div', { class: 'tsb_dd_head' }, [make('span', { class: 'tsb_row_text', text: '재시도 기록' }), make('span', { class: 'tsb_dd_count', text: settings().retryOn ? '켜짐' : '꺼짐' })]));
    if (!retry.log.length) {
        box.append(make('div', { class: 'tsb_empty', text: '아직 기록이 없어요. (새로고침하면 지워져요)' }));
        return;
    }
    const pad = (x) => String(x).padStart(2, '0');
    for (const item of [...retry.log].reverse()) {
        const d = new Date(item.at);
        const cls = item.kind === '성공' ? 'ok' : item.kind === '실패' ? 'fail' : 'stop';
        box.append(make('div', { class: `tsb_log_row tsb_log_${cls}` }, [
            make('span', { class: 'tsb_log_time', text: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }),
            make('span', { class: 'tsb_log_kind', text: item.kind }),
            make('span', { class: 'tsb_log_detail', text: item.detail }),
        ]));
    }
}

// ---------------------------------------------------------------- free button (prompt toggles / search / continue)

const SLOT_INFO = {
    toggles: { icon: 'fa-toggle-on', title: '프롬프트 토글' },
    search: { icon: 'fa-magnifying-glass', title: '채팅 전체 검색' },
    continue: { icon: 'fa-arrow-right', title: '이어쓰기' },
};

function updateSlotButton() {
    const info = SLOT_INFO[settings().slotAction] || SLOT_INFO.toggles;
    el.slotIcon.className = `fa-fw fa-solid ${info.icon}`;
    el.searchBtn.title = info.title;
}

async function onSlotClick() {
    const action = settings().slotAction || 'toggles';
    if (action === 'search') {
        if (el.searchRow.classList.contains('tsb_hidden')) openSearch();
        else closeSearch();
        return;
    }
    if (action === 'continue') {
        closeDropdown();
        try {
            await ctx().executeSlashCommandsWithOptions('/continue');
        } catch (error) {
            console.error('[TopSlideBar] continue failed', error);
            toastr.error('이어쓰기를 하지 못했어요.');
        }
        return;
    }
    openDropdown('toggles', buildToggleList);
}

// ---- prompt toggles: our own switchboard on top of ST's prompt manager

function currentPresetName() {
    return String(ctx().chatCompletionSettings?.preset_settings_openai ?? '');
}

/** Toggleable prompts of the current preset: [{ id, name, enabled, entry }] (markers like chat history are left out). */
function togglablePrompts() {
    const pm = openaiMod?.promptManager;
    const order = promptOrder();
    if (!pm || !order) return null;
    const list = [];
    for (const entry of order) {
        const prompt = pm.getPromptById?.(entry.identifier);
        if (!prompt || prompt.marker) continue;
        list.push({ id: entry.identifier, name: String(prompt.name || entry.identifier), enabled: !!entry.enabled, entry });
    }
    return list;
}

async function applyToggleStates(states) {
    const pm = openaiMod?.promptManager;
    const order = promptOrder();
    if (!pm || !order) return 0;
    let changed = 0;
    for (const entry of order) {
        const want = states[entry.identifier];
        if (typeof want === 'boolean' && want !== !!entry.enabled) {
            entry.enabled = want;
            changed++;
        }
    }
    if (changed) {
        pm.render(false);
        await pm.saveServiceSettings();
        // the chat-memory pin picks this up as this chat's toggles
        rememberSetupDebounced();
    }
    return changed;
}

function favsFor(preset) {
    const all = settings().toggleFavs;
    return Array.isArray(all[preset]) ? all[preset] : [];
}

function togglePromptFav(preset, id) {
    const all = settings().toggleFavs;
    const list = favsFor(preset);
    all[preset] = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
    save();
}

/** UI state of the toggle panel that survives its redraws. */
const toggleUi = { presetOpen: false };

function buildToggleList(box) {
    const c = ctx();
    if (c.mainApi !== 'openai') {
        box.append(make('div', { class: 'tsb_empty', text: '프롬프트 토글은 Chat Completion API에서만 쓸 수 있어요.' }));
        return;
    }
    const prompts = togglablePrompts();
    if (!prompts) {
        box.append(make('div', { class: 'tsb_empty', text: '프롬프트 목록을 불러오지 못했어요.' }));
        return;
    }
    const preset = currentPresetName();
    const rebuild = () => {
        if (dropdownOwner !== 'toggles') return;
        el.dropdown.replaceChildren();
        buildToggleList(el.dropdown);
    };

    // preset picker: tap the pill for favourite presets, the full list is one more tap away
    const mainPreset = /** @type {HTMLSelectElement|null} */ (document.getElementById('settings_preset_openai'));
    const presetFavList = () => (Array.isArray(settings().presetFavs) ? settings().presetFavs : []);
    const switchPreset = (value) => {
        if (!mainPreset || !value || mainPreset.value === value) return;
        mainPreset.value = value;
        $(mainPreset).trigger('change');
        // the panel redraws itself once ST has loaded the new preset (OAI_PRESET_CHANGED_AFTER)
    };
    const optionByName = (name) => Array.from(mainPreset?.options ?? []).find(o => (o.textContent ?? '') === name);
    const curName = mainPreset?.selectedOptions?.[0]?.textContent ?? preset;
    const isFavPreset = presetFavList().includes(curName);

    const presetStar = make('span', { class: 'tsb_pstar' + (isFavPreset ? ' tsb_on' : ''), title: isFavPreset ? '즐겨찾기에서 빼기' : '이 프리셋 즐겨찾기' }, [icon('fa-star')]);
    const pill = make('div', { class: 'tsb_preset_pill', tabindex: '0', title: '즐겨찾기 프리셋 보기' }, [
        make('span', { class: 'tsb_row_text', text: curName || '프리셋' }),
        icon('fa-caret-down'),
    ]);
    const presetRow = make('div', { class: 'tsb_preset_row' }, [presetStar, pill,
        make('span', { class: 'tsb_dd_count', text: `${prompts.filter(p => p.enabled).length}/${prompts.length} 켜짐` })]);
    box.append(presetRow);

    const favBox = make('div', { class: 'tsb_preset_favs' + (toggleUi.presetOpen ? '' : ' tsb_hidden') });
    const favNames = presetFavList().filter(n => optionByName(n));
    if (!favNames.length) {
        favBox.append(make('div', { class: 'tsb_preset_hint', text: '☆을 눌러 자주 쓰는 프리셋을 즐겨찾기 해 두면 여기 모여요.' }));
    }
    for (const name of favNames) {
        const r = make('div', { class: 'tsb_row tsb_preset_item' + (name === curName ? ' tsb_active' : ''), tabindex: '0' }, [
            icon(name === curName ? 'fa-circle-dot' : 'fa-circle'),
            make('span', { class: 'tsb_row_text', text: name }),
        ]);
        r.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleUi.presetOpen = false;
            switchPreset(optionByName(name)?.value);
        });
        favBox.append(r);
    }
    if (mainPreset) {
        // every preset, through the system picker (good for long lists)
        const all = make('select', { class: 'tsb_preset_select', title: '모든 프리셋에서 고르기' });
        all.append(make('option', { value: '', text: `모든 프리셋에서 고르기 (${mainPreset.options.length}개)` }));
        for (const o of Array.from(mainPreset.options)) all.append(make('option', { value: o.value, text: o.textContent ?? o.value }));
        all.value = '';
        all.addEventListener('click', (e) => e.stopPropagation());
        all.addEventListener('change', () => {
            toggleUi.presetOpen = false;
            switchPreset(all.value);
        });
        favBox.append(make('div', { class: 'tsb_preset_all' }, [icon('fa-list'), all]));
    }
    box.append(favBox);

    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleUi.presetOpen = !toggleUi.presetOpen;
        favBox.classList.toggle('tsb_hidden', !toggleUi.presetOpen);
    });
    presetStar.addEventListener('click', (e) => {
        e.stopPropagation();
        const list = presetFavList();
        settings().presetFavs = list.includes(curName) ? list.filter(n => n !== curName) : [...list, curName];
        save();
        rebuild();
    });

    // sets for this preset
    const sets = settings().toggleSets.filter(x => x.preset === preset);
    const setRow = make('div', { class: 'tsb_set_chips' });
    for (const set of sets) {
        const del = make('span', { class: 'tsb_set_del', title: '세트 지우기' }, [icon('fa-xmark')]);
        const chip = make('div', { class: 'tsb_chip tsb_setchip', tabindex: '0', title: `"${set.name}" 조합으로 바꾸기` }, [make('span', { text: set.name }), del]);
        chip.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (e.target instanceof Element && e.target.closest('.tsb_set_del')) {
                settings().toggleSets = settings().toggleSets.filter(x => x !== set);
                save();
                rebuild();
                return;
            }
            const n = await applyToggleStates(set.states);
            toastr.info(n ? `"${set.name}" 조합으로 토글 ${n}개를 바꿨어요.` : `이미 "${set.name}" 조합이에요.`, '프롬프트 토글', { timeOut: 2000 });
            rebuild();
        });
        setRow.append(chip);
    }
    const addSet = make('div', { class: 'tsb_chip tsb_setchip_add', tabindex: '0', title: '지금 켜고 끈 조합을 세트로 저장' }, [icon('fa-plus'), make('span', { text: '지금 조합 저장' })]);
    addSet.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = await c.Popup?.show?.input?.('토글 세트 저장', '이 조합의 이름을 정해 주세요. 예: 수위 높게, 일상 모드', '');
        if (typeof name !== 'string' || !name.trim()) return;
        const states = {};
        for (const p of togglablePrompts() ?? []) states[p.id] = p.enabled;
        const list = settings().toggleSets.filter(x => !(x.preset === preset && x.name === name.trim()));
        list.push({ name: name.trim().slice(0, 30), preset, states });
        settings().toggleSets = list;
        save();
        toastr.success(`"${name.trim()}" 세트를 저장했어요.`, '프롬프트 토글');
        rebuild();
    });
    setRow.append(addSet);
    box.append(setRow);

    const favs = favsFor(preset);
    const row = (p) => {
        const star = make('span', { class: 'tsb_tstar' + (favs.includes(p.id) ? ' tsb_on' : ''), title: favs.includes(p.id) ? '자주 쓰는 토글에서 빼기' : '자주 쓰는 토글로' }, [icon('fa-star')]);
        const sw = make('span', { class: 'tsb_switch' + (p.enabled ? ' tsb_on' : '') }, [make('span', { class: 'tsb_knob' })]);
        const r = make('div', { class: 'tsb_row tsb_trow' + (p.enabled ? ' tsb_active' : ''), tabindex: '0', title: p.name }, [star, make('span', { class: 'tsb_row_text', text: p.name }), sw]);
        r.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (e.target instanceof Element && e.target.closest('.tsb_tstar')) {
                togglePromptFav(preset, p.id);
                rebuild();
                return;
            }
            await applyToggleStates({ [p.id]: !p.enabled });
            rebuild();
        });
        return r;
    };

    const favPrompts = prompts.filter(p => favs.includes(p.id));
    if (favPrompts.length) {
        box.append(make('div', { class: 'tsb_dd_head' }, [make('span', { class: 'tsb_row_text', text: '⭐ 자주 쓰는 토글' })]));
        for (const p of favPrompts) box.append(row(p));
    }
    box.append(make('div', { class: 'tsb_dd_head' }, [make('span', { class: 'tsb_row_text', text: '전체' })]));
    for (const p of prompts) box.append(row(p));
}

// ---------------------------------------------------------------- search

function clearHighlight() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete(HIGHLIGHT_NAME);
    document.querySelectorAll('#chat .mes.tsb_hit').forEach(node => node.classList.remove('tsb_hit'));
}

function openSearch() {
    closeDropdown();
    toggleProfileRow(false);
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
    // (the search button is wired in bindExtraButtons)
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

function buildSettingsContent() {
    const s = settings();

    const content = make('div', { class: 'tsb_settings_popup' });
    content.append(make('h3', { text: 'Top Slide Bar 설정' }));

    content.append(make('label', { text: '여는 방식' }), choiceGroup(
        [['both', '탭 + 스와이프'], ['tap', '탭만'], ['swipe', '스와이프만'], ['always', '항상 열어두기']],
        s.openMode, (v) => { settings().openMode = v; applyOpenMode(); save(); }));
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
    numField('retryDelay', '재시도 사이 대기 (초)', 1, 60);
    const check = (key, label) => {
        const box = make('input', { type: 'checkbox' });
        box.checked = !!settings()[key];
        box.addEventListener('change', () => { settings()[key] = box.checked; save(); });
        content.append(make('label', { class: 'checkbox_label' }, [box, make('span', { text: label })]));
    };
    check('retryBackoff', '재시도할수록 대기를 조금씩 늘리기 (1.3배씩, 최대 30초)');
    check('retryCleanup', '답을 받으면 실패한 스와이프(빈 답 등) 지우기');
    numField('retryMinChars', '이보다 짧은 답도 실패로 치기 (글자 수, 0이면 끔)', 0, 2000);
    check('retryRefusalOn', '거절 문구로 시작하는 답도 다시 시도');
    const refusal = make('textarea', { class: 'text_pole', rows: '4' });
    refusal.value = String(settings().retryRefusals || '');
    refusal.addEventListener('change', () => { settings().retryRefusals = refusal.value; save(); });
    content.append(make('label', { text: '거절 문구 (한 줄에 하나, 답 앞부분에 있으면 실패로 봐요)' }), refusal);
    content.append(make('small', { text: '429·서버 오류·빈 답은 다시 시도하고, 키 문제(401·403)나 잘못된 요청(400)은 다시 해도 소용없어서 바로 멈춰요. 재시도 버튼을 길게 누르면 기록이 보여요.' }));
    content.append(make('small', { text: 'API 오류(429 등)나 빈 응답이 오면 자동으로 다시 생성해요. ST의 중지 버튼을 누르면 멈춰요. 이어쓰기와 백그라운드 생성은 건드리지 않아요.' }));

    content.append(make('div', { class: 'tsb_set_title', text: '페르소나 번역' }));
    const trSelect = make('select', { class: 'text_pole', id: 'tsb_set_tr' });
    trSelect.append(make('option', { value: '', text: '(번역 안 씀)' }));
    let trProfiles = [];
    try { trProfiles = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { trProfiles = []; }
    for (const p of trProfiles) {
        const option = make('option', { value: p.id, text: p.name });
        if (s.translateProfileId === p.id) option.selected = true;
        trSelect.append(option);
    }
    trSelect.addEventListener('change', () => {
        settings().translateProfileId = trSelect.value;
        save();
    });
    content.append(make('label', { for: 'tsb_set_tr', text: '번역에 쓸 연결 프로필 (싼 모델 추천)' }), trSelect);
    content.append(make('small', { text: '페르소나 카드의 [EN | 한]으로 한글로 읽고, "한글 줄만 영어로"로 한글로 쓴 줄만 영어로 바꿔요. 이미 영어인 줄은 절대 다시 번역하지 않아요. 채팅별 메모를 한글로 쓰면 AI에게는 영어로 바꿔서 보내요.' }));

    content.append(make('div', { class: 'tsb_set_title', text: '바 색 · 투명도 · 크기' }));
    const colorRow = make('div', { class: 'tsb_lookrow' });
    const colorInput = make('input', { type: 'color' });
    colorInput.value = /^#[0-9a-f]{6}$/i.test(s.barColor) ? s.barColor : '#f1e7d0';
    const followBox = make('input', { type: 'checkbox' });
    followBox.checked = !s.barColor;
    colorInput.disabled = followBox.checked;
    followBox.addEventListener('change', () => {
        colorInput.disabled = followBox.checked;
        settings().barColor = followBox.checked ? '' : colorInput.value;
        save(); applyBarLook();
    });
    colorInput.addEventListener('input', () => { if (!followBox.checked) { settings().barColor = colorInput.value; save(); applyBarLook(); } });
    colorRow.append(make('label', { class: 'checkbox_label' }, [followBox, make('span', { text: '테마 색 따라가기' })]), colorInput);
    content.append(colorRow);
    const slider = (key, label, min, max, unit) => {
        const value = make('span', { class: 'tsb_lookval', text: `${s[key]}${unit}` });
        const input = make('input', { type: 'range', min: String(min), max: String(max), step: '5' });
        input.value = String(s[key]);
        input.addEventListener('input', () => {
            settings()[key] = Number(input.value);
            value.textContent = `${input.value}${unit}`;
            save(); applyBarLook();
        });
        content.append(make('div', { class: 'tsb_lookrow' }, [make('span', { class: 'tsb_looklabel', text: label }), input, value]));
    };
    slider('barOpacity', '투명도', 20, 100, '%');
    slider('barScale', '크기', 80, 130, '%');

    content.append(make('div', { class: 'tsb_set_title', text: '바 버튼 꾸미기' }));
    content.append(make('small', { text: '체크한 버튼만 바에 나와요. ▲▼로 순서를 바꿔요.' }));
    const btnList = make('div', { class: 'tsb_btnlist' });
    const btnWarn = make('small', { class: 'tsb_btnwarn' });
    const drawBtnList = () => {
        btnList.replaceChildren();
        const list = barButtons();
        list.forEach((item, i) => {
            const meta = BAR_BUTTONS.find(b => b.key === item.key);
            const box = make('input', { type: 'checkbox' });
            box.checked = !!item.on;
            box.addEventListener('change', () => { item.on = box.checked; save(); arrangeButtons(); drawBtnList(); });
            const up = make('div', { class: 'tsb_btnmove' + (i === 0 ? ' tsb_dim' : ''), title: '위로' }, [icon('fa-chevron-up')]);
            const down = make('div', { class: 'tsb_btnmove' + (i === list.length - 1 ? ' tsb_dim' : ''), title: '아래로' }, [icon('fa-chevron-down')]);
            const move = (d) => {
                const j = i + d;
                if (j < 0 || j >= list.length) return;
                [list[i], list[j]] = [list[j], list[i]];
                save(); arrangeButtons(); drawBtnList();
            };
            up.addEventListener('click', () => move(-1));
            down.addEventListener('click', () => move(1));
            const iconEl = item.key === 'persona' ? icon('fa-user') : (el.barEls[item.key]?.querySelector('i')?.cloneNode(true) ?? icon('fa-circle'));
            btnList.append(make('div', { class: 'tsb_btnrow' + (item.on ? ' tsb_on' : '') }, [
                make('label', { class: 'tsb_btnlabel' }, [box, iconEl, make('span', { class: 'tsb_btnname' }, [make('b', { text: meta?.label ?? item.key }), make('small', { text: meta?.hint ?? '' })])]),
                up, down,
            ]));
        });
        const n = list.filter(x => x.on).length;
        btnWarn.textContent = n > 7 ? `지금 ${n}개를 켰어요. 모바일에서는 한 줄에 6~7개 정도가 편해요.` : '';
    };
    drawBtnList();
    const resetBtns = make('div', { class: 'menu_button tsb_btnreset', text: '기본 구성으로 되돌리기' });
    resetBtns.addEventListener('click', () => {
        settings().barButtons = BAR_BUTTONS.map(b => ({ key: b.key, on: DEFAULT_ON.includes(b.key) }));
        save(); arrangeButtons(); drawBtnList();
    });
    content.append(btnList, btnWarn, resetBtns);

    content.append(make('div', { class: 'tsb_set_title', text: '새 채팅 버튼' }));
    const curTap = s.newChatTap === 'branchLast' ? 'branchVisible' : (s.newChatTap || 'new');
    content.append(make('label', { text: '탭하면 할 일 (길게 누르면 항상 메뉴)' }), choiceGroup(
        [['new', '새 채팅'], ['menu', '메뉴 열기'], ['branchVisible', '화면 메시지에서 분기']],
        curTap, (v) => { settings().newChatTap = v; save(); }));

    content.append(make('div', { class: 'tsb_set_title', text: '채팅 목록 버튼' }));
    content.append(make('label', { text: '탭하면 열 것 (길게 누르면 다른 쪽)' }), choiceGroup(
        [['chats', '기본 채팅 목록'], ['subway', '깡통 노선도']],
        s.mapTarget || 'chats', (v) => {
            settings().mapTarget = v;
            save();
            updateMapButton();
            if (v === 'subway' && !hasSubway()) toastr.info('깡통 노선도 확장이 없어서 기본 채팅 목록이 열려요.');
        }));

    content.append(make('div', { class: 'tsb_set_title', text: '바 왼쪽 항목' }));
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

    return content;
}

/** Settings live in a popup opened from the bar (sliders icon) or with /topbar, not in the extensions list. */
async function openSettings() {
    closeDropdown();
    const c = ctx();
    const type = c.POPUP_TYPE?.TEXT ?? 1;
    try {
        await c.callGenericPopup(buildSettingsContent(), type, '', { okButton: '닫기', allowVerticalScrolling: true });
    } catch (error) {
        console.error('[TopSlideBar] Settings popup failed', error);
    }
}

function registerSettingsCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'topbar',
        aliases: ['상단바'],
        callback: () => {
            openSettings();
            return '';
        },
        returns: 'nothing',
        helpString: '<div>Top Slide Bar 설정 창을 열어요.</div>',
    }));
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
    registerSettingsCommand();
    applyVisibility();

    el.personaBtn.addEventListener('click', () => openDropdown('persona', buildPersonaList));
    bindLongPress(el.loreBtn, () => openDropdown('lore', buildLoreList), () => openDropdown('lorepreview', buildLorePreview));
    bindLongPress(el.model, () => openDropdown('info', buildReplyInfo), () => openDropdown('models', (box) => { buildModelSwitch(box); }));
    bindLongPress(el.retryBtn, toggleRetry, () => openDropdown('retrylog', buildRetryLog));
    bindExtraButtons();
    arrangeButtons();
    applyBarLook();
    watchGenerateRequests();
    for (const pin of [el.pinBtn, el.pinBtnRow]) {
        pin.addEventListener('click', (e) => {
            e.stopPropagation();
            onPinClick();
        });
    }
    onEvents(['SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER', 'PRESET_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'MAIN_API_CHANGED'], rememberSetupDebounced);
    onEvents(['GENERATION_STARTED'], (type, _o, dryRun) => {
        if (!dryRun && type !== 'quiet') rememberSetup(false, true);
    });
    updateRetryButton();
    bindNewChatButton();
    el.profileBox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleProfileRow();
    });
    for (const btn of [el.setBtn, el.setBtnRow, el.setBtnLone]) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openSettings();
        });
    }
    bindLongPress(el.mapBtn, onMapTap, onMapLongPress);
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
        updateMapButton();
        // The other extension may add its menu item a bit later
        setTimeout(updateMapButton, 3000);
        updateModel();
        updatePersona();
        updateExtraPrompt();
        updateNotePrompt();
        applyVariantForChat();
        updateLore();
        updateWarn();
    };
    const { eventSource, event_types } = ctx();
    eventSource.once(event_types.APP_READY, ready);

    onEvents(['ONLINE_STATUS_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED', 'MAIN_API_CHANGED'], updateModelDebounced);
    onEvents(['PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED', 'CHAT_CHANGED'], () => {
        updatePersona();
        updateExtraPrompt();
        updateNotePrompt();
    });
    onEvents(['PERSONA_CHANGED', 'CHAT_CHANGED'], applyVariantForChatDebounced);
    onEvents(['GENERATION_STARTED'], (type, options, dryRun) => {
        onGenerationStarted(type, options, dryRun);
        onRetryGenStarted(type, options, dryRun);
    });
    onEvents(['GENERATION_ENDED'], onRetryGenEnded);
    onEvents(['GENERATION_STOPPED'], onRetryStopped);
    onEvents(['WORLD_INFO_ACTIVATED'], onWorldInfoActivated);
    onEvents(['OAI_PRESET_CHANGED_AFTER', 'CHAT_CHANGED'], debounce(() => {
        if (dropdownOwner !== 'toggles') return;
        el.dropdown.replaceChildren();
        buildToggleList(el.dropdown);
    }, 400));
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
