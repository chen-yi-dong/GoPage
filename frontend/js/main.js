/* ============================================================
 * 入口：初始化（组装各模块 + 启动流程）
 *
 * 启动流程：
 *   1. 绑定全部事件（各模块的 setupXxx）
 *   2. 取元信息（版本 / 发布日期）——失败不影响主流程
 *   3. 查询鉴权状态 → 需要登录则展示登录页，否则加载导航数据
 *   4. 未保存改动时，离开页面前提醒
 *
 * 模块依赖方向（自底向上，无循环）：
 *   state / utils           基础（无依赖）
 *   api / filter / render   请求 / 过滤 / 渲染
 *   webSearch / iconPicker / modal / editor / background / account
 *   dnd / users / settings / auth / clearData
 *   main                    组装一切
 * ============================================================ */
import { state } from './state.js';
import { api, showBackendError } from './api.js';
import { $ } from './utils.js';
import { render } from './render.js';
import { setupSearch } from './filter.js';
import { renderHeroSearch, setupEngineSettings, setupWebSearch } from './webSearch.js';
import { setupDragAndDrop } from './dnd.js';
import { setupModal } from './modal.js';
import { loadConfigForUser, setupActions } from './editor.js';
import { setupSettings } from './settings.js';
import { hideLoginModal, setupLogin, setupLoginPolicy, setupLogout, showLoginModal } from './auth.js';
import { applyBackground, setupBackground } from './background.js';
import { setupUserManagement } from './users.js';
import { setupClearData } from './clearData.js';
import { refreshAuthStatus, updateAccountUI } from './account.js';

async function init() {
    // 1) 绑定全部事件
    setupSearch();
    setupWebSearch();
    setupEngineSettings();
    setupDragAndDrop();
    setupModal();
    setupActions();
    setupSettings();
    setupLogin();
    setupLoginPolicy();
    setupLogout();
    setupBackground();
    setupUserManagement();
    setupClearData();

    // 2) 取元信息（版本 / 发布日期）
    try {
        state.appMeta = await api('/api/meta');
        $('aboutVersion').textContent = state.appMeta.version || '-';
        $('aboutDate').textContent = state.appMeta.release_date || '-';
    } catch (e) {
        /* 元信息失败不影响主流程 */
    }

    // 3) 查询鉴权状态
    let needLogin = false;
    try {
        const status = await refreshAuthStatus();
        applyBackground(state.appSettings.background);
        renderHeroSearch();
        needLogin = status.login_required && !status.logged_in;
    } catch (e) {
        console.error('获取鉴权状态失败:', e);
        // 接口不可用时给出明确提示，避免页面白屏让人摸不着头脑
        showBackendError(e);
    }

    // 4) 加载导航数据
    if (needLogin) {
        // 未登录：直接展示登录页，不渲染导航内容
        state.config = {};
        render();
        showLoginModal();
    } else {
        hideLoginModal();
        await loadConfigForUser();
    }

    updateAccountUI();

    // 有未保存改动时，离开页面前给出提醒
    window.addEventListener('beforeunload', () => {
        if (state.dirty) {
            return '有未保存的更改，确定要离开吗？';
        }
    });

    // 隐藏加载动画，显示主容器
    $('loading').classList.add('hidden');
    $('mainContainer').classList.add('visible');
}

init();
