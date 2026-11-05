# 上线前检查清单：Twilio Verify（短信验证码）

给 Song Haw 用，上线前按顺序逐步做；每一步做完截图，存进 PR1b 的验收记录。
页面名称来自 Twilio 官方文档（链接附在每一步后面，2026-11-04 查询）。Twilio 控制台会改版：如果菜单位置和这里写的不一样，按页面名称搜索；凡是写了「以控制台实际页面为准」的地方，表示官方文档里没有找到确切的菜单路径。

为什么要做这些：攻击者可以绕过我们的网站，直接调用 Supabase 发验证码（短信轰炸，按条收费）。Supabase 和数据库里已经有号码白名单和每小时上限（见 backend-design §12、§18 第二轮复查修订记录 M-N1），这份清单是 Twilio 账户这一侧的最后防线：只允许发往马来西亚、自动拦截可疑号码、花钱超过预算就告警、余额用完就停。

---

## 第 0 步：账户登录安全

1. 登录 Twilio 控制台，点右上角自己的名字，进入 **User settings（用户设置）**。
2. 在两步验证（2FA）部分点 **Set up 2FA**，建议再加一个验证器 App（Add authentication app）。把恢复码（recovery code）存进密码管理器。
   - 付费账户强制开启 2FA，不能关闭。
   - 来源：https://help.twilio.com/articles/223136307-Enabling-two-factor-authentication-on-your-Twilio-account ；https://help.twilio.com/articles/360046874054
3. 截图：2FA 已开启的页面。

## 第 1 步：建一个只用来发验证码的子账号

1. 进入 **Subaccounts（子账号）** 页面，点右上角 **Create subaccount**，名称填「restaurant-verify-prod」，点 **Create subaccount**。（只有账户 Owner / Admin 能建。）
   - 来源：https://help.twilio.com/articles/360011348693-View-and-Create-New-Twilio-Subaccounts
   - 子账号页面在左侧菜单的哪一级：以控制台实际页面为准。
2. 以后第 2–5 步都在这个子账号里做（控制台左上角切换账户）。这样就算子账号的密钥泄露，也只影响验证码，不影响主账户的其他服务。
3. 截图：子账号列表。

## 第 2 步：建 Verify Service

1. 在子账号里进入 **Verify → Services**，新建一个 Service，名称填平台的英文名（短信里会显示，例如「<平台名>」）。
   - 新建时如果提示开启 Fraud Guard，选开启。
   - 来源：https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard ；https://help.twilio.com/articles/55716376494619
2. 记下 Service SID（VA 开头），后面填进 Supabase。
3. 进入这个 Service 的 **Settings → General**：
   - **Code Length（验证码位数）**：保持 6 位（可选 4–10 位）。
4. 验证码有效期：Twilio 默认 10 分钟，控制台和 API 都改不了，要改只能联系 Twilio Support（2 分钟到 24 小时）。v1 保持 10 分钟，不用联系。
   - 来源：https://help.twilio.com/articles/360033354913-What-is-the-Default-Verify-V2-Expiration-Time
5. 截图：General 设置页。

## 第 3 步：开 Fraud Guard，设成 Max

1. 还是在这个 Service 的 **Settings**，切到 **SMS** 分页。
2. 勾选 **Enable Fraud Guard**，**Protection Level** 选 **Max**，保存。
   - Max 最严格，可能偶尔误拦正常号码；被拦的用户会收到「发送失败」，前端提示改用邮箱注册。
   - 来源：https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard
3. 截图：SMS 分页里 Fraud Guard = Max。

## 第 4 步：Geo permissions 只开马来西亚

1. 进入 **Verify → Settings → Geo permissions**（这是子账号全局设置，不在某个 Service 里面）。
2. 先把所有国家设为 **Disable all traffic**，再只把 **Malaysia** 的 SMS 设为 **Allow all traffic**。
   - 第三个选项「Monitor all traffic for fraud」（要配合 Fraud Guard）这里不用。
   - 语音（Voice）、WhatsApp 等其他通道：全部 Disable（我们不用）。
