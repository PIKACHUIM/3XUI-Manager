<div align="center">
  <img src="./public/favicon.svg" width="112" height="112" alt="3XUI Manager" />

  <h1>3XUI Manager</h1>

  <p><em>在 Cloudflare Workers 上管理 3X-UI 节点、套餐、订阅与账单</em></p>

  <p>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-3DA639" alt="License" /></a>
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=0B1220" alt="React" />
    <img src="https://img.shields.io/badge/Hono-4.x-E36002" alt="Hono" />
    <img src="https://img.shields.io/badge/D1-SQLite-003B57?logo=sqlite&logoColor=white" alt="Cloudflare D1" />
  </p>

  <p>
    <a href="./README.md">简体中文</a> ·
    <a href="./readmes/README_zh-TW.md">繁體中文</a> ·
    <a href="./readmes/README_en.md">English</a> ·
    <a href="./readmes/README_ja.md">日本語</a> ·
    <a href="./readmes/README_ko.md">한국어</a>
  </p>

  <p>
    <a href="#快速部署">快速部署</a> ·
    <a href="#手动部署">手动部署</a> ·
    <a href="#系统配置">配置</a> ·
    <a href="#设计架构">架构</a> ·
    <a href="#注意事项">注意事项</a>
  </p>
</div>

## 项目简介

3XUI Manager 把 3X-UI 的日常运营集中到一个 Cloudflare Worker内，支持：

- 节点探测、入站与客户端同步
- 套餐与用户、订单与余额
- 流量计量、配额管理和限制
- Clash / V2Ray / SIP008 订阅

3XUI Manager 适合自托管、单管理员或小团队运营多台 3X-UI 节点的场景。同一套 Hono API 也提供 Vercel、EdgeOne 和 ESA 入口；非 D1 平台使用远程 MySQL 或 Blob/KV 文档存储。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| **节点** | 多节点注册、连通性探测，按 3X-UI 结构分节的入站编辑器|
| **订阅** | Clash / Mihomo YAML、V2Ray Base64、Shadowsocks SIP008；|
| **套餐** | 注册、登录、邮箱验证；免费套餐；套餐绑定入站；升级时余额优先抵扣 |
| **配额** | 每分钟采样节点流量；支持倍率、流量重置；D1 幂等事件 |
| **支付** | Waffo 下单、签名验证、Webhook、订单查询；D1 结算锁； |
| **运维** | 站内通知、可选邮件重试、推荐奖励、账户保留清理、Cron 生命周期维护|
| **管理** | 12 种界面语言、阿拉伯语 RTL、亮色 / 暗色 、主题预设、响应式布局 |
| **安全** | 会话 Cookie、同源校验、敏感字段加密、Turnstile 注册 / 签到校验等 |

<details>
<summary><strong>订阅生成</strong>（点击展开）</summary>

- **Clash**：生成 `选择节点` 手动分组和规则分类分组，不生成 `url-test` 自动切换；每个分类仍可直接选具体节点。
- **排序**：大陆节点优先，同类按平台保存的顺序升序；管理列表、用户节点列表和三种订阅格式使用同一套排序数据。
- **凭据**：订阅只使用成功同步到节点的客户端映射；部分成功的入站只输出已确认的节点。
- **缓存**：响应带 ETag，客户端重新校验时返回 304，减少重复传输。

</details>

<details>
<summary><strong>计量配额</strong>（点击展开）</summary>

Cron 每分钟运行一次流量采样和权限对账。单轮最多处理 8 个节点，并发上限 4；节点更多时轮转采样。面板不可达或同步失败不会把节点误判为正常，相关客户端会在后续轮次重试。

D1 中的用量事件是幂等的，配额禁用和支付结算都通过 lease 串行化，避免同一账户的并发写入互相覆盖。

</details>

## 快速部署

