// 更新 8（0004_frontend_alignment.sql）验收断言：回答前端 7 问 + 解除拉黑
// 本地：npm i -D @electric-sql/pglite && node supabase/tests/frontend_alignment.test.mjs
// 加载顺序：supabase_stub.sql → supabase_stub_rereview.sql → 0001 → 0002 → 0003 →（造一条旧停用原因）→ 0004
// H-1 的三条（店家读 status_reason 得 42501；读不到 admin 审计行；管理员经 admin_list_stores 能读）在 Q3 段
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import fs from 'fs';
const db = new PGlite();
const M = new URL('../migrations/', import.meta.url).pathname;
const stub = fs.readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf8').replace('grant anon, authenticated, service_role to postgres;', '');
await db.exec(stub);
await db.exec(fs.readFileSync(new URL('./supabase_stub_rereview.sql', import.meta.url), 'utf8'));
for (const f of ['0001_init.sql', '0002_rpc.sql', '0003_security_rereview.sql']) await db.exec(fs.readFileSync(M + f, 'utf8'));

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
const asUser = (uid, fn, aal = 'aal1') => asRole('authenticated', { sub: uid, role: 'authenticated', aal }, fn);
const cust = (sql, p) => asRole('customer_api', {}, () => q(sql, p));
const H = s => createHash('sha256').update(String(s)).digest('hex');
const storeOf = async id => (await q(`select store_id from store_members where user_id=$1`, [id]))[0]?.store_id;
const newOwner = async (email, meta = '{}') => (await q(`insert into auth.users(email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2::jsonb) returning id`, [email, meta]))[0].id;

// 0004 之前已有的停用原因（迁移后仍在 stores，只是店家读不到）
const legacy = await newOwner('legacy@x.com');
const SL = await storeOf(legacy);
await q(`update stores set status='suspended', status_reason='旧原因：多次投诉', status_changed_at=now() where id=$1`, [SL]);
await db.exec(fs.readFileSync(M + '0004_frontend_alignment.sql', 'utf8'));
console.log('MIGRATIONS OK (0001 + 0002 + 0003 + 0004)');

// ================= H-1 / Q3 停用原因对店家隐藏（rereview-2 隐藏方案） 【待安全顾问复查】 =================
ok('H-1 status_reason 仍在 stores（管理员用），旧原因原样保留', (await q(`select status_reason from stores where id=$1`, [SL]))[0]?.status_reason === '旧原因：多次投诉');
await asUser(legacy, () => expectErr('H-1 店家 select status_reason → 42501 permission denied', 'permission denied', () => q(`select status_reason from stores`)));
const colPriv = await q(`select column_name, has_column_privilege('authenticated', 'public.stores', column_name, 'select') p
  from information_schema.columns where table_schema='public' and table_name='stores' order by 1`);
ok('H-1 authenticated 对 stores 的列级 select：除 status_reason 外全部可读', colPriv.every(c => c.p === (c.column_name !== 'status_reason')), JSON.stringify(colPriv.filter(c => !c.p).map(c => c.column_name)));
ok('H-1 authenticated 对 stores 没有表级 select', !(await q(`select has_table_privilege('authenticated','public.stores','select') x`))[0].x);
const ctxL = (await asUser(legacy, () => q(`select get_my_context() r`)))[0].r;
ok('H-1 停用店的店家：M1 看得到 status=suspended，看不到原因', ctxL.store.status === 'suspended' && !JSON.stringify(ctxL).includes('多次投诉') && !('status_reason' in ctxL.store), JSON.stringify(ctxL.store));
// 以后新加的列默认店家读不到（列级授权，fail-closed）
await q(`alter table stores add column zz_platform_only text`);
await asUser(legacy, () => expectErr('H-1 stores(*) / select * → 店家被拒（M1 必须写显式列）', 'permission denied', () => q(`select * from stores`)));
ok('H-1 显式列照常可读', (await asUser(legacy, () => q(`select id, name, status, is_profile_complete from stores`))).length === 1);
await q(`alter table stores drop column zz_platform_only`);

