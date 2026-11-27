<div align="center">
  <img src="../public/favicon.svg" width="112" height="112" alt="3XUI Manager" />

  <h1>3XUI Manager</h1>

  <p><em>Manage 3X-UI nodes, plans, subscriptions and billing on Cloudflare Workers</em></p>

  <p>A single-origin full-stack platform: Hono API + React dashboard + D1 metering and settlement.</p>

  <p>
    <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-3DA639" alt="License" /></a>
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=0B1220" alt="React" />
    <img src="https://img.shields.io/badge/Hono-4.x-E36002" alt="Hono" />
    <img src="https://img.shields.io/badge/D1-SQLite-003B57?logo=sqlite&logoColor=white" alt="Cloudflare D1" />
  </p>

  <p>
    <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/PIKACHUIM/3XUI-Manager">
      <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
    </a>
  </p>
  <p><sub>The one-click deploy only creates the Worker. D1, database migrations and Worker secrets still need to be configured below.</sub></p>

  <p>
    <a href="../README.md">简体中文</a> ·
    <a href="./README_zh-TW.md">繁體中文</a> ·
    <strong>English</strong> ·
    <a href="./README_ja.md">日本語</a> ·
    <a href="./README_ko.md">한국어</a>
  </p>

  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#deploy-to-cloudflare">Deploy</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#notes">Notes</a>
  </p>
</div>

## Overview

3XUI Manager brings day-to-day 3X-UI operations into one Cloudflare Worker: node probing, inbound and client synchronization, plans and users, orders and balances, traffic metering, quota enforcement, and Clash / V2Ray / SIP008 subscription output.

It is **not** a replacement for the 3X-UI panel. It is a management layer that talks to panels through the 3X-UI HTTP API. The dashboard, user portal, API and webhooks are served from the same origin, so they do not need to be split across domains.

It is intended for self-hosting, a single administrator, or a small team operating multiple 3X-UI nodes.

## Features

| Area | Capabilities |
| --- | --- |
| **Nodes & inbounds** | Register and probe multiple nodes; import inbounds from 3X-UI; edit inbounds in sections that mirror the panel; preserve unknown JSON keys |
| **Subscriptions** | Clash / Mihomo YAML, V2Ray Base64 and Shadowsocks SIP008; a manual `选择节点` (`Select nodes`) group; mainland-first ordering; ETag / 304 |
| **Users & plans** | Registration, login and email verification; free plan; plan-to-inbound bindings; balance-first upgrades; admins can create users and assign plans |
| **Metering & quota** | Per-minute traffic sampling; multipliers and traffic resets; idempotent D1 events; disable clients on exhaustion and retry on later Cron runs |
| **Orders & payments** | Waffo checkout, signature verification, webhooks and order inquiry; D1 settlement leases; manual credit / refund creates `manual` orders and ledger entries |
| **Operations** | In-app notifications, optional email retries, referral rewards, account retention cleanup, Cron lifecycle maintenance and health checks |
| **Experience** | 12 UI languages, Arabic RTL, light / dark / system themes, theme presets, responsive layout, search and pagination |
| **Security** | Session cookies, same-origin checks, encrypted sensitive fields, Turnstile for registration / check-in, `/api/health` capability checks |

### How subscriptions are generated

- **Clash / Mihomo**: generates the `选择节点` manual group and rule-category groups, without `url-test` auto-switching. Every category can still select a specific node.
- **Ordering**: mainland nodes come first, then the saved platform order within each group. Admin lists, user node lists and all subscription formats share the same ordering data.
- **Credentials**: only clients that were successfully synchronized to a node are emitted. A partially synchronized inbound only exposes confirmed nodes.
- **Caching**: responses carry an ETag and return 304 on revalidation to avoid retransmitting an unchanged profile.

### Metering and quota

Cron runs traffic sampling and entitlement reconciliation every minute. One run handles at most 8 nodes with concurrency 4; larger fleets rotate through batches. An unreachable panel or failed synchronization is never treated as healthy, and affected clients are retried on later runs.

Usage events in D1 are idempotent. Quota disabling and payment settlement are serialized with leases so concurrent writes for the same account cannot overwrite each other.

## Quick start

### Requirements

