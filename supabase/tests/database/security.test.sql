-- Integration checks against the actual Supabase roles, after ALL migrations.
begin;
-- The CLI connects as postgres, which is not a superuser in the local stack.
-- Test-only membership permits SET ROLE; ROLLBACK removes these grants.
-- Statements under test still run with the target role's own privileges / RLS.
grant customer_api, authenticated, anon to postgres;
create extension if not exists pgtap with schema extensions;
select plan(87);

insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data)
values ('aaaa0000-0000-4000-8000-000000000001', 'security-a@example.invalid', now(), '{}'),
       ('bbbb0000-0000-4000-8000-000000000001', 'security-b@example.invalid', now(), '{}');
create temp table fixture as
select store_id, gen_random_uuid() as table_id, gen_random_uuid() as other_table_id,
       gen_random_uuid() as category_id, gen_random_uuid() as item_id
from public.store_members where user_id = 'aaaa0000-0000-4000-8000-000000000001';
insert into public.dining_tables (id, store_id, label)
select table_id, store_id, 'security-1' from fixture union all
select other_table_id, store_id, 'security-2' from fixture;
insert into public.categories (id, store_id, name) select category_id, store_id, 'security' from fixture;
insert into public.items (id, store_id, category_id, name, price_cents)
select item_id, store_id, category_id, 'security', 100 from fixture;
grant select on fixture to customer_api, authenticated;

-- Invoker helper: never elevates customer_api or bypasses function grants.
create function pg_temp.place(p_device text, p_other_table boolean default false, p_hash text default repeat('a', 64))
returns jsonb language sql as $$
select public.customer_place_order(store_id, case when p_other_table then other_table_id else table_id end, 1,
 'cccc0000-0000-4000-8000-000000000001', p_hash,
 jsonb_build_array(jsonb_build_object('item_id', item_id, 'quantity', 1, 'unit_price_cents', 100)),
 p_device, repeat('b', 64), repeat('c', 64), repeat('d', 64), false) from fixture
$$;
grant execute on function pg_temp.place(text, boolean, text) to customer_api;

-- Keep pgTAP itself under postgres; only the statement under test changes role.
-- This avoids granting pgTAP internals to application roles after default EXECUTE revocation.
create function pg_temp.as_role(p_role text, p_sql text) returns text
language plpgsql as $$
declare result text;
begin
  execute format('set local role %I', p_role);
  execute p_sql into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;

select is(pg_temp.as_role('customer_api', $$select pg_temp.place(repeat('e',64))$$)::jsonb->>'replayed', 'false', 'customer_api creates order');
select is(pg_temp.as_role('customer_api', $$select pg_temp.place(repeat('e',64))$$)::jsonb->>'replayed', 'true', 'same device and table replay succeeds');
select throws_ok($assert$select pg_temp.as_role('customer_api', $$select pg_temp.place(repeat('f',64))$$)$assert$, 'P0001', 'IDEMPOTENCY_KEY_REUSED', 'cross-device replay rejected');
select throws_ok($assert$select pg_temp.as_role('customer_api', $$select pg_temp.place(repeat('e',64), true)$$)$assert$, 'P0001', 'IDEMPOTENCY_KEY_REUSED', 'cross-table replay rejected');
select throws_ok($assert$select pg_temp.as_role('customer_api', $$select pg_temp.place(repeat('e',64), false, repeat('f',64))$$)$assert$, 'P0001', 'IDEMPOTENCY_KEY_REUSED', 'different content uses same error');
select is((select token_hash from public.bill_access_tokens where store_id = (select store_id from fixture)), repeat('d',64), 'rejected replay leaves token unchanged');
update public.order_client_meta set device_hash = null where store_id = (select store_id from fixture);
select throws_ok($assert$select pg_temp.as_role('customer_api', $$select pg_temp.place(repeat('e',64))$$)$assert$, 'P0001', 'IDEMPOTENCY_KEY_REUSED', 'purged device metadata fails closed');

select set_config('request.jwt.claims', '{"sub":"bbbb0000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select is(pg_temp.as_role('authenticated', $$select count(*)::int from public.items where store_id = (select store_id from fixture)$$)::int, 0, 'merchant cannot read another store');
select is(pg_temp.as_role('authenticated', $$select count(*)::int from public.orders where store_id = (select store_id from fixture)$$)::int, 0, 'merchant cannot read another store orders');
select throws_ok($assert$select pg_temp.as_role('authenticated', $$select status_reason from public.stores$$)$assert$, '42501', null, 'status reason isolated');
select throws_ok($assert$select pg_temp.as_role('authenticated', $$select value_hash from public.blocked_clients$$)$assert$, '42501', null, 'blocked hashes isolated');
select throws_ok($assert$select pg_temp.as_role('authenticated', $$select * from public.order_client_meta$$)$assert$, '42501', null, 'client metadata isolated');
select throws_ok($assert$select pg_temp.as_role('anon', $$select * from public.orders$$)$assert$, '42501', null, 'anonymous orders denied');
select throws_ok($assert$select pg_temp.as_role('anon', $$select public.get_my_context()$$)$assert$, '42501', null, 'anonymous RPC denied');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
 where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
 and has_function_privilege('customer_api', p.oid, 'execute')),
 array['customer_get_bill','customer_get_menu','customer_place_order','customer_quote']::text[], 'customer function allowlist');
