# Windows + Docker Desktop 本地运行说明

本文说明如何在 Windows 上用 Docker Desktop（WSL2）启动本仓库的本地 Supabase，再以 `npm run dev` 连接真实数据层，验证扫码下单和店家后台。命令一律在 **PowerShell** 中执行，并先 `cd` 到仓库根目录。

不要用 `npm start`（即 `next start`）：它会按 production 运行（`NODE_ENV=production`），进程会拒绝 `CUSTOMER_DB_SSL=disable`、`TRUST_LOCAL_IP` 和 `LOCAL_MEMORY_RATE_LIMIT=1`，也读不到本地 IP 头。本地请只用 `npm run dev`（`next dev`）。`LOCAL_MEMORY_RATE_LIMIT` 只用于本机，不能配到 Vercel（包括 production 和 preview）：只要该开关为 `1`，且 `NODE_ENV=production` 或设置了 `VERCEL_ENV`（含 production、preview），进程会直接报错退出，不会静默忽略，也不会退回成不限流。

本说明对应已合并 PR #12 的 main（`c03f95d`，含设置页 logo 上传；迁移至 `0009_customer_check_replay.sql`）。密钥只放在本机 `.env.local`，不要提交，也不要把真实生产密钥写进本文或仓库。

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

### 端口默认对外可访问，请改成只让本机连接

本仓库锁定的 Supabase CLI **2.122.1** 在 `npx supabase start` 成功时会打印安全提示：所有服务绑在 `0.0.0.0` 上，不只是 localhost，因此同一局域网里的其它设备可能连得上本机的 API（`54321`）、Postgres（`54322`）以及 Studio、Mailpit 等一并发布的端口。CLI 把端口写成 `-p 主机端口:容器端口`，没有写成 `127.0.0.1:…`。本地库还使用共享默认密钥，Studio 等界面也没有额外认证，不要在不可信的网络（例如公共 Wi-Fi）上默认这么跑。

`config.toml` 只能改端口号，没有「只绑定 127.0.0.1」的选项。下面是已在官方文档或 CLI 2.122.1 源码里核对过的做法。

**1. 推荐：Docker Desktop 的默认绑定设置（4.52 起）**

Docker Desktop 官方说明：`docker run -p` 默认听在所有网卡（`0.0.0.0`）上，但可以在 Docker Desktop 的 Network 设置里改成默认只绑定 `localhost`（`127.0.0.1`）。4.52.0 起增加了端口绑定设置；发布说明里对应的界面名称是 **Localhost by default** 或 **Localhost only**。管理员也可以在 Settings Management 里配置 `portBindingBehavior`（`default-local-port-binding` 或更严格的 `local-only-port-binding`）。这是针对 Linux 容器的设置，会影响本机所有已发布的容器端口，不单是 Supabase。

步骤：

