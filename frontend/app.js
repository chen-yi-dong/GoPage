/* ============================================================
 * 个人导航中心
 * 功能：登录鉴权 / 数据加载 / 渲染 / 搜索 / 拖动排序 / 卡片与分组增删改
 *       设置（登录开关、背景、账号管理、关于）
 * ============================================================ */

// 后端接口地址
// 前后端同源部署（由同一个容器/端口提供），使用相对路径即可。
// 如需前后端分离调试，可改成绝对地址，例如 'http://127.0.0.1:5000'
const API_BASE = '';

// 全局状态
let config = {};              // 当前正在编辑的数据（分组 -> 卡片数组）
let editing = false;          // 是否处于编辑模式
let modalAction = null;       // 当前弹窗的提交回调
let modalValidate = null;     // 当前弹窗的实时校验函数（用于重名检测等）
let justDragged = false;      // 刚完成一次拖拽（用于屏蔽随后的误触点击）
let dirty = false;            // 是否有未保存的改动

// 鉴权与设置状态
let authToken = localStorage.getItem('nav_token') || '';
let currentUser = null;       // { username, is_admin, created_at }（免登录模式下为默认管理员）
let loggedIn = false;         // 是否真正通过登录获得会话（免登录模式下为 false）
let loginRequired = true;     // 后端是否启用了登录验证
let appMeta = { version: '-', release_date: '-' };
let appSettings = {
    background: { type: 'default', value: '' },
    search: { engines: [], current: '' },   // 搜索引擎配置（后端返回，含内置 Bing/Google）
};
// 是否允许编辑导航内容（未启用登录验证时视为可编辑）
let canEditNav = true;

/* ------------------------------------------------------------
 * 0. 请求封装：统一带上鉴权头，统一解析错误
 * ---------------------------------------------------------- */
async function api(path, options = {}) {
    const opts = {
        cache: 'no-store',
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(options.headers || {})
        }
    };

    const fullUrl = `${API_BASE}${path}`;
    let resp;
    try {
        resp = await fetch(fullUrl, opts);
    } catch (netErr) {
        // 网络层失败（服务未启动 / 跨域被拦 / 地址不可达）
        const err = new Error(`无法连接服务：${netErr.message}`);
        err.url = fullUrl;
        err.status = 0;
        throw err;
    }

    let data = null;
    try {
        data = await resp.json();
    } catch (e) {
        data = null;
    }

    if (!resp.ok) {
        const msg = (data && data.error) || `请求失败（${resp.status}）`;
        const err = new Error(msg);
        err.status = resp.status;
        err.code = data && data.code;
        err.url = fullUrl;            // 便于排查实际的请求地址
        err.responseUrl = resp.url;   // 浏览器实际请求的完整地址（含重定向后）
        throw err;
    }
    return data;
}

// 把接口错误整理成便于排查的文案
function describeApiError(err) {
    const lines = [];
    lines.push(`请求：${err.url || '(未知)'}`);
    if (err.responseUrl && err.responseUrl !== err.url) {
        lines.push(`实际：${err.responseUrl}`);
    }
    lines.push(`状态：${err.status === 0 ? '网络不可达' : err.status}`);
    lines.push(`原因：${err.message}`);
    lines.push(`页面：${location.origin}`);
    return lines.join('\n');
}

function setToken(token) {
    authToken = token || '';
    if (authToken) localStorage.setItem('nav_token', authToken);
    else localStorage.removeItem('nav_token');
}

/* ------------------------------------------------------------
 * 1. 数据层：读取 / 保存
 * ---------------------------------------------------------- */
async function fetchConfig() {
    try {
        // api() 内部已带 cache: 'no-store'，浏览器与代理都不会缓存
        return await api('/api/config');
    } catch (error) {
        console.error('获取配置失败:\n' + describeApiError(error));
        // 未登录时不显示数据，交由登录流程处理
        if (error.status === 401) return {};
        return null;
    }
}

async function saveConfig() {
    try {
        await api('/api/config', {
            method: 'POST',
            body: JSON.stringify(config)
        });
        return true;
    } catch (error) {
        console.error('保存配置失败:', error);
        toast('保存失败：' + error.message);
        return false;
    }
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// 标记有未保存的改动，并更新「保存更改」按钮状态
function markDirty() {
    dirty = true;
    updateSaveButton();
}

// 统一的「按钮不可用」处理：置灰 + 点击时说明原因
// 注意：只对「缺少必填项」或「暂不支持」的按钮置灰，可用的按钮不置灰
function setButtonUnavailable(btn, unavailable, reason) {
    if (!btn) return;
    btn.classList.toggle('unavailable', !!unavailable);
    btn.dataset.unavailableReason = unavailable ? (reason || '该操作当前不可用') : '';
}

// 点击不可用按钮时统一拦截并提示原因
function guardUnavailable(btn, handler) {
    if (!btn) return;
    btn.addEventListener('click', e => {
        if (btn.classList.contains('unavailable')) {
            e.preventDefault();
            e.stopPropagation();
            toast(btn.dataset.unavailableReason || '该操作当前不可用');
            return;
        }
        if (typeof handler === 'function') handler(e);
    });
}

function updateSaveButton() {
    const btn = document.getElementById('saveBtn');
    if (!btn) return;
    // 只在「没有改动」时置灰，并说明原因；有改动时保持可用
    setButtonUnavailable(btn, !dirty, '没有需要保存的更改，请先修改内容');
    btn.classList.toggle('has-changes', dirty);
    btn.innerHTML = dirty
        ? '<i class="fas fa-floppy-disk"></i> 保存更改 *'
        : '<i class="fas fa-floppy-disk"></i> 保存更改';
}

/* ------------------------------------------------------------
 * 2. 渲染层
 * ---------------------------------------------------------- */
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function render() {
    const content = document.getElementById('content');
    let html = '';

    Object.keys(config).forEach((sectionName, sIndex) => {
        const items = config[sectionName] || [];
        html += `
        <div class="section" data-section="${escapeHtml(sectionName)}" data-index="${sIndex}">
            <div class="section-header">
                <i class="fas fa-grip-vertical drag-handle" data-role="section-handle"></i>
                <h2 class="section-title">${escapeHtml(sectionName)}</h2>
                <span class="section-actions">
                    <button class="icon-btn" data-action="edit-section" title="重命名分组"><i class="fas fa-pen"></i></button>
                    <button class="icon-btn danger" data-action="delete-section" title="删除分组"><i class="fas fa-trash"></i></button>
                    <button class="icon-btn" data-action="add-card" title="新增卡片"><i class="fas fa-plus"></i></button>
                </span>
            </div>
            <div class="cards-grid" data-role="grid">
                ${items.map((item, cIndex) => renderCard(item, cIndex)).join('')}
            </div>
            ${items.length === 0 ? '<div class="empty-tip">该分组暂无卡片，点击上方 + 添加</div>' : ''}
        </div>`;
    });

    if (!Object.keys(config).length) {
        html = '<p style="color:#fff;text-align:center;">暂无分组，点击上方“新增分组”开始添加</p>';
    }

    content.innerHTML = html;
    bindConfigItems();
    applyFilter(document.getElementById('searchInput').value);
    updateBodyState();
}

// 把每个卡片 DOM 节点与它在 config 中的对象关联起来，供拖动排序时还原顺序
function bindConfigItems() {
    document.querySelectorAll('.section').forEach(sectionEl => {
        const sectionName = sectionEl.dataset.section;
        const list = config[sectionName] || [];
        sectionEl.querySelectorAll('[data-role="grid"] > .card').forEach((cardEl, i) => {
            cardEl._configItem = list[i] || null;
        });
    });
}

function renderCard(item, cIndex) {
    // 编辑模式下不写入 href，从根本上避免拖拽结束后触发链接跳转/刷新
    const hrefAttr = editing ? '' : `href="${escapeHtml(item.url)}" target="_blank"`;
    return `
    <a ${hrefAttr} class="card" data-url="${escapeHtml(item.url)}"
       data-name="${escapeHtml((item.name || '').toLowerCase())}"
       data-index="${cIndex}">
        <span class="drag-handle" data-role="card-handle"><i class="fas fa-grip-vertical"></i></span>
        <span class="card-actions">
            <button class="icon-btn" data-action="edit-card" title="编辑"><i class="fas fa-pen"></i></button>
            <button class="icon-btn danger" data-action="delete-card" title="删除"><i class="fas fa-trash"></i></button>
        </span>
        <div class="card-icon"><i class="${escapeHtml(item.icon || 'fa fa-link')}"></i></div>
        <div>${escapeHtml(item.name)}</div>
    </a>`;
}

function updateBodyState() {
    document.body.classList.toggle('editing', editing && canEditNav);

    const toggleBtn = document.getElementById('editToggle');
    toggleBtn.classList.toggle('active', editing && canEditNav);
    toggleBtn.innerHTML = (editing && canEditNav)
        ? '<i class="fas fa-check"></i> 退出编辑'
        : '<i class="fas fa-pen"></i> 编辑模式';

    // 未登录（启用登录验证但无会话）时，禁止进入编辑模式
    setButtonUnavailable(toggleBtn, !canEditNav, '请先登录后再编辑');

    document.getElementById('addSectionBtn').style.display = (editing && canEditNav) ? '' : 'none';
    document.getElementById('saveBtn').style.display = (editing && canEditNav) ? '' : 'none';
    updateSaveButton();
}

/* ------------------------------------------------------------
 * 3. 搜索
 * ---------------------------------------------------------- */
function applyFilter(rawQuery) {
    const query = (rawQuery || '').toLowerCase().trim();
    const cards = document.querySelectorAll('.card');
    const sections = document.querySelectorAll('.section');
    let hasResults = false;

    cards.forEach(card => {
        const match = card.dataset.name.includes(query);
        card.style.display = match ? 'flex' : 'none';
        if (match) hasResults = true;
    });

    sections.forEach(section => {
        const visibleCards = section.querySelectorAll('.card:not([style*="display: none"])');
        // 空分组始终保留显示（只在「搜索无结果」时隐藏），避免退出编辑模式后
        // 用户配置的分组看起来消失；同时方便在非编辑模式下也能看到「该分组暂无内容」
        const keepVisible = !query;
        section.style.display = (visibleCards.length > 0 || keepVisible) ? 'block' : 'none';
    });

    document.getElementById('noResults').style.display = hasResults ? 'none' : 'block';
}

function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', function () {
        applyFilter(this.value);
    });
}

/* ------------------------------------------------------------
 * 3.1 网页搜索（可切换搜索引擎，引擎在设置页管理）
 * ---------------------------------------------------------- */
// 根据引擎 id/名称挑选一个合适的品牌图标
// 注意：精简版 Font Awesome 未收录 fa-bing / fa-duckduckgo，
// 分别用 fa-microsoft（微软标）与 fa-searchengin 代替
function engineIconClass(engine) {
    const key = `${engine.id} ${engine.name}`.toLowerCase();
    if (key.includes('bing')) return 'fab fa-microsoft';
    if (key.includes('google')) return 'fab fa-google';
    if (key.includes('duck')) return 'fab fa-searchengin';
    return 'fas fa-magnifying-glass';
}

