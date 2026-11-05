// 本地快速验证：npm i -D @electric-sql/pglite && node supabase/tests/rls_rpc.test.mjs
// PGlite + supabase_stub.sql 模拟 auth / storage / realtime / 角色 / 平台默认权限。正式 CI 用 supabase start + pgTAP（见 implementation-plan.md）。
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
const db = new PGlite();
const M = new URL('../migrations/', import.meta.url).pathname;
const stub = fs.readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf8').replace('grant anon, authenticated, service_role to postgres;', '');
await db.exec(stub);
await db.exec(fs.readFileSync(M + '0001_init.sql', 'utf8'));
await db.exec(fs.readFileSync(M + '0002_rpc.sql', 'utf8'));
console.log('MIGRATIONS OK');

let pass = 0, fail = 0;
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const report = (good, label, extra = '') => { good ? pass++ : fail++; console.log(good ? 'PASS' : 'FAIL', label, extra); };
const ok = (label, cond, extra = '') => report(!!cond, label, extra);
const expectErr = async (label, code, fn, detailHas) => {
  try { await fn(); report(false, label, '(no error)'); }
  catch (e) { const good = (e.message === code || e.message.includes(code)) && (!detailHas || String(e.detail || '').includes(detailHas)); report(good, label, '-> ' + e.message + ' ' + (e.detail || '')); }
};
const asClaims = async (role, claims, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false); select set_config('realtime.topic', '', false);`); }
};
const asUser = (uid, fn) => asClaims('authenticated', { sub: uid, role: 'authenticated' }, fn);
const asCustomer = fn => asClaims('customer_api', { role: 'customer_api' }, fn);
const asAnon = fn => asClaims('anon', { role: 'anon' }, fn);
const H = s => createHash('sha256').update(String(s)).digest('hex');

// ---------- 注册建店 ----------
const memberCount = async uid => (await q(`select count(*)::int n from store_members where user_id=$1`, [uid]))[0].n;
const [ua] = await q(`insert into auth.users(email, raw_user_meta_data, email_confirmed_at) values ('a@x.com','{"store_name":"A 店"}', now()) returning id`);
const [ub] = await q(`insert into auth.users(email) values ('b@x.com') returning id`);
ok('M5 邮箱未验证不建店（无 profile、无成员）', (await memberCount(ub.id)) === 0 && (await q(`select 1 from profiles where user_id=$1`, [ub.id])).length === 0);
await q(`update auth.users set raw_user_meta_data='{"x":1}' where id=$1`, [ub.id]);
ok('M5 改其他字段不触发建店', (await memberCount(ub.id)) === 0);
await q(`update auth.users set email_confirmed_at=now() where id=$1`, [ub.id]);
const [uanon] = await q(`insert into auth.users(is_anonymous, email_confirmed_at) values (true, now()) returning id`);
const [sa] = await q(`select store_id from store_members where user_id=$1`, [ua.id]);
const [sb] = await q(`select store_id from store_members where user_id=$1`, [ub.id]);
ok('注册即验证（autoconfirm 插入）建店，店名取 store_name', sa && (await q(`select name from stores where id=$1`, [sa.store_id]))[0].name === 'A 店');
ok('M5 邮箱验证后建店（默认店名）', sb && (await q(`select name from stores where id=$1`, [sb.store_id]))[0].name === '我的餐厅');
ok('M5 邮箱渠道记为 email', (await q(`select signup_channel from profiles where user_id=$1`, [ub.id]))[0].signup_channel === 'email');
ok('匿名用户不建店', (await memberCount(uanon.id)) === 0);
const [up] = await q(`insert into auth.users(phone, raw_user_meta_data) values ('60123456789','{"store_name":"手机店"}') returning id`);
ok('M5 手机号未验证不建店', (await memberCount(up.id)) === 0);
await q(`update auth.users set phone_confirmed_at=now() where id=$1`, [up.id]);
ok('M5 手机号 OTP 验证后建店，渠道记为 phone', (await memberCount(up.id)) === 1
  && (await q(`select signup_channel from profiles where user_id=$1`, [up.id]))[0].signup_channel === 'phone');
await q(`update auth.users set email='p@x.com', email_confirmed_at=now() where id=$1`, [up.id]);
await q(`update auth.users set phone_confirmed_at=null where id=$1`, [up.id]);
await q(`update auth.users set phone_confirmed_at=now() where id=$1`, [up.id]);
ok('M5 重复验证幂等，不重复建店', (await memberCount(up.id)) === 1 && (await q(`select count(*)::int n from profiles where user_id=$1`, [up.id]))[0].n === 1);
const SA = sa.store_id, SB = sb.store_id;

const A = await asUser(ua.id, async () => {
  const [c] = await q(`insert into categories(store_id,name) values ($1,'主食') returning id`, [SA]);
  const [i1] = await q(`insert into items(store_id,category_id,name,price_cents) values ($1,$2,'炒饭',1250) returning id`, [SA, c.id]);
  const [i2] = await q(`insert into items(store_id,category_id,name,price_cents) values ($1,$2,'奶茶',530) returning id`, [SA, c.id]);
  const [i3] = await q(`insert into items(store_id,category_id,name,price_cents) values ($1,$2,'龙虾',999999) returning id`, [SA, c.id]);
  const t = {};
  for (const l of ['A3', 'X', 'Y', 'Z', 'W1', 'W2']) t[l] = (await q(`insert into dining_tables(store_id,label) values ($1,$2) returning id`, [SA, l]))[0].id;
  return { c: c.id, i1: i1.id, i2: i2.id, i3: i3.id, t };
});
const T = A.t.A3;
await asUser(ub.id, () => q(`insert into categories(store_id,name) values ($1,'B类')`, [SB]));

// ---------- H2 函数权限 ----------
const fnList = (role) => q(`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
  and has_function_privilege('${role}', p.oid, 'execute') order by 1`);
ok('H2 anon 不能执行 public/private 任何函数', (await fnList('anon')).length === 0, JSON.stringify(await fnList('anon')));
const authFns = (await fnList('authenticated')).map(r => r.proname);
const expectedAuth = ['admin_list_stores','admin_set_store_status','block_client_from_order','calc_bill','can_write_store','delete_category','div_round',
  'get_store_daily_stats','is_platform_admin','is_store_member','mark_bill_paid','reorder_categories','reorder_items','rotate_table_qr',
  'soft_delete_item','soft_delete_table','try_uuid','update_order_status'];
ok('H2 authenticated 只能执行白名单函数', JSON.stringify(authFns) === JSON.stringify(expectedAuth), JSON.stringify(authFns));
const custFns = (await fnList('customer_api')).map(r => r.proname);
ok('M7 customer_api 只能执行 4 个 customer_*', JSON.stringify(custFns) === JSON.stringify(['customer_get_bill','customer_get_menu','customer_place_order','customer_quote']), JSON.stringify(custFns));
ok('M7 service_role 不再能执行 customer_place_order', !(await q(`select has_function_privilege('service_role','public.customer_place_order(uuid,uuid,integer,uuid,text,jsonb,text,text,text,text,boolean)','execute') x`))[0].x);
ok('M7 customer_api 没有任何表权限', (await q(`select 1 from information_schema.role_table_grants where grantee='customer_api'`)).length === 0);
await asAnon(() => expectErr('H2 anon 调店家 RPC → permission denied', 'permission denied for function update_order_status', () => q(`select update_order_status(gen_random_uuid(),'accepted','new')`)));
await asAnon(() => expectErr('H2 anon 调 admin RPC → permission denied', 'permission denied for function admin_list_stores', () => q(`select admin_list_stores()`)));
await asUser(ua.id, () => expectErr('H2 authenticated 调 private.purge_expired → permission denied', 'permission denied for function purge_expired', () => q(`select private.purge_expired()`)));
await asUser(ua.id, () => expectErr('H2 authenticated 调 private.resolve_table → permission denied', 'permission denied for function resolve_table', () => q(`select private.resolve_table($1,$2,1,'menu')`, [SA, T])));

// ---------- M1 表默认权限 / L3 search_path ----------
ok('M1 public 所有表都开了 RLS', (await q(`select relname from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p') and not relrowsecurity`)).length === 0);
ok('M1 anon 在 public 没有任何表/视图授权', (await q(`select 1 from information_schema.role_table_grants where grantee='anon' and table_schema='public'`)).length === 0);
const bo = (await q(`select privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_name='bill_overview'`)).map(r => r.privilege_type);
ok('M1 bill_overview 对 authenticated 只有 SELECT', JSON.stringify(bo) === '["SELECT"]', JSON.stringify(bo));
await q(`create table public.zz_future_table(id int)`);
ok('M1 以后新建的表默认对 anon/authenticated 零权限', (await q(`select 1 from information_schema.role_table_grants where table_name='zz_future_table' and grantee in ('anon','authenticated')`)).length === 0);
await q(`drop table public.zz_future_table`);
ok('L3 public/private 所有函数都设置了 search_path', (await q(`select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)
  and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false)`)).length === 0);

