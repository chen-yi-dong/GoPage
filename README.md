# 个人导航中心（GoPage）

![Docker Build](https://github.com/chen-yi-dong/GoPage/actions/workflows/docker-image.yml/badge.svg)

一个前后端一体的个人导航页：多用户、登录鉴权、拖动排序、可换搜索引擎、每账号独立背景。
后端 Flask + 前端原生 ES Module，**没有任何构建步骤**，clone 下来就能跑，适合阅读学习。

## 功能特性

- **多用户**：每个账号拥有独立的导航数据、背景与搜索引擎配置
- **账号安全**：密码 PBKDF2-HMAC-SHA256 + 随机盐单向存储，接口永不返回密码或哈希
- **权限模型**：管理员可管理全部账号；普通用户只能改自己密码；系统始终保留至少一个管理员
- **免登录模式**：关闭登录验证后，以独立的「公共配置」身份使用，与任何账号数据隔离
- **拖动排序**：Pointer Events + 占位块实时预览 + FLIP 动画，卡片可跨分组拖拽
- **图标选择器**：内置 2000+ Font Awesome 图标，支持中文模糊搜索、滚动分页
- **可换搜索引擎**：内置 Bing / Google，可自定义（`{kw}` 占位符），按账号保存
- **每账号背景**：默认渐变 / 纯色 / 图片 + 遮罩浓度（0-80%），内容面板可联动

## 快速开始

### 本地开发

```bash
cd backend
pip install -r requirements.txt
python app.py          #  http://127.0.0.1:5000
```

首次启动自动创建默认管理员 **admin / admin123**（会提示尽快修改）。
前端由后端同源托管，浏览器直接访问上面的地址即可。

### Docker 部署（推荐）

```bash
docker compose up -d --build
```

数据持久化在 `./data`（users.json / settings.json / sessions.json / nav/*.json），
容器重建、镜像升级都不丢数据。健康检查见 `docker-compose.yml`。

### 使用自动构建的镜像（免本地构建）

代码推送到 GitHub 后，Actions 会自动构建镜像并发布到 ghcr.io，
服务器上无需 clone 代码、无需构建，直接拉镜像运行：

```bash
docker pull ghcr.io/chen-yi-dong/gopage:latest
docker run -d --name personal-nav --restart unless-stopped \
  -p 5000:5000 -v ./data:/app/data \
  ghcr.io/chen-yi-dong/gopage:latest
```

也可以改 `docker-compose.yml`：把 `build: .` 和 `image: personal-nav:1.0.0`
两行注释掉，改用 `image: ghcr.io/chen-yi-dong/gopage:latest`。

## 自动构建与发布（GitHub Actions）

工作流定义在 `.github/workflows/docker-image.yml`，**零配置**——
推送即构建，使用 Actions 自带的 `GITHUB_TOKEN`，不需要配任何 Secret。

| 触发方式 | 行为 | 产生的镜像标签 |
| --- | --- | --- |
| push 到 `main` | 构建 + 推送 | `latest`、`main`、`sha-xxxxxx` |
| push tag（`v1.0.14`） | 构建 + 推送 | `1.0.14`、`1.0`、`sha-xxxxxx` |
| Pull Request | 只构建不推送（验证 Dockerfile 没坏） | 无 |
| Actions 页面手动 Run | 构建 + 推送 | 同上 |

发布新版本的推荐流程：

```bash
git tag v1.0.14 && git push origin v1.0.14
```

镜像为多架构（`linux/amd64` + `linux/arm64`），x86 服务器、树莓派、
ARM NAS（群晖等）都可以直接拉取。

> **注意：ghcr.io 的包默认是私有。** 第一次构建完成后，到
> Packages 页面（`github.com/users/chen-yi-dong/packages` 或仓库右侧 Packages）
> 把 GoPage 的 Visibility 改成 **Public**，否则拉镜像需要先 `docker login ghcr.io`。

## 项目结构

```
GoPage/
├── backend/
│   ├── app.py                  # 入口（很薄）：create_app + bootstrap + app.run
│   ├── requirements.txt
│   └── navcenter/              # 后端全部逻辑，一个模块一个职责
│       ├── paths.py            #   路径与常量（数据目录、版本号、默认账号…）
│       ├── storage.py          #   JSON 原子读写 + 不缓存响应头
│       ├── passwords.py        #   密码单向加密（PBKDF2 + 恒定时间比较）
│       ├── services.py         #   业务逻辑：用户/设置/背景/搜索引擎/导航数据
│       ├── security.py         #   会话与身份：登录令牌、当前操作者解析
│       ├── routes_meta.py      #   GET  /api/meta
│       ├── routes_auth.py      #   登录状态 / 登录 / 登出
│       ├── routes_config.py    #   导航配置读写
│       ├── routes_users.py     #   用户管理（增删改查 + 权限校验）
│       ├── routes_settings.py  #   设置（登录开关 / 背景 / 搜索引擎）
│       ├── routes_data.py      #   清空数据（二次确认）
│       ├── routes_pages.py     #   前端静态页面托管 + SPA 回退 + 404/405
│       └── bootstrap.py        #   启动初始化 + 启动信息打印
├── frontend/
│   ├── index.html              # 页面骨架（各弹窗 / 设置页结构）
│   ├── js/                     # 前端 ES Module（浏览器原生，无构建）
│   │   ├── main.js             #   入口：组装各模块 + 启动流程
│   │   ├── state.js            #   全局状态（唯一共享可变状态）
│   │   ├── utils.js            #   DOM 简写 / 转义 / toast / 按钮置灰
│   │   ├── api.js              #   fetch 封装 + 错误诊断页
│   │   ├── filter.js           #   站内服务过滤
│   │   ├── render.js           #   渲染 config -> DOM
│   │   ├── webSearch.js        #   网页搜索 + 搜索引擎管理
│   │   ├── dnd.js              #   拖动排序（Pointer Events + FLIP）
│   │   ├── iconPicker.js       #   图标选择器
│   │   ├── modal.js            #   卡片/分组编辑弹窗
│   │   ├── editor.js           #   数据层 + 增删改 + 编辑工具栏
│   │   ├── background.js       #   背景与遮罩
│   │   ├── account.js          #   当前身份同步与展示
│   │   ├── auth.js             #   登录/登出/登录验证开关
│   │   ├── users.js            #   账号管理
│   │   ├── settings.js         #   设置弹窗
│   │   └── clearData.js        #   清空数据
│   └── assets/                 # Font Awesome、style.css、icons.js（图标数据）
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
└── .github/
    └── workflows/
        └── docker-image.yml   # GitHub Actions：推送自动构建多架构镜像
```

## 后端设计要点（适合学习的地方）

1. **应用工厂 + 蓝图**：`create_app()` 组装应用，每个 `routes_*.py` 一个蓝图，
   API 蓝图统一挂 `/api` 前缀；这样「加一个接口」= 新建一个模块 + 注册一行。
2. **分层清晰**：路由层只做 HTTP 翻译（`request` → 调用 → `jsonify`），
   规则全在 `services.py`，安全相关（哈希/会话/身份）在 `security.py` 与 `passwords.py`。
3. **写入安全**：`storage.write_json` 先写临时文件再 `os.replace` 原子替换，
   写入中断不会留下半个 JSON；密码用 PBKDF2 20 万次迭代 + 恒定时间比较。
4. **会话设计**：令牌在内存字典中，同时持久化到 `sessions.json`——
   配合 Docker 里的 `gunicorn --workers 1`，重启服务登录状态不丢失。
5. **两种「操作者」**：`resolve_actor`（读数据，免登录模式回落到公共配置）与
   `resolve_logged_in_actor`（管账号，必须真实登录），权限边界一目了然。
6. **数据目录即状态**：`data/` 是唯一持久化目录，Docker 只挂载它；
   `bootstrap()` 在直接运行和被 gunicorn 导入时都会执行，幂等可重跑。

## 前端设计要点

1. **ES Module 零构建**：`<script type="module">` 浏览器原生支持，
   模块间用 `import/export`，`state.js` 是唯一共享状态对象——
   告别全局变量满天飞，依赖方向自底向上、**无循环依赖**。
2. **只导出必要的 API**：模块内部用的函数不 export，导出即契约。
3. **XSS 防护**：所有拼进 `innerHTML` 的用户数据都过 `escapeHtml()`。
4. **拖动排序**（`dnd.js`，全文最巧的一段）：
   - 占位块实时反映落点，其他卡片被「挤开」并用 FLIP 动画平滑过渡；
   - 槽位判定带滞回（指针在同一间隙内不触发任何 DOM 变动）；
   - 结束时按「真实 DOM 顺序」重建数据，不做脆弱的下标推算。
5. **编辑模式不写 href**：从根本上避免拖拽结束被浏览器当成点击而跳转刷新。
6. **统一的「按钮置灰 + 原因」**：`setButtonUnavailable` / `guardUnavailable`，
   不可用的按钮点击时会告诉用户为什么。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 版本信息（前端启动时探测后端） |
| GET | `/api/auth/status` | 是否需要登录 / 当前身份 / 背景 / 搜索引擎 |
| POST | `/api/login` | 登录，返回令牌 |
| POST | `/api/logout` | 登出，注销令牌 |
| GET | `/api/config` | 读取当前账号导航配置 |
| POST | `/api/config` | 保存当前账号导航配置 |
| GET | `/api/users` | 用户列表（管理员看全部） |
| POST | `/api/users` | 新增账号（管理员） |
| PUT | `/api/users/<username>` | 改密码 / 权限 / 用户名（含数据迁移） |
| DELETE | `/api/users/<username>` | 删除账号（管理员，连带数据） |
| GET | `/api/settings` | 读取设置 |
| POST | `/api/settings` | 登录开关（管理员）/ 背景 / 搜索引擎 |
| POST | `/api/data/clear` | 清空数据（需二次输入账号密码） |

## 常见问题

**Q：启动时提示 `WARNING: This is a development server...`？**
A：这是 Flask 内置开发服务器的提示。本地 `python app.py` 开发时忽略即可；
   Docker 部署用的是 gunicorn（生产级 WSGI 服务器），不会有这个提示。
   想本地也消除它：`gunicorn --bind 0.0.0.0:5000 --workers 1 --threads 8 app:app`。

**Q：为什么 `app.run()` 里 `debug=True` 也不能用自动重载？**
A：运行数据都在 `data/` 目录，每次保存都会触发重载器重启服务，
   导致登录令牌被清空，表现为页面反复要求登录。调试请用
   `app.run(debug=True, use_reloader=False)`。

**Q：数据存放在哪？会丢吗？**
A：全部在 `backend/data/`（Docker 中为挂载卷 `/app/data`）。
   用户表只存密码摘要；导航数据一人一个 JSON 文件；重启不丢登录状态。

**Q：忘了管理员密码怎么办？**
A：停止服务，删除 `data/users.json` 后重启，会重新生成默认 admin/admin123
   （该账号下的导航数据文件仍在，不会被删）。