function currentEngine() {
    const list = appSettings.search.engines || [];
    return list.find(e => e.id === appSettings.search.current) || list[0] || null;
}

function renderHeroSearch() {
    const engine = currentEngine();
    const icon = document.getElementById('engineIcon');
    const name = document.getElementById('engineName');
    const input = document.getElementById('webSearchInput');
    if (!engine) {
        if (icon) icon.className = 'fas fa-magnifying-glass';
        if (name) name.textContent = '搜索';
        if (input) input.placeholder = '搜索网页…';
        return;
    }
    if (icon) icon.className = engineIconClass(engine);
    if (name) name.textContent = engine.name;
    if (input) input.placeholder = `用 ${engine.name} 搜索，回车直达…`;
}

function renderEngineMenu() {
    const menu = document.getElementById('engineMenu');
    if (!menu) return;
    const list = appSettings.search.engines || [];
    menu.innerHTML = list.map(e => `
        <button type="button" class="engine-item${e.id === appSettings.search.current ? ' active' : ''}"
                data-engine-id="${escapeHtml(e.id)}">
            <i class="${engineIconClass(e)}"></i>
            <span class="engine-item-name">${escapeHtml(e.name)}</span>
            ${e.id === appSettings.search.current ? '<i class="fas fa-check"></i>' : ''}
        </button>`).join('');
}

function toggleEngineMenu(show) {
    const menu = document.getElementById('engineMenu');
    if (!menu) return;
    const open = show === undefined ? !menu.classList.contains('show') : !!show;
    if (open) renderEngineMenu();
    menu.classList.toggle('show', open);
}

async function switchEngine(id) {
    try {
        const res = await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({ search: { current: id } })
        });
        if (res.search) appSettings.search = res.search;
        renderHeroSearch();
        toast('已切换搜索引擎');
    } catch (error) {
        toast('切换失败：' + error.message);
    }
}

function doWebSearch() {
    const input = document.getElementById('webSearchInput');
    const q = (input.value || '').trim();
    if (!q) { input.focus(); return; }
    const engine = currentEngine();
    if (!engine) { toast('请先在设置中添加搜索引擎'); return; }
    const url = engine.url.replace('{kw}', encodeURIComponent(q));
    window.open(url, '_blank', 'noopener');
}

function setupWebSearch() {
    const box = document.getElementById('webSearchBox');
    const chip = document.getElementById('engineChip');
    const input = document.getElementById('webSearchInput');
    const go = document.getElementById('webSearchGo');
    if (!box) return;

    chip.addEventListener('click', e => {
        e.stopPropagation();
        toggleEngineMenu();
    });

    // 引擎菜单项点击（事件委托，菜单内容会重绘）
    document.getElementById('engineMenu').addEventListener('click', async e => {
        const item = e.target.closest('.engine-item');
        if (!item) return;
        toggleEngineMenu(false);
        await switchEngine(item.dataset.engineId);
    });

    // 点击其它区域 / Esc 关闭菜单
    document.addEventListener('click', e => {
        if (!box.contains(e.target)) toggleEngineMenu(false);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') toggleEngineMenu(false);
    });

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') doWebSearch();
    });
    go.addEventListener('click', doWebSearch);
}

/* ------------------------------------------------------------
 * 4. 拖动排序（Pointer Events 实现，支持实时预览）
 *    用「占位元素」实时反映移动结果：拖动过程中其他卡片/分组会被挤开
 * ---------------------------------------------------------- */

// 拖动会话状态
let dndSession = null;

function setupDragAndDrop() {
    const content = document.getElementById('content');
    if (content.dataset.dndReady === '1') return;
    content.dataset.dndReady = '1';

    // 用 Pointer Events 统一起点，鼠标 / 触屏都可用
    content.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
}

// 取得占位元素（复用同一个小方块）
function getPlaceholder() {
    let ph = document.getElementById('dnd-placeholder');
    if (!ph) {
        ph = document.createElement('div');
        ph.id = 'dnd-placeholder';
        ph.className = 'dnd-placeholder';
    }
    return ph;
}

function placePlaceholder(target, position /* 'before' | 'after' | 'append' */) {
    const ph = getPlaceholder();
    if (!target) return;

    // 计算占位块应处的位置，若与当前位置相同则不做任何 DOM 操作，避免来回闪烁
    let referenceNode;
    if (position === 'append') {
        referenceNode = null; // 追加到末尾
    } else if (position === 'before') {
        referenceNode = target;
    } else {
        referenceNode = target.nextSibling;
    }

    if (position === 'append') {
        if (ph.parentNode === target && ph === target.lastElementChild) return;
        target.appendChild(ph);
    } else {
        if (ph.parentNode === target.parentNode && ph.nextSibling === referenceNode) return;
        target.parentNode.insertBefore(ph, referenceNode);
    }
}

function removePlaceholder() {
    const ph = document.getElementById('dnd-placeholder');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
    // 清除上次拖动遗留的内联尺寸，避免影响下一次拖动
    if (ph) {
        ph.style.width = '';
        ph.style.height = '';
    }
}

/* ---------- 起点 ---------- */
function onPointerDown(e) {
    if (!editing) return;
    if (e.button !== undefined && e.button !== 0) return; // 只响应左键

    const cardAction = e.target.closest('.card-actions');
    const sectionAction = e.target.closest('.section-actions');
    if (cardAction || sectionAction) return; // 点击操作按钮不触发拖动

    const card = e.target.closest('.card');
    const section = e.target.closest('.section');
    const onSectionHandle = e.target.closest('[data-role="section-handle"]');

    if (card && !onSectionHandle) {
        startCardDrag(e, card);
    } else if (onSectionHandle && section) {
        startSectionDrag(e, section);
    }
}

function startCardDrag(e, card) {
    const sectionEl = card.closest('.section');
    const rect = card.getBoundingClientRect();

    const ghost = card.cloneNode(true);
    ghost.classList.add('dnd-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.display = 'none'; // 达到拖动阈值后才显示
    document.body.appendChild(ghost);

    dndSession = {
        type: 'card',
        node: card,
        ghost,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        homeSection: sectionEl.dataset.section,
        // 记录被拖动卡片对应的数据对象，跨组时用于从原分组移除
        item: card._configItem || null,
        size: { width: rect.width, height: rect.height }
    };
    moveGhost(e.clientX, e.clientY);

    e.preventDefault();
}

function startSectionDrag(e, section) {
    const rect = section.getBoundingClientRect();
    const ghost = section.cloneNode(true);
    ghost.classList.add('dnd-ghost', 'dnd-ghost-section');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.display = 'none'; // 达到拖动阈值后才显示
    document.body.appendChild(ghost);

    // 锁定拖动开始时的「其它分组」顺序与位置快照（排除自身），
    // 后续间隙判定以此为准，避免 DOM 被插入占位块/隐藏源元素后产生漂移
    const container = document.getElementById('content');
    const sectionBase = Array.prototype.slice
        .call(container.querySelectorAll(':scope > .section'))
        .filter(el => el !== section)
        .map(el => ({
            name: el.dataset.section,
            el,
            rect: el.getBoundingClientRect()
        }));

    dndSession = {
        type: 'section',
        node: section,
        ghost,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        size: { width: rect.width, height: rect.height },
        sectionBase
    };
    moveGhost(e.clientX, e.clientY);

    e.preventDefault();
}

function moveGhost(x, y) {
    if (!dndSession) return;
    const { ghost, offsetX, offsetY } = dndSession;
    ghost.style.left = (x - offsetX) + 'px';
    ghost.style.top = (y - offsetY) + 'px';
}

/* ---------- 移动中：实时预览 ---------- */
function onPointerMove(e) {
    if (!dndSession) return;

    // 移动超过阈值才开始真正拖动，避免误触
    if (!dndSession.started) {
        const dx = Math.abs(e.clientX - dndSession.startX);
        const dy = Math.abs(e.clientY - dndSession.startY);
        if (dx < 5 && dy < 5) return;
        dndSession.started = true;
        // 显示幽灵元素、隐藏原元素（保留在 DOM 中以保证索引计算稳定）
        dndSession.ghost.style.display = '';
        dndSession.node.classList.add('dnd-source-hidden');
        document.body.classList.add('dragging-active');
        // 重置落点槽位状态（首次移动时立刻判定一次）
        dndSession.slotKey = null;
        // 占位元素先放到原元素之前，营造"原位留空"效果
        const ph = getPlaceholder();
        // 让占位块与原元素尺寸一致，避免所在网格行高/列宽跳变导致的闪烁
        if (dndSession.size) {
            ph.style.width = dndSession.size.width + 'px';
            ph.style.height = dndSession.size.height + 'px';
        }
        dndSession.node.parentNode.insertBefore(ph, dndSession.node);
    }

    moveGhost(e.clientX, e.clientY);
    e.preventDefault();

    // 计算当前指针命中的「落点槽位」（带滞回：槽位不变时不再重新判定/触发换位）
    const slot = dndSession.type === 'card'
        ? resolveCardSlot(e)
        : resolveSectionSlot(e);

    if (!slot) return;

    // 槽位未变化 → 什么都不做，避免鼠标轻微移动就来回换位
    // 槽位由「间隙下标」构成，只要指针还在同一间隙内，就不会触发任何变化
    if (dndSession.slotKey === slot.key) return;

    dndSession.slotKey = slot.key;

    // 清除旧高亮
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));

    // 用 FLIP 技术让「被挤走」的卡片平滑移动，而不是生硬跳位
    // 拖动卡片时只动画卡片（不动画分组），拖动分组时才动画分组，避免整页抖动
    const selector = dndSession.type === 'card' ? '.card' : '.section';
    const before = capturePositions(document.getElementById('content'), selector);

    slot.apply();

    playFlip(before);
}

/* ---------- 落点判定（按「卡片之间的间隙」判定，并带滞回） ---------- */

