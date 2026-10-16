/* ============================================================
 * 通用工具：DOM 简写 / HTML 转义 / 提示条 / 按钮「不可用」处理
 * 不依赖项目里任何其他模块。
 * ============================================================ */

/** document.getElementById 简写 */
export const $ = id => document.getElementById(id);

/** querySelectorAll 简写（返回数组，可直接 map / filter / forEach） */
export const $$all = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** HTML 转义：所有拼进 innerHTML 的用户数据都必须先过这里 */
export function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------
 * 轻量提示条（1.8 秒后自动消失）
 * ---------------------------------------------------------- */
let toastTimer = null;
export function toast(message) {
    let el = $('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ------------------------------------------------------------
 * 按钮「不可用」处理：置灰 + 点击时说明原因
 * 注意：只对「缺少必填项」或「暂不支持」的按钮置灰，可用的按钮不置灰
 * ---------------------------------------------------------- */
export function setButtonUnavailable(btn, unavailable, reason) {
    if (!btn) return;
    btn.classList.toggle('unavailable', !!unavailable);
    btn.dataset.unavailableReason = unavailable ? (reason || '该操作当前不可用') : '';
}

/** 点击不可用按钮时统一拦截并提示原因 */
export function guardUnavailable(btn, handler) {
    if (!btn) return;
    btn.addEventListener('click', e => {
        if (btn.classList.contains('unavailable')) {
            e.preventDefault();
            e.stopPropagation();
            toast(btn.dataset.unavailableReason || '该操作当前不可用');
            return;
        }
        if (typeof handler === 'function') handler(e);
    });
}
