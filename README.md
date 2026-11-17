# 3XUI Manager

基于 Cloudflare Workers、Hono、React、D1 和 3X-UI API 的订阅与节点管理平台。D1 是生产计量、套餐配额强制和原子支付结算的必需存储；KV 仅供能力受限的部署使用。

## 功能

- 用户注册、登录、邮件验证、管理员首次引导及会话 Cookie。
- 用户订阅、套餐、节点、订单查询；管理员用户、套餐、节点、入站与订单管理。
- 3X-UI 节点探测、入站/客户端同步、每分钟定时流量采样及用量耗尽后的禁用重试。
- 入站编辑器按 3X-UI 面板的结构分节：协议（VLESS / VMess / Trojan / Shadowsocks / Dokodemo-door / HTTP / SOCKS / Mixed / WireGuard）、传输（TCP / Raw / WebSocket / HTTP2 / HTTP Upgrade / gRPC / XHTTP / mKCP / Hysteria）、TLS 与 REALITY（证书数组、版本、曲线、会话恢复、ML-DSA-65 等）、嗅探（含排除域名与 IP）、sockopt 与 TCP/UDP 最终掩码；入站级字段覆盖总流量、到期时间、流量重置周期与重置日、标签、分享地址策略、订阅排序、订阅排除和 Flow 禁用。未托管的 JSON 键在保存时原样保留，原始配置可在“高级设置”里查看；VLESS 默认 Flow 只写入之后为套餐新建的客户端映射。
- 唯一支付接入为 Waffo.com；下单/通知签名验证、订单金额核对和 D1 结算锁。
- 付费升级先扣账户余额（D1 原子扣减并记流水），余额不足时只对差额发起 Waffo 支付；订单关闭或过期会退已抵扣余额，晚到的成功通知会在结算前重新扣回。
- 管理员可在用户管理里直接充值或退款：每笔调整都会生成 `provider: manual` 的订单，并写入 `manual_credit` / `manual_refund` 余额流水；退款不能超过当前余额，且需要 D1 原子存储。
- 默认免费套餐（等级 0、价格 0）可调整流量与有效期；新注册账户和管理员新建的免费账户会继承这些值并立即尝试同步客户端，但修改不会回写已有账户的额度。
- `/api/health` 报告 D1 流量计量、配额强制及支付结算能力。
- D1 定时维护负责过期待付款订单、用户通知及可选的账户保留清理。
- 被邀请用户的成功付款可按配置向邀请人账户记入幂等奖励。

> 当前管理 UI 通过弹窗创建/编辑节点、入站、套餐和用户；管理员可手动创建用户并设置初始密码和套餐，新建账号会直接标记为邮箱已验证，可立即登录；用户列表还提供“充值 / 退款”弹窗，用于人工增减余额并留下订单记录。还支持启停用户/套餐/入站/节点和探测节点。入站节点绑定只在创建时设置；暂不提供节点/入站删除界面。管理员增长图表尚无聚合数据源；系统设置页面支持验证码、Waffo 支付、Resend 邮件及签到奖励范围。用户订阅链接复制和部分动态信息尚未接通服务端。签到已接入 D1 API；无 D1 存储模式会明确禁用。系统设置以十进制 GB 配置最小/最大奖励，服务端在包含两端的整数 Byte 范围内均匀随机发放；上下限相同为固定奖励，最大值为 0 时关闭签到奖励。旧 `checkinTrafficBytes` 配置兼容为相同上下限；每天按配置时区仅可领取一次。注册与签到现已接入 Turnstile widget/token 流程，后端会校验 action 和请求主机名；启用前必须配置有效的 Site Key、Secret Key 和对应 widget 域名。当前没有真实 Turnstile 凭据，因此未做真实 token 验证。请勿将未接通页面上的静态文案视为线上状态或交易记录。

界面支持简体中文、繁体中文、英语、日语、韩语、德语、西班牙语、葡萄牙语、意大利语、阿拉伯语、俄语和法语，可在顶栏语言菜单切换并记住选择；阿拉伯语会自动切换为从右到左布局。主题默认跟随浏览器/操作系统配色，手动切换后会记住所选主题。

