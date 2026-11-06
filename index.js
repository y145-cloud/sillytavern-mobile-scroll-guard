/**
 * 手机流式滚动守护 / Mobile Stream Scroll Guard
 *
 * 解决的问题
 * ----------
 * 手机（含 WebView 壳）上，AI 正在流式输出时，只要自己往下翻看已经吐出来的内容，
 * 画面就会跳回「本楼最开头」；电脑上却正常。
 *
 * 手机端为什么会被拽走（找得到的三个力）
 * --------------------------------------
 * 1. 别的扩展在生成期间/生成结束时直接写 `#chat.scrollTop`
 *    （典型：柏宝箱 ST-BaiBai-Tools 的「生成结束定位到最新消息开头」，
 *      它的目标位置就是「最新一条消息的开头」，
 *      LONG_CHAT_DOM_RENDER_LATEST_MESSAGE_TOP_OFFSET_RATIO = 0.18，
 *      即把本楼开头放到离顶部 18% 的位置）。
 * 2. 同一个扩展在生成期间给 #chat 的所有子元素加 `overflow-anchor: none`，
 *    关掉了浏览器原生滚动锚定；随后流式输出让高度不断变化、
 *    content-visibility 的占位高度估算来回切换 —— 没有任何补偿，
 *    文字就会「自己往上跳」。
 * 3. SillyTavern 核心的 `#chat` 高度用 `100vh` 而不是 `100dvh`，
 *    手机地址栏伸缩时 #chat 比可视区高，滚动会链到整个页面上。
 *
 * 本扩展干的事
 * ------------
 * 只要「生成中 + 你已经离开底部（说明你在读）」，就进入「阅读锁定」：
 *   · 拦截其他脚本对 #chat 的 scrollTop/scrollTo/scrollBy/scrollIntoView 写入；
 *   · 每帧用「视口顶部那条消息」做锚点，把布局漂移补回去；
 *   · 重新打开浏览器原生滚动锚定；
 *   · 修正 #chat 的移动端高度。
 * 你一滑回底部立刻恢复原状，ST 的自动跟随完全不受影响。
 *
 * 不会做的事
 * ----------
 * 不删除、不修改任何其他扩展的文件；不改 ST 核心代码；
 * 设置只存在本扩展自己的 localStorage key 里。
 */

import { eventSource, event_types } from '../../../../script.js';

const LOG_PREFIX = '[STMSG]';
const STORE_KEY = 'stmsg.settings.v1';
const BADGE_ID = 'stmsg-badge';

/** 生成结束后继续守护的时长：覆盖「生成结束定位」那套 settle 定时器（最长 ~0.9s + 1.2s） */
const GRACE_AFTER_GENERATION_MS = 2400;
/** 用户最后一次手势之后，安静这么久才认为「停下来了，可以补位置」 */
const USER_QUIET_MS = 220;
/** 自己写 scrollTop 之后这段时间内的 scroll 事件不算用户滚动 */
const SELF_SCROLL_MS = 150;
/** 距底部多少像素以内算「在底部」——在底部就完全不插手 */
const BOTTOM_TOLERANCE = 64;
/** 锚点漂移超过这么多像素才补 */
const ANCHOR_TOLERANCE = 1.5;

const DEFAULTS = {
    enabled: true,
    touchOnly: true,
    suppressWrites: true,
    restoreAnchor: true,
    reenableScrollAnchor: true,
    fixChatHeight: true,
    showBadge: true,
    debug: false,
};

const settings = loadSettings();

const state = {
    generating: false,
    windowUntil: 0,
    locked: false,
    forceUnlocked: false,
    anchorEl: null,
    anchorOffset: 0,
    lastUserInputAt: 0,
    lastScrollAt: 0,
    selfScrollUntil: 0,
    writing: false,
    rafId: 0,
    previousInlineScrollBehavior: null,
    blockedWrites: 0,
    corrections: 0,
    engagements: 0,
    lastBlockedKind: '',
    badgeEl: null,
    boundChats: new WeakSet(),
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

function now() {
    return performance.now();
}

function chatEl() {
    const chat = document.getElementById('chat');
    return chat instanceof HTMLElement ? chat : null;
}

function isTouchDevice() {
    try {
        return navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
    } catch {
        return false;
    }
}

function isActive() {
    return Boolean(settings.enabled) && (!settings.touchOnly || isTouchDevice());
}

function inWindow() {
    return state.generating || now() < Number(state.windowUntil || 0);
}

function isLockedNow() {
    return state.locked && !state.forceUnlocked && isActive() && inWindow();
}

function atBottom(chat, tolerance = BOTTOM_TOLERANCE) {
    if (!(chat instanceof HTMLElement)) {
        return true;
    }
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= tolerance;
}

function loadSettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        return Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    } catch {
        return Object.assign({}, DEFAULTS);
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {
        /* localStorage 被禁用也无所谓，运行时的设置仍然生效 */
    }
}

