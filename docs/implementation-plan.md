# 实施计划（给 Cursor 云端编码代理）

依据：`docs/backend-design.md`（与 Page 同步，v9：已按安全审查（设计文档 §17）、第二轮复查（§18）、第二轮复查的复查 rereview-2 与前端 7 问（§21「更新 8」）修订；前端配合见 §19、§21）、`supabase/migrations/0001_init.sql`、`0002_rpc.sql`、`0003_security_rereview.sql`、`0004_frontend_alignment.sql`、`0005_purge_resend_boundary.sql`、`scripts/ops/create-admin.ts`、`docs/launch-checklist-twilio.md`、`docs/runbook-emergency-suspend-store.md`。

> v8 说明：PR1 已获准开工，**PR1 一节保持原样不改**。第二轮复查的数据库与 Auth 配置改动全部放在新增的 PR1b（排在 PR1 之后、PR2 / PR3 之前）。PR1 一节里与 v8 不一致的配置（`sms_sent = 60`、验证码 5 分钟、§18 引用、customer_api JWT 一项）以 PR1b 为准，由 PR1b 覆盖。
>
> v9 说明（更新 8）：
> - **分工**：页面和界面全部由前端 PR 做；后端 PR2–PR5 只做数据库、RLS、接口和 `lib/data/supabase/` 的真实实现。共用类型在 `lib/data/types.ts`，由前端 PR-A 先建并写入设计文档 §21.4 的 6 个类型，后端不重复添加，之后只追加新类型、不改名。middleware 拆开：判定函数 `lib/auth/guard.ts` 与 `lib/auth/safe-next.ts` 由前端 PR-C 按 §21.4 签名先写纯函数版，后端 PR2 接手填真实逻辑、不改签名；前端的 `middleware.ts` 负责跳转。
> - **rereview-2**：H-1、M-3、L-8、L-1 在 PR1b（0004）；M-1、M-2、L-3、L-7 在 PR2 开工前完成（本次已改文档与模板）；L-9 在 PR3；L-11 书面接受风险；M-4 与 23 项真实环境确认列为上线前验收（见文末）。标「待安全顾问复查」的是 H-1（前端第 3 问）与验证码重发限额（前端第 4 问）。
> - 每个 PR 都写了**开工条件**和**验收标准**；未满足开工条件不开分支。
>
> v9.1 说明（前端说明 v0.6，同属更新 8）：16 问逐条答复、9 处不一致逐处处理见设计文档 §21。代码层面的变化只有三处，都在 0004（PR1b）：`get_my_context()` 多返回 `password_set_at`；平台管理员未完成两步验证（aal1）调 admin_* 返回 **`MFA_REQUIRED`**（403），非管理员仍是 `FORBIDDEN`（新增私有函数 `private.assert_platform_admin()`）；**注册不收店名（L-5，已定）**，建店一律「我的餐厅」，店家登录后在店铺设置里改，「资料未填」只看 `is_profile_complete`。

> v9.2 说明（第三轮复查 rereview-3，2026-11-04）：
> - **中-1（L-4）按做法 A 修**：0001–0004 一行不改。管理员建号改为两步（`scripts/ops/create-admin.ts`：createUser 不带密码 → updateUserById 设密码 → signInWithPassword 自检），原因是 GoTrue admin createUser 在同一事务里是 INSERT → UPDATE app_metadata → Confirm UPDATE，Confirm 那一下会触发 0003 的首次验证擦除，`provisioned_by='ops'` 放行不了。PR1b 验收第 9 条后半句（真实环境管理员登录）移到 PR5 第 2d 项。
> - **低-6**：pgTAP 补两条（value_hash 列权限、不能直接 delete 拉黑），`plan(25)`。**低-4（L-2）**：新增 `0005_purge_resend_boundary.sql`（只重定义 `purge_unverified_users`），归入 PR1b；PR3 的 L-9 迁移顺延为 `0006_customer_timeouts.sql`。**低-3**：运维手册改 dollar quoting、审计记 `current_user` / `session_user`，并要求 Supabase 组织强制 MFA。**低-1、低-2、低-5** 进 PR2。

范围固定为 MVP F1–F12 + F21，**不扩展功能**。每个 PR 独立分支，合并顺序如下；接口编号（C/A/S/M/R）见设计文档 §8。

| 顺序 | PR | 开工条件 | 可并行 |
| --- | --- | --- | --- |
| 1 | PR1 数据库与测试基线 | 无（已开工，内容不变） | — |
| 1b | PR1b 复查修订：0003 + 0004 + 0005、Auth 配置、邮件模板、旧测试 5 处预期、运维手册 | PR1 合并 | 与前端 PR-A 并行 |
| 2 | PR2 认证接口 + 店家数据层（`lib/data/supabase/{me,store,menu,tables,images,blocks}`、A6、guard） | PR1b 合并；前端 PR-A 合并（types.ts）；前端 PR-C 合并（guard / safe-next 纯函数版）；M-1 / M-2 / L-3 / L-7 已写进文档（本次已完成） | 与 PR3 并行 |
| 2 | PR3 顾客接口 C1–C4（二维码、菜单、报价、下单、进度）+ L-9 | PR1b 合并；前端 PR-A 合并 | 与 PR2 并行 |
| 3 | PR4 订单与结账数据层 + Realtime hook | PR2、PR3 合并 | — |
| 4 | PR5 记录、统计、拉黑、平台管理、cron、管理员 MFA、CI | PR4 合并 | — |
| — | 上线前验收：M-4、23 项真实环境确认、未处理的低危项 | PR5 合并；前端全部页面合并 | — |

通用约定（所有 PR）：
- 技术栈：Next.js App Router + TypeScript strict + `@supabase/ssr` + `@supabase/supabase-js` + `zod`；限流 `@upstash/ratelimit` + `@upstash/redis`。
- 错误响应统一 `{"error":{"code","message","details"?}}`，错误码与 HTTP 状态以设计文档 §10 为准，集中在 `lib/api/errors.ts`。
- 金额一律整数仙（`*_cents`），费率整数基点（`*_bp`），前端显示时再格式化为 `RM 12.50`。
- 环境变量名以设计文档 §1 为准，写入 `.env.example`（不要提交真实值）。
- Vercel 上**不放** secret key / service_role key，也**不存在** `SUPABASE_JWT_SECRET`（v8，H-N2）。secret key 只在运维机器上给 `scripts/ops/*.ts` 用；定时任务一律 pg_cron。顾客流量一律走 `lib/supabase/customer.ts`（postgres.js，以 customer_api 登录角色经 Supavisor 连接，`CUSTOMER_API_DATABASE_URL`）。ESLint：`no-restricted-syntax` / CI grep 禁止出现 `SUPABASE_JWT_SECRET`；`no-restricted-imports` 只允许 `lib/supabase/customer.ts` 引入 `postgres`。**L-7：CI grep 只是提醒**，真正的控制是在 Dashboard 停用 legacy JWT secret，并定期审计 Vercel 各环境的环境变量清单。
- 页面与界面（`app/**/page.tsx`、组件、`middleware.ts`）一律由前端 PR 做。后端 PR 只交付数据库、RLS、Route Handler / Server Action、`lib/data/supabase/*`、`lib/auth/*`（guard.ts、safe-next.ts 接手前端 PR-C 的纯函数版，签名不变）与单元 / 集成测试；共用类型只往 `lib/data/types.ts` **追加**，不改名、不删字段。
- 店家端读店铺只用 `get_my_context()`（M1）或显式列；`stores(*)` / `select *` 在 0004 之后会报 42501（H-1）。
- Preview 与 Production 使用不同的 Supabase 项目，Preview 环境不放生产密钥。
- 顾客 Route Handler 一律 `export const dynamic = 'force-dynamic'`；日志不记录令牌 cookie、备注、Turnstile token。

---
## PR1 数据库与测试基线

