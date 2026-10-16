# ============================================================
# 个人导航中心 - 前后端一体镜像
# 前端静态资源 + Flask 后端打包在同一个容器，由同一端口提供服务
# 构建：docker build -t personal-nav:1.0.0 .
# ============================================================
FROM python:3.12-slim

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NAV_DATA_DIR=/app/data \
    NAV_FRONTEND_DIR=/app/frontend

WORKDIR /app

# 先安装依赖，充分利用 Docker 层缓存
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# 后端代码：入口 app.py + navcenter 包（见 backend/navcenter/ 各模块）
COPY backend/app.py ./app.py
COPY backend/navcenter ./navcenter

# 前端静态资源（含 Font Awesome 字体、图标数据、样式与 ES Module 脚本）
COPY frontend/ ./frontend/

# 数据目录（运行时通过 volume 挂载持久化）
RUN mkdir -p /app/data/nav
VOLUME ["/app/data"]

EXPOSE 5000

# 单进程多线程：保证内存中的会话状态一致（会话同时已持久化到 data/sessions.json）
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "8", "--timeout", "120", "app:app"]