const own = await newOwner('own@x.com', '{"store_name":"测试店"}');
const S = await storeOf(own);
const [adm] = await q(`insert into auth.users(email, email_confirmed_at, raw_app_meta_data) values ('adm@x.com', now(), '{"no_store":true}') returning id`);
await q(`update profiles set role='platform_admin' where user_id=$1`, [adm.id]);
const setSt = (st, reason) => asUser(adm.id, () => q(`select admin_set_store_status($1,$2,$3) r`, [S, st, reason]), 'aal2');
const r1 = (await setSt('suspended', '涉嫌刷单 A'))[0].r;
ok('H-1 管理员停用：返回里有 status_reason（只给平台）', r1.status === 'suspended' && r1.status_reason === '涉嫌刷单 A');
await asUser(own, () => expectErr('H-1 停用后店家 select status_reason → 42501', 'permission denied', () => q(`select status_reason from stores where id=$1`, [S])));
const listed = (await asUser(adm.id, () => q(`select admin_list_stores() r`), 'aal2'))[0].r.stores.find(s => s.id === S);
ok('H-1 管理员经 admin_list_stores 能读原因（另含 is_profile_complete）', listed.status_reason === '涉嫌刷单 A' && listed.is_profile_complete === false, JSON.stringify(listed));
const auditOwn = await asUser(own, () => q(`select action, actor_type, details from audit_logs where store_id=$1`, [S]));
ok('H-1 店家在 audit_logs 读不到 actor_type=admin 的行（含原因与管理员 uid）', !auditOwn.some(a => a.actor_type === 'admin') && !JSON.stringify(auditOwn).includes('涉嫌刷单') && !JSON.stringify(auditOwn).includes(adm.id), JSON.stringify(auditOwn));
ok('H-1 管理员 aal2 在 audit_logs 看得到', (await asUser(adm.id, () => q(`select 1 from audit_logs where store_id=$1 and action='store.status'`, [S]), 'aal2')).length === 1);
ok('H-1 店家 get_my_context 不含原因', !JSON.stringify((await asUser(own, () => q(`select get_my_context() r`)))[0].r).includes('涉嫌刷单'));
await setSt('active', '');

// ================= 下单准备 =================
const F = await asUser(own, async () => {
  const [c] = await q(`insert into categories(store_id,name) values ($1,'饮料') returning id`, [S]);
  const [c2] = await q(`insert into categories(store_id,name) values ($1,'隐藏分类') returning id`, [S]);
  const [i] = await q(`insert into items(store_id,category_id,name,price_cents) values ($1,$2,'奶茶',530) returning id`, [S, c.id]);
  const [i2] = await q(`insert into items(store_id,category_id,name,price_cents) values ($1,$2,'隐藏菜',800) returning id`, [S, c2.id]);
  const t = [];
  for (let k = 0; k < 3; k++) t.push((await q(`insert into dining_tables(store_id,label) values ($1,$2) returning id`, [S, 'A' + k]))[0].id);
  return { cat: c.id, cat2: c2.id, item: i.id, item2: i2.id, t };
});
let n = 1;
const rid = () => `${String(n++).padStart(8, '0')}-0000-4000-8000-000000000000`;
const cart = (item = F.item, price = 530, qty = 1) => JSON.stringify([{ item_id: item, quantity: qty, unit_price_cents: price }]);
const place = async ({ table, dev, ip = 'ip-1', r = rid(), items = cart() }) => (await cust(
  `select customer_place_order($1,$2,1,$3,$4,$5::jsonb,$6,$7,null,$8,false) r`,
  [S, table, r, H('req' + r), items, H(dev), H(ip), H('tok' + r)]))[0].r;
const quote = async (items, table = F.t[0]) => (await cust(`select customer_quote($1,$2,1,$3::jsonb) r`, [S, table, items]))[0].r;

