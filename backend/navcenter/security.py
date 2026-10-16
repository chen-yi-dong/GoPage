"""会话与身份：登录令牌、当前操作者解析

设计要点：
  * 会话放在内存字典 SESSIONS 中，同时持久化到 sessions.json——
    单进程部署（gunicorn --workers 1）下重启服务登录状态不丢失；
  * 「当前操作者」分两档：
      resolve_actor          读/写导航数据用，免登录模式回落到公共配置
      resolve_logged_in_actor 账号管理用，必须真实登录
"""
import datetime
import secrets

from flask import jsonify, request

from .paths import (
    PUBLIC_USERNAME,
    SESSIONS_FILE,
    SESSION_MAX_AGE,
)
from .services import load_users, login_required_enabled
from .storage import read_json, write_json

# 登录令牌表：token -> { username, created_at }
SESSIONS = {}


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
        except (ValueError, AttributeError):
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


def create_session(username):
    """签发一个新登录令牌并持久化"""
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {
        'username': username,
        'created_at': datetime.datetime.now().isoformat(timespec='seconds'),
    }
    save_sessions()
    return token


def destroy_session(token):
    """注销单个令牌"""
    if token:
        SESSIONS.pop(token, None)
        save_sessions()


def rename_user_in_sessions(old_username, new_username):
    """用户被重命名后，把其会话令牌指向新用户名"""
    changed = False
    for sess in SESSIONS.values():
        if sess['username'] == old_username:
            sess['username'] = new_username
            changed = True
    if changed:
        save_sessions()


def drop_user_sessions(username):
    """删除用户后，使其所有登录令牌失效"""
    tokens = [tk for tk, sess in SESSIONS.items() if sess['username'] == username]
    for tk in tokens:
        SESSIONS.pop(tk, None)
    if tokens:
        save_sessions()


def get_token():
    """从请求头取登录令牌：Authorization: Bearer <token> 或 X-Auth-Token"""
    auth = request.headers.get('Authorization', '')
    if auth.startswith('Bearer '):
        return auth[7:].strip()
    return request.headers.get('X-Auth-Token', '').strip()


def current_user():
    """返回 (username, user_record)；未登录返回 (None, None)"""
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


def resolve_actor():
    """解析当前操作者（读数据 / 写数据用）

      * 启用登录验证 -> 必须携带有效 token
      * 关闭登录验证 -> 未登录时按「公共配置」处理（PUBLIC_USERNAME）

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
    """解析当前操作者（账号管理专用）：必须「真实登录」

    免登录模式（login_required=False）下即使后端会回退到公共配置，
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