**范围**
- `supabase init`；放入 `supabase/migrations/0001_init.sql`、`0002_rpc.sql`（直接使用本仓库文档附带的 v7 文件：已按安全审查报告修订，见设计文档 §17。照原样使用；如确需修改，必须同步更新设计文档与测试，且不得削弱 §17 列出的任何安全项）。
- `supabase/config.toml`：`[auth.email] enable_signup = true, enable_confirmations = true`；`[auth.sms] enable_signup = true, enable_confirmations = true, max_frequency = "60s"`；`[auth.sms.twilio_verify] enabled = true`，`account_sid` / `message_service_sid`（Verify Service SID）/ `auth_token` 用 `env(TWILIO_ACCOUNT_SID)` 等引用；`[auth.rate_limit] sms_sent = 60`（项目级每小时）；`[auth.sms.test_otp]` 放开发用测试号码（不真发短信）；验证码有效期在控制台设 5 分钟；`[auth.captcha] enabled = true`、`provider = "turnstile"`（secret 用 `TURNSTILE_SECRET_KEY`）；`[auth] enable_anonymous_sign_ins = false`；开发和测试阶段用 Supabase 自带发信（只能发给项目团队成员邮箱、每小时限额很低），正式发信域名上线前跟平台名称一起定；`site_url` / `additional_redirect_urls` 用 `NEXT_PUBLIC_SITE_URL`；Auth 邮件模板 recovery / confirm 链接改为 `/auth/confirm?token_hash=...&type=...&next=...`。
- `supabase/tests/`：
  - `rls_rpc.test.mjs` + `supabase_stub.sql`（PGlite 快速验证，已有 117 条断言，`node supabase/tests/rls_rpc.test.mjs`，输出 `RESULT 117 PASS, 0 FAIL`）；
  - 新增 pgTAP 版本 `supabase/tests/database/*.test.sql`，在 `supabase test db` 下跑同样的断言（真实 auth / storage schema）。
- `npm run db:types` → `supabase gen types typescript --local > lib/supabase/database.types.ts`。
- GitHub Actions：`supabase start` → `supabase db reset` → `supabase test db`。
- 在真实 Supabase（本地 CLI 或 Preview 项目）上确认 PGlite 测不到的部分：`\ddp` 默认权限、`grant customer_api to authenticator`、customer_api JWT 能被 PostgREST 接受（若项目使用非对称 JWT 签名密钥，改为 customer_api LOGIN 角色经 Supavisor 直连）、Realtime 私有频道、Auth CAPTCHA 与匿名登录开关；手机注册：已验证号码再次 signUp 时的返回（防枚举）、验证码实际有效期。
- 短信服务商（设计文档 §18，推荐 Twilio Verify，待 Song Haw 确认）：开 Twilio 账号与 Verify Service；Verify 的 Geo Permissions 只开 Malaysia；控制台设余额告警；向 Twilio 确认马来西亚模板是否自动带 RM0 和品牌名。换服务商只改 config.toml 与环境变量。

**验收标准**
1. `supabase db reset` 无错误；13 张表（含 order_client_meta）、视图 `bill_overview`、桶 `menu-images`（2 MB，jpeg/png/webp）存在；`supabase_realtime` 发布包含 orders、bills。
2. RLS 隔离：用户 A 查询 B 店的 stores / items / categories / dining_tables / orders / bills 均返回 0 行；A 向 B 店 insert 报 RLS 违规；A 调 `update_order_status` 改 B 店订单报 `NOT_FOUND`。
3. 权限（H2、M1、M7、L3）：anon 对 public / private 任何函数都没有 EXECUTE；authenticated 只能执行 18 个白名单函数；customer_api 只能执行 4 个 customer_*，没有任何表权限；service_role 不能执行 customer_*；anon 在 public 零表授权；所有表开 RLS；bill_overview 对 authenticated 只有 SELECT；迁移后新建的表默认零权限；所有函数都设置了 search_path。
3a. NULL 安全（M2）：`resolve_table` 传 NULL qr_version、`customer_place_order` 传 NULL 设备 / IP 哈希、`update_order_status` / `mark_bill_paid` / `admin_set_store_status` / `get_store_daily_stats` 传 NULL 一律 `VALIDATION_FAILED`，不会放行。
3b. 外键与路径（L2、L5、L6）：订单的 (bill_id, table_id) 必须和账单同桌；blocked_clients.source_order_id 只能是本店订单；items.image_path / stores.logo_path 指向别店路径被 CHECK 拒绝；Storage 三级目录或非法文件名被拒；authenticated 读不到 order_client_meta，orders 上没有设备 / IP 哈希列。
3c. Realtime（M8）：本店成员能加入 `store:{id}` 私有频道，别店账号不能；客户端 insert realtime.messages 被拒。
3d. 验证后才建店（M5）：未验证的邮箱 / 手机号用户没有 profile、店铺、成员；改其他字段不触发；email_confirmed_at 或 phone_confirmed_at 由空变为有值时建店，profiles.signup_channel 分别为 email / phone；重复验证不重复建店；匿名用户（is_anonymous=true）不建店。
3e. 首单审核字段（H1）：stores.require_first_order_approval 默认 false；店家 update 该列 → permission denied；任何角色置 true → CHECK `stores_first_order_approval_v1_ck` 拒绝。admin_list_stores 返回 owner_phone。
4. 停用店铺：管理员 `admin_set_store_status(A, 'suspended')` 后，A 店主 update items → `STORE_SUSPENDED`；调 `soft_delete_item` → `STORE_SUSPENDED`；select 仍可读；`customer_get_menu` → `STORE_SUSPENDED`。
5. 幂等：同一 `request_id` + 相同内容第二次调用返回 `replayed=true` 且 order.id 相同、订单数不增加；同一设备首次没收到令牌时重放会重新签发；相同 `request_id` + 不同内容 → `IDEMPOTENCY_KEY_REUSED`（details 不含 order_id）。
6. 一桌一张 open 账单：同桌第二单进入同一账单（seq_in_bill=2）；直接再插一张 open 账单违反 `bills_one_open_per_table_uq`；账单付款后的下一单开新账单（seq_in_bill=1）。并发：两个连接同时为同一空桌下单，结果只有 1 张 open 账单（pgTAP 或脚本用 `dblink`/两个客户端验证）。
7. 状态机：new→accepted→served 通过；served→accepted、served→cancelled → `INVALID_STATUS_TRANSITION`；p_expected 过期 → `ORDER_STATUS_CONFLICT`；取消已付款账单内订单 → `ORDER_BILL_CLOSED`；已取消订单不计入 bills.subtotal_cents。
8. 下单校验：售完 → `ITEM_UNAVAILABLE`（details.items[].reason='sold_out'）；价格不符 → `PRICE_CHANGED`（details 含 client/current 单价）；店家关闭接单 → `STORE_CLOSED`，但 `customer_get_menu` 仍返回菜单。
9. 金额算例（`private.calc_bill`；费率由店家自设，SST 对小计+服务费征收，第一版不做 5 仙进位）：
   - 店家通过 stores 列级更新把 service_charge_bp 设为 1000、sst_bp 设为 600 成功；把 cash_rounding 设为 true 被 CHECK 拒绝；
   - 小计 4560 → 服务费 456、SST 301、取整 0、合计 5317；
   - 小计 4620 → 462 / 305 / 0 / 5387；
   - `mark_bill_paid(bill, 1)` → `BILL_TOTAL_CHANGED`；`mark_bill_paid(bill, 5387)` 成功且快照列写入；再次调用 → `BILL_ALREADY_PAID`。
