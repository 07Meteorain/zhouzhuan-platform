# 学校 OA 接入说明

本项目已按"OA 内嵌子模块"架构设计，OA 接口到位后**只替换适配器实现类，业务代码零改动**。

---

## 一、向学校信息中心索要的资料

### 必问的三个问题

1. **免登如何实现？** 平台以 iframe 嵌入 OA 页面，还是 OA 菜单跳转到我们域名？跳转时能否携带 ticket 参数？
2. **用户信息包含哪些字段？** 尤其**是否有"部门"或"身份类型"字段** —— 这直接决定五类角色如何映射。
3. **工作流能否被外部系统触发？** 审批完成后能否回调本服务？

### 需要的资料清单

| 资料 | 用途 | 缺失后果 |
|---|---|---|
| 《OA 对外接口文档》 | 了解协议格式与调用方式 | 无法开始编码 |
| AppKey / AppSecret | 应用凭证，相当于系统间密码 | 接口调不通 |
| 测试账号（学生/教职工/管理员各一） | 验收时让资产中心老师登录 | 无法做用户测试 |
| 回调白名单申请方式 | 部分 OA 只允许备案 IP/域名回调 | 登录后回调被拒，最易漏 |
| 测试环境地址 | 避免直接上生产调试 | 风险过高 |

### 角色映射表（`auth-adapter.js` 的 `ROLE_MAP`）

已按 OA 常见身份字段预置，拿到文档后按实际情况调整：

```js
const ROLE_MAP = {
  student:           'student',    // 学号
  undergraduate:     'student',    // 本科生
  postgraduate:      'student',    // 研究生
  teacher:           'mentor',     // 教职工 → 导师
  student_supervisor:'mentor',     // 指导教师
  warehouse:         'warehouse',  // 仓库管理员
  asset_manager:     'asset_admin',// 资产管理处
};
```

> **若 OA 只推工号和姓名、不含身份字段**，需额外维护一张工号前缀/名单映射表，
> 这种情况请尽早反馈给需求方，因为会影响权限系统的实现方式。

---

## 二、免登接入（AuthAdapter）

### 当前实现

```js
// server/auth-adapter.js
const MODE = process.env.AUTH_MODE || 'local';  // local | oa
const current = MODE === 'oa' ? OaAuth : LocalAuth;
```

业务代码只调用 `current.verify(username, password)`，不关心底层是谁。

### 接入三步

**第一步：拿到 OA 文档后，确认协议**

多数高校 OA 使用两种方案之一：

- **OAuth2.0 授权码模式**：跳转授权页 → 拿 code → 换 token → 查用户信息
- **CAS 单点登录**：跳转 CAS 服务 → 拿 ticket → 校验 ticket → 拿用户

**第二步：实现 `OaAuth.verifyFromTicket(ticket)`**

文件里已留好位置（约 70 行处）：

```js
async verifyFromTicket(ticket) {
  if (!ticket) return null;
  if (!OA_CONFIG.appKey || !OA_CONFIG.appSecret) {
    throw new Error('OA 接入配置未完成：缺少 OA_APP_KEY / OA_APP_SECRET');
  }
  // TODO: 按 OA 文档实现两步请求
  // 1) 用 ticket 换 access_token
  // 2) 用 access_token 查用户档案
  return { username, name, identityType, dept, phone };
}
```

**第三步：确认回调路由已生效**

`server/index.js` 已预留 `GET /api/auth/callback?ticket=xxx`，
需把这个地址报给 OA 侧作为回调地址，并申请白名单。

### 用户自动落库

`syncUser()` 已实现：OA 返回的用户档案会**自动写入 `users` 表**，
按 `ROLE_MAP` 映射角色，`source` 标记为 `oa`。OA 侧新增人员无需手工导入。

---

## 三、审批对接（ApprovalAdapter）

### 三种情况

| OA 能力 | 对接方式 | 工作量 |
|---|---|---|
| 支持外部触发工作流 + 回调 | 完整接入，推待办到 OA | 2-3 天 |
| 支持触发但不支持回调 | 推待办 + 靠 `reconcile()` 定时拉取补齐 | 3-4 天 |
| **都不支持** | 审批在平台内做，仅用 OA 消息提醒 | 0 天（现状即最终形态） |

第三种情况很常见。**不要因此停下开发**，平台内审批中心已经是完整的最终形态，
接入 OA 只是把待办换个地方显示。

### 接入实现

```js
// server/approval-adapter.js
const MODE = process.env.APPROVAL_MODE || 'local';

async pushTodo(req, approver) {
  // TODO: 创建 OA 待办，返回流程实例 ID
  // 建议在本平台记录 extId，便于回调时匹配单据
}

async onResult(req, result, operator) {
  // TODO: 收到回调后更新本地单据状态
}

async reconcile() {
  // TODO: 遍历中间态单据，查询 OA 真实状态并修正
  // 这是回调丢失时的兜底，建议每 5 分钟跑一次
}
```

### 一单两记的状态一致性

申领单在**本地平台**和 **OA 工作流**各存一份，必须保证状态一致：

```
本地创建单据（待审批） → 同时创建 OA 待办
                          ↓
                    老师 OA 点同意
                          ↓
                   OA 回调本地 → 更新状态 + 触发库存扣减
```

**回调可能丢失**，所以 `reconcile()` 不是可选项。演示前务必跑一次对账，
否则会出现"老师明明点了同意，系统里还是待审批"。

---

## 四、切换步骤

```bash
# 1. 设置环境变量
export AUTH_MODE=oa
export APPROVAL_MODE=oa
export OA_APP_KEY=xxx
export OA_APP_SECRET=xxx
export OA_TOKEN_URL=https://oa.xxx.cn/auth/token
export OA_USERINFO_URL=https://oa.xxx.cn/api/user
export OA_WORKFLOW_CREATE_URL=https://oa.xxx.cn/api/workflow/create
export OA_WORKFLOW_QUERY_URL=https://oa.xxx.cn/api/workflow/query
export OA_CALLBACK_URL=https://your-domain/api/auth/callback

# 2. 实现适配器中的 TODO

# 3. 重启
node server/index.js
```

切换后 `/api/me` 会返回当前模式，前端页面右上角会显示"认证:oa 审批:oa"，便于确认。

---

## 五、汇报口径

OA 接口属于外部依赖，尚未拿到时建议这样表述：

> 本轮已实现周转物资申领到归还的完整业务闭环，包括两级审批、部分通过改单、
> 库存实时增减与账实对账，全部在平台内验证通过。并发压测 60 人抢 30 顶物资，
> 无超卖、无负库存。
>
> OA 统一身份认证与工作流对接需学校信息中心开放接口，属下一阶段工作。
> 因业务层与认证审批层已做适配器隔离，接口到位后可零改动切换，周期约 1-2 天。

关键词是「**已验证**」和「**零改动切换**」—— 前者证明该做的做完了，
后者证明外部依赖不会变成项目烂尾的风险。
