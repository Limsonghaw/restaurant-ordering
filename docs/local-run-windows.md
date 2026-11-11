# Windows + Docker Desktop 本地运行说明

本文说明如何在 Windows 上用 Docker Desktop（WSL2）启动本仓库的本地 Supabase，再以 `npm run dev` 连接真实数据层，验证扫码下单和店家后台。命令一律在 **PowerShell** 中执行，并先 `cd` 到仓库根目录。

不要用 `npm start`（即 `next start`）：它会按生产环境处理，不能设置 `CUSTOMER_DB_SSL=disable`，本地 IP 规则也不可用。本地请只用 `npm run dev`。

本说明对应仓库当前 main（迁移至 `0009_customer_check_replay.sql`）。密钥只放在本机 `.env.local`，不要提交，也不要把真实生产密钥写进本文或仓库。

若只想看假数据预览、不启数据库，可按根目录 `README.md` 使用默认的 `NEXT_PUBLIC_DATA_SOURCE=mock`，无需 Docker。下面步骤针对 `NEXT_PUBLIC_DATA_SOURCE=supabase`。

## 1. 安装 Docker Desktop（WSL2）

1. 使用 Windows 10/11，并在 BIOS 中开启虚拟化。
2. 从 Docker 官网安装 Docker Desktop for Windows，安装时选择 **Use WSL 2 instead of Hyper-V**。
3. 如系统提示，先安装或启用 WSL2（可在「以管理员身份运行」的 PowerShell 中执行 `wsl --install`，然后重启）。
4. 启动 Docker Desktop，等到状态变为 Running。
5. 在普通 PowerShell 中检查：

```powershell
docker version
```

能看到 Client 和 Server 即表示引擎已就绪。若只有 Client、报错连不上引擎，先在系统托盘打开 Docker Desktop 并等待完成。

首次 `npx supabase start` 会拉取镜像，需要联网，可能要几分钟。

## 2. Node.js 版本

`package.json` 的 `engines` 要求 **Node.js >= 22**。GitHub Actions CI（`.github/workflows/ci.yml`）使用 **Node.js 24**，本地建议安装同一主版本，避免和 CI 行为不一致。

