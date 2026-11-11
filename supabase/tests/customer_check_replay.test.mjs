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
  const check = (overrides={}) => {
    const a={store,table:t.id,version:1,request:firstRequest,hash:'f'.repeat(64),dev:D1,...overrides};
    return role(async () => (await q('select customer_check_replay($1,$2,$3,$4,$5,$6) result',[a.store,a.table,a.version,a.request,a.hash,a.dev]))[0].result);
  };
  equal(await check(),{status:'replay'});
  equal(await check({request:randomUUID()}),{status:'missing'});
  equal(await check({hash:'0'.repeat(64)}),{status:'mismatch',code:'IDEMPOTENCY_KEY_REUSED'});
  equal(await check({dev:D2}),{status:'mismatch',code:'IDEMPOTENCY_KEY_REUSED'});
  equal(await check({table:u.id}),{status:'mismatch',code:'IDEMPOTENCY_KEY_REUSED'});
  await error(()=>check({store:randomUUID()}),'TABLE_INVALID');
  // Another valid store cannot locate the original store's request ID.
  const [{id:uid2}]=await q("insert into auth.users(email,email_confirmed_at) values ('other@example.invalid',now()) returning id");
  const [{store_id:store2}]=await q('select store_id from store_members where user_id=$1',[uid2]);
  const [{id:table2}]=await q("insert into dining_tables(store_id,label) values ($1,'Other') returning id",[store2]);
  equal(await check({store:store2,table:table2}),{status:'missing'});
  await q('update dining_tables set qr_version=2 where id=$1',[t.id]);
  await error(()=>check(),'TABLE_INVALID');
  await error(()=>place(t.id,1,K2,firstRequest),'TABLE_INVALID');
  await q('update dining_tables set qr_version=1 where id=$1',[t.id]);
  await q("update stores set status='suspended' where id=$1",[store]);
  await error(()=>check(),'STORE_SUSPENDED');
  await error(()=>place(t.id,1,K2,firstRequest),'STORE_SUSPENDED');
  await q("update stores set status='active',is_accepting_orders=false where id=$1",[store]);
  await error(()=>check(),'STORE_CLOSED');
  await error(()=>place(t.id,1,K2,firstRequest),'STORE_CLOSED');
  await q('update stores set is_accepting_orders=true where id=$1',[store]);
  await q('update order_client_meta set device_hash=null where order_id=(select id from orders where request_id=$1)',[firstRequest]);
  equal(await check(),{status:'mismatch',code:'IDEMPOTENCY_KEY_REUSED'});
  await q('update order_client_meta set device_hash=$1 where order_id=(select id from orders where request_id=$2)',[D1,firstRequest]);
  // Commit fixtures first: read-only mode must cover a fresh transaction.
  await db.exec('commit; begin read only; set role customer_api');
  equal((await q('select customer_check_replay($1,$2,1,$3,$4,$5) result',[store,t.id,firstRequest,'f'.repeat(64),D1]))[0].result,{status:'replay'});
  equal((await q('select customer_check_replay($1,$2,1,$3,$4,$5) result',[store,t.id,randomUUID(),'f'.repeat(64),D1]))[0].result,{status:'missing'});
  equal((await q('select customer_check_replay($1,$2,1,$3,$4,$5) result',[store,t.id,firstRequest,'f'.repeat(64),D2]))[0].result,{status:'mismatch',code:'IDEMPOTENCY_KEY_REUSED'});
  await db.exec('reset role; commit');
  equal((await q("select conname from pg_constraint where conrelid='public.orders'::regclass and conname='orders_store_id_request_id_key'" )).length,1);
  const [{source}] = await q("select prosrc as source from pg_proc where oid='public.customer_check_replay(uuid,uuid,integer,uuid,text,text)'::regprocedure");
  equal(/for\s+(update|share)|advisory|\b(insert|update|delete|merge)\s/i.test(source),false);
  console.log(`PASS customer_check_replay: ${assertions} assertions`);
} finally { await db.close(); }