function log(...args) {
    if (settings.debug) {
        console.log(LOG_PREFIX, ...args);
    }
}

/* ------------------------------------------------------------------ */
/* 写入拦截（对付直接写 scrollTop 的扩展）                             */
/* ------------------------------------------------------------------ */

function patchStore() {
    if (!window.__stmsgPatchStore) {
        window.__stmsgPatchStore = {};
    }
    return window.__stmsgPatchStore;
}

function installPatches() {
    const store = patchStore();

    if (!store.scrollTopDescriptor) {
        store.scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    }
    const desc = store.scrollTopDescriptor;
    if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') {
        Object.defineProperty(Element.prototype, 'scrollTop', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(value) {
                if (shouldBlockWrite(this)) {
                    state.blockedWrites += 1;
                    state.lastBlockedKind = 'scrollTop';
                    log('拦截 scrollTop 写入:', value);
                    return;
                }
                desc.set.call(this, value);
            },
        });
    }

    if (typeof Element.prototype.scrollTo === 'function') {
        if (!store.origScrollTo) {
            store.origScrollTo = Element.prototype.scrollTo;
        }
        const orig = store.origScrollTo;
        Element.prototype.scrollTo = function (...args) {
            if (shouldBlockWrite(this)) {
                state.blockedWrites += 1;
                state.lastBlockedKind = 'scrollTo';
                log('拦截 scrollTo 调用');
                return;
            }
            return orig.apply(this, args);
        };
    }

    if (typeof Element.prototype.scrollBy === 'function') {
        if (!store.origScrollBy) {
            store.origScrollBy = Element.prototype.scrollBy;
        }
        const orig = store.origScrollBy;
        Element.prototype.scrollBy = function (...args) {
            if (shouldBlockWrite(this)) {
                state.blockedWrites += 1;
                state.lastBlockedKind = 'scrollBy';
                log('拦截 scrollBy 调用');
                return;
            }
            return orig.apply(this, args);
        };
    }

    if (typeof Element.prototype.scrollIntoView === 'function') {
        if (!store.origScrollIntoView) {
            store.origScrollIntoView = Element.prototype.scrollIntoView;
        }
        const orig = store.origScrollIntoView;
        Element.prototype.scrollIntoView = function (...args) {
            const el = this;
            if (isLockedNow() && settings.suppressWrites
                && el instanceof Element
                && !el.classList.contains('stmsg-allow-scroll')
                && (el.id === 'chat' || el.closest('#chat'))) {
                state.blockedWrites += 1;
                state.lastBlockedKind = 'scrollIntoView';
                log('拦截 scrollIntoView 调用');
                return;
            }
            return orig.apply(el, args);
        };
    }
}

function shouldBlockWrite(el) {
    if (!settings.suppressWrites || state.writing || !isLockedNow()) {
        return false;
    }
    if (!(el instanceof Element)) {
        return false;
    }
    // 只挡 #chat 这个滚动容器；页面级滚动交给 CSS 处理，避免误伤
    return el.id === 'chat';
}

/** 绕过我们自己的拦截，写一次 scrollTop */
function writeScrollTop(chat, value) {
    const store = patchStore();
    const setter = store.scrollTopDescriptor && store.scrollTopDescriptor.set;
    if (typeof setter !== 'function') {
        return;
    }
    state.writing = true;
    try {
        setter.call(chat, value);
    } finally {
        state.writing = false;
    }
    state.selfScrollUntil = now() + SELF_SCROLL_MS;
}

/* ------------------------------------------------------------------ */
/* 锚点                                                               */
/* ------------------------------------------------------------------ */

/**
 * 取「当前视口顶部那条消息」作为锚点。
 * 选消息元素（.mes）而不是文本节点：流式输出会整块重建 innerHTML，
 * 文本节点每帧都会死，.mes 不会；而且流式增长发生在消息末尾，
 * 消息自身的 top 不会因为自己变长而移动。
 */
function captureAnchor(chat) {
    const chatRect = chat.getBoundingClientRect();
    const messages = chat.querySelectorAll('.mes[mesid]');
    let anchor = null;

    for (const el of messages) {
        if (!(el instanceof HTMLElement)) {
            continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) {
            continue;
        }
        if (rect.bottom > chatRect.top + 2) {
            anchor = el;
            break;
        }
    }

    state.anchorEl = anchor;
    state.anchorOffset = anchor ? anchor.getBoundingClientRect().top - chatRect.top : 0;
}