// ================= (a) 拉黑名单 / 解除拉黑 =================
const bad = await place({ table: F.t[0], dev: 'bad-dev', ip: 'bad-ip' });
const blk = (await asUser(own, () => q(`select block_client_from_order($1, true, true, 7) r`, [bad.order.id])))[0].r;
ok('(a) 拉黑设备 + IP', blk.blocked === 2 && blk.cancelled === true);
const blockAudit = await asUser(own, () => q(`select details from audit_logs where action='client.blocked' and entity_id=$1`, [bad.order.id]));
ok('(a) 拉黑写审计 client.blocked，details 不含哈希', blockAudit.length === 1 && !JSON.stringify(blockAudit).includes(H('bad-dev')) && !JSON.stringify(blockAudit).includes(H('bad-ip')), JSON.stringify(blockAudit));
const list = (await asUser(own, () => q(`select list_blocked_clients() r`)))[0].r;
ok('(a) list_blocked_clients 返回 2 条，带来源订单桌号', list.length === 2 && list.every(b => b.source_order?.table_label === 'A0' && b.is_active), JSON.stringify(list[0]));
ok('(a) list_blocked_clients 不含 value_hash', !JSON.stringify(list).includes('value_hash') && !JSON.stringify(list).includes(H('bad-dev')));
await asUser(own, () => expectErr('H-1 店家直接 select value_hash → permission denied', 'permission denied', () => q(`select value_hash from blocked_clients`)));
ok('Q3 店家仍可读 blocked_clients 的其他列', (await asUser(own, () => q(`select id, kind, expires_at from blocked_clients`))).length === 2);
await asUser(own, () => expectErr('(a) 店家直接 delete blocked_clients → permission denied（必须走 unblock_client 留审计）', 'permission denied', () => q(`delete from blocked_clients`)));
await expectErr('(a) 被拉黑设备下单 → DEVICE_BLOCKED', 'DEVICE_BLOCKED', () => place({ table: F.t[1], dev: 'bad-dev', ip: 'ip-x' }));
const other = await newOwner('other@x.com');
ok('(a) 别家店看不到本店拉黑名单', (await asUser(other, () => q(`select list_blocked_clients() r`)))[0].r.length === 0);
await asUser(other, () => expectErr('(a) 别家店解除本店拉黑 → NOT_FOUND', 'NOT_FOUND', () => q(`select unblock_client($1)`, [list[0].id])));
await setSt('suspended', '临时停用');
ok('(a) 店铺停用时仍可查看拉黑名单', (await asUser(own, () => q(`select list_blocked_clients() r`)))[0].r.length === 2);
await asUser(own, () => expectErr('(a) 店铺停用时解除拉黑 → STORE_SUSPENDED', 'STORE_SUSPENDED', () => q(`select unblock_client($1)`, [list[0].id])));
await setSt('active', null);
const devBlock = list.find(b => b.kind === 'device');
const ub = (await asUser(own, () => q(`select unblock_client($1) r`, [devBlock.id])))[0].r;
ok('(a) unblock_client 成功', ub.unblocked === true && (await q(`select 1 from blocked_clients where id=$1`, [devBlock.id])).length === 0);
ok('(a) 解除拉黑写审计 client.unblocked', (await asUser(own, () => q(`select 1 from audit_logs where action='client.unblocked' and entity_id=$1`, [devBlock.id]))).length === 1);
await asUser(own, () => expectErr('(a) 重复解除 → NOT_FOUND', 'NOT_FOUND', () => q(`select unblock_client($1)`, [devBlock.id])));
await asUser(own, () => expectErr('(a) 参数为空 → VALIDATION_FAILED', 'VALIDATION_FAILED', () => q(`select unblock_client(null)`)));
ok('(a) 解除设备拉黑后该设备（换个 IP）可再下单', (await place({ table: F.t[1], dev: 'bad-dev', ip: 'ip-y' })).replayed === false);
await q(`update blocked_clients set expires_at = now() - interval '1 minute'`);
ok('(a) 默认只列有效的；p_include_expired=true 才列过期的',
  (await asUser(own, () => q(`select list_blocked_clients() r`)))[0].r.length === 0
  && (await asUser(own, () => q(`select list_blocked_clients(true) r`)))[0].r[0]?.is_active === false);

// ================= (b) 分类隐藏 = categories.is_hidden =================
await asUser(own, () => q(`update categories set is_hidden=true where id=$1`, [F.cat2]));
const menu = (await cust(`select customer_get_menu($1,$2,1) r`, [S, F.t[0]]))[0].r;
ok('(b) 隐藏分类及其菜品不出现在顾客菜单', !menu.categories.some(c => c.id === F.cat2) && !menu.items.some(i => i.id === F.item2));
const qh = await quote(cart(F.item2, 800));
ok('(b) 购物车里有隐藏分类的菜 → can_order=false、unavailable', qh.can_order === false && qh.unavailable[0]?.item_id === F.item2);
await asUser(own, () => q(`update categories set is_hidden=false where id=$1`, [F.cat2]));
ok('(b) 取消隐藏后菜品回到菜单', (await cust(`select customer_get_menu($1,$2,1) r`, [S, F.t[0]]))[0].r.items.some(i => i.id === F.item2));

