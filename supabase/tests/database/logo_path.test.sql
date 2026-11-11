-- Also appended to security.test.sql: package.json test:db enumerates two files.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);
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
select * from finish();
rollback;