9a. 令牌作用域（H1）：同桌第二台设备下单得到自己的令牌；`customer_get_bill` 用 A 设备令牌只返回 A 设备的订单（scope=own_orders，amounts_basis=own_orders）；A 设备令牌换成 B 设备哈希或别的桌子 → `BILL_TOKEN_INVALID`；不带令牌只返回 `table_in_use` 布尔值（L7）。
9b. 结账即清台（H1、M4）：`mark_bill_paid` 返回 tokens_revoked，该账单全部令牌 revoked_reason=bill_paid；之后用旧令牌 → 410 `BILL_TOKEN_EXPIRED`，details.reason='bill_paid'；`table_in_use=false`；下一单开新账单。
9c. 重置桌码（H1）：`rotate_table_qr` 后 qr_version+1，旧版本二维码 → `TABLE_INVALID`，旧令牌 → 410 reason='qr_rotated'，写审计 table.qr_rotated；别店账号 → `NOT_FOUND`；店铺停用 → `STORE_SUSPENDED`。
9d. 数据库兜底限流（M3）：同桌 10 分钟第 11 单 → `RATE_LIMITED`（scope table_db）；同店同 IP 第 21 单 → ip_db；同店同设备第 11 单 → device_db；require_captcha=true 且 p_captcha_verified=false → `CAPTCHA_REQUIRED`；被拉黑设备 → `DEVICE_BLOCKED`。
9e. 报价溢出（L4）：超过金额上限的购物车 `customer_quote` 返回 limit_exceeded=true、估算金额为 null，不报错。
10. 统计：付款后 `get_store_daily_stats(今天 UTC+8)` 的 `revenue_cents` = 当天 paid 账单 total 之和（含服务费、SST），`paid_bills` 返回 subtotal / service_charge / sst / rounding 合计，`open_bills` 返回实时金额。

## PR1b 复查修订（0003 + 0004 + 0005、Auth 配置、邮件模板、运维手册）

依据设计文档 §18（逐条）、§21（更新 8：rereview-2 与前端 7 问）与 §9f、§12、§19。**不改 PR1 的 0001 / 0002 / rls_rpc.test.mjs / supabase_stub.sql**（旧测试的预期变化以补丁文件提供，见下）。

**开工条件**：PR1 已合并。

**范围**
- `supabase/migrations/0003_security_rereview.sql`（直接使用本仓库文件）：H-N1 首次验证清空密码触发器、`profiles.password_set_at` 与 `on_auth_user_password_set`、`private.purge_unverified_users()` + pg_cron `purge-unverified-users`（`17 * * * *`，删除 24 小时未验证账号）；M-N1 `private.hook_before_user_created`（只收 `^601[0-9]{8,9}$`）；H-N2 customer_api 改 LOGIN 角色（connection limit 20、statement_timeout 3s、idle_in_transaction_session_timeout 5s、撤销 authenticator 成员关系）；M-N3 同 IP 两档；L-N1 `is_platform_admin()` 要求 aal2、`no_store`；L-N3 `orders.device_seq_in_bill`；L9 `resolve_table` for share。
- `supabase/migrations/0004_frontend_alignment.sql`（直接使用本仓库文件）：
  - **H-1（待安全顾问复查）**：stores 改列级 grant（除 status_reason 外全部列），店家读不到停用原因；`audit_logs_select` 排除 actor_type='admin' 的行；收回 `blocked_clients.value_hash` 的读取和直接 delete；`admin_list_stores` 继续返回原因。
  - **M-3**：`auth_wipe_password_on_confirmed_insert`（INSERT 时已验证也擦密码，只放行 `app_metadata.provisioned_by = 'ops'`）；`handle_new_user` 只在 ops 建号时于 INSERT 写 password_set_at。
  - **L-1**：首次验证时同时 `delete from auth.sessions where user_id = new.id`。
  - 前端问题：(a) `list_blocked_clients` / `unblock_client(p_block_id)`（按拉黑记录 id，不依赖 value_hash，写审计）、`block_client_from_order` 写审计；Q1 `customer_quote` 新字段；Q2 `stores.is_profile_complete`；Q5 `orders_store_served_idx`；Q6 tokens CHECK（bill_paid / qr_rotated）；Q7 `get_my_context()`（含 `password_set_at`）、`ensure_my_store()`；`private.assert_platform_admin()` → `MFA_REQUIRED` / `FORBIDDEN`（admin_list_stores、admin_set_store_status 改用它）；L-5：`handle_new_user` / `ensure_my_store` 不读 `user_metadata.store_name`，店名一律「我的餐厅」。
- `supabase/migrations/0005_purge_resend_boundary.sql`（rereview-3 低-4 / L-2，直接使用本仓库文件）：只 `create or replace private.purge_unverified_users()`，改为「最后一次发确认（`coalesce(confirmation_sent_at, created_at)`）超过 24 小时，**且**注册超过 25 小时」才删，A8 重发后的新链接不会被清理任务弄失效；短信注册若不写 `confirmation_sent_at`（需确认，清单第 20 项）就落在 25 小时下限。签名、definer、search_path、授权、pg_cron 任务都不变。
- customer_api 密码**不写进迁移，也不在 SQL 编辑器里写明文**（L-7）：每个环境（本地 / Preview / Production）各自 `openssl rand -base64 32` 生成，用 psql 连上后执行 `\password customer_api`（psql 只把 SCRAM 校验值发给服务器），再把连接串写进 Vercel 对应环境的 `CUSTOMER_API_DATABASE_URL`（Supavisor transaction 模式、端口 6543、用户名 `customer_api.<project-ref>`，见 `.env.example`）。
- `supabase/config.toml` 的 Auth 部分改写（以本节为准，覆盖 PR1 的 Auth 配置）：
  - `[auth] enable_anonymous_sign_ins = false, minimum_password_length = 8, password_requirements = "letters_digits"`（M-2：密码规则下沉到 GoTrue，Dashboard 同步设置）；`site_url = env(NEXT_PUBLIC_SITE_URL)`；本地 `additional_redirect_urls = ["http://localhost:3000/**"]`；Preview 项目在 Dashboard 填 `https://*-<vercel-team>.vercel.app/**`；**生产项目只填两个精确地址** `SITE/store`、`SITE/reset-password`（Supabase 官方建议生产用精确路径，L-3、清单第 21 项）；
  - `[auth.email] enable_signup = true, enable_confirmations = true, otp_length = 8, otp_expiry = 900, secure_password_change = true, max_frequency = "1m"`；
  - `[auth.sms] enable_signup = true, enable_confirmations = true, max_frequency = "60s"`；`[auth.sms.twilio_verify] enabled = true`（`env(TWILIO_ACCOUNT_SID)` / `env(TWILIO_VERIFY_SERVICE_SID)` / `env(TWILIO_AUTH_TOKEN)`）；
  - `[auth.rate_limit] sms_sent = 20, email_sent = 30, sign_in_sign_ups = 15, token_verifications = 15`（email_sent 只在配置了自定义 SMTP 后生效，M-4；前端第 4 问的数值，待安全顾问复查）；
  - `[auth.captcha] enabled = true, provider = "turnstile", secret = "env(TURNSTILE_SECRET_KEY)"`；
  - `[auth.hook.before_user_created] enabled = true, uri = "pg-functions://postgres/private/hook_before_user_created"`；
  - `[auth.email.template.confirmation|magic_link|recovery|email_change|reauthentication]` 指向 `supabase/templates/*.html`（L-3：`next={{ .RedirectTo | urlquery }}`；只有 token_hash 链接，不放数字验证码；注释里也不写模板变量）；
  - `[auth.sms.test_otp]` **只**在本地 / Preview 配置；禁止 `supabase config push` 到生产，生产 Auth 设置只在 Dashboard 改；Dashboard 确认 mailer / sms autoconfirm 关闭（M-3）。