function resolveCardSlot(e) {
    dndSession.ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return null;

    const grid = el.closest('[data-role="grid"]');
    const section = el.closest('.section');
    const dropZone = el.closest('[data-role="drop-zone"]');

    // 找到指针所在（或最接近）的分组网格
    const gridEl = grid || (section && section.querySelector('[data-role="grid"]'));
    if (!gridEl) {
        if (dropZone) {
            const zoneSection = dropZone.closest('.section');
            return {
                key: `zone:${zoneSection.dataset.section}`,
                apply() {
                    placePlaceholder(dropZone, 'before');
                    dropZone.classList.add('drop-target');
                }
            };
        }
        return null;
    }

    const sectionName = gridEl.closest('.section').dataset.section;

    // 收集该网格中所有卡片（排除被拖动的源卡片）及其位置
    const cards = Array.prototype.slice
        .call(gridEl.querySelectorAll(':scope > .card'))
        .filter(c => c !== dndSession.node);

    if (!cards.length) {
        return {
            key: `empty:${sectionName}`,
            apply() {
                placePlaceholder(gridEl, 'append');
                gridEl.classList.add('drop-target');
            }
        };
    }

    // 计算插入槽位：把「卡片之间的间隙」当作判定区域
    // 槽位 0 = 第 1 张卡片之前；槽位 i = 第 i 张卡片之后；槽位 n = 最后一张之后
    // 用每张卡片的中线作为间隙分界：指针在卡片 i 中线左侧 → 插入到 i 之前
    const rects = cards.map(c => c.getBoundingClientRect());

    let slotIndex = cards.length;            // 默认插到最后
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const midX = r.left + r.width / 2;
        if (e.clientX < midX) {
            slotIndex = i;
            break;
        }
    }

    const refCard = cards[slotIndex];        // 插入到它之前；slotIndex === cards.length 时插到最后
    // key 由「分组 + 间隙下标」构成：只要指针还在同一间隙内，key 不变 → 不做任何操作
    const slotKey = `slot:${sectionName}:${slotIndex}`;

    return {
        key: slotKey,
        apply() {
            if (refCard) {
                placePlaceholder(refCard, 'before');
                refCard.classList.add('drop-target');
            } else {
                placePlaceholder(gridEl, 'append');
                gridEl.classList.add('drop-target');
            }
        }
    };
}

// 分组拖动：按「分组之间的间隙」判定插入槽位（带滞回）
// 以拖动开始时锁定的原始分组顺序为基准，计算指针落在哪个间隙，
// 避免因为 DOM 中被插入占位块 / 源元素被隐藏而导致判定漂移
function resolveSectionSlot(e) {
    dndSession.ghost.style.pointerEvents = 'none';

    const base = dndSession.sectionBase;   // [{ name, el, rect }]，拖动开始时快照
    if (!base || !base.length) return null;

    // 槽位 0 = 第 1 个分组之前；槽位 i = 第 i 个分组之前；槽位 n = 最后之后
    let slotIndex = base.length;
    for (let i = 0; i < base.length; i++) {
        const r = base[i].rect;
        const midY = r.top + r.height / 2;
        if (e.clientY < midY) {
            slotIndex = i;
            break;
        }
    }

    const refEntry = base[slotIndex];
    return {
        key: `slot:${slotIndex}`,
        apply() {
            const container = document.getElementById('content');

            if (!refEntry) {
                // 插到最后
                container.appendChild(getPlaceholder());
                base[base.length - 1].el.classList.add('drop-target');
                return;
            }

            container.insertBefore(getPlaceholder(), refEntry.el);
            refEntry.el.classList.add('drop-target');
        }
    };
}

// 记录元素位置（FLIP: First）
// 注意：先取消进行中的位移动画，否则 getBoundingClientRect 会被动画的 transform 污染，
// 导致「测量 → 动画 → 再测量」形成反馈回路，表现为小卡片来回闪烁
function capturePositions(root, selector) {
    const map = new Map();
    root.querySelectorAll(selector || '.card, .section').forEach(el => {
        if (el.classList.contains('dnd-source-hidden')) return;
        if (el._flipAnim) {
            el._flipAnim.cancel();
            el._flipAnim = null;
        }
        const r = el.getBoundingClientRect();
        map.set(el, { left: r.left, top: r.top });
    });
    return map;
}

// 播放位置变化动画（FLIP: Invert + Play）
// 使用 Web Animations API，避免与进行中的动画互相打断而产生闪烁
function playFlip(beforeMap) {
    beforeMap.forEach((prev, el) => {
        if (!el.isConnected) return;
        const now = el.getBoundingClientRect();
        const dx = prev.left - now.left;
        const dy = prev.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

        // 取消同一元素上未完成的位移动画，保证从当前视觉位置平滑过渡
        if (el._flipAnim) el._flipAnim.cancel();
        try {
            el._flipAnim = el.animate(
                [
                    { transform: `translate(${dx}px, ${dy}px)` },
                    { transform: 'translate(0, 0)' }
                ],
                { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }
            );
            el._flipAnim.onfinish = () => { el._flipAnim = null; };
        } catch (err) {
            // 退化方案：不支持 Web Animations 时直接还原，不做动画
        }
    });
}

/* ---------- 结束：结算并保存 ---------- */
function onPointerUp(e) {
    if (!dndSession) return;

    const session = dndSession;

    // 未真正开始拖动 → 视为普通点击，不做任何处理
    if (!session.started) {
        teardownDnd();
        return;
    }

    e.preventDefault();

    if (session.type === 'card') {
        commitCardDrag(session);
    } else {
        commitSectionDrag(session);
    }

    teardownDnd();

    // 屏蔽拖动结束后紧随的 click，避免 <a> 触发跳转导致页面刷新
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 300);
}

function teardownDnd() {
    document.body.classList.remove('dragging-active');
    if (!dndSession) return;
    const { ghost, node } = dndSession;
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    if (node) {
        node.classList.remove('dnd-source-hidden');
        if (node._flipAnim) {
            node._flipAnim.cancel();
            node._flipAnim = null;
        }
    }
    removePlaceholder();
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    dndSession.slotKey = null;
    dndSession = null;
}

function commitCardDrag(session) {
    const ph = document.getElementById('dnd-placeholder');
    if (!ph || !ph.parentNode) return;

    const newGrid = ph.closest('[data-role="grid"]');
    if (!newGrid) return;
    const toSection = newGrid.closest('.section').dataset.section;
    const fromSection = session.homeSection;

    // 被拖动的卡片对象（拖动开始时记录，跨组时从原分组移除）
    const movedItem = session.item || session.node._configItem;

    // 1) 先把被拖动的卡片节点移动到占位块位置（就地更新 DOM）
    moveCardNodeInDom(session.node, ph, newGrid);

    // 2) 依据移动后的真实 DOM 顺序重建「目标分组」的卡片数组
    const rebuildByDom = sectionEl => {
        const gridEl = sectionEl.querySelector('[data-role="grid"]');
        if (!gridEl) return null;
        return Array.prototype.slice
            .call(gridEl.querySelectorAll(':scope > .card'))
            .map(cardEl => cardEl._configItem)
            .filter(Boolean);
    };

    const targetSectionEl = newGrid.closest('.section');
    const rebuiltTarget = rebuildByDom(targetSectionEl) || [];

    if (fromSection === toSection) {
        // 同组：直接用 DOM 顺序（不会丢项，因为只挪动了组内节点）
        config[toSection] = rebuiltTarget;
    } else {
        // 跨组：目标组用 DOM 顺序；原组明确移除被拖走的那一项
        config[toSection] = rebuiltTarget;

        const sourceSectionEl = Array.prototype.slice
            .call(document.querySelectorAll('.section'))
            .find(el => el.dataset.section === fromSection);

        if (sourceSectionEl) {
            config[fromSection] = rebuildByDom(sourceSectionEl) || [];
        }
        // 双保险：若原分组中仍存在该卡片对象，强制剔除
        if (Array.isArray(config[fromSection])) {
            config[fromSection] = config[fromSection].filter(it => it !== movedItem);
        }
    }

    // 3) 用最新 config 重新渲染，保证界面顺序与服务端数据完全一致
    markDirty();
    render();
}

// 把被拖动的卡片节点移动到占位块所在位置，并移除占位块
function moveCardNodeInDom(node, placeholder, targetGrid) {
    if (placeholder.parentNode === targetGrid) {
        targetGrid.insertBefore(node, placeholder);
    } else {
        targetGrid.appendChild(node);
    }
    removePlaceholder();
}

function commitSectionDrag(session) {
    const ph = document.getElementById('dnd-placeholder');
    if (!ph || !ph.parentNode) return;

    const container = ph.parentNode;

    // 1) 先把被拖动的分组节点移动到占位块位置（就地更新 DOM）
    if (ph.parentNode === container) {
        container.insertBefore(session.node, ph);
    } else {
        container.appendChild(session.node);
    }
    removePlaceholder();

    // 2) 直接以「移动后的真实 DOM 顺序」重建 config，彻底避免下标推算出错
    const orderedKeys = Array.prototype.slice
        .call(container.querySelectorAll(':scope > .section'))
        .map(el => el.dataset.section);

    const newConfig = {};
    orderedKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(config, key)) {
            newConfig[key] = config[key];
        }
    });
    // 兜底：把不在 DOM 中的分组（理论上不会出现）追加回去，避免数据丢失
    Object.keys(config).forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(newConfig, key)) {
            newConfig[key] = config[key];
        }
    });
    config = newConfig;

    // 用最新 config 重新渲染，保证界面顺序与服务端数据完全一致
    markDirty();
    render();
}

// 仅在内存中更新数据 + 就地刷新 DOM（不请求后端、不整页重渲染）
// 未保存的改动会在点击「保存更改」时统一写入后端
function applyLocalChanges() {
    markDirty();
    render();
}

/* ------------------------------------------------------------
 * 5. 弹窗（复用为「卡片」和「分组」表单）
 * ---------------------------------------------------------- */
function openModal({ title, showUrl = true, showIcon = true, values = {}, onSubmit, validate, submitLabel }) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('urlGroup').style.display = showUrl ? '' : 'none';
    document.getElementById('iconGroup').style.display = showIcon ? '' : 'none';
    // 隐藏的字段要同步取消 required，否则浏览器的原生校验会拦住提交
    document.getElementById('fieldUrl').required = showUrl;
    document.getElementById('fieldName').value = values.name || '';
    document.getElementById('fieldUrl').value = values.url || '';
    document.getElementById('fieldIcon').value = values.icon || '';
    document.getElementById('iconPreview').innerHTML = values.icon ? `<i class="${escapeHtml(values.icon)}"></i>` : '';

    // 提交按钮文案随上下文变化：默认「保存」，可由调用方覆盖
    document.getElementById('modalSubmit').textContent = submitLabel || '保存';

    modalAction = onSubmit;
    // 额外的实时校验（如重名检测）：输入时立即更新按钮可用状态
    // 返回 { unavailable: true, reason: '...' } 表示按钮应置灰
    modalValidate = typeof validate === 'function' ? validate : null;
    const modal = document.getElementById('editModal');
    modal.classList.add('show');

    // 打开弹窗时刷新「保存」按钮的可用状态（缺必填项则置灰）
    const form = document.getElementById('editForm');
    if (form && typeof form._refreshSubmitState === 'function') {
        form._refreshSubmitState();
    }

    document.getElementById('fieldName').focus();
}

function closeModal() {
    document.getElementById('editModal').classList.remove('show');
    modalAction = null;
    modalValidate = null;
}

