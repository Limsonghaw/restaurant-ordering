-- =====================================================================
-- 0004_frontend_alignment.sql  阶段 1 · 回答前端 7 问（更新 8，归入 PR1b，与 0003 一起合并）
-- 不修改 0001 / 0002 / 0003 文件本身；只用 create or replace / alter 追加。
--   H-1 / Q3  停用原因对店家隐藏（rereview-2 的隐藏方案）：stores 改列级 select（不含 status_reason）；
--       audit_logs 店家看不到 actor_type='admin' 的行；blocked_clients 店家读不到 value_hash      【待安全顾问复查】
--   M-3 「自动确认」误开时 INSERT 也擦密码；handle_new_user 只给 provisioned_by='ops' 的账号记 password_set_at
--   L-1 首次验证擦密码时顺手删除该用户已有的会话（纵深防御）
--   (a) 解除拉黑：list_blocked_clients / unblock_client（写审计），拉黑也写审计；收回直接 delete
--   Q1  customer_quote 增加 estimated_total_cents 等（口径：只算这一单）
--   Q2  stores.is_profile_complete（生成列）
--   Q5  orders (store_id, served_at) 部分索引（P5「已上菜」）
--   Q6  bill_access_tokens.revoked_reason 去掉从未使用的 'merchant'
--   Q7  get_my_context()（M1）与 ensure_my_store()（「已登录但没有店铺」的自助修复）；停用拦截触发器放行 stores 的 INSERT
--   前端 v0.6：get_my_context 多返回 password_set_at（第 5 问）；管理员未完成两步验证 → MFA_REQUIRED，
--       不是管理员 → FORBIDDEN（第 16 问，private.assert_platform_admin）；注册不收店名，建店一律「我的餐厅」（L-5，已定）
-- =====================================================================

-- ---------------------------------------------------------------------
-- H-1（rereview-2，= 前端第 3 问）停用原因对店家隐藏：按复查报告的「隐藏方案」，status_reason 留在 stores，
-- 但店家（authenticated）的列级 select 不含它（见下方 ②）；平台管理员经 admin_list_stores / admin_set_store_status
-- （definer）读写，不受影响。
-- admin_list_stores、admin_set_store_status 重定义：权限检查改用 private.assert_platform_admin()（MFA_REQUIRED / FORBIDDEN），
-- admin_list_stores 另多返回 is_profile_complete（Q2）；其余与 0002 相同。
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Q2 资料是否完整：地址、营业时间都填了（去掉首尾空格后非空）。店名必填（CHECK 保证）；Logo 可选。
-- ---------------------------------------------------------------------
alter table public.stores add column is_profile_complete boolean
  generated always as (btrim(address) <> '' and btrim(opening_hours) <> '') stored;

-- ---------------------------------------------------------------------
-- 前端 v0.6 第 16 问：平台管理员的权限检查分两种错误
--   profiles.role = 'platform_admin' 但会话不是 aal2（没做两步验证）→ MFA_REQUIRED（403，前端带去 /admin/mfa）
--   其他人（店家、管理员账号以外）                                   → FORBIDDEN（403）
-- 只告诉调用者自己是不是管理员，不泄露别人的信息。private.is_platform_admin()（RLS 用）不变，仍是 aal2 才为 true。
-- ---------------------------------------------------------------------
create or replace function private.assert_platform_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.is_platform_admin() then return; end if;
  if exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'platform_admin') then
    perform private.raise_app('MFA_REQUIRED', jsonb_build_object('aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1')));
  end if;
  perform private.raise_app('FORBIDDEN');
end $$;
revoke execute on function private.assert_platform_admin() from public, anon, authenticated;

create or replace function public.admin_list_stores(p_status public.store_status default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_platform_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.stores s where p_status is null or s.status = p_status),
    'stores', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select s.id, s.name, s.slug, s.status, s.status_reason, s.status_changed_at, s.created_at, s.is_accepting_orders,
               s.is_profile_complete,
               (select u.email from public.store_members m join auth.users u on u.id = m.user_id
                 where m.store_id = s.id and m.role = 'owner' limit 1) as owner_email,
               (select u.phone from public.store_members m join auth.users u on u.id = m.user_id
                 where m.store_id = s.id and m.role = 'owner' limit 1) as owner_phone,
               (select max(o.created_at) from public.orders o where o.store_id = s.id) as last_order_at
          from public.stores s
         where p_status is null or s.status = p_status
         order by s.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'));
