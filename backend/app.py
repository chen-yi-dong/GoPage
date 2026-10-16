"""
个人导航中心 - 前后端一体化服务

本文件同时承担两个职责：
  1. 提供 REST API（多用户、登录鉴权、导航数据、设置、账号管理）
  2. 直接托管前端静态页面（前后端打包在同一容器，同源访问，无跨域问题）

功能概览：
  * 多用户：每个账号拥有独立的导航配置文件
  * 账号安全：密码使用 PBKDF2-HMAC-SHA256 + 随机盐 单向加密，接口永不返回密码/哈希
  * 权限：管理员可管理所有用户；普通用户只能修改自己的密码
  * 可选的登录验证开关（关闭时以独立的「公共配置」身份使用，与任何账号隔离）
  * 每个账号独立的界面设置（背景纯色/图片/遮罩、搜索引擎等）

目录说明：
  frontend/                前端静态资源（可由 NAV_FRONTEND_DIR 指定）
  data/                    唯一的持久化目录，Docker 只需挂载它
    ├── users.json         账号表（仅密码摘要，无明文）
    ├── settings.json      全局设置 + 各账号界面设置（背景、搜索引擎等）
    ├── sessions.json      登录令牌（重启后仍保持登录）
    └── nav/<用户名>.json  每个账号的导航数据

  数据目录可通过环境变量 NAV_DATA_DIR 覆盖（容器中通常指向挂载卷）。
  首次启动会自动创建目录、生成默认管理员（admin / admin123）。
"""
from flask import Flask, jsonify, request, send_from_directory, redirect
from flask_cors import CORS
import json
import os
import re
import hashlib
import secrets
import datetime

# 前端静态资源的目录（与后端一起打包进同一个镜像/容器）
#   * Docker 中为 /app/frontend
#   * 本地开发时为本项目同级的 ../frontend
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
FRONTEND_DIR = os.environ.get('NAV_FRONTEND_DIR') or os.path.join(BASE_DIR, 'frontend')
if not os.path.isdir(FRONTEND_DIR):
    _sibling = os.path.abspath(os.path.join(BASE_DIR, '..', 'frontend'))
    if os.path.isdir(_sibling):
        FRONTEND_DIR = _sibling

# 前后端同源部署（同一个容器、同一个端口）
# 这里关闭 Flask 自带的 static 路由（static_folder=None），改由下方自定义路由提供，
# 这样可以精确控制 SPA 回退、目录穿越防护与 /api 冲突。
app = Flask(__name__, static_folder=None)
# 允许跨域：便于本地开发时前端独立运行；同源部署下不影响
CORS(app)

# 重要：关闭 JSON 键排序，否则 jsonify 会按 Unicode 重新排列分组顺序，
# 导致拖动排序保存后刷新页面分组顺序又被打乱
app.json.sort_keys = False

# ---------------------------------------------------------------- 常量与路径
APP_VERSION = '1.0.13'
APP_RELEASE_DATE = '2026-09-20'

# 所有需要持久化的数据统一放在 data/ 目录下，便于 Docker 挂载卷（重启不丢数据）
#   data/
#     ├── users.json               账号表（密码摘要，无明文）
#     ├── settings.json            全局设置 + 各账号界面设置（背景、搜索引擎等）
#     ├── sessions.json            登录令牌（重启后仍保持登录）
#     └── nav/
#         ├── <用户名>.json        每个账号的导航数据
#         └── _public.json         免登录模式使用的公共配置（不属于任何账号）
#
# 可通过环境变量 NAV_DATA_DIR 覆盖（容器里通常指向挂载卷）
DATA_DIR = os.environ.get('NAV_DATA_DIR') or os.path.join(BASE_DIR, 'data')
NAV_DIR = os.path.join(DATA_DIR, 'nav')

USERS_FILE = os.path.join(DATA_DIR, 'users.json')
SETTINGS_FILE = os.path.join(DATA_DIR, 'settings.json')
SESSIONS_FILE = os.path.join(DATA_DIR, 'sessions.json')

# 旧版导航数据目录（导航文件曾直接放在 data/ 下）
LEGACY_NAV_DIR = DATA_DIR

DEFAULT_USERNAME = 'admin'
DEFAULT_PASSWORD = 'admin123'

# 背景遮罩默认浓度（%），设置页可调 0-80
DEFAULT_BG_SCRIM = 30

# 免登录模式使用的「公共配置」伪账号名。
# 它不是一个真实账号（不会出现在用户表里），只用来定位 data/nav/_public.json，
# 这样免登录模式下改动的数据不会与 admin 账号的数据混在一起。
PUBLIC_USERNAME = '_public'