// ---------- 跨店隔离 ----------
await asUser(ub.id, async () => {
  ok('B 读不到 A 的菜品', (await q(`select * from items where store_id=$1`, [SA])).length === 0);
  ok('B 读不到 A 的店铺', (await q(`select * from stores where id=$1`, [SA])).length === 0);
  ok('B 改不了 A 的菜品', (await q(`update items set price_cents=1 where id=$1 returning id`, [A.i1])).length === 0);
  await expectErr('B 不能往 A 店插数据', 'new row violates row-level security policy for table "categories"', () => q(`insert into categories(store_id,name) values ($1,'x')`, [SA]));
  await expectErr('authenticated 不能调 customer_place_order', 'permission denied for function customer_place_order', () => q(`select customer_place_order(null,null,1,null,null,null,null,null,null,null)`));
});
await asAnon(() => expectErr('anon 不能读 items', 'permission denied for table items', () => q(`select * from items`)));

// ---------- 顾客下单 ----------
const cust = (sql, p) => asCustomer(() => q(sql, p));
const place = async (o) => {
  const x = { table: T, ver: 1, req: 'r', dev: 'D1', ip: 'I1', tok: null, captcha: false, ...o };
  const newTok = x.newTok || H('tok:' + x.rid);
  return (await cust(`select customer_place_order($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) r`,
    [SA, x.table, x.ver, x.rid, x.reqHash || H(x.req), x.items == null ? null : JSON.stringify(x.items), x.devHash === undefined ? H(x.dev) : x.devHash, H(x.ip), x.tok, newTok, x.captcha]))[0].r;
};
const getBill = async (tok, dev = 'D1', table = T, ver = 1) => (await cust(`select customer_get_bill($1,$2,$3,$4,$5) r`, [SA, table, ver, tok, H(dev)]))[0].r;
const L = (item, qty, price, note) => ({ item_id: item, quantity: qty, unit_price_cents: price, ...(note ? { note } : {}) });
const rid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// M2 NULL 安全
await expectErr('M2 qr_version 传 NULL → TABLE_INVALID', 'TABLE_INVALID', () => cust(`select customer_get_menu($1,$2,null)`, [SA, T]));
await expectErr('M2 store_id 传 NULL → TABLE_INVALID', 'TABLE_INVALID', () => cust(`select customer_get_menu(null,$1,1)`, [T]));
await expectErr('M2/M3 设备哈希为 NULL → VALIDATION_FAILED', 'VALIDATION_FAILED', () => place({ rid: rid(90), items: [L(A.i1, 1, 1250)], devHash: null }));
await expectErr('M2 items 为 NULL → VALIDATION_FAILED', 'VALIDATION_FAILED', () => place({ rid: rid(91), items: null }));

