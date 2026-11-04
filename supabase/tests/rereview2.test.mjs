// 第二轮复查（rereview-2）在 PR1b 里要修的项：M-3、L-1、L-8（H-1 的三条在 frontend_alignment.test.mjs 的 Q3 段）
// 第三轮复查（rereview-3）：中-1（L-4 管理员建号按 GoTrue 顺序模拟，做法 A）、低-4（0005 清理边界，文件末尾单独加载 0005）
// 本地：node supabase/tests/rereview2.test.mjs   加载：stub → stub_rereview → 0001 → 0002 → 0003 → 0004（低-4 段之前再加载 0005）
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const M = new URL('../migrations/', import.meta.url).pathname;
const stub = fs.readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf8').replace('grant anon, authenticated, service_role to postgres;', '');
await db.exec(stub);
await db.exec(fs.readFileSync(new URL('./supabase_stub_rereview.sql', import.meta.url), 'utf8'));
for (const f of ['0001_init.sql', '0002_rpc.sql', '0003_security_rereview.sql', '0004_frontend_alignment.sql']) await db.exec(fs.readFileSync(M + f, 'utf8'));

let pass = 0, fail = 0;
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const report = (good, label, extra = '') => { good ? pass++ : fail++; console.log(good ? 'PASS' : 'FAIL', label, extra); };
const ok = (label, cond, extra = '') => report(!!cond, label, extra);
const asAuthAdmin = async fn => { await db.exec('set role supabase_auth_admin'); try { return await fn(); } finally { await db.exec('reset role'); } };
const pw = async id => (await q(`select coalesce(encrypted_password, '') p from auth.users where id=$1`, [id]))[0].p;
const prof = async id => (await q(`select * from profiles where user_id=$1`, [id]))[0];

// ================= M-3 自动确认误开：INSERT 时已验证也擦密码 =================
const [a] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password, email_confirmed_at, raw_user_meta_data)
  values ('auto@x.com', '$2a$10$attacker', now(), '{"store_name":"抢注店"}') returning id`));
ok('M-3 邮箱插入即验证（自动确认）→ 密码被擦除', (await pw(a.id)) === '');
ok('M-3 插入即验证 → password_set_at 为空（middleware 会带去 /set-password）', (await prof(a.id))?.password_set_at === null);
const [b] = await asAuthAdmin(() => q(`insert into auth.users(phone, encrypted_password, phone_confirmed_at)
  values ('60123456789', '$2a$10$attacker', now()) returning id`));
ok('M-3 手机插入即验证 → 密码被擦除', (await pw(b.id)) === '' && (await prof(b.id))?.password_set_at === null);
const [c] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password, email_confirmed_at, raw_user_meta_data)
  values ('fake-ops@x.com', '$2a$10$attacker', now(), '{"provisioned_by":"ops"}') returning id`));
