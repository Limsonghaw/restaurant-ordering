/**
 * scripts/ops/create-admin.ts —— 建平台管理员账号（只在运维本机运行；Vercel 上没有 secret key）
 *
 * rereview-3 中-1（L-4）做法 A：两步建号，不改任何迁移。
 *   GoTrue 的 admin createUser 在同一事务里是 INSERT → UPDATE app_metadata → Confirm UPDATE。
 *   最后那次 Confirm 会触发 0003 的「首次验证清空密码」，所以 createUser 时带的密码一定会被擦掉。
 *   因此：
 *     1) auth.admin.createUser —— 不传 password，email_confirm: true，app_metadata = { no_store, provisioned_by: 'ops' }；
 *     2) auth.admin.updateUserById(id, { password }) —— 此时已验证，0003 的 on_auth_user_password_set 记 password_set_at；
 *     3) signInWithPassword 自检 —— 登录不成功就以非 0 退出码大声失败。
 *   PGlite 模拟见 supabase/tests/rereview2.test.mjs「中-1」段；真实项目的验收是 implementation-plan PR5 第 2d 项 + 清单第 14 项。
 *
 * 所有机密只从环境变量读，不接受命令行参数，不打印：
 *   SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_URL   项目地址
 *   SUPABASE_SECRET_KEY                         sb_secret_…（只在本机临时 export，用完 unset）
 *   ADMIN_EMAIL                                 管理员邮箱
 *   ADMIN_PASSWORD                              管理员密码（≥ 8 位，含字母和数字，与 GoTrue 密码规则一致）
 * 可选：
 *   ADMIN_RESUME_USER_ID                        第 2 步失败后重跑：跳过第 1 步，直接给这个已建好的账号设密码并自检
 *
 * 用法（示例；先在 Preview 项目跑）：
 *   read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=… ADMIN_EMAIL=ops@example.com npx tsx scripts/ops/create-admin.ts
 *
 * 成功后还要手工做（脚本不做，避免 secret key 直接写 profiles.role）：
 *   在 SQL Editor：update public.profiles set role = 'platform_admin' where user_id = '<脚本输出的 user id>';
 *   然后用这个账号登录 /admin/mfa 绑定 TOTP（未到 aal2 前调 admin_* 返回 MFA_REQUIRED）。
 */
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

class CreateAdminError extends Error {}

function env(name: string, ...fallbacks: string[]): string {
  for (const n of [name, ...fallbacks]) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  throw new CreateAdminError(`缺少环境变量 ${[name, ...fallbacks].join(' 或 ')}`);
}

function assertPasswordPolicy(pw: string): void {
  // 与 config.toml 的 minimum_password_length = 8、password_requirements = "letters_digits" 一致（M-2）
  if (pw.length < 8 || pw.length > 72 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw new CreateAdminError('ADMIN_PASSWORD 不符合密码规则：8–72 位，且同时包含字母和数字');
  }
}

function newClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

async function step1CreateWithoutPassword(admin: SupabaseClient, email: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,                                   // 直接标为已验证（运维建号，不发确认信）
    app_metadata: { no_store: true, provisioned_by: 'ops' }, // 只有 service role 能写；handle_new_user 据此不建店
    // 注意：这里故意不传 password（L-4：会被 Confirm UPDATE 触发的 0003 擦除）
  });
  if (error || !data.user) throw new CreateAdminError(`第 1 步 createUser 失败：${error?.message ?? '没有返回 user'}`);
  const u = data.user;
  if (!u.email_confirmed_at) throw new CreateAdminError(`第 1 步异常：账号 ${u.id} 没有 email_confirmed_at`);
  if (u.app_metadata?.provisioned_by !== 'ops' || u.app_metadata?.no_store !== true) {
    throw new CreateAdminError(`第 1 步异常：账号 ${u.id} 的 app_metadata 不对：${JSON.stringify(u.app_metadata)}`);
  }
  return u;
}

async function step2SetPassword(admin: SupabaseClient, userId: string, password: string): Promise<void> {
  const { data, error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error || !data.user) {
    throw new CreateAdminError(
      `第 2 步 updateUserById 设密码失败：${error?.message ?? '没有返回 user'}。` +
      `账号已建好但没有密码；修正后设 ADMIN_RESUME_USER_ID=${userId} 重跑本脚本（不会重复建号）`);
  }
}

async function step3SelfCheck(url: string, secretKey: string, email: string, password: string): Promise<void> {
  // 用 secret key 的独立客户端登录：GoTrue 对 admin 凭据跳过 CAPTCHA（middleware.go verifyCaptcha → requireAdminCredentials）
  const check = newClient(url, secretKey);
  const { data, error } = await check.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new CreateAdminError(
      `第 3 步自检失败：signInWithPassword 不成功（${error?.code ?? ''} ${error?.message ?? '没有会话'}）。` +
      '密码很可能被首次验证触发器擦掉了，或者 GoTrue 的建号顺序与预期不同（清单第 14 项）。不要把这个账号交付使用');
  }
  await check.auth.signOut({ scope: 'local' }); // 自检会话不保留；本地进程退出后也不留存（persistSession: false）
}

async function main(): Promise<void> {
  const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const secretKey = env('SUPABASE_SECRET_KEY');
  const email = env('ADMIN_EMAIL').toLowerCase();
  const password = env('ADMIN_PASSWORD');
  const resumeId = process.env.ADMIN_RESUME_USER_ID?.trim() || null;
  assertPasswordPolicy(password);

  const admin = newClient(url, secretKey);

  let userId: string;
  if (resumeId) {
    const { data, error } = await admin.auth.admin.getUserById(resumeId);
    if (error || !data.user) throw new CreateAdminError(`ADMIN_RESUME_USER_ID 找不到账号：${error?.message ?? ''}`);
    if (data.user.email?.toLowerCase() !== email || data.user.app_metadata?.provisioned_by !== 'ops') {
      throw new CreateAdminError('ADMIN_RESUME_USER_ID 对应的账号邮箱不符，或不是运维脚本建的账号，拒绝改密码');
    }
    userId = resumeId;
    console.log(`[1/3] 跳过建号，继续处理已有账号 ${userId}`);
  } else {
    const u = await step1CreateWithoutPassword(admin, email);
    userId = u.id;
    console.log(`[1/3] 已建号（无密码、已验证、no_store）：${userId}`);
  }

  await step2SetPassword(admin, userId, password);
  console.log('[2/3] 已设置密码（updateUserById）');

  await step3SelfCheck(url, secretKey, email, password);
  console.log('[3/3] 自检通过：signInWithPassword 成功');

  console.log(`\n下一步（手工）：在 SQL Editor 执行\n  update public.profiles set role = 'platform_admin' where user_id = '${userId}';\n` +
    '然后用该账号登录并在 /admin/mfa 绑定 TOTP。');
}

main().catch((e: unknown) => {
  console.error(`\n✖ create-admin 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
