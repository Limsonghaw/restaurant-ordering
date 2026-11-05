-- =====================================================================
-- 0003_security_rereview.sql  第二轮安全复查修订（PR1b，在 PR1 合并之后、PR2/PR3 之前）
-- 依据：/workspace/security-reviews/restaurant-ordering-design-rereview-1.md
-- 不改 0001 / 0002 的任何一行：需要改的函数在这里 create or replace（保留原有授权），新对象显式授权。
--   H-N1  先验证、后设密码：首次验证时清空注册时带的密码；profiles.password_set_at；清理 24 小时未验证账号（pg_cron 每小时）
--   H-N2  customer_api 改为数据库登录角色（经 Supavisor 直连），不再经 PostgREST / JWT
--   M-N1  Before User Created Hook：Auth 服务端的号码白名单（只收马来西亚手机号）
--   M-N3  同店同 IP：20 单 / 10 分钟起要求 Turnstile，100 单才硬拒绝
--   L-N1  平台管理员必须 aal2（MFA）；app_metadata.no_store = true 的账号不建店
--   L-N3  orders.device_seq_in_bill：账单内「设备 #n」
--   L9    resolve_table 的 order 模式对 stores 加 for share
-- 密码不写进迁移：customer_api 的密码上线前在 SQL Editor 手工执行 alter role（见 implementation-plan PR1b）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- H-N1 ① profiles.password_set_at：用户第一次在已验证的会话里设好密码的时间；为空 → middleware 强制去 /set-password
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists password_set_at timestamptz;

-- ---------------------------------------------------------------------
-- H-N1 ② 首次验证时清空密码（数据库兜底，堵「预先抢注」）
-- 攻击者先用受害人的邮箱/手机号直连 GoTrue 注册并带上自己的密码；受害人完成验证的那一次 UPDATE，
-- 不管 GoTrue 有没有覆盖密码，这里都把密码清空。之后只能在已验证的会话里经 A6 设置新密码。
-- 条件：验证前两个 confirmed_at 都为空，验证后任一非空。已验证过的账号（改邮箱、补验证手机）不受影响。
-- 普通（非 definer）触发器函数：只改 NEW，不访问其他对象，以 supabase_auth_admin 身份执行也没问题（L-N7 已测）。
-- ---------------------------------------------------------------------
create or replace function private.auth_wipe_password_on_first_confirm() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.encrypted_password := '';
  return new;
end $$;
drop trigger if exists auth_wipe_password_on_first_confirm on auth.users;
create trigger auth_wipe_password_on_first_confirm before update on auth.users
  for each row
  when (old.email_confirmed_at is null and old.phone_confirmed_at is null
        and (new.email_confirmed_at is not null or new.phone_confirmed_at is not null))
  execute function private.auth_wipe_password_on_first_confirm();

-- H-N1 ③ 已验证账号设了非空密码 → 记录 password_set_at（只记第一次）
create or replace function private.mark_password_set() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set password_set_at = coalesce(password_set_at, now()), updated_at = now()
   where user_id = new.id and password_set_at is null;
  return new;
end $$;
drop trigger if exists on_auth_user_password_set on auth.users;
create trigger on_auth_user_password_set after update of encrypted_password on auth.users
  for each row
  when (coalesce(new.encrypted_password, '') <> ''
        and new.encrypted_password is distinct from old.encrypted_password
        and (new.email_confirmed_at is not null or new.phone_confirmed_at is not null))
  execute function private.mark_password_set();

-- ---------------------------------------------------------------------
-- L-N1 + H-N1：handle_new_user 重新定义（触发器定义不变，沿用 0001 的两个 trigger）
--  · raw_app_meta_data.no_store = true（只有 admin API / service role 能写）→ 只建 profile，不建店（平台管理员账号）
--  · raw_user_meta_data 是用户自己能填的，不认它的 no_store
--  · 插入时就已验证（admin API 建号、email_confirm=true）且带密码 → password_set_at = now()
-- ---------------------------------------------------------------------
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
            case when tg_op = 'INSERT' and coalesce(v_j ->> 'encrypted_password', '') <> '' then now() end)
    on conflict (user_id) do nothing
    returning user_id into v_uid;
  if v_uid is null then
    return new;                                   -- 已建过：幂等跳过
  end if;
  if coalesce(v_j -> 'raw_app_meta_data' ->> 'no_store', '') = 'true' then
    return new;                                   -- 管理员等不需要店铺的账号（L-N1）
  end if;
  v_name := left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'store_name'), ''), '我的餐厅'), 50);
  insert into public.stores (slug, name)
    values ('s-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), v_name)
    returning id into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store, new.id, 'owner');
  return new;