ok('M-3 provisioned_by 写在用户可改的 user_metadata 里 → 不放行，照样擦除', (await pw(c.id)) === '' && (await prof(c.id))?.password_set_at === null);
const [d] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('ops-admin@x.com', '$2a$10$ops', now(), '{"no_store":true,"provisioned_by":"ops"}') returning id`));
ok('M-3 运维脚本建号（app_metadata.provisioned_by = ops）→ 保留密码、记 password_set_at、不建店',
  (await pw(d.id)) === '$2a$10$ops' && (await prof(d.id))?.password_set_at !== null && !(await q(`select 1 from store_members where user_id=$1`, [d.id])).length);
const [e] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password) values ('later@x.com', '$2a$10$x') returning id`));
ok('M-3 未验证插入 → 不擦（由 0003 的首次验证擦除）', (await pw(e.id)) === '$2a$10$x');
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now() where id=$1`, [e.id]));
ok('M-3 之后首次验证 → 擦除（0003 行为不变）', (await pw(e.id)) === '');
await asAuthAdmin(() => q(`update auth.users set encrypted_password = '$2a$10$own' where id=$1`, [e.id]));
ok('M-3 已验证后经 A6 设密码 → 保留并记 password_set_at（0003 行为不变）', (await pw(e.id)) === '$2a$10$own' && (await prof(e.id)).password_set_at !== null);

// ================= L-1 首次验证时删除已有会话 =================
const [f] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password) values ('sess@x.com', '$2a$10$x') returning id`));
await asAuthAdmin(() => q(`insert into auth.sessions(user_id) values ($1), ($1)`, [f.id]));
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now() where id=$1`, [f.id]));
ok('L-1 首次验证（以 supabase_auth_admin 身份）→ 该用户已有会话全部删除', (await q(`select count(*)::int n from auth.sessions where user_id=$1`, [f.id]))[0].n === 0);
await asAuthAdmin(() => q(`insert into auth.sessions(user_id) values ($1)`, [f.id]));
ok('L-1 验证同一事务之后新建的会话不受影响', (await q(`select count(*)::int n from auth.sessions where user_id=$1`, [f.id]))[0].n === 1);
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now(), phone = '60129999999', phone_confirmed_at = now() where id=$1`, [f.id]));
ok('L-1 已验证账号再验证（补手机号）→ 不删会话', (await q(`select count(*)::int n from auth.sessions where user_id=$1`, [f.id]))[0].n === 1);
const [g] = await asAuthAdmin(() => q(`insert into auth.users(email) values ('other@x.com') returning id`));
await asAuthAdmin(() => q(`insert into auth.sessions(user_id) values ($1)`, [g.id]));
const [h] = await asAuthAdmin(() => q(`insert into auth.users(email) values ('h@x.com') returning id`));
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now() where id=$1`, [h.id]));
ok('L-1 只删被验证的这个用户的会话', (await q(`select count(*)::int n from auth.sessions where user_id=$1`, [g.id]))[0].n === 1);

// ================= rereview-3 中-1（L-4）：GoTrue admin API 的真实写入顺序 =================
// GoTrue adminUserCreate（internal/api/admin.go）在同一事务里：tx.Create(user)【INSERT，email_confirmed_at 为空，app_metadata 只有 provider】
//   → UpdateAppMetaData【UPDATE】→ user.Confirm(tx)【UPDATE email_confirmed_at】。托管版本是否一致见清单第 14 项。
// 以 supabase_auth_admin 身份逐条执行，模拟这三步；0001–0004 一行不改（做法 A：scripts/ops/create-admin.ts 两步建号）。
const gotrueAdminCreate = async (email, { password = null, appMetaAtInsert = { provider: 'email' } } = {}) => {
  const [u] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password, raw_app_meta_data) values ($1, $2, $3::jsonb) returning id`,
    [email, password ?? '', JSON.stringify(appMetaAtInsert)]));                                     // ① tx.Create（无密码时 GoTrue 写空串）
  await asAuthAdmin(() => q(`update auth.users set raw_app_meta_data = raw_app_meta_data || $2::jsonb where id=$1`,
    [u.id, JSON.stringify({ providers: ['email'], no_store: true, provisioned_by: 'ops' })]));       // ② UpdateAppMetaData
  await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now() where id=$1`, [u.id])); // ③ user.Confirm（email_confirm: true）
  return u.id;
};
const noStore = async id => !(await q(`select 1 from store_members where user_id=$1`, [id])).length;
// 反例（旧写法，path B）：createUser 时就带 password → ③ 触发 0003 的首次验证擦除，ops 放行管不到 UPDATE
const naive = await gotrueAdminCreate('naive-admin@x.com', { password: '$2a$10$naive' });
ok('中-1 反例：createUser 带密码 → Confirm UPDATE 把密码擦掉、password_set_at 为空（证明旧写法不可用）',
  (await pw(naive)) === '' && (await prof(naive))?.password_set_at === null);
const naive2 = await gotrueAdminCreate('naive-admin2@x.com', { password: '$2a$10$naive', appMetaAtInsert: { provider: 'email', no_store: true, provisioned_by: 'ops' } });
ok('中-1 反例：provisioned_by 在 INSERT 时就带上（path B2）也一样被擦（0004 的 ops 放行只管 INSERT）',
  (await pw(naive2)) === '' && (await prof(naive2))?.password_set_at === null);
// 做法 A：① createUser 不带 password（email_confirm: true + app_metadata）→ ② updateUserById(id, { password })
const adminA = await gotrueAdminCreate('ops-admin-a@x.com');
ok('中-1 做法 A 第一步后：已验证、无密码、已建 profile、没有店铺（no_store）',
  (await pw(adminA)) === '' && (await prof(adminA))?.password_set_at === null && (await noStore(adminA)));
await asAuthAdmin(() => q(`update auth.users set encrypted_password = '$2a$10$opsA' where id=$1`, [adminA]));   // ④ updateUserById
ok('中-1 做法 A 第二步 updateUserById 设密码 → 密码保留、password_set_at 有值（0003 on_auth_user_password_set）',
  (await pw(adminA)) === '$2a$10$opsA' && (await prof(adminA))?.password_set_at !== null);
ok('中-1 做法 A 建好的管理员账号仍然没有店铺', await noStore(adminA));

// ================= L-8 权限扫描扩展到所有非系统 schema =================
const SYS = `('pg_catalog','information_schema','pg_toast')`;
const schemas = (await q(`select nspname from pg_namespace where nspname not in ${SYS} and nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%' order by 1`)).map(r => r.nspname);
console.log('  扫描的 schema：', schemas.join(', '), '（真实项目还有 vault、cron、net、graphql 等，pgTAP / 上线清单第 11、23 项确认）');
const tablePrivs = async role => (await q(`select n.nspname || '.' || c.relname t,
    string_agg(p.priv, ',' order by p.priv) privs
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) p(priv)
  where c.relkind in ('r','v','m','p','f') and n.nspname not in ${SYS}
    and has_table_privilege('${role}', c.oid, p.priv)
  group by 1 order by 1`));
