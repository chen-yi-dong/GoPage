/* ============================================================
 * 当前账号：向后端同步登录状态 + 在界面上展示
 *
 * 与 auth.js 的分工：
 *   auth.js    登录 / 登出「动作」与登录页
 *   本模块      「我是谁」的状态镜像（refreshAuthStatus）
 *              与账号信息展示（updateAccountUI）
 * 独立成模块的好处：settings / users / clearData 等模块
 * 只需要「读身份」，不必依赖登录动作，依赖图保持无环。
 * ============================================================ */
import { state, setToken } from './state.js';
import { api } from './api.js';
import { $, setButtonUnavailable } from './utils.js';

/** 查询后端鉴权状态，并同步到全局 state */
export async function refreshAuthStatus() {
    const res = await api('/api/auth/status');
    state.loginRequired = !!res.login_required;
    // 免登录模式下后端会返回默认管理员身份，此时也算「有管理员权限」
    state.currentUser = res.user || null;
    // 是否真的通过了登录（用于区分「免登录模式的默认身份」）
    state.loggedIn = !!res.logged_in;
    // 免登录模式下后端以默认管理员身份提供服务，因此可以编辑
    state.canEditNav = !state.loginRequired || state.loggedIn;
    if (res.background) state.appSettings.background = res.background;
    if (res.search) state.appSettings.search = res.search;

    // 仅在「需要登录但令牌已失效」时清理本地缓存
    if (state.loginRequired && !state.loggedIn) setToken('');
    return res;
}

/** 刷新「关于」页的账号展示，以及退出登录 / 清空数据按钮的可用状态 */
export function updateAccountUI() {
    const userEl = $('aboutUser');
    if (userEl) {
        if (state.loggedIn && state.currentUser) {
            userEl.textContent = `${state.currentUser.username}${state.currentUser.is_admin ? '（管理员）' : ''}`;
        } else if (!state.loginRequired && state.currentUser) {
            // 免登录模式：后端以「公共配置」虚拟身份工作（_public 不直接展示）
            const name = state.currentUser.username === '_public' ? '公共配置' : state.currentUser.username;
            userEl.textContent = `${name}（免登录模式）`;
        } else {
            userEl.textContent = '未登录';
        }
    }
    // 未登录时：退出登录 / 清空数据 均置灰并说明原因
    setButtonUnavailable($('logoutBtn'), !state.loggedIn, '当前未登录');
    setButtonUnavailable($('clearDataBtn'), !state.currentUser, '请先登录后再清空数据');
}
