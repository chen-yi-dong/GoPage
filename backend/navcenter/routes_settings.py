"""设置接口：登录验证开关、账号背景、搜索引擎

背景与搜索引擎都是「每个账号独立」的；登录验证开关是全局的（仅管理员可改）。
"""
import re
import secrets

from flask import Blueprint, jsonify, request

from .paths import DEFAULT_BG_SCRIM, MAX_SEARCH_ENGINES
from .security import resolve_actor
from .services import (
    ensure_settings,
    get_background,
    get_search_config,
    save_search_config,
    save_settings,
    set_background,
)
from .storage import no_cache

bp = Blueprint('settings', __name__, url_prefix='/api')


@bp.route('/settings', methods=['GET'])
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


@bp.route('/settings', methods=['POST'])
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