PBKDF2_ITERATIONS = 200_000
USERNAME_PATTERN = re.compile(r'^[A-Za-z0-9_\u4e00-\u9fa5-]{1,32}$')

# 登录令牌有效期（秒），默认 30 天
SESSION_MAX_AGE = 30 * 24 * 3600

# 登录令牌：token -> { username, created_at }
# 持久化到 data/sessions.json，这样服务重启后登录状态不会丢失
SESSIONS = {}

# 导入即创建数据目录，避免任何读写路径因目录缺失而失败（幂等、无副作用）
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(NAV_DIR, exist_ok=True)


def load_sessions():
    """从磁盘加载会话，并清理已过期 / 用户已不存在的令牌"""
    global SESSIONS
    raw = read_json(SESSIONS_FILE, {})
    if not isinstance(raw, dict):
        raw = {}

    users = load_users()
    now = datetime.datetime.now()
    valid = {}
    for token, sess in raw.items():
        try:
            created = datetime.datetime.fromisoformat(sess.get('created_at', ''))
        except (ValueError, AttributeError, TypeError):
            continue
        if (now - created).total_seconds() > SESSION_MAX_AGE:
            continue
        if sess.get('username') not in users:
            continue
        valid[token] = sess

    SESSIONS = valid
    return valid


def save_sessions():
    write_json(SESSIONS_FILE, SESSIONS)


# ---------------------------------------------------------------- 基础工具
def read_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    """先写临时文件再原子替换，避免写入中断导致数据损坏"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_file = path + '.tmp'
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
    os.replace(tmp_file, path)


def no_cache(resp):
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


# ---------------------------------------------------------------- 密码加密
def hash_password(password, salt=None):
    """使用 PBKDF2-HMAC-SHA256 生成单向密码摘要"""
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt.encode('utf-8'),
        PBKDF2_ITERATIONS
    )
    return {'salt': salt, 'hash': digest.hex(), 'algo': 'pbkdf2_sha256', 'iterations': PBKDF2_ITERATIONS}


def verify_password(password, record):
    """校验密码，使用恒定时间比较防止时序攻击"""
    if not isinstance(record, dict):
        return False
    expected = record.get('hash') or ''
    calc = hash_password(password, record.get('salt') or '')['hash']
    return secrets.compare_digest(calc, expected)


# ---------------------------------------------------------------- 用户数据
def load_users():
    users = read_json(USERS_FILE)
    if not isinstance(users, dict):
        users = {}
    return users


def save_users(users):
    write_json(USERS_FILE, users)


def user_data_file(username):
    """
    每个账号一个独立配置文件：data/nav/<用户名>.json
    公共配置（免登录模式）对应：data/nav/_public.json
    """
    if username == PUBLIC_USERNAME:
        return os.path.join(NAV_DIR, '_public.json')
    safe = re.sub(r'[^A-Za-z0-9_\u4e00-\u9fa5-]', '_', username)
    return os.path.join(NAV_DIR, f'{safe}.json')


def ensure_data_dirs():
    """创建数据目录结构"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(NAV_DIR, exist_ok=True)


def migrate_legacy_files():
    """
    兼容旧版本目录结构：把散落在 data/ 根下的导航数据文件
    迁移到 data/nav/ 下。仅在目标不存在时迁移，可重复执行（幂等）。
    """
    ensure_data_dirs()

    moved = []
    # 旧的导航数据文件（data/<用户名>.json -> data/nav/<用户名>.json）
    # 注意：只迁移「账号数据文件」，排除用户表/设置/会话等元数据文件
    meta_names = {'users.json', 'settings.json', 'sessions.json'}
    if os.path.isdir(LEGACY_NAV_DIR):
        for name in os.listdir(LEGACY_NAV_DIR):
            if not name.endswith('.json') or name in meta_names:
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


def load_user_config(username):
    data = read_json(user_data_file(username))
    if isinstance(data, dict):
        return data
    return {}


def save_user_config(username, data):
    write_json(user_data_file(username), data)


def ensure_default_user():
    """首次运行时自动创建默认管理员；返回当前账号表（供启动信息复用，避免重复读盘）"""
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


def load_settings():
    settings = read_json(SETTINGS_FILE)
    if not isinstance(settings, dict):
        settings = {}
    return settings


