/* ============================================================
 * 图标选择器（支持中文模糊搜索 + 实时预览 + 滚动分页）
 *   数据来源：assets/icons.js 中的 window.FA_ICONS
 *   每项结构：{
 *     n: 图标名（如 "house"，不含 fa- 前缀）,
 *     s: 风格（'s'=solid 实心 / 'r'=regular 线性 / 'b'=brands 品牌）,
 *     k: 搜索关键词（中文/英文）
 *   }
 *   注意：品牌图标必须使用 fa-brands 前缀（字体族不同），
 *         否则即使码点存在也显示不出来（如 fa-confluence）。
 *
 * 本模块自包含：内部状态 iconPickerState 不对外暴露。
 * ============================================================ */
import { $, $$all, escapeHtml } from './utils.js';

const ICON_PICKER_PAGE_SIZE = 240;   // 首屏渲染数量，滚动到底自动加载更多

// 风格 -> Font Awesome 类名前缀
const STYLE_PREFIX = { s: 'fa-solid', r: 'fa-regular', b: 'fa-brands' };

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
    const grid = $('iconGrid');
    const empty = $('iconEmpty');
    const countEl = $('iconPickerCount');

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

    $$all('.icon-cell.active').forEach(el => el.classList.remove('active'));
    cell.classList.add('active');

    iconPickerState.selected = cell.dataset.iconName;
    iconPickerState.selectedStyle = cell.dataset.iconStyle;
    updateIconPickerCurrent();
}

function updateIconPickerCurrent() {
    const name = iconPickerState.selected;
    const glyphEl = $('iconPickerCurrent');
    const nameEl = $('iconPickerCurrentName');

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

    const searchInput = $('iconSearchInput');
    searchInput.value = '';
    iconPickerState.keyword = '';

    iconPickerState.filtered = filterIcons('');
    renderIconGrid(true);
    updateIconPickerCurrent();

    $('iconPickerMask').classList.add('show');
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
    $('iconPickerMask').classList.remove('show');
    iconPickerState.targetInput = null;
}

function confirmIconPicker() {
    if (iconPickerState.targetInput) {
        const cls = iconPickerState.selected
            ? toIconClass(iconPickerState.selected, iconPickerState.selectedStyle)
            : '';
        iconPickerState.targetInput.value = cls;
        // 同步刷新输入框下方的预览
        $('iconPreview').innerHTML = cls ? `<i class="${escapeHtml(cls)}"></i>` : '';
    }
    closeIconPicker();
}

export function setupIconPicker() {
    const mask = $('iconPickerMask');
    const grid = $('iconGrid');
    const body = document.querySelector('.icon-picker-body');
    const searchInput = $('iconSearchInput');

    if (!mask || mask.dataset.ready === '1') return;
    mask.dataset.ready = '1';

    // 搜索（输入即过滤）
    searchInput.addEventListener('input', function () {
        iconPickerState.keyword = this.value;
        iconPickerState.filtered = filterIcons(this.value);
        renderIconGrid(true);
    });

    $('iconSearchClear').addEventListener('click', () => {
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

    $('iconPickerConfirm').addEventListener('click', confirmIconPicker);
    $('iconPickerCancel').addEventListener('click', closeIconPicker);
    $('iconPickerClear').addEventListener('click', () => {
        iconPickerState.selected = '';
        iconPickerState.selectedStyle = '';
        $$all('.icon-cell.active').forEach(el => el.classList.remove('active'));
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
    const browseBtn = $('browseIconsBtn');
    if (browseBtn) {
        browseBtn.addEventListener('click', () => {
            openIconPicker($('fieldIcon'));
        });
    }
}
