/* ============================================================
 * 全局状态
 * 所有需要跨模块共享的可变状态都集中在这一个对象里，
 * 各模块通过 import { state } from './state.js' 读写，
 * 避免「全局变量满天飞」导致的难以追踪问题。
 * ============================================================ */

export const state = {
    // 当前正在编辑的数据（分组 -> 卡片数组）
    config: {},
    editing: false,          // 是否处于编辑模式
    dirty: false,            // 是否有未保存的改动
    justDragged: false,      // 刚完成一次拖拽（用于屏蔽随后的误触点击）

    // 编辑弹窗状态
    modalAction: null,       // 当前弹窗的提交回调
    modalValidate: null,     // 当前弹窗的实时校验函数（用于重名检测等）

    // 鉴权与设置状态
    authToken: localStorage.getItem('nav_token') || '',
    currentUser: null,       // { username, is_admin, created_at }（免登录模式下为公共配置）
    loggedIn: false,         // 是否真正通过登录获得会话（免登录模式下为 false）
    loginRequired: true,     // 后端是否启用了登录验证
    canEditNav: true,        // 是否允许编辑导航内容（未启用登录验证时视为可编辑）
    appMeta: { version: '-', release_date: '-' },
    appSettings: {
        background: { type: 'default', value: '' },
        search: { engines: [], current: '' },   // 搜索引擎配置（后端返回，含内置 Bing/Google）
    },

    // 账号弹窗状态
    userModalMode: 'create', // 'create' | 'edit'
    userModalTarget: '',     // 编辑时的原用户名

    // 拖动会话状态（结构见 dnd.js）
    dndSession: null,
};

/** 写入 / 清除登录令牌（同步到 localStorage，刷新页面不丢登录态） */
export function setToken(token) {
    state.authToken = token || '';
    if (state.authToken) localStorage.setItem('nav_token', state.authToken);
    else localStorage.removeItem('nav_token');
}