def ensure_settings():
    """用户级设置：每个账号一份（背景、是否启用登录验证由管理员维护全局开关）"""
    settings = load_settings()
    if 'login_required' not in settings:
        settings['login_required'] = True
    if 'backgrounds' not in settings or not isinstance(settings['backgrounds'], dict):
        settings['backgrounds'] = {}
    save_settings(settings)
    return settings


def save_settings(settings):
    write_json(SETTINGS_FILE, settings)


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


# ---------------------------------------------------------------- 搜索引擎配置
# 内置搜索引擎（{kw} 为关键词占位符，搜索时替换为 URL 编码后的关键词）
BUILTIN_SEARCH_ENGINES = [
    {'id': 'bing', 'name': 'Bing', 'url': 'https://www.bing.com/search?q={kw}'},
    {'id': 'google', 'name': 'Google', 'url': 'https://www.google.com/search?q={kw}'},
]

MAX_SEARCH_ENGINES = 12   # 每个账号最多可保存的搜索引擎数量


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


# ---------------------------------------------------------------- 鉴权
def get_token():
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        return auth[7:].strip()
    return request.headers.get('X-Auth-Token', '').strip()


def current_user():
    """返回 (username, user_record) 或 (None, None)"""
    token = get_token()
    if token and token in SESSIONS:
        username = SESSIONS[token]['username']
        users = load_users()
        if username in users:
            return username, users[username]
        # 用户已被删除，清理失效会话
        SESSIONS.pop(token, None)
        save_sessions()
    return None, None


def login_required_enabled():
    return bool(ensure_settings().get('login_required', True))


def resolve_actor():
    """
    解析当前操作者：
      * 启用登录验证  -> 必须携带有效 token
      * 关闭登录验证  -> 未登录时按「公共配置」处理（PUBLIC_USERNAME）

    公共配置说明：
      它不是真实账号（不在 users.json 中），只对应 data/nav/_public.json，
      因此免登录模式下改动的导航数据不会污染任何真实账号的数据。

    返回 (username, user_record, error_response)
    """
    username, user = current_user()
    if username:
        return username, user, None

    if not login_required_enabled():
        # 公共配置：虚拟管理员身份，仅用于读写 _public.json 与公共背景
        return PUBLIC_USERNAME, {
            'is_admin': True,
            'is_public': True,
            'created_at': '',
        }, None

    return None, None, (jsonify({'error': '未登录或登录已失效', 'code': 'unauthorized'}), 401)


def resolve_logged_in_actor():
    """
    账号管理专用：必须「真实登录」才允许操作。
    免登录模式（login_required=False）下即使后端会回退到默认管理员，
    也不允许管理账号，避免未经验证就修改用户信息。

    返回 (username, user_record, error_response)
    """
    username, user = current_user()
    if username:
        return username, user, None

    if not login_required_enabled():
        return None, None, (jsonify({
            'error': '免登录模式下无法管理账号，请先启用登录验证并登录',
            'code': 'login_required_for_user_mgmt',
        }), 403)

    return None, None, (jsonify({'error': '未登录或登录已失效', 'code': 'unauthorized'}), 401)


def public_user(username, record):
    """对外输出的用户信息（绝不包含密码或哈希）"""
    return {
        'username': username,
        'is_admin': bool(record.get('is_admin')),
        'created_at': record.get('created_at', ''),
        'is_public': bool(record.get('is_public')),
    }


@app.before_request
def normalize_api_path():
    """
    兼容接口路径的尾斜杠：/api/meta/ 与 /api/meta 视为同一个接口。
    避免因前端多写一个 '/' 而落到静态路由上变成 404。
    """
    if request.path.startswith('/api/') and request.path.endswith('/') and len(request.path) > 5:
        new_path = request.path.rstrip('/')
        return redirect(new_path, code=308)


# ---------------------------------------------------------------- 元信息
@app.route('/api/meta', methods=['GET'])
def get_meta():
    return no_cache(jsonify({
        'name': '个人导航中心',
        'version': APP_VERSION,
        'release_date': APP_RELEASE_DATE,
    }))


