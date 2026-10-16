/* ============================================================
 * 渲染层：把 state.config 渲染成页面，并维护编辑模式 / 保存按钮状态
 * ============================================================ */
import { state } from './state.js';
import { $, $$all, escapeHtml, setButtonUnavailable } from './utils.js';
import { applyFilter } from './filter.js';

export function render() {
    const content = $('content');
    let html = '';

    Object.keys(state.config).forEach((sectionName, sIndex) => {
        const items = state.config[sectionName] || [];
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

    if (!Object.keys(state.config).length) {
        html = '<p style="color:#fff;text-align:center;">暂无分组，点击上方“新增分组”开始添加</p>';
    }

    content.innerHTML = html;
    bindConfigItems();
    applyFilter($('searchInput').value);
    updateBodyState();
}

// 把每个卡片 DOM 节点与它在 config 中的对象关联起来，供拖动排序时还原顺序
function bindConfigItems() {
    $$all('.section').forEach(sectionEl => {
        const sectionName = sectionEl.dataset.section;
        const list = state.config[sectionName] || [];
        sectionEl.querySelectorAll('[data-role="grid"] > .card').forEach((cardEl, i) => {
            cardEl._configItem = list[i] || null;
        });
    });
}

function renderCard(item, cIndex) {
    // 编辑模式下不写入 href，从根本上避免拖拽结束后触发链接跳转/刷新
    const hrefAttr = state.editing ? '' : `href="${escapeHtml(item.url)}" target="_blank"`;
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
    document.body.classList.toggle('editing', state.editing && state.canEditNav);

    const toggleBtn = $('editToggle');
    toggleBtn.classList.toggle('active', state.editing && state.canEditNav);
    toggleBtn.innerHTML = (state.editing && state.canEditNav)
        ? '<i class="fas fa-check"></i> 退出编辑'
        : '<i class="fas fa-pen"></i> 编辑模式';

    // 未登录（启用登录验证但无会话）时，禁止进入编辑模式
    setButtonUnavailable(toggleBtn, !state.canEditNav, '请先登录后再编辑');

    $('addSectionBtn').style.display = (state.editing && state.canEditNav) ? '' : 'none';
    $('saveBtn').style.display = (state.editing && state.canEditNav) ? '' : 'none';
    updateSaveButton();
}

function updateSaveButton() {
    const btn = $('saveBtn');
    if (!btn) return;
    // 只在「没有改动」时置灰，并说明原因；有改动时保持可用
    setButtonUnavailable(btn, !state.dirty, '没有需要保存的更改，请先修改内容');
    btn.classList.toggle('has-changes', state.dirty);
    btn.innerHTML = state.dirty
        ? '<i class="fas fa-floppy-disk"></i> 保存更改 *'
        : '<i class="fas fa-floppy-disk"></i> 保存更改';
}

// 标记有未保存的改动，并更新「保存更改」按钮状态
function markDirty() {
    state.dirty = true;
    updateSaveButton();
}

// 仅在内存中更新数据 + 就地刷新 DOM（不请求后端、不整页重渲染）
// 未保存的改动会在点击「保存更改」时统一写入后端
export function applyLocalChanges() {
    markDirty();
    render();
}
