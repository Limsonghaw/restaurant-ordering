// 第二轮安全复查（0003_security_rereview.sql）验收断言；PR1b 的最终状态（叠加 0004）下运行
// 本地：npm i -D @electric-sql/pglite && node supabase/tests/rereview.test.mjs
// 加载桩与全部迁移；rls_rpc.test.mjs 同样覆盖全部迁移。
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import fs from 'fs';
const db = new PGlite();
const M = new URL('../migrations/', import.meta.url).pathname;
const stub = fs.readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf8').replace('grant anon, authenticated, service_role to postgres;', '');
await db.exec(stub);
await db.exec(fs.readFileSync(new URL('./supabase_stub_rereview.sql', import.meta.url), 'utf8'));
for (const f of ['0001_init.sql', '0002_rpc.sql', '0003_security_rereview.sql', '0004_frontend_alignment.sql']) await db.exec(fs.readFileSync(M + f, 'utf8'));
console.log('MIGRATIONS OK (0001 + 0002 + 0003 + 0004)');

await db.exec(fs.readFileSync(M + '0005_purge_resend_boundary.sql', 'utf8'));
await db.exec(fs.readFileSync(M + '0006_idempotency_device_binding.sql', 'utf8'));
let pass = 0, fail = 0;
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const report = (good, label, extra = '') => { good ? pass++ : fail++; console.log(good ? 'PASS' : 'FAIL', label, extra); };
const ok = (label, cond, extra = '') => report(!!cond, label, extra);
const expectErr = async (label, code, fn, detailHas) => {
  try { await fn(); report(false, label, '(no error)'); }
  catch (e) { const good = (e.message === code || e.message.includes(code)) && (!detailHas || String(e.detail || '').includes(detailHas)); report(good, label, '-> ' + e.message + ' ' + (e.detail || '')); }
};
const asRole = async (role, claims, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`); }
};
const asAuthAdmin = fn => asRole('supabase_auth_admin', {}, fn);            // GoTrue 写 auth.users 的真实身份（L-N7）
const asUser = (uid, fn, aal = 'aal1') => asRole('authenticated', { sub: uid, role: 'authenticated', aal }, fn);
const cust = (sql, p) => asRole('customer_api', {}, () => q(sql, p));     // H-N2：直连，不带 JWT
const H = s => createHash('sha256').update(String(s)).digest('hex');
const pw = async id => (await q(`select encrypted_password p from auth.users where id=$1`, [id]))[0].p;
const prof = async id => (await q(`select * from profiles where user_id=$1`, [id]))[0];
const storeOf = async id => (await q(`select store_id from store_members where user_id=$1`, [id]))[0]?.store_id;

// ================= H-N1 先验证、后设密码（以 supabase_auth_admin 身份执行，同时覆盖 L-N7） =================
const [atk] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password, raw_user_meta_data)
  values ('victim@x.com', '$2a$10$attacker', '{"store_name":"受害店"}') returning id`));