## 通知、推荐奖励与账户保留

- 用户可通过仪表盘铃铛查看通知。`GET /api/user/notifications` 只返回当前用户的通知；`POST /api/user/notifications/:id/read` 将该条通知标记为已读。事件包括订单过期、流量耗尽、订阅过期、流量重置、推荐奖励和账户清理预警。
- Worker Cron 每分钟运行 D1 生命周期维护；待付款订单从创建起 30 分钟后过期。邮件投递为可选功能，须在系统设置同时配置 `resendApiKey` 和 `resendFrom`；已启用的通知邮件最多重试五次。邮件不可用不影响站内通知记录。本地邮件测试使用 mock，尚未验证 Resend 真实投递。
- 推荐设置通过管理员鉴权的 `GET/PUT /api/admin/settings` API 保存，默认值为 `referralPercent: 10`、`referralValidityDays: 30`。被邀请账户在有效期限内完成付款后，只有邀请人账户已启用且套餐币种匹配时才会记入奖励；D1 ledger 幂等性避免重复入账。可在系统设置页面修改推荐参数。
- 账户清理默认关闭：`deleteInactiveAfterDays` 与 `deleteWithoutPlanAfterDays` 默认为 `0`；`warnBeforeDeleteDays` 默认为 `3`。启用后，仅评估满足对应不活跃或无有效套餐期限的启用普通用户；管理员、有非零余额、有效付费套餐、邀请关系、待付款订单或现有客户端映射的账户不会清理。清理会删除用户记录、会话、邮箱索引和通知，但保留历史订单/付款记录，因此它不是完整的数据擦除机制。相关设置须通过管理员鉴权的 `/api/admin/settings` API 修改，启用前应审阅清理条件和数据影响。

## 本地开发

要求 Node.js 20 或更高版本及 npm。先安装锁定依赖并应用本地 D1 migrations：

```bash
npm ci
npm run db:local
npm run dev
```

`npm run dev` 由 Vite Cloudflare 插件启动本地 Workers 预览。在项目根目录被 Git 忽略的 `.dev.vars` 中仅填写 `ADMIN_BOOTSTRAP_TOKEN`、`APP_ENCRYPTION_KEY` 等部署密钥；管理员登录后在系统设置填写验证码、邮件和支付配置；不要将密钥粘贴到源码、`wrangler.jsonc` 或提交记录。没有 Waffo 沙箱配置时，普通页面和 API 可开发，但下单会失败。不要用生产商户密钥做本地测试。

常用本地检查：

```bash
npm run typecheck
npm test
npm run build
npm run preview
```

`npm run preview` 使用已生成的 `dist`，因此需先运行 `npm run build`。测试使用 Wrangler 的本地 D1 platform，不请求远程面板、支付商户或数据库。

## Cloudflare 配置

1. 在 Cloudflare 创建 Worker 和 D1 数据库：

   ```bash
   npx wrangler d1 create 3xui-manager
   ```

2. 将创建结果中的真实 `database_id` 更新到 `wrangler.jsonc` 的 `d1_databases[0]`。当前配置中的 `00000000-0000-0000-0000-000000000001` 只是占位符。保留 binding 名 `DB`、数据库名 `3xui-manager` 及 `migrations_dir: "migrations"`。
3. 确认 Worker vars：`STORAGE_DRIVER=d1`；管理员系统设置中的 `registrationEnabled` 控制注册，`publicAppUrl` 配为最终 HTTPS 源站/Worker 域名。项目依赖同源 API 与 Webhook，不应把前端和 API 拆到不同域名。
4. 在部署前登记所需密钥（Wrangler 会交互式要求输入；命令不包含密钥值）：

   ```bash
   npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
   npx wrangler secret put APP_ENCRYPTION_KEY
   ```

   `APP_ENCRYPTION_KEY` 至少 32 个字符，并须持久保存；它用于加密 3X-UI 面板凭据及系统设置中的敏感凭据。更换密钥前必须先设计并验证已有密文的重加密方案，否则既有凭据将无法解密。`WAFFO_SIGNING_KEY` 是商户私钥，用于请求签名及签署回执；`WAFFO_PUBLIC_KEY` 用于验签。不得把它们互换。