end $$;

-- ---------------------------------------------------------------------
-- H-N1 ④ 清理超过 24 小时仍未验证的账号（pg_cron 每小时第 17 分钟）
-- 24 小时：邮件链接 15 分钟、短信验证码 10 分钟过期，用户当天回来还能重发；超过一天视为放弃或抢注。
-- 未验证账号没有 profile / 店铺 / 订单，删除只会级联 GoTrue 自己的 identities、sessions 等表。
-- ---------------------------------------------------------------------
create or replace function private.purge_unverified_users() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from auth.users u
   where u.email_confirmed_at is null and u.phone_confirmed_at is null
     and u.created_at < now() - interval '24 hours';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

do $$ begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron 不可用（本地 PGlite）：跳过定时任务，生产环境由 pgTAP 断言 cron.job 存在';
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-unverified-users', '17 * * * *', 'select private.purge_unverified_users()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- M-N1 Before User Created Hook：GoTrue 建任何用户之前都会调用（包括有人拿 publishable key 直连 /signup、/otp）
-- 手机号只收马来西亚手机号 601xxxxxxxx(x)；auth.users.phone 不带 +，这里两种都接受。
-- 在 config.toml [auth.hook.before_user_created] / Dashboard Authentication → Hooks 启用。
-- ---------------------------------------------------------------------
create or replace function private.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_phone text := nullif(ltrim(coalesce(event -> 'user' ->> 'phone', ''), '+'), '');
begin
  if v_phone is not null and v_phone !~ '^601[0-9]{8,9}$' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 400, 'message', 'PHONE_NOT_SUPPORTED'));
  end if;
  return '{}'::jsonb;
end $$;

-- ---------------------------------------------------------------------
-- M-N3 + L-N3：customer_place_order 重新定义（签名不变，授权沿用 0002：只有 customer_api）
--  第 5 步：同店同 IP 10 分钟 ≥100 单 → RATE_LIMITED；≥20 单且没过 Turnstile → CAPTCHA_REQUIRED（scope=ip_db）
--  第 9 步：device_seq_in_bill = 本设备在这张账单上已有的编号，否则 max + 1（账单行已 for update，串行）
-- ---------------------------------------------------------------------
alter table public.orders add column if not exists device_seq_in_bill smallint
  check (device_seq_in_bill is null or device_seq_in_bill >= 1);