function setupModal() {
    const form = document.getElementById('editForm');
    const nameInput = document.getElementById('fieldName');
    const urlInput = document.getElementById('fieldUrl');
    const submitBtn = document.getElementById('modalSubmit');

    // 根据必填项是否填写，实时更新「保存」按钮是否置灰
    const refreshSubmitState = () => {
        const name = nameInput.value.trim();
        const nameOk = !!name;
        const urlRequired = document.getElementById('urlGroup').style.display !== 'none';
        const urlOk = !urlRequired || !!urlInput.value.trim();

        let unavailable = !(nameOk && urlOk);
        let reason = '';
        if (!nameOk) reason = '请先填写「名称」';
        else if (!urlOk) reason = '请先填写「链接地址」';

        // 自定义校验（如新增分组时的重名检测）：表单本身合法时再检查
        if (!unavailable && modalValidate) {
            try {
                const extra = modalValidate(name);
                if (extra && extra.unavailable) {
                    unavailable = true;
                    reason = extra.reason || '';
                }
            } catch (_) { /* 校验函数异常不影响 UI */ }
        }

        setButtonUnavailable(submitBtn, unavailable, reason || '请先补全必填项');
    };
    form._refreshSubmitState = refreshSubmitState;

    nameInput.addEventListener('input', refreshSubmitState);
    urlInput.addEventListener('input', refreshSubmitState);

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = {
            name: nameInput.value.trim(),
            url: urlInput.value.trim(),
            icon: document.getElementById('fieldIcon').value.trim()
        };
        // 缺少必填项时给出明确提示（按钮此刻已置灰）
        if (!data.name) {
            toast('请先填写「名称」');
            refreshSubmitState();
            return;
        }
        const urlRequired = document.getElementById('urlGroup').style.display !== 'none';
        if (urlRequired && !data.url) {
            toast('请先填写「链接地址」');
            refreshSubmitState();
            return;
        }
        if (modalAction) {
            const action = modalAction;
            // 让处理函数可以先校验（如重名检测）：
            // 返回 false 表示校验未通过，保持弹窗打开，便于用户修改
            let result;
            try {
                result = await action(data);
            } catch (err) {
                toast('操作失败：' + (err && err.message ? err.message : err));
                return;
            }
            if (result === false) return;   // 校验失败，弹窗保持打开
            closeModal();
        }
    });

    document.getElementById('modalCancel').addEventListener('click', closeModal);
    document.getElementById('editModal').addEventListener('click', e => {
        if (e.target.id === 'editModal') closeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });
    document.getElementById('fieldIcon').addEventListener('input', function () {
        document.getElementById('iconPreview').innerHTML = this.value.trim()
            ? `<i class="${escapeHtml(this.value.trim())}"></i>`
            : '';
    });

    setupIconPicker();
}

/* ------------------------------------------------------------
 * 5.1 图标选择器（支持中文模糊搜索 + 实时预览）
 *     数据来源：assets/icons.js 中的 window.FA_ICONS
 *     每项结构：{
 *       n: 图标名（如 "house"，不含 fa- 前缀）,
 *       s: 风格（'s'=solid 实心 / 'r'=regular 线性 / 'b'=brands 品牌）,
 *       k: 搜索关键词（中文/英文）
 *     }
 *     注意：品牌图标必须使用 fa-brands 前缀（字体族不同），
 *           否则即使码点存在也显示不出来（如 fa-confluence）。
 * ---------------------------------------------------------- */
const ICON_PICKER_PAGE_SIZE = 240;   // 首屏渲染数量，滚动到底自动加载更多

// 风格 -> Font Awesome 类名前缀
const STYLE_PREFIX = { s: 'fa-solid', r: 'fa-regular', b: 'fa-brands' };

// 风格 -> 中文名（用于界面展示）
const STYLE_LABEL = { s: '实心', r: '线性', b: '品牌' };

// 图标选择器状态
const iconPickerState = {
    keyword: '',
    filtered: [],
    shown: 0,
    selected: '',        // 当前选中的图标名（如 "confluence"）
    selectedStyle: '',   // 当前选中的风格（'s' / 'r' / 'b'）
    targetInput: null    // 触发选择器的输入框
};

// 图标名 + 风格 -> 完整 Font Awesome class
// 传入对象时用其 s 字段；传入字符串时默认按 solid 处理
function toIconClass(name, style) {
    if (!name) return '';

    // 已是完整 class 字符串（含空格，例如 "fa fa-search" / "fa-brands fa-github"）
    if (typeof name === 'string' && /\s/.test(name)) return name;

    let raw = String(name).trim();
    // 只写了 "fa-xxx" 的情况
    if (raw.startsWith('fa-')) {
        // 已有风格前缀则直接补 solid 声明
        if (/^fa-(solid|regular|brands)\b/.test(raw)) return raw;
        // "fa-house" -> name = "house"
        raw = raw.slice(3);
    }

    // 查表得到风格（优先传入的 style，其次数据表，最后 solid）
    let st = style;
    if (!st) {
        const found = getIconList().find(it => it.n === raw);
        st = found ? found.s : 's';
    }
    const prefix = STYLE_PREFIX[st] || 'fa-solid';
    return `${prefix} fa-${raw}`;
}

// 从 class 字符串中取出纯图标名（用于回填高亮）
function iconClassToName(cls) {
    if (!cls) return '';
    const m = String(cls).match(/fa-([a-z0-9-]+)/i);
    return m ? m[1].toLowerCase() : '';
}

// 从 class 字符串中取出风格前缀
function iconClassToStyle(cls) {
    if (!cls) return '';
    if (/fa-brands|\bfab\b/.test(cls)) return 'b';
    if (/fa-regular|\bfar\b/.test(cls)) return 'r';
    if (/fa-solid|\bfas\b|\bfa\b/.test(cls)) return 's';
    return '';
}

function getIconList() {
    return Array.isArray(window.FA_ICONS) ? window.FA_ICONS : [];
}

// 模糊搜索：关键词按空格分词，所有词都能命中才算匹配（支持中文）
function filterIcons(keyword) {
    const all = getIconList();
    const kw = (keyword || '').trim().toLowerCase();
    if (!kw) return all;

    const terms = kw.split(/\s+/).filter(Boolean);
    const scored = [];

    for (const item of all) {
        const hay = (item.n + ' ' + item.k).toLowerCase();
        let ok = true;
        let score = 0;
        for (const t of terms) {
            const idx = hay.indexOf(t);
            if (idx === -1) { ok = false; break; }
            // 命中位置越靠前、且命中「图标名」而非关键词，得分越高
            score += (item.n.toLowerCase().includes(t) ? 100 : 0) + Math.max(0, 40 - idx);
        }
        if (ok) scored.push({ item, score });
    }

    scored.sort((a, b) => b.score - a.score || a.item.n.localeCompare(b.item.n));
    return scored.map(s => s.item);
}

function renderIconGrid(reset) {
    const grid = document.getElementById('iconGrid');
    const empty = document.getElementById('iconEmpty');
    const countEl = document.getElementById('iconPickerCount');

    if (reset) {
        grid.innerHTML = '';
        iconPickerState.shown = 0;
    }

    const list = iconPickerState.filtered;
    const total = list.length;
    const selectedName = iconPickerState.selected;

    if (total === 0) {
        empty.style.display = 'block';
        countEl.textContent = '';
        return;
    }
    empty.style.display = 'none';

    const start = iconPickerState.shown;
    const end = Math.min(total, start + ICON_PICKER_PAGE_SIZE);
    const frag = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
        const icon = list[i];
        const cell = document.createElement('div');
        cell.className = 'icon-cell' + (icon.n === selectedName ? ' active' : '');
        cell.dataset.iconName = icon.n;
        cell.dataset.iconStyle = icon.s;
        cell.title = `${toIconClass(icon.n, icon.s)}${icon.k ? ' - ' + icon.k : ''}`;
        // 按图标真实风格渲染（品牌图标用 fa-brands，否则会显示不出来）
        cell.innerHTML =
            `<span class="glyph"><i class="${toIconClass(icon.n, icon.s)}"></i></span>` +
            `<span class="label">${escapeHtml(icon.n)}</span>` +
            (icon.s === 'b' ? '<span class="badge badge-brand">品牌</span>' : '');
        frag.appendChild(cell);
    }
    grid.appendChild(frag);
    iconPickerState.shown = end;

    countEl.textContent = total > end
        ? `共 ${total} 个，已显示 ${end} 个（继续滚动加载更多）`
        : `共 ${total} 个`;
}

// 卡片 / 网格点击选择
function onIconGridClick(e) {
    const cell = e.target.closest('.icon-cell');
    if (!cell) return;

    document.querySelectorAll('.icon-cell.active').forEach(el => el.classList.remove('active'));
    cell.classList.add('active');

    iconPickerState.selected = cell.dataset.iconName;
    iconPickerState.selectedStyle = cell.dataset.iconStyle;
    updateIconPickerCurrent();
}

function updateIconPickerCurrent() {
    const name = iconPickerState.selected;
    const glyphEl = document.getElementById('iconPickerCurrent');
    const nameEl = document.getElementById('iconPickerCurrentName');

    if (name) {
        const cls = toIconClass(name, iconPickerState.selectedStyle);
        glyphEl.innerHTML = `<i class="${cls}"></i>`;
        nameEl.textContent = cls;
    } else {
        glyphEl.innerHTML = '<i class="fas fa-ban"></i>';
        nameEl.textContent = '未选择';
    }
}

function openIconPicker(targetInput) {
    iconPickerState.targetInput = targetInput || null;
    const curCls = targetInput ? targetInput.value : '';
    iconPickerState.selected = iconClassToName(curCls);
    iconPickerState.selectedStyle = iconClassToStyle(curCls);

    // 若数据表中存在同名图标，以数据表的风格为准
    if (iconPickerState.selected) {
        const found = getIconList().find(it => it.n === iconPickerState.selected);
        if (found) iconPickerState.selectedStyle = found.s;
    }

    const searchInput = document.getElementById('iconSearchInput');
    searchInput.value = '';
    iconPickerState.keyword = '';

    iconPickerState.filtered = filterIcons('');
    renderIconGrid(true);
    updateIconPickerCurrent();

    document.getElementById('iconPickerMask').classList.add('show');
    searchInput.focus();

    // 若已选项存在，滚动到它附近
    if (iconPickerState.selected) {
        const idx = iconPickerState.filtered.findIndex(i => i.n === iconPickerState.selected);
        if (idx >= 0) {
            while (iconPickerState.shown <= idx) renderIconGrid(false);
            const cell = document.querySelector(`.icon-cell[data-icon-name="${iconPickerState.selected}"]`);
            if (cell) cell.scrollIntoView({ block: 'center' });
        }
    }
}

function closeIconPicker() {
    document.getElementById('iconPickerMask').classList.remove('show');
    iconPickerState.targetInput = null;
}

function confirmIconPicker() {
    if (iconPickerState.targetInput) {
        const cls = iconPickerState.selected
            ? toIconClass(iconPickerState.selected, iconPickerState.selectedStyle)
            : '';
        iconPickerState.targetInput.value = cls;
        // 同步刷新输入框下方的预览
        document.getElementById('iconPreview').innerHTML = cls ? `<i class="${escapeHtml(cls)}"></i>` : '';
    }
    closeIconPicker();
}