5. 邮件验证默认开启，因此需要有效的 Resend 配置，才能让普通注册用户完成验证。首次管理员通过登录页的“First-time admin setup”流程创建，需提供 `ADMIN_BOOTSTRAP_TOKEN`；建成后该 Token 不会代替管理员登录凭据。
6. 准备好 3X-UI 面板的 HTTPS 公网地址、用户名与密码或受限 API Token。Worker 无法访问私网/回环面板地址；面板凭据在 D1 中加密保存。管理员在界面新增节点并验证探测状态，再创建入站和套餐。

### Waffo

依赖以下系统设置（表中旧变量名对应上文 camelCase 字段，不再读取 Worker 绑定）；缺任意一项时下单会直接失败并提示 `Waffo requires WAFFO_API_KEY, WAFFO_SIGNING_KEY, WAFFO_PUBLIC_KEY, WAFFO_MERCHANT_ID, and PUBLIC_APP_URL.`：

| 变量 | 含义与格式 |
| --- | --- |
| `WAFFO_API_KEY` | Waffo 商户后台签发的 API Key，随请求以 `X-API-KEY` 头发送。 |
| `WAFFO_MERCHANT_ID` | Waffo 商户号，写入下单请求的 `merchantInfo.merchantId`。 |
| `WAFFO_SIGNING_KEY` | 商户 RSA 私钥，建议 PKCS#8（`-----BEGIN PRIVATE KEY-----`），也接受 `RSA PRIVATE KEY`；用于对下单/查询请求体签名。 |
| `WAFFO_PUBLIC_KEY` | Waffo 平台 RSA 公钥（`-----BEGIN PUBLIC KEY-----`，也接受 `RSA PUBLIC KEY`）；用于验签 Waffo 响应与 webhook。 |
| `PUBLIC_APP_URL` | 站点 HTTPS 源站，如 `https://3xui.example.com`；用于生成 `notifyUrl` 与成功/失败/取消跳转地址，必须是 `https:` 且与前端/API 同源。 |
| `WAFFO_ENVIRONMENT` | 可省略。省略或非 `production` 值时请求 `https://api-sandbox.waffo.com`，设为 `production` 才请求 `https://api.waffo.com`。 |

本地和生产都通过管理员 `PUT /api/admin/settings` 保存业务配置，不再读取同名环境变量，也不会自动导入旧环境变量。升级时请重新保存旧配置后验证业务，再清理已废弃的 Worker secrets。

系统设置字段：`publicAppUrl`、`turnstileSiteKey`、`turnstileSecretKey`、`resendApiKey`、`resendFrom`、`waffoApiKey`、`waffoSigningKey`、`waffoPublicKey`、`waffoMerchantId`、`waffoEnvironment`（sandbox/production）。现有未开放支付适配器使用 `dodoApiKey`、`dodoWebhookKey`、`dodoEnvironment`（test_mode/live_mode）、`dodoTopupProductId`、`zpayPid`、`zpayKey`、`zpayPaymentType`（alipay/wxpay）。`publicAppUrl` 必须为不带路径、凭据、查询或片段的 HTTPS 源站。

敏感字段 `turnstileSecretKey`、`resendApiKey`、`waffoApiKey`、`waffoSigningKey`、`dodoApiKey`、`dodoWebhookKey`、`zpayKey` 使用 APP_ENCRYPTION_KEY 加密后存储。`GET /api/admin/settings` 返回 `{ settings, secretConfigured }`，其中秘密字段始终为空字符串，状态为布尔值。PUT 使用平铺对象；省略或空字符串保持旧秘密，`null` 明确清除，非空字符串替换。所有字段校验和加密完成后才开始写入。普通字段空字符串清除。PEM 支持真实换行和字面 `\n`；私钥只用于签名，平台公钥只用于验签。

配置完成后自检：

