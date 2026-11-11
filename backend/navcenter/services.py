"""业务逻辑层：用户、设置、背景、搜索引擎、导航数据

只做「数据与规则」，不碰 HTTP（不出现 request / response），
路由层（routes_*.py）负责把 HTTP 请求翻译成这里的函数调用。
"""
import datetime
import os
import re

from .passwords import hash_password
from .paths import (
    BUILTIN_SEARCH_ENGINES,
    DATA_DIR,
    DEFAULT_BG_SCRIM,
    DEFAULT_PASSWORD,
    DEFAULT_USERNAME,
    LEGACY_NAV_DIR,
    MAX_SEARCH_ENGINES,
    NAV_DIR,
    PUBLIC_USERNAME,
    SETTINGS_FILE,
    USERS_FILE,
)
from .storage import read_json, write_json

# 不随账号迁移的元数据文件（迁移旧数据时要排除它们）
_META_FILES = {'users.json', 'settings.json', 'sessions.json'}


# ---------------------------------------------------------------- 目录与旧数据
def ensure_data_dirs():
    """创建数据目录结构"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(NAV_DIR, exist_ok=True)


def migrate_legacy_files():
    """兼容旧版本目录结构：把散落在 data/ 根下的导航数据迁移到 data/nav/ 下。

    仅在目标不存在时迁移，可重复执行（幂等）。
    """
    ensure_data_dirs()

    moved = []
    if os.path.isdir(LEGACY_NAV_DIR):
        for name in os.listdir(LEGACY_NAV_DIR):
            if not name.endswith('.json') or name in _META_FILES:
                continue
            src = os.path.join(LEGACY_NAV_DIR, name)
            dst = os.path.join(NAV_DIR, name)
            if os.path.isfile(src) and not os.path.exists(dst):
                try:
                    os.replace(src, dst)
                    moved.append('nav/' + name)
                except OSError:
                    pass

    if moved:
        print('[数据迁移] 已移动到新目录 data/ :', ', '.join(moved))


# ---------------------------------------------------------------- 用户
def load_users():
    """读取账号表；文件损坏时按空表处理"""
    users = read_json(USERS_FILE)
    return users if isinstance(users, dict) else {}


def save_users(users):
    write_json(USERS_FILE, users)


def ensure_default_user():
    """首次运行时自动创建默认管理员；返回当前账号表"""
    ensure_data_dirs()

    users = load_users()
    if users:
        return users

    users[DEFAULT_USERNAME] = {
        'password': hash_password(DEFAULT_PASSWORD),
        'is_admin': True,
        'created_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'must_change_password': True,
    }
    save_users(users)
    save_user_config(DEFAULT_USERNAME, {})
    ensure_settings()
    return users


def public_user(username, record):
    """对外输出的用户信息（绝不包含密码或哈希）"""
    return {
        'username': username,
        'is_admin': bool(record.get('is_admin')),
        'created_at': record.get('created_at', ''),
        'is_public': bool(record.get('is_public')),
    }


# ---------------------------------------------------------------- 导航数据
def user_data_file(username):
    """每个账号一个独立配置文件：data/nav/<用户名>.json

    公共配置（免登录模式）对应：data/nav/_public.json
    """
    if username == PUBLIC_USERNAME:
        return os.path.join(NAV_DIR, '_public.json')
    safe = re.sub(r'[^A-Za-z0-9_\u4e00-\u9fa5-]', '_', username)
    return os.path.join(NAV_DIR, f'{safe}.json')


def load_user_config(username):
    data = read_json(user_data_file(username))
    return data if isinstance(data, dict) else {}


def save_user_config(username, data):
    write_json(user_data_file(username), data)


# ---------------------------------------------------------------- 设置
def load_settings():
    settings = read_json(SETTINGS_FILE)
    return settings if isinstance(settings, dict) else {}


def ensure_settings():
    """补全旧数据缺失的字段；只有确实发生变化时才落盘

    getter 会反复调用本函数，若每次都无条件写 settings.json，
    纯读接口也会变成写接口，并在并发下放大写冲突。
    """
    settings = load_settings()
    changed = False
    if 'login_required' not in settings:
        settings['login_required'] = True
        changed = True
    if 'backgrounds' not in settings or not isinstance(settings['backgrounds'], dict):
        settings['backgrounds'] = {}
        changed = True
    if changed:
        save_settings(settings)
    return settings


def save_settings(settings):
    write_json(SETTINGS_FILE, settings)


def login_required_enabled():
    return bool(ensure_settings().get('login_required', True))


# ---------------------------------------------------------------- 背景
def get_background(username):
    """读取背景设置；旧记录缺少 scrim / panel_link 时补默认值"""
    settings = ensure_settings()
    bg = settings['backgrounds'].get(username)
    if not isinstance(bg, dict):
        bg = {'type': 'default', 'value': ''}
    try:
        scrim = int(bg.get('scrim', DEFAULT_BG_SCRIM))
    except (TypeError, ValueError):
        scrim = DEFAULT_BG_SCRIM
    bg['scrim'] = max(0, min(80, scrim))
    bg['panel_link'] = bool(bg.get('panel_link', True))
    return bg


def set_background(username, bg):
    settings = ensure_settings()
    settings['backgrounds'][username] = bg
    save_settings(settings)


# ---------------------------------------------------------------- 搜索引擎
def get_search_config(username):
    """读取账号的搜索引擎配置；无记录时返回内置引擎副本"""
    settings = ensure_settings()
    store = settings.get('search_engines')
    cfg = store.get(username) if isinstance(store, dict) else None
    if not isinstance(cfg, dict):
        cfg = {}

    engines = cfg.get('engines')
    if not isinstance(engines, list):
        engines = []
    # 过滤掉不完整的记录，防止手改配置文件导致页面异常
    engines = [e for e in engines
               if isinstance(e, dict) and e.get('id') and e.get('name') and e.get('url')]
    if not engines:
        engines = [dict(e) for e in BUILTIN_SEARCH_ENGINES]

    current = cfg.get('current')
    if current not in [e['id'] for e in engines]:
        current = engines[0]['id']

    return {'engines': engines, 'current': current}


def save_search_config(username, cfg):
    settings = ensure_settings()
    if not isinstance(settings.get('search_engines'), dict):
        settings['search_engines'] = {}
    settings['search_engines'][username] = cfg
    save_settings(settings)