end $$;

-- admin_set_store_status：与 0002 相同，只是权限检查改为 assert_platform_admin（MFA_REQUIRED / FORBIDDEN）
create or replace function public.admin_set_store_status(p_store_id uuid, p_status public.store_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s public.stores;
begin
  perform private.assert_platform_admin();
  if p_store_id is null or p_status is null or char_length(coalesce(p_reason, '')) > 200 then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'status'));
  end if;
  update public.stores set status = p_status, status_reason = nullif(btrim(p_reason), ''), status_changed_at = now()
   where id = p_store_id returning * into v_s;
  if not found then perform private.raise_app('NOT_FOUND'); end if;
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_s.id, (select auth.uid()), 'admin', 'store.status', 'stores', v_s.id, jsonb_build_object('status', p_status, 'reason', p_reason));
  return jsonb_build_object('id', v_s.id, 'status', v_s.status, 'status_reason', v_s.status_reason, 'status_changed_at', v_s.status_changed_at);
end $$;


-- ---------------------------------------------------------------------
-- H-1 ② stores 改列级 select（除 status_reason 外全部列出）：店家读 status_reason 得 42501；
--       以后新加的列默认店家读不到，必须显式授权（M1 也改显式列）
-- ---------------------------------------------------------------------
revoke select on public.stores from authenticated;
grant select (id, slug, name, logo_path, address, opening_hours, is_accepting_orders, status, status_changed_at,
  currency, locale, timezone, service_charge_bp, sst_bp, cash_rounding, require_first_order_approval,
  max_order_cents, require_captcha, is_profile_complete, created_at, updated_at) on public.stores to authenticated;

-- H-1 ③ 审计日志：店家只看本店非平台操作（平台停用 / 启用的记录带原因，只给平台管理员）
drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (private.is_platform_admin()
         or (store_id is not null and actor_type <> 'admin' and private.is_store_member(store_id)));

-- H-1 ④ blocked_clients：店家读不到 value_hash；不再允许直接 delete（解除拉黑一律走 unblock_client，才能写审计）
revoke select, delete on public.blocked_clients from authenticated;
grant select (id, store_id, kind, reason, source_order_id, created_by, created_at, expires_at) on public.blocked_clients to authenticated;
drop policy blocked_clients_delete on public.blocked_clients;

-- ---------------------------------------------------------------------
-- (a) 拉黑名单 / 解除拉黑 / 拉黑写审计
-- ---------------------------------------------------------------------
-- 店铺停用时也能看（只读）；默认只列有效的（expires_at > now()）
create or replace function public.list_blocked_clients(p_include_expired boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid;
begin
  select store_id into v_store from public.store_members where user_id = (select auth.uid());
  if v_store is null then perform private.raise_app('FORBIDDEN'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'reason', b.reason,
      'created_at', b.created_at, 'expires_at', b.expires_at, 'is_active', b.expires_at > now(),
      'source_order', case when o.id is null then null else jsonb_build_object(
          'id', o.id, 'seq_in_bill', o.seq_in_bill, 'table_label', t.label,
          'subtotal_cents', o.subtotal_cents, 'created_at', o.created_at) end)
      order by b.created_at desc)
    from (select * from public.blocked_clients
           where store_id = v_store and (coalesce(p_include_expired, false) or expires_at > now())
           order by created_at desc limit 200) b
    left join public.orders o on o.id = b.source_order_id and o.store_id = b.store_id
    left join public.dining_tables t on t.id = o.table_id and t.store_id = o.store_id), '[]'::jsonb);
end $$;

-- 解除拉黑：本店成员；店铺停用时拒绝（STORE_SUSPENDED，与其他写操作一致）；写审计 client.unblocked
create or replace function public.unblock_client(p_block_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_b public.blocked_clients;
begin
  if p_block_id is null then perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'block_id')); end if;
  select * into v_b from public.blocked_clients where id = p_block_id for update;
  if not found or not private.is_store_member(v_b.store_id) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_b.store_id);
  delete from public.blocked_clients where id = v_b.id;
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_b.store_id, (select auth.uid()), 'user', 'client.unblocked', 'blocked_clients', v_b.id,
          jsonb_build_object('kind', v_b.kind, 'source_order_id', v_b.source_order_id,
                             'blocked_at', v_b.created_at, 'expires_at', v_b.expires_at));
  return jsonb_build_object('id', v_b.id, 'unblocked', true);
end $$;

