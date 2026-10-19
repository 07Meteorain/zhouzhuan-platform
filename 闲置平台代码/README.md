# 公共资产闲**置平台**

**部门用户在公共资产闲置平台**上以「发布者 + 领取者」双重身份发布与认领真实闲置资产；管理员在后台管架构、核验图片、留痕与统计；平台作为共享池集中展示与流转。

技术栈（固定）：**FastAPI + SQLite** ／ **原生 HTML + Tailwind（CDN，无构建）** ／ 图片本地文件存储 ／ **docker compose 一键拉起** ／ JWT 登录。

---

## 一、一键启动命令与访问地址

提供**两套启动方式**，任选其一，功能完全一致。

### 方式 A：免 Docker 一键脚本（无需安装 Docker，推荐本机验收）

```bash
# Windows：双击 start.bat，或在命令行执行
start.bat          # 启动
stop.bat           # 停止

# Linux / macOS / Git Bash
./start.sh         # 启动
./stop.sh          # 停止
```

脚本自动完成：创建 `.venv` 虚拟环境 → 安装后端依赖 → 从 `.env.example` 生成 `.env` → 启动后端 8000 与前端 3000 → 自动打开浏览器。首次执行约需 1–3 分钟（主要耗时在装依赖）。

### 方式 B：Docker Compose（适合交给运维/上服务器）

```bash
# 进入项目根目录（含 docker-compose.yml）
cd 闲置平台代码

# 首次构建并启动（自动建表 + 注入种子数据）
docker compose up --build

# 后台启动
docker compose up -d --build

# 停止
docker compose down

# 清空数据重新启动（会删除 database/data 下的库与图片）
# docker compose down && rm -rf database/data && docker compose up --build
```

> **注意**：Docker 场景下**不要**复制 `.env`，`docker-compose.yml` 已内置容器内路径（`/app/data`）并挂载卷；`.env` 只服务于方式 A。  
> `config.py` 中的路径默认值指向仓库内 `database/data`，因此不配置任何环境变量也能直接跑起来。

| 服务   | 地址                                      | 说明                                                              |
| ---- | --------------------------------------- | --------------------------------------------------------------- |
| 前端站点 | <http://localhost:3000>                 | 登录页 `/index.html`，部门用户 `/user/home.html`，管理员 `/admin/orgs.html` |
| 后端接口 | <http://localhost:8000>                 | Swagger 文档 <http://localhost:8000/docs>                         |
| 健康检查 | <http://localhost:8000/api/health>      | 返回数据库与上传目录配置                                                    |
| 图片访问 | <http://localhost:3000/uploads/xxx.png> | 由 nginx 反代到后端静态目录                                               |

> 环境变量见 `.env.example`（方式 A 用）：`DATABASE_PATH` 数据库路径、`UPLOAD_DIR` 上传目录、`SECRET_KEY` 会话密钥。  
> 相对路径按**仓库根目录**解析；不配置则用 `config.py` 默认值（`database/data/` 下），开箱即用。

### 手动分步启动（排障时用，等价于一键脚本）

```bash
# 后端：在 backend/ 目录下执行（app 包需可被导入）
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000

# 前端：在仓库根目录执行，自动把 /api 与 /uploads 反代到 8000
python tools/dev_server.py --port 3000 --backend http://127.0.0.1:8000
```

---

## 二、测试账号

| 账号       | 口令       | 角色    | 所属组织                     |
| -------- | -------- | ----- | ------------------------ |
| `user1`  | `123456` | 部门用户  | 智能制造学院 / 实训中心（工号 20156）  |
| `user2`  | `123456` | 部门用户  | 信息技术学院 / 网络运维部（工号 30208） |
| `admin1` | `123456` | 平台管理员 | 不参与发布与认领                 |

种子数据：2 个专业学院（各 2 个下设部门，共 4 个）、3 条已上架闲置物资、1 条已被领走（`ZC-2026-004`，剩余 0 自动下架）、1 条已完成认领流转记录（含交接单号 `JJ<日期>0001`）。种子图片来自 `database/seed_images/` 的真实照片，导入时自动叠加「部门 + 资产编号 + 时间」水印。

> 演示认领链路建议：用 `user1` 认领 `user2` 部门（`信息技术学院 / 网络运维部`）发布的物资，或反之；系统禁止认领本部门发布的物资。

---

## 三、功能地图（角色 → 页面 / 路由）

### 部门用户（`/user/*.html`）