| Cloudflare Workers | EdgeOne Makers | Aliyun ESA | Vercel |
| :---: | :---: | :---: | :---: |
| [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PIKACHUIM/3XUI-Manager) | [![Deploy to EdgeOne](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?project-name=3xui-manager&repository-url=https://github.com/PIKACHUIM/3XUI-Manager) | [![Deploy to Aliyun ESA](https://img.shields.io/badge/Deploy-Aliyun%20ESA-FF6A00?logo=alibabacloud&logoColor=white)](https://esa.console.aliyun.com/edge/function/list) | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/PIKACHUIM/3XUI-Manager) |

> 一键部署只创建平台项目，不会自动创建数据库、执行迁移或填写 secrets。Cloudflare 使用 D1，EdgeOne/ESA 使用 Blob/KV，Vercel 使用远程 MySQL；请参考 [手动部署](#手动部署) 和 [系统配置](#系统配置)。

### 平台存储

| 平台 | 存储 | 配置 |
| --- | --- | --- |
| Cloudflare Workers | D1（生产）/ KV（受限） | `DB` binding；`STORAGE_DRIVER=d1` |
| EdgeOne Makers | Blob / KV | `STORAGE_DRIVER=blob`；Blob SDK 或 `EO_KV` / `EO_BLOB` binding |
| Aliyun ESA | Blob / KV | `STORAGE_DRIVER=blob`；`ESA_BLOB` / `ESA_KV` binding |
| Vercel / Node | 远程 MySQL | `STORAGE_DRIVER=mysql`；`MYSQL_URLS` 或 `MYSQL_HOST/MYSQL_NAME` |

Blob/KV 和 MySQL 文档模式支持登录、节点、套餐、订阅和客户端同步；**原子流量计量、配额强制和 Waffo 结算仍只支持 D1**。EdgeOne/ESA 的边缘运行时不能直接连 MySQL，Vercel 的 Node 运行时可以使用远程 MySQL。

## 手动部署

<details>
<summary><strong>展开手动部署步骤</strong>（本地开发、配置与多平台部署）</summary>

### 前置要求

- Node.js 20 或更高版本 + npm
- 一个 Cloudflare、EdgeOne、ESA 或 Vercel 账号
- 生产存储：Cloudflare D1 / EdgeOne、ESA 的 Blob 或 KV / Vercel 的远程 MySQL
- 一台可从公网访问的 3X-UI 面板（HTTPS 域名 + 用户名/密码或受限 API Token）
- 可选：Waffo 沙箱商户配置（只测试支付时需要）

<details>
<summary><strong>本地开发</strong>（点击展开）</summary>

```bash
git clone https://github.com/PIKACHUIM/3XUI-Manager.git
cd 3XUI-Manager
npm ci
npm run db:local
npm run dev
```

`npm run db:local` 会把 `migrations/` 应用到本地 D1。`npm run dev` 由 Vite Cloudflare 插件启动本地 Workers 预览，终端会输出实际访问地址。

在项目根目录创建被 Git 忽略的 `.dev.vars`，只放部署级密钥：

```dotenv
ADMIN_BOOTSTRAP_TOKEN="<首次管理员初始化用的长随机串>"
APP_ENCRYPTION_KEY="<至少 32 个字符，需长期保存>"
```

> `APP_ENCRYPTION_KEY` 用于加密面板凭据和系统设置中的敏感字段。更换前必须先设计并验证已有密文的重加密方案，否则旧凭据将无法解密。

业务配置（验证码、邮件、支付、签到、推荐奖励等）在管理员登录后的“系统设置”里填写，不写入 `.dev.vars`，也不要提交到仓库。

</details>

<details>
<summary><strong>配置系统</strong>（点击展开）</summary>

1. 打开本地开发地址，使用登录页的“首次管理员初始化”。
2. 输入 `ADMIN_BOOTSTRAP_TOKEN`，创建管理员账号；建成后该 Token 不再代替管理员登录凭据。
3. 在“节点列表”新增 3X-UI 节点，确认探测状态为在线。
4. 创建入站、套餐，并把套餐绑定到入站。
5. 按需配置 Turnstile、Resend、Waffo 和签到奖励。
6. 创建用户或让用户注册，检查订阅链接与客户端同步状态。

</details>

### 部署到 Cloudflare

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create 3xuiwork-data
```

将命令输出中的 `database_id` 写入 `wrangler.jsonc` 的 `d1_databases[0].database_id`。保留 binding 名 `DB`、数据库名 `3xuiwork-data` 和 `migrations_dir: "migrations"`。

> 仓库里的 `wrangler.jsonc` 可能包含部署者的真实 ID。Fork 或自建时请替换为自己的 D1 ID，不要直接复用他人的数据库。

### 2. 登记 Worker secrets

```bash
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
npx wrangler secret put APP_ENCRYPTION_KEY
```

这两项只在部署环境设置。Waffo 的 API Key、商户号、签名私钥和平台公钥现在通过管理员“系统设置”保存，不再读取同名 Worker 环境变量。

### 3. 数据迁移

迁移不会自动执行。先审阅 `migrations/` 中待应用的 SQL，导出备份，再由有生产权限的操作者应用：

```bash
npx wrangler d1 migrations list 3xuiwork-data --remote
npx wrangler d1 export 3xuiwork-data --remote --output d1-before-deploy.sql
npm run db:remote
```

`--remote` 会写入远程数据库。执行前请核对 Wrangler 登录账号、数据库名/ID、备份可用性和恢复责任人。

### 4. 构建发布

```bash
npm run typecheck
npm test
npm run deploy
```

`npm run deploy` 等价于 `npm run build && wrangler deploy`，会先构建前端静态资源，再发布 Worker、D1 绑定和 Cron 触发器。

### 5. 完成检查

1. 访问 `https://<你的域名>/api/health`，确认 D1 计量、配额强制和支付结算能力正常。
2. 完成首次管理员初始化并登录，确认会话 Cookie 与同源请求正常。
3. 新增节点并探测，确认 3X-UI 面板可达；Worker 不能访问裸 IP、私网或回环地址。
4. 在系统设置填写 `publicAppUrl`，必须是最终 HTTPS 源站，不带路径、凭据、查询或片段。
5. 在 Waffo 商户后台把通知地址设为 `https://<你的域名>/api/webhooks/waffo`，并用沙箱完成一次升级/回调验证。
6. 检查 Cron 执行日志、流量采样、订阅输出和节点客户端状态。

### 部署到 Vercel

1. 在 Vercel 导入仓库；`vercel.json` 已指定 `npm run build:vercel`、`dist/vercel`、API rewrite 和每分钟 `/api/cron`。
2. 准备远程 MySQL，并设置环境变量：`STORAGE_DRIVER=mysql`、`MYSQL_URLS`（或 `MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASS/MYSQL_NAME`）。
3. 设置 `APP_ENCRYPTION_KEY`、`ADMIN_BOOTSTRAP_TOKEN`、`CRON_SECRET` 和可选的 `APP_NAME`。
4. 应用会自动创建文档表 `3xui_kv`；Vercel Hobby 计划可能不允许每分钟 Cron，请按套餐调整 `vercel.json` 或改用外部调度。

### 部署到 EdgeOne

1. 在 EdgeOne Makers 导入仓库；`npm run build:edgeone` 会生成 `dist/edgeone` 静态资源和 `edge-functions/api/[[default]].js`。
2. 在 EdgeOne 控制台绑定 Blob 或 KV，并设置 `STORAGE_DRIVER=blob`；Blob 命名空间可用 `EO_BLOB_NAMESPACE`，KV binding 为 `EO_KV`。
3. 设置 `APP_ENCRYPTION_KEY`、`ADMIN_BOOTSTRAP_TOKEN`、`CRON_SECRET`。
4. EdgeOne 原生 `schedules` 最小间隔为一天；需要分钟级同步时，用外部调度请求 `/api/cron`。

### 部署到 Aliyun ESA

1. 在 ESA 控制台导入仓库；`esa.jsonc` 使用 `dist/esa-entry.js` 和 `dist/esa` 静态资源。
2. 绑定 `ESA_BLOB` 或 `ESA_KV`，并设置 `STORAGE_DRIVER=blob`。
3. 设置 `APP_ENCRYPTION_KEY`、`ADMIN_BOOTSTRAP_TOKEN`、`CRON_SECRET`。
4. ESA 没有原生分钟级 Cron；用外部调度向 `/api/cron` 发送 `x-cron-secret`。ESA 边缘函数有较低 CPU 和子请求限制，建议把重任务留给外部调度器或 Cloudflare Worker。

</details>

## 系统配置

### Worker 绑定与变量

| 名称 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `DB` | D1 | Cloudflare | 计量、配额、支付结算和订阅数据的核心存储 |
| `ASSETS` | Static Assets | 是 | React 管理端与用户端静态资源 |
| `APP_KV` | KV | 否 | Cloudflare KV；仅用于能力受限的部署 |
| `STORAGE_DRIVER` | Variable | 是 | `d1` / `mysql` / `blob` / `kv` |
| `APP_NAME` | Variable | 否 | 站点标题的默认值，可在系统设置中覆盖 |
| `ADMIN_BOOTSTRAP_TOKEN` | Secret | 首次初始化 | 只用于创建第一个管理员 |
| `APP_ENCRYPTION_KEY` | Secret | 是 | 加密面板凭据和系统设置敏感字段，至少 32 字符 |

### 平台环境变量

| 变量 | 适用平台 | 说明 |
| --- | --- | --- |
| `STORAGE_DRIVER` | 全部 | `d1` / `mysql` / `blob` / `kv` |
| `MYSQL_URLS` | Vercel / Node | 优先使用的 MySQL 连接串，如 `mysql://user:pass@host:3306/db` |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASS` / `MYSQL_NAME` | Vercel / Node | `MYSQL_URLS` 的分项替代写法 |
| `CRON_SECRET` | Vercel / EdgeOne / ESA | 外部或平台 Cron 调用 `/api/cron` 时使用；Vercel 会以 Bearer 发送 |
| `EO_KV` / `EO_BLOB` | EdgeOne | 平台 KV/Blob binding；`STORAGE_DRIVER=blob` |
| `EO_BLOB_NAMESPACE` | EdgeOne | EdgeOne Blob 命名空间，默认 `default` |
| `ESA_BLOB` / `ESA_KV` | Aliyun ESA | ESA Blob/KV binding；`STORAGE_DRIVER=blob` |

Vercel 和 Node 的环境变量模板见 `.env.example`；Cloudflare 本地变量模板见 `.dev.vars.example`。不要把真实值提交到仓库。

<details>
<summary><strong>系统设置</strong>（点击展开）</summary>

| 设置 | 用途 |
| --- | --- |
| `publicAppUrl` | 站点 HTTPS 源站，用于支付回跳和 Webhook 地址校验 |
| `registrationEnabled` | 是否允许普通用户注册 |
| `turnstileSiteKey` / `turnstileSecretKey` | 注册与签到的 Turnstile 校验；后端同时校验 action 和请求主机名 |
| `resendApiKey` / `resendFrom` | 可选邮件投递；两者都配置后才发送通知邮件 |
| `waffoApiKey` / `waffoSigningKey` / `waffoPublicKey` | Waffo 请求签名与响应验签 |
| `waffoMerchantId` / `waffoEnvironment` | 商户号与运行环境；默认沙箱，设为 `production` 才请求生产 API |
| 签到奖励范围 | 按十进制 GB 配置上下限；服务端在包含两端的整数 Byte 范围内均匀随机 |
| `referralPercent` / `referralValidityDays` | 推荐奖励比例与有效天数 |
| 账户清理相关项 | 不活跃/无套餐清理阈值与预警天数；默认关闭 |

敏感字段使用 `APP_ENCRYPTION_KEY` 加密后保存。管理员读取设置时，秘密字段返回空字符串，并通过 `secretConfigured` 表示是否已配置；写入时省略或传空字符串保留旧值，传 `null` 清除，传非空字符串替换。

</details>

### Waffo 支付

<details>
<summary>展开查看 Waffo 配置、回调与交易行为</summary>

支付相关配置全部通过管理员 `PUT /api/admin/settings` 保存

| 设置 | 含义 |
| --- | --- |
| `waffoApiKey` | Waffo 商户后台签发的 API Key，随请求以 `X-API-KEY` 发送 |
| `waffoMerchantId` | 商户号，写入下单请求的 `merchantInfo.merchantId` |
| `waffoSigningKey` | 商户 RSA 私钥，建议 PKCS#8；用于对下单/查询请求体签名 |
| `waffoPublicKey` | Waffo 平台 RSA 公钥；用于验签响应与 Webhook |
| `publicAppUrl` | 生成 `notifyUrl` 与成功/失败/取消跳转地址，必须是 HTTPS 且与前端/API 同源 |
| `waffoEnvironment` | 省略或非 `production` 时请求沙箱，设为 `production` 才请求生产 API |

交易行为：

- 升级应付款先由账户余额抵扣；余额部分以 D1 流水 `balance_payment` 记账，并在同一事务内扣减。余额不足时只对差额创建 Waffo 订单，已抵扣金额记录在 `metadata.balanceAppliedMinor`。
- 订单关闭或过期时，已抵扣余额以 `balance_refund` 幂等退回；晚到的成功通知会在结算前重新核对。
- 支持的终态为 `PAY_SUCCESS` 和 `ORDER_CLOSE`；处理中状态只确认接收，不结算。
- Webhook 可能乱序。若成功通知到达时订单已被标记为失败或过期，应用会请求并验签 Waffo Order Inquiry，确认金额和币种后再结算。
- 管理员人工充值/退款不经过 Waffo：充值订单记为 `paid`，退款订单记为 `refunded`，只调整本地余额并写流水，不会产生真实收付款；人工充值不计入“本月收入”。
- 账户余额当前是单一数值，不区分币种；跨币种套餐应避免依赖余额。
- 仓库测试使用签名模拟响应，未完成真实商户环境的 Webhook / Inquiry 端到端验证；上线前必须用沙箱完整验证。

</details>

## 设计架构

```mermaid
flowchart LR
  subgraph Clients["客户端"]
    B["浏览器 / 管理后台"]
    C["Clash / Mihomo"]
    V["v2ray / SIP008"]
  end

  subgraph Platforms["边缘 / Serverless"]
    E["Worker / Vercel / EdgeOne / ESA 入口"]
    A["Hono API + React 静态资源"]
  end

  S[("D1 / MySQL / Blob / KV")]
  T["平台 Cron / 外部调度"]
  X["3X-UI 面板集群"]
  P["Waffo"]
  M["Resend / Turnstile"]

  B --> E
  C --> E
  V --> E
  E --> A
  E --> S
  T --> E
  E --> X
  E --> P
  E --> M
```

| 层 | 技术 |
| --- | --- |
| 运行时 | Cloudflare Workers、Vercel Node、EdgeOne Edge Functions、ESA Edge Functions |
| 后端 | Hono、TypeScript |
| 存储 | D1（原子能力）、远程 MySQL、EdgeOne/ESA Blob 或 KV |
| 前端 | React 19、Vite、Tailwind CSS 4、Recharts、Lucide |
| 测试 | Vitest、Wrangler 本地 D1 platform、MySQL/Blob/KV 适配器测试 |
| 外部系统 | 3X-UI HTTP API、Waffo、Turnstile、Resend |

<details>
<summary><strong>项目结构</strong>（点击展开）</summary>

```text
src/
├─ app.ts        Hono 应用与 /api/cron
├─ api/          路由：auth / user / admin / payments / subscriptions
├─ services/     计费、流量、生命周期、通知、订阅、节点同步、WireGuard
├─ adapters/     外部系统：3X-UI、Waffo
├─ domain/       类型、默认值、加密、WireGuard
├─ storage/      D1 / MySQL / Blob / KV 存储适配器
├─ platform/     Vercel / EdgeOne / ESA 入口与环境映射
├─ worker/       Cloudflare Worker 入口与共享 Cron jobs
└─ client/       React 管理端与用户端
api/             Vercel Web Handler 与 Cron 函数
migrations/      D1 SQL 迁移
public/          图标等静态资源
scripts/         EdgeOne / ESA 函数打包脚本
wrangler.jsonc   Cloudflare Worker / D1 / KV / Cron 配置
vercel.json      Vercel 构建、路由与 Cron
edgeone.json     EdgeOne 构建与静态资源
esa.jsonc        ESA 入口与静态资源
```

</details>

<details>
<summary><strong>开发脚本</strong>（点击展开）</summary>

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地 Workers 预览 |
| `npm run build` | 构建 Worker 和前端静态资源 |
| `npm run build:vercel` | 构建 Vercel 静态前端 |
| `npm run build:edgeone` | 构建 EdgeOne 静态前端与边缘函数 |
| `npm run build:esa` | 构建 ESA 静态前端与边缘函数 |
| `npm run preview` | 使用 `dist` 预览构建结果，需先执行 `build` |
| `npm run deploy` | 构建并发布到 Cloudflare |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行 Vitest 测试 |
| `npm run db:local` | 应用本地 D1 迁移 |
| `npm run db:remote` | 应用远程 D1 迁移（人工确认后执行） |

</details>

## 注意事项

<details>
<summary>点击展开查看注意事项</summary>

- **存储限制**：D1 仍提供原子流量计量、配额强制和 Waffo 结算；Blob/KV 与 MySQL 文档模式支持登录、节点、套餐、订阅和客户端同步，但非 D1 存储会禁用 checkout、签到和原子余额调整。
- **平台适配**：已提供 Vercel、EdgeOne、ESA 入口和构建配置；Vercel 需要远程 MySQL，EdgeOne/ESA 使用 Blob/KV。三者仍需在真实平台绑定资源、设置 secrets 并完成端到端验证，不能仅凭构建成功视为上线完成。
- **面板网络**：面板必须使用 HTTPS 域名。Worker 无法访问裸 IP、私网或回环地址；面板被防火墙拦截时，应放行 Cloudflare 出口或使用 Cloudflare Tunnel。
- **执行延迟**：Cloudflare/Vercel 的 Cron 每分钟运行；EdgeOne 原生 schedules 最小间隔为一天，ESA 无原生分钟级 Cron，二者需外部调度 `/api/cron`。单轮最多 8 个节点、并发 4，实际执行时间还受面板可用性和 D1 事件积压影响。
- **支付边界**：只接入 Waffo，且结算只在 D1 存储下启用；沙箱为默认环境。真实商户 Webhook、完整 Inquiry payload 和 Waffo 重试行为未在商户环境端到端验证。支付成功跳转不能当作付款凭证，以签名验证后的服务端 Webhook 和订单状态为准。
- **登录验证**：仓库测试不包含真实第三方凭据；上线前必须配置有效 Site Key、Secret Key、widget 域名和发件域，并自行完成真实投递验证。
- **迁移回滚**：D1 迁移与 Worker 版本分开；回滚 Worker 不会撤销已应用的 migration，D1 Time Travel 恢复会原地覆盖数据库，属于破坏性操作。MySQL/Blob/KV 文档模式使用应用自动建表或键值记录，不执行 D1 migration，但也没有 D1 Time Travel 等价恢复。
- **密钥管理**：`APP_ENCRYPTION_KEY` 必须长期保存；不要在日志、Issue、截图或提交记录中暴露密钥、面板密码、UUID、订阅令牌或支付私钥。

</details>

<details>
<summary><strong>常见问题</strong>（点击展开）</summary>

| 现象 | 优先检查 |
| --- | --- |
| `/api/health` 报告 D1 不可用 | `wrangler.jsonc` 的 `DB` binding、`database_id`、迁移是否已应用 |
| 订阅返回 422 | 是否有满足套餐、已启用且成功同步的客户端；检查入站绑定与 `syncedNodes` |
| 面板探测超时 | 面板是否为 HTTPS 域名；防火墙是否放行 Cloudflare；是否使用了裸 IP/私网地址 |
| `Waffo returned an unverified response` | `waffoPublicKey` 是否为当前平台公钥，`waffoSigningKey` 是否为对应商户私钥 |
| 注册后收不到验证邮件 | `resendApiKey` 与 `resendFrom` 是否同时配置，发件域是否已验证 |
| 管理员无法登录 | 首次初始化只使用 `ADMIN_BOOTSTRAP_TOKEN`；之后使用创建的管理员邮箱和密码 |
| 订阅更新后节点仍失败 | 在客户端重新更新订阅，而不是只刷新节点列表；再检查面板客户端与节点同步状态 |

</details>

## 许可证

本项目基于 [AGPL-3.0](./LICENSE) 许可证开源。

如果你部署的是修改后的版本，请按 AGPL-3.0 的要求向用户提供对应源代码。

## 相关项目

- [3X-UI](https://github.com/MHSanaei/3x-ui)：面板与 Xray 管理
- [Hono](https://hono.dev)：边缘运行时 Web 框架
- [Cloudflare Workers](https://workers.cloudflare.com)：运行时与边缘网络
- [Waffo](https://waffo.com)：支付接入
