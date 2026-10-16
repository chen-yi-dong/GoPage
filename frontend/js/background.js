/* ============================================================
 * 主页背景：默认渐变 / 纯色 / 图片 + 遮罩浓度
 *   遮罩浓度（0-80）通过 CSS 变量联动内容面板：
 *     #bgScrim            全局遮罩层透明度
 *     --panel-alpha       内容面板（联动开 = 遮罩 + 10%）
 *     --title-stroke-*    分组标题描边/阴影
 * ============================================================ */
import { state } from './state.js';
import { api } from './api.js';
import { $, guardUnavailable, toast } from './utils.js';

const DEFAULT_BACKGROUND = 'linear-gradient(135deg, #2C3E50 0%, #b3dace 30%, #cce8db 60%, #e3f5ec 100%)';

export function backgroundCss(bg) {
    if (!bg || bg.type === 'default') return DEFAULT_BACKGROUND;
    if (bg.type === 'color') return bg.value || DEFAULT_BACKGROUND;
    if (bg.type === 'image') return bg.value ? `url("${bg.value}")` : DEFAULT_BACKGROUND;
    return DEFAULT_BACKGROUND;
}

function applyScrim(pct) {
    let v = Number(pct);
    if (!Number.isFinite(v)) v = 30;
    v = Math.max(0, Math.min(80, v));
    const ratio = v / 100;
    const el = $('bgScrim');
    if (el) el.style.opacity = ratio.toFixed(3);

    const toggle = $('scrimPanelToggle');
    const linked = toggle ? toggle.checked : true;
    const root = document.documentElement;
    if (linked) {
        const panel = Math.min(ratio + 0.10, 0.95);
        root.style.setProperty('--panel-alpha', panel.toFixed(3));
        root.style.setProperty('--panel-alpha-deep', Math.min(panel + 0.07, 0.97).toFixed(3));
        root.style.setProperty('--band-alpha', Math.min(panel + 0.04, 0.95).toFixed(3));

        // 标题描边/阴影：随浓度缩放（0.30 时 = 基准观感 0.32 / 0.5 / 0.45）
        const strokeA = Math.min(0.20 + ratio * 0.40, 0.60).toFixed(3);
        const sh1 = Math.min(0.38 + ratio * 0.40, 0.70).toFixed(3);
        const sh2 = Math.min(0.33 + ratio * 0.40, 0.65).toFixed(3);
        root.style.setProperty('--title-stroke-color', `rgba(10, 16, 26, ${strokeA})`);
        root.style.setProperty('--title-shadow',
            `0 2px 4px rgba(2, 8, 20, ${sh1}), 0 4px 18px rgba(2, 8, 20, ${sh2})`);
    } else {
        root.style.setProperty('--panel-alpha', '0');
        root.style.setProperty('--panel-alpha-deep', '0');
        root.style.setProperty('--band-alpha', '0');
        root.style.setProperty('--title-stroke-color', 'rgba(10, 16, 26, 0)');
        root.style.setProperty('--title-shadow', 'none');
    }
}

export function applyBackground(bg) {
    document.body.style.backgroundImage = 'none';
    document.body.style.background = '';
    // 同步「内容面板跟随联动」开关（首次加载/登录后与已保存状态对齐）
    const toggle = $('scrimPanelToggle');
    if (toggle && bg && bg.panel_link !== undefined) toggle.checked = !!bg.panel_link;
    applyScrim(bg && bg.scrim !== undefined ? bg.scrim : 30);

    if (!bg || bg.type === 'default') {
        document.body.style.background = DEFAULT_BACKGROUND;
        document.body.style.backgroundAttachment = 'fixed';
        return;
    }
    if (bg.type === 'color') {
        document.body.style.background = bg.value || DEFAULT_BACKGROUND;
        return;
    }
    if (bg.type === 'image' && bg.value) {
        document.body.style.backgroundImage = `url("${bg.value.replace(/"/g, '')}")`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
        document.body.style.backgroundRepeat = 'no-repeat';
        return;
    }
    document.body.style.background = DEFAULT_BACKGROUND;
}

function refreshBgPreview() {
    const preview = $('bgPreview');
    if (!preview) return;
    const type = getSelectedBgType();
    let value = '';
    if (type === 'color') value = $('bgColor').value || '';
    if (type === 'image') value = $('bgImage').value.trim();
    preview.style.backgroundImage = 'none';
    preview.style.background = backgroundCss({ type, value });
    if (type === 'image' && value) {
        preview.style.backgroundImage = `url("${value.replace(/"/g, '')}")`;
        preview.style.backgroundSize = 'cover';
        preview.style.backgroundPosition = 'center';
    }
    // 预览遮罩浓度（::after 层的透明度跟随滑块）
    const scrimRange = $('bgScrimRange');
    const pct = scrimRange ? +scrimRange.value : 30;
    preview.style.setProperty('--scrim-opacity', (pct / 100).toFixed(2));
}

