// Execute the real constraints and sorting RPCs after all committed migrations.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
try {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  await db.exec(read('../test-support/supabase_stub.sql').replace('grant anon, authenticated, service_role to postgres;', ''));
  await db.exec(read('../test-support/supabase_stub_rereview.sql'));
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) await db.exec(read('../migrations/' + f));
  const [{ id: user }] = (await db.query("insert into auth.users(email,email_confirmed_at) values ('paths@example.invalid',now()) returning id")).rows;
  const [{ store_id: store }] = (await db.query('select store_id from store_members where user_id=$1', [user])).rows;
  const [{ id: category }] = (await db.query("insert into categories(store_id,name) values ($1,'paths') returning id", [store])).rows;
  const [{ id: item }] = (await db.query("insert into items(store_id,category_id,name,price_cents) values ($1,$2,'paths',100) returning id", [store, category])).rows;
  const [{ id: otherStore }] = (await db.query("insert into stores(slug,name) values ('other-path-store','other') returning id")).rows;
  const uuid = '11111111-1111-4111-8111-111111111111';
  let assertions = 0;
  for (const [table, column, id, directory, suffix, constraint] of [
    ['stores','logo_path',store,'logo','', 'stores_logo_path_ck'],
    ['items','image_path',item,'items','', 'items_image_path_ck'],
    ['items','thumb_path',item,'items','_thumb', 'items_thumb_path_ck'],
  ]) {
    const valid = `${store}/${directory}/${uuid}${suffix}.webp`;
    const invalid = [`https://evil.invalid/${valid}`, `http://evil.invalid/${valid}`, `//evil.invalid/${valid}`, `data:image/png;base64,AAA`, `${uuid}/${directory}/${uuid}${suffix}.png`, `${store}/${directory}/../${uuid}${suffix}.png`, `${valid}/..`, `${store}/${directory}/${uuid}${suffix}.svg`];
    invalid.push(`${valid}\n`, `${store}/${directory}/\n${uuid}${suffix}.png`,
      `${store}/${directory.toUpperCase()}/${uuid}${suffix}.png`,
      `${store}/${directory}/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA${suffix}.png`,
      valid.replace(/webp$/, 'PNG'), `${valid}.png`,
      `${otherStore}/${directory}/${uuid}${suffix}.png`);
    for (const path of invalid) {
      await assert.rejects(db.query(`update ${table} set ${column}=$1 where id=$2`, [path, id]), e => e.code === '23514' && e.constraint === constraint);
      assertions++;
    }
    for (const path of [null, ...['webp','jpg','jpeg','png'].map(ext => valid.replace(/webp$/, ext))]) {
      await db.query(`update ${table} set ${column}=$1 where id=$2`, [path, id]);
      assert.equal((await db.query(`select ${column} from ${table} where id=$1`, [id])).rows[0][column], path);
      assertions++;
    }
  }
  const cats = [category];
  for (const name of ['second','third']) cats.push((await db.query('insert into categories(store_id,name) values ($1,$2) returning id',[store,name])).rows[0].id);
  const items = [item];
  for (const name of ['second','third']) items.push((await db.query('insert into items(store_id,category_id,name,price_cents) values ($1,$2,$3,100) returning id',[store, category, name])).rows[0].id);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({sub:user,role:'authenticated',aal:'aal1'})]);
  await db.exec('set role authenticated');
  await db.query('select reorder_categories($1::uuid[])', [[...cats].reverse()]);
  await db.query('select reorder_items($1,$2::uuid[])', [category,[...items].reverse()]);
  for (const [table, ids] of [['categories',cats],['items',items]]) {
    const rows = (await db.query(`select id,sort_order from ${table} order by sort_order`)).rows;
    assert.deepEqual(rows.map(r => r.id), [...ids].reverse());
    assert.deepEqual(rows.map(r => r.sort_order), [10,20,30]);
    assertions += 2;
  }
  console.log(`PASS PR2 image constraints / sorting: ${assertions} assertions`);
} finally { await db.close(); }