@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    """
    前端启动时调用：是否需要登录、当前是否已登录、当前用户信息

    当「登录验证」关闭时，后端以「公共配置」身份提供服务
    （见 resolve_actor），这里也把该身份返回给前端，
    否则前端会认为「未登录且没有管理员权限」，导致设置里的
    登录验证开关被禁用、无法再次开启。

    公共配置使用的是 data/nav/_public.json，与任何真实账号的数据隔离。
    """
    username, user = current_user()
    settings = ensure_settings()
    required = bool(settings.get('login_required', True))

    effective_user = None
    if username:
        effective_user = public_user(username, user)
    elif not required:
        # 免登录模式：以公共配置身份提供服务
        effective_user = public_user(PUBLIC_USERNAME, {
            'is_admin': True, 'is_public': True, 'created_at': '',
        })

    # 背景归属：登录用户用自己；免登录模式用公共配置
    bg_owner = username or (PUBLIC_USERNAME if not required else None)

    return no_cache(jsonify({
        'login_required': required,
        'logged_in': username is not None,
        'user': effective_user,
        'public_config': not required,
        'background': get_background(bg_owner) if bg_owner else None,
        'search': get_search_config(bg_owner) if bg_owner else None,
    }))


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'error': '请输入用户名和密码'}), 400

    users = load_users()
    record = users.get(username)
    # 统一的失败提示，避免暴露「用户名是否存在」
    if not record or not verify_password(password, record.get('password')):
        return jsonify({'error': '用户名或密码错误'}), 401

    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {
        'username': username,
        'created_at': datetime.datetime.now().isoformat(timespec='seconds'),
    }
    save_sessions()

    return jsonify({
        'success': True,
        'token': token,
        'user': public_user(username, record),
        'must_change_password': bool(record.get('must_change_password')),
        'background': get_background(username),
        'search': get_search_config(username),
    })


@app.route('/api/logout', methods=['POST'])
def logout():
    token = get_token()
    if token:
        SESSIONS.pop(token, None)
        save_sessions()
    return jsonify({'success': True})


# ---------------------------------------------------------------- 导航配置
@app.route('/api/config', methods=['GET'])
def get_config():
    """读取当前账号的导航配置"""
    username, _user, err = resolve_actor()
    if err:
        return err
    try:
        return no_cache(jsonify(load_user_config(username)))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/config', methods=['POST'])
def update_config():
    """保存当前账号的导航配置"""
    username, _user, err = resolve_actor()
    if err:
        return err

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': '请求数据格式错误，应为 JSON 对象'}), 400

    for section, items in data.items():
        if not isinstance(items, list):
            return jsonify({'error': f'分组「{section}」的数据应为数组'}), 400
        for item in items:
            if not isinstance(item, dict):
                return jsonify({'error': f'分组「{section}」中存在非法的卡片数据'}), 400

    try:
        save_user_config(username, data)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ---------------------------------------------------------------- 用户管理
@app.route('/api/users', methods=['GET'])
def list_users():
    """
    管理员：返回全部用户；普通用户：只返回自己
    响应中始终不含任何密码信息
    要求必须真实登录（免登录模式不允许查看账号）
    """
    username, user, err = resolve_logged_in_actor()
    if err:
        return err

    users = load_users()
    if user.get('is_admin'):
        result = [public_user(name, rec) for name, rec in users.items()]
    else:
        result = [public_user(username, user)]

    result.sort(key=lambda x: (not x['is_admin'], x['username']))
    return no_cache(jsonify({'users': result, 'is_admin': bool(user.get('is_admin'))}))


@app.route('/api/users', methods=['POST'])
def create_user():
    username, user, err = resolve_logged_in_actor()
    if err:
        return err
    if not user.get('is_admin'):
        return jsonify({'error': '仅管理员可以新增账号'}), 403

    data = request.get_json(silent=True) or {}
    new_name = (data.get('username') or '').strip()
    password = data.get('password') or ''
    is_admin = bool(data.get('is_admin'))

    if not USERNAME_PATTERN.match(new_name):
        return jsonify({'error': '用户名只能包含中文、字母、数字、下划线或短横线，长度 1-32'}), 400
    if len(password) < 6:
        return jsonify({'error': '密码长度至少 6 位'}), 400

    users = load_users()
    if new_name in users:
        return jsonify({'error': '该用户名已存在'}), 409

    users[new_name] = {
        'password': hash_password(password),
        'is_admin': is_admin,
        'created_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'must_change_password': False,
    }
    save_users(users)
    save_user_config(new_name, {})
    return jsonify({'success': True, 'user': public_user(new_name, users[new_name])})