function setupIconPicker() {
    const mask = document.getElementById('iconPickerMask');
    const grid = document.getElementById('iconGrid');
    const body = document.querySelector('.icon-picker-body');
    const searchInput = document.getElementById('iconSearchInput');

    if (!mask || mask.dataset.ready === '1') return;
    mask.dataset.ready = '1';

    // 搜索（输入即过滤）
    searchInput.addEventListener('input', function () {
        iconPickerState.keyword = this.value;
        iconPickerState.filtered = filterIcons(this.value);
        renderIconGrid(true);
    });

    document.getElementById('iconSearchClear').addEventListener('click', () => {
        searchInput.value = '';
        iconPickerState.keyword = '';
        iconPickerState.filtered = filterIcons('');
        renderIconGrid(true);
        searchInput.focus();
    });

    grid.addEventListener('click', onIconGridClick);

    // 滚动到底部自动加载更多
    body.addEventListener('scroll', () => {
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 120) {
            if (iconPickerState.shown < iconPickerState.filtered.length) {
                renderIconGrid(false);
            }
        }
    });

    document.getElementById('iconPickerConfirm').addEventListener('click', confirmIconPicker);
    document.getElementById('iconPickerCancel').addEventListener('click', closeIconPicker);
    document.getElementById('iconPickerClear').addEventListener('click', () => {
        iconPickerState.selected = '';
        iconPickerState.selectedStyle = '';
        document.querySelectorAll('.icon-cell.active').forEach(el => el.classList.remove('active'));
        updateIconPickerCurrent();
    });

    // 点击遮罩关闭
    mask.addEventListener('click', e => {
        if (e.target.id === 'iconPickerMask') closeIconPicker();
    });

    // Esc 关闭（优先关闭图标选择器）
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && mask.classList.contains('show')) {
            e.stopPropagation();
            closeIconPicker();
        }
    }, true);

    // 编辑弹窗中的「浏览图标」按钮
    const browseBtn = document.getElementById('browseIconsBtn');
    if (browseBtn) {
        browseBtn.addEventListener('click', () => {
            openIconPicker(document.getElementById('fieldIcon'));
        });
    }
}

/* ------------------------------------------------------------
 * 6. 增删改：卡片 & 分组
 * ---------------------------------------------------------- */
async function addCard(sectionName) {
    openModal({
        title: `新增卡片 · ${sectionName}`,
        submitLabel: '添加',
        values: { icon: 'fa fa-link' },
        onSubmit: async data => {
            const item = { name: data.name, url: data.url, icon: data.icon || 'fa fa-link' };
            if (!config[sectionName]) config[sectionName] = [];
            config[sectionName].push(item);
            applyLocalChanges();
        }
    });
}

async function editCard(sectionName, index) {
    const card = (config[sectionName] || [])[index];
    if (!card) return;
    openModal({
        title: `编辑卡片 · ${card.name}`,
        submitLabel: '保存',
        values: card,
        onSubmit: async data => {
            config[sectionName][index] = {
                name: data.name,
                url: data.url,
                icon: data.icon || 'fa fa-link'
            };
            applyLocalChanges();
        }
    });
}

async function deleteCard(sectionName, index) {
    const card = (config[sectionName] || [])[index];
    if (!card) return;
    if (!confirm(`确认删除卡片「${card.name}」？`)) return;
    config[sectionName].splice(index, 1);
    applyLocalChanges();
}

async function addSection() {
    openModal({
        title: '新增分组',
        submitLabel: '添加',
        showUrl: false,
        showIcon: false,
        // 实时校验：重名时按钮置灰、原因提示
        validate: name => {
            if (!name) return null;
            if (Object.prototype.hasOwnProperty.call(config, name)) {
                return { unavailable: true, reason: '该分组名称已存在' };
            }
            return null;
        },
        onSubmit: async data => {
            const name = data.name;
            // 提交时再校验一次（防止输入框值与校验函数执行之间被改）
            if (Object.prototype.hasOwnProperty.call(config, name)) {
                toast('该分组名称已存在');
                return false;
            }
            config[name] = [];
            editing = true;
            applyLocalChanges();
            return true;
        }
    });
}

async function renameSection(sectionName) {
    openModal({
        title: `重命名分组 · ${sectionName}`,
        submitLabel: '保存',
        showUrl: false,
        showIcon: false,
        values: { name: sectionName },
        // 实时校验：与其它分组重名时按钮置灰
        validate: name => {
            if (!name || name === sectionName) return null;
            if (Object.prototype.hasOwnProperty.call(config, name)) {
                return { unavailable: true, reason: '该分组名称已存在' };
            }
            return null;
        },
        onSubmit: async data => {
            const newName = data.name;
            if (newName === sectionName) return true;   // 名称未变，直接关闭
            if (Object.prototype.hasOwnProperty.call(config, newName)) {
                toast('该分组名称已存在');
                return false;                            // 保持弹窗打开
            }
            const newConfig = {};
            Object.keys(config).forEach(k => {
                newConfig[k === sectionName ? newName : k] = config[k];
            });
            config = newConfig;
            applyLocalChanges();
            return true;
        }
    });
}

async function deleteSection(sectionName) {
    const count = (config[sectionName] || []).length;
    const msg = count
        ? `分组「${sectionName}」下还有 ${count} 个卡片，确认连同卡片一起删除？`
        : `确认删除分组「${sectionName}」？`;
    if (!confirm(msg)) return;
    delete config[sectionName];
    applyLocalChanges();
}

/* ------------------------------------------------------------
 * 7. 事件绑定
 * ---------------------------------------------------------- */
function setupActions() {
    guardUnavailable(document.getElementById('editToggle'), () => {
        // 退出编辑模式时如有未保存改动，先确认
        if (editing && dirty) {
            if (!confirm('有未保存的更改，确定要退出编辑模式吗？（改动仍会保留在前端，可再次进入编辑模式保存）')) {
                return;
            }
        }
        editing = !editing;
        // 重新渲染以切换卡片的 href（编辑模式下不带链接，避免误跳转/刷新）
        render();
    });

    document.getElementById('addSectionBtn').addEventListener('click', addSection);

    guardUnavailable(document.getElementById('saveBtn'), async () => {
        const btn = document.getElementById('saveBtn');
        // 保存过程中临时禁止重复点击（用不可用样式 + 原因提示，而不是灰色 disabled）
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
        btn.classList.add('busy');
        const ok = await saveConfig();
        btn.classList.remove('busy');

        if (ok) {
            dirty = false;
            updateSaveButton();
            // 保存成功后不刷新页面，仅本地提示
            toast('已保存');
        } else {
            updateSaveButton();
        }
    });

    // 阻止编辑模式下点击卡片跳转
    document.getElementById('content').addEventListener('click', e => {
        const actionBtn = e.target.closest('[data-action]');

        if (actionBtn) {
            e.preventDefault();
            e.stopPropagation();
            const action = actionBtn.dataset.action;
            const sectionEl = actionBtn.closest('.section');
            const sectionName = sectionEl.dataset.section;
            const card = actionBtn.closest('.card');

            if (action === 'edit-card') editCard(sectionName, Number(card.dataset.index));
            else if (action === 'delete-card') deleteCard(sectionName, Number(card.dataset.index));
            else if (action === 'edit-section') renameSection(sectionName);
            else if (action === 'delete-section') deleteSection(sectionName);
            else if (action === 'add-card') addCard(sectionName);
            return;
        }

        // 编辑模式下禁止卡片链接跳转；刚完成拖拽时也禁止（避免浏览器把拖放当成点击而刷新页面）
        if ((editing || justDragged) && e.target.closest('.card')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

/* ------------------------------------------------------------
 * 7.1 登录 / 登出
 * ---------------------------------------------------------- */
function showLoginModal(message) {
    const page = document.getElementById('loginPage');
    document.getElementById('loginHint').textContent = message || '';
    document.getElementById('loginPass').value = '';
    page.classList.add('show');
    // 未登录时锁住页面滚动，避免看到背后的内容
    document.body.classList.add('login-locked');
    // 登录页使用当前背景设置
    page.style.background = backgroundCss(appSettings.background);
    if (appSettings.background && appSettings.background.type === 'image' && appSettings.background.value) {
        page.style.backgroundImage = `url("${appSettings.background.value.replace(/"/g, '')}")`;
        page.style.backgroundSize = 'cover';
        page.style.backgroundPosition = 'center';
    } else {
        page.style.backgroundImage = 'none';
    }

    const userInput = document.getElementById('loginUser');
    if (!userInput.value) userInput.focus();
    else document.getElementById('loginPass').focus();
}

function hideLoginModal() {
    document.getElementById('loginPage').classList.remove('show');
    document.body.classList.remove('login-locked');
    document.getElementById('loginHint').textContent = '';
}

function updateAccountUI() {
    const userEl = document.getElementById('aboutUser');
    if (userEl) {
        if (loggedIn && currentUser) {
            userEl.textContent = `${currentUser.username}${currentUser.is_admin ? '（管理员）' : ''}`;
        } else if (!loginRequired && currentUser) {
            // 免登录模式：后端以「公共配置」虚拟身份工作（_public 不直接展示）
            const name = currentUser.username === '_public' ? '公共配置' : currentUser.username;
            userEl.textContent = `${name}（免登录模式）`;
        } else {
            userEl.textContent = '未登录';
        }
    }
    // 未登录时：退出登录 / 清空数据 均置灰并说明原因
    setButtonUnavailable(document.getElementById('logoutBtn'), !loggedIn, '当前未登录');
    setButtonUnavailable(document.getElementById('clearDataBtn'), !currentUser, '请先登录后再清空数据');
}

async function doLogin(username, password) {
    const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
    });
    setToken(res.token);
    currentUser = res.user;
    loggedIn = true;
    canEditNav = true;
    if (res.background) appSettings.background = res.background;
    if (res.search) appSettings.search = res.search;
    hideLoginModal();
    applyBackground(appSettings.background);
    renderHeroSearch();
    updateAccountUI();
    return res;
}

async function doLogout() {
    try {
        await api('/api/logout', { method: 'POST' });
    } catch (e) {
        /* 忽略登出接口异常 */
    }
    setToken('');
    loggedIn = false;
    editing = false;
    dirty = false;
    config = {};
    closeSettings();

    if (loginRequired) {
        // 仍需登录：清空身份并弹出登录页
        currentUser = null;
        canEditNav = false;
        render();
        updateAccountUI();
        showLoginModal();
        toast('已退出登录');
    } else {
        // 免登录模式：退出登录后，后端会以「公共配置」身份继续提供服务，
        // 因此这里重新拉取状态，保证设置里的登录验证开关仍然可用（可再次开启）
        try {
            await refreshAuthStatus();
        } catch (e) {
            currentUser = null;
            canEditNav = true;
        }
        applyBackground(appSettings.background);
        render();
        updateAccountUI();
        toast('已退出登录（当前为免登录模式，可再次开启登录验证）');
    }
}

function setupLogin() {
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const username = document.getElementById('loginUser').value.trim();
        const password = document.getElementById('loginPass').value;
        const hint = document.getElementById('loginHint');
        const btn = document.getElementById('loginSubmit');

        if (!username || !password) {
            hint.textContent = '请输入用户名和密码';
            return;
        }
        btn.classList.add('busy');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 登录中...';
        try {
            const res = await doLogin(username, password);
            toast('登录成功');
            await loadConfigForUser();
            if (res.must_change_password) {
                openSettings('accounts');
                toast('首次登录，请及时修改默认密码');
            }
        } catch (error) {
            hint.textContent = error.message || '登录失败';
        } finally {
            btn.classList.remove('busy');
            btn.innerHTML = '登录';
        }
    });
}

