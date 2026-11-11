import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const db = new PGlite();
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
let assertions = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
try {
  await db.exec(read('../test-support/supabase_stub.sql').replace('grant anon, authenticated, service_role to postgres;', ''));
  await db.exec(read('../test-support/supabase_stub_rereview.sql'));
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) await db.exec(read('../migrations/' + f));
  await db.exec('begin');
  const [{ id: uid }] = await q("insert into auth.users(email,email_confirmed_at) values ('pr4@example.invalid',now()) returning id");
  const [{ store_id: store }] = await q('select store_id from store_members where user_id=$1', [uid]);
  const [t, u] = await q("insert into dining_tables(store_id,label) values ($1,'T'),($1,'U') returning id", [store]);
  const [{ id: cat }] = await q("insert into categories(store_id,name) values ($1,'C') returning id", [store]);
  const [{ id: item }] = await q("insert into items(store_id,category_id,name,price_cents) values ($1,$2,'I',100) returning id", [store,cat]);
  const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64), K1 = 'c'.repeat(64), KU = 'd'.repeat(64), K2 = 'e'.repeat(64);
  const cart = JSON.stringify([{item_id:item,quantity:1,unit_price_cents:100}]);
  const role = async fn => { await db.exec('savepoint rpc; set role customer_api'); try { return await fn(); } catch (e) { await db.exec('rollback to savepoint rpc'); throw e; } finally { await db.exec('reset role; release savepoint rpc'); } };
  const place = (table, version, token, request = randomUUID()) => role(async () => (await q('select customer_place_order($1,$2,$3,$4,$5,$6,$7,$8,null,$9,false) result', [store,table,version,request,'f'.repeat(64),cart,D1,'1'.repeat(64),token]))[0].result);
  const bill = (version, token=K1, dev=D1) => role(async () => (await q('select customer_get_bill($1,$2,$3,$4,$5) result',[store,t.id,version,token,dev]))[0].result);
  const error = async (fn, code, reason) => {
    await assert.rejects(fn, e => e.message === code && (!reason || JSON.parse(e.detail).reason === reason)); assertions++;
  };
  const firstRequest = randomUUID();
  await place(t.id,1,K1,firstRequest); await place(u.id,1,KU);
  const pay = async () => {
    const [{ id, total }] = await q(`select b.id,c.total_cents total from bills b join stores s on s.id=b.store_id
      cross join lateral private.calc_bill(b.subtotal_cents,s.service_charge_bp,s.sst_bp,s.cash_rounding) c
      where b.table_id=$1 and b.status='open'`,[t.id]);
    await db.exec(`set request.jwt.claims = '${JSON.stringify({sub:uid,role:'authenticated',aal:'aal2'})}'; set role authenticated`);
    try { await q('select mark_bill_paid($1,$2)',[id,total]); } finally { await db.exec('reset role'); }
  };
  const rotate = async () => {
    await db.exec(`set request.jwt.claims = '${JSON.stringify({sub:uid,role:'authenticated',aal:'aal2'})}'; set role authenticated`);
    try { await q('select rotate_table_qr($1)',[t.id]); } finally { await db.exec('reset role'); }
  };
  await db.exec('savepoint baseline');
  await rotate();
  await error(() => bill(1), 'BILL_TOKEN_EXPIRED','qr_rotated'); // 1 + old-version baseline regression
  await error(() => bill(1,null),'TABLE_INVALID'); // 2
  await error(() => bill(1,K1,D2),'TABLE_INVALID'); // 3
  await error(() => bill(1,KU),'TABLE_INVALID'); // 4
  await error(() => bill(2,KU),'BILL_TOKEN_INVALID'); // 5
  await place(t.id,2,K2);
  equal((await bill(2,K2)).view,'bill'); // 6
  await error(() => bill(1,K2),'TABLE_INVALID'); // 7
  equal((await q('select revoked_at from bill_access_tokens where token_hash=$1',[K2]))[0].revoked_at,null);
  equal((await bill(2,K2)).view,'bill');
  // 9: payment revocation after rotation preserves the first reason.
  await pay();
  await error(() => bill(1),'BILL_TOKEN_EXPIRED','qr_rotated');
  await db.exec('rollback to savepoint baseline');
  // 8: reverse the event order through the actual merchant settlement RPC.
  await pay();
  await rotate();
  await error(() => bill(1),'BILL_TOKEN_EXPIRED','bill_paid');
  await db.exec('rollback to savepoint baseline');
  // 10 / 11: old/current QR with an unrevoked expired token.
  await q('update dining_tables set qr_version=2 where id=$1',[t.id]);
  await q("update bill_access_tokens set expires_at=now()-interval '1 second' where token_hash=$1",[K1]);
  await error(() => bill(1),'BILL_TOKEN_EXPIRED','expired');
  await error(() => bill(2),'BILL_TOKEN_EXPIRED','expired');
  // 12: suspension wins for both versions, with and without token.
  await q("update stores set status='suspended' where id=$1",[store]);
  for (const version of [1,2]) for (const token of [K1,null]) await error(() => bill(version,token),'STORE_SUSPENDED');
  // 13: deleted tables fail before resolving the store.
  await q('update dining_tables set deleted_at=now() where id=$1',[t.id]);
  await error(() => bill(1),'TABLE_INVALID');
  await db.exec('rollback to savepoint baseline');
  // 14: configuration + exact EXECUTE ACLs, also assert SECURITY DEFINER.
  const signature = 'public.customer_get_bill(uuid,uuid,integer,text,text)';
  const [config] = await q('select proconfig,prosecdef from pg_proc where oid=$1::regprocedure',[signature]);
  equal(config.proconfig.includes('statement_timeout=3s'),true);
  equal(config.proconfig.includes('search_path=""'),true);
  equal(config.prosecdef,true);
  for (const role of ['customer_api','anon','authenticated','service_role']) equal((await q("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature]))[0].allowed,role==='customer_api');
  // Additional negative ownership/input cases beyond the 14-item matrix.
  await error(() => bill(1,'malformed'),'BILL_TOKEN_INVALID');
  await error(() => role(() => q('select customer_get_bill(null,$1,1,$2,$3)',[t.id,K1,D1])),'TABLE_INVALID');
  await error(() => role(() => q('select customer_get_bill($1,$2,null,$3,$4)',[store,t.id,K1,D1])),'TABLE_INVALID');
  const foreign = randomUUID();
  await error(() => role(() => q('select customer_get_bill($1,$2,1,$3,$4)',[foreign,t.id,K1,D1])),'TABLE_INVALID');
  await db.exec('savepoint malformed_stale');
  await q('update dining_tables set qr_version=2 where id=$1',[t.id]);
  await error(() => bill(1,'malformed'),'TABLE_INVALID');
  await error(() => bill(1,'9'.repeat(64)),'TABLE_INVALID');
  await db.exec('rollback to savepoint malformed_stale');
  // A2 probe safety: even a fully valid unknown ID is rolled back, as are token rotations.
  const request = randomUUID();
  await db.exec('savepoint probe'); await place(t.id,1,K2,request); await db.exec('rollback to savepoint probe');
  equal((await q('select count(*)::int n from orders where request_id=$1',[request]))[0].n,0);
  equal((await q('select count(*)::int n from bill_access_tokens where token_hash=$1',[K2]))[0].n,0);
  await db.exec('savepoint replay_rotation');
  equal((await place(t.id,1,K2,firstRequest)).replayed,true);
  equal((await q('select count(*)::int n from bill_access_tokens where token_hash=$1',[K1]))[0].n,0);
  await db.exec('rollback to savepoint replay_rotation');
  equal((await q('select count(*)::int n from bill_access_tokens where token_hash=$1',[K1]))[0].n,1);
  equal((await q('select count(*)::int n from orders where request_id=$1',[firstRequest]))[0].n,1);
  console.log(`PASS bill_qr_rotated: cases 1–14 + A2 rollback, ${assertions} assertions`);
} finally { await db.close(); }
