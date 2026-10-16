"""清空数据接口（危险操作，需二次确认 + 输入账号密码）"""
import os

from flask import Blueprint, jsonify, request

from .passwords import verify_password
from .security import destroy_session, get_token, resolve_actor
from .services import (
    ensure_settings,
    load_users,
    save_search_config,
    save_settings,
    save_user_config,
    save_users,
    set_background,
    user_data_file,
)

bp = Blueprint('data', __name__, url_prefix='/api')


@bp.route('/data/clear', methods=['POST'])
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
    destroy_session(get_token())

    return jsonify({'success': True, 'scope': 'user'})
