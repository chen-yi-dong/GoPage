/* ============================================================
 * 账号管理：用户列表 / 新增 / 修改（密码、权限、用户名）/ 删除
 *
 * 权限规则与后端一致：
 *   * 必须「真实登录」才能管理账号（免登录模式不行）
 *   * 管理员可管理全部账号；普通用户只能修改自己的密码
 * ============================================================ */
import { state } from './state.js';
import { api } from './api.js';
import { $, escapeHtml, guardUnavailable, setButtonUnavailable, toast } from './utils.js';
import { refreshAuthStatus } from './account.js';

export async function refreshUserList() {
    const tbody = $('userTableBody');
    const hint = $('userListHint');
    const addBtn = $('addUserBtn');
    if (!tbody) return;

    // 账号管理要求「真实登录」：
    //   * 未登录 / 免登录模式（implicit admin）下，一律不允许查看与修改账号信息
    if (!state.loggedIn || !state.currentUser) {
        const reason = !state.loginRequired
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
        const isSelf = state.currentUser && u.username === state.currentUser.username;
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
    if (!state.loggedIn || !state.currentUser) {
        toast(state.loginRequired ? '请先登录后再管理账号' : '免登录模式下无法管理账号，请先启用登录验证并登录');
        return;
    }

    state.userModalMode = mode;
    state.userModalTarget = username || '';
    const isAdmin = state.currentUser && state.currentUser.is_admin;

    $('userModalTitle').textContent = mode === 'create' ? '新增账号' : `修改账号 · ${username}`;

    const nameGroup = $('userNameGroup');
    const nameInput = $('userName');
    const adminGroup = $('userAdminGroup');
    const passInput = $('userPass');
    const passHint = $('userPassHint');

    if (mode === 'create') {
        nameGroup.style.display = '';
        nameInput.value = '';
        nameInput.readOnly = false;
        adminGroup.style.display = isAdmin ? '' : 'none';
        $('userIsAdmin').checked = false;
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
        $('userIsAdmin').checked = !!(badge && badge.classList.contains('admin'));
        passInput.value = '';
        passHint.textContent = '（留空表示不修改，至少 6 位）';
        passInput.required = false;
    }

    $('userModal').classList.add('show');
    (mode === 'create' ? nameInput : passInput).focus();
}

function closeUserModal() {
    $('userModal').classList.remove('show');
}

export function setupUserManagement() {
    guardUnavailable($('addUserBtn'), () => {
        openUserModal('create');
    });

    $('userModalCancel').addEventListener('click', closeUserModal);
    $('userModal').addEventListener('click', e => {
        if (e.target.id === 'userModal') closeUserModal();
    });

    // 表格内的操作按钮
    $('userTableBody').addEventListener('click', async e => {
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
    $('userForm').addEventListener('submit', async e => {
        e.preventDefault();
        const username = $('userName').value.trim();
        const password = $('userPass').value;
        const isAdmin = $('userIsAdmin').checked;

        try {
            if (state.userModalMode === 'create') {
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
                if ($('userNameGroup').style.display !== 'none') {
                    const newName = $('userName').value.trim();
                    if (newName && newName !== state.userModalTarget) payload.new_username = newName;
                }
                await api(`/api/users/${encodeURIComponent(state.userModalTarget)}`, {
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