- 旧测试的 **5 处**预期更新（叠加 0003 / 0004 后的预期变化，非 PR1 缺陷），以补丁 `docs/pr1b/rls_rpc.test.mjs.patch` 提供，在 PR1b 分支 `git apply`：
  1. asUser 的 JWT claims 加 `aal: 'aal2'`（L-N1）；
  2. 同店同 IP 第 21 单的预期从 `RATE_LIMITED` 改为 `CAPTCHA_REQUIRED`（details.scope = 'ip_db'，M-N3；报告写第 251 行，基线文件实际在第 249 行）；
  3. 「B 读不到 A 的店铺」由 `select *` 改为 `select id`（H-1 列级授权后 `select *` 报 42501）；
  4. H2 白名单追加 0004 的 4 个函数 `ensure_my_store`、`get_my_context`、`list_blocked_clients`、`unblock_client`；
  5. 「注册即验证建店，店名取 store_name」改为店名一律「我的餐厅」（L-5）。
  另外补丁让测试依次加载 `supabase_stub_rereview.sql`、0003、0004。
- 测试：`supabase/tests/rereview.test.mjs`（64，现叠加 0004 运行；管理员 aal1 的两条预期为 `MFA_REQUIRED`）、`rereview2.test.mjs`（31：M-3、L-1、L-8 全 schema 权限扫描；rereview-3 中-1 按 GoTrue 顺序模拟管理员建号 5 条、低-4 清理边界 7 条，低-4 段额外加载 0005）、`frontend_alignment.test.mjs`（88：前端问题 + H-1 + v0.6 的 password_set_at、MFA_REQUIRED、L-5、列清单）、`runbook_suspend.test.mjs`（30：直接执行运维手册里的 SQL；rereview-3 低-3 补 db_user / session_user 与单引号文本 3 条）+ `supabase_stub_rereview.sql`（PGlite）；`supabase/tests/database/auth_roles.test.sql`（pgTAP 25 条，`supabase test db`；rereview-3 低-6 补 value_hash 列权限、不能直接 delete 拉黑）。
- `docs/runbook-emergency-suspend-store.md`：管理员 TOTP 上线前，用 SQL Editor 紧急停用 / 恢复店铺。
- 上线设置：按 `docs/launch-checklist-twilio.md` 在 Twilio 控制台完成第 0–10 步；在 Supabase Dashboard 完成 Authentication → Hooks、Rate Limits、CAPTCHA、Secure password change、Password requirements；改用 publishable / secret key 后停用 legacy JWT secret。
- `.env.example` 按设计文档 §1 更新（已在本仓库）。

**验收标准**
1. `supabase db reset`（0001→0005）无错误；PGlite：`rls_rpc.test.mjs`（打补丁后）117、`rereview.test.mjs` 64、`rereview2.test.mjs` 31、`frontend_alignment.test.mjs` 88、`runbook_suspend.test.mjs` 30 条全过；`supabase test db` 中 `auth_roles.test.sql` 25 条全过。未打补丁的 PR1 基线 `rls_rpc.test.mjs` 在 0001 + 0002 上仍是 117 全过。
2. H-N1：未验证用户的 encrypted_password 在首次验证时被清空、password_set_at 为空；之后 updateUser 设密码 → password_set_at 有值；`select private.purge_unverified_users()` 只删「最后一次发确认超过 24 小时且注册超过 25 小时」的未验证用户（0005，低-4）；`cron.job` 中存在 `purge-unverified-users`。
3. H-N2：customer_api 能用 `CUSTOMER_API_DATABASE_URL` 登录并调用 4 个 customer_*；`select * from stores` → permission denied；PostgREST 请求 `Accept-Profile` / JWT role=customer_api 被拒（authenticator 不再是成员）；仓库与 Vercel 环境变量中没有 `SUPABASE_JWT_SECRET`；Dashboard 已停用 legacy JWT secret（截图）。
4. M-N1：用 publishable key 直接调 GoTrue `/otp` 传 `+6591234567` → 被 hook 拒绝（PHONE_NOT_SUPPORTED），Twilio Verify 日志里没有发送记录。
5. Twilio：按清单第 10 步测试马来西亚号码收到、+65 号码被 Geo permissions 拒绝；Geo permissions、Fraud Guard、Auto-recharge 关闭、Usage Triggers（每日 $30、每月 $150）截图附在 PR 描述里。
6. M-N4 / L-3：五个模板里都只有链接、没有数字验证码；链接 15 分钟后失效；在 Preview 用「忘记密码」走一遍，确认链接里的 next 是编码后的 `SITE/reset-password`，`/auth/confirm` 之后落在 `/reset-password`（不是回退到 `/store`）。
7. Supabase Rate Limits 页面数值与 config.toml 一致（截图）；生产项目 test OTP 为空；Password requirements 为 8 位、字母 + 数字（截图）。
8. H-1：店家（authenticated）`select status_reason from stores` → 42501；`select *` → 42501；读不到 actor_type='admin' 的审计行；读不到 blocked_clients.value_hash、不能直接 delete blocked_clients（pgTAP 低-6 两条）；平台管理员经 `admin_list_stores()` 能读到原因。
9. M-3：Preview 上临时打开 autoconfirm 用 `/signup` 带密码注册 → 密码被擦除、password_set_at 为空（测完立即关回）；PR1b 只验证「`provisioned_by = 'ops'` 的账号在 INSERT 时就已验证的情况下密码保留」（rereview2 M-3 段），以及 PGlite 按 GoTrue 顺序的模拟：createUser 带密码 → Confirm 后被擦（反例），两步建号 → 密码保留、password_set_at 有值（rereview2 中-1 段）。**真实项目里管理员账号能用密码登录，移到 PR5 第 2d 项**（rereview-3 中-1）。
10. 运维手册：在 Preview 按手册停用一个测试店铺再恢复，第 4 步的验证结果与手册表格一致。
11. v0.6：管理员 aal1 调 `admin_list_stores` / `admin_set_store_status` → `MFA_REQUIRED`（不改数据）；店家无论 aal1 / aal2 → `FORBIDDEN`；`get_my_context` 含 `password_set_at`；带 `store_name` 注册的店名仍是「我的餐厅」；店家可读 / 可改的 stores 列与设计文档 §21 表格完全一致。

## PR2 认证接口 + 店家数据层

**开工条件**：PR1b 已合并；前端 PR-A 已合并（`lib/data/types.ts` 与数据层接口已存在，含设计文档 §21.4 的 6 个类型）；前端 PR-C 已合并（`lib/auth/guard.ts`、`lib/auth/safe-next.ts` 按 §21.4 签名的纯函数版已存在）；rereview-2 的 M-1、M-2、L-3、L-7 已写进设计文档 §9f 与本计划（本次已完成）。