const T1 = H('tok:' + rid(1));
const o1 = await place({ rid: rid(1), items: [L(A.i1, 2, 1250, '少辣')] });
ok('首单开账单并签发令牌', o1.order.seq_in_bill === 1 && o1.order.subtotal_cents === 2500 && o1.bill_token_issued && o1.bill.status === 'open');
ok('下单响应不含任何指纹字段', !JSON.stringify(o1).includes('hash'));
const rep = await place({ rid: rid(1), items: [L(A.i1, 2, 1250, '少辣')], tok: T1 });
ok('重复 request_id 返回原单（replayed=true）', rep.replayed === true && rep.order.id === o1.order.id && rep.bill_token_issued === false);
const T1b = H('tok-reissue');
const rep2 = await place({ rid: rid(1), items: [L(A.i1, 2, 1250, '少辣')], tok: null, newTok: T1b });
ok('重放时本设备没收到令牌 → 重新下发', rep2.replayed === true && rep2.bill_token_issued === true);
await expectErr('旧令牌哈希被替换后失效', 'BILL_TOKEN_INVALID', () => getBill(T1));
await expectErr('同 request_id 不同内容 → IDEMPOTENCY_KEY_REUSED（不带 order_id）', 'IDEMPOTENCY_KEY_REUSED', async () => {
  try { await place({ rid: rid(1), items: [L(A.i1, 3, 1250)], req: 'other' }); } catch (e) { if (String(e.detail).includes('order_id')) throw new Error('LEAKS order_id'); throw e; } });
