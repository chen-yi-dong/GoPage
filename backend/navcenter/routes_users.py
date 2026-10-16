"""用户管理接口：账号的增删改查

权限规则：
  * 查看/修改账号必须「真实登录」（免登录模式也不行，见 resolve_logged_in_actor）
  * 管理员可管理全部账号；普通用户只能修改自己的密码
"""
import datetime
import os

from flask import Blueprint, jsonify, request

from .paths import USERNAME_PATTERN
from .passwords import hash_password
from .security import (
    drop_user_sessions,
    rename_user_in_sessions,
    resolve_logged_in_actor,
)
from .services import (
    ensure_settings,
    load_users,
    public_user,
    save_settings,
    save_user_config,
    save_users,
    user_data_file,
)
from .storage import no_cache

bp = Blueprint('users', __name__, url_prefix='/api')


@bp.route('/users', methods=['GET'])
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


@bp.route('/users', methods=['POST'])
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


@bp.route('/users/<username>', methods=['PUT'])
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

            # 会话令牌指向新用户名（重命名不需要重新登录）
            rename_user_in_sessions(username, new_name)

            username = new_name
            changed = True

    if changed:
        save_users(users)

    return jsonify({'success': True, 'user': public_user(username, users[username])})


@bp.route('/users/<username>', methods=['DELETE'])
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
    drop_user_sessions(username)

    return jsonify({'success': True})