**范围**（不含任何页面；页面、`middleware.ts`、`/verify`、`/set-password`、`/auth/confirm` 都在前端 PR）
- `lib/supabase/{server,browser,middleware}.ts`（`middleware.ts` 里只刷新会话的辅助函数；**不再有 `lib/supabase/admin.ts`**，L-7：Vercel 上没有 secret key）。
- `lib/auth/guard.ts` 与 `lib/auth/safe-next.ts`：**接手**前端 PR-C 按设计文档 §21.4 签名写好的纯函数版，只填真实逻辑，**不改函数签名**（不另起新文件；判定在这里，前端 middleware 负责跳转）。guard：`getAuthState(supabase)` 调 `rpc('get_my_context')`（含 `password_set_at`）得到 `AuthState`（anonymous / needs_mfa / platform_admin / no_store / needs_password / ready，ready 带 storeId、storeStatus、isProfileComplete）；纯函数 `evaluateAccess(pathname, state)` 返回 allow 或跳转原因（login / mfa / admin_home / no_store / set_password / store_home）；`safe-next.ts` 的 `safeNext(next: string | null): string`（URL 解析，同源后取 pathname 比对白名单 `/reset-password`、`/set-password`、`/store`、`/store/*`，L-3）。
- `lib/api/errors.ts`（错误码表，含 `MFA_REQUIRED` 403、`UNSUPPORTED_MEDIA_TYPE` 415、`toErrorResponse`、PostgREST 映射：P0001→message、42501→FORBIDDEN、23505→按约束名、23514→VALIDATION_FAILED）、`lib/api/schemas.ts`（认证与店家表单的 zod）。
- 认证是**浏览器直连 Supabase Auth**（设计文档 §9f、§19），后端只提供封装和错误映射：A1 / A4 / A8 = `supabase.auth.signInWithOtp({ email | phone, options: { shouldCreateUser: true, captchaToken, emailRedirectTo } })`（**不传 data / store_name**，L-5），`emailRedirectTo` 直接用 `SITE + '/store'`（注册及其重发）或 `SITE + '/reset-password'`（忘记密码及其重发）（L-3，完整写法见设计文档 §21 紧急第 3 项）；A8 重发就是再调一次 signInWithOtp（不用 `resend`，前端第 4 问）；A2 `signInWithPassword`；A3 `signOut`；A5 `verifyOtp({ token_hash, type })`，type 只接受 email / recovery / email_change；A7 `verifyOtp({ phone, token, type: 'sms' })`。
- A6 是唯一的认证 Route Handler：`app/api/auth/set-password/route.ts`（POST）。
  - M-1 CSRF 规格：`Origin` 必须与 `NEXT_PUBLIC_SITE_URL` 精确相等，缺失也拒绝 → 403 `FORBIDDEN`；`Sec-Fetch-Site` 存在时必须是 `same-origin` → 否则 403；`Content-Type` 必须以 `application/json` 开头 → 否则 415 `UNSUPPORTED_MEDIA_TYPE`；会话 cookie 保持 SameSite=Lax、Secure；响应 `Cache-Control: no-store`。
  - `lib/auth/reauth.ts`：amr 中有 FRESH 集合 `otp`、`magiclink`、`recovery`、`email/signup`、`sms/signup` 之一且时间戳在 5 分钟内，否则 401 `REAUTH_REQUIRED`（与设计文档 §9f 同一集合；真实取值上线前确认，清单第 2 项）；通过后 `updateUser({ password })` + `signOut({ scope: 'others' })`。
  - M-2：文档承认浏览器持有 access token 时可以直连 `PUT /user` 绕过 A6 的新鲜度检查和 signOut others；真正的控制是 GoTrue 的 `secure_password_change` 与密码规则（PR1b 已下沉到 GoTrue）。A6 保留为 UX 与 signOut others 的统一入口。「改密码需要当前密码」保持关闭（我们的忘记密码流程不是 recovery 会话，开启会让重设密码失败）。
- `lib/auth/gotrue-errors.ts`（GoTrue 错误码 → 本项目错误码，见 §19；429 `over_*_send_rate_limit` → `RATE_LIMITED`，前端显示「请稍后再试」）、`lib/validation/phone.ts`（libphonenumber-js/max；有效、手机类型、国家在 `NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES`，默认 MY）。
- 防枚举：A1 / A4 / A8 新旧账号同一调用、同样响应；A7 错误统一 `OTP_INVALID`；A2 不存在与密码错误同一提示。
- 数据层 `lib/data/supabase/{me,store,menu,tables,images,blocks}.ts`（实现前端 PR-A 定义的接口）：M1 = `rpc('get_my_context')`（显式列，不再 `stores(*)`）；`ensure_my_store`；M2–M8、R3–R7、R12；`rotate_table_qr`；M14 `list_blocked_clients` / R13 `unblock_client(blockId)`；图片上传路径与大小 / 类型校验（前端负责压缩）。
- `lib/data/types.ts`：设计文档 §21.4 的 6 个类型（`StoreStatus`、`MyStoreSummary`、`MyContext`、`BlockedClientRow`、`BillGoneReason`、`QuoteEstimate`）已由前端 PR-A 写入，后端**不重复添加**；只在文件末尾追加本 PR 新需要的类型，不改名、不删字段。
- rereview-3 低-1、低-2、低-5（在本 PR 一起处理）：
  - **低-1**：phone_change / email_change 的说法改为「v1 前端不提供入口；API 仍然可以调用（持有会话的人可直接 `PUT /auth/v1/user {phone}` 或 `{email}`，不经过 Before User Created Hook），靠 Twilio Geo 权限（只开 MY）、`sms_sent`、`max_frequency` 兜底，见清单第 19 项」（设计文档 §9a 已改）；PR5 监控加 `user_updated` 审计里 phone 字段变化的统计。
  - **低-2**：`supabase/config.toml` 的 `[auth.email]` 加 `double_confirm_changes = true`（secure email change：新旧两个地址都要确认），Dashboard 同步打开；A5 继续接受 `email_change` 的前提就是它。
  - **低-5**：`lib/auth/gotrue-errors.ts` 把 Twilio「同一号码 10 分钟第 6 次」（Twilio 60203 / 429，经 GoTrue 可能以 `sms_send_failed` 一类的码返回）映射为 `RATE_LIMITED`，前端统一显示「请稍后再试」；其余 `sms_send_failed` 仍是 `SMS_SEND_FAILED`。真实返回码在 Preview 上实测（并入清单第 10 项），按实测结果改判定条件。

**验收标准**（后端 PR 内用单元 / 集成测试验收；带页面的端到端用例在对应前端 PR 合并后联调）
1. guard 单元测试：`evaluateAccess` 对六种 AuthState × `/store/**`、`/admin/**`、`/set-password`、`/verify`、`/login` 的结果与设计文档 §21 表格一致；`get_my_context` 返回里没有停用原因。
2. safeNext 单元测试（M6、L-N4、L-3）：`https://evil.com`、`//evil.com`、`/\evil.com`、`/` + 制表符 + `/evil.com`、`/%09/evil.com`、`/storeevil`、`/admin`、空值都回退 `/store`；`/reset-password`、`/set-password`、`/store/menu` 以及同源完整 URL `SITE/reset-password` 都得到对应 pathname。
3. A6（M-1）：缺 Origin、Origin 不同（含 `SITE.evil.com`）、`Sec-Fetch-Site: cross-site` → 403；`text/plain` / `application/x-www-form-urlencoded` → 415；跨站 form POST 的 E2E → 403；验证后 5 分钟内设密码成功，其他设备会话失效；超过 5 分钟或只用密码登录的会话 → 401 `REAUTH_REQUIRED`。
4. M-2：直连 `PUT /user` 设 7 位或纯数字密码 → 被 GoTrue 拒绝（weak_password，映射为 `VALIDATION_FAILED`）。
5. gotrue-errors 单元测试：§19 表中每个 GoTrue code 映射正确，未知 code → `INTERNAL`。
6. 数据层集成测试（本地 Supabase）：改店铺资料、开关营业中、增改分类 / 菜品 / 桌子成功；桌名重复 `TABLE_LABEL_TAKEN`；分类非空删除 `CATEGORY_NOT_EMPTY`；有 open 账单的桌删除 `TABLE_HAS_OPEN_BILL`；批量排序后 sort_order 为 10、20、30…；停用店铺时写操作 `STORE_SUSPENDED`、读取正常；上传 >2 MB 或非图片 `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE`，别店目录被拒；`unblock_client` 用别店的拉黑 id → `NOT_FOUND`；代码库里没有 `stores(*)`。
7. 抢注（H-N1）与手机号（test_otp）流程在前端 `/verify`、`/set-password` 页面合并后按设计文档 §9f 联调一次：抢注者的密码登录失败；`012-345 6789` 规范化为 `+60123456789`；`+65…` 被拒。
8. 仓库中没有 `lib/supabase/admin.ts`、没有 `SUPABASE_JWT_SECRET`。
9. 低-1：设计文档与前端文案里不再出现「phone_change 在 v1 不可触发」；用测试账号直连 `PUT /auth/v1/user {phone: '+65…'}` → 被 Twilio Geo 权限拒绝（或受 `sms_sent` / `max_frequency` 限制），结果截图附在 PR 描述里。
10. 低-2：`config.toml` 里有 `double_confirm_changes = true`；Dashboard「Secure email change」已开（截图，和 PR1b 验收第 7 条的截图放在一起）；Preview 上改邮箱时新旧两个地址都收到确认信，只确认其中一个时邮箱不变。
11. 低-5：gotrue-errors 单元测试：Twilio 60203 / 每号上限对应的 GoTrue 错误（以 Preview 实测的 code + message 为准）→ `RATE_LIMITED`；普通 `sms_send_failed` → `SMS_SEND_FAILED`；Preview 上对同一测试号码 10 分钟内发第 6 次，前端显示「请稍后再试」而不是 INTERNAL。
12. `lib/auth/guard.ts`、`lib/auth/safe-next.ts` 的导出签名与前端 PR-C 版本及设计文档 §21.4 一致（`getAuthState(supabase)`、`evaluateAccess(pathname, state)`、`safeNext(next)`，`AuthState` / `AccessDecision` 不变）：PR diff 只改函数体，前端调用处不改，`tsc` 通过；验收第 1、2 条的单元测试在接手后的版本上跑。
13. `lib/data/types.ts` 里 §21.4 的 6 个类型各只定义一次（`grep -c` 为 1），后端新增类型只出现在文件末尾的追加段。