await expectErr('价格变了 → PRICE_CHANGED', 'PRICE_CHANGED', () => place({ rid: rid(2), items: [L(A.i1, 1, 1000)] }));
await q(`update items set is_sold_out=true where id=$1`, [A.i2]);
await expectErr('售完 → ITEM_UNAVAILABLE', 'ITEM_UNAVAILABLE', () => place({ rid: rid(2), items: [L(A.i2, 1, 530)] }));
await q(`update items set is_sold_out=false where id=$1`, [A.i2]);
const T2 = H('tok:' + rid(2));
const o2 = await place({ rid: rid(2), items: [L(A.i1, 1, 1250), L(A.i2, 2, 530)], dev: 'D2', ip: 'I2' });
ok('第二台设备进同一账单并拿到自己的令牌', o2.bill.id === o1.bill.id && o2.order.seq_in_bill === 2 && o2.bill_token_issued);
const o3 = await place({ rid: rid(3), items: [L(A.i2, 2, 530)], tok: T1b });
ok('本设备再下单沿用令牌', o3.bill_token_issued === false && o3.order.seq_in_bill === 3);
const v2 = await getBill(T2, 'D2');
ok('H1 新设备只看到自己的订单', v2.scope === 'own_orders' && v2.orders.length === 1 && v2.orders[0].id === o2.order.id && v2.bill.subtotal_cents === 2310, JSON.stringify(v2.bill));
const v1 = await getBill(T1b, 'D1');
ok('H1 D1 只看到 D1 的两单', v1.orders.length === 2 && v1.orders.every(o => [o1.order.id, o3.order.id].includes(o.id)) && v1.bill.subtotal_cents === 3560);
await expectErr('M4 令牌换设备使用 → BILL_TOKEN_INVALID', 'BILL_TOKEN_INVALID', () => getBill(T1b, 'D2'));
await expectErr('令牌换桌使用 → BILL_TOKEN_INVALID', 'BILL_TOKEN_INVALID', () => getBill(T1b, 'D1', A.t.X));
const vt = await getBill(null, 'D9');
ok('L7 不带令牌只返回 table_in_use 布尔值', vt.view === 'table' && vt.table_in_use === true && !('open_bill_order_count' in vt) && vt.orders.length === 0);
ok('L7 菜单接口也只返回布尔值', (await cust(`select customer_get_menu($1,$2,1) r`, [SA, T]))[0].r.table_in_use === true);
const quote = (await cust(`select customer_quote($1,$2,1,$3::jsonb) r`, [SA, T, JSON.stringify([L(A.i1, 1, 999)])]))[0].r;
ok('quote 报告价格变化', quote.price_changes.length === 1 && quote.subtotal_cents === 1250);
const big = (await cust(`select customer_quote($1,$2,1,$3::jsonb) r`, [SA, T, JSON.stringify(Array.from({ length: 30 }, () => L(A.i3, 99, 999999)))]))[0].r;
ok('L4 超大购物车 quote 不溢出，返回 can_order=false', big.can_order === false && big.limit_exceeded === true && big.estimated_sst_cents === null);