// ================= Q1 C2 预估合计（只算这一单） =================
await asUser(own, () => q(`update stores set service_charge_bp=1000, sst_bp=600 where id=$1`, [S]));
const qt = await quote(cart(F.item, 530, 1));
ok('Q1 estimate_basis = this_order，带费率', qt.estimate_basis === 'this_order' && qt.service_charge_bp === 1000 && qt.sst_bp === 600);
ok('Q1 530 → 服务费 53、SST 35（(530+53)×6% 四舍五入）、合计 618', qt.estimated_service_charge_cents === 53 && qt.estimated_sst_cents === 35
  && qt.estimated_rounding_cents === 0 && qt.estimated_total_cents === 618, JSON.stringify(qt));
ok('Q1 合计 = 小计 + 服务费 + SST + 进位', qt.estimated_total_cents === qt.subtotal_cents + qt.estimated_service_charge_cents + qt.estimated_sst_cents + qt.estimated_rounding_cents);
const qt2 = await quote(cart(F.item, 530, 1), F.t[1]);   // A1 桌已有未结账单，预估仍只算这一单
ok('Q1 已有未结账单的桌：预估只算这一单（不含之前的单）', qt2.subtotal_cents === 530 && qt2.estimated_total_cents === 618);
await q(`update stores set max_order_cents=1000 where id=$1`, [S]);
const qo = await quote(cart(F.item, 530, 5));
ok('Q1 超过单笔上限 → 预估字段为 null、can_order=false', qo.limit_exceeded === true && qo.estimated_total_cents === null && qo.can_order === false);
await q(`update stores set max_order_cents=300000 where id=$1`, [S]);

// ================= (c) P10 未结金额 = open_bills 实时 =================
const st1 = (await asUser(own, () => q(`select get_store_daily_stats((now() at time zone 'Asia/Kuala_Lumpur')::date) r`)))[0].r;
const openSub = (await q(`select coalesce(sum(subtotal_cents),0)::int s from bills where store_id=$1 and status='open'`, [S]))[0].s;
const expTotal = (await q(`select sum(c.total_cents)::int t from bills b, private.calc_bill(b.subtotal_cents, 1000, 600, false) c where b.store_id=$1 and b.status='open'`, [S]))[0].t;
ok('(c) open_bills.total_cents 按当前费率实时计算', st1.open_bills.subtotal_cents === openSub && st1.open_bills.total_cents === expTotal, JSON.stringify(st1.open_bills));
await asUser(own, () => q(`update stores set service_charge_bp=0, sst_bp=0 where id=$1`, [S]));
const st2 = (await asUser(own, () => q(`select get_store_daily_stats((now() at time zone 'Asia/Kuala_Lumpur')::date) r`)))[0].r;
ok('(c) 店家改费率后 open_bills.total_cents 立即跟着变', st2.open_bills.total_cents === openSub);

// ================= Q2 资料完整标记 =================
const prof0 = (await asUser(own, () => q(`select is_profile_complete from stores where id=$1`, [S])))[0].is_profile_complete;
ok('Q2 新店 is_profile_complete=false', prof0 === false);
await asUser(own, () => q(`update stores set address='  ' , opening_hours='10:00–22:00' where id=$1`, [S]));
ok('Q2 地址只有空格 → 仍 false', (await q(`select is_profile_complete x from stores where id=$1`, [S]))[0].x === false);
await asUser(own, () => q(`update stores set address='吉隆坡 Jalan 1' where id=$1`, [S]));
ok('Q2 地址 + 营业时间都填 → true（Logo 可选）', (await q(`select is_profile_complete x from stores where id=$1`, [S]))[0].x === true);
ok('Q2 get_my_context 返回 is_profile_complete', (await asUser(own, () => q(`select get_my_context() r`)))[0].r.store.is_profile_complete === true);
await asUser(own, () => expectErr('Q2 店家不能直接写 is_profile_complete（生成列）', 'is_profile_complete', () => q(`update stores set is_profile_complete=false where id=$1`, [S])));