## PR3 顾客接口

**开工条件**：PR1b 已合并（customer_api 登录角色与 0004 的 customer_quote 字段就绪）；前端 PR-A 已合并。

**范围**（不含页面；P1/P2/P3 在前端 PR）
- `lib/qr.ts`（`signTableCode` / `verifyTableCode`，格式见设计文档 §9 公共部分，常量时间比较）、`lib/hash.ts`、`lib/ratelimit.ts`（§12 全部 scope；Upstash 出错时 fail-closed：要求 Turnstile）。
- `lib/client-context.ts`：可信 IP 只取 `x-vercel-forwarded-for` / `x-real-ip`；设备 cookie `did` 由服务端签发（HMAC `DEVICE_COOKIE_SECRET`，HttpOnly、Secure、SameSite=Strict、Path=/api/t）；指纹哈希 = HMAC(`CLIENT_HASH_SECRET`, `store_id:值`)。
- `lib/supabase/customer.ts`（H-N2，代码见设计文档 §18）：`postgres(process.env.CUSTOMER_API_DATABASE_URL, { max: 1, prepare: false, ssl: 'require', idle_timeout: 20, connect_timeout: 5 })`，只封装 4 个 customer_* RPC；P0001 → 业务错误码，57014 / 连接失败 → `INTERNAL` 并告警。依赖 `postgres`（postgres.js）。
- M-N3：Upstash 同店同 IP 10 分钟 ≥20 单要求 Turnstile（`CAPTCHA_REQUIRED`，scope ip），≥100 单 429；数据库同样两档（scope ip_db）。
- C1–C4：`app/api/t/[code]/{menu,quote,orders,bill}/route.ts`，全部 `Cache-Control: no-store`，经 customer_api 调 `customer_*` RPC。C3 用 `crypto.randomBytes(32)` 生成账单令牌，通过 Set-Cookie `bt_{table_id 去横线}`（HttpOnly、Secure、SameSite=Strict、Path=/api/t、12 小时）下发，响应体不含令牌；C4 从 cookie 读令牌。
- S1：`app/store/tables/actions.ts` 的 `getTableQrLinks`（校验 tableIds 属于当前店）。
- 给前端的约定（页面由前端 PR 做）：不再用 localStorage 存设备 ID 和账单令牌，也不发 `X-Device-Id` / `X-Bill-Token` 头（都在 HttpOnly cookie 里）；下单带 `client_request_id`（失败重试复用同一个）；进度页 10 秒轮询，页面隐藏时停止；收到 410 时按 details.reason 显示：bill_paid →「已结账，谢谢光临」，qr_rotated →「二维码已更新，请重新扫码」，expired →「页面已过期，请重新扫码」，并停止轮询。
- L-9（rereview-2）：`revoke temporary on database postgres from public`（先在 Preview 确认不影响 Supabase 内部角色，如有影响只对 customer_api 收回）；`alter function public.customer_place_order(...) set statement_timeout = '3s'`（其余 3 个 customer_* 同样设置），会话里的 SET 覆盖不了函数级设置；函数级 statement_timeout 已覆盖，连接参数经 Supavisor 可能被拒，已删除。实际迁移为 `0007_customer_timeouts.sql`（0006 为幂等设备绑定）。
- L-11（书面接受风险）：同店同 IP 计数在并发下可能少量超过 20 / 100 单的阈值，不加 `pg_advisory_xact_lock`；Upstash 一层和同桌 / 同设备限流仍在。

**验收标准**
0. 用 customer_api 连接串连到 Supavisor，冷启动后首个请求成功；仓库中搜不到 `SUPABASE_JWT_SECRET`。
0a. 同一 IP 同店 10 分钟第 21 单 → `CAPTCHA_REQUIRED`，带 Turnstile 重提成功；第 101 单 → 429。
1. 篡改 code 任一字符 → 404 `TABLE_INVALID`；同一 IP 10 分钟内第 21 次无效码 → 429。
2. 菜单只含本店未隐藏、未删除的分类与菜品；售完菜品出现但 `is_sold_out=true`；关店时返回菜单且 `is_accepting_orders=false`，下单 → `STORE_CLOSED`。
3. 下单成功返回 201，并通过 Set-Cookie 下发 `bt_` 令牌（响应体不含令牌，JS 读不到 cookie）；网络重试（同 `client_request_id`）返回 200 + `replayed=true` 且不产生新订单。
4. 价格被店家修改后用旧价下单 → 409 `PRICE_CHANGED`，details 含新价；quote 接口对同一购物车返回相同的 price_changes。
5. 同设备 1 分钟内第 4 单 → 429；伪造 `X-Forwarded-For` 或 `X-Device-Id` 头不改变限流计数；清掉 cookie 后按 IP 的限流仍生效；Redis 不可用时（模拟）下单要求 Turnstile，且同桌 10 分钟第 11 单仍被数据库拒绝。
6. 进度页：无令牌只显示「这桌正在使用」（table_in_use）；有令牌只显示本设备的订单与这些订单的预估金额，同桌另一部手机的订单看不到；店家结账后下一次轮询得到 410 reason=bill_paid 并显示「已结账」；店家重置二维码后得到 410 reason=qr_rotated；令牌过期 → 410 reason=expired。
6a. 同一 cookie 换到另一张桌子的二维码，或换一台设备（不同 did）使用 → 401 `BILL_TOKEN_INVALID`。
7. 金额显示与 PR1 算例一致（前端只显示后端给的数字，不自行计算）。
8. L-9：customer_api 会话执行 `set statement_timeout = '60s'` 后调用 customer_place_order，函数内仍是 3 秒（`pg_sleep` 探针或 pgTAP 断言 `proconfig`）；customer_api 不能 `create temp table`。
9. 设计文档 §21 的 C2 新字段（Q1：本单预估、limit_exceeded 等）与 C4 的 410 reason（bill_paid / qr_rotated / expired）与前端 PR-A 的类型一致。

## PR4 订单与结账数据层 + Realtime hook

A 组顾客接口与数据库补充（不涉及 B 组 lib/data、lib/realtime）：