ok('H-N1 抢注的未验证账号：不建店、密码暂存', !(await storeOf(atk.id)) && (await pw(atk.id)) === '$2a$10$attacker');
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now() where id=$1`, [atk.id]));
ok('H-N1 首次邮箱验证 → 注册时带的密码被清空', (await pw(atk.id)) === '');
ok('L-N7 supabase_auth_admin 身份验证时触发器照常建店', !!(await storeOf(atk.id)));
ok('H-N1 验证后 password_set_at 为空（middleware 会强制 /set-password）', (await prof(atk.id)).password_set_at === null);

const [atk2] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password) values ('v2@x.com', '$2a$10$old') returning id`));
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now(), encrypted_password = '$2a$10$stale' where id=$1`, [atk2.id]));
ok('H-N1 验证那次 UPDATE 同时写回旧密码（整行更新）也被清空', (await pw(atk2.id)) === '');

const [ph] = await asAuthAdmin(() => q(`insert into auth.users(phone, encrypted_password) values ('60123000001', '$2a$10$atk') returning id`));
await asAuthAdmin(() => q(`update auth.users set phone_confirmed_at = now() where id=$1`, [ph.id]));
ok('H-N1 首次手机验证 → 密码清空并建店', (await pw(ph.id)) === '' && !!(await storeOf(ph.id)));

await asAuthAdmin(() => q(`update auth.users set encrypted_password = '$2a$10$owner' where id=$1`, [atk.id]));
const p1 = await prof(atk.id);
ok('H-N1 已验证后设密码（A6）→ 保留，并记录 password_set_at', (await pw(atk.id)) === '$2a$10$owner' && p1.password_set_at !== null);
await asAuthAdmin(() => q(`update auth.users set encrypted_password = '$2a$10$owner2' where id=$1`, [atk.id]));
ok('H-N1 再次改密码 → 保留，password_set_at 不变（只记第一次）',
  (await pw(atk.id)) === '$2a$10$owner2' && (await prof(atk.id)).password_set_at.getTime() === p1.password_set_at.getTime());
await asAuthAdmin(() => q(`update auth.users set email = 'p2@x.com', email_confirmed_at = now() where id=$1`, [ph.id]));
await asAuthAdmin(() => q(`update auth.users set encrypted_password = '$2a$10$ph' where id=$1`, [ph.id]));
await asAuthAdmin(() => q(`update auth.users set email_confirmed_at = now() where id=$1`, [ph.id]));
ok('H-N1 已验证账号再验证邮箱 → 不清空密码', (await pw(ph.id)) === '$2a$10$ph');
const [unv] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password) values ('u@x.com', '$2a$10$x') returning id`));
await asAuthAdmin(() => q(`update auth.users set encrypted_password = '$2a$10$y' where id=$1`, [unv.id]));
ok('H-N1 未验证账号改密码 → 不记 password_set_at（也没有 profile）', !(await prof(unv.id)));
const [adm] = await asAuthAdmin(() => q(`insert into auth.users(email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('admin@x.com', '$2a$10$adm', now(), '{"no_store":true,"provisioned_by":"ops"}') returning id`));
ok('H-N1 admin API 建号（插入即验证、带密码）→ 不清空、password_set_at 有值', (await pw(adm.id)) === '$2a$10$adm' && (await prof(adm.id)).password_set_at !== null);

// 清理未验证账号
const [old1] = await q(`insert into auth.users(email, created_at) values ('old@x.com', now() - interval '25 hours') returning id`);
const [old2] = await q(`insert into auth.users(phone, created_at) values ('60123000099', now() - interval '25 hours') returning id`);
const [new1] = await q(`insert into auth.users(email, created_at) values ('new@x.com', now() - interval '1 hour') returning id`);
const [oldv] = await q(`insert into auth.users(email, created_at, email_confirmed_at) values ('oldv@x.com', now() - interval '30 hours', now()) returning id`);
const purged = (await q(`select private.purge_unverified_users() n`))[0].n;
const alive = async id => (await q(`select 1 from auth.users where id=$1`, [id])).length === 1;
ok('H-N1 清理：超过 24 小时未验证的邮箱 / 手机账号被删', purged === 2 && !(await alive(old1.id)) && !(await alive(old2.id)), 'purged=' + purged);
ok('H-N1 清理：24 小时内未验证的保留、已验证的保留', (await alive(new1.id)) && (await alive(oldv.id)) && (await alive(unv.id)));
for (const r of ['anon', 'authenticated', 'service_role', 'customer_api', 'supabase_auth_admin'])
  ok(`H-N1 ${r} 不能执行 purge_unverified_users`, !(await q(`select has_function_privilege('${r}','private.purge_unverified_users()','execute') x`))[0].x);