// ================= Q5 P5「已上菜」 =================
const o1 = await place({ table: F.t[2], dev: 'p5-a' });
const o2 = await place({ table: F.t[2], dev: 'p5-b' });
for (const o of [o1, o2]) await asUser(own, async () => {
  await q(`select update_order_status($1,'accepted','new')`, [o.order.id]);
  await q(`select update_order_status($1,'served','accepted')`, [o.order.id]);
});
const idx = (await q(`select indexdef from pg_indexes where indexname='orders_store_served_idx'`))[0]?.indexdef || '';
ok('Q5 索引 orders_store_served_idx (store_id, served_at desc) where status=served', /\(store_id, served_at DESC\)/.test(idx) && /status = 'served'/.test(idx), idx);
const P5 = `select o.id, o.seq_in_bill, o.device_seq_in_bill, o.subtotal_cents, o.served_at, t.label
  from orders o join dining_tables t on t.id = o.table_id
 where o.store_id = $1 and o.status = 'served'
   and o.served_at >= ($2::date::timestamp at time zone 'Asia/Kuala_Lumpur')
   and o.served_at <  (($2::date + 1)::timestamp at time zone 'Asia/Kuala_Lumpur')
 order by o.served_at desc limit 100`;
const today = (await q(`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d`))[0].d;
ok('Q5 店家按当天 UTC+8 查到 2 条已上菜（RLS 放行）', (await asUser(own, () => q(P5, [S, today]))).length === 2);
ok('Q5 别家店同样的查询 → 0 条', (await asUser(other, () => q(P5, [S, today]))).length === 0);
await q(`set enable_seqscan = off`);
const plan = (await q(`explain ` + P5.replace('$1', `'${S}'`).replace(/\$2/g, `'${today}'`))).map(r => r['QUERY PLAN']).join('\n');
await q(`reset enable_seqscan`);
ok('Q5 查询计划走 orders_store_served_idx', plan.includes('orders_store_served_idx'), plan.split('\n').slice(0, 3).join(' | '));

// ================= Q6 410 原因只剩 bill_paid / qr_rotated / expired =================
const tok = (await q(`select id from bill_access_tokens where revoked_at is null limit 1`))[0].id;
await expectErr('Q6 revoked_reason=merchant 已不允许', 'bill_access_tokens_revoked_reason_check', () => q(`update bill_access_tokens set revoked_at=now(), revoked_reason='merchant' where id=$1`, [tok]));
ok('Q6 bill_paid / qr_rotated 仍允许', (await q(`select pg_get_constraintdef(oid) d from pg_constraint where conname='bill_access_tokens_revoked_reason_check'`))[0].d.includes('qr_rotated'));