- `0008_bill_qr_rotated.sql` 仅替换 customer_get_bill；先用当前版本检查店铺，再验证令牌的店/桌/设备归属。本人令牌先判撤销（保留最早原因）、再判过期；仍有效的新令牌配旧码返回 404。无本人令牌的旧码统一 404；店停用优先 403。保留函数级 3 秒超时、空 search_path、SECURITY DEFINER 与 customer_api 独占 EXECUTE。
- PR3 验收第 6 条由以下规则补充：旧码本人令牌得到 410 qr_rotated 并清 cookie，410 不增加 invalidIp；bill_paid、expired 同样清 cookie。PGlite 覆盖精确说明 14 项，pgTAP CI 复验配置/授权及判定顺序。
- 重放在计数前由 customer_api RPC 事务确认，仅 replayed=true 提交（含令牌补发）；其他结果或业务拒绝回滚，仍走原有应用与数据库硬限流。不得因客户端声称 request_id 已提交而放行，不新增表权限或 RPC。
- L-1：生产只支持 Vercel（平台覆盖 x-vercel-forwarded-for）；x-real-ip 仅本地开发/测试使用，生产缺可信头归 unknown。IPv6 /64 分桶，IPv4-mapped 统一为 IPv4。上线监控应统计 unknown 比例并报警；本地不接监控服务。
- L-2：前端 PR-D 为 place_order widget 设置 `cData = table_id + '_' + client_request_id`，请求字段仍是 `captcha_token`。服务端发送 idempotency_key=client_request_id，严格核对 success/action/hostname/cdata；仅 Cloudflare 官方 always-pass 测试 secret 允许缺 cdata，生产不得使用测试 key。
- L-4：函数级 statement_timeout 已覆盖，连接参数经 Supavisor 可能被拒，已删除；连接仍保持 max=1、prepare=false、ssl=require。
- L-5：quote/orders 在 JSON 解析前限制 16 KiB，检查 Content-Length 并逐块计量无长度/虚报长度的请求，超限返回 413 PAYLOAD_TOO_LARGE。
- Retry-After 使用数据库 retry_after_seconds 或限流窗口秒数，向上取整且至少 1；无值默认 60。应用层 CAPTCHA_REQUIRED 带 details.scope。顾客停用提示为「本店暂停服务」，共享错误表的店家文案保持原样。


**开工条件**：PR2、PR3 已合并。

**范围**（不含页面；P5 / P6 在前端 PR）
- M9–M12、R1、R2：`lib/data/live.ts` + `lib/data/supabase/live-orders.ts`；账单 `lib/data/bills.ts` + `lib/data/{mock,supabase}/bills.ts`；`lib/realtime/useStoreChannel.ts`（postgres_changes 订阅 orders、bills，filter `store_id=eq.{id}`；频道用 `channel('store:'+id, { config: { private: true } })`，Supabase Dashboard 的 Realtime 设置关闭「Allow public access」）。
- 补拉：重连、visibilitychange、每 60 秒，`updated_since = 上次最大 updated_at − 30s`，按 id 去重合并。
- 提示音：存在 `status='new'` 时每 10 秒响一次；首次需用户点击「开启声音」。
- 给前端的约定：P5 进行中订单按设计文档 §21 Q5 的查询（served 订单用 `orders_store_served_idx`）；P6 账单列表分页 20/页；订单卡与账单详情显示「设备 #n」（orders.device_seq_in_bill，L-N3），不显示哈希。

- PR2 统一入口：`lib/data/store.ts`、`lib/data/tables.ts`（经 `lib/data/index.ts` 导出）；完整资料用 getStore/updateStore，营业状态用 getStoreStatus/setAcceptingOrders，仅读 name/status/is_accepting_orders，开关只写 is_accepting_orders。
- `listBills(BillFilters)` 页码从 1 开始，20/页，返回 BillPage；paid_from/paid_to 为 YYYY-MM-DD，末日包含，内部用 UTC+8 半开区间。getBillDetail 返回 BillDetail；markBillPaid 返回 CheckoutResult（冻结费率、金额、paid_at、table_id、tokens_revoked、is_estimate=false）。P6 重读 bill_overview 金额，不用 Realtime 裸行重算。
- `useStoreChannel(storeId)` 返回 orders、connection、error、soundEnabled、enableSound、refresh；orders 包含补拉终态，P5 按状态筛选。P5 可保留 LiveProvider 或采用新 hook，同一用途不可同时启用，以免重复订阅和响铃。
- 顾客 fetch 请求固定 same-origin/no-store；PlaceOrderBody 兼容 turnstile_token 别名（两者都有时别名优先），线上只发送 captcha_token。菜单 table.id 可供前端构造 cData。DataErrorCode 扩展账单冲突及 PAYLOAD_TOO_LARGE；保留 HTTP status、details.scope/reason/新金额、Retry-After 秒数和服务端文案。
- build-guards 用受控 fetch 验证未配置数据源仍 isMock=false，并核对菜单路径和请求选项，替换已失效的 NOT_IMPLEMENTED 占位预期。

**验收标准**（1–2、6 在前端 P5 / P6 合并后联调）
1. 顾客下单后 2 秒内店家页面出现新订单并响铃；两台店家设备同时打开都能收到。
2. 断网 1 分钟期间下的单，恢复网络后自动补齐，不重复。
3. 两台设备同时接同一单：一台成功，另一台得到 `ORDER_STATUS_CONFLICT` 并刷新为最新状态。
4. 取消必须选原因；选「其他」可填 ≤100 字说明；取消后账单小计立即减少。
5. 结账：确认框显示合计；期间顾客加单 → `BILL_TOTAL_CHANGED` 并显示新金额；成功后账单变 paid，金额不再随费率变化；重复点击 → `BILL_ALREADY_PAID`；结账后该桌顾客令牌全部撤销（顾客端进度页显示「已结账」），桌子恢复空闲，下一位顾客下单开新账单。
6. 账单列表按状态、桌、付款日期（UTC+8 日界）筛选结果正确；open 账单标「预估」。
7. B 店账号订阅 A 店频道收不到任何 A 店事件（Realtime RLS 隔离）；未登录客户端无法加入私有频道；客户端发 Broadcast 被拒（M8）。

## PR5 记录、统计、平台管理、防刷收尾

**开工条件**：PR4 已合并。