async function loadConfigForUser() {
    const data = await fetchConfig();
    if (data && !data.error) {
        config = data;
    } else {
        config = {};
    }
    dirty = false;
    render();
}

/* ------------------------------------------------------------
 * 7.2 背景设置
 * ---------------------------------------------------------- */
const DEFAULT_BACKGROUND = 'linear-gradient(135deg, #2C3E50 0%, #b3dace 30%, #cce8db 60%, #e3f5ec 100%)';

function backgroundCss(bg) {
    if (!bg || bg.type === 'default') return DEFAULT_BACKGROUND;
    if (bg.type === 'color') return bg.value || DEFAULT_BACKGROUND;
    if (bg.type === 'image') return bg.value ? `url("${bg.value}")` : DEFAULT_BACKGROUND;
    return DEFAULT_BACKGROUND;
}

// 应用背景遮罩浓度（0-80）：
// 1) #bgScrim 全局遮罩层透明度（始终生效）
// 2) 内容面板浓度 --panel-alpha：
//      联动开 → 全局遮罩 + 10%（想改幅度就调这里的 0.10）
//      联动关 → 0，面板完全透明
//    卡片下层再比面板深 7%；标题条带再比面板深 4%
// 3) 分组标题描边/阴影（--title-stroke-color / --title-shadow）：
//      联动开 → 随遮罩浓度缩放（30% 时即默认观感）；联动关 → 归零消失
function applyScrim(pct) {
    let v = Number(pct);
    if (!Number.isFinite(v)) v = 30;
    v = Math.max(0, Math.min(80, v));
    const ratio = v / 100;
    const el = document.getElementById('bgScrim');
    if (el) el.style.opacity = ratio.toFixed(3);

    const toggle = document.getElementById('scrimPanelToggle');
    const linked = toggle ? toggle.checked : true;
    const root = document.documentElement;
    if (linked) {
        const panel = Math.min(ratio + 0.10, 0.95);
        root.style.setProperty('--panel-alpha', panel.toFixed(3));
        root.style.setProperty('--panel-alpha-deep', Math.min(panel + 0.07, 0.97).toFixed(3));
        root.style.setProperty('--band-alpha', Math.min(panel + 0.04, 0.95).toFixed(3));

        // 标题描边/阴影：随浓度缩放（0.30 时 = 基准观感 0.32 / 0.5 / 0.45）
        const strokeA = Math.min(0.20 + ratio * 0.40, 0.60).toFixed(3);
        const sh1 = Math.min(0.38 + ratio * 0.40, 0.70).toFixed(3);
        const sh2 = Math.min(0.33 + ratio * 0.40, 0.65).toFixed(3);
        root.style.setProperty('--title-stroke-color', `rgba(10, 16, 26, ${strokeA})`);
        root.style.setProperty('--title-shadow',
            `0 2px 4px rgba(2, 8, 20, ${sh1}), 0 4px 18px rgba(2, 8, 20, ${sh2})`);
    } else {
        root.style.setProperty('--panel-alpha', '0');
        root.style.setProperty('--panel-alpha-deep', '0');
        root.style.setProperty('--band-alpha', '0');
        root.style.setProperty('--title-stroke-color', 'rgba(10, 16, 26, 0)');
        root.style.setProperty('--title-shadow', 'none');
    }
}

function applyBackground(bg) {
    document.body.style.backgroundImage = 'none';
    document.body.style.background = '';
    // 同步「内容面板跟随联动」开关（首次加载/登录后与已保存状态对齐）
    const toggle = document.getElementById('scrimPanelToggle');
    if (toggle && bg && bg.panel_link !== undefined) toggle.checked = !!bg.panel_link;
    applyScrim(bg && bg.scrim !== undefined ? bg.scrim : 30);

    if (!bg || bg.type === 'default') {
        document.body.style.background = DEFAULT_BACKGROUND;
        document.body.style.backgroundAttachment = 'fixed';
        return;
    }
    if (bg.type === 'color') {
        document.body.style.background = bg.value || DEFAULT_BACKGROUND;
        return;
    }
    if (bg.type === 'image' && bg.value) {
        document.body.style.backgroundImage = `url("${bg.value.replace(/"/g, '')}")`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
        document.body.style.backgroundRepeat = 'no-repeat';
        return;
    }
    document.body.style.background = DEFAULT_BACKGROUND;
}

function refreshBgPreview() {
    const preview = document.getElementById('bgPreview');
    if (!preview) return;
    const type = getSelectedBgType();
    let value = '';
    if (type === 'color') value = document.getElementById('bgColor').value || '';
    if (type === 'image') value = document.getElementById('bgImage').value.trim();
    preview.style.backgroundImage = 'none';
    preview.style.background = backgroundCss({ type, value });
    if (type === 'image' && value) {
        preview.style.backgroundImage = `url("${value.replace(/"/g, '')}")`;
        preview.style.backgroundSize = 'cover';
        preview.style.backgroundPosition = 'center';
    }
    // 预览遮罩浓度（::after 层的透明度跟随滑块）
    const scrimRange = document.getElementById('bgScrimRange');
    const pct = scrimRange ? +scrimRange.value : 30;
    preview.style.setProperty('--scrim-opacity', (pct / 100).toFixed(2));
}

function getSelectedBgType() {
    const el = document.querySelector('input[name="bgType"]:checked');
    return el ? el.value : 'default';
}

function setSelectedBgType(type) {
    document.querySelectorAll('input[name="bgType"]').forEach(el => {
        el.checked = el.value === (type || 'default');
    });
    const isColor = type === 'color';
    const isImage = type === 'image';
    document.getElementById('bgColorRow').style.display = isColor ? '' : 'none';
    document.getElementById('bgImageRow').style.display = isImage ? '' : 'none';
}

function fillBackgroundForm(bg) {
    const b = bg || { type: 'default', value: '' };
    setSelectedBgType(b.type);
    if (b.type === 'color') {
        document.getElementById('bgColor').value = /^#[0-9a-fA-F]{6}$/.test(b.value) ? b.value : '#2C3E50';
        document.getElementById('bgColorText').value = b.value || '';
    } else {
        document.getElementById('bgColor').value = '#2C3E50';
        document.getElementById('bgColorText').value = '';
    }
    document.getElementById('bgImage').value = b.type === 'image' ? (b.value || '') : '';
    // 同步遮罩滑块、百分比与「内容面板跟随联动」开关
    let scrimPct = Number(b.scrim);
    if (!Number.isFinite(scrimPct)) scrimPct = 30;
    scrimPct = Math.max(0, Math.min(80, scrimPct));
    const scrimRange = document.getElementById('bgScrimRange');
    if (scrimRange) {
        scrimRange.value = scrimPct;
        document.getElementById('bgScrimValue').textContent = scrimPct + '%';
    }
    const panelToggle = document.getElementById('scrimPanelToggle');
    if (panelToggle) panelToggle.checked = b.panel_link !== undefined ? !!b.panel_link : true;
    refreshBgPreview();
}

/* ---------- 设置页：搜索引擎管理 ---------- */
function renderEngineSettings() {
    const wrap = document.getElementById('engineList');
    if (!wrap) return;
    const list = appSettings.search.engines || [];

    wrap.innerHTML = list.map(e => {
        const isCurrent = e.id === appSettings.search.current;
        // 内置引擎不可删除（bing / google），自定义引擎可删除
        const isBuiltin = ['bing', 'google'].includes(e.id);
        return `
        <div class="engine-row${isCurrent ? ' current' : ''}">
            <label class="engine-radio">
                <input type="radio" name="enginePick" value="${escapeHtml(e.id)}" ${isCurrent ? 'checked' : ''}>
                <i class="${engineIconClass(e)}"></i>
                <span class="engine-row-name">${escapeHtml(e.name)}</span>
            </label>
            <code class="engine-row-url">${escapeHtml(e.url)}</code>
            ${isBuiltin ? '' : `
            <button type="button" class="icon-btn danger" data-del-engine="${escapeHtml(e.id)}" title="删除该引擎">
                <i class="fas fa-trash"></i>
            </button>`}
        </div>`;
    }).join('') || '<div class="settings-desc">暂无引擎，请在下方添加</div>';
}

async function updateSearchSetting(payload, okMsg) {
    try {
        const res = await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({ search: payload })
        });
        if (res.search) appSettings.search = res.search;
        renderEngineSettings();
        renderHeroSearch();
        if (okMsg) toast(okMsg);
        return true;
    } catch (error) {
        toast('操作失败：' + error.message);
        return false;
    }
}

function setupEngineSettings() {
    const wrap = document.getElementById('engineList');
    if (!wrap) return;

    // 切换默认引擎（radio 变化即保存）
    wrap.addEventListener('change', e => {
        if (e.target.name !== 'enginePick') return;
        updateSearchSetting({ current: e.target.value }, '已设为默认搜索引擎');
    });

    // 删除自定义引擎
    wrap.addEventListener('click', async e => {
        const btn = e.target.closest('[data-del-engine]');
        if (!btn) return;
        const eng = (appSettings.search.engines || []).find(x => x.id === btn.dataset.delEngine);
        if (!eng) return;
        if (!confirm(`确认删除搜索引擎「${eng.name}」？`)) return;
        await updateSearchSetting({ delete: eng.id }, '已删除');
    });

    // 新增引擎
    document.getElementById('addEngineBtn').addEventListener('click', async () => {
        const name = document.getElementById('newEngineName').value.trim();
        const url = document.getElementById('newEngineUrl').value.trim();
        if (!name) { toast('请先填写引擎名称'); return; }
        if (!url) { toast('请先填写搜索地址'); return; }
        const ok = await updateSearchSetting({ add: { name, url } }, '已添加并启用');
        if (ok) {
            document.getElementById('newEngineName').value = '';
            document.getElementById('newEngineUrl').value = '';
        }
    });
}