-- 拉黑：同 0002，另写审计 client.blocked（details 不含哈希）
create or replace function public.block_client_from_order(p_order_id uuid, p_cancel boolean default true,
  p_include_ip boolean default false, p_days integer default 7)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_o public.orders; v_m public.order_client_meta; v_n int := 0; v_cancelled boolean := false;
        v_kinds text[] := '{}'; v_until timestamptz;
begin
  if p_order_id is null or p_days is null or p_days not between 1 and 30 then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'days'));
  end if;
  select * into v_o from public.orders where id = p_order_id;
  if not found or not private.is_store_member(v_o.store_id) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_o.store_id);
  select * into v_m from public.order_client_meta where order_id = v_o.id;
  v_until := now() + make_interval(days => p_days);
  if coalesce(p_cancel, true) and v_o.status in ('new', 'accepted') then
    perform public.update_order_status(v_o.id, 'cancelled', v_o.status, 'other', '恶意下单');
    v_cancelled := true;
  end if;
  if v_m.device_hash is not null then
    insert into public.blocked_clients (store_id, kind, value_hash, reason, source_order_id, created_by, expires_at)
    values (v_o.store_id, 'device', v_m.device_hash, '店家拉黑', v_o.id, (select auth.uid()), v_until)
    on conflict (store_id, kind, value_hash) do update set expires_at = excluded.expires_at;
    v_n := v_n + 1; v_kinds := v_kinds || 'device'::text;
  end if;
  if coalesce(p_include_ip, false) and v_m.ip_hash is not null then
    insert into public.blocked_clients (store_id, kind, value_hash, reason, source_order_id, created_by, expires_at)
    values (v_o.store_id, 'ip', v_m.ip_hash, '店家拉黑', v_o.id, (select auth.uid()), v_until)
    on conflict (store_id, kind, value_hash) do update set expires_at = excluded.expires_at;
    v_n := v_n + 1; v_kinds := v_kinds || 'ip'::text;
  end if;
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_o.store_id, (select auth.uid()), 'user', 'client.blocked', 'orders', v_o.id,
          jsonb_build_object('kinds', to_jsonb(v_kinds), 'days', p_days, 'cancelled', v_cancelled));
  return jsonb_build_object('blocked', v_n, 'cancelled', v_cancelled, 'expires_at', v_until);
end $$;

-- ---------------------------------------------------------------------
-- Q1 C2 预估合计：只算「这一单」（不含同账单其他单）。整单结账时按整张账单重新算，可能差几仙。
-- ---------------------------------------------------------------------
create or replace function public.customer_quote(p_store_id uuid, p_table_id uuid, p_qr_version integer, p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_s public.stores; v_cart jsonb; c record; v_sub bigint; v_over boolean;
begin
  v_s := private.resolve_table(p_store_id, p_table_id, p_qr_version, 'menu');
  v_cart := private.validate_cart(v_s, p_items);
  v_sub := (v_cart ->> 'subtotal_cents')::bigint;
  v_over := v_sub > v_s.max_order_cents or (v_cart ->> 'item_count')::int > 200;
  if not v_over then
    select * into c from private.calc_bill(v_sub::int, v_s.service_charge_bp, v_s.sst_bp, v_s.cash_rounding);
  end if;
  return jsonb_build_object('can_order', v_s.is_accepting_orders and not v_over
            and jsonb_array_length(v_cart -> 'unavailable') = 0,
         'is_accepting_orders', v_s.is_accepting_orders,
         'limit_exceeded', v_over,
         'lines', v_cart -> 'lines', 'subtotal_cents', v_sub,
         'item_count', (v_cart ->> 'item_count')::int,
         'estimate_basis', 'this_order',
         'service_charge_bp', v_s.service_charge_bp, 'sst_bp', v_s.sst_bp,
         'estimated_service_charge_cents', case when v_over then null else c.service_charge_cents end,
         'estimated_sst_cents', case when v_over then null else c.sst_cents end,
         'estimated_rounding_cents', case when v_over then null else c.rounding_cents end,
         'estimated_total_cents', case when v_over then null else c.total_cents end,
         'unavailable', v_cart -> 'unavailable', 'price_changes', v_cart -> 'price_changes',
         'max_order_cents', v_s.max_order_cents);
end $$;

-- ---------------------------------------------------------------------
-- Q5 P5「已上菜」按当天（UTC+8）served_at 查询的索引
-- ---------------------------------------------------------------------
create index orders_store_served_idx on public.orders (store_id, served_at desc) where status = 'served';

-- ---------------------------------------------------------------------
-- Q6 令牌撤销原因：只有 bill_paid（结账）与 qr_rotated（重置二维码）；'merchant' 从未使用，删除
-- ---------------------------------------------------------------------
alter table public.bill_access_tokens drop constraint if exists bill_access_tokens_revoked_reason_check;
alter table public.bill_access_tokens add constraint bill_access_tokens_revoked_reason_check
  check (revoked_reason in ('bill_paid', 'qr_rotated'));

-- ---------------------------------------------------------------------
-- Q7 M1：一次拿到登录状态判断所需的全部字段（显式列，不含停用原因）
-- ---------------------------------------------------------------------
create or replace function public.get_my_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_p public.profiles; v_m public.store_members; v_s public.stores;
begin
  if v_uid is null then perform private.raise_app('UNAUTHENTICATED'); end if;
  select * into v_p from public.profiles where user_id = v_uid;
  select * into v_m from public.store_members where user_id = v_uid;
  if v_m.store_id is not null then select * into v_s from public.stores where id = v_m.store_id; end if;
  return jsonb_build_object(
    'user_id', v_uid,
    'platform_role', v_p.role,                       -- null = 没有 profile
    'aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1'),
    'password_set', v_p.password_set_at is not null,
    'password_set_at', v_p.password_set_at,          -- 前端 v0.6 第 5 问：null = 还没设密码（守卫带去 /set-password）
    'member_role', v_m.role,
    'store', case when v_s.id is null then null else jsonb_build_object(
      'id', v_s.id, 'slug', v_s.slug, 'name', v_s.name, 'logo_path', v_s.logo_path,
      'status', v_s.status, 'status_changed_at', v_s.status_changed_at,
      'is_accepting_orders', v_s.is_accepting_orders, 'is_profile_complete', v_s.is_profile_complete) end);