1. `https://<PUBLIC_APP_URL>/api/health` 可访问，且支付结算能力显示为可用（D1 模式）。
2. 在 Waffo 商户后台将通知地址设为 `https://<PUBLIC_APP_URL>/api/webhooks/waffo`；应用下单时也会带 `notifyUrl`，两处应一致。
3. 用沙箱账号在套餐中心完成一次升级：余额足够时不跳转收银台、直接升级并提示余额抵扣；余额不足时跳转 Waffo 收银台并回跳 `?payment=complete`。
4. 若报 `Waffo returned an unverified response`，优先核对 `WAFFO_PUBLIC_KEY` 是否为 Waffo 后台当前公钥、`WAFFO_SIGNING_KEY` 是否为对应商户私钥。

交易行为说明：

- 沙箱环境为默认值；将系统设置 `waffoEnvironment` 设为 `production` 才会指向生产 API。上线前先在 Waffo 沙箱使用沙箱密钥完整验证订单创建、签名响应和 webhook。
- Waffo 商户后台通知地址必须配置为 `https://<PUBLIC_APP_URL>/api/webhooks/waffo`；应用会以 HTTPS `PUBLIC_APP_URL` 生成通知及跳转地址。
- 付费升级的应付金额先由账户余额抵扣（升级抵扣按剩余有效期与剩余流量较低比例计算，公式不变），余额部分以 D1 流水 `balance_payment` 记账并在同一事务内扣减；余额不足时订单金额为差额，余额已抵扣部分记录在订单 `metadata.balanceAppliedMinor`，订单关闭或过期时以 `balance_refund` 幂等退回。
- 支持的订单终态为 `PAY_SUCCESS` 和 `ORDER_CLOSE`；处理中状态确认接收但不结算。Webhook 投递可能乱序；若成功通知到达时本地订单已标记为失败或过期，应用会请求并验签 Waffo Order Inquiry，以返回的终态核对订单金额和币种后再结算，查询失败或仍未终态时返回失败回执供 Waffo 重试。重复关闭通知对已失败/过期订单幂等确认。
- 同一账户的管理员套餐修改、checkout 定价及支付结算通过 D1 lease 串行化；升级抵扣在锁内基于最新用户套餐与用量重新计算，抵扣公式不变。支付成功后以订单创建时保存的套餐快照结算，因此有效的待付款订单若在管理员修改套餐后完成付款，仍会应用该订单快照。
- 账户余额当前是单一数值，不区分币种；余额抵扣按套餐币种直接使用，跨币种套餐应避免依赖余额。
- 人工充值/退款不经过 Waffo：充值订单直接记为 `paid`、退款订单记为 `refunded`，金额和币种由管理员填写；两者都只调整本地余额并写流水，不会产生真实收付款。接口为 `POST /api/admin/users/:id/balance`，需管理员会话和同源请求。人工充值订单不计入仪表盘“本月收入”。
- 当前只支持 Waffo，不要把未接通的其他支付渠道设置到调用方。真实商户 webhook、完整 Inquiry payload 和 Waffo 重试行为尚未进行商户环境端到端验证；本地 Inquiry/回调测试使用签名模拟响应，不访问 Waffo 沙箱或生产 API。

## 数据库迁移与发布

迁移仅在创建/使用 D1 时执行。先审阅 `migrations/` 中待应用 SQL，再备份/导出并核对数据库目标；`--remote` 会写入远程数据库，本仓库没有自动执行生产迁移或商户交易。

本地迁移：

```bash
npm run db:local
```

部署前检查远程待迁移项、导出备份，然后由有生产权限的操作者人工应用迁移：

```bash
npx wrangler d1 migrations list 3xui-manager --remote
npx wrangler d1 export 3xui-manager --remote --output d1-before-deploy.sql
npm run db:remote
```

远程迁移确认前，须核对 Wrangler 登录账号、数据库名/ID、备份文件可用性与当前数据恢复责任人。之后构建并部署：

```bash
npm run typecheck
npm test
npm run build
npx wrangler deploy
```

部署后由运维人员检查 `GET /api/health`、管理员引导/登录、节点连通性、Cron 执行日志、Waffo 沙箱回调和 D1 计数。不要将支付成功重定向当作付款凭证；以签名验证后的服务端 webhook 与订单状态为准。

### 回滚