create or replace function public.customer_place_order(
  p_store_id uuid, p_table_id uuid, p_qr_version integer,
  p_request_id uuid, p_request_hash text, p_items jsonb,
  p_device_hash text, p_ip_hash text,
  p_bill_token_hash text, p_new_bill_token_hash text,
  p_captcha_verified boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s public.stores; v_cart jsonb; v_existing public.orders; v_meta public.order_client_meta;
  v_bill public.bills; v_order public.orders; v_tok public.bill_access_tokens;
  v_recent int; v_token_issued boolean := false; v_line jsonb; v_dev_seq smallint;
begin
  -- 0. 入参
  if p_request_id is null or not private.is_hex64(p_request_hash) or not private.is_hex64(p_device_hash)
     or not private.is_hex64(p_ip_hash) or not private.is_hex64(p_new_bill_token_hash)
     or (p_bill_token_hash is not null and not private.is_hex64(p_bill_token_hash)) then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'client_context'));
  end if;

  -- 1. 桌子加锁 + 店铺状态（L9：店铺行 for share）
  v_s := private.resolve_table(p_store_id, p_table_id, p_qr_version, 'order');

  -- 2. 幂等
  select * into v_existing from public.orders where store_id = p_store_id and request_id = p_request_id;
  if found then
    select * into v_meta from public.order_client_meta where order_id = v_existing.id;
    if v_meta.request_hash is distinct from p_request_hash then
      perform private.raise_app('IDEMPOTENCY_KEY_REUSED');
    end if;
    select * into v_tok from public.bill_access_tokens where id = v_meta.bill_token_id;
    if found and v_tok.device_hash = p_device_hash and v_tok.revoked_at is null and v_tok.expires_at > now()
       and v_tok.token_hash is distinct from p_bill_token_hash then
      update public.bill_access_tokens set token_hash = p_new_bill_token_hash where id = v_tok.id;
      v_token_issued := true;
    end if;
    select * into v_bill from public.bills where id = v_existing.bill_id;
    return jsonb_build_object('replayed', true, 'bill_token_issued', v_token_issued,
      'order', private.customer_order_json(v_existing),
      'bill', jsonb_build_object('id', v_bill.id, 'status', v_bill.status));
  end if;

  -- 3. 店铺强制验证码
  if v_s.require_captcha and p_captcha_verified is not true then
    perform private.raise_app('CAPTCHA_REQUIRED');
  end if;

  -- 4. 拉黑
  if exists (select 1 from public.blocked_clients b where b.store_id = p_store_id and b.expires_at > now()
               and ((b.kind = 'device' and b.value_hash = p_device_hash) or (b.kind = 'ip' and b.value_hash = p_ip_hash))) then
    perform private.raise_app('DEVICE_BLOCKED');
  end if;

  -- 5. 数据库兜底限流（10 分钟）：同桌 10 单；同店同设备 10 单；同店同 IP 20 单起要验证码、100 单硬拒绝（M-N3）
  select count(*) into v_recent from public.orders
   where table_id = p_table_id and created_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    perform private.raise_app('RATE_LIMITED', jsonb_build_object('scope', 'table_db', 'retry_after_seconds', 120));
  end if;
  select count(*) into v_recent from public.order_client_meta
   where store_id = p_store_id and ip_hash = p_ip_hash and created_at > now() - interval '10 minutes';
  if v_recent >= 100 then
    perform private.raise_app('RATE_LIMITED', jsonb_build_object('scope', 'ip_db', 'retry_after_seconds', 120));
  elsif v_recent >= 20 and p_captcha_verified is not true then
    perform private.raise_app('CAPTCHA_REQUIRED', jsonb_build_object('scope', 'ip_db'));
  end if;
  select count(*) into v_recent from public.order_client_meta
   where store_id = p_store_id and device_hash = p_device_hash and created_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    perform private.raise_app('RATE_LIMITED', jsonb_build_object('scope', 'device_db', 'retry_after_seconds', 120));
  end if;

  -- 6. 菜品与价格
  v_cart := private.validate_cart(v_s, p_items);
  perform private.assert_cart_ok(v_s, v_cart);

  -- 7. 取或开账单
  select * into v_bill from public.bills where table_id = p_table_id and status = 'open' for update;
  if not found then
    insert into public.bills (store_id, table_id) values (p_store_id, p_table_id) returning * into v_bill;
  end if;
  if (select count(*) from public.orders where bill_id = v_bill.id) >= 60 then
    perform private.raise_app('ORDER_LIMIT_EXCEEDED', jsonb_build_object('max_orders_per_bill', 60));
  end if;

  -- 8. 账单令牌
  select * into v_tok from public.bill_access_tokens
   where token_hash = p_bill_token_hash and bill_id = v_bill.id and device_hash = p_device_hash
     and revoked_at is null and expires_at > now();
  if not found then
    insert into public.bill_access_tokens (bill_id, store_id, token_hash, device_hash, scope)
    values (v_bill.id, p_store_id, p_new_bill_token_hash, p_device_hash, 'own_orders') returning * into v_tok;
    v_token_issued := true;
  end if;

  -- 9. 写订单（L-N3：账单内设备编号）+ 指纹 + 明细
  select o.device_seq_in_bill into v_dev_seq
    from public.orders o join public.order_client_meta m on m.order_id = o.id
   where o.bill_id = v_bill.id and m.device_hash = p_device_hash and o.device_seq_in_bill is not null
   order by o.seq_in_bill limit 1;
  if v_dev_seq is null then
    select coalesce(max(o.device_seq_in_bill), 0) + 1 into v_dev_seq from public.orders o where o.bill_id = v_bill.id;
  end if;
  insert into public.orders (store_id, table_id, bill_id, seq_in_bill, subtotal_cents, item_count, request_id, device_seq_in_bill)
  values (p_store_id, p_table_id, v_bill.id,
          coalesce((select max(seq_in_bill) from public.orders where bill_id = v_bill.id), 0) + 1,
          (v_cart ->> 'subtotal_cents')::int, (v_cart ->> 'item_count')::int, p_request_id, v_dev_seq)
  returning * into v_order;
  insert into public.order_client_meta (order_id, store_id, request_hash, device_hash, ip_hash, bill_token_id)
  values (v_order.id, p_store_id, p_request_hash, p_device_hash, p_ip_hash, v_tok.id);

  for v_line in select * from jsonb_array_elements(v_cart -> 'lines') loop
    insert into public.order_items (order_id, store_id, item_id, line_no, item_name, unit_price_cents, quantity, note)
    values (v_order.id, p_store_id, (v_line ->> 'item_id')::uuid, (v_line ->> 'line_no')::smallint,
            v_line ->> 'item_name', (v_line ->> 'unit_price_cents')::int, (v_line ->> 'quantity')::int, v_line ->> 'note');
  end loop;

  select * into v_bill from public.bills where id = v_bill.id;
  return jsonb_build_object('replayed', false, 'bill_token_issued', v_token_issued,
    'order', private.customer_order_json(v_order),
    'bill', jsonb_build_object('id', v_bill.id, 'status', v_bill.status));