// ================= M-N1 Before User Created Hook =================
const hook = async (user) => (await asAuthAdmin(() => q(`select private.hook_before_user_created($1::jsonb) r`, [JSON.stringify({ metadata: { name: 'before-user-created' }, user })])))[0].r;
ok('M-N1 hook：马来西亚手机号 60123456789 放行', JSON.stringify(await hook({ phone: '60123456789' })) === '{}');
ok('M-N1 hook：带 + 的 +601123456789 放行', JSON.stringify(await hook({ phone: '+601123456789' })) === '{}');
ok('M-N1 hook：邮箱注册（phone 为空）放行', JSON.stringify(await hook({ email: 'a@b.com', phone: '' })) === '{}');
for (const [lbl, p] of [['新加坡 6591234567', '6591234567'], ['牙买加 18765551234', '18765551234'], ['马来西亚固话 60321234567', '60321234567'], ['位数不够 6012345', '6012345'], ['位数过多 6012345678901', '6012345678901']]) {
  const r = await hook({ phone: p });
  ok(`M-N1 hook 拒绝${lbl} → 400 PHONE_NOT_SUPPORTED`, r?.error?.http_code === 400 && r.error.message === 'PHONE_NOT_SUPPORTED', JSON.stringify(r));
}
for (const r of ['anon', 'authenticated', 'service_role', 'customer_api'])
  ok(`M-N1 ${r} 不能执行 hook`, !(await q(`select has_function_privilege('${r}','private.hook_before_user_created(jsonb)','execute') x`))[0].x);
const authAdminFns = (await q(`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
  and has_function_privilege('supabase_auth_admin', p.oid, 'execute') order by 1`)).map(r => r.proname);
ok('M-N1 supabase_auth_admin 在 public/private 只能执行 hook', JSON.stringify(authAdminFns) === '["hook_before_user_created"]', JSON.stringify(authAdminFns));

// ================= H-N2 customer_api 数据库登录角色 =================
const [role] = await q(`select rolcanlogin, rolinherit, rolconnlimit, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolconfig from pg_roles where rolname='customer_api'`);
ok('H-N2 customer_api 可登录、noinherit、连接上限 20', role.rolcanlogin && !role.rolinherit && role.rolconnlimit === 20, JSON.stringify(role));
ok('H-N2 customer_api 不是超级用户、不能建角色/库、不绕过 RLS', !role.rolsuper && !role.rolcreaterole && !role.rolcreatedb && !role.rolbypassrls);
ok('H-N2 statement_timeout=3s、idle_in_transaction_session_timeout=5s',
  (role.rolconfig || []).includes('statement_timeout=3s') && (role.rolconfig || []).includes('idle_in_transaction_session_timeout=5s'), JSON.stringify(role.rolconfig));
ok('H-N2 authenticator 不再能切换到 customer_api', !(await q(`select pg_has_role('authenticator','customer_api','member') x`))[0].x);
ok('H-N2 customer_api 不属于任何其他角色', (await q(`select count(*)::int n from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='customer_api'`))[0].n === 0);
const custFns = (await q(`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
  and has_function_privilege('customer_api', p.oid, 'execute') order by 1`)).map(r => r.proname);
ok('H-N2 customer_api 只能执行 4 个 customer_*', JSON.stringify(custFns) === JSON.stringify(['customer_get_bill','customer_get_menu','customer_place_order','customer_quote']), JSON.stringify(custFns));
const tblPriv = await q(`select n.nspname||'.'||c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','v','m','p') and n.nspname in ('public','private','auth','storage','realtime')
    and (has_table_privilege('customer_api', c.oid, 'select') or has_table_privilege('customer_api', c.oid, 'insert')
      or has_table_privilege('customer_api', c.oid, 'update') or has_table_privilege('customer_api', c.oid, 'delete'))`);
ok('H-N2 customer_api 对 public/private/auth/storage/realtime 任何表都没有权限', tblPriv.length === 0, JSON.stringify(tblPriv));
await asRole('customer_api', {}, () => expectErr('H-N2 customer_api 读 auth.users → permission denied', 'permission denied', () => q(`select * from auth.users`)));
await asRole('customer_api', {}, () => expectErr('H-N2 customer_api 读 storage.objects → permission denied', 'permission denied', () => q(`select * from storage.objects`)));
await asRole('customer_api', {}, () => expectErr('H-N2 customer_api 在 public 建表 → permission denied', 'permission denied', () => q(`create table public.evil(x int)`)));
ok('H-N2 customer_api 对 private / auth schema 没有 usage', !(await q(`select has_schema_privilege('customer_api','private','usage') a`))[0].a
  && !(await q(`select has_schema_privilege('customer_api','auth','usage') a`))[0].a);

