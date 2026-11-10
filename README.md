# 餐厅扫码点餐

面向多店的餐厅扫码点餐 SaaS。当前提供 Next.js App Router、TypeScript strict、Tailwind CSS、Supabase 客户端工厂及基础 CI，首页为简体中文占位页面。

## 本地启动

使用 Node.js 22+（当前 Supabase SDK 的最低要求） 和 npm，推荐 Node.js 24（与 CI 一致）。

```sh
npm ci
cp .env.example .env.local
npm run dev
```

浏览器访问本地 3000 端口。默认 `NEXT_PUBLIC_DATA_SOURCE=mock`，首页不连接数据库；数据层由后续 PR-A 实现。切换为 `supabase` 的数据层尚未实现。无需真实密钥即可启动首页。

## 环境变量

完整变量及中文说明见 [.env.example](.env.example)。本地值放在 `.env.local`，部署值通过部署平台配置。`NEXT_PUBLIC_` 变量会进入浏览器，不能填服务端密钥。`SUPABASE_SERVICE_ROLE_KEY`、`CUSTOMER_API_DATABASE_URL` 和 `TURNSTILE_SECRET_KEY` 仅限服务端使用；当前骨架不使用它们。Supabase 工厂仅在调用时读取公开 URL 和匿名密钥，缺少时会报错。

## 目录结构

```text
app/                       根布局、首页、全局样式
lib/supabase/              浏览器与服务端客户端工厂
proxy.ts                   Next.js 16 请求透传占位
tests/                    Vitest 单元测试
docs/                     原始设计与运维资料
supabase/migrations/      原始数据库迁移
supabase/tests/           原始数据库测试
supabase/templates/       原始邮件模板
scripts/                  原始运维脚本
.github/workflows/ci.yml    自动检查
```

`docs/`、`supabase/`、`scripts/` 从资料目录原样复制，不参与本 PR 的 ESLint、Prettier、TypeScript 或 Vitest 检查。原始数据库测试和运维脚本需要独立环境及工具，未在骨架 CI 中执行。服务端工厂支持 Cookie 适配；认证守卫与会话刷新由后续 PR 实现。

## 检查命令

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
npm run format
```

`npm start` 需要先构建；`npm run format` 只格式化本骨架文件，保留复制资料原貌。CI 依次执行安装、静态检查、单元测试和生产构建，构建使用虚假公开变量，无需密钥。

## PR 规则

所有变更只开 PR，是否合并由负责人决定，禁止自行合并。密钥只放环境变量，绝不进入仓库或提交信息；不提交真实服务地址、token 或任何凭据。参考资料中的公开文档链接保持原样。提交前必须通过 CI 对应的全部检查。

## PR-A 假数据预览

从 `/t/demo-a1` 开始；空桌为 `/t/demo-a2`，零费率 `/t/demo-b1`，暂停接单 `/t/demo-paused`，停用店铺 `/t/demo-suspended`，无效桌码 `/t/demo-a9`。店家框架从 `/store` 进入。界面只通过 `lib/data/index.ts` 调用数据，`lib/data/types.ts` 是后续 PR 共享的追加式类型合约。

`NEXT_PUBLIC_DATA_SOURCE=mock` 为默认；改成 `supabase` 后需重启或重新构建，目前会显示「未实现」，不会请求 Supabase。mock 只在浏览器运行，以 `ro-mock:` 存状态，以 `cart:{code}` 分桌保存购物车。右下「假数据」支持延迟、错误、验证码、自动推进、结账、重置桌码、过期和换手机；「重置全部假数据」会清除这些演示状态和购物车。模拟设备和令牌仅在数据层内部使用，页面无需读取。无真实账号密码。

验证码 site key 留空时不加载外部脚本，使用勾选占位。设置公开 site key 后才按需加载官方 Turnstile；三种公开测试 key 见 `.env.example`，`VERCEL_ENV=production` 禁止测试 key。每次提交后都重置验证码；真实校验归后端负责。

公共组件位于 `lib/ui/common.tsx`，验证码位于 `lib/ui/captcha.tsx`，后台框架 `StoreShell` 支持 `banners` 叠放和 `newOrderCount` 角标。后续模拟项按 `lib/ui/mock-panel-a.ts`、`lib/data/mock/controls-a.ts` 的领域文件方式追加。金额和时间统一使用 `lib/format.ts`；金额只在 mock 内部计价，页面展示数据层返回值。