end $$;

-- ---------------------------------------------------------------------
-- L9：resolve_table 的 order 模式对店铺行加 for share，平台停用与在途下单互斥
-- ---------------------------------------------------------------------
create or replace function private.resolve_table(p_store_id uuid, p_table_id uuid, p_qr_version integer, p_mode text)
returns public.stores language plpgsql security definer set search_path = '' as $$
declare v_t public.dining_tables; v_s public.stores;
begin
  if p_store_id is null or p_table_id is null or p_qr_version is null
     or p_mode is null or p_mode not in ('menu', 'order', 'bill') then
    perform private.raise_app('TABLE_INVALID');
  end if;
  if p_mode = 'order' then
    select * into v_t from public.dining_tables where id = p_table_id for update;
  else
    select * into v_t from public.dining_tables where id = p_table_id;
  end if;
  if not found or v_t.store_id is distinct from p_store_id or v_t.deleted_at is not null
     or v_t.qr_version is distinct from p_qr_version or (p_mode <> 'bill' and v_t.is_active is not true) then
    perform private.raise_app('TABLE_INVALID');
  end if;
  if p_mode = 'order' then
    select * into v_s from public.stores where id = p_store_id for share;   -- L9
  else
    select * into v_s from public.stores where id = p_store_id;
  end if;
  if not found or v_s.status is distinct from 'active' then
    perform private.raise_app('STORE_SUSPENDED');
  end if;
  if p_mode = 'order' and v_s.is_accepting_orders is not true then
    perform private.raise_app('STORE_CLOSED');
  end if;
  return v_s;
end $$;

-- ---------------------------------------------------------------------
-- L-N1：平台管理员必须完成 MFA（JWT aal = aal2）
-- RLS 策略、admin_* RPC 都经过这个函数，所以 aal1 的管理员会话看不到全部店铺、也调不了 admin RPC。
-- ---------------------------------------------------------------------
create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
     and exists (select 1 from public.profiles p
                 where p.user_id = (select auth.uid()) and p.role = 'platform_admin')
$$;

-- ---------------------------------------------------------------------
-- H-N2：customer_api 改为数据库登录角色（最小权限）
--  · 只能执行 4 个 customer_*（0002 已授权），没有任何表权限；不再授予 authenticator，PostgREST 切换不到它
--  · 连接：Supavisor 共享池 transaction 模式 6543 端口，用户名 customer_api.<project-ref>
--  · 密码不在迁移里（rereview-2 L-7）：上线前用 psql 连上后执行 \password customer_api（只发送 SCRAM 校验值），不要在 SQL Editor 里写明文
-- ---------------------------------------------------------------------
alter role customer_api with login noinherit connection limit 20;
alter role customer_api set statement_timeout = '3s';
alter role customer_api set idle_in_transaction_session_timeout = '5s';
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticator')
     and pg_has_role('authenticator', 'customer_api', 'member') then
    revoke customer_api from authenticator;
  end if;
end $$;
revoke create on schema public from customer_api;
revoke all on schema private from customer_api;

-- ---------------------------------------------------------------------
-- 授权：新函数不给 public / anon / authenticated / service_role / customer_api；hook 只给 supabase_auth_admin
-- （create or replace 的函数保留 0002 的授权：is_platform_admin → authenticated；customer_place_order → customer_api）
-- ---------------------------------------------------------------------
revoke execute on function private.auth_wipe_password_on_first_confirm(), private.mark_password_set(),
  private.purge_unverified_users(), private.hook_before_user_created(jsonb)
  from public, anon, authenticated, service_role, customer_api;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema private to supabase_auth_admin;
    grant execute on function private.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;
