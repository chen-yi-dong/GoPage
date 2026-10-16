/* ============================================================
 * 拖动排序（Pointer Events 实现，支持实时预览）
 *   用「占位元素」实时反映移动结果：拖动过程中其他卡片/分组会被挤开
 *   用 FLIP 动画让被挤走的元素平滑移动，而不是生硬跳位
 *
 * 会话状态保存在 state.dndSession，结构：
 *   { type: 'card' | 'section', node, ghost, offsetX, offsetY,
 *     startX, startY, started, size, slotKey, ... }
 * ============================================================ */
import { state } from './state.js';
import { $, $$all } from './utils.js';
import { applyLocalChanges } from './render.js';

export function setupDragAndDrop() {
    const content = $('content');
    if (content.dataset.dndReady === '1') return;
    content.dataset.dndReady = '1';

    // 用 Pointer Events 统一起点，鼠标 / 触屏都可用
    content.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
}

// 取得占位元素（复用同一个小方块）
function getPlaceholder() {
    let ph = $('dnd-placeholder');
    if (!ph) {
        ph = document.createElement('div');
        ph.id = 'dnd-placeholder';
        ph.className = 'dnd-placeholder';
    }
    return ph;
}

function placePlaceholder(target, position /* 'before' | 'after' | 'append' */) {
    const ph = getPlaceholder();
    if (!target) return;

    // 计算占位块应处的位置，若与当前位置相同则不做任何 DOM 操作，避免来回闪烁
    let referenceNode;
    if (position === 'append') {
        referenceNode = null; // 追加到末尾
    } else if (position === 'before') {
        referenceNode = target;
    } else {
        referenceNode = target.nextSibling;
    }

    if (position === 'append') {
        if (ph.parentNode === target && ph === target.lastElementChild) return;
        target.appendChild(ph);
    } else {
        if (ph.parentNode === target.parentNode && ph.nextSibling === referenceNode) return;
        target.parentNode.insertBefore(ph, referenceNode);
    }
}

function removePlaceholder() {
    const ph = $('dnd-placeholder');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
    // 清除上次拖动遗留的内联尺寸，避免影响下一次拖动
    if (ph) {
        ph.style.width = '';
        ph.style.height = '';
    }
}

/* ---------- 起点 ---------- */
function onPointerDown(e) {
    if (!state.editing) return;
    if (e.button !== undefined && e.button !== 0) return; // 只响应左键

    const cardAction = e.target.closest('.card-actions');
    const sectionAction = e.target.closest('.section-actions');
    if (cardAction || sectionAction) return; // 点击操作按钮不触发拖动

    const card = e.target.closest('.card');
    const section = e.target.closest('.section');
    const onSectionHandle = e.target.closest('[data-role="section-handle"]');

    if (card && !onSectionHandle) {
        startCardDrag(e, card);
    } else if (onSectionHandle && section) {
        startSectionDrag(e, section);
    }
}