| 页面        | 路由文件                      | 关键功能                                                          | 主要接口                                                                                                                           |
| --------- | ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 登录        | `/index.html`             | 账号口令登录、测试账号一键填充                                               | `POST /api/auth/login`                                                                                                         |
| 首页        | `/user/home.html`         | 顶部显示「学院 + 下设部门」；切换「我的发布 / 我的认领」；下架 / 重新挂牌                     | `GET /api/auth/me`、`GET /api/assets/mine`、`GET /api/claims/mine`、`POST /api/assets/{id}/unlist`、`POST /api/assets/{id}/relist` |
| 发布物资      | `/user/publish.html`      | 学院 → 部门两级联动；资产编号唯一校验；多图上传（拍照/相册）；提交即上架                        | `GET /api/colleges`、`POST /api/assets`                                                                                         |
| 平台浏览 / 搜索 | `/user/browse.html`       | 卡片展示编号、名称、剩余、存放地点、管理部门；按名称/编号/分类/学院/部门/管理部门/存放地点/状态/剩余范围搜索与排序 | `GET /api/assets`、`GET /api/colleges`、`GET /api/assets/meta/options`                                                           |
| 物资详情 + 认领 | `/user/asset.html?id=`    | 图片说明卡片（在哪儿/长什么样/什么尺寸/有多少个/成色）；全部字段；流转记录；认领（接收 → 确认）           | `GET /api/assets/{id}`、`POST /api/claims`、`POST /api/handovers`                                                                |
| 交接单       | `/user/handover.html?no=` | 单号、转出/转入部门、接收人、资产信息、签字栏；**服务端导出 Word / PDF**；`window.print()` 打印并记录日志 | `GET /api/handovers/{no}`、`GET /api/handovers/{no}/export?format=docx｜pdf`、`POST /api/handovers/{no}/print`                                                                     |
| 我的记录      | `/user/records.html`      | 转出 / 转入历史、交接单查询、导出 CSV、打印                                     | `GET /api/claims/mine`、`GET /api/handovers`                                                                                    |

### 平台管理员（`/admin/*.html`）

| 页面      | 路由文件                 | 关键功能                                    | 主要接口                                                                                                                                                                   |
| ------- | -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 组织机构管理  | `/admin/orgs.html`   | 学院 / 部门 新增、改名、启用停用、删除；停用后物资停止挂牌         | `GET /api/colleges`、`POST/PUT/DELETE /api/admin/colleges[/{id}]`、`POST/PUT/DELETE /api/admin/departments[/{id}]`                                                       |
| 用户与工号管理 | `/admin/users.html`  | 账号、工号、姓名、学院/部门维护；查询、新增、修改、停用            | `GET/POST /api/admin/users`、`PUT /api/admin/users/{id}`、`POST /api/admin/users/{id}/status`                                                                            |
| 物资管理    | `/admin/assets.html` | 全量查看；**修正异常物资**（改编号/数量/各字段/状态，逐字段留痕）；强制下架；重新挂牌；图片真实性核验与驳回/恢复；**撤销认领**（数量自动恢复） | `GET /api/admin/assets`、`PUT /api/admin/assets/{id}`、`POST /api/admin/assets/{id}/force-off`、`POST /api/admin/assets/{id}/relist`、`POST /api/admin/assets/{id}/images/{image_id}/reject`、`/restore`、`GET /api/claims?asset_id=`、`POST /api/claims/{id}/revoke` |
| 日志中心    | `/admin/logs.html`   | 发布/修改/下架/认领/撤销/图片/组织/用户/交接单生成·打印·导出日志；只可查看与导出，不可删除 | `GET /api/admin/logs`、`GET /api/admin/logs/types`、`GET /api/admin/logs/export`                                                                                         |
| 统计报表    | `/admin/stats.html`  | 总览指标、按资产统计、按部门间调动统计、导出 CSV              | `GET /api/admin/stats/overview`、`/assets`、`/departments`、`/export`                                                                                                     |

### 公共资产闲置平台（共享池）

集中展示全部上架物资、搜索、发布入口、认领入口、数量流转（总数 − 已认领 = 剩余，归零自动下架）、流转记录公开、下架/再上架、仅展示通过真实性规则的图片。

---

## 四、二次开发指南

### 4.1 目录结构