end $$;

-- Q7 ensure_my_store 以店家身份（jwt role = authenticated）建店：0001 的停用拦截触发器在 stores 的 BEFORE INSERT 时
-- 查不到这行（status 为空）会误报 STORE_SUSPENDED。新建的店一定是 active，放行 stores 的 INSERT；
-- authenticated 对 stores 没有 insert 权限、也没有 insert policy，只有 definer 函数能走到这里。其余逻辑与 0001 相同。
create or replace function private.assert_store_writable() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_status public.store_status; v_row jsonb;
begin
  if private.jwt_role() <> 'authenticated' or private.is_platform_admin() then
    return coalesce(new, old);
  end if;
  if tg_table_name = 'stores' and tg_op = 'INSERT' then
    return new;
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_store := (case when tg_table_name = 'stores' then v_row ->> 'id' else v_row ->> 'store_id' end)::uuid;
  select status into v_status from public.stores where id = v_store;
  if v_status is distinct from 'active' then
    perform private.raise_app('STORE_SUSPENDED', jsonb_build_object('store_id', v_store));
  end if;
  return coalesce(new, old);
end $$;

-- Q7 已验证、已登录却没有店铺时的自助修复（幂等）。管理员账号（no_store / platform_admin）不建店。
create or replace function public.ensure_my_store()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_u record; v_store uuid; v_role public.platform_role; v_name text;
begin
  if v_uid is null then perform private.raise_app('UNAUTHENTICATED'); end if;
  perform pg_advisory_xact_lock(hashtextextended('ensure_my_store:' || v_uid::text, 0));
  select store_id into v_store from public.store_members where user_id = v_uid;
  if v_store is not null then return jsonb_build_object('store_id', v_store, 'created', false); end if;
  select u.email_confirmed_at, u.phone_confirmed_at, u.is_anonymous, u.raw_user_meta_data, u.raw_app_meta_data
    into v_u from auth.users u where u.id = v_uid;
  if not found then perform private.raise_app('UNAUTHENTICATED'); end if;
  if coalesce(v_u.is_anonymous, false) or (v_u.email_confirmed_at is null and v_u.phone_confirmed_at is null) then
    perform private.raise_app('FORBIDDEN', jsonb_build_object('reason', 'not_verified'));
  end if;
  insert into public.profiles (user_id, signup_channel)
    values (v_uid, case when v_u.email_confirmed_at is not null then 'email' else 'phone' end)
    on conflict (user_id) do nothing;
  select role into v_role from public.profiles where user_id = v_uid;
  if v_role = 'platform_admin' or coalesce(v_u.raw_app_meta_data ->> 'no_store', '') = 'true' then
    return jsonb_build_object('store_id', null, 'created', false, 'reason', 'no_store_account');
  end if;
  v_name := '我的餐厅';   -- L-5（已定）：注册不收店名，不采用未验证期间写入的 user_metadata.store_name；店家登录后在 P9 改
  insert into public.stores (slug, name)
    values ('s-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), v_name)
    returning id into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store, v_uid, 'owner');
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_store, v_uid, 'system', 'store.ensured', 'stores', v_store, '{}'::jsonb);
  return jsonb_build_object('store_id', v_store, 'created', true);
