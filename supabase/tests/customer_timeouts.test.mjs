// L-9: catalog/ACL checks only; actual timer enforcement belongs to PostgreSQL CI/Preview.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
try {
  await db.exec(read('../test-support/supabase_stub.sql').replace('grant anon, authenticated, service_role to postgres;', ''));
  await db.exec(read('../test-support/supabase_stub_rereview.sql'));
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(read('../migrations/' + file));
  }
  await db.exec("set role customer_api; set statement_timeout = '60s'");
  assert.equal((await db.query('show statement_timeout')).rows[0].statement_timeout, '1min');
  const signatures = [
    'public.customer_get_menu(uuid,uuid,integer)',
    'public.customer_quote(uuid,uuid,integer,jsonb)',
    'public.customer_place_order(uuid,uuid,integer,uuid,text,jsonb,text,text,text,text,boolean)',
    'public.customer_get_bill(uuid,uuid,integer,text,text)',
  ];
  for (const signature of signatures) {
    const [row] = (await db.query('select proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows;
    assert.ok(row.proconfig.includes('statement_timeout=3s'), signature);
    assert.ok(row.proconfig.includes('search_path=""'), `${signature}: preserve empty search_path`);
  }
  assert.equal((await db.query("select has_database_privilege(current_user, 'postgres', 'TEMP') as allowed")).rows[0].allowed, false);
  await assert.rejects(db.exec('create temp table l9_forbidden(id integer)'), e => e.code === '42501');
  console.log('PASS L-9: 11 assertions (session SET, four timeout/search_path settings, TEMP ACL and denial)');
} finally { await db.close(); }