select ok(not has_function_privilege('authenticated', 'public.customer_place_order(uuid,uuid,integer,uuid,text,jsonb,text,text,text,text,boolean)', 'execute'), 'merchant cannot execute customer RPC');
select ok(not has_function_privilege('service_role', 'public.customer_place_order(uuid,uuid,integer,uuid,text,jsonb,text,text,text,text,boolean)', 'execute'), 'service role cannot execute customer RPC');
select ok(not has_function_privilege('anon', 'public.customer_place_order(uuid,uuid,integer,uuid,text,jsonb,text,text,text,text,boolean)', 'execute'), 'anonymous cannot execute customer RPC');
select is((select count(*)::int from pg_proc p
 where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
 and has_function_privilege('anon', p.oid, 'execute')), 0, 'anonymous has no application function grants');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
 where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
 and has_function_privilege('authenticated', p.oid, 'execute')),
 array['admin_list_stores','admin_set_store_status','block_client_from_order','calc_bill','can_write_store','delete_category','div_round',
 'ensure_my_store','get_my_context','get_store_daily_stats','is_platform_admin','is_store_member','list_blocked_clients','mark_bill_paid',
 'reorder_categories','reorder_items','rotate_table_qr','soft_delete_item','soft_delete_table','try_uuid','unblock_client','update_order_status']::text[],
 'merchant function allowlist');
update public.profiles set role = 'platform_admin' where user_id = 'bbbb0000-0000-4000-8000-000000000001';
select throws_ok($assert$select pg_temp.as_role('authenticated', $$select public.admin_list_stores()$$)$assert$, 'P0001', 'MFA_REQUIRED', 'platform admin at aal1 cannot access admin RPC');
insert into public.stores(id,slug,name) values ('cccc0000-0000-4000-8000-000000000002','pr2-path-check','paths');
insert into public.categories(id,store_id,name) values ('cccc0000-0000-4000-8000-000000000003','cccc0000-0000-4000-8000-000000000002','paths');
insert into public.items(id,store_id,category_id,name,price_cents) values ('cccc0000-0000-4000-8000-000000000004','cccc0000-0000-4000-8000-000000000002','cccc0000-0000-4000-8000-000000000003','paths',100);
create function pg_temp.pr2_path(p_table text,p_column text,p_value text) returns text language plpgsql as $$
begin
  execute format('update public.%I set %I=$1 where id=$2',p_table,p_column) using p_value,
    case when p_table='stores' then 'cccc0000-0000-4000-8000-000000000002' else 'cccc0000-0000-4000-8000-000000000004' end::uuid;
  return 'ok';
exception when check_violation then return sqlstate;
end $$;
select is(pg_temp.pr2_path(t,c,p),expected,c||': '||coalesce(p,'NULL'))
from (values ('stores','logo_path','logo',''),('items','image_path','items',''),('items','thumb_path','items','_thumb')) as columns(t,c,d,s)
cross join lateral (values
 (null::text,'ok'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.webp','ok'),
 ('https://evil.invalid/image.png','23514'),('http://evil.invalid/image.png','23514'),
 ('//evil.invalid/image.png','23514'),('data:image/png;base64,AAA','23514'),
 ('dddd0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.png','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/../11111111-1111-4111-8111-111111111111'||s||'.png','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.png/..','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.svg','23514')
) as paths(p,expected);
-- F-8: append coverage without removing the original path matrix.
select is(pg_temp.pr2_path(t,c,p),expected,c||': F-8 '||p)
from (values ('stores','logo_path','logo',''),('items','image_path','items',''),('items','thumb_path','items','_thumb')) as columns(t,c,d,s)
cross join lateral (values
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||E'.png\n','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||E'/\n11111111-1111-4111-8111-111111111111'||s||'.png','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||upper(d)||'/11111111-1111-4111-8111-111111111111'||s||'.png','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'||s||'.png','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.PNG','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.png.webp','23514'),
 ((select store_id::text from fixture)||'/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.png','23514'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.jpg','ok'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.jpeg','ok'),
 ('cccc0000-0000-4000-8000-000000000002/'||d||'/11111111-1111-4111-8111-111111111111'||s||'.png','ok')
) as paths(p,expected);

-- L-9: inspect all four exact function identities as customer_api after SET 60s.
-- Catalog assertions are intentional: no wall-clock timeout claim from pg_sleep.
select is(pg_temp.as_role('customer_api', $sql$
 select set_config('statement_timeout', '60s', true)
$sql$), '1min', 'customer session can request 60 seconds');
select is(pg_temp.as_role('customer_api', format(
 'select (%L = any(proconfig))::text from pg_proc where oid = %L::regprocedure',
 'statement_timeout=3s', signature)), 'true', signature||' retains function timeout')
from (values
 ('public.customer_get_menu(uuid,uuid,integer)'),
 ('public.customer_quote(uuid,uuid,integer,jsonb)'),
 ('public.customer_place_order(uuid,uuid,integer,uuid,text,jsonb,text,text,text,text,boolean)'),
 ('public.customer_get_bill(uuid,uuid,integer,text,text)')
) as functions(signature);
select throws_ok($assert$select pg_temp.as_role('customer_api', $$create temp table l9_forbidden(id integer)$$)$assert$,
 '42501', null, 'customer_api cannot create temporary tables');
select * from finish();
rollback;