end $$;

-- ---------------------------------------------------------------------
-- M-3（rereview-2）「自动确认」（mailer_autoconfirm / sms_autoconfirm）被误开时，INSERT 当下就已验证，
-- 0003 的 UPDATE 擦除触发器不会触发，抢注者自带的密码会保留。这里在 INSERT 时同样擦除；
-- 只放行运维脚本建的账号（raw_app_meta_data.provisioned_by = 'ops'，只有 admin API / service role 能写）。
-- 普通（非 definer）触发器函数：只改 NEW。
-- ---------------------------------------------------------------------
create or replace function private.auth_wipe_password_on_confirmed_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(new.raw_app_meta_data ->> 'provisioned_by', '') <> 'ops' then
    new.encrypted_password := '';
  end if;
  return new;
end $$;
drop trigger if exists auth_wipe_password_on_confirmed_insert on auth.users;
create trigger auth_wipe_password_on_confirmed_insert before insert on auth.users
  for each row when (new.email_confirmed_at is not null or new.phone_confirmed_at is not null)
  execute function private.auth_wipe_password_on_confirmed_insert();

-- M-3 handle_new_user：INSERT 时已验证且带密码，只有 provisioned_by = 'ops' 才记 password_set_at；
-- L-5：店名一律「我的餐厅」（不读 raw_user_meta_data.store_name）；其余与 0003 相同
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_name text; v_uid uuid; v_j jsonb := to_jsonb(new);
begin
  if coalesce((v_j ->> 'is_anonymous')::boolean, false) then
    return new;                                   -- 匿名用户不建店
  end if;
  if new.email_confirmed_at is null and new.phone_confirmed_at is null then
    return new;                                   -- 未验证：不建店
  end if;
  insert into public.profiles (user_id, signup_channel, password_set_at)
    values (new.id, case when new.email_confirmed_at is not null then 'email' else 'phone' end,
            case when tg_op = 'INSERT' and coalesce(v_j ->> 'encrypted_password', '') <> ''
                      and coalesce(v_j -> 'raw_app_meta_data' ->> 'provisioned_by', '') = 'ops' then now() end)
    on conflict (user_id) do nothing
    returning user_id into v_uid;
  if v_uid is null then
    return new;                                   -- 已建过：幂等跳过
  end if;
  if coalesce(v_j -> 'raw_app_meta_data' ->> 'no_store', '') = 'true' then
    return new;                                   -- 管理员等不需要店铺的账号（L-N1）
  end if;
  v_name := '我的餐厅';   -- L-5（已定）：注册不收店名，未验证期间写入的 store_name 一律不用
  insert into public.stores (slug, name)
    values ('s-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), v_name)
    returning id into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store, new.id, 'owner');
  return new;
end $$;

-- ---------------------------------------------------------------------
-- L-1（rereview-2，纵深防御）首次验证擦密码时，顺手删除这个用户已有的会话。
-- 正常情况下未验证账号拿不到会话（enable_confirmations = true），这里只是兜底。
-- 触发器以 supabase_auth_admin（auth.sessions 的属主）身份执行；BEFORE UPDATE 里删除，
-- GoTrue 随后在同一事务里新建的会话不受影响（上线前在真实项目确认，清单第 15 项）。
-- ---------------------------------------------------------------------
create or replace function private.auth_wipe_password_on_first_confirm() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.encrypted_password := '';
  delete from auth.sessions where user_id = new.id;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 授权：新函数只给 authenticated（customer_api / anon 不给）
-- ---------------------------------------------------------------------
revoke execute on function public.list_blocked_clients(boolean), public.unblock_client(uuid),
  public.get_my_context(), public.ensure_my_store() from public, anon;
grant execute on function public.list_blocked_clients(boolean), public.unblock_client(uuid),
  public.get_my_context(), public.ensure_my_store() to authenticated;