- Worker 代码版本和 D1 schema/data 是分开的：只回滚 Worker 不会撤销已应用的 D1 migration。若 migration 已应用，先评估旧版代码与新 schema 的兼容性，优先用向前修复避免 schema 降级。
- Cloudflare D1 Time Travel 可在可用保留期内恢复到分钟级时间点。**恢复会原地覆盖数据库，属于破坏性操作**；须由有权限人员审批、停止写入、确认时间点并先保留当前状态，再手工执行：

  ```bash
  npx wrangler d1 time-travel info 3xui-manager --timestamp="<RFC3339时间>"
  npx wrangler d1 time-travel restore 3xui-manager --timestamp="<RFC3339时间>"
  ```

- Free 计划 Time Travel 保留期为 7 天，Paid 计划为 30 天；应以 Cloudflare 当前套餐和官方文档为准。长期保留需另行配置定期导出到独立存储。迁移应用时 Wrangler 会捕获备份，但这不替代变更前独立导出与恢复演练。

## 存储与边缘平台限制

- **Cloudflare D1（生产推荐/必需能力）**：原子流量采样、用量事件幂等应用、配额执行及订单结算锁依赖 D1。Cron 每分钟触发；每轮最多处理 8 个节点，并发上限为 4，节点更多时轮转采样。面板不可达或同步失败会在后续 Cron 重试；实际配额执行延迟还取决于采样轮转、D1 事件积压及 3X-UI 可用性。
- **KV（受限模式）**：可用于通用记录读写，但 `KvStore` 的 lease 是非原子读后写，不能提供 D1 级并发结算/事件幂等保证。当前支付 checkout 会拒绝非 D1 存储；流量采集会停止并报告不可用。不要把 KV 部署描述为具备可靠计量或配额强制。
- **Tencent EdgeOne**：其官方产品资料介绍了 Pages/Makers 的全栈 Web 与函数能力，但本项目基于 Wrangler 配置、Workers bindings、D1 及 Cron；未验证 EdgeOne 对这些 API 和 bindings 的兼容性。需逐项确认平台运行时、D1 接入、定时触发、部署环境变量与 API 差异后才能移植。
- **Alibaba Cloud ESA / EdgeRoutine**：Alibaba 文档介绍的 EdgeRoutine 并非 Cloudflare Workers/D1 的兼容运行时；EdgeRoutine 文档还列有每次最多 4 个 subrequests、4 MB 程序包、受限 CPU/内存等限制，并说明旧 DCDN EdgeRoutine 不再对新用户开放。ESA 的 Functions and Pages 属不同产品路径；本项目尚未验证该路径与 Wrangler/D1 绑定兼容。不可直接将本项目视为可原样运行。

## 关键文件

- `wrangler.jsonc`：Worker、D1、KV、Cron 和部署配置（创建 Cloudflare D1 后替换占位 database ID）。
- `migrations/`：按序执行的 D1 SQL migrations。
- `src/services/traffic.ts`、`src/storage/d1.ts`：采样、累计、事件应用及配额同步。
- `src/adapters/payments/waffo.ts`、`src/api/payments.ts`：Waffo API/Webhook 契约和订单处理。
- `src/api/admin.ts`、`src/client/src/pages/App.tsx`：管理员 API 与界面。

## 资料来源

- 本地实现：`package.json`、`wrangler.jsonc`、`migrations/`、`src/services/traffic.ts`、`src/services/billing.ts`、`src/services/lifecycle.ts`、`src/services/notifications.ts`、`src/domain/defaults.ts`、`src/storage/d1.ts`、`src/api/payments.ts`、`src/api/user.ts`、`src/api/admin.ts`、`src/worker/index.ts`、`src/adapters/payments/waffo.ts`。
- Cloudflare D1 Wrangler commands: https://developers.cloudflare.com/d1/wrangler-commands/（访问日期：2026-11-14）。
- Cloudflare D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/（访问日期：2026-11-14）。
- Tencent EdgeOne Makers product introduction: https://edgeone.ai/document/160427672992178176（访问日期：2026-11-14）。
- Alibaba Cloud EdgeRoutine: https://help.aliyun.com/en/edge-security-acceleration/dcdn/user-guide/what-is-er（访问日期：2026-11-14）。
