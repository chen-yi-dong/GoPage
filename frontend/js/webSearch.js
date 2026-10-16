/* ============================================================
 * 网页搜索：主页顶部搜索框（可切换搜索引擎）
 *  +  设置页的搜索引擎管理（增 / 删 / 设默认）
 *
 * 引擎数据由后端按账号存储；内置 Bing / Google 不可删除。
 * ============================================================ */
import { state } from './state.js';
import { api } from './api.js';
import { $, escapeHtml, toast } from './utils.js';

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
    const list = state.appSettings.search.engines || [];
    return list.find(e => e.id === state.appSettings.search.current) || list[0] || null;
}

export function renderHeroSearch() {
    const engine = currentEngine();
    const icon = $('engineIcon');
    const name = $('engineName');
    const input = $('webSearchInput');
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
    const menu = $('engineMenu');
    if (!menu) return;
    const list = state.appSettings.search.engines || [];
    menu.innerHTML = list.map(e => `
        <button type="button" class="engine-item${e.id === state.appSettings.search.current ? ' active' : ''}"
                data-engine-id="${escapeHtml(e.id)}">
            <i class="${engineIconClass(e)}"></i>
            <span class="engine-item-name">${escapeHtml(e.name)}</span>
            ${e.id === state.appSettings.search.current ? '<i class="fas fa-check"></i>' : ''}
        </button>`).join('');
}

function toggleEngineMenu(show) {
    const menu = $('engineMenu');
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
        if (res.search) state.appSettings.search = res.search;
        renderHeroSearch();
        toast('已切换搜索引擎');
    } catch (error) {
        toast('切换失败：' + error.message);
    }
}

function doWebSearch() {
    const input = $('webSearchInput');
    const q = (input.value || '').trim();
    if (!q) { input.focus(); return; }
    const engine = currentEngine();
    if (!engine) { toast('请先在设置中添加搜索引擎'); return; }
    const url = engine.url.replace('{kw}', encodeURIComponent(q));
    window.open(url, '_blank', 'noopener');
}

export function setupWebSearch() {
    const box = $('webSearchBox');
    const chip = $('engineChip');
    const input = $('webSearchInput');
    const go = $('webSearchGo');
    if (!box) return;

    chip.addEventListener('click', e => {
        e.stopPropagation();
        toggleEngineMenu();
    });

    // 引擎菜单项点击（事件委托，菜单内容会重绘）
    $('engineMenu').addEventListener('click', async e => {
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
 * 设置页：搜索引擎管理
 * ---------------------------------------------------------- */
export function renderEngineSettings() {
    const wrap = $('engineList');
    if (!wrap) return;
    const list = state.appSettings.search.engines || [];

    wrap.innerHTML = list.map(e => {
        const isCurrent = e.id === state.appSettings.search.current;
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
        if (res.search) state.appSettings.search = res.search;
        renderEngineSettings();
        renderHeroSearch();
        if (okMsg) toast(okMsg);
        return true;
    } catch (error) {
        toast('操作失败：' + error.message);
        return false;
    }
}

export function setupEngineSettings() {
    const wrap = $('engineList');
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
        const eng = (state.appSettings.search.engines || []).find(x => x.id === btn.dataset.delEngine);
        if (!eng) return;
        if (!confirm(`确认删除搜索引擎「${eng.name}」？`)) return;
        await updateSearchSetting({ delete: eng.id }, '已删除');
    });

    // 新增引擎
    $('addEngineBtn').addEventListener('click', async () => {
        const name = $('newEngineName').value.trim();
        const url = $('newEngineUrl').value.trim();
        if (!name) { toast('请先填写引擎名称'); return; }
        if (!url) { toast('请先填写搜索地址'); return; }
        const ok = await updateSearchSetting({ add: { name, url } }, '已添加并启用');
        if (ok) {
            $('newEngineName').value = '';
            $('newEngineUrl').value = '';
        }
    });
}