function setupBackground() {
    document.querySelectorAll('input[name="bgType"]').forEach(el => {
        el.addEventListener('change', () => {
            setSelectedBgType(getSelectedBgType());
            refreshBgPreview();
        });
    });

    const colorPicker = document.getElementById('bgColor');
    const colorText = document.getElementById('bgColorText');

    colorPicker.addEventListener('input', () => {
        colorText.value = colorPicker.value;
        refreshBgPreview();
    });
    colorText.addEventListener('input', () => {
        const v = colorText.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) colorPicker.value = v;
        refreshBgPreview();
    });
    document.getElementById('bgImage').addEventListener('input', refreshBgPreview);

    // 背景遮罩滑块：拖动时实时预览（更新页面遮罩 + 百分比 + 预览图）
    const scrimRange = document.getElementById('bgScrimRange');
    if (scrimRange) {
        scrimRange.addEventListener('input', () => {
            const pct = +scrimRange.value;
            document.getElementById('bgScrimValue').textContent = pct + '%';
            applyScrim(pct);
            refreshBgPreview();
        });
    }

    // 内容面板联动开关：切换时实时重新应用遮罩
    const panelToggle = document.getElementById('scrimPanelToggle');
    if (panelToggle) {
        panelToggle.addEventListener('change', () => {
            applyScrim(scrimRange ? +scrimRange.value : 30);
            refreshBgPreview();
        });
    }

    guardUnavailable(document.getElementById('bgSaveBtn'), async () => {
        const type = getSelectedBgType();
        let value = '';
        if (type === 'color') {
            value = (document.getElementById('bgColorText').value.trim() || document.getElementById('bgColor').value);
            if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
                toast('颜色格式应为 #RGB 或 #RRGGBB');
                return;
            }
        } else if (type === 'image') {
            value = document.getElementById('bgImage').value.trim();
            if (value && !/^(https?:\/\/|data:image\/|\.\/)/.test(value)) {
                toast('图片地址应以 http(s):// 或 ./ 开头');
                return;
            }
        }
        const scrim = scrimRange ? +scrimRange.value : 30;
        const panel_link = panelToggle ? panelToggle.checked : true;

        try {
            const res = await api('/api/settings', {
                method: 'POST',
                body: JSON.stringify({ background: { type, value, scrim, panel_link } })
            });
            appSettings.background = res.background;
            applyBackground(appSettings.background);
            fillBackgroundForm(appSettings.background);
            toast('背景已保存');
        } catch (error) {
            toast('保存失败：' + error.message);
        }
    });

    guardUnavailable(document.getElementById('bgResetBtn'), async () => {
        try {
            const res = await api('/api/settings', {
                method: 'POST',
                body: JSON.stringify({ background: { type: 'default', value: '' } })
            });
            appSettings.background = res.background;
            fillBackgroundForm(appSettings.background);
            applyBackground(appSettings.background);
            toast('已恢复默认背景');
        } catch (error) {
            toast('操作失败：' + error.message);
        }
    });
}

/* ------------------------------------------------------------
 * 7.3 账号管理
 * ---------------------------------------------------------- */
let userModalMode = 'create';   // 'create' | 'edit'
let userModalTarget = '';       // 编辑时的原用户名