// ================= 下单相关（M-N3、L-N3、L9） =================
const [own] = await q(`insert into auth.users(email, raw_user_meta_data, email_confirmed_at) values ('own@x.com','{"store_name":"测试店"}', now()) returning id`);
const S = await storeOf(own.id);
const F = await asUser(own.id, async () => {
  const [c] = await q(`insert into categories(store_id,name) values ($1,'饮料') returning id`, [S]);
  const [i] = await q(`insert into items(store_id,category_id,name,price_cents) values ($1,$2,'奶茶',530) returning id`, [S, c.id]);
  const t = [];
  for (let k = 0; k < 12; k++) t.push((await q(`insert into dining_tables(store_id,label) values ($1,$2) returning id`, [S, 'T' + k]))[0].id);
  return { item: i.id, t };
});
let n = 1;
const rid = () => `${String(n++).padStart(8, '0')}-0000-4000-8000-000000000000`;
const place = async ({ table, dev, ip, captcha = false, tok = null, r = rid() }) => (await cust(
  `select customer_place_order($1,$2,1,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) r`,
  [S, table, r, H('req' + r), JSON.stringify([{ item_id: F.item, quantity: 1, unit_price_cents: 530 }]), H(dev), H(ip), tok, H('tok' + r), captcha]))[0].r;
const ok1 = await place({ table: F.t[0], dev: 'd-a', ip: 'ip-a' });
ok('H-N2 customer_api 直连仍能下单', ok1.replayed === false);

// L-N3 设备编号
const seqOf = async id => (await q(`select device_seq_in_bill s from orders where id=$1`, [id]))[0].s;
const o2 = await place({ table: F.t[0], dev: 'd-a', ip: 'ip-a' });
const o3 = await place({ table: F.t[0], dev: 'd-b', ip: 'ip-a' });
const o4 = await place({ table: F.t[0], dev: 'd-c', ip: 'ip-a' });
const o5 = await place({ table: F.t[0], dev: 'd-b', ip: 'ip-a' });
ok('L-N3 第一个设备 = 设备 #1，同设备再下单仍是 #1', (await seqOf(ok1.order.id)) === 1 && (await seqOf(o2.order.id)) === 1);
ok('L-N3 新设备依次为 #2、#3，老设备回来沿用原编号', (await seqOf(o3.order.id)) === 2 && (await seqOf(o4.order.id)) === 3 && (await seqOf(o5.order.id)) === 2);
const o6 = await place({ table: F.t[1], dev: 'd-c', ip: 'ip-a' });
ok('L-N3 另一张账单重新从 #1 开始', (await seqOf(o6.order.id)) === 1);
const rep = await cust(`select customer_place_order($1,$2,1,$3,$4,$5::jsonb,$6,$7,null,$8,false) r`,
  [S, F.t[0], '00000003-0000-4000-8000-000000000000', H('req00000003-0000-4000-8000-000000000000'), JSON.stringify([{ item_id: F.item, quantity: 1, unit_price_cents: 530 }]), H('d-b'), H('ip-a'), H('x')]);
ok('L-N3 幂等重放不改设备编号', rep[0].r.replayed === true && (await seqOf(o3.order.id)) === 2);
ok('L-N3 店家能读到 device_seq_in_bill', (await asUser(own.id, () => q(`select device_seq_in_bill from orders where id=$1`, [o4.order.id])))[0].device_seq_in_bill === 3);
await asUser(own.id, () => expectErr('L-N3 店家不能改 device_seq_in_bill', 'permission denied', () => q(`update orders set device_seq_in_bill=9 where id=$1`, [o4.order.id])));