const anonT = await tablePrivs('anon');
ok('L-8 anon 在所有非系统 schema 只有 realtime.messages 的 select/insert（Realtime 私有频道要用，RLS 拦）',
  JSON.stringify(anonT) === JSON.stringify([{ t: 'realtime.messages', privs: 'insert,select' }]), JSON.stringify(anonT));
const custT = await tablePrivs('customer_api');
ok('L-8 customer_api 在所有非系统 schema 没有任何表 / 视图权限', custT.length === 0, JSON.stringify(custT));
const authT = (await tablePrivs('authenticated')).map(r => r.t);
const allowedAuth = ['public.bill_overview', 'public.bills', 'public.blocked_clients', 'public.categories', 'public.dining_tables', 'public.items',
  'public.order_items', 'public.orders', 'public.profiles', 'public.store_members', 'public.stores', 'public.audit_logs', 'realtime.messages', 'storage.objects'];
const extraAuth = authT.filter(t => !allowedAuth.includes(t));
ok('L-8 authenticated 只在白名单表上有权限（private / auth / extensions 等一律没有）', extraAuth.length === 0, JSON.stringify(extraAuth));
const colAll = await q(`select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ${SYS} and c.relkind = 'r'
    and has_any_column_privilege('customer_api', c.oid, 'select,insert,update,references')`);
ok('L-8 customer_api 也没有任何列级权限', colAll.length === 0, JSON.stringify(colAll));
const fnPriv = async role => (await q(`select n.nspname || '.' || p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ${SYS} and has_function_privilege('${role}', p.oid, 'execute') order by 1`)).map(r => r.f);
const custF = await fnPriv('customer_api');
const custExtra = custF.filter(f => !['public.customer_get_bill', 'public.customer_get_menu', 'public.customer_place_order', 'public.customer_quote'].includes(f)
  && !f.startsWith('auth.') && !f.startsWith('realtime.') && !f.startsWith('storage.'));
