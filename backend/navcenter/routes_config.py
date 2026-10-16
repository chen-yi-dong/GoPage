"""导航配置接口：读取 / 保存当前账号的导航数据

数据结构：{ 分组名: [ {name, url, icon}, ... ], ... }
分组顺序即 JSON 键顺序（前端依赖它做拖动排序）。
"""
from flask import Blueprint, jsonify, request

from .security import resolve_actor
from .services import load_user_config, save_user_config
from .storage import no_cache

bp = Blueprint('config', __name__, url_prefix='/api')


@bp.route('/config', methods=['GET'])
def get_config():
    """读取当前账号的导航配置"""
    username, _user, err = resolve_actor()
    if err:
        return err
    try:
        return no_cache(jsonify(load_user_config(username)))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/config', methods=['POST'])
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
