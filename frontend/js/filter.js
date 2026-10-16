/* ============================================================
 * 站内服务过滤：按卡片名称实时筛选（与网页搜索相互独立）
 * ============================================================ */
import { $, $$all } from './utils.js';

export function applyFilter(rawQuery) {
    const query = (rawQuery || '').toLowerCase().trim();
    const cards = $$all('.card');
    const sections = $$all('.section');
    let hasResults = false;

    cards.forEach(card => {
        const match = card.dataset.name.includes(query);
        card.style.display = match ? 'flex' : 'none';
        if (match) hasResults = true;
    });

    sections.forEach(section => {
        const visibleCards = section.querySelectorAll('.card:not([style*="display: none"])');
        // 空分组始终保留显示（只在「搜索无结果」时隐藏），避免退出编辑模式后
        // 用户配置的分组看起来消失；同时方便在非编辑模式下也能看到「该分组暂无内容」
        const keepVisible = !query;
        section.style.display = (visibleCards.length > 0 || keepVisible) ? 'block' : 'none';
    });

    $('noResults').style.display = hasResults ? 'none' : 'block';
}

export function setupSearch() {
    $('searchInput').addEventListener('input', function () {
        applyFilter(this.value);
    });
}