3. 保存后立即生效。被拦的号码发送时会返回错误 60605。
   - 来源：https://www.twilio.com/docs/verify/preventing-toll-fraud/verify-geo-permissions
   - 注意：Twilio 公告自 2026-08-19 起把意大利、阿根廷的默认设置从 Allow 改为 Monitor；已手工改过的国家不受影响。我们是手工全部 Disable，上线前再看一眼列表即可。来源：https://www.twilio.com/en-us/changelog/Verify_Geo_Permission_Update
4. 不要往 Safe List（白名单号码）里加号码：Safe List 用于让指定号码绕过防欺诈拦截，我们用不到。Safe List 的入口以控制台实际页面为准。
5. 截图：Geo permissions 列表（Malaysia = Allow，其余 = Disable）。

## 第 5 步：Verify Service 的号码频率限制（不用设，说明一下）

- Twilio Verify 自带限制：同一个号码 10 分钟内最多发 5 次验证（超过返回错误 60203），每个验证码最多校验 5 次。
- 安全复查建议的「Verify Service 的 Rate Limits 按号码设限」：官方文档里这是 API 功能（Rate Limits、Buckets），要求发送验证码时带上 RateLimits 参数；Supabase 发验证码时不会带这个参数，所以对我们不起作用。控制台里是否有对应页面：以控制台实际页面为准。
  - 来源：https://www.twilio.com/docs/verify/api/programmable-rate-limits
- 我们的按号码限制由 Supabase 负责：同一号码 60 秒一条、项目每小时最多 20 条（见第 9 步）。

## 第 6 步：每日花费告警（Usage Trigger）

1. 回到主账户（或子账号，两边各设一个更保险），进入 **Billing → Account usage → Usage Triggers**，点 **Create usage trigger**。
2. 填写：
   - 名称：「Verify 每日 30 美元」
   - Usage category：总花费（Total price）。类别下拉里的确切叫法以控制台实际页面为准。
   - Trigger by：Cost（金额）
   - Threshold：30（美元）
   - Recurring：Daily
   - 通知方式：Email，填 Song Haw 的邮箱（也可以加 webhook）
3. 再建一个月度的：Threshold 150、Recurring Monthly。
   - 来源：https://help.twilio.com/articles/55716593836315 ；https://www.twilio.com/docs/usage/api/usage-trigger
   - 说明：Usage Trigger 只发告警，不会停止发送。真正的封顶靠第 7 步。
4. 截图：Usage Triggers 列表。

## 第 7 步：关闭自动充值，余额保持小额

1. 进入 **Billing → Billing → Settings**，找到 **Auto-recharge**；或者在 Billing Overview 点 **Edit auto recharge settings**，切换到 **Disabled**，点 **Save**。
   - 来源：https://help.twilio.com/articles/55716593773979 ；https://help.twilio.com/articles/223135607
2. 余额只充够 1–2 个月的用量（参考 backend-design §20：每月 50 个手机号注册约 $25）。余额用完 Twilio 就停止发送，这是费用的硬上限。
3. 截图：Auto-recharge = Disabled，以及当前余额。

## 第 8 步：低余额提醒

1. 在 Billing 的 **Notifications（通知）** 里开启低余额提醒，阈值设为 $10，发到 Song Haw 的邮箱。
   - 来源：https://help.twilio.com/articles/49919017748763 （Billing 页面导航说明）
   - 具体字段名称以控制台实际页面为准。
2. 截图。

## 第 9 步：把密钥填进 Supabase（不要填进 Vercel）

1. 在子账号里进入 **API keys & auth tokens** 页面（新版在 Settings → Account settings 下面，旧版在 Account → Keys & credentials），选中子账号，在 Live credentials 里查看 Account SID 和 Auth Token。
   - 来源：https://www.twilio.com/docs/global-infrastructure/manage-regional-api-credentials
