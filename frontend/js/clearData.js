/* ============================================================
 * 清空数据（危险操作，二次确认：需输入自己的账号密码）
 *   管理员：保留账号，仅清空导航数据、背景与搜索引擎配置
 *   普通用户：账号及全部相关数据一并删除，且不可恢复
 * ============================================================ */
import { state, setToken } from './state.js';
import { api } from './api.js';
import { $, guardUnavailable, toast } from './utils.js';
import { render } from './render.js';
import { applyBackground, fillBackgroundForm } from './background.js';
import { refreshAuthStatus, updateAccountUI } from './account.js';
import { showLoginModal } from './auth.js';
import { closeSettings } from './settings.js';

export function setupClearData() {
    guardUnavailable($('clearDataBtn'), () => {
        if (!state.currentUser) {
            toast('请先登录');
            return;
        }
        const isAdmin = state.currentUser.is_admin;
        $('clearWarn').innerHTML = isAdmin
            ? '你当前是<b>管理员</b>：确认后将<b>保留账号</b>，仅清空你的导航数据与背景设置。'
            : '你当前是<b>普通用户</b>：确认后将<b>删除你的账号及全部相关数据</b>，且不可恢复。';
        $('clearUser').value = '';
        $('clearPass').value = '';
        $('clearHint').textContent = '';
        $('clearModal').classList.add('show');
        $('clearUser').focus();
    });

    $('clearCancel').addEventListener('click', () => {
        $('clearModal').classList.remove('show');
    });
    $('clearModal').addEventListener('click', e => {
        if (e.target.id === 'clearModal') $('clearModal').classList.remove('show');
    });

    $('clearForm').addEventListener('submit', async e => {
        e.preventDefault();
        const hint = $('clearHint');
        const username = $('clearUser').value.trim();
        const password = $('clearPass').value;

        if (!username || !password) {
            hint.textContent = '请输入用户名和密码';
            return;
        }

        try {
            const res = await api('/api/data/clear', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });
            $('clearModal').classList.remove('show');

            if (res.scope === 'admin') {
                toast('已清空你的导航数据（账号已保留）');
                state.config = {};
                state.dirty = false;
                render();
                fillBackgroundForm({ type: 'default', value: '' });
                applyBackground({ type: 'default', value: '' });
            } else {
                toast('你的账号及数据已清除，已退出登录');
                setToken('');
                state.loggedIn = false;
                state.currentUser = null;
                state.canEditNav = !state.loginRequired;
                state.config = {};
                state.dirty = false;
                render();
                closeSettings();
                updateAccountUI();
                if (state.loginRequired) {
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