- Node.js 20 or newer + npm
- A Cloudflare account (required for Workers deployment)
- A publicly reachable 3X-UI panel (HTTPS hostname + username/password or a scoped API token)
- Optional: a Waffo sandbox merchant configuration (only for payment testing)

<details>
<summary><strong>Local development</strong> (click to expand)</summary>

```bash
git clone https://github.com/PIKACHUIM/3XUI-Manager.git
cd 3XUI-Manager
npm ci
npm run db:local
npm run dev
```

`npm run db:local` applies `migrations/` to the local D1 database. `npm run dev` starts the local Workers preview through the Vite Cloudflare plugin and prints the actual URL.

Create a Git-ignored `.dev.vars` file in the project root with deployment-level secrets only:

```dotenv
ADMIN_BOOTSTRAP_TOKEN="<long random token for the first admin setup>"
APP_ENCRYPTION_KEY="<at least 32 characters; keep it permanently>"
```

> `APP_ENCRYPTION_KEY` encrypts panel credentials and sensitive settings. Before rotating it, design and verify a re-encryption path for existing ciphertext, or old credentials will become unreadable.

Business settings (Turnstile, email, payments, check-in and referral rules) are configured in the admin **System settings** page. Do not put them in `.dev.vars`, and never commit them.

</details>

### Configure the system

1. Open the local development URL and use **First-time admin setup** on the login page.
2. Enter `ADMIN_BOOTSTRAP_TOKEN` to create the administrator. After that, the token is no longer a login credential.
3. Add a 3X-UI node in **Nodes** and confirm that probing reports it online.
4. Create an inbound and a plan, then bind the plan to the inbound.
5. Configure Turnstile, Resend, Waffo and check-in rewards as needed.
6. Create a user or let one register, then verify subscription links and client synchronization.

## Deploy to Cloudflare

### 1. Create the D1 database

```bash
npx wrangler d1 create 3xuiwork-data
```

Put the returned `database_id` into `d1_databases[0].database_id` in `wrangler.jsonc`. Keep the binding name `DB`, the database name `3xuiwork-data` and `migrations_dir: "migrations"`.

> `wrangler.jsonc` in this repository may contain the deployer's real ID. When forking or self-hosting, replace it with your own D1 ID and do not reuse someone else's database.

### 2. Register Worker secrets

```bash
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
npx wrangler secret put APP_ENCRYPTION_KEY
```

These are deployment secrets only. Waffo API keys, merchant ID, signing key and platform public key are stored through **System settings** and are no longer read from Worker environment variables.

### 3. Apply database migrations

Migrations are never applied automatically. Review the pending SQL under `migrations/`, export a backup, then apply it as an operator with production access:

```bash
npx wrangler d1 migrations list 3xuiwork-data --remote
npx wrangler d1 export 3xuiwork-data --remote --output d1-before-deploy.sql
npm run db:remote
```

`--remote` writes to the remote database. Before running it, verify the Wrangler account, database name/ID, backup availability and the person responsible for recovery.

### 4. Build and deploy

```bash
npm run typecheck
npm test
npm run deploy
```

`npm run deploy` is equivalent to `npm run build && wrangler deploy`: it builds the frontend assets and then publishes the Worker, D1 binding and Cron trigger.

### 5. Post-deploy checks

1. Open `https://<your-domain>/api/health` and confirm D1 metering, quota enforcement and payment settlement are available.
2. Complete first-time admin setup and sign in; verify session cookies and same-origin requests.
3. Add and probe a node; the Worker cannot reach bare IPs, private networks or loopback addresses.
4. Set `publicAppUrl` in System settings to the final HTTPS origin, without a path, credentials, query or fragment.
5. Set the Waffo notification URL to `https://<your-domain>/api/webhooks/waffo` and complete a sandbox upgrade/callback test.
6. Check Cron logs, traffic sampling, subscription output and panel client state.

## Configuration

### Worker bindings and variables

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `DB` | D1 | Yes | Core storage for metering, quota, payment settlement and subscriptions |
| `ASSETS` | Static Assets | Yes | React dashboard and user portal assets |
| `APP_KV` | KV | No | Only for limited deployments; cannot replace D1 atomicity |
| `STORAGE_DRIVER` | Variable | Yes | Set to `d1` in production |
| `APP_NAME` | Variable | No | Default site title, overridable in System settings |
| `ADMIN_BOOTSTRAP_TOKEN` | Secret | First setup | Used only to create the first administrator |
| `APP_ENCRYPTION_KEY` | Secret | Yes | Encrypts panel credentials and sensitive settings; at least 32 characters |