// ================= Q7 get_my_context / ensure_my_store =================
await asRole('authenticated', { role: 'authenticated' }, () => expectErr('Q7 没登录 → UNAUTHENTICATED', 'UNAUTHENTICATED', () => q(`select get_my_context()`)));
const c0 = (await asUser(own, () => q(`select get_my_context() r`)))[0].r;
ok('Q7 店主：有店、member_role=owner、password_set=false', c0.store?.id === S && c0.member_role === 'owner' && c0.password_set === false && c0.platform_role === 'merchant', JSON.stringify(c0));
const e0 = (await asUser(own, () => q(`select ensure_my_store() r`)))[0].r;
ok('Q7 已有店 → ensure_my_store 不新建（幂等）', e0.store_id === S && e0.created === false);
// 数据异常：成员关系丢失（人工修数据 / 将来的移除成员）
const lost = await newOwner('lost@x.com', '{"store_name":"丢店"}');
const oldStore = await storeOf(lost);
await q(`delete from store_members where user_id=$1`, [lost]);
ok('Q7 已登录但没有店铺：get_my_context.store = null', (await asUser(lost, () => q(`select get_my_context() r`)))[0].r.store === null);
const e1 = (await asUser(lost, () => q(`select ensure_my_store() r`)))[0].r;
ok('Q7 ensure_my_store 建新店并加为 owner', e1.created === true && e1.store_id !== oldStore && (await storeOf(lost)) === e1.store_id);
ok('L-5 补建的店不用 user_metadata 里的店名，一律「我的餐厅」', (await q(`select name from stores where id=$1`, [e1.store_id]))[0].name === '我的餐厅');
ok('Q7 再调一次不再新建', (await asUser(lost, () => q(`select ensure_my_store() r`)))[0].r.created === false);
ok('Q7 authenticated 对 stores 仍没有 insert 权限（只有 definer 函数能建店）', !(await q(`select has_table_privilege('authenticated','public.stores','insert') x`))[0].x);
ok('Q7 建店写审计 store.ensured', (await q(`select 1 from audit_logs where action='store.ensured' and store_id=$1`, [e1.store_id])).length === 1);
const ea = (await asUser(adm.id, () => q(`select ensure_my_store() r`), 'aal2'))[0].r;
ok('Q7 平台管理员 / no_store 账号 → 不建店，reason=no_store_account', ea.store_id === null && ea.reason === 'no_store_account' && !(await storeOf(adm.id)));
const [unv] = await q(`insert into auth.users(email) values ('unv@x.com') returning id`);
await asUser(unv.id, () => expectErr('Q7 未验证账号 → FORBIDDEN(not_verified)', 'FORBIDDEN', () => q(`select ensure_my_store()`), 'not_verified'));
ok('Q7 未验证账号没有被建店', !(await storeOf(unv.id)));

// ================= 权限回归 =================
for (const fn of ['list_blocked_clients(boolean)', 'unblock_client(uuid)', 'get_my_context()', 'ensure_my_store()']) {
  ok(`授权 authenticated 可执行 ${fn}`, (await q(`select has_function_privilege('authenticated','public.${fn}','execute') x`))[0].x);
  ok(`授权 anon / customer_api 不能执行 ${fn}`, !(await q(`select has_function_privilege('anon','public.${fn}','execute') a, has_function_privilege('customer_api','public.${fn}','execute') b`)).some(r => r.a || r.b));
}
const authFns = (await q(`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
  and has_function_privilege('authenticated', p.oid, 'execute') order by 1`)).map(r => r.proname);
const expectAuth = ['admin_list_stores', 'admin_set_store_status', 'block_client_from_order', 'calc_bill', 'can_write_store', 'delete_category',
  'div_round', 'ensure_my_store', 'get_my_context', 'get_store_daily_stats', 'is_platform_admin', 'is_store_member', 'list_blocked_clients',
  'mark_bill_paid', 'reorder_categories', 'reorder_items', 'rotate_table_qr', 'soft_delete_item', 'soft_delete_table', 'try_uuid',
  'unblock_client', 'update_order_status'];
ok('回归 authenticated 白名单 = PR1 的 18 个 + 本次 4 个（PR1 rls_rpc 的 H2 断言只针对 0001+0002）', JSON.stringify(authFns) === JSON.stringify(expectAuth), JSON.stringify(authFns));
const custFns = (await q(`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
  and has_function_privilege('customer_api', p.oid, 'execute') order by 1`)).map(r => r.proname);
ok('回归 customer_api 仍只能执行 4 个 customer_*', JSON.stringify(custFns) === JSON.stringify(['customer_get_bill', 'customer_get_menu', 'customer_place_order', 'customer_quote']), JSON.stringify(custFns));