function getSelectedBgType() {
    const el = document.querySelector('input[name="bgType"]:checked');
    return el ? el.value : 'default';
}

function setSelectedBgType(type) {
    document.querySelectorAll('input[name="bgType"]').forEach(el => {
        el.checked = el.value === (type || 'default');
    });
    const isColor = type === 'color';
    const isImage = type === 'image';
    $('bgColorRow').style.display = isColor ? '' : 'none';
    $('bgImageRow').style.display = isImage ? '' : 'none';
}

export function fillBackgroundForm(bg) {
    const b = bg || { type: 'default', value: '' };
    setSelectedBgType(b.type);
    if (b.type === 'color') {
        $('bgColor').value = /^#[0-9a-fA-F]{6}$/.test(b.value) ? b.value : '#2C3E50';
        $('bgColorText').value = b.value || '';
    } else {
        $('bgColor').value = '#2C3E50';
        $('bgColorText').value = '';
    }
    $('bgImage').value = b.type === 'image' ? (b.value || '') : '';
    // 同步遮罩滑块、百分比与「内容面板跟随联动」开关
    let scrimPct = Number(b.scrim);
    if (!Number.isFinite(scrimPct)) scrimPct = 30;
    scrimPct = Math.max(0, Math.min(80, scrimPct));
    const scrimRange = $('bgScrimRange');
    if (scrimRange) {
        scrimRange.value = scrimPct;
        $('bgScrimValue').textContent = scrimPct + '%';
    }
    const panelToggle = $('scrimPanelToggle');
    if (panelToggle) panelToggle.checked = b.panel_link !== undefined ? !!b.panel_link : true;
    refreshBgPreview();
}

export function setupBackground() {
    document.querySelectorAll('input[name="bgType"]').forEach(el => {
        el.addEventListener('change', () => {
            setSelectedBgType(getSelectedBgType());
            refreshBgPreview();
        });
    });

    const colorPicker = $('bgColor');
    const colorText = $('bgColorText');

    colorPicker.addEventListener('input', () => {
        colorText.value = colorPicker.value;
        refreshBgPreview();
    });
    colorText.addEventListener('input', () => {
        const v = colorText.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) colorPicker.value = v;
        refreshBgPreview();
    });
    $('bgImage').addEventListener('input', refreshBgPreview);

    // 背景遮罩滑块：拖动时实时预览（更新页面遮罩 + 百分比 + 预览图）
    const scrimRange = $('bgScrimRange');
    if (scrimRange) {
        scrimRange.addEventListener('input', () => {
            const pct = +scrimRange.value;
            $('bgScrimValue').textContent = pct + '%';
            applyScrim(pct);
            refreshBgPreview();
        });
    }

    // 内容面板联动开关：切换时实时重新应用遮罩
    const panelToggle = $('scrimPanelToggle');
    if (panelToggle) {
        panelToggle.addEventListener('change', () => {
            applyScrim(scrimRange ? +scrimRange.value : 30);
            refreshBgPreview();
        });
    }

    guardUnavailable($('bgSaveBtn'), async () => {
        const type = getSelectedBgType();
        let value = '';
        if (type === 'color') {
            value = ($('bgColorText').value.trim() || $('bgColor').value);
            if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
                toast('颜色格式应为 #RGB 或 #RRGGBB');
                return;
            }
        } else if (type === 'image') {
            value = $('bgImage').value.trim();
            if (value && !/^(https?:\/\/|data:image\/|\.\/)/.test(value)) {
                toast('图片地址应以 http(s):// 或 ./ 开头');
                return;
            }
        }
        const scrim = scrimRange ? +scrimRange.value : 30;
        const panel_link = panelToggle ? panelToggle.checked : true;

        try {
            const res = await api('/api/settings', {
                method: 'POST',
                body: JSON.stringify({ background: { type, value, scrim, panel_link } })
            });
            state.appSettings.background = res.background;
            applyBackground(state.appSettings.background);
            fillBackgroundForm(state.appSettings.background);
            toast('背景已保存');
        } catch (error) {
            toast('保存失败：' + error.message);
        }
    });

    guardUnavailable($('bgResetBtn'), async () => {
        try {
            const res = await api('/api/settings', {
                method: 'POST',
                body: JSON.stringify({ background: { type: 'default', value: '' } })
            });
            state.appSettings.background = res.background;
            fillBackgroundForm(state.appSettings.background);
            applyBackground(state.appSettings.background);
            toast('已恢复默认背景');
        } catch (error) {
            toast('操作失败：' + error.message);
        }
    });
}