### System settings

| Setting | Purpose |
| --- | --- |
| `publicAppUrl` | HTTPS origin used for payment redirects and webhook validation |
| `registrationEnabled` | Whether normal users may register |
| `turnstileSiteKey` / `turnstileSecretKey` | Turnstile checks for registration and check-in; the backend also validates the action and request hostname |
| `resendApiKey` / `resendFrom` | Optional email delivery; both are required before notification emails are sent |
| `waffoApiKey` / `waffoSigningKey` / `waffoPublicKey` | Waffo request signing and response verification |
| `waffoMerchantId` / `waffoEnvironment` | Merchant ID and environment; sandbox by default, `production` switches to the production API |
| Check-in reward range | Minimum and maximum in decimal GB; the server picks uniformly from the inclusive integer byte range |
| `referralPercent` / `referralValidityDays` | Referral reward percentage and validity period |
| Account cleanup settings | Inactive/no-plan thresholds and warning days; disabled by default |

Sensitive fields are encrypted with `APP_ENCRYPTION_KEY`. When an administrator reads settings, secret fields are returned as empty strings and `secretConfigured` reports whether they are set. On write, an omitted field or empty string keeps the old value, `null` clears it, and a non-empty string replaces it.

### Waffo payments

<details>
<summary>Waffo configuration, webhooks and transaction behavior</summary>

All payment settings are saved through the admin `PUT /api/admin/settings` endpoint.

| Setting | Meaning |
| --- | --- |
| `waffoApiKey` | API key issued by Waffo, sent as `X-API-KEY` |
| `waffoMerchantId` | Merchant ID written to `merchantInfo.merchantId` |
| `waffoSigningKey` | Merchant RSA private key, preferably PKCS#8, used to sign checkout/inquiry requests |
| `waffoPublicKey` | Waffo platform RSA public key, used to verify responses and webhooks |
| `publicAppUrl` | Generates `notifyUrl` and success/failure/cancel redirects; must be HTTPS and same-origin |
| `waffoEnvironment` | Omitted or non-`production` uses sandbox; `production` uses the production API |

Transaction behavior:

- Upgrades first consume the account balance. The balance portion is recorded as a `balance_payment` ledger entry and deducted in the same transaction. If the balance is insufficient, only the difference is charged through Waffo, with the applied amount stored in `metadata.balanceAppliedMinor`.
- When an order closes or expires, the applied balance is refunded idempotently as `balance_refund`. A late success notification re-checks the order before settlement.
- Terminal states are `PAY_SUCCESS` and `ORDER_CLOSE`. Processing states are acknowledged but not settled.
- Webhooks can arrive out of order. If a success notification arrives after an order was marked failed or expired, the app verifies a Waffo Order Inquiry response and checks amount and currency before settling.
- Manual admin credits/refunds bypass Waffo: credits are marked `paid`, refunds are marked `refunded`, and both only change the local balance and ledger. They do not move real money, and manual credits are excluded from "monthly revenue".
- Account balance is currently a single amount without a currency; avoid relying on balance for cross-currency plans.
- Tests use signed mock responses. Real merchant webhook/inquiry end-to-end validation is still required before production.

</details>

## Architecture

```mermaid
flowchart LR
  subgraph Clients["Clients"]
    B["Browser / Admin"]
    C["Clash / Mihomo"]
    V["v2ray / SIP008"]
  end

  subgraph Edge["Cloudflare"]
    W["Worker + Hono API"]
    A["React SPA / Static Assets"]
    D[("D1")]
    K[("KV (limited)")]
    T["Cron every minute"]
  end

  X["3X-UI panels"]
  P["Waffo"]
  M["Resend / Turnstile"]

  B --> W
  C --> W
  V --> W
  W --> A
  W --> D
  W --> K
  T --> W
  W --> X
  W --> P
  W --> M
```

| Layer | Technology |
| --- | --- |
| Runtime | Cloudflare Workers, Wrangler |
| Backend | Hono, TypeScript, D1, KV (limited) |
| Frontend | React 19, Vite, Tailwind CSS 4, Recharts, Lucide |
| Testing | Vitest, Wrangler local D1 platform |
| External systems | 3X-UI HTTP API, Waffo, Turnstile, Resend |

