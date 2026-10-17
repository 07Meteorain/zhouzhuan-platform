# 周转物资平台

本目录是 GitHub Pages 的发布目录，由 `node scripts/build-static.js` 从 `public/index.html` 自动生成，请勿手工修改。

生成方式：

```bash
node scripts/build-static.js   # public/index.html + scripts/mock-api.js + scripts/seed.json → docs/index.html
node scripts/test-static.js    # 静态版业务回归，11 组共 86 项断言
```