function startCardDrag(e, card) {
    const sectionEl = card.closest('.section');
    const rect = card.getBoundingClientRect();

    const ghost = card.cloneNode(true);
    ghost.classList.add('dnd-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.display = 'none'; // 达到拖动阈值后才显示
    document.body.appendChild(ghost);

    state.dndSession = {
        type: 'card',
        node: card,
        ghost,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        homeSection: sectionEl.dataset.section,
        // 记录被拖动卡片对应的数据对象，跨组时用于从原分组移除
        item: card._configItem || null,
        size: { width: rect.width, height: rect.height }
    };
    moveGhost(e.clientX, e.clientY);

    e.preventDefault();
}

function startSectionDrag(e, section) {
    const rect = section.getBoundingClientRect();
    const ghost = section.cloneNode(true);
    ghost.classList.add('dnd-ghost', 'dnd-ghost-section');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.display = 'none'; // 达到拖动阈值后才显示
    document.body.appendChild(ghost);

    // 锁定拖动开始时的「其它分组」顺序与位置快照（排除自身），
    // 后续间隙判定以此为准，避免 DOM 被插入占位块/隐藏源元素后产生漂移
    const container = $('content');
    const sectionBase = $$all(':scope > .section', container)
        .filter(el => el !== section)
        .map(el => ({
            name: el.dataset.section,
            el,
            rect: el.getBoundingClientRect()
        }));

    state.dndSession = {
        type: 'section',
        node: section,
        ghost,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        size: { width: rect.width, height: rect.height },
        sectionBase
    };
    moveGhost(e.clientX, e.clientY);

    e.preventDefault();
}

function moveGhost(x, y) {
    if (!state.dndSession) return;
    const { ghost, offsetX, offsetY } = state.dndSession;
    ghost.style.left = (x - offsetX) + 'px';
    ghost.style.top = (y - offsetY) + 'px';
}

/* ---------- 移动中：实时预览 ---------- */
function onPointerMove(e) {
    if (!state.dndSession) return;

    // 移动超过阈值才开始真正拖动，避免误触
    if (!state.dndSession.started) {
        const dx = Math.abs(e.clientX - state.dndSession.startX);
        const dy = Math.abs(e.clientY - state.dndSession.startY);
        if (dx < 5 && dy < 5) return;
        state.dndSession.started = true;
        // 显示幽灵元素、隐藏原元素（保留在 DOM 中以保证索引计算稳定）
        state.dndSession.ghost.style.display = '';
        state.dndSession.node.classList.add('dnd-source-hidden');
        document.body.classList.add('dragging-active');
        // 重置落点槽位状态（首次移动时立刻判定一次）
        state.dndSession.slotKey = null;
        // 占位元素先放到原元素之前，营造"原位留空"效果
        const ph = getPlaceholder();
        // 让占位块与原元素尺寸一致，避免所在网格行高/列宽跳变导致的闪烁
        if (state.dndSession.size) {
            ph.style.width = state.dndSession.size.width + 'px';
            ph.style.height = state.dndSession.size.height + 'px';
        }
        state.dndSession.node.parentNode.insertBefore(ph, state.dndSession.node);
    }

    moveGhost(e.clientX, e.clientY);
    e.preventDefault();

    // 计算当前指针命中的「落点槽位」（带滞回：槽位不变时不再重新判定/触发换位）
    const slot = state.dndSession.type === 'card'
        ? resolveCardSlot(e)
        : resolveSectionSlot(e);

    if (!slot) return;

    // 槽位未变化 → 什么都不做，避免鼠标轻微移动就来回换位
    // 槽位由「间隙下标」构成，只要指针还在同一间隙内，就不会触发任何变化
    if (state.dndSession.slotKey === slot.key) return;

    state.dndSession.slotKey = slot.key;

    // 清除旧高亮
    $$all('.drop-target').forEach(el => el.classList.remove('drop-target'));

    // 用 FLIP 技术让「被挤走」的卡片平滑移动，而不是生硬跳位
    // 拖动卡片时只动画卡片（不动画分组），拖动分组时才动画分组，避免整页抖动
    const selector = state.dndSession.type === 'card' ? '.card' : '.section';
    const before = capturePositions($('content'), selector);

    slot.apply();

    playFlip(before);
}

/* ---------- 落点判定（按「卡片之间的间隙」判定，并带滞回） ---------- */

function resolveCardSlot(e) {
    state.dndSession.ghost.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return null;

    const grid = el.closest('[data-role="grid"]');
    const section = el.closest('.section');
    const dropZone = el.closest('[data-role="drop-zone"]');

    // 找到指针所在（或最接近）的分组网格
    const gridEl = grid || (section && section.querySelector('[data-role="grid"]'));
    if (!gridEl) {
        if (dropZone) {
            const zoneSection = dropZone.closest('.section');
            return {
                key: `zone:${zoneSection.dataset.section}`,
                apply() {
                    placePlaceholder(dropZone, 'before');
                    dropZone.classList.add('drop-target');
                }
            };
        }
        return null;
    }

    const sectionName = gridEl.closest('.section').dataset.section;

    // 收集该网格中所有卡片（排除被拖动的源卡片）及其位置
    const cards = $$all(':scope > .card', gridEl)
        .filter(c => c !== state.dndSession.node);

    if (!cards.length) {
        return {
            key: `empty:${sectionName}`,
            apply() {
                placePlaceholder(gridEl, 'append');
                gridEl.classList.add('drop-target');
            }
        };
    }

    // 计算插入槽位：把「卡片之间的间隙」当作判定区域
    // 槽位 0 = 第 1 张卡片之前；槽位 i = 第 i 张卡片之后；槽位 n = 最后一张之后
    // 用每张卡片的中线作为间隙分界：指针在卡片 i 中线左侧 → 插入到 i 之前
    const rects = cards.map(c => c.getBoundingClientRect());

    let slotIndex = cards.length;            // 默认插到最后
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const midX = r.left + r.width / 2;
        if (e.clientX < midX) {
            slotIndex = i;
            break;
        }
    }

    const refCard = cards[slotIndex];        // 插入到它之前；slotIndex === cards.length 时插到最后
    // key 由「分组 + 间隙下标」构成：只要指针还在同一间隙内，key 不变 → 不做任何操作
    const slotKey = `slot:${sectionName}:${slotIndex}`;

    return {
        key: slotKey,
        apply() {
            if (refCard) {
                placePlaceholder(refCard, 'before');
                refCard.classList.add('drop-target');
            } else {
                placePlaceholder(gridEl, 'append');
                gridEl.classList.add('drop-target');
            }
        }
    };
}