function rebaseline(chat) {
    if (!(state.anchorEl instanceof HTMLElement) || !state.anchorEl.isConnected) {
        captureAnchor(chat);
        return;
    }
    const chatRect = chat.getBoundingClientRect();
    state.anchorOffset = state.anchorEl.getBoundingClientRect().top - chatRect.top;
}

function restoreAnchor(chat) {
    if (!settings.restoreAnchor) {
        return;
    }

    if (!(state.anchorEl instanceof HTMLElement) || !state.anchorEl.isConnected) {
        captureAnchor(chat);
        return;
    }

    const chatRect = chat.getBoundingClientRect();
    const current = state.anchorEl.getBoundingClientRect().top - chatRect.top;
    const delta = current - state.anchorOffset;

    if (Math.abs(delta) < ANCHOR_TOLERANCE) {
        return;
    }

    const before = chat.scrollTop;
    writeScrollTop(chat, before + delta);
    if (Math.abs(chat.scrollTop - before) > 0.5) {
        state.corrections += 1;
        log('补位置:', delta.toFixed(1), 'scrollTop', before.toFixed(1), '→', chat.scrollTop.toFixed(1));
    }

    // 写完之后重新对齐基准，避免下一帧来回拉锯
    rebaseline(chat);
}

/* ------------------------------------------------------------------ */
/* 锁定 / 解锁                                                        */
/* ------------------------------------------------------------------ */

function engage(reason) {
    if (state.locked || state.forceUnlocked || !isActive() || !inWindow()) {
        return;
    }
    const chat = chatEl();
    if (!chat || atBottom(chat)) {
        return;
    }

    state.locked = true;
    state.engagements += 1;
    captureAnchor(chat);

    if (settings.fixChatHeight) {
        try {
            if (window.getComputedStyle(chat).scrollBehavior === 'smooth') {
                state.previousInlineScrollBehavior = chat.style.scrollBehavior;
                chat.style.scrollBehavior = 'auto';
            }
        } catch {
            /* 忽略 */
        }
    }

    document.body.classList.add('stmsg-reading-lock');
    updateBadge();
    log('阅读锁定开启:', reason);
}

function disengage(reason) {
    if (!state.locked) {
        return;
    }
    state.locked = false;
    document.body.classList.remove('stmsg-reading-lock');

    const chat = chatEl();
    if (chat && state.previousInlineScrollBehavior !== null) {
        chat.style.scrollBehavior = state.previousInlineScrollBehavior;
    }
    state.previousInlineScrollBehavior = null;

    updateBadge();
    log('阅读锁定关闭:', reason);
}

/* ------------------------------------------------------------------ */
/* 每帧守护                                                           */
/* ------------------------------------------------------------------ */

function tick() {
    state.rafId = 0;

    if (!isActive() || !inWindow() || state.forceUnlocked) {
        disengage('window-ended');
        return;
    }

    const chat = chatEl();
    if (!chat) {
        disengage('no-chat');
        return;
    }

    // 在底部 = 让 ST 自己跟随，完全不插手
    if (atBottom(chat)) {
        disengage('at-bottom');
        rebaseline(chat);
        schedule();
        return;
    }

    // 手指/滚轮还在动：跟着用户走，不抢位置
    const lastInput = Math.max(Number(state.lastUserInputAt || 0), Number(state.lastScrollAt || 0));
    if (now() - lastInput < USER_QUIET_MS) {
        rebaseline(chat);
        schedule();
        return;
    }

    // 停下来了又不在底部 —— 说明在读，开始守护
    if (!state.locked) {
        engage('reading');
        if (!state.locked) {
            schedule();
            return;
        }
    }

    restoreAnchor(chat);
    schedule();
}

function schedule() {
    if (state.rafId) {
        return;
    }
    if (!inWindow() || !isActive()) {
        return;
    }
    state.rafId = requestAnimationFrame(tick);
}

function startWindow() {
    state.forceUnlocked = false;
    ensureChatScrollListener();
    if (!state.rafId && isActive()) {
        schedule();
    }
}

function endWindow(delayMs = GRACE_AFTER_GENERATION_MS) {
    state.windowUntil = Math.max(Number(state.windowUntil || 0), now() + delayMs);
    schedule();
}

/* ------------------------------------------------------------------ */
/* 事件                                                               */
/* ------------------------------------------------------------------ */