// ---------- 状态机 ----------
await asUser(ua.id, async () => {
  await q(`select update_order_status($1,'accepted','new')`, [o1.order.id]);
  await expectErr('过期的 expected 状态 → ORDER_STATUS_CONFLICT', 'ORDER_STATUS_CONFLICT', () => q(`select update_order_status($1,'accepted','new')`, [o1.order.id]));
  await expectErr('M2 expected 传 NULL → VALIDATION_FAILED', 'VALIDATION_FAILED', () => q(`select update_order_status($1,'served',null)`, [o1.order.id]));
  await q(`select update_order_status($1,'served','accepted')`, [o1.order.id]);
  await expectErr('served → accepted 被拒', 'INVALID_STATUS_TRANSITION', () => q(`select update_order_status($1,'accepted','served')`, [o1.order.id]));
  await expectErr('served → cancelled 被拒', 'INVALID_STATUS_TRANSITION', () => q(`select update_order_status($1,'cancelled','served','other')`, [o1.order.id]));
  await q(`select update_order_status($1,'cancelled','new','sold_out')`, [o2.order.id]);
  const [b] = await q(`select * from bill_overview where id=$1`, [o1.bill.id]);
  ok('取消的订单不计入账单', b.subtotal_cents === 3560, b.subtotal_cents);
  await expectErr('L6 店家读不到 order_client_meta', 'permission denied for table order_client_meta', () => q(`select * from order_client_meta`));
});
ok('L6 orders 表不再有指纹列', (await q(`select 1 from information_schema.columns where table_name='orders' and column_name like '%hash%'`)).length === 0);
await asUser(ub.id, () => expectErr('B 改不了 A 的订单 → NOT_FOUND', 'NOT_FOUND', () => q(`select update_order_status($1,'accepted','new')`, [o3.order.id])));

// ---------- 金额（店家自设费率，第一版不做 5 仙进位） ----------
await asUser(ua.id, () => q(`update stores set service_charge_bp=1000, sst_bp=600 where id=$1`, [SA]));
ok('店家可自设服务费与 SST', (await q(`select service_charge_bp, sst_bp from stores where id=$1`, [SA]))[0].sst_bp === 600);
ok('H1 首单审核字段默认关闭', (await q(`select require_first_order_approval v from stores where id=$1`, [SA]))[0].v === false);
await asUser(ua.id, () => expectErr('H1 v1 店家不能开启首单审核（无列级授权）', 'permission denied', () => q(`update stores set require_first_order_approval=true where id=$1`, [SA])));
await expectErr('H1 v1 即使超级用户也不能置 true（CHECK）', 'stores_first_order_approval_v1_ck', () => q(`update stores set require_first_order_approval=true where id=$1`, [SA]));
await expectErr('第一版不做 5 仙进位（cash_rounding 只能为 false）', 'check constraint', () => q(`update stores set cash_rounding=true where id=$1`, [SA]));
await place({ rid: rid(4), items: [L(A.i2, 1, 530), L(A.i2, 1, 530, '少冰')], tok: T1b }); // +1060 → 4620
const [bill] = await asUser(ua.id, () => q(`select subtotal_cents,service_charge_cents,sst_cents,rounding_cents,total_cents from bill_overview where id=$1`, [o1.bill.id]));
ok('账单 4620：服务费 462、SST 305、取整 0、合计 5387', bill.subtotal_cents === 4620 && bill.service_charge_cents === 462 && bill.sst_cents === 305 && bill.rounding_cents === 0 && bill.total_cents === 5387, JSON.stringify(bill));
const c1 = (await q(`select * from private.calc_bill(4560,1000,600,false)`))[0];
ok('算例 4560 / 10% / 6% → 456 / 301 / 0 / 5317', c1.service_charge_cents === 456 && c1.sst_cents === 301 && c1.rounding_cents === 0 && c1.total_cents === 5317, JSON.stringify(c1));
ok('D1 看到自己订单的估算金额', (await getBill(T1b, 'D1')).bill.total_cents === 5387);

