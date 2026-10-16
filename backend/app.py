"""入口文件

两种启动方式：
  * 直接运行：python app.py        （本地开发）
  * 生产部署：gunicorn app:app     （Docker 默认，见 Dockerfile）

两者都会在导入本模块时执行 bootstrap() 完成初始化。
"""
import os

from navcenter import create_app
from navcenter.bootstrap import bootstrap, print_startup_info
from navcenter.paths import DEFAULT_PORT

app = create_app()
users = bootstrap()   # 被 gunicorn 以 `app:app` 导入时也会执行，保证数据就绪

if __name__ == '__main__':
    port = int(os.environ.get('PORT', DEFAULT_PORT))
    print_startup_info(app, users)

    # 注意：不能使用 debug=True 的自动重载。
    # 本服务的运行数据都在 data/ 目录里，每次保存都会触发重载器重启服务，
    # 导致登录令牌被清空，表现为「页面一直在刷新 / 反复要求登录」。
    # 如需调试，请用 debug=True 但同时关闭 use_reloader：
    #   app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
    app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