ok('L-8 customer_api 在 public / private / extensions 等只能执行 4 个顾客函数（auth / storage / realtime 是 stub 的平台函数）', custExtra.length === 0, JSON.stringify(custExtra));
const privF = (await fnPriv('authenticated')).filter(f => f.startsWith('private.'));
// 与 PR1 的 H2 白名单一致：RLS / 列默认值用到的判定和计价辅助函数
const privAllowed = ['private.calc_bill', 'private.can_write_store', 'private.div_round', 'private.is_platform_admin', 'private.is_store_member', 'private.jwt_role', 'private.try_uuid'];
ok('L-8 authenticated 在 private schema 只能执行 H2 白名单里的辅助函数', privF.every(f => privAllowed.includes(f)), JSON.stringify(privF));
ok('L-8 customer_api / anon 对 private schema 没有 USAGE', !(await q(`select has_schema_privilege('customer_api','private','usage') a, has_schema_privilege('anon','private','usage') b`)).some(r => r.a || r.b));

// ================= rereview-3 低-4（0005）：清理按最后一次发确认计时，25 小时下限 =================
await db.exec(fs.readFileSync(M + '0005_purge_resend_boundary.sql', 'utf8'));
await q(`delete from auth.users where email_confirmed_at is null and phone_confirmed_at is null`);   // 只看本段造的数据
const mkU = async (tag, createdH, sentH, confirmed = false) => (await q(`insert into auth.users(email, created_at, confirmation_sent_at, email_confirmed_at)
  values ($1, now() - $2::float8 * interval '1 hour', now() - $3::float8 * interval '1 hour',
          case when $4 then now() end) returning id`, [tag + '@purge.x', createdH, sentH, confirmed]))[0].id;
const P = {
  resent:   await mkU('resent', 30, 2),        // 30 小时前注册，2 小时前重发 → 保留（旧逻辑会删）
  stale:    await mkU('stale', 30, 26),        // 30 小时前注册，26 小时前最后一次发 → 删
  noSent:   await mkU('nosent', 26, null),     // 没有 confirmation_sent_at（短信是否写入需确认）、26 小时 → 删
  edge:     await mkU('edge', 24.5, null),     // 24.5 小时、没有 confirmation_sent_at → 保留（25 小时下限）
  edgeSent: await mkU('edgesent', 24.5, 24.5), // 24.5 小时、最后一次发也是 24.5 小时前 → 保留（25 小时下限）
  fresh:    await mkU('fresh', 1, 1),          // 新注册 → 保留
  verified: await mkU('verified', 48, 48, true), // 已验证的老账号 → 保留
};
const n5 = (await q(`select private.purge_unverified_users() n`))[0].n;
const alive5 = async id => (await q(`select 1 from auth.users where id=$1`, [id])).length === 1;
ok('低-4 清理只删 2 个（最后一次发确认超过 24 小时，且注册超过 25 小时）', n5 === 2, 'purged=' + n5);
ok('低-4 30 小时前注册、2 小时前重发 → 保留（新链接不会被清理任务弄失效）', await alive5(P.resent));
ok('低-4 最后一次发确认在 26 小时前 → 删除', !(await alive5(P.stale)));
ok('低-4 没有 confirmation_sent_at、注册 26 小时 → 删除（退回 25 小时阈值）', !(await alive5(P.noSent)));
ok('低-4 注册 24.5 小时 → 保留（25 小时下限，有无 confirmation_sent_at 都一样）', (await alive5(P.edge)) && (await alive5(P.edgeSent)));
ok('低-4 新注册、已验证老账号 → 保留', (await alive5(P.fresh)) && (await alive5(P.verified)));
ok('低-4 0005 之后函数仍是 security definer + search_path=""，且只有属主能执行',
  (await q(`select p.prosecdef d, p.proconfig c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='private' and p.proname='purge_unverified_users'`))
    .every(r => r.d && JSON.stringify(r.c) === JSON.stringify(['search_path=""']))
  && !(await q(`select bool_or(has_function_privilege(r, 'private.purge_unverified_users()', 'execute')) x
                  from unnest(array['anon','authenticated','service_role','customer_api','supabase_auth_admin']) r`))[0].x);

console.log(`${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