<details>
<summary><strong>Project structure</strong> (click to expand)</summary>

```text
src/
├─ api/          Hono routes: auth / user / admin / payments / subscriptions
├─ services/     billing, traffic, lifecycle, notifications, subscriptions, node sync, WireGuard
├─ adapters/     external systems: 3X-UI, Waffo
├─ domain/       types, defaults, encryption, WireGuard
├─ storage/      D1 / KV document storage
├─ worker/       Worker entry and Cron scheduling
└─ client/       React dashboard and user portal
migrations/      D1 SQL migrations
public/          icons and static assets
wrangler.jsonc   Worker / D1 / KV / Cron configuration
```

</details>

<details>
<summary><strong>Development scripts</strong> (click to expand)</summary>

| Command | Description |
| --- | --- |
| `npm run dev` | Start the local Workers preview |
| `npm run build` | Build the Worker and frontend assets |
| `npm run preview` | Preview the built `dist`, after running `build` |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Run Vitest tests |
| `npm run db:local` | Apply local D1 migrations |
| `npm run db:remote` | Apply remote D1 migrations (after manual confirmation) |

</details>

## Notes

- **Storage limit**: D1 is required in production. KV leases are non-atomic read-modify-write and cannot provide D1-level concurrent settlement or event idempotency. Checkout rejects non-D1 storage and traffic collection stops and reports unavailable.
- **Platform compatibility**: the project relies on Wrangler, Workers bindings, D1 and Cron. Tencent EdgeOne, Alibaba Cloud ESA and similar runtimes have not been verified and cannot be assumed to run this project unchanged.
- **Panel network**: panels must use an HTTPS hostname. Workers cannot fetch bare IPs, private networks or loopback addresses. If a firewall blocks the panel, allow Cloudflare egress or use a Cloudflare Tunnel.
- **Execution latency**: Cron runs every minute, handles at most 8 nodes per run with concurrency 4, and rotates through larger fleets. Actual timing also depends on panel availability and D1 event backlog.
- **Payment boundary**: only Waffo is integrated; sandbox is the default. Real merchant webhooks, the full inquiry payload and Waffo retries have not been validated end-to-end. A payment success redirect is not proof of payment; trust the signed server webhook and order state.
- **Login verification**: repository tests do not include real third-party credentials. Configure a valid Site Key, Secret Key, widget hostname and sending domain, and verify real delivery before going live.
- **Migrations and rollback**: rolling back the Worker does not undo applied D1 migrations. D1 Time Travel restore overwrites the database in place and is destructive; require approval, stop writes, confirm the timestamp and preserve the current state first.
- **Secrets**: keep `APP_ENCRYPTION_KEY` permanently. Never expose keys, panel passwords, UUIDs, subscription tokens or payment private keys in logs, issues, screenshots or commits.

<details>
<summary><strong>FAQ</strong> (click to expand)</summary>

| Symptom | Check first |
| --- | --- |
| `/api/health` reports D1 unavailable | `DB` binding, `database_id`, applied migrations |
| Subscription returns 422 | Whether an enabled, plan-eligible client was successfully synchronized; check inbound bindings and `syncedNodes` |
| Panel probe times out | HTTPS hostname, Cloudflare egress allowed by the firewall, no bare IP/private address |
| `Waffo returned an unverified response` | `waffoPublicKey` is the current platform key and `waffoSigningKey` matches the merchant |
| No verification email | `resendApiKey` and `resendFrom` are both set and the sending domain is verified |
| Admin cannot sign in | First setup uses `ADMIN_BOOTSTRAP_TOKEN`; afterwards use the created admin email and password |
| Nodes still fail after subscription update | Update the subscription in the client, not just refresh the node list; then check panel clients and node sync state |

</details>

## License

This project is licensed under [AGPL-3.0](../LICENSE).

If you deploy a modified version, provide the corresponding source code to your users as required by AGPL-3.0.

## Related projects

- [3X-UI](https://github.com/MHSanaei/3x-ui): panel and Xray management
- [Hono](https://hono.dev): web framework for edge runtimes
- [Cloudflare Workers](https://workers.cloudflare.com): runtime and edge network
- [Waffo](https://waffo.com): payment integration