// 分组拖动：按「分组之间的间隙」判定插入槽位（带滞回）
// 以拖动开始时锁定的原始分组顺序为基准，计算指针落在哪个间隙，
// 避免因为 DOM 中被插入占位块 / 源元素被隐藏而导致判定漂移
function resolveSectionSlot(e) {
    state.dndSession.ghost.style.pointerEvents = 'none';

    const base = state.dndSession.sectionBase;   // [{ name, el, rect }]，拖动开始时快照
    if (!base || !base.length) return null;

    // 槽位 0 = 第 1 个分组之前；槽位 i = 第 i 个分组之前；槽位 n = 最后之后
    let slotIndex = base.length;
    for (let i = 0; i < base.length; i++) {
        const r = base[i].rect;
        const midY = r.top + r.height / 2;
        if (e.clientY < midY) {
            slotIndex = i;
            break;
        }
    }

    const refEntry = base[slotIndex];
    return {
        key: `slot:${slotIndex}`,
        apply() {
            const container = $('content');

            if (!refEntry) {
                // 插到最后
                container.appendChild(getPlaceholder());
                base[base.length - 1].el.classList.add('drop-target');
                return;
            }

            container.insertBefore(getPlaceholder(), refEntry.el);
            refEntry.el.classList.add('drop-target');
        }
    };
}

// 记录元素位置（FLIP: First）
// 注意：先取消进行中的位移动画，否则 getBoundingClientRect 会被动画的 transform 污染，
// 导致「测量 → 动画 → 再测量」形成反馈回路，表现为小卡片来回闪烁
function capturePositions(root, selector) {
    const map = new Map();
    $$all(selector || '.card, .section', root).forEach(el => {
        if (el.classList.contains('dnd-source-hidden')) return;
        if (el._flipAnim) {
            el._flipAnim.cancel();
            el._flipAnim = null;
        }
        const r = el.getBoundingClientRect();
        map.set(el, { left: r.left, top: r.top });
    });
    return map;
}

// 播放位置变化动画（FLIP: Invert + Play）
// 使用 Web Animations API，避免与进行中的动画互相打断而产生闪烁
function playFlip(beforeMap) {
    beforeMap.forEach((prev, el) => {
        if (!el.isConnected) return;
        const now = el.getBoundingClientRect();
        const dx = prev.left - now.left;
        const dy = prev.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

        // 取消同一元素上未完成的位移动画，保证从当前视觉位置平滑过渡
        if (el._flipAnim) el._flipAnim.cancel();
        try {
            el._flipAnim = el.animate(
                [
                    { transform: `translate(${dx}px, ${dy}px)` },
                    { transform: 'translate(0, 0)' }
                ],
                { duration: 220, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }
            );
            el._flipAnim.onfinish = () => { el._flipAnim = null; };
        } catch (err) {
            // 退化方案：不支持 Web Animations 时直接还原，不做动画
        }
    });
}

/* ---------- 结束：结算并保存 ---------- */
function onPointerUp(e) {
    if (!state.dndSession) return;

    const session = state.dndSession;

    // 未真正开始拖动 → 视为普通点击，不做任何处理
    if (!session.started) {
        teardownDnd();
        return;
    }

    e.preventDefault();

    if (session.type === 'card') {
        commitCardDrag(session);
    } else {
        commitSectionDrag(session);
    }

    teardownDnd();

    // 屏蔽拖动结束后紧随的 click，避免 <a> 触发跳转导致页面刷新
    state.justDragged = true;
    setTimeout(() => { state.justDragged = false; }, 300);
}