仓库没有 `.nvmrc`。可从 [https://nodejs.org](https://nodejs.org) 安装 Node.js 24，或使用 fnm / nvm-windows 安装 24 后打开新的 PowerShell：

```powershell
node -v
npm -v
```

`node -v` 应显示 v22 或更高（推荐 v24）。然后在仓库根目录安装依赖：

```powershell
npm ci
```

## 3. Supabase CLI

不要另装全局 CLI。本仓库 `devDependencies` 已锁定 `supabase` **2.122.1**，用 `npx` 调用即可，保证版本与 `package.json` 一致：

```powershell
npx supabase --version
```

应输出 `2.122.1`。本文后续命令均写 `npx supabase …`。

## 4. 启动本地数据库、迁移和种子数据

确认 Docker Desktop 已在运行后，在仓库根目录执行：

```powershell
npx supabase start
```

`supabase/config.toml` 里本地端口为：

- API：`54321`
- Postgres：`54322`
- Auth 的 `site_url`：`http://localhost:3000`（与下面的 `NEXT_PUBLIC_SITE_URL` 一致）

请使用完整的 `npx supabase start`，不要照抄 CI 数据库作业里的 `supabase start -x …`。CI 会排除 Auth、Realtime、Storage、Mailpit、Studio 等容器，那些排除项只为跑数据库测试；本地联调需要这些服务（注册邮件、实时订单、图片存储）。

`npx supabase start` 会自动应用 `supabase/migrations/` 下的迁移，当前为：

- `0001_init.sql`
- `0002_rpc.sql`
- `0003_security_rereview.sql`
- `0004_frontend_alignment.sql`
- `0005_purge_resend_boundary.sql`
- `0006_idempotency_device_binding.sql`
- `0007_customer_timeouts.sql`
- `0008_bill_qr_rotated.sql`
- `0009_customer_check_replay.sql`

查看本机地址和密钥（只在本机终端阅读，不要贴到聊天或提交）：

```powershell
npx supabase status
```

输出中会有 API URL、anon key、数据库连接串，以及 Studio、本地邮箱（Mailpit）等地址。邮箱确认请在 status 列出的本地邮箱界面里打开链接。`config.toml` 里 `[auth.email] enable_confirmations = true`，`[auth.sms] enable_signup = false`（本地不能用短信注册，请用邮箱）。

### 种子数据：仓库里没有

`supabase/config.toml` 的 `[db.seed] enabled = false`，仓库中也没有 `supabase/seed.sql` 或其它官方种子脚本（`lib/data/mock/seed.ts` 等只用于 `NEXT_PUBLIC_DATA_SOURCE=mock`，不会写入本地 Postgres）。因此 **`npx supabase start` 或 `npx supabase db reset --local` 之后库是空的**：没有示范店、示范桌、示范账号。店和桌要在后台自己注册、创建，见第 8 节。

若以后要清空并重新应用迁移（仍不会跑种子）：

```powershell
npx supabase db reset --local
```

重置后需重新设置下面的 `customer_api` 密码。

### 为本机设置 `customer_api` 密码

顾客接口通过 `CUSTOMER_API_DATABASE_URL` 以数据库角色 `customer_api` 连接。迁移会创建该登录角色，但 **密码不会写进迁移**，每个环境要自己设置。

在本机生成一段只含十六进制字符的密码（避免引号和 URL 编码问题），不要提交：

```powershell
$customerApiPassword = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$customerApiPassword
npx supabase db query --local "alter role customer_api with password '$customerApiPassword';"
```

把终端里打印出的密码稍后填进 `.env.local`。也可以用 `npx supabase status` 给出的超级用户 DB URL，用 psql 连上后执行 `\password customer_api`（只发送 SCRAM 校验值）。不要把 service_role 密钥或超级用户连接串写进应用的 `.env.local`。

## 5. 填写 `.env.local`

```powershell
Copy-Item .env.example .env.local
```

用编辑器打开 `.env.local`，按下面填写。`.gitignore` 已忽略 `.env*`（只保留 `.env.example`）。`NEXT_PUBLIC_` 变量会进入浏览器，只能填公开值。

| 变量 | 本地怎么填 |
| --- | --- |
| `NEXT_PUBLIC_DATA_SOURCE` | `supabase`（不要用 `.env.example` 里的默认值 `mock`） |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare 公开测试 site key，见第 6 节。推荐 `1x00000000000000000000AA`（总是通过）。留空时 supabase 构建会显示「验证组件未配置」，无法登录或下单。 |
| `NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES` | 保持 `MY` |
| `NEXT_PUBLIC_SUPABASE_URL` | `npx supabase status` 的 API URL，一般为 `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | status 输出的 anon key（占位，勿把真实值写入仓库） |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000`（不要尾斜杠；须与本机页面主机名一致，Turnstile 会校验 hostname） |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 若 status 另有 publishable key 则填写；没有就留空，应用会回退到 `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `CUSTOMER_API_DATABASE_URL` | `postgresql://customer_api:<上一步生成的密码>@127.0.0.1:54322/postgres`（端口来自 `config.toml` 的 `[db] port`。主机必须是 `127.0.0.1` 或 `localhost`，否则不能关 SSL） |
| `CUSTOMER_DB_SSL` | `disable`（仅限本机 loopback；默认 `require` 会连不上没有 TLS 的本地 Postgres） |
| `TRUST_LOCAL_IP` | 一般可省略。只有需要读取 `X-Forwarded-For` 时才设为 `1`，且只能出现在本地 |
| `QR_SIGNING_SECRET` | 本机随机值，不要用生产密钥。可用：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `CLIENT_HASH_SECRET` | 同上，另生成一串 |
| `DEVICE_COOKIE_SECRET` | 同上，另生成一串 |
| `TURNSTILE_SECRET_KEY` | 与 site key 配对的 Cloudflare 公开测试 secret，见第 6 节。推荐 `1x0000000000000000000000000000000AA` |
| `TWILIO_ACCOUNT_SID` | 本地留空（`config.toml` 里 Twilio Verify 为 `enabled = false`） |
| `TWILIO_VERIFY_SERVICE_SID` | 本地留空 |
| `TWILIO_AUTH_TOKEN` | 本地留空 |
| `UPSTASH_REDIS_REST_URL` | 见第 6 节；完整走通顾客流程时必填 |
| `UPSTASH_REDIS_REST_TOKEN` | 与上一行同时配置，缺一不可 |

改完 `.env.local` 后若 dev 已在跑，需要停掉再执行 `npm run dev`，公开变量才会生效。

## 6. Turnstile 测试 key 与 Upstash 的本地替代

### Turnstile

`.env.example` 列出的公开测试 **site key**（只用于开发和预览，生产构建会拒绝）：

- `1x00000000000000000000AA`：总是通过
- `2x00000000000000000000AB`：总是失败
- `3x00000000000000000000FF`：强制交互验证

服务端 `TURNSTILE_SECRET_KEY` 请使用 Cloudflare 官方测试 secret。本地推荐与「总是通过」site key 配对的 `1x0000000000000000000000000000000AA`（代码里把这一值视为官方 always-pass secret）。这些是 Cloudflare 公开测试凭据，不是本项目的生产密钥。

本地 Auth 的 `[auth.captcha] enabled = false`，GoTrue 不会校验注册/登录验证码；但前端在 supabase 模式下仍要有效的 site key 才能得到令牌。下单接口会调用 siteverify，并检查 `action === place_order` 以及返回的 hostname 是否等于 `NEXT_PUBLIC_SITE_URL` 的主机名，因此本地必须是 `http://localhost:3000`，并在浏览器用这个地址打开，不要改用 `127.0.0.1:3000`。

### Upstash

运行时限流固定走 `RedisRateLimiter`（Upstash Redis REST）。仓库里的 `MemoryRateLimiter` 只给测试使用，**没有**「本地改用内存限流」的环境变量开关。

`.env.example` 写明：`UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN` 必须同时有值。缺失或故障时：

- **下单**会要求 Turnstile；
- **菜单、报价、账单**等其它顾客接口会返回 429。

因此不配 Upstash 时，无法完成第 8 节的「扫码下单」清单。本地替代是：

1. 使用 Upstash 免费档 Redis（REST URL + TOKEN），只写入本机 `.env.local`，不要用生产实例、不要提交；或
2. 暂时留空，则只能调试店家登录等不经过上述顾客限流的页面，不能完整下单。

没有可在本仓库直接启动的本地 Upstash 兼容服务。

## 7. 启动前端

```powershell
npm run dev
```

对应 `package.json` 的 `dev` 脚本（`next dev`），默认 [http://localhost:3000](http://localhost:3000)。请用 `http://localhost:3000` 打开，以便和 `NEXT_PUBLIC_SITE_URL`、Auth `site_url` 一致。

## 8. 逐项验证清单

本地没有种子数据，请按顺序自己准备店铺和桌位。

1. **注册店家并完成资料**
   - 打开 `http://localhost:3000/register`，用邮箱注册（不要用手机号）。
   - 在 `npx supabase status` 给出的本地邮箱（Mailpit）里打开确认链接，再设置密码。
   - 登录后进入店家后台，打开 **设置**（`/store/settings`）：填写店名、地址、营业时间，打开「接受下单」，保存。当前 main 的设置页仍是手填图片路径，而数据库只接受 `{店铺id}/logo/{uuid}.扩展名` 这种上传路径，本地可先把店铺图片留空。
2. **桌位页**
   - 打开 **桌位**（`/store/tables`），新建一张桌子，确认能改名、停用/启用。
   - 查看或打印该桌二维码。链接应落在 `http://localhost:3000/t/…`（由 `NEXT_PUBLIC_SITE_URL` 拼接并签名）。把链接复制到本机浏览器打开，或用手机扫码（手机须能访问你电脑的该地址；若只在本机浏览器打开同一链接也可验证）。
3. **扫码下单**
   - 顾客页应能看到菜单。若还没有菜，先到 **菜单**（`/store/menu`）建分类和菜品，再刷新顾客页。
   - 加购、确认报价、完成 Turnstile（测试 key 会自动通过）、下单成功。
   - 若菜单一加载就 429：检查 Upstash 两项是否都已填写，并已重启 `npm run dev`。
4. **店家实时订单**
   - 打开 **实时订单**（`/store/live`），应出现刚才的新订单，并可接单/上菜。若页面一直断开，确认 `npx supabase start` 没有排除 Realtime，且 `.env.local` 的 `NEXT_PUBLIC_SUPABASE_URL` 与 status 的 API URL 一致（页面会按该地址连 WebSocket）。
5. **账单**
   - 打开 **账单**（`/store/bills`），应能看到该桌未结账单和订单明细，并可按页面流程结账。

以上五项都通过，即本地 supabase 主路径可用。

## 9. 停下和重置

停止前端：在运行 `npm run dev` 的终端按 `Ctrl+C`。

停止本地 Supabase，但保留数据卷（下次 `npx supabase start` 还在）：

```powershell
npx supabase stop
```

停止并删除数据卷（库、存储全部清空）：

```powershell
npx supabase stop --no-backup
```

只重置数据库到当前迁移（不清容器镜像；**不会**跑种子；`customer_api` 密码要重设）：

```powershell
npx supabase db reset --local
```

然后按第 4 节再执行一次 `alter role customer_api …`。若密码与 `.env.local` 里已有值相同，连接串不用改。

`.env.local` 不会被上述命令删除。不要用仓库里的「重置全部假数据」（那只作用于 mock）。

## 10. 常见错误

| 现象 | 可能原因与处理 |
| --- | --- |
| `docker version` 没有 Server / `npx supabase start` 说 Docker 未运行 | 先启动 Docker Desktop，等到 Running。确认安装时选了 WSL2。 |
| `npx supabase start` 端口被占用 | `54321`（API）或 `54322`（Postgres）已被占用。结束占用进程，或先 `npx supabase stop`。 |
| `npx supabase --version` 不是 2.122.1 | 先在仓库根目录执行 `npm ci`，不要用全局旧版 `supabase`。 |
| 连接顾客库失败、SSL 报错 | 本地应为 `CUSTOMER_DB_SSL=disable`，URL 主机为 `127.0.0.1` 或 `localhost`。若误用了 `npm start` 或设置了 `VERCEL_ENV` / `NODE_ENV=production`，进程会直接拒绝该开关。 |
| `Missing database configuration` | 未设 `CUSTOMER_API_DATABASE_URL`。 |
| 密码认证失败 | `db reset` 或 `--no-backup` 后未重新 `alter role`，或 URL 中的密码与角色密码不一致。 |
| `Missing server configuration` | 未填 `QR_SIGNING_SECRET`、`CLIENT_HASH_SECRET` 或 `DEVICE_COOKIE_SECRET`。 |
| 页面显示「验证组件未配置」 | supabase 模式下必须配置 `NEXT_PUBLIC_TURNSTILE_SITE_KEY`。 |
| 下单 `CAPTCHA_FAILED` | 检查测试 secret 是否与 site key 配对；用 `http://localhost:3000` 打开而不是 `127.0.0.1`；`NEXT_PUBLIC_SITE_URL` 须为 `http://localhost:3000`。 |
| 菜单 / 报价 / 账单 429，或一打开顾客页就失败 | 未同时配置 Upstash 两项，或 REST URL/TOKEN 无效。 |
| 注册收不到邮件 | 到 `npx supabase status` 列出的本地邮箱界面查看，不要等真实 SMTP。本地短信注册是关闭的。 |
| 登录后没有店铺 / 桌位是空的 | 预期现象：没有种子数据。需自己注册并在桌位页建桌。 |
| 实时订单不更新 | 用完整 `npx supabase start`（不要 `-x realtime`）；检查浏览器能否连到 API 的 WebSocket。 |
| 正式感的报错：「生产环境必须配置正式 Turnstile…」或不能关 SSL | 不要用 `npm start`，不要在本机 `.env.local` 设置 `VERCEL_ENV`。 |
| `NEXT_PUBLIC_DATA_SOURCE 必须明确设置为 mock 或 supabase` | `.env.local` 未生效或拼写错误，改完后重启 `npm run dev`。 |