2. 打开 Supabase Dashboard（生产项目）→ Authentication → 手机登录的服务商设置（Twilio Verify），填 Account SID、Auth Token、Verify Service SID（第 2 步记下的 VA…）。Supabase 页面的确切名称以控制台实际页面为准。
3. 同一天在 Supabase 做下面几项（不属于 Twilio，但必须一起做，否则 Twilio 的设置挡不住全部风险）：
   - Authentication → Rate Limits：短信每小时上限（sms_sent）改为 20。（页面名称来源：https://supabase.com/docs/guides/auth/rate-limits）
   - Authentication → Hooks：启用 Before User Created，选 `private.hook_before_user_created`。
   - 确认生产项目没有任何测试号码（test OTP）。
4. Auth Token 只存在 Supabase 和密码管理器里；Vercel、GitHub、聊天记录里都不要出现。
5. 截图：Supabase 服务商设置页（Auth Token 遮住）、Rate Limits 页、Hooks 页。

## 第 10 步：上线前实测

1. 用一个马来西亚手机号在网站注册：应该在 1 分钟内收到验证码短信，显示的是第 2 步填的 Service 名称。记下短信原文。
   - 马来西亚对短信内容有格式要求（例如「RM0」前缀，见 backend-design §20）；如果短信原文不符合，联系 Twilio 支持确认马来西亚的发送模板。
2. 用一个新加坡号码（+65）注册：网站应提示「暂不支持这个国家或地区的手机号」（数据库 hook 拦住，Twilio 不会收到请求）。
3. 到 Twilio 子账号的 Verify 日志里看最近的记录：只应该有第 1 次的马来西亚号码。日志页面的位置以控制台实际页面为准。
4. 截图：短信原文、+65 的提示、Twilio 日志。

## 上线后每周看一次

- Usage Triggers 有没有触发过告警邮件；
- 余额变化是否和注册人数对得上（每个手机号注册约 $0.39）；
- Verify 日志里有没有非马来西亚号码、或者同一号码段大量请求（短信轰炸的迹象）。

如果发现被刷：先到 Supabase 把 sms_sent 改成 0（立即停止发短信），网站会自动提示用户改用邮箱注册；再查日志。

---

## Supabase 组织：强制 MFA（上线前，阻塞上线；rereview-3 低-3）

这一步不是 Twilio 的设置，但同样是「控制台账号」这一层的防线：运维手册（`docs/runbook-emergency-suspend-store.md`）允许有 SQL Editor 权限的人直接停店、读停用原因，Supabase 组织成员的账号一旦被盗，就能绕过应用里的一切权限。所以 Supabase 组织必须强制所有成员使用两步验证。

**由 Song Haw 本人设置**（只有组织 Owner 能改这个开关，不要交给别人代做）：

1. 先给自己的 Supabase 账号开 MFA：Dashboard 右上角头像 → Account preferences / Security → 添加 TOTP。Supabase 不提供恢复码，**建议在另一台设备、另一个验证器 App 上再加一个备用因子**。（来源：https://supabase.com/docs/guides/platform/multi-factor-authentication）
2. 进入组织设置 → **Security** 页签，打开 **Require MFA to access organization**。（来源：https://supabase.com/docs/guides/platform/mfa/org-mfa-enforcement ，2026-11-04 查询）
   - 只在 Pro、Team、Enterprise 方案可用；如果组织还是 Free 方案，页面会提示升级，需先升级（上线本来就不应在 Free 方案上跑生产）。
   - 打开后，没开 MFA 的成员会立刻失去所有项目的访问权限，开了 MFA 后自动恢复，事先通知团队。
   - Personal Access Token（CLI / CI 用）不受这个开关影响，所以另外核对：组织里没有不用的 PAT，CI 用的 token 只放在 GitHub Actions secret 里。
3. 在组织的 Team 页面核对成员名单：有 SQL Editor 权限（Owner / Administrator / Developer，以控制台实际角色为准）的人必须和运维手册第 0 节的书面名单一致；多出来的人降级或移除。
4. 截图：Security 页签上「Require MFA to access organization」已打开；Team 成员列表。存进上线前验收记录（`implementation-plan.md`「上线前验收」的「Supabase 组织安全」一项）。
5. 之后每次人员变动、以及每季度一次，重新核对第 3 步的名单。