**范围**（数据层、cron、脚本与 CI；P10 / P11 / 拉黑列表 / 管理员 TOTP 页面在前端 PR）
- M13（P10 订单记录按日；未付金额取实时 `open_bills`，前端问题 (c)）、R8（统计卡片）、M14 + R9 + R13（一键拒单并拉黑、拉黑列表、按拉黑记录 id 解除，0004 已有 RPC）。
- R10、R11（店铺列表、停用 / 启用、原因）的数据层；管理员 TOTP 上线前，紧急停店用 `docs/runbook-emergency-suspend-store.md`。
- Turnstile：`stores.require_captcha` 或店级 10 分钟超 120 单时，C3 返回 `CAPTCHA_REQUIRED`，前端弹出后带 `captcha_token` 和同一 `client_request_id` 重提。
- 监控：每日汇总（429 次数、无效码次数、高取消率设备）写入 audit_logs，平台页面可查看；`private.purge_expired()` 用 pg_cron 每天执行（删除过期或撤销满 7 天的令牌、过期拉黑；order_client_meta 设备 / IP 哈希 30 天后置空；审计日志保留 180 天）。
- 后续项（安全审查 L8 与其他建议，不阻塞上线）：price_cents、is_accepting_orders、service_charge_bp、sst_bp、is_active 的 AFTER UPDATE 审计触发器；二维码多密钥轮换（key id）。平台管理员 aal2 与 no_store 已在 PR1b 的数据库层生效，/admin/mfa 绑定与验证页面由前端做（`supabase.auth.mfa.*`，流程见设计文档 §21 第 9 问）；本 PR 做 `lib/auth/guard.ts` 的 needs_mfa 判定联调、`MFA_REQUIRED` 的错误映射、`scripts/ops/create-admin.ts`（运维机器用 secret key 建账号，app_metadata = `{ no_store: true, provisioned_by: 'ops' }`，M-3 / L-4；rereview-3 中-1 做法 A，脚本已在仓库：① `auth.admin.createUser` 不带 password、`email_confirm: true` → ② `auth.admin.updateUserById(id, { password })` → ③ `signInWithPassword` 自检，失败以非 0 退出；机密只从环境变量 `SUPABASE_URL` / `SUPABASE_SECRET_KEY` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` 读取；`profiles.role = 'platform_admin'` 仍在 SQL Editor 手工设置）。
- L-N6：CI 用 Management API 读取生产 Auth 配置，test OTP 不为空则失败。短信监控：over_sms_send_rate_limit 次数、Twilio Usage Trigger 告警邮件接收人；`user_updated` 审计里 phone 字段变化的次数（rereview-3 低-1）。首单审核的逻辑与界面（stores.require_first_order_approval 已预留，开启后的行为见设计文档 §12）不在 v1。

**验收标准**
1. 统计：当天（UTC+8）付款的账单 total 合计 = 营业额，含服务费与 SST；23:59（UTC+8）付款计入当天，00:01 计入次日；open 账单金额单独显示。
2. 一键拒单并拉黑：订单变 cancelled（原因 other），该设备 7 天内再下单 → `DEVICE_BLOCKED`；解除后可再下单。
2a. 管理员未完成 TOTP（aal1）调用 admin_* → `MFA_REQUIRED`（前端带去 /admin/mfa）；非管理员 → `FORBIDDEN`；完成 TOTP 后正常；管理员账号没有店铺。
2b. CI：生产项目 test OTP 非空时失败。
2c. 解除拉黑：`unblock_client(id)` 后该设备能再下单；店铺停用时解除 → `STORE_SUSPENDED`，列表仍可读；审计里有 client.blocked / client.unblocked。
2d. （由 PR1b 验收第 9 条后半句移来，rereview-3 中-1）在 Preview 项目执行 `scripts/ops/create-admin.ts`：三步都成功、退出码 0；`profiles.password_set_at` 有值、该账号没有店铺；之后在登录页用这个密码能登录（aal1 调 admin_* → `MFA_REQUIRED`，绑定 TOTP 后正常）。同时完成清单第 14 项：确认 admin createUser(email_confirm:true) 在托管版本上也是 INSERT → UPDATE app_metadata → Confirm UPDATE（是的话，旧的一步建号会丢密码，脚本的两步写法是必需的）。
3. 平台管理员能列出全部店铺（含店主邮箱或手机号），停用后该店顾客扫码看到停用提示、店家写操作被拒；非管理员调用 → `FORBIDDEN`。
4. 平台管理员查询任意店 orders / bills 返回 0 行。
5. Turnstile 开启后无 token 下单 → `CAPTCHA_REQUIRED`（Route Handler 与数据库 require_captcha 两层都能返回）；token 无效 → `CAPTCHA_FAILED`；有效 token 下单成功且不重复。
6. `purge_expired()` 执行后：30 天前订单的 order_client_meta.device_hash / ip_hash 为 NULL，撤销满 7 天的令牌被删除。


## 上线前验收（PR5 合并、前端页面全部合并后；阻塞正式上线）

**开工条件**：PR5 已合并；前端页面全部合并；自定义 SMTP 域名已定。

**M-4 发信额度**（决定：第一版前端**不开放改手机号**，也不提供改邮箱）
1. 配置自定义 SMTP，并显式设置 `[auth.rate_limit] email_sent`（PR1b 建议 30 / 小时，按实际量调整）；Supabase 自带 SMTP 不上生产。
2. 按 Twilio 预算把 `sms_sent` 调到能撑住峰值；Twilio 侧余额 / 花费告警（Usage Triggers）。
3. 监控 GoTrue 的 429 `over_sms_send_rate_limit` / `over_email_send_rate_limit` 并告警。
4. 额度被耗尽时的处置写进运维手册（临时调高额度、开启更严的 CAPTCHA、必要时 `sms_sent = 0` 暂停短信注册，见 `docs/launch-checklist-twilio.md`）。

**真实环境确认清单（rereview-2 第 7 节，23 项，逐项在 Preview / 生产项目确认并留截图或命令输出）**
1. GoTrue 验证时是否整行写回旧哈希；
2. amr 实际取值（决定 A6 的 FRESH 集合）；
3. hook 拒绝时的错误格式；
4. pg_cron 可用且 postgres 能删 auth.users；
5. Supavisor 对 customer_api 的连接数 ≤ 20；
6. 停用 legacy JWT secret 后 publishable key 正常；
7. Management API 测试号码的字段名；
8. verifyOtp type='email' 对注册和登录两种邮件都适用；
9. A2 的响应时间差；
10. Twilio：Geo permissions 只开 MY、Fraud Guard 开启、每码 5 次校验后作废、马来西亚模板合规；
11. Dashboard：Realtime 关闭「Allow public access」；匿名登录关闭；CAPTCHA 已开且不是测试 key；`\ddp` 默认权限；
12. hosted Supabase 上以 postgres 身份能否在 auth.users 上建触发器、改 encrypted_password；
13. Auth 设置 mailer_autoconfirm = false、sms_autoconfirm = false，「允许未验证邮箱登录」关闭（M-3）；
14. GoTrue admin createUser(email_confirm:true) 是一条 INSERT 还是先 INSERT 后 UPDATE（L-4；rereview-3 中-1：与 PR5 第 2d 项一起确认，`create-admin.ts` 两步建号在两种情况下都能用）；
15. 验证前 /otp、/signup、/token 都不发会话（另见 L-1：首次验证删除已有会话，确认同一事务里随后创建的会话不受影响）；
16. `PUT /user` 改密码时 secure_password_change 的实际行为，以及「需要当前密码」选项（M-2）；
17. 密码策略 minimum_password_length / password_requirements 已设置（M-2）；
18. 自定义 SMTP 与 email_sent 限额（M-4）；
19. phone_change 是否走 Twilio Verify、是否受 sms_sent 约束（M-4；第一版前端不开放改手机号）；
20. purge 与 verify 并发：验证已被删除的账号时 GoTrue 的返回（L-2）；
21. Auth redirect allowlist：生产只有 `SITE/store`、`SITE/reset-password` 两个精确地址，Preview / 本地才用通配（L-3）；
22. 数据库日志与 SQL 编辑器历史是否保留 `alter role … password` 明文（L-7；已改用 `\password`，仍需确认历史里没有旧记录）；
23. `auth_roles.test.sql` 在 `supabase test db` 下实际通过（现为 25 条，rereview-3 低-6 补 2 条）。

**Supabase 组织安全（rereview-3 低-3，阻塞上线）**：Supabase 组织必须强制开启 MFA（组织设置里的 Require MFA，所有成员都要绑定两步验证），**由 Song Haw 本人设置**并截图；同时核对有 SQL Editor 权限的成员名单与运维手册第 0 节的名单一致。步骤见 `docs/launch-checklist-twilio.md` 末尾「Supabase 组织」一节。

**rereview-2 中本轮未处理、上线前处理或书面接受的低危项**：L-2（24 小时清理边界：rereview-3 低-4 已在 PR1b 的 `0005_purge_resend_boundary.sql` 处理，按最后一次发确认计时 + 25 小时下限；短信是否写 `confirmation_sent_at` 随第 20 项确认）、L-4（管理员建号：**不是**靠 M-3 的 provisioned_by 缓解——GoTrue admin createUser 的 Confirm UPDATE 会触发 0003 的首次验证擦除，ops 放行管不到；改为 `scripts/ops/create-admin.ts` 两步建号（做法 A，迁移不改），PGlite 模拟见 rereview2 中-1 段，真实环境由 PR5 第 2d 项 + 第 14 项确认）、L-6（生产构建拦截 Turnstile 测试 key、TWILIO_* 移到 `supabase/.env.example`）、L-10（hook 正则放行 1300 / 1800 号段）。**L-11 已书面接受**（见 PR3）。**L-5 已在 PR1b 处理**（注册不收店名，0004 不再读 `user_metadata.store_name`）。

---

## 仍待 Song Haw 决定（不阻塞 PR1–PR5）
1. 短信服务商选型：推荐 Twilio Verify（设计文档 §20；上线设置见 `docs/launch-checklist-twilio.md`）。未回复前 PR1 / PR2 按 Twilio Verify 配置；换服务商只改 config.toml 与环境变量，不改代码。

已拍板（2026-11-04）：邮箱或手机号注册、验证通过后才建店（含 M5）；首单审核做成店家开关、默认关，v1 只建字段，加入码不做（H1）。