1. 确认 Docker Desktop 版本至少为 4.52（「About Docker Desktop」或 [发布说明](https://docs.docker.com/desktop/release-notes/#4520)）。
2. 打开 Docker Desktop → Settings → Network，把端口绑定设为 **Localhost only**（若没有该项，则用 **Localhost by default**）。
3. 保存设置。若 Docker Desktop 提示需要重启引擎或应用，按提示操作。
4. 在仓库根目录执行 `npx supabase stop`，再执行 `npx supabase start`，让容器按新的默认绑定重新发布端口。改设置前已经在跑的容器不会自动改绑定。

改完后，`docker ps` 里这些端口应显示为 `127.0.0.1:54321`、`127.0.0.1:54322`（以及 `[::1]`），而不是 `0.0.0.0:…`。前端仍用 `http://localhost:3000` 即可。

**2. Windows 防火墙**

Docker Desktop 官方说明：容器的入站连接会经过主机上的 `com.docker.backend.exe`，可以用 Windows Defender Firewall 或企业防火墙对该进程允许或拒绝入站。官方文档没有给出「只允许本机访问 54321/54322」的逐步规则，本文不编写具体命令。若要用防火墙作补充，请按上述官方说明自行配置，并在改完后验证局域网内其它设备已连不上这些端口。

**3. CLI 的 `--network-id`**

CLI 2.122.1 有全局参数 `--network-id`，让 `npx supabase start` 使用你预先创建的 Docker 网络，而不是它自动生成的网络。Docker Engine 文档还说明：创建自定义 bridge 网络时可加上 `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`，未指定主机地址的 `-p` 就会默认绑到回环地址。这两段都是官方或源码里有的，但 **Docker Desktop for Windows 的官方文档没有确认该组合在 Desktop 上一定生效**（Desktop 通过自己的后端转发已发布端口），因此这里不把它当作 Windows + Docker Desktop 的推荐做法。

若 Docker Desktop 低于 4.52、找不到上述设置，或无法确认端口已改绑到 `127.0.0.1`，请只在可信的网络里运行本地栈，用完后执行 `npx supabase stop`。

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

输出中会有 API URL、anon key、数据库连接串，以及 Studio、本地邮箱等地址。本地邮箱对应 CLI 可排除的容器名是 `mailpit`（部分 `status` 输出仍可能标为 Inbucket）。邮件确认请在该界面打开链接，不需要真实 SMTP。`config.toml` 里 `[auth.email] enable_confirmations = true`，`[auth.sms] enable_signup = false`，注释写明本地在配置短信服务商之前保持关闭、**没有测试 OTP**，因此不能用短信或本地测试号码注册，请用邮箱。

### 种子数据：仓库里没有

`supabase/config.toml` 的 `[db.seed] enabled = false`，仓库中也没有 `supabase/seed.sql` 或其它官方种子脚本（`lib/data/mock/seed.ts` 等只用于 `NEXT_PUBLIC_DATA_SOURCE=mock`，不会写入本地 Postgres）。因此 **`npx supabase start` 或 `npx supabase db reset --local` 之后库是空的**：没有示范店、示范桌、示范账号。店和桌要在后台自己注册、创建，见第 8 节。

若以后要清空并重新应用迁移（仍不会跑种子）：

```powershell
npx supabase db reset --local
```

重置后需重新设置下面的 `customer_api` 密码。

### 为本机设置 `customer_api` 密码

顾客接口通过 `CUSTOMER_API_DATABASE_URL` 以数据库角色 `customer_api` 连接。迁移会创建该登录角色，但 **密码不会写进迁移**，每个环境要自己设置。

推荐在已经 `Copy-Item .env.example .env.local`（见第 5 节）并完成 `npx supabase start` 之后，执行：

```powershell
npm run db:local-customer-password
```

脚本会生成一段只含十六进制字符的随机密码（也可用环境变量 `CUSTOMER_API_PASSWORD` 指定，同样只能是字母或数字），把 SQL 从标准输入交给 `npx supabase db query --local`（密码不会出现在命令行参数里），并把 `CUSTOMER_API_DATABASE_URL` 写进本机 `.env.local`（该文件已被 gitignore，不要提交）。脚本不会在终端打印连接串或密码。若还没有 `.env.local`，请先按第 5 节复制 `.env.example` 再重新执行，不要让脚本把密钥打到屏幕上。

也可以手动设置：

```powershell
$customerApiPassword = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 把 SQL 从标准输入传入，避免密码出现在命令行参数里
@"
alter role customer_api with password '$customerApiPassword';
"@ | npx supabase db query --local
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
| `CUSTOMER_DB_SSL` | `disable`。本地 Supabase 的 Postgres 没有 SSL；默认 `require` 会连不上。该值仅在主机为 `localhost` 或 `127.0.0.1`、且非生产环境时才会真正关闭 SSL |
| `TRUST_LOCAL_IP` | 要测 IP 限流时设为 `1`（只在非生产环境生效，生产或设置了 `VERCEL_ENV` 会直接报错）。设为 `1` 后才读取 `X-Forwarded-For` 的首地址，没有再用 `x-real-ip`。不设也能跑：`npm run dev` 时仍会尝试读 `x-real-ip`，直接用浏览器访问通常没有这个头，IP 会记成 `unknown`，所有请求共用一个限流桶 |
| `QR_SIGNING_SECRET` | 本机随机值，不要用生产密钥。可用：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `CLIENT_HASH_SECRET` | 同上，另生成一串 |
| `DEVICE_COOKIE_SECRET` | 同上，另生成一串 |
| `TURNSTILE_SECRET_KEY` | 与 site key 配对的 Cloudflare 公开测试 secret，见第 6 节。推荐 `1x0000000000000000000000000000000AA` |
| `TWILIO_ACCOUNT_SID` | 本地留空（`config.toml` 里 Twilio Verify 为 `enabled = false`） |
| `TWILIO_VERIFY_SERVICE_SID` | 本地留空 |
| `TWILIO_AUTH_TOKEN` | 本地留空 |
| `LOCAL_MEMORY_RATE_LIMIT` | 本地完整走通顾客流程、又不想注册 Upstash 时设为 `1`（必须显式写成 `1`，默认关闭）。只用于本机 `npm run dev`，**不要写进 Vercel 环境变量**。`NODE_ENV=production` 或设置了 `VERCEL_ENV`（production / preview 等）时，只要开关为 `1` 就会直接报错，不会静默忽略或取消限流。已同时配置 Upstash 两项时仍走 Upstash，不启用内存限流 |
| `UPSTASH_REDIS_REST_URL` | 本地可留空；若填写则必须与下一行同时配置，此时走 Upstash 而不走内存限流 |
| `UPSTASH_REDIS_REST_TOKEN` | 与上一行同时配置，缺一不可 |

改完 `.env.local` 后若 dev 已在跑，需要停掉再执行 `npm run dev`，公开变量才会生效。

## 6. Turnstile 测试 key 与 Upstash 的本地替代

### Turnstile

`.env.example` 列出的公开测试 **site key**（只用于开发和预览，生产构建会拒绝）：

- `1x00000000000000000000AA`：总是通过
- `2x00000000000000000000AB`：总是失败
- `3x00000000000000000000FF`：强制交互验证

服务端 `TURNSTILE_SECRET_KEY` 请使用 Cloudflare 官方测试 secret。本地推荐与「总是通过」site key 配对的 `1x0000000000000000000000000000000AA`。这些是 Cloudflare 公开测试凭据，不是本项目的生产密钥，**只用于本地或预览测试**。

本地推荐打开 `LOCAL_MEMORY_RATE_LIMIT=1`（见下节），这样菜单、报价、账单和下单的限流阈值与 Upstash 版相同，不必再注册 Redis。即便如此，下单路径仍会校验 Turnstile（测试 secret 也要配对）；只用 always-pass 测试 secret 才会跳过 `cData` 检查，见下。

代码只对这一个官方 always-pass secret（`1x0000000000000000000000000000000AA`）跳过 `cData`（桌号 + `client_request_id`）绑定检查；其它测试 secret 不会跳过。即便使用 always-pass secret，仍会校验 `action === place_order` 以及返回的 hostname 是否等于 `NEXT_PUBLIC_SITE_URL` 的主机名。因此本地必须是 `http://localhost:3000`，并在浏览器用这个地址打开，不要改用 `127.0.0.1:3000`。跳过 cData 检查只为方便本地测试，不能用于生产。

本地 Auth 的 `[auth.captcha] enabled = false`，GoTrue 不会校验注册/登录验证码；但前端在 supabase 模式下仍要有效的 site key 才能得到令牌。

### 本地内存限流（不要配到 Vercel）

本地完整走通第 8 节的扫码下单，**不必注册 Upstash 账号**。在 `.env.local` 设置 `LOCAL_MEMORY_RATE_LIMIT=1`，并保持 `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN` 为空，限流会改用进程内的 `MemoryRateLimiter`。阈值和调用顺序与 Upstash 版相同（例如菜单 60 次/分钟、报价 30 次/分钟；下单时 `orderProbe` 仍在 `customer_check_replay` 之前）。Turnstile 校验和数据库层的限流（`table_db`、`device_db`、`ip_db`）不会因为这个开关变弱。

注意：

- 必须显式设为 `1` 才生效，默认关闭。`.env.example` 里只是注释，复制后不会自动打开，需要自己在 `.env.local` 写上。
- **只用于本机**。不要把这个变量配到 Vercel，也不要在托管环境打开。只要开关为 `1`，且 `NODE_ENV=production` 或设置了 `VERCEL_ENV`（包括 `production` 和 `preview`），启动时会直接报错退出；不会静默忽略该开关，也不会退回成不限流。
- 内存计数只存在于当前 `npm run dev` 进程里，重启后清零，多进程之间不共享。这只适合单机开发。
- 若 `.env.local` 里同时填了 Upstash 两项，仍走 Upstash，不启用内存限流。
- 开关关闭且未配置 Upstash 时，行为与原来一样：**下单**在限流不可用时会要求 Turnstile；**菜单、报价、账单**等其它顾客接口会返回 429，无法完成第 8 节清单。

改完该变量后须重启 `npm run dev`。

## 7. 启动前端

```powershell
npm run dev
```

对应 `package.json` 的 `dev` 脚本（`next dev`），默认 [http://localhost:3000](http://localhost:3000)。请用 `http://localhost:3000` 打开，以便和 `NEXT_PUBLIC_SITE_URL`、Auth `site_url` 一致。

## 8. 逐项验证清单

本地没有种子数据，请按顺序自己准备店铺和桌位。

1. **注册店家并完成资料**
   - 打开 `http://localhost:3000/register`，用邮箱注册（不要用手机号）。
   - 在 `npx supabase status` 给出的本地邮箱界面（Mailpit，有的输出仍可能叫 Inbucket）里打开确认链接，再设置密码。不需要真实邮件或短信服务商。
   - 登录后进入店家后台，打开 **设置**（`/store/settings`）：填写店名、地址、营业时间，打开「接受下单」。店铺图片用「上传图片」，选择 JPG、PNG 或 WebP（最大 2 MB），预览出现后再保存。文件会上传到迁移 `0001_init.sql` 创建的公共桶 `menu-images`，路径为 `{店铺id}/logo/{uuid}.扩展名`。可在 Studio 的 Storage 中打开该桶核对；顾客页也应能显示这张 logo。上传依赖 Storage，须使用完整的 `npx supabase start`（不要排除 `storage-api`）。菜单里的菜品图片同样进入此桶的 `{店铺id}/items/` 目录。
2. **桌位页**
   - 打开 **桌位**（`/store/tables`），新建一张桌子，确认能改名、停用/启用。
   - 查看或打印该桌二维码。链接应落在 `http://localhost:3000/t/…`（由 `NEXT_PUBLIC_SITE_URL` 拼接并签名）。把链接复制到本机浏览器打开，或用手机扫码（手机须能访问你电脑的该地址；若只在本机浏览器打开同一链接也可验证）。
3. **扫码下单**
   - 顾客页应能看到菜单。若还没有菜，先到 **菜单**（`/store/menu`）建分类和菜品，再刷新顾客页。
   - 加购、确认报价、完成 Turnstile（测试 key 会自动通过）、下单成功。
   - 若菜单一加载就 429：检查 `.env.local` 是否已设 `LOCAL_MEMORY_RATE_LIMIT=1`（或同时填写了有效的 Upstash 两项），并已重启 `npm run dev`。不要把该开关配到 Vercel。
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

然后按第 4 节再执行一次 `npm run db:local-customer-password`（或手动 `alter role customer_api …`）。若密码与 `.env.local` 里已有值相同，连接串不用改。

`.env.local` 不会被上述命令删除。不要用仓库里的「重置全部假数据」（那只作用于 mock）。

## 10. 常见错误

| 现象 | 可能原因与处理 |
| --- | --- |
| `docker version` 没有 Server / `npx supabase start` 说 Docker 未运行 | 先启动 Docker Desktop，等到 Running。确认安装时选了 WSL2。 |
| `npx supabase start` 端口被占用 | `54321`（API）或 `54322`（Postgres）已被占用。结束占用进程，或先 `npx supabase stop`。 |
| 局域网里其它设备能连上 `54321` / `54322` | CLI 默认把服务绑在 `0.0.0.0`。按第 4 节把 Docker Desktop（4.52 起）的端口绑定设为 Localhost only 或 Localhost by default，保存后再重新 `npx supabase start`。找不到该设置时，只在可信网络运行，用完执行 `npx supabase stop`。 |
| `npx supabase --version` 不是 2.122.1 | 先在仓库根目录执行 `npm ci`，不要用全局旧版 `supabase`。 |
| 连接顾客库失败、SSL 报错 | 本地应为 `CUSTOMER_DB_SSL=disable`，URL 主机为 `127.0.0.1` 或 `localhost`。若误用了 `npm start` 或设置了 `VERCEL_ENV` / `NODE_ENV=production`，进程会直接拒绝该开关。 |
| `Missing database configuration` | 未设 `CUSTOMER_API_DATABASE_URL`。 |
| 密码认证失败 | `db reset` 或 `--no-backup` 后未重新 `alter role`，或 URL 中的密码与角色密码不一致。 |
| `Missing server configuration` | 未填 `QR_SIGNING_SECRET`、`CLIENT_HASH_SECRET` 或 `DEVICE_COOKIE_SECRET`。 |
| 页面显示「验证组件未配置」 | supabase 模式下必须配置 `NEXT_PUBLIC_TURNSTILE_SITE_KEY`。 |
| 下单 `CAPTCHA_FAILED` | 检查测试 secret 是否与 site key 配对；用 `http://localhost:3000` 打开而不是 `127.0.0.1`；`NEXT_PUBLIC_SITE_URL` 须为 `http://localhost:3000`。 |
| 菜单 / 报价 / 账单 429，或一打开顾客页就失败 | 本地应设 `LOCAL_MEMORY_RATE_LIMIT=1` 并重启 `npm run dev`；或同时配置有效的 Upstash 两项。开关关闭且未配 Upstash 时，这些接口会 429。不要把该开关配到 Vercel。 |
| 注册收不到邮件 | 到 `npx supabase status` 列出的本地邮箱界面查看，不要等真实 SMTP。本地短信注册是关闭的。 |
| 登录后没有店铺 / 桌位是空的 | 预期现象：没有种子数据。需自己注册并在桌位页建桌。 |
| 实时订单不更新 | 用完整 `npx supabase start`（不要 `-x realtime`）；检查浏览器能否连到 API 的 WebSocket。 |
| 正式感的报错：「生产环境必须配置正式 Turnstile…」、不能关 SSL，或提示 `LOCAL_MEMORY_RATE_LIMIT is local-only` | 不要用 `npm start`，不要在本机 `.env.local` 设置 `VERCEL_ENV`。`LOCAL_MEMORY_RATE_LIMIT` 只能用于本地，不能配到 Vercel。 |
| `NEXT_PUBLIC_DATA_SOURCE 必须明确设置为 mock 或 supabase` | `.env.local` 未生效或拼写错误，改完后重启 `npm run dev`。 |
| 设置页或菜单上传图片失败 | 确认用了完整 `npx supabase start`（含 Storage），文件为 JPG/PNG/WebP 且不超过 2 MB。对象应出现在 Studio → Storage → `menu-images`。 |
| 本地 IP 限流测不出来 / 所有人共用限额 | 直接访问 `next dev` 时 IP 常为 `unknown`。要测按 IP 的限流，在 `.env.local` 设 `TRUST_LOCAL_IP=1` 并重启 `npm run dev`，再用带 `X-Forwarded-For` 的请求。不要在生产环境设置该变量。 |