```
闲置平台代码/
├── start.bat / stop.bat      # 免 Docker 一键启停（Windows）
├── start.sh  / stop.sh       # 免 Docker 一键启停（Linux / macOS / Git Bash）
├── docker-compose.yml        # 一键编排（前端 3000 / 后端 8000）
├── .env.example              # 数据库路径、上传目录、Session 密钥
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py           # 应用入口：建表 + 自动注入种子 + 注册路由
│       ├── config.py         # 环境变量与全局配置（路径、密钥、上传限制）
│       ├── database.py       # engine / SessionLocal / get_db
│       ├── models.py         # 8 张表 ORM，字段带中文注释
│       ├── schemas.py        # 入参/出参 Pydantic 模型
│       ├── auth.py           # 口令哈希（PBKDF2）+ JWT 签发/解析
│       ├── deps.py           # 登录守卫、管理员校验、日志工具、序列化
│       ├── image_util.py     # 图片真实性校验 + 水印
│       ├── export_util.py    # 交接单服务端导出：build_docx() / build_pdf()
│       └── routers/
│           ├── auth.py       # 登录 / 当前用户 / 退出
│           ├── orgs.py       # 学院、部门（公开查询 + 管理员管理）
│           ├── users.py      # 用户与工号管理
│           ├── assets.py     # 发布 / 浏览搜索 / 详情 / 改 / 上下架 / 图片
│           ├── claims.py     # 认领 / 流转记录 / 撤销
│           ├── handovers.py  # 交接单生成 / 查询 / 导出 docx·pdf / 打印日志
│           ├── logs.py       # 日志中心
│           └── stats.py      # 统计报表
├── frontend/
│   ├── Dockerfile / nginx.conf # 静态站点 + /api、/uploads 反代
│   ├── index.html              # 登录页
│   ├── user/                   # 部门用户页面
│   ├── admin/                  # 管理员页面
│   └── js/{api.js, common.js, common.css}
└── database/
    ├── seed.py                 # 种子数据（也可独立运行）
    └── seed_images/            # 种子图片（真实照片）
```

### 4.2 新增一个页面

1. 在 `frontend/user/` 或 `frontend/admin/` 下新建 `xxx.html`；
2. 顶部按现有约定写注释：页面名称 / 所属角色 / 依赖 API；
3. 引入 `<script src="/js/api.js"></script>` 与 `<script src="/js/common.js"></script>`；
4. 调用 `PAIP.boot({ role: 'user'|'admin', active: 'xxx', init: function(user){ ... } })` 完成鉴权与导航渲染；
5. 在 `frontend/js/common.js` 的 `USER_LINKS` / `ADMIN_LINKS` 数组里加一条导航项即可出现在顶部菜单。

### 4.3 新增一个后端接口

1. 在 `backend/app/routers/` 对应分组文件中添加路由函数（若属于新分组，新建文件并在其顶部写明负责的接口，再到 `backend/app/main.py` 中 `app.include_router(...)` 注册）；
2. 需要登录：参数加 `current_user: User = Depends(get_current_user)`；需要管理员：加 `admin=Depends(require_admin)`（见 `backend/app/deps.py`）；
3. 需要入参校验：在 `backend/app/schemas.py` 中新增 Pydantic 模型；
4. 需要留痕：调用 `write_log(db, 类型, 操作人, 详情, asset_no=..., quantity=..., request=request)`，类型字典见 `backend/app/routers/logs.py` 的 `TYPE_LABELS`；
5. 前端调用：在 `frontend/js/api.js` 的 `window.API` 中加一个方法，页面里通过 `API.xxx()` 调用。

### 4.4 扩展表字段

新增/修改字段需要同时改两处（保持结构一致）：

1. **`backend/app/models.py`** —— ORM 列定义（新增列请补默认值，SQLite 不支持给已有表自动加列，见下方迁移说明）；
2. **`database/seed.py`** —— `SCHEMA_SQL` 中的建表语句与插入数据（首次建表由后端 `create_all` 完成，种子脚本兜底建表）。

若数据库文件已存在：

- 开发阶段：删除 `database/data/app.db` 后重启，会自动重建并注入种子数据；
- 保留数据：使用 `sqlite3 database/data/app.db "ALTER TABLE assets ADD COLUMN xxx TEXT DEFAULT '';"` 手动迁移，再同步 `models.py`。

### 4.5 其他常见改动位置

| 需求                     | 修改文件                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| 调整搜索/筛选字段              | `backend/app/routers/assets.py` 的 `list_assets`，以及 `frontend/user/browse.html` 工具栏 |
| 调整图片真实性规则（最小分辨率、体积、查重） | `backend/app/image_util.py`                                                        |
| 调整水印文案                 | `backend/app/image_util.py` 的 `make_watermark` 调用处（`routers/assets.py`）            |
| 调整登录有效期 / 密钥           | `.env`（`JWT_EXPIRE_HOURS`、`SECRET_KEY`）                                            |
| 调整交接单打印样式              | `frontend/user/handover.html` 的 `<style>` 与 `@media print`                         |
| 调整导出的 Word / PDF 内容    | `backend/app/export_util.py`（字段清单在文件顶部 `FIELD_ROWS` / `FULL_WIDTH_ROWS`）          |
| 新增日志类型                 | `backend/app/routers/logs.py` 的 `TYPE_LABELS`                                      |
| 调整端口                   | `docker-compose.yml`（`ports`）与 `frontend/nginx.conf`；免 Docker 方式改 `start.bat` / `start.sh` |
| 新增带鉴权的文件下载（导出）        | 前端一律用 `PAIP.downloadFile(url, 默认文件名)`，不要用 `location.href`（不带 JWT 会被 401 拒绝）  |

