/* ============================================================
 * 数据层与编辑器
 *   * fetchConfig / saveConfig / loadConfigForUser —— 与后端同步导航数据
 *   * 卡片与分组的增删改 —— 只更新内存并标记「未保存」
 *   * setupActions —— 顶部编辑工具栏 + 卡片操作按钮的事件绑定
 *
 * 所有改动都只写 state.config 并置 dirty，
 * 点击「保存更改」时才统一 POST 给后端。
 * ============================================================ */
import { state } from './state.js';
import { api, describeApiError } from './api.js';
import { $, guardUnavailable, toast } from './utils.js';
import { applyLocalChanges, render } from './render.js';
import { openModal } from './modal.js';

/* ------------------------------------------------------------
 * 读取 / 保存
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
            body: JSON.stringify(state.config)
        });
        return true;
    } catch (error) {
        console.error('保存配置失败:', error);
        toast('保存失败：' + error.message);
        return false;
    }
}

export async function loadConfigForUser() {
    const data = await fetchConfig();
    state.config = (data && !data.error) ? data : {};
    state.dirty = false;
    render();
}

/* ------------------------------------------------------------
 * 卡片增删改
 * ---------------------------------------------------------- */
async function addCard(sectionName) {
    openModal({
        title: `新增卡片 · ${sectionName}`,
        submitLabel: '添加',
        values: { icon: 'fa fa-link' },
        onSubmit: async data => {
            const item = { name: data.name, url: data.url, icon: data.icon || 'fa fa-link' };
            if (!state.config[sectionName]) state.config[sectionName] = [];
            state.config[sectionName].push(item);
            applyLocalChanges();
        }
    });
}

async function editCard(sectionName, index) {
    const card = (state.config[sectionName] || [])[index];
    if (!card) return;
    openModal({
        title: `编辑卡片 · ${card.name}`,
        submitLabel: '保存',
        values: card,
        onSubmit: async data => {
            state.config[sectionName][index] = {
                name: data.name,
                url: data.url,
                icon: data.icon || 'fa fa-link'
            };
            applyLocalChanges();
        }
    });
}

async function deleteCard(sectionName, index) {
    const card = (state.config[sectionName] || [])[index];
    if (!card) return;
    if (!confirm(`确认删除卡片「${card.name}」？`)) return;
    state.config[sectionName].splice(index, 1);
    applyLocalChanges();
}

/* ------------------------------------------------------------
 * 分组增删改
 * ---------------------------------------------------------- */
async function addSection() {
    openModal({
        title: '新增分组',
        submitLabel: '添加',
        showUrl: false,
        showIcon: false,
        // 实时校验：重名时按钮置灰、原因提示
        validate: name => {
            if (!name) return null;
            if (Object.prototype.hasOwnProperty.call(state.config, name)) {
                return { unavailable: true, reason: '该分组名称已存在' };
            }
            return null;
        },
        onSubmit: async data => {
            const name = data.name;
            // 提交时再校验一次（防止输入框值与校验函数执行之间被改）
            if (Object.prototype.hasOwnProperty.call(state.config, name)) {
                toast('该分组名称已存在');
                return false;
            }
            state.config[name] = [];
            state.editing = true;
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
            if (Object.prototype.hasOwnProperty.call(state.config, name)) {
                return { unavailable: true, reason: '该分组名称已存在' };
            }
            return null;
        },
        onSubmit: async data => {
            const newName = data.name;
            if (newName === sectionName) return true;   // 名称未变，直接关闭
            if (Object.prototype.hasOwnProperty.call(state.config, newName)) {
                toast('该分组名称已存在');
                return false;                            // 保持弹窗打开
            }
            const newConfig = {};
            Object.keys(state.config).forEach(k => {
                newConfig[k === sectionName ? newName : k] = state.config[k];
            });
            state.config = newConfig;
            applyLocalChanges();
            return true;
        }
    });
}

async function deleteSection(sectionName) {
    const count = (state.config[sectionName] || []).length;
    const msg = count
        ? `分组「${sectionName}」下还有 ${count} 个卡片，确认连同卡片一起删除？`
        : `确认删除分组「${sectionName}」？`;
    if (!confirm(msg)) return;
    delete state.config[sectionName];
    applyLocalChanges();
}

/* ------------------------------------------------------------
 * 顶部工具栏：编辑模式 / 新增分组 / 保存更改 + 卡片操作按钮
 * ---------------------------------------------------------- */
export function setupActions() {
    guardUnavailable($('editToggle'), () => {
        // 退出编辑模式时如有未保存改动，先确认
        if (state.editing && state.dirty) {
            if (!confirm('有未保存的更改，确定要退出编辑模式吗？（改动仍会保留在前端，可再次进入编辑模式保存）')) {
                return;
            }
        }
        state.editing = !state.editing;
        // 重新渲染以切换卡片的 href（编辑模式下不带链接，避免误跳转/刷新）
        render();
    });

    $('addSectionBtn').addEventListener('click', addSection);

    guardUnavailable($('saveBtn'), async () => {
        const btn = $('saveBtn');
        // 保存过程中临时禁止重复点击（用不可用样式 + 原因提示，而不是灰色 disabled）
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
        btn.classList.add('busy');
        const ok = await saveConfig();
        btn.classList.remove('busy');

        if (ok) {
            state.dirty = false;
            // 保存成功后不刷新页面，仅本地提示
            toast('已保存');
        }
        render();   // 统一刷新按钮状态（成功清除 dirty / 失败恢复文案）
    });

    // 阻止编辑模式下点击卡片跳转；卡片操作按钮统一在这里分发
    $('content').addEventListener('click', e => {
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
        if ((state.editing || state.justDragged) && e.target.closest('.card')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}
