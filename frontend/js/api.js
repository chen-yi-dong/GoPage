/* ============================================================
 * 请求封装：统一带上鉴权头，统一解析错误
 *
 * 前后端同源部署（由同一个容器/端口提供），使用相对路径即可。
 * 如需前后端分离调试，可改成绝对地址，例如 'http://127.0.0.1:5000'
 * ============================================================ */
import { state } from './state.js';
import { $, escapeHtml } from './utils.js';

const API_BASE = '';

export async function api(path, options = {}) {
    const opts = {
        cache: 'no-store',
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
            ...(options.headers || {})
        }
    };

    const fullUrl = `${API_BASE}${path}`;
    let resp;
    try {
        resp = await fetch(fullUrl, opts);
    } catch (netErr) {
        // 网络层失败（服务未启动 / 跨域被拦 / 地址不可达）
        const err = new Error(`无法连接服务：${netErr.message}`);
        err.url = fullUrl;
        err.status = 0;
        throw err;
    }

    let data = null;
    try {
        data = await resp.json();
    } catch (e) {
        data = null;
    }

    if (!resp.ok) {
        const msg = (data && data.error) || `请求失败（${resp.status}）`;
        const err = new Error(msg);
        err.status = resp.status;
        err.code = data && data.code;
        err.url = fullUrl;            // 便于排查实际的请求地址
        err.responseUrl = resp.url;   // 浏览器实际请求的完整地址（含重定向后）
        throw err;
    }
    return data;
}

// 把接口错误整理成便于排查的文案
export function describeApiError(err) {
    const lines = [];
    lines.push(`请求：${err.url || '(未知)'}`);
    if (err.responseUrl && err.responseUrl !== err.url) {
        lines.push(`实际：${err.responseUrl}`);
    }
    lines.push(`状态：${err.status === 0 ? '网络不可达' : err.status}`);
    lines.push(`原因：${err.message}`);
    lines.push(`页面：${location.origin}`);
    return lines.join('\n');
}

// 后端接口不可用（404 / 网络错误）时给出明确提示，便于排查部署问题
export function showBackendError(err) {
    const container = $('content');
    if (!container) return;

    const status = err && err.status;
    let title = '无法连接后端服务';
    if (status === 404) title = '接口返回 404（地址不正确）';
    else if (status === 401) title = '登录状态失效，请重新登录';

    container.innerHTML = `
        <div style="max-width:680px;margin:2rem auto;padding:1.5rem 1.75rem;background:rgba(0,0,0,0.6);
                    border-radius:14px;color:#fff;line-height:1.8;">
            <h3 style="margin-bottom:0.8rem;display:flex;align-items:center;gap:0.5rem;">
                <i class="fas fa-triangle-exclamation" style="color:#f1c40f;"></i> ${escapeHtml(title)}
            </h3>
            <pre style="font-size:0.8rem;background:rgba(0,0,0,0.35);padding:0.75rem;border-radius:8px;
                        white-space:pre-wrap;word-break:break-all;">${escapeHtml(describeApiError(err))}</pre>
            <ul style="font-size:0.85rem;opacity:0.9;margin:0.9rem 0 0 1.2rem;">
                <li>页面与接口应当来自<strong>同一个地址</strong>（前后端已打包在同一服务）</li>
                <li>直接访问 <code>${escapeHtml((API_BASE || location.origin) + '/api/meta')}</code> 应返回一段 JSON</li>
                <li>若返回 404，说明该地址上没有本后端服务</li>
            </ul>
            <div style="margin-top:1rem;display:flex;gap:0.6rem;">
                <button type="button" class="btn" onclick="location.reload()">
                    <i class="fas fa-rotate-right"></i> 重新加载
                </button>
                <button type="button" class="btn" id="backendProbeBtn">
                    <i class="fas fa-stethoscope"></i> 检测接口
                </button>
            </div>
        </div>`;

    const probeBtn = $('backendProbeBtn');
    if (probeBtn) {
        probeBtn.addEventListener('click', async () => {
            probeBtn.classList.add('busy');
            const base = API_BASE || location.origin;
            const targets = [
                `${base}/api/meta`,
                `${location.origin}/api/meta`,
            ];
            const results = [];
            for (const url of targets) {
                try {
                    const r = await fetch(url, { cache: 'no-store' });
                    results.push(`${r.ok ? '✔' : '✘'} ${url} -> ${r.status}`);
                } catch (e) {
                    results.push(`✘ ${url} -> ${e.message}`);
                }
            }
            alert('接口连通性检测：\n\n' + results.join('\n'));
            probeBtn.classList.remove('busy');
        });
    }
}
