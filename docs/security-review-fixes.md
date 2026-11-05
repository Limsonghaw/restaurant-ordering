# 安全审查修复与验证

- 0006 保留原 RPC 签名与权限；返回幂等订单、轮换令牌之前，核对原订单桌号、元数据设备哈希和请求哈希。不匹配（包括清理后为空的设备哈希）统一返回 `IDEMPOTENCY_KEY_REUSED`，不带订单详情。
- `npm ci` 安装锁定的 PGlite 与 Supabase CLI。`npm run test:db:unit` 顺序执行五套隔离模拟测试；主 RLS/RPC 测试自动按顺序加载全部迁移，其余迁移过渡测试保留中间状态断言并加载后续迁移。
- CI 的独立 database job 必须通过模拟测试和 `npm run test:db`。后者在本地 Supabase PostgreSQL 中应用全部迁移后执行 pgTAP，覆盖真实角色、Auth 触发器、跨店和匿名隔离、函数白名单、敏感字段、管理员 MFA、重放归属与令牌不变性。任何失败都会使 job 失败，不允许跳过。
- 本地集成测试：先 `npx --no-install supabase start`（需要 Docker），再 `npm run test:db`。CI 只启动数据库相关容器，不需要 Auth、短信或 CAPTCHA 密钥。
- `supabase/config.toml` 是本地无密钥基线，启用验证要求、密码规则、号码 Hook、邮件模板及限流；本地短信注册和 CAPTCHA 关闭。生产必须在 Dashboard 开启 Turnstile、配置短信商与 SMTP、确认 Hook 和模板生效，使用实际域名的两个精确重定向地址，确认无测试 OTP。不得把本地配置 push 到生产。远端设置尚未验收。
- 页面统一返回 CSP（含 `frame-ancestors 'none'`）、DENY、Referrer-Policy 和 nosniff。CSP 为兼容静态 Next.js hydration 保留 inline script；开发模式额外允许 eval，未来动态认证页面可升级为 nonce。HSTS 留待 HTTPS 托管验收。
- CI Actions 使用已从上游 tag 核对的完整提交 SHA，checkout 不保留凭据。

本次环境验证：默认 npm 缓存目录只读，改用 `/tmp/restaurant-npm-cache` 后安装成功；五套数据库模拟测试及 lint、typecheck、test、build 通过，生产服务实测返回上述响应头。CLI 的本地目录只读问题已通过 `SUPABASE_HOME=/tmp/restaurant-supabase` 绕过，但本机没有 Docker / Podman，真实角色 pgTAP 无法在本机执行；须以 CI 的 database job 结果为准。未访问生产 Dashboard，未执行远端迁移或上线配置。