function onUserInput() {
    state.lastUserInputAt = now();
    if (!isActive() || !inWindow() || state.forceUnlocked) {
        return;
    }
    const chat = chatEl();
    if (!chat || atBottom(chat)) {
        return;
    }
    // 用户主动离开了底部，立刻进入守护（不等下一帧）
    engage('user-input');
    startWindow();
}

function onChatScroll(event) {
    const chat = chatEl();
    if (!chat) {
        return;
    }
    if (event.target !== chat) {
        return;
    }
    if (now() < Number(state.selfScrollUntil || 0)) {
        return; // 我们自己写的，不算用户滚动
    }
    state.lastScrollAt = now();

    if (!isActive()) {
        return;
    }

    if (atBottom(chat)) {
        disengage('user-at-bottom');
        rebaseline(chat);
        return;
    }

    if (inWindow() && !state.forceUnlocked && !state.locked) {
        engage('scroll');
    }
    schedule();
}

function ensureChatScrollListener() {
    const chat = chatEl();
    if (!chat || state.boundChats.has(chat)) {
        return;
    }
    chat.addEventListener('scroll', onChatScroll, { passive: true });
    state.boundChats.add(chat);
}

function bindDomEvents() {
    const opts = { passive: true, capture: true };
    for (const type of ['touchstart', 'touchmove', 'pointerdown', 'wheel']) {
        document.addEventListener(type, (event) => {
            const chat = chatEl();
            if (!chat) {
                return;
            }
            const target = event.target;
            if (target === chat || (target instanceof Node && chat.contains(target))) {
                onUserInput();
            }
        }, opts);
    }

    window.addEventListener('resize', () => {
        const chat = chatEl();
        if (chat && state.locked) {
            rebaseline(chat);
        }
    }, { passive: true });

    // #chat 可能被 ST 重建（换聊天等），定期确认监听还在
    setInterval(() => {
        if (inWindow()) {
            ensureChatScrollListener();
        }
    }, 2000);
}

function bindStEvents() {
    if (!eventSource || !event_types) {
        console.warn(LOG_PREFIX, '拿不到 eventSource / event_types，扩展不会生效');
        return;
    }

    eventSource.on(event_types.GENERATION_STARTED, () => {
        state.generating = true;
        state.windowUntil = 0;
        startWindow();
        log('生成开始');
    });

    const onGenerationFinished = (kind) => {
        state.generating = false;
        endWindow();
        log('生成结束:', kind);
    };

    eventSource.on(event_types.GENERATION_ENDED, () => onGenerationFinished('ended'));
    eventSource.on(event_types.GENERATION_STOPPED, () => onGenerationFinished('stopped'));

    eventSource.on(event_types.CHAT_CHANGED, () => {
        state.forceUnlocked = false;
        disengage('chat-changed');
        state.anchorEl = null;
        ensureChatScrollListener();
    });
}

/* ------------------------------------------------------------------ */
/* 提示按钮                                                           */
/* ------------------------------------------------------------------ */

function ensureBadge() {
    if (!document.body) {
        return null;
    }
    if (state.badgeEl && document.body.contains(state.badgeEl)) {
        return state.badgeEl;
    }
    const badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.title = '手机流式滚动守护';
    badge.textContent = '🔒 已锁定阅读位置 · 点此解除';
    badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.forceUnlocked = true;
        disengage('user-released');
        badge.classList.add('stmsg-badge-off');
        badge.textContent = '🔓 本次生成已解除锁定';
        log('用户手动解除锁定');
    });
    document.body.appendChild(badge);
    state.badgeEl = badge;
    return badge;
}

