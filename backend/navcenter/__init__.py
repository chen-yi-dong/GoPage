"""应用工厂：创建 Flask 实例并组装各模块

模块划分（自底向上）：
  paths.py       路径与常量（无依赖）
  storage.py     JSON 文件存取（无依赖）
  passwords.py   密码单向加密（无依赖）
  services.py    业务逻辑：用户 / 设置 / 背景 / 搜索引擎 / 导航数据
  security.py    会话与身份：登录令牌、当前操作者解析
  routes_*.py    路由层：只负责把 HTTP 请求翻译成 services/security 调用
  bootstrap.py   启动初始化（直接运行与被 gunicorn 导入时都会执行）
"""
from flask import Flask, g, redirect, request
from flask_cors import CORS

from . import (
    routes_auth,
    routes_config,
    routes_data,
    routes_meta,
    routes_pages,
    routes_settings,
    routes_users,
)
from .storage import DATA_LOCK


def create_app():
    """创建并组装应用（应用工厂模式，便于测试与扩展）"""
    app = Flask(__name__, static_folder=None)

    # 允许跨域：便于本地开发时前端独立运行；同源部署下不影响
    CORS(app)

    # 数据全部以 JSON 文件持久化，setter 都是「读-改-写」且无事务：
    # 用一把进程内锁把 /api 请求串行化，避免多线程并发写互相覆盖，
    # 也避免 json.dump 遍历 SESSIONS 期间被其他线程修改。
    # 静态资源请求不进 /api，不受影响。此锁依赖 --workers 1（单进程）。
    @app.before_request
    def lock_data_access():
        if request.path.startswith('/api/'):
            g._data_lock_held = True
            DATA_LOCK.acquire()

    @app.teardown_request
    def unlock_data_access(_exc):
        if getattr(g, '_data_lock_held', False):
            g._data_lock_held = False
            DATA_LOCK.release()

    # 重要：关闭 JSON 键排序，否则 jsonify 会按 Unicode 重新排列分组顺序，
    # 导致拖动排序保存后刷新页面分组顺序又被打乱
    app.json.sort_keys = False

    # 注册各蓝图（API 路由统一带 /api 前缀，页面路由不带）
    for blueprint in (
        routes_meta.bp,
        routes_auth.bp,
        routes_config.bp,
        routes_users.bp,
        routes_settings.bp,
        routes_data.bp,
        routes_pages.bp,
    ):
        app.register_blueprint(blueprint)

    # 兼容接口路径的尾斜杠：/api/meta/ 与 /api/meta 视为同一个接口，
    # 避免因前端多写一个 '/' 而落到静态路由上变成 404
    @app.before_request
    def normalize_api_path():
        if request.path.startswith('/api/') and request.path.endswith('/') and len(request.path) > 5:
            return redirect(request.path.rstrip('/'), code=308)

    # 404 / 405 统一处理：API 返回 JSON，其它路径回退到前端首页（单页应用）
    app.register_error_handler(404, routes_pages.handle_404)
    app.register_error_handler(405, routes_pages.handle_405)

    return app
