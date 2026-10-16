/* ============================================================
 * 编辑弹窗：复用为「卡片」和「分组」表单
 * 打开时通过参数控制显示哪些字段（链接 / 图标可隐藏）
 * ============================================================ */
import { state } from './state.js';
import { $, escapeHtml, setButtonUnavailable, toast } from './utils.js';
import { setupIconPicker } from './iconPicker.js';

export function openModal({ title, showUrl = true, showIcon = true, values = {}, onSubmit, validate, submitLabel }) {
    $('modalTitle').textContent = title;
    $('urlGroup').style.display = showUrl ? '' : 'none';
    $('iconGroup').style.display = showIcon ? '' : 'none';
    // 隐藏的字段要同步取消 required，否则浏览器的原生校验会拦住提交
    $('fieldUrl').required = showUrl;
    $('fieldName').value = values.name || '';
    $('fieldUrl').value = values.url || '';
    $('fieldIcon').value = values.icon || '';
    $('iconPreview').innerHTML = values.icon ? `<i class="${escapeHtml(values.icon)}"></i>` : '';

    // 提交按钮文案随上下文变化：默认「保存」，可由调用方覆盖
    $('modalSubmit').textContent = submitLabel || '保存';

    state.modalAction = onSubmit;
    // 额外的实时校验（如重名检测）：输入时立即更新按钮可用状态
    // 返回 { unavailable: true, reason: '...' } 表示按钮应置灰
    state.modalValidate = typeof validate === 'function' ? validate : null;
    const modal = $('editModal');
    modal.classList.add('show');

    // 打开弹窗时刷新「保存」按钮的可用状态（缺必填项则置灰）
    const form = $('editForm');
    if (form && typeof form._refreshSubmitState === 'function') {
        form._refreshSubmitState();
    }

    $('fieldName').focus();
}

function closeModal() {
    $('editModal').classList.remove('show');
    state.modalAction = null;
    state.modalValidate = null;
}

export function setupModal() {
    const form = $('editForm');
    const nameInput = $('fieldName');
    const urlInput = $('fieldUrl');
    const submitBtn = $('modalSubmit');

    // 根据必填项是否填写，实时更新「保存」按钮是否置灰
    const refreshSubmitState = () => {
        const name = nameInput.value.trim();
        const nameOk = !!name;
        const urlRequired = $('urlGroup').style.display !== 'none';
        const urlOk = !urlRequired || !!urlInput.value.trim();

        let unavailable = !(nameOk && urlOk);
        let reason = '';
        if (!nameOk) reason = '请先填写「名称」';
        else if (!urlOk) reason = '请先填写「链接地址」';

        // 自定义校验（如新增分组时的重名检测）：表单本身合法时再检查
        if (!unavailable && state.modalValidate) {
            try {
                const extra = state.modalValidate(name);
                if (extra && extra.unavailable) {
                    unavailable = true;
                    reason = extra.reason || '';
                }
            } catch (_) { /* 校验函数异常不影响 UI */ }
        }

        setButtonUnavailable(submitBtn, unavailable, reason || '请先补全必填项');
    };
    form._refreshSubmitState = refreshSubmitState;

    nameInput.addEventListener('input', refreshSubmitState);
    urlInput.addEventListener('input', refreshSubmitState);

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = {
            name: nameInput.value.trim(),
            url: urlInput.value.trim(),
            icon: $('fieldIcon').value.trim()
        };
        // 缺少必填项时给出明确提示（按钮此刻已置灰）
        if (!data.name) {
            toast('请先填写「名称」');
            refreshSubmitState();
            return;
        }
        const urlRequired = $('urlGroup').style.display !== 'none';
        if (urlRequired && !data.url) {
            toast('请先填写「链接地址」');
            refreshSubmitState();
            return;
        }
        if (state.modalAction) {
            const action = state.modalAction;
            // 让处理函数可以先校验（如重名检测）：
            // 返回 false 表示校验未通过，保持弹窗打开，便于用户修改
            let result;
            try {
                result = await action(data);
            } catch (err) {
                toast('操作失败：' + (err && err.message ? err.message : err));
                return;
            }
            if (result === false) return;   // 校验失败，弹窗保持打开
            closeModal();
        }
    });

    $('modalCancel').addEventListener('click', closeModal);
    $('editModal').addEventListener('click', e => {
        if (e.target.id === 'editModal') closeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });
    $('fieldIcon').addEventListener('input', function () {
        $('iconPreview').innerHTML = this.value.trim()
            ? `<i class="${escapeHtml(this.value.trim())}"></i>`
            : '';
    });

    setupIconPicker();
}
