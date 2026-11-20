-- Bound lock waits and limit the normalized demo email whitelist.
create or replace function public.reset_demo_data(p_allowed_emails text[])
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '30s'
as $$
declare
  v_store_id constant uuid := 'de000010-0000-4000-8000-000000000001';
  v_logo_id constant uuid := 'de000010-0000-4000-8000-000000000002';
  v_table_ids constant uuid[] := array[
    'de000010-0000-4000-8000-000000000010',
    'de000010-0000-4000-8000-000000000011',
    'de000010-0000-4000-8000-000000000012'
  ]::uuid[];
  v_category_ids constant uuid[] := array[
    'de000010-0000-4000-8000-000000000020', 'de000010-0000-4000-8000-000000000021',
    'de000010-0000-4000-8000-000000000022', 'de000010-0000-4000-8000-000000000023'
  ]::uuid[];
  v_item_ids constant uuid[] := array[
    'de000010-0000-4000-8000-000000000030', 'de000010-0000-4000-8000-000000000031',
    'de000010-0000-4000-8000-000000000032', 'de000010-0000-4000-8000-000000000033',
    'de000010-0000-4000-8000-000000000034', 'de000010-0000-4000-8000-000000000035',
    'de000010-0000-4000-8000-000000000036', 'de000010-0000-4000-8000-000000000037',
    'de000010-0000-4000-8000-000000000038', 'de000010-0000-4000-8000-000000000039',
    'de000010-0000-4000-8000-00000000003a', 'de000010-0000-4000-8000-00000000003b',
    'de000010-0000-4000-8000-00000000003c', 'de000010-0000-4000-8000-00000000003d',
    'de000010-0000-4000-8000-00000000003e', 'de000010-0000-4000-8000-00000000003f'
  ]::uuid[];
  v_allowed_emails text[];
  v_allowed_users uuid[];
  v_reset_stores uuid[];
  v_deleted jsonb := '{}'::jsonb;
  v_affected bigint;
  v_relation text;
  v_result jsonb;
