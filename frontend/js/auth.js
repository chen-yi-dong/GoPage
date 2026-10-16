/* ============================================================
 * 登录 / 登出：动作与登录页
 *
 * 三种身份（状态字段详见 account.js）：
 *   loggedIn = true      真实登录的账号
 *   loginRequired = false 免登录模式：后端以「公共配置」虚拟身份工作
 *   其余                 未登录（弹登录页）
 * ============================================================ */
import { state, setToken } from './state.js';
import { api } from './api.js';
import { $, guardUnavailable, toast } from './utils.js';
import { render } from './render.js';
import { applyBackground, backgroundCss } from './background.js';
import { loadConfigForUser } from './editor.js';
import { renderHeroSearch } from './webSearch.js';
import { refreshAuthStatus, updateAccountUI } from './account.js';
import { closeSettings, openSettings } from './settings.js';

export function showLoginModal(message) {
    const page = $('loginPage');
    $('loginHint').textContent = message || '';
    $('loginPass').value = '';
    page.classList.add('show');
    // 未登录时锁住页面滚动，避免看到背后的内容
    document.body.classList.add('login-locked');
    // 登录页使用当前背景设置
    page.style.background = backgroundCss(state.appSettings.background);
    const bg = state.appSettings.background;
    if (bg && bg.type === 'image' && bg.value) {
        page.style.backgroundImage = `url("${bg.value.replace(/"/g, '')}")`;
        page.style.backgroundSize = 'cover';
        page.style.backgroundPosition = 'center';
    } else {
        page.style.backgroundImage = 'none';
    }

    const userInput = $('loginUser');
    if (!userInput.value) userInput.focus();
    else $('loginPass').focus();
}

export function hideLoginModal() {
    $('loginPage').classList.remove('show');
    document.body.classList.remove('login-locked');
    $('loginHint').textContent = '';
}

async function doLogin(username, password) {
    const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
    });
    setToken(res.token);
    state.currentUser = res.user;
    state.loggedIn = true;
    state.canEditNav = true;
    if (res.background) state.appSettings.background = res.background;
    if (res.search) state.appSettings.search = res.search;
    hideLoginModal();
    applyBackground(state.appSettings.background);
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
    state.loggedIn = false;
    state.editing = false;
    state.dirty = false;
    state.config = {};
    closeSettings();

    if (state.loginRequired) {
        // 仍需登录：清空身份并弹出登录页
        state.currentUser = null;
        state.canEditNav = false;
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
            state.currentUser = null;
            state.canEditNav = true;
        }
        applyBackground(state.appSettings.background);
        render();
        updateAccountUI();
        toast('已退出登录（当前为免登录模式，可再次开启登录验证）');
    }
}

export function setupLogin() {
    $('loginForm').addEventListener('submit', async e => {
        e.preventDefault();
        const username = $('loginUser').value.trim();
        const password = $('loginPass').value;
        const hint = $('loginHint');
        const btn = $('loginSubmit');

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

/** 「退出登录」按钮（位于设置弹窗的「关于」页） */
export function setupLogout() {
    guardUnavailable($('logoutBtn'), () => {
        if (!state.loggedIn) return;
        if (!confirm('确认退出登录？')) return;
        doLogout();
    });
}

/**
 * 「启用登录验证」开关（位于设置弹窗的「基础设置」页，仅管理员可改）
 * 规则：无论「开启」还是「关闭」，改完之后都必须重新登录，以新策略重新建立会话。
 * 放在 auth.js 是因为它改变的是登录策略本身。
 */
export function setupLoginPolicy() {
    $('loginRequiredToggle').addEventListener('change', async function () {
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
            state.loginRequired = res.login_required;
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
        state.loggedIn = false;
        state.currentUser = null;
        state.editing = false;
        state.dirty = false;
        state.config = {};
        closeSettings();
        render();
        updateAccountUI();

        if (state.loginRequired) {
            // 开启登录验证：回到登录页
            state.canEditNav = false;
            showLoginModal('已启用登录验证，请重新登录');
        } else {
            // 关闭登录验证：以默认管理员身份继续，但同样提示需重新进入
            state.canEditNav = true;
            try {
                await refreshAuthStatus();
            } catch (e) {
                /* 忽略 */
            }
            applyBackground(state.appSettings.background);
            render();
            updateAccountUI();
            toast('已关闭登录验证，当前为免登录模式');
        }
    });
}
