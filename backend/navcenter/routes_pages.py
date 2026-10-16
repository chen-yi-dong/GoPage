"""前端静态页面托管

前后端打包在同一个容器里，由本服务直接提供页面与静态资源（同源，无需跨域）。
路由规则：
  /               首页 index.html
  /favicon.ico    站点图标（按 mtime 做进程内缓存）
  /<path:...>     真实文件直接返回；其它路径回退到 index.html（单页应用）
"""
import os
import re

from flask import Blueprint, current_app, jsonify, request, send_from_directory

from .paths import APP_VERSION, FRONTEND_DIR

bp = Blueprint('pages', __name__)


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

    # 给 ./js/**/*.js 与 ./assets/**/*.js|css|ico 自动追加版本参数（已有 v= 的会替换）
    # favicon 也在列：更换图标后发版即可强制浏览器拉取新图标
    def _bust(m):
        quote, path = m.group(1), m.group(2)
        base = re.sub(r'\?v=[^"\']*$', '', path)
        return f'{quote}{base}?v={APP_VERSION}{quote}'

    html = re.sub(r'(?P<q>["\'])(\./(?:js|assets)/[^"\']+\.(?:js|css|ico))(?:\?v=[^"\']*)?(?P=q)',
                  _bust, html)

    resp = current_app.response_class(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@bp.route('/', methods=['GET'])
def index():
    return _send_index()


# favicon 进程内缓存：{ mtime, data }。文件被替换（mtime 变化）时自动重新读取
_FAVICON_CACHE = {'mtime': None, 'data': None}


@bp.route('/favicon.ico', methods=['GET'])
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

    resp = current_app.response_class(_FAVICON_CACHE['data'], mimetype='image/x-icon')
    resp.headers['Cache-Control'] = 'public, max-age=604800'
    return resp


@bp.route('/<path:filename>', methods=['GET'])
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


def handle_404(e):
    """404 统一处理：/api/* 返回 JSON，其它回退到前端首页（单页应用）"""
    if request.path.startswith('/api'):
        return _api_not_found()
    return _send_index()


def handle_405(e):
    """405（方法不允许）也返回 JSON，便于前端区分"""
    if request.path.startswith('/api'):
        return jsonify({
            'error': '请求方法不允许',
            'path': request.path,
            'method': request.method,
        }), 405
    return _send_index()