begin
  select array_agg(distinct email order by email) into v_allowed_emails
  from (
    select lower(regexp_replace(entry, '^\s+|\s+$', '', 'g')) as email
    from unnest(p_allowed_emails) as entries(entry)
  ) normalized
  where email <> '';

  if v_allowed_emails is null then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'p_allowed_emails'));
  end if;

  if cardinality(v_allowed_emails) > 10 then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'p_allowed_emails', 'max', 10));
  end if;

  -- Keep the user and ownership checks stable through cleanup, including during signup.
  -- The business locks also serialize resets with each other and with demo writes.
  lock table auth.users in share mode;
  lock table public.stores, public.store_members, public.dining_tables, public.categories,
    public.items, public.bills, public.orders, public.order_items, public.order_client_meta,
    public.bill_access_tokens, public.blocked_clients, public.audit_logs in share row exclusive mode;

  if exists (
    select 1 from auth.users u
    where u.email is not null and not (lower(u.email) = any(v_allowed_emails))
  ) then
    perform private.raise_app('FORBIDDEN', jsonb_build_object('reason', 'email_outside_whitelist'));
  end if;

  select coalesce(array_agg(u.id), '{}'::uuid[]) into v_allowed_users
  from auth.users u where lower(u.email) = any(v_allowed_emails);

  if exists (
    select 1 from public.store_members m
    where not (m.user_id = any(v_allowed_users)) and (m.role = 'owner' or m.store_id <> v_store_id)
  ) or exists (
    select 1 from public.stores s
    where s.id <> v_store_id and not exists (
      select 1 from public.store_members m
      where m.store_id = s.id and m.role = 'owner' and m.user_id = any(v_allowed_users)
    )
  ) then
    perform private.raise_app('FORBIDDEN', jsonb_build_object('reason', 'store_outside_whitelist'));
  end if;

  -- At this point all stores are either the golden store or verified disposable leftovers.
  select coalesce(array_agg(id), '{}'::uuid[]) into v_reset_stores from public.stores;

  -- Delete in dependency order and count rows explicitly, including those on leftover stores.
  foreach v_relation in array array[
    'blocked_clients', 'order_items', 'order_client_meta', 'orders',
    'bill_access_tokens', 'bills', 'audit_logs'
  ] loop
    execute format('delete from public.%I where store_id = any($1)', v_relation) using v_reset_stores;
    get diagnostics v_affected = row_count;
    v_deleted := v_deleted || jsonb_build_object(v_relation, v_affected);
  end loop;

  delete from public.items where store_id <> v_store_id;
  delete from public.categories where store_id <> v_store_id;
  delete from public.dining_tables where store_id <> v_store_id;
  delete from public.store_members where store_id <> v_store_id;
  delete from public.stores where id <> v_store_id;
  get diagnostics v_affected = row_count;
  v_deleted := v_deleted || jsonb_build_object('stores', v_affected);

  insert into public.stores as current_row
    (id, slug, name, logo_path, address, opening_hours, currency, locale, timezone,
     service_charge_bp, sst_bp, status, is_accepting_orders, status_reason, status_changed_at,
     cash_rounding, require_first_order_approval, require_captcha, max_order_cents)
  values
    (v_store_id, 'demo-teahouse', '示范茶餐室', v_store_id || '/logo/' || v_logo_id || '.png',
     '示范街 18 号', '每日 08:00–22:00', 'MYR', 'zh-Hans', 'Asia/Kuala_Lumpur',
     1000, 600, 'active', true, null, null, false, false, false, 300000)
  on conflict (id) do update
    set (slug, name, logo_path, address, opening_hours, currency, locale, timezone,
         service_charge_bp, sst_bp, status, is_accepting_orders, status_reason, status_changed_at,
         cash_rounding, require_first_order_approval, require_captcha, max_order_cents) =
        (excluded.slug, excluded.name, excluded.logo_path, excluded.address, excluded.opening_hours,
         excluded.currency, excluded.locale, excluded.timezone, excluded.service_charge_bp,
         excluded.sst_bp, excluded.status, excluded.is_accepting_orders, excluded.status_reason,
         excluded.status_changed_at, excluded.cash_rounding, excluded.require_first_order_approval,
         excluded.require_captcha, excluded.max_order_cents)
    where (current_row.slug, current_row.name, current_row.logo_path, current_row.address,
           current_row.opening_hours, current_row.currency, current_row.locale,
           current_row.timezone, current_row.service_charge_bp, current_row.sst_bp,
           current_row.status, current_row.is_accepting_orders, current_row.status_reason,
           current_row.status_changed_at, current_row.cash_rounding,
           current_row.require_first_order_approval, current_row.require_captcha,
           current_row.max_order_cents)
      is distinct from (excluded.slug, excluded.name, excluded.logo_path, excluded.address,
                        excluded.opening_hours, excluded.currency, excluded.locale,
                        excluded.timezone, excluded.service_charge_bp, excluded.sst_bp,
                        excluded.status, excluded.is_accepting_orders, excluded.status_reason,
                        excluded.status_changed_at, excluded.cash_rounding,
                        excluded.require_first_order_approval, excluded.require_captcha,
                        excluded.max_order_cents);

  -- Free labels held by extra tables or by seeded tables whose labels were swapped.
  delete from public.dining_tables where store_id = v_store_id and not (id = any(v_table_ids));
  update public.dining_tables t set deleted_at = now()
  from unnest(v_table_ids) with ordinality as seed(id, position)
  where t.store_id = v_store_id and t.id = seed.id and t.deleted_at is null
    and t.label <> 'A' || seed.position;

  insert into public.dining_tables as current_row
    (id, store_id, label, sort_order, is_active, qr_version, deleted_at)
  values
    (v_table_ids[1], v_store_id, 'A1', 0, true, 1, null),
    (v_table_ids[2], v_store_id, 'A2', 10, true, 1, null),
    (v_table_ids[3], v_store_id, 'A3', 20, true, 1, null)
  on conflict (id) do update
    set (label, sort_order, is_active, qr_version, deleted_at) =
        (excluded.label, excluded.sort_order, excluded.is_active, excluded.qr_version,
         excluded.deleted_at)
    where (current_row.label, current_row.sort_order, current_row.is_active, current_row.qr_version,
           current_row.deleted_at)
      is distinct from (excluded.label, excluded.sort_order, excluded.is_active,
                        excluded.qr_version, excluded.deleted_at);

  insert into public.categories as current_row
    (id, store_id, name, sort_order, is_hidden, deleted_at)
  values
    (v_category_ids[1], v_store_id, '招牌饭面', 0, false, null),
    (v_category_ids[2], v_store_id, '小食', 10, false, null),
    (v_category_ids[3], v_store_id, '饮料', 20, false, null),
    (v_category_ids[4], v_store_id, '甜品', 30, false, null)
  on conflict (id) do update
    set (name, sort_order, is_hidden, deleted_at) =
        (excluded.name, excluded.sort_order, excluded.is_hidden, excluded.deleted_at)
    where (current_row.name, current_row.sort_order, current_row.is_hidden, current_row.deleted_at)
      is distinct from (excluded.name, excluded.sort_order, excluded.is_hidden, excluded.deleted_at);

  insert into public.items as current_row
    (id, store_id, category_id, name, description, price_cents, image_path, thumb_path,
     is_sold_out, is_hidden, sort_order, deleted_at, name_i18n, description_i18n)
  select v_item_ids[seed.idx + 1], v_store_id, v_category_ids[seed.idx / 4 + 1], seed.name,
    case when seed.idx = 7 then repeat('每日新鲜制作，外酥里嫩，配搭主厨调制酱汁。', 8)
         else '新鲜食材，用心烹调，一份熟悉的南洋滋味。' end,
    seed.price_cents, image.base_path || '.png', image.base_path || '_thumb.png',
    seed.idx in (5, 13), false, seed.idx * 10, null, '{}'::jsonb, '{}'::jsonb
  from (values
    (0, '招牌海南鸡饭', 1250),
    (1, '干炒牛河', 1490),
    (2, '叉烧云吞面', 1280),
    (3, '双人海鲜拼盘', 12800),
    (4, '香脆炸鸡翅', 890),
    (5, '咖喱鱼蛋', 690),
    (6, '手工春卷', 590),
    (7, '招牌酥脆黄金豆腐配秘制香辣酱与时令蔬菜', 990),
    (8, '南洋奶茶', 390),
    (9, '冰柠檬茶', 490),
    (10, '白咖啡', 590),
    (11, '薏米水', 390),
    (12, '椰香西米露', 690),
    (13, '红豆冰', 790),
    (14, '芒果布丁', 890),
    (15, '传统咖椰吐司', 490)
  ) as seed(idx, name, price_cents)
  cross join lateral (
    select case when seed.idx % 4 = 0 then v_store_id || '/items/' || v_item_ids[seed.idx + 1] end
  ) as image(base_path)
  on conflict (id) do update
    set (category_id, name, description, price_cents, image_path, thumb_path, is_sold_out,
         is_hidden, sort_order, deleted_at, name_i18n, description_i18n) =
        (excluded.category_id, excluded.name, excluded.description, excluded.price_cents,
         excluded.image_path, excluded.thumb_path, excluded.is_sold_out, excluded.is_hidden,
         excluded.sort_order, excluded.deleted_at, excluded.name_i18n, excluded.description_i18n)
    where (current_row.category_id, current_row.name, current_row.description,
           current_row.price_cents, current_row.image_path, current_row.thumb_path,
           current_row.is_sold_out, current_row.is_hidden, current_row.sort_order,
           current_row.deleted_at, current_row.name_i18n, current_row.description_i18n)
      is distinct from (excluded.category_id, excluded.name, excluded.description,
                        excluded.price_cents, excluded.image_path, excluded.thumb_path,
                        excluded.is_sold_out, excluded.is_hidden, excluded.sort_order,
                        excluded.deleted_at, excluded.name_i18n, excluded.description_i18n);

  delete from public.items where store_id = v_store_id and not (id = any(v_item_ids));
  delete from public.categories where store_id = v_store_id and not (id = any(v_category_ids));

  insert into public.store_members as current_row (store_id, user_id, role)
  select v_store_id, allowed.user_id, 'owner' from unnest(v_allowed_users) as allowed(user_id)
  on conflict (user_id) do update set role = excluded.role
    where current_row.role is distinct from excluded.role;

  v_result := jsonb_build_object(
    'store_id', v_store_id, 'public_table_id', v_table_ids[1],
    'stores', 1, 'tables', cardinality(v_table_ids), 'categories', cardinality(v_category_ids),
    'items', cardinality(v_item_ids), 'owners', cardinality(v_allowed_users), 'deleted', v_deleted
  );

  insert into public.audit_logs (store_id, actor_type, action, entity, entity_id, details)
  values (v_store_id, 'system', 'demo.reset', 'stores', v_store_id, v_result);

  insert into public.demo_reset_runs (allowed_emails, result, success)
  values (v_allowed_emails, v_result, true);

  return v_result;
end $$;

revoke all on function public.reset_demo_data(text[]) from public, anon, authenticated, customer_api;
grant execute on function public.reset_demo_data(text[]) to service_role;
