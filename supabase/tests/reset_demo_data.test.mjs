import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migrations = new URL('../migrations/', import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const storeId = 'de000010-0000-4000-8000-000000000001';
const seedId = (n) => 'de000010-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const publicTableId = seedId(0x10);
const allowedEmail = 'merchant@example.invalid';
let passed = 0;
let failed = 0;

async function check(label, test) {
  try {
    await test();
    passed++;
    console.log('PASS', label);
  } catch (error) {
    failed++;
    console.error('FAIL', label, error);
  }
}

async function reset(emails = [allowedEmail]) {
  await db.exec('set role service_role');
  try {
    const [{ result }] = await rows('select public.reset_demo_data($1::text[]) as result', [emails]);
    return result;
  } finally {
    await db.exec('reset role');
  }
}

const operationalTables = [
  'blocked_clients', 'order_items', 'order_client_meta', 'orders', 'bill_access_tokens', 'bills',
];

async function snapshot() {
  const [store] = await rows('select * from stores');
  const tables = await rows('select * from dining_tables order by sort_order, id');
  const categories = await rows('select * from categories order by sort_order, id');
  const items = await rows('select * from items order by sort_order, id');
  return { store, tables, categories, items };
}

function withoutUpdateTime(data) {
  return JSON.parse(JSON.stringify(data, (key, value) => key === 'updated_at' ? undefined : value));
}

async function assertEmptyOperations() {
  for (const table of operationalTables) {
    assert.deepEqual(await rows('select * from ' + table), [], table);
  }
}

try {
  const stub = read('../test-support/supabase_stub.sql')
    .replace('grant anon, authenticated, service_role to postgres;', '');
  await db.exec(stub);
  await db.exec(read('../test-support/supabase_stub_rereview.sql'));
  for (const name of readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }

  await check('only service_role has API access to reset and read run history', async () => {
    for (const role of ['anon', 'authenticated', 'customer_api', 'service_role']) {
      const [privileges] = await rows(`
        select has_function_privilege($1, 'public.reset_demo_data(text[])', 'execute') as can_run,
               has_table_privilege($1, 'public.demo_reset_runs', 'select') as can_read,
               has_table_privilege($1, 'public.demo_reset_runs', 'insert') as can_insert
      `, [role]);
      assert.deepEqual(privileges, {
        can_run: role === 'service_role', can_read: role === 'service_role', can_insert: false,
      }, role);
    }
    assert.deepEqual(await rows(`
      select relrowsecurity from pg_class where oid = 'public.demo_reset_runs'::regclass
    `), [{ relrowsecurity: true }]);
  });

  await check('null, empty, and blank-only whitelists fail validation', async () => {
    for (const invalid of [null, [], [null, ' \t\n ']]) {
      await assert.rejects(reset(invalid), { code: 'P0001', message: 'VALIDATION_FAILED' });
    }
    assert.deepEqual(await rows('select * from stores'), []);
    assert.deepEqual(await rows('select * from demo_reset_runs'), []);
  });

  let golden;
  await check('service_role seeds an empty project and records the normalized whitelist', async () => {
    const result = await reset([' \tMERCHANT@EXAMPLE.INVALID\n ', allowedEmail, null, ' ']);
    assert.deepEqual(result, {
      store_id: storeId, public_table_id: publicTableId,
      stores: 1, tables: 3, categories: 4, items: 16, owners: 0,
      deleted: Object.fromEntries([...operationalTables, 'audit_logs', 'stores'].map((table) => [table, 0])),
    });
    golden = await snapshot();
    assert.deepEqual(await rows('select * from store_members'), []);
    await assertEmptyOperations();
    assert.deepEqual(await rows('select allowed_emails, result, success from demo_reset_runs'), [
      { allowed_emails: [allowedEmail], result, success: true },
    ]);
  });

  await check('store, tables and all 16 dishes match the golden data and Storage manifest', async () => {
    const { store, tables, categories, items } = golden;
    const storeFields = {
      id: storeId, slug: 'demo-teahouse', name: '示范茶餐室', address: '示范街 18 号',
      opening_hours: '每日 08:00–22:00', currency: 'MYR', locale: 'zh-Hans',
      timezone: 'Asia/Kuala_Lumpur', service_charge_bp: 1000, sst_bp: 600,
      status: 'active', is_accepting_orders: true, is_profile_complete: true,
      cash_rounding: false, require_first_order_approval: false, require_captcha: false,
      max_order_cents: 300000, status_reason: null, status_changed_at: null,
      logo_path: storeId + '/logo/' + seedId(2) + '.png',
    };
    for (const [key, value] of Object.entries(storeFields)) assert.equal(store[key], value, key);
    assert.deepEqual(tables.map(({ id, store_id, label, is_active, qr_version, sort_order, deleted_at }) =>
      [id, store_id, label, is_active, qr_version, sort_order, deleted_at]),
    ['A1', 'A2', 'A3'].map((label, i) => [seedId(0x10 + i), storeId, label, true, 1, i * 10, null]));
    assert.deepEqual(categories.map(({ id, store_id, name, sort_order, is_hidden, deleted_at }) =>
      [id, store_id, name, sort_order, is_hidden, deleted_at]),
    ['招牌饭面', '小食', '饮料', '甜品'].map((name, i) => [seedId(0x20 + i), storeId, name, i * 10, false, null]));

    const names = [
      '招牌海南鸡饭', '干炒牛河', '叉烧云吞面', '双人海鲜拼盘', '香脆炸鸡翅', '咖喱鱼蛋',
      '手工春卷', '招牌酥脆黄金豆腐配秘制香辣酱与时令蔬菜', '南洋奶茶', '冰柠檬茶', '白咖啡',
      '薏米水', '椰香西米露', '红豆冰', '芒果布丁', '传统咖椰吐司',
    ];
    const prices = [1250, 1490, 1280, 12800, 890, 690, 590, 990, 390, 490, 590, 390, 690, 790, 890, 490];
    assert.equal(items.length, names.length);
    for (const [i, { created_at, updated_at, ...item }] of items.entries()) {
      assert.ok(created_at && updated_at);
      const id = seedId(0x30 + i);
      const imageBase = storeId + '/items/' + id;
      assert.deepEqual(item, {
        id, store_id: storeId, category_id: seedId(0x20 + Math.floor(i / 4)), name: names[i],
        description: i === 7 ? '每日新鲜制作，外酥里嫩，配搭主厨调制酱汁。'.repeat(8)
          : '新鲜食材，用心烹调，一份熟悉的南洋滋味。',
        price_cents: prices[i], is_hidden: false, is_sold_out: i === 5 || i === 13,
        sort_order: i * 10, deleted_at: null, name_i18n: {}, description_i18n: {},
        image_path: i % 4 === 0 ? imageBase + '.png' : null,
        thumb_path: i % 4 === 0 ? imageBase + '_thumb.png' : null,
      });
    }

    const manifest = JSON.parse(read('../../scripts/demo-seed/manifest.json'));
    assert.equal(manifest.bucket, 'menu-images');
    assert.equal(manifest.contentType, 'image/png');
    const expectedKeys = [store.logo_path, ...items.flatMap((item) => [item.image_path, item.thumb_path]).filter(Boolean)];
    assert.deepEqual(manifest.objects.map(({ key }) => key).sort(), expectedKeys.sort());
    for (const { file } of manifest.objects) {
      const png = readFileSync(new URL('../../scripts/demo-seed/' + file, import.meta.url));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(png.length < 2_000_000);
    }
  });

  await db.exec(`
    update stores set name = 'Changed', status = 'suspended', require_captcha = true,
      is_accepting_orders = false, address = '', status_reason = 'Changed' where id = '${storeId}';
    update dining_tables set label = 'Old', qr_version = 2, is_active = false where id = '${publicTableId}';
    update dining_tables set label = 'A1' where id = '${seedId(0x11)}';
    insert into dining_tables (store_id, label) values ('${storeId}', 'a2');
    update categories set is_hidden = true, deleted_at = now() where id = '${seedId(0x20)}';
    update items set price_cents = 100, category_id = '${seedId(0x21)}', is_hidden = true,
      deleted_at = now(), name_i18n = '{"en": "Changed"}' where id = '${seedId(0x30)}';
    with extra_category as (
      insert into categories (store_id, name) values ('${storeId}', 'Extra') returning id
    )
    insert into items (store_id, category_id, name, price_cents)
      select '${storeId}', id, 'Extra', 100 from extra_category;
    with bill as (
      insert into bills (store_id, table_id)
      select store_id, id from dining_tables where store_id = '${storeId}' and label = 'a2'
      returning id, store_id, table_id
    ), new_order as (
      insert into orders (store_id, table_id, bill_id, seq_in_bill, subtotal_cents, item_count, request_id)
      select store_id, table_id, id, 1, 100, 1, gen_random_uuid() from bill returning id, store_id
    )
    insert into order_items (order_id, store_id, item_id, line_no, item_name, unit_price_cents, quantity)
      select o.id, o.store_id, i.id, 1, i.name, 100, 1 from new_order o
      join items i on i.store_id = o.store_id and i.name = 'Extra';
    insert into bill_access_tokens (bill_id, store_id, token_hash, device_hash)
      select id, store_id, repeat('a', 64), repeat('b', 64) from bills;
    insert into order_client_meta (order_id, store_id, request_hash, bill_token_id)
      select o.id, o.store_id, repeat('c', 64), t.id from orders o
      join bill_access_tokens t on t.bill_id = o.bill_id;
    insert into blocked_clients (store_id, kind, value_hash, source_order_id)
      select store_id, 'device', repeat('b', 64), id from orders;
    insert into audit_logs (actor_type, action, entity) values ('system', 'platform.test', 'stores');
  `);

  const dirty = await snapshot();
  for (const verified of [true, false]) {
    await check(`${verified ? 'verified' : 'unverified'} foreign email aborts before cleanup`, async () => {
      const [{ id }] = await rows(`
        insert into auth.users (email, raw_app_meta_data, email_confirmed_at)
        values ('outsider@example.invalid', '{"no_store":true}', case when $1 then now() end)
        returning id
      `, [verified]);
      try {
        await assert.rejects(reset(), {
          code: 'P0001', message: 'FORBIDDEN', detail: '{"reason": "email_outside_whitelist"}',
        });
        assert.deepEqual(await snapshot(), dirty);
        for (const table of operationalTables) assert.equal((await rows('select * from ' + table)).length, 1);
        assert.equal((await rows('select * from demo_reset_runs')).length, 1);
      } finally {
        await rows('delete from auth.users where id = $1', [id]);
      }
    });
  }

  for (const phoneOwner of [false, true]) {
    await check(`${phoneOwner ? 'phone-only foreign owner' : 'ownerless store'} aborts before cleanup`, async () => {
      let owner;
      let store;
      if (phoneOwner) {
        [owner] = await rows("insert into auth.users (phone, phone_confirmed_at) values ('60123456789', now()) returning id");
        [store] = await rows('select store_id as id from store_members where user_id = $1', [owner.id]);
      } else {
        [store] = await rows("insert into stores (slug, name) values ('ownerless-test', 'Ownerless') returning id");
      }
      try {
        await assert.rejects(reset(), {
          code: 'P0001', message: 'FORBIDDEN', detail: '{"reason": "store_outside_whitelist"}',
        });
        assert.deepEqual(await rows('select name from stores where id = $1', [storeId]), [{ name: 'Changed' }]);
        assert.equal((await rows('select id from stores where id = $1', [store.id])).length, 1);
        assert.equal((await rows('select id from orders')).length, 1);
      } finally {
        if (owner) await rows('delete from auth.users where id = $1', [owner.id]);
        await rows('delete from stores where id = $1', [store.id]);
      }
    });
  }

  await check('dirty reset restores all golden rows, clears operations and replaces scoped audit', async () => {
    const result = await reset();
    for (const table of operationalTables) assert.equal(result.deleted[table], 1, table);
    assert.deepEqual(withoutUpdateTime(await snapshot()), withoutUpdateTime(golden));
    await assertEmptyOperations();
    assert.deepEqual(await rows('select store_id, actor_type, action from audit_logs order by id'), [
      { store_id: null, actor_type: 'system', action: 'platform.test' },
      { store_id: storeId, actor_type: 'system', action: 'demo.reset' },
    ]);
  });

  await check('a second reset preserves full seed rows and appends run history', async () => {
    const clean = await snapshot();
    const result = await reset();
    assert.deepEqual(await snapshot(), clean);
    await assertEmptyOperations();
    for (const table of operationalTables) assert.equal(result.deleted[table], 0, table);
    assert.deepEqual(await rows('select success from demo_reset_runs'), Array(3).fill({ success: true }));
  });

  await check('allows multiple owners, removes the signup store and preserves auth and profiles', async () => {
    const users = await rows(`
      insert into auth.users (email, email_confirmed_at, raw_app_meta_data)
      values ('Merchant@Example.Invalid', now(), '{}'),
             ('second@example.invalid', now(), '{"no_store":true}')
      returning id
    `);
    const [leftover] = await rows(`
      select s.id, s.name from stores s join store_members m on s.id = m.store_id where m.user_id = $1
    `, [users[0].id]);
    assert.equal(leftover.name, '我的餐厅');
    await rows("update stores set slug = 'demo-teahouse-old' where id = $1", [storeId]);
    await rows("update stores set slug = 'demo-teahouse' where id = $1", [leftover.id]);
    await rows("insert into dining_tables (store_id, label) values ($1, 'A1')", [leftover.id]);
    const authBefore = await rows('select * from auth.users order by id');
    const profilesBefore = await rows('select * from profiles order by user_id');

    const emails = ['SECOND@EXAMPLE.INVALID', allowedEmail];
    const result = await reset(emails);
    assert.equal(result.deleted.stores, 1);
    assert.equal(result.owners, 2);
    assert.deepEqual(await rows('select id, slug from stores'), [{ id: storeId, slug: 'demo-teahouse' }]);
    const memberships = await rows('select * from store_members order by user_id');
    assert.deepEqual(memberships.map(({ user_id }) => user_id), users.map(({ id }) => id).sort());
    assert.ok(memberships.every((m) => m.store_id === storeId && m.role === 'owner'));
    await reset(emails);
    assert.deepEqual(await rows('select * from store_members order by user_id'), memberships);
    assert.deepEqual(await rows('select * from auth.users order by id'), authBefore);
    assert.deepEqual(await rows('select * from profiles order by user_id'), profilesBefore);
  });
} catch (error) {
  failed++;
  console.error('FAIL reset demo database setup or fixture', error);
} finally {
  await db.close();
}

console.log(`${passed} PASS / ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