@app.route('/api/users/<username>', methods=['PUT'])
def update_user(username):
    """
    管理员：可重命名 / 修改任意用户的密码与权限
    普通用户：只能修改自己的密码
    要求必须真实登录（免登录模式不允许修改账号）
    """
    actor, actor_rec, err = resolve_logged_in_actor()
    if err:
        return err

    is_admin = bool(actor_rec.get('is_admin'))
    if not is_admin and actor != username:
        return jsonify({'error': '没有权限操作其他账号'}), 403

    users = load_users()
    if username not in users:
        return jsonify({'error': '用户不存在'}), 404

    data = request.get_json(silent=True) or {}
    record = users[username]
    changed = False

    # 修改密码（自己或管理员）
    new_password = data.get('password')
    if new_password:
        if len(new_password) < 6:
            return jsonify({'error': '密码长度至少 6 位'}), 400
        record['password'] = hash_password(new_password)
        record['must_change_password'] = False
        changed = True

    # 以下操作仅管理员可用
    if 'is_admin' in data or 'new_username' in data:
        if not is_admin:
            return jsonify({'error': '仅管理员可以修改权限或用户名'}), 403

        if 'is_admin' in data:
            want_admin = bool(data['is_admin'])
            # 防止把最后一个管理员降级，导致无人可管理
            if record.get('is_admin') and not want_admin:
                admin_count = sum(1 for r in users.values() if r.get('is_admin'))
                if admin_count <= 1:
                    return jsonify({'error': '系统必须保留至少一个管理员'}), 400
            record['is_admin'] = want_admin
            changed = True

        new_name = (data.get('new_username') or '').strip()
        if new_name and new_name != username:
            if not USERNAME_PATTERN.match(new_name):
                return jsonify({'error': '用户名只能包含中文、字母、数字、下划线或短横线，长度 1-32'}), 400
            if new_name in users:
                return jsonify({'error': '该用户名已存在'}), 409

            users[new_name] = record
            del users[username]

            # 迁移该用户的导航数据文件
            old_file = user_data_file(username)
            if os.path.exists(old_file):
                os.replace(old_file, user_data_file(new_name))

            # 迁移背景设置与搜索引擎配置
            settings = ensure_settings()
            if username in settings['backgrounds']:
                settings['backgrounds'][new_name] = settings['backgrounds'].pop(username)
            if isinstance(settings.get('search_engines'), dict) and username in settings['search_engines']:
                settings['search_engines'][new_name] = settings['search_engines'].pop(username)
            save_settings(settings)

            # 使其旧令牌失效
            for tk, sess in list(SESSIONS.items()):
                if sess['username'] == username:
                    sess['username'] = new_name
            save_sessions()

            username = new_name
            changed = True

    if changed:
        save_users(users)

    return jsonify({'success': True, 'user': public_user(username, users[username])})


@app.route('/api/users/<username>', methods=['DELETE'])
def delete_user(username):
    """
    仅管理员可删除用户（不能删除自己，也不能删掉最后一个管理员）
    要求必须真实登录（免登录模式不允许删除账号）
    """
    actor, actor_rec, err = resolve_logged_in_actor()
    if err:
        return err
    if not actor_rec.get('is_admin'):
        return jsonify({'error': '仅管理员可以删除账号'}), 403
    if actor == username:
        return jsonify({'error': '不能删除当前登录的账号'}), 400

    users = load_users()
    if username not in users:
        return jsonify({'error': '用户不存在'}), 404

    if users[username].get('is_admin'):
        admin_count = sum(1 for r in users.values() if r.get('is_admin'))
        if admin_count <= 1:
            return jsonify({'error': '系统必须保留至少一个管理员'}), 400

    del users[username]
    save_users(users)

    # 删除该用户的数据文件
    path = user_data_file(username)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass

    # 清理设置中的背景与搜索引擎配置
    settings = ensure_settings()
    settings['backgrounds'].pop(username, None)
    if isinstance(settings.get('search_engines'), dict):
        settings['search_engines'].pop(username, None)
    save_settings(settings)

    # 使其会话失效
    for tk, sess in list(SESSIONS.items()):
        if sess['username'] == username:
            SESSIONS.pop(tk, None)
    save_sessions()

    return jsonify({'success': True})


# ---------------------------------------------------------------- 界面设置
@app.route('/api/settings', methods=['GET'])
def get_settings():
    """返回当前账号可读取的设置"""
    username, user, err = resolve_actor()
    if err:
        return err

    settings = ensure_settings()
    return no_cache(jsonify({
        'login_required': bool(settings.get('login_required', True)),
        'is_admin': bool(user.get('is_admin')),
        'username': username,
        'background': get_background(username),
        'search': get_search_config(username),
    }))