// ================= 前端 v0.6 =================
// 第 5 问：get_my_context 返回 password_set_at
const ctxA = (await asUser(own, () => q(`select get_my_context() r`)))[0].r;
ok('v0.6 第 5 问 get_my_context 含 password_set_at（未设密码为 null）', 'password_set_at' in ctxA && ctxA.password_set_at === null && ctxA.password_set === false, JSON.stringify(ctxA));
await q(`set role supabase_auth_admin`);
await q(`update auth.users set encrypted_password = '$2a$10$own' where id=$1`, [own]);
await q(`reset role`);
const ctxB = (await asUser(own, () => q(`select get_my_context() r`)))[0].r;
ok('v0.6 第 5 问 设密码后 password_set_at 有值', ctxB.password_set === true && typeof ctxB.password_set_at === 'string', JSON.stringify(ctxB.password_set_at));
// L-5：注册时写在 user_metadata 的店名不采用
ok('L-5 注册带 store_name 也建「我的餐厅」', (await q(`select s.name from stores s join store_members m on m.store_id = s.id where m.user_id=$1`, [own]))[0].name === '我的餐厅');
// 第 16 问：MFA_REQUIRED 与 FORBIDDEN
await expectErr('v0.6 第 16 问 管理员 aal1 调 admin_list_stores → MFA_REQUIRED', 'MFA_REQUIRED', () => asUser(adm.id, () => q(`select admin_list_stores()`), 'aal1'), 'aal1');
await expectErr('v0.6 第 16 问 管理员 aal1 调 admin_set_store_status → MFA_REQUIRED（且不改数据）', 'MFA_REQUIRED', () => asUser(adm.id, () => q(`select admin_set_store_status($1,'suspended','x')`, [S]), 'aal1'));
ok('v0.6 第 16 问 aal1 调用后店铺状态未变', (await q(`select status from stores where id=$1`, [S]))[0].status === 'active');
await expectErr('v0.6 第 16 问 店家（aal1）调 admin_list_stores → FORBIDDEN', 'FORBIDDEN', () => asUser(own, () => q(`select admin_list_stores()`)));
await expectErr('v0.6 第 16 问 店家即使 aal2 也是 FORBIDDEN（不是 MFA_REQUIRED）', 'FORBIDDEN', () => asUser(own, () => q(`select admin_set_store_status($1,'suspended','x')`, [S]), 'aal2'));
let mfaMsg = '';
try { await asUser(own, () => q(`select admin_list_stores()`), 'aal2'); } catch (e) { mfaMsg = e.message; }
ok('v0.6 第 16 问 店家拿到的错误码里没有 MFA_REQUIRED', mfaMsg === 'FORBIDDEN', mfaMsg);
ok('v0.6 第 16 问 管理员 aal2 正常', (await asUser(adm.id, () => q(`select admin_list_stores() r`), 'aal2'))[0].r.total >= 1);
await expectErr('v0.6 第 16 问 authenticated 不能直接执行 private.assert_platform_admin', 'permission denied', () => asUser(own, () => q(`select private.assert_platform_admin()`)));
// 第 1 问 = 第 11 问：店家能读的 stores 列清单与文档完全一致
const storeCols = (await q(`select attname from pg_attribute where attrelid = 'public.stores'::regclass and attnum > 0 and not attisdropped
  and has_column_privilege('authenticated', 'public.stores'::regclass, attname, 'select') order by attnum`)).map(r => r.attname);
const docCols = ['id','slug','name','logo_path','address','opening_hours','is_accepting_orders','status','status_changed_at','currency','locale','timezone',
  'service_charge_bp','sst_bp','cash_rounding','require_first_order_approval','max_order_cents','require_captcha','created_at','updated_at','is_profile_complete'];
ok('v0.6 第 11 问 店家可读列 = 文档 §21 的 21 列（按表内顺序）', JSON.stringify(storeCols) === JSON.stringify(docCols), JSON.stringify(storeCols));
const updCols = (await q(`select attname from pg_attribute where attrelid = 'public.stores'::regclass and attnum > 0 and not attisdropped
  and has_column_privilege('authenticated', 'public.stores'::regclass, attname, 'update') order by attnum`)).map(r => r.attname);
ok('v0.6 第 11 问 店家可改列 = name、logo_path、address、opening_hours、is_accepting_orders、service_charge_bp、sst_bp', JSON.stringify(updCols) === JSON.stringify(['name','logo_path','address','opening_hours','is_accepting_orders','service_charge_bp','sst_bp']), JSON.stringify(updCols));
const bcCols = (await q(`select attname from pg_attribute where attrelid = 'public.blocked_clients'::regclass and attnum > 0 and not attisdropped
  and has_column_privilege('authenticated', 'public.blocked_clients'::regclass, attname, 'select') order by attname`)).map(r => r.attname);
ok('v0.6 第 12 问 blocked_clients 可读列含 source_order_id、expires_at，不含 value_hash', ['id','kind','reason','source_order_id','created_at','expires_at'].every(c => bcCols.includes(c)) && !bcCols.includes('value_hash'), JSON.stringify(bcCols));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