// ---------- 结账（自动清台、撤销令牌） ----------
await asUser(ua.id, async () => {
  await expectErr('结账金额不符 → BILL_TOTAL_CHANGED', 'BILL_TOTAL_CHANGED', () => q(`select mark_bill_paid($1,1)`, [o1.bill.id]));
  await expectErr('M2 结账金额传 NULL → VALIDATION_FAILED', 'VALIDATION_FAILED', () => q(`select mark_bill_paid($1,null)`, [o1.bill.id]));
  const [p] = await q(`select mark_bill_paid($1,$2) r`, [o1.bill.id, 5387]);
  ok('结账成功并撤销 2 个令牌', p.r.status === 'paid' && p.r.total_cents === 5387 && p.r.tokens_revoked === 2, JSON.stringify(p.r));
  await expectErr('重复结账 → BILL_ALREADY_PAID', 'BILL_ALREADY_PAID', () => q(`select mark_bill_paid($1,5387)`, [o1.bill.id]));
  await expectErr('已付款账单内取消订单 → ORDER_BILL_CLOSED', 'ORDER_BILL_CLOSED', () => q(`select update_order_status($1,'cancelled','new','other')`, [o3.order.id]));
  await q(`select update_order_status($1,'accepted','new')`, [o3.order.id]);
  const today = (await q(`select (now() at time zone 'Asia/Kuala_Lumpur')::date d`))[0].d;
  const [s] = await q(`select get_store_daily_stats($1::date) r`, [today]);
  ok('当日营业额 = 已付款账单合计', s.r.revenue_cents === 5387 && s.r.paid_bills.sst_cents === 305, JSON.stringify(s.r.paid_bills));
});
await expectErr('结账后顾客令牌被撤销（410，reason=bill_paid）', 'BILL_TOKEN_EXPIRED', () => getBill(T1b, 'D1'), 'bill_paid');
await expectErr('结账后另一台设备的令牌也被撤销', 'BILL_TOKEN_EXPIRED', () => getBill(T2, 'D2'), 'bill_paid');
ok('结账后桌子空闲（table_in_use=false）', (await getBill(null)).table_in_use === false);
const T5 = H('tok:' + rid(5));
const o5 = await place({ rid: rid(5), items: [L(A.i1, 1, 1250)], tok: T1b });
ok('下一单开新账单并签发新令牌', o5.bill.id !== o1.bill.id && o5.order.seq_in_bill === 1 && o5.bill_token_issued === true);

// ---------- H1 重置桌码 ----------
await asUser(ub.id, () => expectErr('B 不能重置 A 的桌码 → NOT_FOUND', 'NOT_FOUND', () => q(`select rotate_table_qr($1)`, [T])));
const rot = (await asUser(ua.id, () => q(`select rotate_table_qr($1) r`, [T])))[0].r;
ok('重置桌码：版本 +1 并撤销 open 账单令牌', rot.qr_version === 2 && rot.tokens_revoked === 1, JSON.stringify(rot));
await expectErr('重置后旧二维码失效（菜单）', 'TABLE_INVALID', () => cust(`select customer_get_menu($1,$2,1)`, [SA, T]));
await expectErr('重置后旧二维码不能下单', 'TABLE_INVALID', () => place({ rid: rid(6), items: [L(A.i1, 1, 1250)] }));
ok('新二维码可以看菜单', (await cust(`select customer_get_menu($1,$2,2) r`, [SA, T]))[0].r.table.id === T);
await expectErr('重置后旧令牌失效（reason=qr_rotated）', 'BILL_TOKEN_EXPIRED', () => getBill(T5, 'D1', T, 2), 'qr_rotated');
ok('审计日志记录了重置', (await q(`select 1 from audit_logs where action='table.qr_rotated' and entity_id=$1`, [T])).length === 1);

// ---------- L2 复合外键 ----------
await expectErr('L2 订单的桌子必须与账单同桌', 'orders_bill_table_fk', () => q(`insert into orders(store_id,table_id,bill_id,seq_in_bill,subtotal_cents,item_count,request_id) values ($1,$2,$3,99,0,1,gen_random_uuid())`, [SA, A.t.X, o5.bill.id]));
await expectErr('L2 拉黑来源订单必须是本店订单', 'blocked_clients_source_order_fk', () => q(`insert into blocked_clients(store_id,kind,value_hash,source_order_id) values ($1,'device',$2,$3)`, [SB, H('x'), o5.order.id]));

