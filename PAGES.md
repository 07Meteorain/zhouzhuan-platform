# GitHub Pages

本仓库通过 GitHub Pages 发布静态演示版。

- 网址：https://07meteorain.github.io/zhouzhuan-platform/
- 发布目录：`docs/`
- 发布方式：仓库设置 → Pages → Source 选择 `main` 分支 `/docs` 目录（Deploy from a branch）

## 关于两种运行形态

| |本地 Node 版 | Pages 静态演示版 |
|---|---|---|
| 入口 | `start.bat` → `http://localhost:3000` | 上述 Pages 网址 |
| 后端 | `server/index.js`（Node http） | 无，`scripts/mock-api.js` 在浏览器内应答 |
| 数据库 | `data/platform.db`（SQLite） | `localStorage`，带「重置演示数据」按钮 |
| 数据 | 真实台账导入 | 同一份真实台账作种子 |

两者共用同一份前端代码 `public/index.html`，静态版由 `node scripts/build-static.js` 生成。

## 重新发布

```bash
node scripts/build-static.js     # 重新生成 docs/index.html
node scripts/test-static.js      # 静态版业务回归，11 组 86 项断言
```

改完前端后把 `docs/` 目录推上去，Pages 会自动重新构建。

## 数据脱敏说明（重要）

本仓库与 Pages 演示版使用的 `scripts/seed.json` 为**脱敏数据**，由 `node scripts/gen-seed-public.js` 从本地真实库生成：

| 字段 | 处理 |
|---|---|
| 负责人姓名 | 替换为虚构称谓（王师傅、刘师傅、张师傅） |
| 负责人手机号 | 全部替换为 `1390000001x` 虚构号段 |
| 存放地点 | 替换为泛化楼栋描述 |
| 物资名称与规格 | 保留真实分类，使演示有真实感 |

生成脚本内置校验：一旦检测到真实手机号、真实全名或真实存放地点残留，会直接报错退出。

**真实台账仅存在于本地 `data/platform.db`，已被 .gitignore 排除，不会上传。**