function updateBadge() {
    const badge = ensureBadge();
    if (!badge) {
        return;
    }
    if (!settings.showBadge) {
        badge.style.display = 'none';
        return;
    }
    badge.style.display = '';
    if (state.locked) {
        badge.classList.remove('stmsg-badge-off');
        badge.textContent = '🔒 已锁定阅读位置 · 点此解除';
    }
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                           */
/* ------------------------------------------------------------------ */

const PANEL_ROWS = [
    ['enabled', '启用（手机端流式阅读锁定）'],
    ['touchOnly', '仅在触屏设备生效'],
    ['suppressWrites', '拦截其他扩展的强制跳转（推荐）'],
    ['restoreAnchor', '补偿内容高度变化导致的位移（推荐）'],
    ['reenableScrollAnchor', '恢复浏览器原生滚动锚定（推荐）'],
    ['fixChatHeight', '修正手机端 #chat 高度（100vh → 100dvh）'],
    ['showBadge', '显示锁定提示按钮'],
    ['debug', '调试日志（控制台）'],
];

function applyBodyClasses() {
    if (!document.body) {
        return;
    }
    const on = Boolean(settings.enabled);
    document.body.classList.toggle('stmsg-enabled', on);
    document.body.classList.toggle('stmsg-height', on && Boolean(settings.fixChatHeight));
    document.body.classList.toggle('stmsg-anchor-restore', on && Boolean(settings.reenableScrollAnchor));
}

function buildPanel() {
    if (!document.body || document.getElementById('stmsg-settings')) {
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'stmsg-settings';
    panel.className = 'stmsg-panel';

    const title = document.createElement('div');
    title.className = 'inline-drawer';
    title.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>手机流式滚动守护</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content"></div>
    `;

    panel.appendChild(title);

    const content = title.querySelector('.inline-drawer-content');

    const hint = document.createElement('div');
    hint.className = 'stmsg-hint';
    hint.textContent = '流式输出时你往下翻，如果别的脚本想把你拽回本楼开头，这里会拦住它。滑回底部即自动恢复。';
    content.appendChild(hint);

    for (const [key, label] of PANEL_ROWS) {
        const row = document.createElement('label');
        row.className = 'stmsg-row';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(settings[key]);
        input.addEventListener('change', () => {
            settings[key] = input.checked;
            saveSettings();
            applyBodyClasses();
            if (key === 'enabled' && !input.checked) {
                disengage('disabled');
            }
            log('设置变更:', key, input.checked);
        });
        const span = document.createElement('span');
        span.textContent = label;
        row.appendChild(input);
        row.appendChild(span);
        content.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'stmsg-actions';

    const diagBtn = document.createElement('button');
    diagBtn.type = 'button';
    diagBtn.className = 'menu_button';
    diagBtn.textContent = '诊断';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'menu_button';
    resetBtn.textContent = '恢复默认';

    actions.appendChild(diagBtn);
    actions.appendChild(resetBtn);
    content.appendChild(actions);

    const pre = document.createElement('pre');
    pre.className = 'stmsg-diag';
    content.appendChild(pre);

    diagBtn.addEventListener('click', () => {
        const chat = chatEl();
        const report = {
            触屏设备: isTouchDevice(),
            扩展生效: isActive(),
            生成中: state.generating,
            守护窗口剩余ms: Math.max(0, Math.round(Number(state.windowUntil || 0) - now())),
            阅读锁定: state.locked,
            手动解除: state.forceUnlocked,
            距底部px: chat ? Math.round(chat.scrollHeight - chat.scrollTop - chat.clientHeight) : null,
            scrollTop: chat ? Math.round(chat.scrollTop) : null,
            拦截写入次数: state.blockedWrites,
            位置补偿次数: state.corrections,
            进入锁定次数: state.engagements,
            最近拦截类型: state.lastBlockedKind || '无',
            锚点消息: state.anchorEl instanceof Element ? String(state.anchorEl.getAttribute('mesid')) : '无',
            长聊天优化是否开: Boolean(chat && chat.classList.contains('bai-bai-toolkit-long-chat-render-optimized')),
        };
        pre.textContent = JSON.stringify(report, null, 2);
        pre.classList.add('stmsg-diag-open');
        console.log(LOG_PREFIX, report);
    });

    resetBtn.addEventListener('click', () => {
        Object.assign(settings, DEFAULTS);
        saveSettings();
        applyBodyClasses();
        log('设置已恢复默认');
        panel.querySelectorAll('input[type="checkbox"]').forEach((input, index) => {
            const key = PANEL_ROWS[index] ? PANEL_ROWS[index][0] : '';
            if (key) {
                input.checked = Boolean(settings[key]);
            }
        });
    });

    const container = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (container) {
        container.appendChild(panel);
    } else {
        setTimeout(buildPanel, 1500); // 抽屉还没建好，稍后再试
    }
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

function boot() {
    if (window.__stmsgBooted) {
        return;
    }
    window.__stmsgBooted = true;

    installPatches();
    bindDomEvents();
    bindStEvents();
    applyBodyClasses();
    ensureChatScrollListener();
    ensureBadge();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            applyBodyClasses();
            ensureChatScrollListener();
            buildPanel();
        }, { once: true });
    } else {
        buildPanel();
    }

    window.stMobileScrollGuard = {
        settings,
        state,
        engage,
        disengage,
        report: () => ({
            locked: state.locked,
            blockedWrites: state.blockedWrites,
            corrections: state.corrections,
            engagements: state.engagements,
        }),
    };

    console.log(LOG_PREFIX, '已加载', { touch: isTouchDevice(), settings });
}

boot();
