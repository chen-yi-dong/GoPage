/* ============================================================
 * 设置弹窗：基础设置（背景 / 搜索引擎）/ 账号管理 / 关于
 *
 * 说明：
 *   * 「启用登录验证」开关的交互在 auth.js（setupLoginPolicy）——
 *     它本质上改变的是登录策略，改完还要强制重新登录
 *   * 各面板的内容由对应模块渲染（背景 -> background.js，
 *     搜索引擎 -> webSearch.js，账号 -> users.js）
 * ============================================================ */
import { state } from './state.js';
import { $, setButtonUnavailable } from './utils.js';
import { updateAccountUI } from './account.js';
import { fillBackgroundForm } from './background.js';
import { renderEngineSettings } from './webSearch.js';
import { refreshUserList } from './users.js';

export function openSettings(tab) {
    $('settingsModal').classList.add('show');
    switchSettingsTab(tab || 'basic');
}

export function closeSettings() {
    $('settingsModal').classList.remove('show');
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
        const hasUser = !!state.currentUser;
        const isAdmin = hasUser && state.currentUser.is_admin;

        // 登录验证开关（仅管理员可改）
        const toggle = $('loginRequiredToggle');
        toggle.checked = state.loginRequired;
        toggle.disabled = !isAdmin;
        $('loginRequiredNote').textContent = isAdmin
            ? (state.loginRequired
                ? '当前已启用：访问需登录。关闭后，任何访问者都将以公共配置使用。'
                : '当前已关闭（免登录模式，以公共配置使用）。可随时重新开启。')
            : (hasUser ? '仅管理员可以修改此开关。' : '请先登录后再修改此项。');

        // 背景设置：需要有身份（免登录模式下后端提供公共配置）
        setButtonUnavailable(
            $('bgSaveBtn'),
            !hasUser,
            '请先登录后再保存背景'
        );
        setButtonUnavailable(
            $('bgResetBtn'),
            !hasUser,
            '请先登录后再恢复默认背景'
        );

        fillBackgroundForm(state.appSettings.background);
        renderEngineSettings();
    }
}

export function setupSettings() {
    $('settingsBtn').addEventListener('click', () => openSettings('basic'));
    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsModal').addEventListener('click', e => {
        if (e.target.id === 'settingsModal') closeSettings();
    });
    $('settingsTabs').addEventListener('click', e => {
        const tab = e.target.closest('.settings-tab');
        if (tab) switchSettingsTab(tab.dataset.tab);
    });

    updateAccountUI();
}
