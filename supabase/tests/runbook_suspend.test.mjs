// 运维手册 docs/runbook-emergency-suspend-store.md 的 SQL 验收：直接从手册里读出带 -- RUNBOOK: 标记的 SQL 运行
// 本地：node supabase/tests/runbook_suspend.test.mjs（PGlite 是超级用户；真实 SQL Editor 是 postgres 角色，见手册开头）
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const M = new URL('../migrations/', import.meta.url).pathname;
const stub = fs.readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf8').replace('grant anon, authenticated, service_role to postgres;', '');
await db.exec(stub);
await db.exec(fs.readFileSync(new URL('./supabase_stub_rereview.sql', import.meta.url), 'utf8'));
for (const f of ['0001_init.sql', '0002_rpc.sql', '0003_security_rereview.sql', '0004_frontend_alignment.sql']) await db.exec(fs.readFileSync(M + f, 'utf8'));
const md = fs.readFileSync(new URL('../../docs/runbook-emergency-suspend-store.md', import.meta.url), 'utf8');
const blocks = Object.fromEntries([...md.matchAll(/```sql\n-- RUNBOOK:(\w+)[^\n]*\n([\s\S]*?)```/g)].map(m => [m[1], m[2]]));

await db.exec(fs.readFileSync(M + '0005_purge_resend_boundary.sql', 'utf8'));
await db.exec(fs.readFileSync(M + '0006_idempotency_device_binding.sql', 'utf8'));
let pass = 0, fail = 0;
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const report = (good, label, extra = '') => { good ? pass++ : fail++; console.log(good ? 'PASS' : 'FAIL', label, extra); };
const ok = (label, cond, extra = '') => report(!!cond, label, extra);
const asUser = async (uid, fn) => {
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: 'authenticated' })}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`); }
};
const fill = (sql, v) => Object.entries(v).reduce((s, [k, x]) => s.split(`<${k}>`).join(x), sql);
const run = async (name, v) => { const r = await db.exec(fill(blocks[name], v)); return r[r.length - 1].rows; };

ok('手册里 5 段 SQL 都在（lookup / check / suspend / verify / restore）', ['lookup', 'check', 'suspend', 'verify', 'restore'].every(k => blocks[k]), Object.keys(blocks).join(','));

// 准备：两家店，各有一张桌子
const mk = async (email, phone, name) => {
  const [u] = await q(`insert into auth.users(email, phone, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3::jsonb) returning id`, [email, phone, JSON.stringify({ store_name: name })]);
  const [m] = await q(`select store_id from store_members where user_id=$1`, [u.id]);
  await q(`update stores set name=$2 where id=$1`, [m.store_id, name]);   // L-5 起注册不收店名，店家登录后自己改名
  await q(`insert into dining_tables(store_id, label) values ($1, 'A1')`, [m.store_id]);
  return { uid: u.id, store: m.store_id };
};
const A = await mk('bad@x.com', null, '问题店');
const B = await mk('good@x.com', '60123456789', '正常店');
const V = { '店铺 slug': '<店铺 slug>', '店名关键字': '<店名关键字>', '店主邮箱': '<店主邮箱>', '店主手机，例如 60123456789': '<店主手机，例如 60123456789>' };

// 第 1 步：按邮箱、手机号、店名都能找到唯一一家；占位符原样保留时不会匹配所有店
let r = await run('lookup', { ...V, '店主邮箱': 'BAD@x.com' });
ok('第 1 步 按店主邮箱（大小写不敏感）找到唯一一家', r.length === 1 && r[0].store_id === A.store && r[0].owner_uid === A.uid, JSON.stringify(r));
r = await run('lookup', { ...V, '店主手机，例如 60123456789': '60123456789' });
ok('第 1 步 按手机号找到正常店', r.length === 1 && r[0].store_id === B.store);
r = await run('lookup', { ...V, '店名关键字': '问题' });
ok('第 1 步 按店名关键字找到问题店', r.length === 1 && r[0].store_id === A.store);
r = await run('lookup', V);
ok('第 1 步 占位符原样保留 → 0 行（不会误匹配全部）', r.length === 0);

// 第 2 步
r = await run('check', { '店铺 id': A.store });
ok('第 2 步 停用前 status = active', r.length === 1 && r[0].status === 'active');

// 停用前先跑一次第 4 步：全部可以执行
const Vv = { '店铺 id': A.store, '店主 uid': A.uid };
r = await run('verify', Vv);
ok('第 4 步（停用前）顾客菜单 / 下单 / 店家读写都可以执行', r.length === 1 && r[0].customer_menu === '可以执行' && r[0].customer_order === '可以执行' && r[0].owner_read === '可以执行' && r[0].owner_write === '可以执行', JSON.stringify(r));

// 第 3 步：停用
const Vs = { '店铺 id': A.store, '原因': '涉嫌刷单（运维手册测试）', '操作人': 'songhaw', '事件编号': 'INC-1' };
r = await run('suspend', Vs);
ok('第 3 步 停用返回 1 行，审计 details 含原因、操作人、事件编号', r.length === 1 && r[0].details.reason === '涉嫌刷单（运维手册测试）' && r[0].details.operator === 'songhaw' && r[0].details.ticket === 'INC-1' && r[0].details.via === 'sql_editor');
ok('第 3 步（rereview-3 低-3）审计 details 记下 db_user / session_user', r[0].details.db_user === 'postgres' && r[0].details.session_user === 'postgres', JSON.stringify(r[0].details));
const st = (await q(`select status, status_reason from stores where id=$1`, [A.store]))[0];
ok('第 3 步 stores.status = suspended、原因已写', st.status === 'suspended' && st.status_reason === '涉嫌刷单（运维手册测试）');
ok('第 3 步 审计日志 actor_type = admin', (await q(`select count(*)::int n from audit_logs where store_id=$1 and action='store.status' and actor_type='admin'`, [A.store]))[0].n === 1);
ok('第 3 步 只改了这一家店', (await q(`select status from stores where id=$1`, [B.store]))[0].status === 'active');
r = await run('suspend', Vs);
ok('第 3 步 重复执行 → 0 行，不重复写审计', r.length === 0 && (await q(`select count(*)::int n from audit_logs where store_id=$1 and action='store.status'`, [A.store]))[0].n === 1);
r = await run('suspend', { ...Vs, '店铺 id': '00000000-0000-4000-8000-000000000000' });
ok('第 3 步 id 填错 → 0 行', r.length === 0);
let err = '';
try { await run('suspend', { ...Vs, '店铺 id': B.store, '原因': 'x'.repeat(201) }); } catch (e) { err = e.message; }
ok('第 3 步 原因超过 200 字 → 报错且不改数据', err !== '' && (await q(`select status from stores where id=$1`, [B.store]))[0].status === 'active', err);
// rereview-3 低-3：dollar quoting 后，原因 / 操作人里有单引号也能执行（用 B 店试一次，再用第 6 步恢复）
r = await run('suspend', { ...Vs, '店铺 id': B.store, '原因': "店主's 账号被盗；'); drop table stores; --", '操作人': "o'neil", '事件编号': "INC-'2" });
ok('第 3 步 文本含单引号（及注入样式文本）→ 正常停用，原样写入', r.length === 1 && r[0].details.reason === "店主's 账号被盗；'); drop table stores; --" && r[0].details.operator === "o'neil"
  && (await q(`select status_reason from stores where id=$1`, [B.store]))[0].status_reason === "店主's 账号被盗；'); drop table stores; --", JSON.stringify(r));
r = await run('restore', { '店铺 id': B.store, '恢复原因': "测试回滚 'quote'", '操作人': "o'neil", '事件编号': "INC-'2" });
ok('第 6 步 文本含单引号 → 正常恢复，B 店回到 active', r.length === 1 && r[0].details.reason === "测试回滚 'quote'" && (await q(`select status from stores where id=$1`, [B.store]))[0].status === 'active');

// 第 4 步：验证
r = await run('verify', Vv);
ok('第 4 步 status = suspended', r[0].status === 'suspended');
ok('第 4 步 顾客读菜单被拦住：STORE_SUSPENDED', r[0].customer_menu.startsWith('被拦住') && r[0].customer_menu.includes('STORE_SUSPENDED'), r[0].customer_menu);
ok('第 4 步 顾客下单被拦住：STORE_SUSPENDED', r[0].customer_order.includes('STORE_SUSPENDED'), r[0].customer_order);
ok('第 4 步 店家可以读（只读）', r[0].owner_read === '可以执行', r[0].owner_read);
ok('第 4 步 店家写被拦住：STORE_SUSPENDED', r[0].owner_write.includes('STORE_SUSPENDED'), r[0].owner_write);
ok('第 4 步 不改数据：试写已撤销、角色已还原', (await q(`select current_user u, current_setting('request.jwt.claims', true) c`))[0].u === 'postgres');
// 店家在 H-1 之后看不到原因与平台审计行
const ownerView = await asUser(A.uid, async () => ({
  st: await q(`select status from stores where id=$1`, [A.store]),
  audit: await q(`select action from audit_logs where store_id=$1`, [A.store]),
}));
ok('停用后店家看得到 status = suspended，看不到 admin 审计行', ownerView.st[0]?.status === 'suspended' && !ownerView.audit.some(a => a.action === 'store.status'), JSON.stringify(ownerView));
ok('get_my_context 不含停用原因', !JSON.stringify((await asUser(A.uid, () => q(`select get_my_context() r`)))[0].r).includes('刷单'));

// 第 6 步：恢复
r = await run('restore', { '店铺 id': A.store, '恢复原因': '误操作回滚', '操作人': 'songhaw', '事件编号': 'INC-1' });
ok('第 6 步 恢复返回 1 行', r.length === 1 && r[0].details.status === 'active');
const st2 = (await q(`select status, status_reason from stores where id=$1`, [A.store]))[0];
ok('第 6 步 status = active、原因清空', st2.status === 'active' && st2.status_reason === null);
r = await run('verify', Vv);
ok('第 6 步后第 4 步全部可以执行', r[0].customer_menu === '可以执行' && r[0].customer_order === '可以执行' && r[0].owner_write === '可以执行', JSON.stringify(r));
r = await run('restore', { '店铺 id': A.store, '恢复原因': 'x', '操作人': 'x', '事件编号': 'x' });
ok('第 6 步 对未停用的店再恢复 → 0 行', r.length === 0);
ok('审计日志共 2 条（停用 + 恢复），按时间可追溯', (await q(`select count(*)::int n from audit_logs where store_id=$1 and action='store.status'`, [A.store]))[0].n === 2);

console.log(`${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