// M-N3 同店同 IP：已有 6 单（ip-a）。凑到 20 单（各桌 ≤10、各设备 ≤10）
const plan = [];
for (let k = 0; k < 14; k++) plan.push({ table: F.t[2 + (k % 5)], dev: 'm' + k, ip: 'ip-a' });
for (const p of plan) await place(p);
ok('M-N3 同 IP 第 20 单前不要求验证码', (await q(`select count(*)::int c from order_client_meta where ip_hash=$1`, [H('ip-a')]))[0].c === 20);
await expectErr('M-N3 同店同 IP 10 分钟第 21 单、未过 Turnstile → CAPTCHA_REQUIRED(ip_db)', 'CAPTCHA_REQUIRED', () => place({ table: F.t[7], dev: 'z1', ip: 'ip-a' }), 'ip_db');
ok('M-N3 过了 Turnstile 的第 21 单 → 成功（不再硬拒绝店内 Wi-Fi）', (await place({ table: F.t[7], dev: 'z1', ip: 'ip-a', captcha: true })).replayed === false);
// 凑到 100 单：桌 2–11 各 ≤10 单
let cnt = 21, k2 = 0;
const tableCount = async t => (await q(`select count(*)::int c from orders where table_id=$1`, [t]))[0].c;
for (let ti = 2; ti < 12 && cnt < 100; ti++) {
  while (cnt < 100 && (await tableCount(F.t[ti])) < 10) { await place({ table: F.t[ti], dev: 'f' + (k2++), ip: 'ip-a', captcha: true }); cnt++; }
}
ok('M-N3 已有 100 单（同 IP）', (await q(`select count(*)::int c from order_client_meta where ip_hash=$1`, [H('ip-a')]))[0].c === 100, 'cnt=' + cnt);
await expectErr('M-N3 同 IP 第 101 单即使过了 Turnstile → RATE_LIMITED(ip_db)', 'RATE_LIMITED', () => place({ table: F.t[1], dev: 'last', ip: 'ip-a', captcha: true }), 'ip_db');

// L9
const def = (await q(`select pg_get_functiondef('private.resolve_table(uuid,uuid,integer,text)'::regprocedure) d`))[0].d;
ok('L9 resolve_table 的 order 分支对 stores 加 for share', /from public\.stores where id = p_store_id for share/.test(def));
await q(`update stores set status='suspended' where id=$1`, [S]);
await expectErr('L9 停用后下单仍报 STORE_SUSPENDED', 'STORE_SUSPENDED', () => place({ table: F.t[1], dev: 'sx', ip: 'ip-s' }));
await q(`update stores set status='active' where id=$1`, [S]);

// ================= L-N1 平台管理员 aal2、no_store =================
ok('L-N1 app_metadata.no_store 的账号：有 profile、不建店', !!(await prof(adm.id)) && !(await storeOf(adm.id)));
const [selfNs] = await q(`insert into auth.users(email, email_confirmed_at, raw_user_meta_data) values ('ns@x.com', now(), '{"no_store":true}') returning id`);
ok('L-N1 用户自己填的 user_metadata.no_store 不认，照常建店', !!(await storeOf(selfNs.id)));
await q(`update profiles set role='platform_admin' where user_id=$1`, [adm.id]);
await asUser(adm.id, () => expectErr('L-N1 管理员 aal1 → admin_list_stores 被拒（0004 起错误码 MFA_REQUIRED）', 'MFA_REQUIRED', () => q(`select admin_list_stores()`)), 'aal1');
await asUser(adm.id, () => expectErr('L-N1 管理员 aal1 → admin_set_store_status 被拒（0004 起错误码 MFA_REQUIRED）', 'MFA_REQUIRED', () => q(`select admin_set_store_status($1,'suspended','x')`, [S])), 'aal1');
ok('L-N1 管理员 aal1 → RLS 下看不到任何店铺', (await asUser(adm.id, () => q(`select count(*)::int c from stores`), 'aal1'))[0].c === 0);
const total = (await q(`select count(*)::int c from stores`))[0].c;
ok('L-N1 管理员 aal2 → admin_list_stores 正常', (await asUser(adm.id, () => q(`select admin_list_stores() r`), 'aal2'))[0].r.total === total);
ok('L-N1 管理员 aal2 → RLS 下能看到全部店铺', (await asUser(adm.id, () => q(`select count(*)::int c from stores`), 'aal2'))[0].c === total);
ok('L-N1 普通店主带 aal2 也不是管理员', (await asUser(own.id, () => q(`select private.is_platform_admin() x`), 'aal2'))[0].x === false);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