---

## 五、已知边界

1. **数据库**：SQLite 单文件，适合部门级并发；如需多实例部署请替换 `backend/app/database.py` 的 engine 为 PostgreSQL/MySQL。
2. **图片存储**：仅支持本地文件目录（`UPLOAD_DIR`），未接入对象存储；容器重建时通过 `./database/data` 卷持久化，删除该目录会同时丢失图片。
3. **图片真实性核验**：工程侧做到文件头魔数校验、可解码校验、内容指纹查重、最小分辨率与体积校验；**AI 生成图的判定无法 100% 自动化**，最终依赖管理员在「物资管理 → 图片核验」中抽检与驳回。
4. **交接单导出**：服务端真实生成标准 `.docx`（python-docx）与 `.pdf`（reportlab），可直接存档；PDF 中文字体按「系统中文字体 → reportlab 内置 CID 字体（STSong-Light）」回退，无中文字体包的 Linux 容器同样可正常出中文。仍保留浏览器打印（`window.print()`）以便现场签字。
5. **CSV 导出**：后端导出带 UTF-8 BOM，Excel 可直接打开；未生成 .xlsx 文件。
6. **认领撤销**：仅管理员可撤销（物资管理页 → 流转记录 → 撤销认领），撤销后数量自动恢复、必要时重新挂牌，并留痕；部门用户端未提供自助撤销入口。
7. **跨部门发布**：已放开——发布主体可选任意启用中的学院/部门，物资归属所选部门，`publisher_*` 仍记录实际操作人，代发布关系写入日志。若需收回该能力，在 `backend/app/routers/assets.py` 的 `create_asset` 中恢复 `department_id != current_user.department_id` 的 403 校验即可。
8. **时间处理**：统一使用服务器本地时间（容器时区 `Asia/Shanghai`）。
9. **前端样式**：Tailwind 通过公网 CDN 引入，首次打开需要联网；离线环境仍可正常操作（关键布局与组件在 `frontend/js/common.css` 中有兜底样式）。
10. **图片审核留痕**：系统保留上传人、部门、时间、文件指纹与水印文案，但不保留原始 EXIF 全量信息（落盘图已重新编码）。

---

## 六、自检脚本（`tools/`，可选，不参与部署）

| 脚本                        | 作用                                                                  |
| ------------------------- | ------------------------------------------------------------------- |
| `tools/check_js.js`       | 抽取所有 HTML 内联脚本与 `frontend/js/*.js` 做语法检查                            |
| `tools/check_dom_refs.py` | 检查 `getElementById` / `PAIP.*` / `API.*` 引用是否都存在，页面与静态资源是否断链        |
| `tools/smoke_test.py`     | 本地拉起后端跑端到端断言：登录→发布→浏览→搜索→认领扣减→归零下架→流转记录→交接单→我的记录→管理员五模块→统计→权限→导出鉴权→docx/pdf 导出→管理员修正→撤销认领→跨部门发布→部门启用的数量规则 |
| `tools/render_test.js`    | 用 jsdom 真实加载 11 个页面并执行脚本，验证无运行时错误且渲染出预期数据（需先启动 3000/8000，依赖 jsdom） |
| `tools/dev_server.py`     | 模拟 `nginx.conf` 的本地静态服务器（/api、/uploads 反代），便于无 Docker 联调            |

运行示例：

```bash
node tools/check_js.js
python tools/check_dom_refs.py
python tools/smoke_test.py        # 会自动起后端并在结束后关闭
python tools/dev_server.py        # 另开终端：前端 http://127.0.0.1:3000
node tools/render_test.js         # 需 3000/8000 已启动；需先 npm i jsdom
```

最近一次全量自检结果（可直接复现）：

| 检查项                  | 结果                     |
| -------------------- | ---------------------- |
| 前端 JS 语法             | 12 个脚本块全部通过            |
| DOM / API 引用一致性      | 无缺失 id、无未定义函数、无断链     |
| 后端端到端冒烟              | **91 项断言全部通过**         |
| 页面真实渲染（jsdom）        | 11 个页面，零运行时错误，内容渲染正确  |