@app.route('/api/settings', methods=['POST'])
def update_settings():
    """更新设置：登录验证开关仅管理员可改；背景每个账号独立"""
    username, user, err = resolve_actor()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    result = {}

    if 'login_required' in data:
        if not user.get('is_admin'):
            return jsonify({'error': '仅管理员可以修改登录验证开关'}), 403
        settings = ensure_settings()
        settings['login_required'] = bool(data['login_required'])
        save_settings(settings)
        result['login_required'] = settings['login_required']

    if 'background' in data:
        bg = data['background']
        if not isinstance(bg, dict):
            return jsonify({'error': '背景设置格式错误'}), 400

        bg_type = bg.get('type')
        value = bg.get('value') or ''
        if bg_type not in ('default', 'color', 'image'):
            return jsonify({'error': '不支持的背景类型'}), 400
        if bg_type == 'color' and not re.match(r'^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$', value):
            return jsonify({'error': '颜色格式应为 #RGB 或 #RRGGBB'}), 400
        if bg_type == 'image' and value and not re.match(r'^(https?://|data:image/|\./)', value):
            return jsonify({'error': '图片地址应以 http(s):// 或 ./ 开头'}), 400

        # 遮罩浓度（0-80），非法值回退默认；内容面板联动开关默认开
        try:
            scrim = int(bg.get('scrim', DEFAULT_BG_SCRIM))
        except (TypeError, ValueError):
            scrim = DEFAULT_BG_SCRIM
        scrim = max(0, min(80, scrim))
        panel_link = bool(bg.get('panel_link', True))

        set_background(username, {'type': bg_type, 'value': value, 'scrim': scrim, 'panel_link': panel_link})
        result['background'] = get_background(username)

    # 搜索引擎设置：{'search': {'current': id}} / {'add': {name,url}} / {'delete': id}
    if 'search' in data:
        s = data['search']
        if not isinstance(s, dict):
            return jsonify({'error': '搜索引擎设置格式错误'}), 400

        cfg = get_search_config(username)
        engines = cfg['engines']

        if 'add' in s:
            item = s['add'] if isinstance(s['add'], dict) else {}
            name = (item.get('name') or '').strip()
            url = (item.get('url') or '').strip()
            if not name or len(name) > 20:
                return jsonify({'error': '搜索引擎名称需为 1-20 个字符'}), 400
            if not re.match(r'^https?://', url):
                return jsonify({'error': '搜索地址需以 http(s):// 开头'}), 400
            if '{kw}' not in url:
                return jsonify({'error': '搜索地址需包含 {kw} 占位符（搜索词替换位置）'}), 400
            if len(engines) >= MAX_SEARCH_ENGINES:
                return jsonify({'error': f'搜索引擎数量已达上限（{MAX_SEARCH_ENGINES} 个）'}), 400
            new_engine = {
                'id': 'c' + secrets.token_hex(4),
                'name': name,
                'url': url,
            }
            engines.append(new_engine)
            cfg['current'] = new_engine['id']   # 新增后直接启用，符合直觉

        if 'delete' in s:
            did = s['delete']
            idx = next((i for i, e in enumerate(engines) if e['id'] == did), None)
            if idx is None:
                return jsonify({'error': '搜索引擎不存在'}), 404
            if len(engines) <= 1:
                return jsonify({'error': '至少保留一个搜索引擎'}), 400
            removed = engines.pop(idx)
            if cfg['current'] == removed['id']:
                cfg['current'] = engines[0]['id']

        if 'current' in s:
            cid = s['current']
            if cid not in [e['id'] for e in engines]:
                return jsonify({'error': '搜索引擎不存在'}), 404
            cfg['current'] = cid

        save_search_config(username, cfg)
        result['search'] = get_search_config(username)

    return jsonify({'success': True, **result})


# ---------------------------------------------------------------- 清空数据
@app.route('/api/data/clear', methods=['POST'])
def clear_data():
    """
    清空数据（危险操作，前端需二次确认并输入账号密码）
      * 管理员：保留账号本身，仅清空自己的导航数据、背景与搜索引擎配置
      * 普通用户：清除自己账号相关的所有数据（导航数据 + 背景设置 + 搜索引擎配置）
    """
    username, user, err = resolve_actor()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    confirm_user = (data.get('username') or '').strip()
    confirm_pass = data.get('password') or ''

    # 二次确认：必须输入自己的账号与密码
    if confirm_user != username:
        return jsonify({'error': '账号输入不正确'}), 400

    users = load_users()
    record = users.get(username)
    if not record or not verify_password(confirm_pass, record.get('password')):
        return jsonify({'error': '密码不正确'}), 401

    if user.get('is_admin'):
        # 管理员保留账号，只清空数据
        save_user_config(username, {})
        set_background(username, {'type': 'default', 'value': ''})
        save_search_config(username, {})   # 搜索引擎恢复默认（内置 Bing/Google）
        return jsonify({'success': True, 'scope': 'admin'})

    # 普通用户：清除与自身相关的所有数据
    path = user_data_file(username)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass

    settings = ensure_settings()
    settings['backgrounds'].pop(username, None)
    if isinstance(settings.get('search_engines'), dict):
        settings['search_engines'].pop(username, None)
    save_settings(settings)

    del users[username]
    save_users(users)

    # 会话失效
    token = get_token()
    if token:
        SESSIONS.pop(token, None)
    save_sessions()

    return jsonify({'success': True, 'scope': 'user'})