// ---------- L5 图片路径 / Storage ----------
await asUser(ua.id, async () => {
  await expectErr('L5 菜品图片不能指向别店路径', 'items_image_path_ck', () => q(`update items set image_path=$2 where id=$1`, [A.i1, `${SB}/items/${randomUUID()}.webp`]));
  await expectErr('L5 菜品图片不能是外部 URL', 'items_image_path_ck', () => q(`update items set image_path='https://evil.example/x.png' where id=$1`, [A.i1]));
  const good = `${SA}/items/${randomUUID()}.webp`;
  ok('L5 本店合法路径可写', (await q(`update items set image_path=$2 where id=$1 returning id`, [A.i1, good])).length === 1);
  ok('L5 Storage 合法路径可上传', (await q(`insert into storage.objects(bucket_id,name) values ('menu-images',$1) returning id`, [`${SA}/items/${randomUUID()}_thumb.webp`])).length === 1);
  await expectErr('L5 Storage 多级目录被拒', 'row-level security', () => q(`insert into storage.objects(bucket_id,name) values ('menu-images',$1)`, [`${SA}/items/sub/${randomUUID()}.webp`]));
  await expectErr('L5 Storage 非法文件名被拒', 'row-level security', () => q(`insert into storage.objects(bucket_id,name) values ('menu-images',$1)`, [`${SA}/items/evil.html`]));
  await expectErr('Storage 不能写别店目录', 'row-level security', () => q(`insert into storage.objects(bucket_id,name) values ('menu-images',$1)`, [`${SB}/items/${randomUUID()}.webp`]));
});

// ---------- M8 Realtime 私有频道 ----------
await q(`insert into realtime.messages(topic, payload) values ($1, '{}')`, ['store:' + SA]);
const rtCount = (uid) => asUser(uid, async () => { await q(`select set_config('realtime.topic',$1,false)`, ['store:' + SA]); return (await q(`select count(*)::int n from realtime.messages where topic=$1`, ['store:' + SA]))[0].n; });
ok('M8 本店成员能加入 store:{id} 私有频道', (await rtCount(ua.id)) === 1);
ok('M8 别店账号加入不了 store:{id}', (await rtCount(ub.id)) === 0);
await asUser(ua.id, async () => { await q(`select set_config('realtime.topic',$1,false)`, ['store:' + SA]);
  await expectErr('M8 客户端不能往频道发 Broadcast', 'row-level security', () => q(`insert into realtime.messages(topic,payload) values ($1,'{}')`, ['store:' + SA])); });

// ---------- M3 数据库兜底限流 / 拉黑 / 验证码 ----------
let n = 100;
for (let i = 0; i < 10; i++) await place({ rid: rid(n++), table: A.t.X, items: [L(A.i2, 1, 530)], dev: 'dX' + i, ip: 'I9' });
for (let i = 0; i < 10; i++) await place({ rid: rid(n++), table: A.t.Y, items: [L(A.i2, 1, 530)], dev: 'dY' + i, ip: 'I9' });
await expectErr('M3 同店同 IP 10 分钟第 21 单 → RATE_LIMITED(ip_db)', 'RATE_LIMITED', () => place({ rid: rid(n++), table: A.t.Z, items: [L(A.i2, 1, 530)], dev: 'dZ', ip: 'I9' }), 'ip_db');
await expectErr('同桌 10 分钟第 11 单 → RATE_LIMITED(table_db)', 'RATE_LIMITED', () => place({ rid: rid(n++), table: A.t.X, items: [L(A.i2, 1, 530)], dev: 'dX-new', ip: 'I8' }), 'table_db');
for (let i = 0; i < 10; i++) await place({ rid: rid(n++), table: A.t.W1, items: [L(A.i2, 1, 530)], dev: 'DV', ip: 'IV' + i });
await expectErr('M3 同店同设备 10 分钟第 11 单 → RATE_LIMITED(device_db)', 'RATE_LIMITED', () => place({ rid: rid(n++), table: A.t.W2, items: [L(A.i2, 1, 530)], dev: 'DV', ip: 'IV-new' }), 'device_db');
const [xo] = await q(`select o.id from orders o join order_client_meta m on m.order_id=o.id where m.device_hash=$1`, [H('dX0')]);
await asUser(ua.id, () => q(`select block_client_from_order($1)`, [xo.id]));
await expectErr('拉黑设备后再下单 → DEVICE_BLOCKED', 'DEVICE_BLOCKED', () => place({ rid: rid(n++), table: A.t.W2, items: [L(A.i2, 1, 530)], dev: 'dX0', ip: 'I-fresh' }));
await q(`update stores set require_captcha=true where id=$1`, [SA]);
await expectErr('要求验证码时未验证 → CAPTCHA_REQUIRED', 'CAPTCHA_REQUIRED', () => place({ rid: rid(n++), table: A.t.W2, items: [L(A.i2, 1, 530)], dev: 'dC', ip: 'IC' }));
ok('通过验证码后可下单', (await place({ rid: rid(n++), table: A.t.W2, items: [L(A.i2, 1, 530)], dev: 'dC', ip: 'IC', captcha: true })).replayed === false);
await q(`update stores set require_captcha=false where id=$1`, [SA]);