async function refreshUserList() {
    const tbody = document.getElementById('userTableBody');
    const hint = document.getElementById('userListHint');
    const addBtn = document.getElementById('addUserBtn');
    if (!tbody) return;

    // 账号管理要求「真实登录」：
    //   * 未登录 / 免登录模式（implicit admin）下，一律不允许查看与修改账号信息
    if (!loggedIn || !currentUser) {
        const reason = !loginRequired
            ? '免登录模式下无法管理账号，请先在「基础设置」中启用登录验证并登录'
            : '请先登录后再管理账号';
        setButtonUnavailable(addBtn, true, reason);
        hint.textContent = reason;
        tbody.innerHTML =
            `<tr><td colspan="4" style="text-align:center;color:#8a95a1;">${escapeHtml(reason)}</td></tr>`;
        return;
    }

    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8a95a1;">加载中...</td></tr>';

    let data;
    try {
        data = await api('/api/users');
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#e74c3c;">${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    const users = data.users || [];
    const isAdmin = !!data.is_admin;

    setButtonUnavailable(addBtn, !isAdmin, '仅管理员可以新增账号');
    hint.textContent = isAdmin
        ? `共 ${users.length} 个账号，可管理全部账号`
        : '普通用户仅可修改自己的密码';

    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8a95a1;">暂无账号</td></tr>';
        return;
    }

    tbody.innerHTML = users.map(u => {
        const isSelf = currentUser && u.username === currentUser.username;
        // 非管理员只能改自己密码
        const canEdit = isAdmin || isSelf;
        const canDelete = isAdmin && !isSelf;

        // 按钮不可用时的具体原因（点击会以提示形式告知）
        // 注：管理员删除「最后一个管理员」的场景由后端校验并返回错误提示，
        //     这里 delReason 仅覆盖按钮本身不可用的情况
        const editReason = canEdit ? '' : '只能修改自己的密码';
        const delReason = isSelf ? '不能删除当前登录的账号' : '仅管理员可以删除账号';

        return `
        <tr data-username="${escapeHtml(u.username)}">
            <td>${escapeHtml(u.username)}${isSelf ? ' <span class="hint-inline">（我）</span>' : ''}</td>
            <td><span class="role-badge ${u.is_admin ? 'admin' : ''}">${u.is_admin ? '管理员' : '普通用户'}</span></td>
            <td>${escapeHtml(u.created_at || '-')}</td>
            <td class="col-actions">
                <div class="row-actions">
                    <button type="button" class="icon-btn${canEdit ? '' : ' unavailable'}" data-user-action="edit"
                        data-disabled-reason="${escapeHtml(editReason)}"
                        title="${canEdit ? '修改密码' : escapeHtml(editReason)}">
                        <i class="fas fa-key"></i>
                    </button>
                    <button type="button" class="icon-btn danger${canDelete ? '' : ' unavailable'}" data-user-action="delete"
                        data-disabled-reason="${escapeHtml(delReason)}"
                        title="${canDelete ? '删除账号' : escapeHtml(delReason)}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function openUserModal(mode, username) {
    // 账号管理必须先真实登录
    if (!loggedIn || !currentUser) {
        toast(loginRequired ? '请先登录后再管理账号' : '免登录模式下无法管理账号，请先启用登录验证并登录');
        return;
    }

    userModalMode = mode;
    userModalTarget = username || '';
    const isAdmin = currentUser && currentUser.is_admin;

    document.getElementById('userModalTitle').textContent = mode === 'create' ? '新增账号' : `修改账号 · ${username}`;

    const nameGroup = document.getElementById('userNameGroup');
    const nameInput = document.getElementById('userName');
    const adminGroup = document.getElementById('userAdminGroup');
    const passInput = document.getElementById('userPass');
    const passHint = document.getElementById('userPassHint');

    if (mode === 'create') {
        nameGroup.style.display = '';
        nameInput.value = '';
        nameInput.readOnly = false;
        adminGroup.style.display = isAdmin ? '' : 'none';
        document.getElementById('userIsAdmin').checked = false;
        passInput.value = '';
        passHint.textContent = '（至少 6 位）';
        passInput.required = true;
    } else {
        // 编辑：普通用户改自己密码时不允许改用户名
        nameGroup.style.display = isAdmin ? '' : 'none';
        nameInput.value = username || '';
        nameInput.readOnly = !isAdmin;
        adminGroup.style.display = isAdmin ? '' : 'none';
        const row = document.querySelector(`#userTableBody tr[data-username="${CSS.escape(username)}"]`);
        const badge = row && row.querySelector('.role-badge');
        document.getElementById('userIsAdmin').checked = !!(badge && badge.classList.contains('admin'));
        passInput.value = '';
        passHint.textContent = '（留空表示不修改，至少 6 位）';
        passInput.required = false;
    }

    document.getElementById('userModal').classList.add('show');
    (mode === 'create' ? nameInput : passInput).focus();
}

function closeUserModal() {
    document.getElementById('userModal').classList.remove('show');
}

function setupUserManagement() {
    guardUnavailable(document.getElementById('addUserBtn'), () => {
        openUserModal('create');
    });

    document.getElementById('userModalCancel').addEventListener('click', closeUserModal);
    document.getElementById('userModal').addEventListener('click', e => {
        if (e.target.id === 'userModal') closeUserModal();
    });

    // 表格内的操作按钮
    document.getElementById('userTableBody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-user-action]');
        if (!btn) return;
        if (btn.disabled || btn.classList.contains('unavailable')) {
            toast(btn.dataset.disabledReason || '该账号不可操作');
            return;
        }
        const row = btn.closest('tr');
        const username = row.dataset.username;
        const action = btn.dataset.userAction;

        if (action === 'edit') {
            openUserModal('edit', username);
        } else if (action === 'delete') {
            if (!confirm(`确认删除账号「${username}」？该账号的导航数据也会一并删除，且不可恢复。`)) return;
            try {
                await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
                toast('账号已删除');
                await refreshUserList();
            } catch (error) {
                toast('删除失败：' + error.message);
            }
        }
    });

    // 提交表单
    document.getElementById('userForm').addEventListener('submit', async e => {
        e.preventDefault();
        const username = document.getElementById('userName').value.trim();
        const password = document.getElementById('userPass').value;
        const isAdmin = document.getElementById('userIsAdmin').checked;

        try {
            if (userModalMode === 'create') {
                if (!username) { toast('请输入用户名'); return; }
                if (password.length < 6) { toast('密码长度至少 6 位'); return; }
                await api('/api/users', {
                    method: 'POST',
                    body: JSON.stringify({ username, password, is_admin: isAdmin })
                });
                toast('账号已创建');
            } else {
                const payload = { is_admin: isAdmin };
                if (password) {
                    if (password.length < 6) { toast('密码长度至少 6 位'); return; }
                    payload.password = password;
                }
                // 管理员可改用户名
                if (document.getElementById('userNameGroup').style.display !== 'none') {
                    const newName = document.getElementById('userName').value.trim();
                    if (newName && newName !== userModalTarget) payload.new_username = newName;
                }
                await api(`/api/users/${encodeURIComponent(userModalTarget)}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
                toast('账号已更新');
            }
            closeUserModal();
            // 若改的是自己，刷新当前用户信息
            await refreshAuthStatus();
            await refreshUserList();
        } catch (error) {
            toast('保存失败：' + error.message);
        }
    });
}

/* ------------------------------------------------------------
 * 7.4 清空数据（二次确认）
 * ---------------------------------------------------------- */
function setupClearData() {
    guardUnavailable(document.getElementById('clearDataBtn'), () => {
        if (!currentUser) {
            toast('请先登录');
            return;
        }
        const isAdmin = currentUser.is_admin;
        document.getElementById('clearWarn').innerHTML = isAdmin
            ? '你当前是<b>管理员</b>：确认后将<b>保留账号</b>，仅清空你的导航数据与背景设置。'
            : '你当前是<b>普通用户</b>：确认后将<b>删除你的账号及全部相关数据</b>，且不可恢复。';
        document.getElementById('clearUser').value = '';
        document.getElementById('clearPass').value = '';
        document.getElementById('clearHint').textContent = '';
        document.getElementById('clearModal').classList.add('show');
        document.getElementById('clearUser').focus();
    });

    document.getElementById('clearCancel').addEventListener('click', () => {
        document.getElementById('clearModal').classList.remove('show');
    });
    document.getElementById('clearModal').addEventListener('click', e => {
        if (e.target.id === 'clearModal') document.getElementById('clearModal').classList.remove('show');
    });

    document.getElementById('clearForm').addEventListener('submit', async e => {
        e.preventDefault();
        const hint = document.getElementById('clearHint');
        const username = document.getElementById('clearUser').value.trim();
        const password = document.getElementById('clearPass').value;

        if (!username || !password) {
            hint.textContent = '请输入用户名和密码';
            return;
        }

        try {
            const res = await api('/api/data/clear', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });
            document.getElementById('clearModal').classList.remove('show');

            if (res.scope === 'admin') {
                toast('已清空你的导航数据（账号已保留）');
                config = {};
                dirty = false;
                render();
                fillBackgroundForm({ type: 'default', value: '' });
                applyBackground({ type: 'default', value: '' });
            } else {
                toast('你的账号及数据已清除，已退出登录');
                setToken('');
                loggedIn = false;
                currentUser = null;
                canEditNav = !loginRequired;
                config = {};
                dirty = false;
                render();
                closeSettings();
                updateAccountUI();
                if (loginRequired) {
                    showLoginModal('账号数据已清除，请重新登录');
                } else {
                    // 免登录模式：账号已删，刷新一次状态
                    try { await refreshAuthStatus(); } catch (e) { /* 忽略 */ }
                    render();
                    updateAccountUI();
                }
            }
        } catch (error) {
            hint.textContent = error.message;
        }
    });
}

/* ------------------------------------------------------------
 * 7.5 设置弹窗（基础设置 / 账号管理 / 关于）
 * ---------------------------------------------------------- */
function openSettings(tab) {
    document.getElementById('settingsModal').classList.add('show');
    switchSettingsTab(tab || 'basic');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('show');
}

function switchSettingsTab(tab) {
    document.querySelectorAll('.settings-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.querySelectorAll('.settings-body').forEach(el => {
        el.style.display = el.dataset.panel === tab ? '' : 'none';
    });

    if (tab === 'accounts') refreshUserList();
    if (tab === 'about') updateAccountUI();
    if (tab === 'basic') {
        // 有身份即为已登录；免登录模式下后端会给公共配置
        const hasUser = !!currentUser;
        const isAdmin = hasUser && currentUser.is_admin;

        // 登录验证开关（仅管理员可改）
        const toggle = document.getElementById('loginRequiredToggle');
        toggle.checked = loginRequired;
        toggle.disabled = !isAdmin;
        document.getElementById('loginRequiredNote').textContent = isAdmin
            ? (loginRequired
                ? '当前已启用：访问需登录。关闭后，任何访问者都将以公共配置使用。'
                : '当前已关闭（免登录模式，以公共配置使用）。可随时重新开启。')
            : (hasUser ? '仅管理员可以修改此开关。' : '请先登录后再修改此项。');

        // 背景设置：需要有身份（免登录模式下后端提供公共配置）
        setButtonUnavailable(
            document.getElementById('bgSaveBtn'),
            !hasUser,
            '请先登录后再保存背景'
        );
        setButtonUnavailable(
            document.getElementById('bgResetBtn'),
            !hasUser,
            '请先登录后再恢复默认背景'
        );

        fillBackgroundForm(appSettings.background);
        renderEngineSettings();
    }
}

function setupSettings() {
    document.getElementById('settingsBtn').addEventListener('click', () => openSettings('basic'));
    document.getElementById('settingsClose').addEventListener('click', closeSettings);
    document.getElementById('settingsModal').addEventListener('click', e => {
        if (e.target.id === 'settingsModal') closeSettings();
    });
    document.getElementById('settingsTabs').addEventListener('click', e => {
        const tab = e.target.closest('.settings-tab');
        if (tab) switchSettingsTab(tab.dataset.tab);
    });

    // 登录验证开关（仅管理员）
    // 规则：无论「开启」还是「关闭」，改完之后都必须重新登录，以新策略重新建立会话
    document.getElementById('loginRequiredToggle').addEventListener('change', async function () {
        const want = this.checked;
        const actionText = want ? '启用' : '关闭';
        if (!confirm(`确认${actionText}登录验证？\n\n修改后需要重新登录以应用新设置。`)) {
            this.checked = !want;
            return;
        }

        try {
            const res = await api('/api/settings', {
                method: 'POST',
                body: JSON.stringify({ login_required: want })
            });
            loginRequired = res.login_required;
        } catch (error) {
            this.checked = !want;
            toast('修改失败：' + error.message);
            return;
        }

        // 清除当前会话，强制重新登录
        try {
            await api('/api/logout', { method: 'POST' });
        } catch (e) {
            /* 忽略 */
        }
        setToken('');
        loggedIn = false;
        currentUser = null;
        editing = false;
        dirty = false;
        config = {};
        closeSettings();
        render();
        updateAccountUI();

        if (loginRequired) {
            // 开启登录验证：回到登录页
            canEditNav = false;
            showLoginModal('已启用登录验证，请重新登录');
        } else {
            // 关闭登录验证：以默认管理员身份继续，但同样提示需重新进入
            canEditNav = true;
            try {
                await refreshAuthStatus();
            } catch (e) {
                /* 忽略 */
            }
            applyBackground(appSettings.background);
            render();
            updateAccountUI();
            toast('已关闭登录验证，当前为免登录模式');
        }
    });

    guardUnavailable(document.getElementById('logoutBtn'), () => {
        if (!loggedIn) return;
        if (!confirm('确认退出登录？')) return;
        doLogout();
    });

    setupBackground();
    setupUserManagement();
    setupClearData();
    updateAccountUI();
}

/* ------------------------------------------------------------
 * 8. 初始化
 * ---------------------------------------------------------- */
// 轻量提示条
let toastTimer = null;
function toast(message) {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// 后端接口不可用（404 / 网络错误）时给出明确提示，便于排查部署问题
function showBackendError(err) {
    const container = document.getElementById('content');
    if (!container) return;

    const status = err && err.status;
    let title = '无法连接后端服务';
    if (status === 404) title = '接口返回 404（地址不正确）';
    else if (status === 401) title = '登录状态失效，请重新登录';

    container.innerHTML = `
        <div style="max-width:680px;margin:2rem auto;padding:1.5rem 1.75rem;background:rgba(0,0,0,0.6);
                    border-radius:14px;color:#fff;line-height:1.8;">
            <h3 style="margin-bottom:0.8rem;display:flex;align-items:center;gap:0.5rem;">
                <i class="fas fa-triangle-exclamation" style="color:#f1c40f;"></i> ${escapeHtml(title)}
            </h3>
            <pre style="font-size:0.8rem;background:rgba(0,0,0,0.35);padding:0.75rem;border-radius:8px;
                        white-space:pre-wrap;word-break:break-all;">${escapeHtml(describeApiError(err))}</pre>
            <ul style="font-size:0.85rem;opacity:0.9;margin:0.9rem 0 0 1.2rem;">
                <li>页面与接口应当来自<strong>同一个地址</strong>（前后端已打包在同一服务）</li>
                <li>直接访问 <code>${escapeHtml((API_BASE || location.origin) + '/api/meta')}</code> 应返回一段 JSON</li>
                <li>若返回 404，说明该地址上没有本后端服务</li>
            </ul>
            <div style="margin-top:1rem;display:flex;gap:0.6rem;">
                <button type="button" class="btn" onclick="location.reload()">
                    <i class="fas fa-rotate-right"></i> 重新加载
                </button>
                <button type="button" class="btn" id="backendProbeBtn">
                    <i class="fas fa-stethoscope"></i> 检测接口
                </button>
            </div>
        </div>`;

    const probeBtn = document.getElementById('backendProbeBtn');
    if (probeBtn) {
        probeBtn.addEventListener('click', async () => {
            probeBtn.classList.add('busy');
            const base = API_BASE || location.origin;
            const targets = [
                `${base}/api/meta`,
                `${location.origin}/api/meta`,
            ];
            const results = [];
            for (const url of targets) {
                try {
                    const r = await fetch(url, { cache: 'no-store' });
                    results.push(`${r.ok ? '✔' : '✘'} ${url} -> ${r.status}`);
                } catch (e) {
                    results.push(`✘ ${url} -> ${e.message}`);
                }
            }
            alert('接口连通性检测：\n\n' + results.join('\n'));
            probeBtn.classList.remove('busy');
        });
    }
}

async function refreshAuthStatus() {
    const res = await api('/api/auth/status');
    loginRequired = !!res.login_required;
    // 免登录模式下后端会返回默认管理员身份，此时也算「有管理员权限」
    currentUser = res.user || null;
    // 是否真的通过了登录（用于区分「免登录模式的默认身份」）
    loggedIn = !!res.logged_in;
    // 免登录模式下后端以默认管理员身份提供服务，因此可以编辑
    canEditNav = !loginRequired || loggedIn;
    if (res.background) appSettings.background = res.background;
    if (res.search) appSettings.search = res.search;

    // 仅在「需要登录但令牌已失效」时清理本地缓存
    if (loginRequired && !loggedIn) setToken('');
    return res;
}

async function init() {
    setupSearch();
    setupWebSearch();
    setupEngineSettings();
    setupDragAndDrop();
    setupModal();
    setupActions();
    setupSettings();
    setupLogin();

    // 1) 取元信息（版本 / 发布日期）
    try {
        appMeta = await api('/api/meta');
        document.getElementById('aboutVersion').textContent = appMeta.version || '-';
        document.getElementById('aboutDate').textContent = appMeta.release_date || '-';
    } catch (e) {
        /* 元信息失败不影响主流程 */
    }

    // 2) 查询鉴权状态
    let needLogin = false;
    try {
        const status = await refreshAuthStatus();
        applyBackground(appSettings.background);
        renderHeroSearch();
        needLogin = status.login_required && !status.logged_in;
    } catch (e) {
        console.error('获取鉴权状态失败:', e);
        // 接口不可用时给出明确提示，避免页面白屏让人摸不着头脑
        showBackendError(e);
    }

    // 3) 加载导航数据
    if (needLogin) {
        // 未登录：直接展示登录页，不渲染导航内容
        config = {};
        render();
        showLoginModal();
    } else {
        hideLoginModal();
        await loadConfigForUser();
    }

    updateAccountUI();

    // 有未保存改动时，离开页面前给出提醒
    window.addEventListener('beforeunload', () => {
        if (dirty) {
            return '有未保存的更改，确定要离开吗？';
        }
    });

    // 隐藏加载动画，显示主容器
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('mainContainer').classList.add('visible');
}

init();