# ---------------------------------------------------------------- 前端静态页面
# 前后端打包在同一个容器里，由本服务直接提供页面与静态资源（同源，无需跨域）

def _static_response(filename):
    """
    返回静态文件，并按类型设置缓存策略：
      * HTML          -> 不缓存（保证每次都能拿到最新的脚本引用）
      * JS / CSS      -> 不缓存（本地部署，避免升级后仍用旧脚本导致功能异常）
      * 图片 / 字体    -> 强缓存 7 天（体积大且极少变动）
    """
    resp = send_from_directory(FRONTEND_DIR, filename)

    lower = filename.lower()
    if lower.endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf')):
        resp.headers['Cache-Control'] = 'public, max-age=604800'
    else:
        resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
    return resp


def _send_index():
    """
    返回前端首页。
    同时把 HTML 里的 JS/CSS 引用自动加上版本号（?v=<应用版本>），
    这样每次发版升级都会强制浏览器拉取新脚本，避免用到缓存里的旧版本。
    """
    if not os.path.isdir(FRONTEND_DIR):
        return jsonify({
            'error': '未找到前端目录',
            'hint': f'请确认 {FRONTEND_DIR} 存在，或用 NAV_FRONTEND_DIR 指定前端目录',
        }), 500

    index_path = os.path.join(FRONTEND_DIR, 'index.html')
    try:
        with open(index_path, 'r', encoding='utf-8') as f:
            html = f.read()
    except OSError as e:
        return jsonify({'error': f'读取首页失败: {e}'}), 500

    # 给 ./app.js 与 ./assets/**/*.js|css|ico 自动追加版本参数（已有 v= 的会替换）
    # favicon 也在列：更换图标后发版即可强制浏览器拉取新图标
    def _bust(m):
        quote, path = m.group(1), m.group(2)
        base = re.sub(r'\?v=[^"\']*$', '', path)
        return f'{quote}{base}?v={APP_VERSION}{quote}'

    html = re.sub(r'(?P<q>["\'])(\./(?:app\.js|assets/[^"\']+\.(?:js|css|ico)))(?:\?v=[^"\']*)?(?P=q)',
                  _bust, html)

    resp = app.response_class(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route('/', methods=['GET'])
def index():
    return _send_index()


# favicon 进程内缓存：{ mtime, data }。文件被替换（mtime 变化）时自动重新读取
_FAVICON_CACHE = {'mtime': None, 'data': None}


@app.route('/favicon.ico', methods=['GET'])
def favicon():
    """返回站点图标。文件较大（数百 KB），按 mtime 缓存在进程内，避免每次请求读盘"""
    path = os.path.join(FRONTEND_DIR, 'assets', 'favicon.ico')
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return jsonify({'error': '未找到 favicon.ico'}), 404

    if _FAVICON_CACHE['data'] is None or _FAVICON_CACHE['mtime'] != mtime:
        try:
            with open(path, 'rb') as f:
                _FAVICON_CACHE['data'] = f.read()
            _FAVICON_CACHE['mtime'] = mtime
        except OSError:
            return jsonify({'error': '读取 favicon.ico 失败'}), 500

    resp = app.response_class(_FAVICON_CACHE['data'], mimetype='image/x-icon')
    resp.headers['Cache-Control'] = 'public, max-age=604800'
    return resp


@app.route('/<path:filename>', methods=['GET'])
def static_files(filename):
    """
    提供前端静态资源（仅兜底，/api/* 已由更精确的路由优先匹配）
      * 真实存在的文件 -> 直接返回（含 Font Awesome 字体、样式、脚本等）
      * /api/xxx        -> 返回 JSON 404，避免误当成页面
      * 其它路径        -> 回退到 index.html（单页应用）
    """
    # API 路径不在此处渲染页面（防御性处理，正常不会走到这里）
    if filename == 'api' or filename.startswith('api/'):
        return _api_not_found()

    # 安全校验：禁止目录穿越
    normalized = os.path.normpath(filename).replace('\\', '/')
    if normalized.startswith('..') or os.path.isabs(normalized):
        return jsonify({'error': '非法的资源路径'}), 400

    target = os.path.join(FRONTEND_DIR, normalized)
    if os.path.isfile(target):
        return _static_response(normalized)

    # 回退到首页（前端为单页应用）
    return _send_index()


def _api_not_found():
    """统一的 API 404 响应，附带可用接口清单便于排查"""
    return jsonify({
        'error': '接口不存在',
        'path': request.path,
        'hint': '请确认请求的是后端服务地址（默认同一端口 /api/...）',
        'available': [
            'GET  /api/meta',
            'GET  /api/auth/status',
            'POST /api/login',
            'POST /api/logout',
            'GET  /api/config',
            'POST /api/config',
            'GET  /api/users',
            'POST /api/users',
            'PUT  /api/users/<username>',
            'DELETE /api/users/<username>',
            'GET  /api/settings',
            'POST /api/settings',
            'POST /api/data/clear',
        ],
    }), 404


# 404 统一处理：
#   * /api/*           -> JSON（永不返回 HTML，方便前端识别）
#   * 其它             -> 回退到前端首页（单页应用）
@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith('/api'):
        return _api_not_found()
    return _send_index()


# 405（方法不允许）也返回 JSON，便于前端区分
@app.errorhandler(405)
def handle_405(e):
    if request.path.startswith('/api'):
        return jsonify({
            'error': '请求方法不允许',
            'path': request.path,
            'method': request.method,
        }), 405
    return _send_index()


def bootstrap():
    """
    启动初始化：创建目录、迁移旧数据、创建默认管理员、恢复会话
    同时适用于 `python app.py` 与 WSGI 服务器（如 gunicorn）导入的场景
    返回当前账号表（供启动信息打印复用）
    """
    ensure_data_dirs()
    migrate_legacy_files()
    users = ensure_default_user()
    ensure_settings()
    load_sessions()   # 恢复上次的登录状态（重启后无需重新登录）
    return users


def print_startup_info(users=None):
    """启动时打印关键信息，便于排查「接口 404」类问题；users 由 bootstrap() 传入，避免重复读盘"""
    # Flask 会为同一接口的 GET/POST 各建一条路由规则，
    # 这里按路径分组合并方法，避免输出重复行
    grouped = {}
    for r in app.url_map.iter_rules():
        path = str(r)
        if not path.startswith('/api'):
            continue
        grouped.setdefault(path, set()).update(r.methods - {'HEAD', 'OPTIONS'})

    port = int(os.environ.get('PORT', 5000))

    # 仅当默认管理员仍在使用初始密码时才提示账号密码
    admin = (users if users is not None else load_users()).get(DEFAULT_USERNAME) or {}
    show_default_creds = bool(admin.get('must_change_password'))

    print('=' * 62)
    print(f' 个人导航中心 v{APP_VERSION}  ({APP_RELEASE_DATE})')
    print('=' * 62)
    print(f' 前端目录     : {FRONTEND_DIR}')
    print(f' 数据目录     : {DATA_DIR}')
    print(f' 登录验证     : {"已启用" if login_required_enabled() else "已关闭（免登录模式，使用公共配置）"}')
    print(f' 接口数量     : {len(grouped)} 个')
    for path in sorted(grouped):
        methods = ','.join(sorted(grouped[path]))
        print(f'   {methods:16s} {path}')
    print('-' * 62)
    print(f' 访问方式     : 浏览器打开 http://<本机IP>:{port}/')
    if show_default_creds:
        print(f' 默认管理员   : {DEFAULT_USERNAME} / {DEFAULT_PASSWORD}  （请尽快登录修改密码）')
    print('=' * 62)


if __name__ == '__main__':
    users = bootstrap()

    # 注意：不能使用 debug=True 的自动重载。
    # 本服务的运行数据都在 data/ 目录里，每次保存都会触发重载器重启服务，
    # 导致登录令牌被清空，表现为「页面一直在刷新 / 反复要求登录」。
    # 如需调试，请用 debug=True 但同时关闭 use_reloader：
    #   app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
    port = int(os.environ.get('PORT', 5000))
    print_startup_info(users)
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
else:
    # 通过 gunicorn 等 WSGI 服务器以 `app:app` 方式导入时也要完成初始化
    bootstrap()