// ---------- 打烊 / 停用 ----------
await asUser(ua.id, () => q(`update stores set is_accepting_orders=false where id=$1`, [SA]));
await expectErr('打烊 → STORE_CLOSED', 'STORE_CLOSED', () => place({ rid: rid(n++), table: A.t.Z, items: [L(A.i1, 1, 1250)], dev: 'dQ', ip: 'IQ' }));
ok('打烊时菜单仍可看', (await cust(`select customer_get_menu($1,$2,1) r`, [SA, A.t.Z]))[0].r.items.length === 3);
await q(`update profiles set role='platform_admin' where user_id=$1`, [ub.id]);
await asUser(ub.id, () => q(`select admin_set_store_status($1,'suspended','test')`, [SA]));
await expectErr('停用：菜单不可见', 'STORE_SUSPENDED', () => cust(`select customer_get_menu($1,$2,1)`, [SA, A.t.Z]));
await asUser(ua.id, async () => {
  await expectErr('停用：店家改菜品 → STORE_SUSPENDED', 'STORE_SUSPENDED', () => q(`update items set price_cents=100 where id=$1`, [A.i1]));
  await expectErr('停用：店家 RPC → STORE_SUSPENDED', 'STORE_SUSPENDED', () => q(`select soft_delete_item($1)`, [A.i1]));
  await expectErr('停用：重置桌码 → STORE_SUSPENDED', 'STORE_SUSPENDED', () => q(`select rotate_table_qr($1)`, [A.t.Z]));
  ok('停用：店家仍可读', (await q(`select * from items where store_id=$1`, [SA])).length === 3);
});
await asUser(ub.id, async () => {
  const r = (await q(`select admin_list_stores() r`))[0].r; ok('平台管理员能列出店铺', r.total === 3, r.stores[0].owner_email);
  ok('平台管理员能看到手机号注册店主的号码', r.stores.some(x => x.owner_phone === '60123456789'));
  ok('平台管理员看不到各店订单', (await q(`select * from orders`)).length === 0);
  await expectErr('M2 admin_set_store_status 状态传 NULL → VALIDATION_FAILED', 'VALIDATION_FAILED', () => q(`select admin_set_store_status($1,null)`, [SA]));
  await q(`select admin_set_store_status($1,'active',null)`, [SA]);
});
await asUser(ua.id, async () => {
  await q(`select soft_delete_item($1)`, [A.i2]);
  ok('软删除保留行', (await q(`select deleted_at from items where id=$1`, [A.i2]))[0].deleted_at !== null);
  await expectErr('分类非空不能删 → CATEGORY_NOT_EMPTY', 'CATEGORY_NOT_EMPTY', () => q(`select delete_category($1)`, [A.c]));
  await expectErr('不能硬删菜品', 'permission denied for table items', () => q(`delete from items where id=$1`, [A.i2]));
});
await expectErr('一桌只能有一张 open 账单（唯一索引）', 'bills_one_open_per_table_uq', () => q(`insert into bills(store_id,table_id) values ($1,$2)`, [SA, T]));

console.log(`\nRESULT ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
