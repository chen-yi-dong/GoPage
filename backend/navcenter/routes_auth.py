"""鉴权接口：登录状态 / 登录 / 登出"""
from flask import Blueprint, jsonify, request

from .paths import PUBLIC_USERNAME
from .security import create_session, current_user, destroy_session, get_token
from .services import (
    ensure_settings,
    get_background,
    get_search_config,
    load_users,
    public_user,
)
from .storage import no_cache
from .passwords import verify_password

bp = Blueprint('auth', __name__, url_prefix='/api')


@bp.route('/auth/status', methods=['GET'])
def auth_status():
    """前端启动时调用：是否需要登录、当前是否已登录、当前用户信息

    当「登录验证」关闭时，后端以「公共配置」身份提供服务
    （见 security.resolve_actor），这里也把该身份返回给前端，
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


@bp.route('/login', methods=['POST'])
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

    token = create_session(username)

    return jsonify({
        'success': True,
        'token': token,
        'user': public_user(username, record),
        'must_change_password': bool(record.get('must_change_password')),
        'background': get_background(username),
        'search': get_search_config(username),
    })


@bp.route('/logout', methods=['POST'])
def logout():
    destroy_session(get_token())
    return jsonify({'success': True})