function teardownDnd() {
    document.body.classList.remove('dragging-active');
    if (!state.dndSession) return;
    const { ghost, node } = state.dndSession;
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    if (node) {
        node.classList.remove('dnd-source-hidden');
        if (node._flipAnim) {
            node._flipAnim.cancel();
            node._flipAnim = null;
        }
    }
    removePlaceholder();
    $$all('.drop-target').forEach(el => el.classList.remove('drop-target'));
    state.dndSession.slotKey = null;
    state.dndSession = null;
}

function commitCardDrag(session) {
    const ph = $('dnd-placeholder');
    if (!ph || !ph.parentNode) return;

    const newGrid = ph.closest('[data-role="grid"]');
    if (!newGrid) return;
    const toSection = newGrid.closest('.section').dataset.section;
    const fromSection = session.homeSection;

    // 被拖动的卡片对象（拖动开始时记录，跨组时从原分组移除）
    const movedItem = session.item || session.node._configItem;

    // 1) 先把被拖动的卡片节点移动到占位块位置（就地更新 DOM）
    moveCardNodeInDom(session.node, ph, newGrid);

    // 2) 依据移动后的真实 DOM 顺序重建「目标分组」的卡片数组
    const rebuildByDom = sectionEl => {
        const gridEl = sectionEl.querySelector('[data-role="grid"]');
        if (!gridEl) return null;
        return $$all(':scope > .card', gridEl)
            .map(cardEl => cardEl._configItem)
            .filter(Boolean);
    };

    const targetSectionEl = newGrid.closest('.section');
    const rebuiltTarget = rebuildByDom(targetSectionEl) || [];

    if (fromSection === toSection) {
        // 同组：直接用 DOM 顺序（不会丢项，因为只挪动了组内节点）
        state.config[toSection] = rebuiltTarget;
    } else {
        // 跨组：目标组用 DOM 顺序；原组明确移除被拖走的那一项
        state.config[toSection] = rebuiltTarget;

        const sourceSectionEl = $$all('.section')
            .find(el => el.dataset.section === fromSection);

        if (sourceSectionEl) {
            state.config[fromSection] = rebuildByDom(sourceSectionEl) || [];
        }
        // 双保险：若原分组中仍存在该卡片对象，强制剔除
        if (Array.isArray(state.config[fromSection])) {
            state.config[fromSection] = state.config[fromSection].filter(it => it !== movedItem);
        }
    }

    // 3) 用最新 config 重新渲染，保证界面顺序与服务端数据完全一致
    applyLocalChanges();
}

// 把被拖动的卡片节点移动到占位块所在位置，并移除占位块
function moveCardNodeInDom(node, placeholder, targetGrid) {
    if (placeholder.parentNode === targetGrid) {
        targetGrid.insertBefore(node, placeholder);
    } else {
        targetGrid.appendChild(node);
    }
    removePlaceholder();
}

function commitSectionDrag(session) {
    const ph = $('dnd-placeholder');
    if (!ph || !ph.parentNode) return;

    const container = ph.parentNode;

    // 1) 先把被拖动的分组节点移动到占位块位置（就地更新 DOM）
    if (ph.parentNode === container) {
        container.insertBefore(session.node, ph);
    } else {
        container.appendChild(session.node);
    }
    removePlaceholder();

    // 2) 直接以「移动后的真实 DOM 顺序」重建 config，彻底避免下标推算出错
    const orderedKeys = $$all(':scope > .section', container)
        .map(el => el.dataset.section);

    const newConfig = {};
    orderedKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(state.config, key)) {
            newConfig[key] = state.config[key];
        }
    });
    // 兜底：把不在 DOM 中的分组（理论上不会出现）追加回去，避免数据丢失
    Object.keys(state.config).forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(newConfig, key)) {
            newConfig[key] = state.config[key];
        }
    });
    state.config = newConfig;

    // 用最新 config 重新渲染，保证界面顺序与服务端数据完全一致
    applyLocalChanges();
}
