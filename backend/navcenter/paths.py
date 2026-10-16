"""路径与全局常量

把散落在各处的「魔法值」集中到一个模块：
换数据目录、换端口、发新版本，都只需要改这里。
"""
import os
import re

# ---------------------------------------------------------------- 路径
PKG_DIR = os.path.abspath(os.path.dirname(__file__))        # backend/navcenter
BACKEND_DIR = os.path.abspath(os.path.join(PKG_DIR, '..'))  # backend

# 前端静态资源目录（与后端一起打包进同一个镜像/容器）
#   * Docker 中为 /app/frontend
#   * 本地开发时为本项目根目录下的 frontend
FRONTEND_DIR = os.environ.get('NAV_FRONTEND_DIR') or os.path.join(BACKEND_DIR, 'frontend')
if not os.path.isdir(FRONTEND_DIR):
    _sibling = os.path.abspath(os.path.join(BACKEND_DIR, '..', 'frontend'))
    if os.path.isdir(_sibling):
        FRONTEND_DIR = _sibling

# 所有需要持久化的数据统一放在 data/ 下，便于 Docker 挂载卷（重启不丢数据）
#   data/
#     ├── users.json         账号表（仅密码摘要，无明文）
#     ├── settings.json      全局设置 + 各账号界面设置（背景、搜索引擎等）
#     ├── sessions.json      登录令牌（重启后仍保持登录）
#     └── nav/<用户名>.json  每个账号的导航数据
DATA_DIR = os.environ.get('NAV_DATA_DIR') or os.path.join(BACKEND_DIR, 'data')
NAV_DIR = os.path.join(DATA_DIR, 'nav')

USERS_FILE = os.path.join(DATA_DIR, 'users.json')
SETTINGS_FILE = os.path.join(DATA_DIR, 'settings.json')
SESSIONS_FILE = os.path.join(DATA_DIR, 'sessions.json')

# 旧版导航数据目录（导航文件曾直接放在 data/ 下），用于一次性迁移
LEGACY_NAV_DIR = DATA_DIR

# ---------------------------------------------------------------- 应用信息
APP_NAME = '个人导航中心'
APP_VERSION = '1.0.13'
APP_RELEASE_DATE = '2026-09-20'
DEFAULT_PORT = 5000

# ---------------------------------------------------------------- 账号
DEFAULT_USERNAME = 'admin'
DEFAULT_PASSWORD = 'admin123'

# 免登录模式使用的「公共配置」伪账号名。
# 它不是一个真实账号（不会出现在用户表里），只用来定位 data/nav/_public.json，
# 这样免登录模式下改动的数据不会与任何真实账号的数据混在一起。
PUBLIC_USERNAME = '_public'

PBKDF2_ITERATIONS = 200_000                                    # 密码哈希迭代次数
USERNAME_PATTERN = re.compile(r'^[A-Za-z0-9_\u4e00-\u9fa5-]{1,32}$')
SESSION_MAX_AGE = 30 * 24 * 3600                               # 登录令牌有效期（秒）

# ---------------------------------------------------------------- 界面设置
DEFAULT_BG_SCRIM = 30        # 背景遮罩默认浓度（%），设置页可调 0-80

# 内置搜索引擎（{kw} 为关键词占位符，搜索时替换为 URL 编码后的关键词）
BUILTIN_SEARCH_ENGINES = [
    {'id': 'bing', 'name': 'Bing', 'url': 'https://www.bing.com/search?q={kw}'},
    {'id': 'google', 'name': 'Google', 'url': 'https://www.google.com/search?q={kw}'},
]
MAX_SEARCH_ENGINES = 12      # 每个账号最多可保存的搜索引擎数量
