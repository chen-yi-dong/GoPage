"""启动初始化与启动信息打印

bootstrap() 在「直接运行」和「被 gunicorn 导入」时都会执行，
保证两种方式下数据目录、默认账号、会话都已就绪。
"""
import os

from .paths import (
    APP_NAME,
    APP_RELEASE_DATE,
    APP_VERSION,
    DATA_DIR,
    DEFAULT_PASSWORD,
    DEFAULT_PORT,
    DEFAULT_USERNAME,
    FRONTEND_DIR,
)
from .security import load_sessions
from .services import (
    ensure_data_dirs,
    ensure_default_user,
    ensure_settings,
    login_required_enabled,
    migrate_legacy_files,
)


def bootstrap():
    """创建目录、迁移旧数据、创建默认管理员、恢复会话；返回当前账号表"""
    ensure_data_dirs()
    migrate_legacy_files()
    users = ensure_default_user()
    ensure_settings()
    load_sessions()   # 恢复上次的登录状态（重启后无需重新登录）
    return users


def print_startup_info(app, users=None):
    """启动时打印关键信息，便于排查「接口 404」类问题；users 由 bootstrap() 传入，避免重复读盘"""
    # Flask 会为同一接口的 GET/POST 各建一条路由规则，
    # 这里按路径分组合并方法，避免输出重复行
    grouped = {}
    for r in app.url_map.iter_rules():
        path = str(r)
        if not path.startswith('/api'):
            continue
        grouped.setdefault(path, set()).update(r.methods - {'HEAD', 'OPTIONS'})

    port = int(os.environ.get('PORT', DEFAULT_PORT))

    # 仅当默认管理员仍在使用初始密码时才提示账号密码
    admin = (users if users is not None else {}).get(DEFAULT_USERNAME) or {}
    show_default_creds = bool(admin.get('must_change_password'))

    print('=' * 62)
    print(f' {APP_NAME} v{APP_VERSION}  ({APP_RELEASE_DATE})')
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
