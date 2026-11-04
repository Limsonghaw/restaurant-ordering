-- =====================================================================
-- 0001_init.sql  餐厅扫码点餐平台 · 阶段 1 · 表结构 / 约束 / 触发器 / RLS / Storage / Realtime
-- 目标：Supabase (PostgreSQL 15+)。金额一律整数分 (cents, MYR)。时间 timestamptz，按 Asia/Kuala_Lumpur 统计。
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

-- 【安全审查 H2】函数默认 EXECUTE：只有不带 IN SCHEMA 的全局默认才能去掉 PUBLIC EXECUTE
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from anon, authenticated;
-- 【安全审查 M1】Supabase 平台默认把 public 新建的表/序列 grant all 给 anon、authenticated，这里撤销，
-- 以后 PR 新建的表/视图默认对 anon、authenticated 零权限，必须显式授权
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------
create type public.store_status  as enum ('pending_review', 'active', 'suspended');
create type public.platform_role as enum ('merchant', 'platform_admin');
create type public.member_role   as enum ('owner', 'staff');          -- staff 预留给 F17 (V2)
create type public.order_status  as enum ('new', 'accepted', 'served', 'cancelled');
create type public.bill_status   as enum ('open', 'paid');
create type public.cancel_reason as enum ('sold_out', 'customer_request', 'duplicate', 'other');
create type public.block_kind    as enum ('device', 'ip');

-- ---------------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------------
create table public.stores (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  name                text not null check (char_length(name) between 1 and 50),
  logo_path           text check (char_length(logo_path) <= 300),   -- 【L5】格式约束见表后 stores_logo_path_ck
  address             text not null default '' check (char_length(address) <= 200),
  opening_hours       text not null default '' check (char_length(opening_hours) <= 200),  -- 只作显示
  is_accepting_orders boolean not null default true,                 -- 店家「营业中」开关
  status              public.store_status not null default 'active', -- 平台启用/停用
  status_reason       text check (char_length(status_reason) <= 200),
  status_changed_at   timestamptz,
  currency            char(3) not null default 'MYR' check (currency = 'MYR'),
  locale              text not null default 'zh-Hans',
  timezone            text not null default 'Asia/Kuala_Lumpur',
  service_charge_bp   integer not null default 0 check (service_charge_bp between 0 and 2000), -- 店家自设；基点 1000 = 10%
  sst_bp              integer not null default 0 check (sst_bp between 0 and 1000),            -- 店家自设；600 = 6%，对「小计+服务费」征收
  cash_rounding       boolean not null default false check (cash_rounding = false),          -- 5 仙进位：第一版不做，字段预留、固定 false
  -- 【H1 已定】首单审核：店家开关，默认关。v1 只建字段、不实现逻辑和界面，故 CHECK 锁死为 false 且不授予 update。
  -- 将来开启后：新桌会话（该桌无 open 账单）的首单、以及已有 open 账单时新设备的首单进入「待审核」，
  -- 店家确认后才进厨房/计入账单，拒绝则取消。实现时删除此 CHECK、加列级 update 授权、加 order_status 'pending_approval'。
  require_first_order_approval boolean not null default false
    constraint stores_first_order_approval_v1_ck check (require_first_order_approval = false),
  max_order_cents     integer not null default 300000 check (max_order_cents between 100 and 10000000),
  require_captcha     boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint stores_logo_path_ck check (logo_path is null
    or logo_path ~ ('^' || id::text || '/logo/[0-9a-f-]{36}\.(webp|jpe?g|png)$'))
);

create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       public.platform_role not null default 'merchant',
  signup_channel text not null default 'email' check (signup_channel in ('email', 'phone')),  -- 首次验证通过的渠道
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.store_members (
  store_id   uuid not null references public.stores (id) on delete restrict,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.member_role not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (store_id, user_id),
  unique (user_id)                                  -- MVP：一个账号只属于一家店
);

create table public.dining_tables (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete restrict,
  label       text not null check (char_length(label) between 1 and 20),
  is_active   boolean not null default true,
  qr_version  integer not null default 1 check (qr_version between 1 and 65535),  -- 二维码签名里的版本号（uint16）；rotate_table_qr +1 即作废旧码
  sort_order  integer not null default 0,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, store_id)
);
create unique index dining_tables_store_label_uq on public.dining_tables (store_id, lower(label)) where deleted_at is null;

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete restrict,
  name        text not null check (char_length(name) between 1 and 30),
  sort_order  integer not null default 0,
  is_hidden   boolean not null default false,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, store_id)
);
create index categories_store_sort_idx on public.categories (store_id, sort_order) where deleted_at is null;

create table public.items (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores (id) on delete restrict,
  category_id      uuid not null,
  name             text not null check (char_length(name) between 1 and 40),
  description      text not null default '' check (char_length(description) <= 300),
  price_cents      integer not null check (price_cents between 0 and 999999),
  image_path       text check (char_length(image_path) <= 300),
  thumb_path       text check (char_length(thumb_path) <= 300),
  is_sold_out      boolean not null default false,
  is_hidden        boolean not null default false,
  sort_order       integer not null default 0,
  deleted_at       timestamptz,
  name_i18n        jsonb not null default '{}'::jsonb,   -- 预留 F14
  description_i18n jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, store_id),
  foreign key (category_id, store_id) references public.categories (id, store_id) on delete restrict,
  -- 【L5】图片路径只能指向本店目录，文件名为 uuid（缩略图带 _thumb）
  constraint items_image_path_ck check (image_path is null
    or image_path ~ ('^' || store_id::text || '/items/[0-9a-f-]{36}\.(webp|jpe?g|png)$')),
  constraint items_thumb_path_ck check (thumb_path is null
    or thumb_path ~ ('^' || store_id::text || '/items/[0-9a-f-]{36}_thumb\.(webp|jpe?g|png)$'))
);
create index items_store_cat_sort_idx on public.items (store_id, category_id, sort_order) where deleted_at is null;

create table public.bills (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores (id) on delete restrict,
  table_id             uuid not null,
  status               public.bill_status not null default 'open',
  opened_at            timestamptz not null default now(),
  paid_at              timestamptz,
  paid_by              uuid references auth.users (id) on delete set null,
  subtotal_cents       integer not null default 0 check (subtotal_cents >= 0), -- 未取消订单合计（触发器维护）
  -- 以下为结清时快照；open 时为 null，读取时按店铺当前费率实时计算
  service_charge_bp    integer,
  service_charge_cents integer,
  sst_bp               integer,
  sst_cents            integer,
  rounding_cents       integer,
  total_cents          integer,
  currency             char(3) not null default 'MYR',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, store_id),
  constraint bills_id_table_uq unique (id, table_id),              -- 【L2】供 orders (bill_id, table_id) 复合外键
  foreign key (table_id, store_id) references public.dining_tables (id, store_id) on delete restrict,
  check (
    (status = 'open' and paid_at is null and total_cents is null)
    or (status = 'paid' and paid_at is not null and total_cents is not null
        and service_charge_cents is not null and sst_cents is not null and rounding_cents is not null
        and total_cents = subtotal_cents + service_charge_cents + sst_cents + rounding_cents)
  )
);
create unique index bills_one_open_per_table_uq on public.bills (table_id) where status = 'open';
create index bills_store_paid_at_idx on public.bills (store_id, paid_at) where status = 'paid';
create index bills_store_status_opened_idx on public.bills (store_id, status, opened_at desc);
create index bills_store_updated_idx on public.bills (store_id, updated_at);

create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores (id) on delete restrict,
  table_id           uuid not null,
  bill_id            uuid not null,
  seq_in_bill        integer not null check (seq_in_bill >= 1),           -- 「第 N 单」
  status             public.order_status not null default 'new',
  subtotal_cents     integer not null check (subtotal_cents >= 0),
  item_count         integer not null check (item_count between 1 and 200),
  request_id         uuid not null,                                     -- 幂等键（request_hash 与设备/IP 哈希在 order_client_meta，【L6】）
  cancel_reason      public.cancel_reason,
  cancel_note        text check (char_length(cancel_note) <= 100),
  cancelled_by       uuid references auth.users (id) on delete set null,
  accepted_at        timestamptz,
  served_at          timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, store_id),
  unique (store_id, request_id),
  unique (bill_id, seq_in_bill),
  foreign key (bill_id, store_id)  references public.bills (id, store_id) on delete restrict,
  foreign key (table_id, store_id) references public.dining_tables (id, store_id) on delete restrict,
  constraint orders_bill_table_fk foreign key (bill_id, table_id) references public.bills (id, table_id) on delete restrict, -- 【L2】订单与账单同桌
  check ((status = 'cancelled') = (cancel_reason is not null)),
  check (cancel_note is null or cancel_reason is not null)
);
create index orders_store_updated_idx on public.orders (store_id, updated_at);
create index orders_store_created_idx on public.orders (store_id, created_at);
create index orders_bill_idx on public.orders (bill_id);
create index orders_table_created_idx on public.orders (table_id, created_at);
create index orders_store_active_idx on public.orders (store_id, status) where status in ('new', 'accepted');

create table public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null,
  store_id         uuid not null,
  item_id          uuid not null,
  line_no          smallint not null check (line_no between 1 and 30),
  item_name        text not null check (char_length(item_name) between 1 and 40),  -- 快照
  unit_price_cents integer not null check (unit_price_cents between 0 and 999999), -- 快照
  quantity         integer not null check (quantity between 1 and 99),
  line_total_cents integer generated always as (unit_price_cents * quantity) stored,
  note             text not null default '' check (char_length(note) <= 50),
  created_at       timestamptz not null default now(),
  unique (order_id, line_no),
  foreign key (order_id, store_id) references public.orders (id, store_id) on delete restrict,
  foreign key (item_id, store_id)  references public.items (id, store_id) on delete restrict
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_item_idx on public.order_items (item_id);

create table public.bill_access_tokens (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null,
  store_id     uuid not null,
  token_hash   text not null unique check (char_length(token_hash) = 64), -- sha256(token) hex，明文不入库；明文由 CSPRNG 生成
  device_hash  text not null check (char_length(device_hash) = 64),        -- 【M4/H1】令牌绑定签发设备
  scope        text not null default 'own_orders' check (scope in ('own_orders', 'bill')), -- 【H1】v1 只签 own_orders；'bill' 留给首单确认/加入码
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '12 hours',
  revoked_at   timestamptz,                                                -- 【M4】结账 / 轮换桌码时撤销
  revoked_reason text check (revoked_reason in ('bill_paid', 'qr_rotated', 'merchant')),
  last_used_at timestamptz,
  foreign key (bill_id, store_id) references public.bills (id, store_id) on delete cascade,
  check ((revoked_at is null) = (revoked_reason is null))
);
create index bill_access_tokens_bill_idx on public.bill_access_tokens (bill_id);

-- 【L6】顾客指纹与幂等哈希单独存放：authenticated 无任何授权，不进 Realtime；只有 definer 函数可读
create table public.order_client_meta (
  order_id      uuid primary key,
  store_id      uuid not null,
  request_hash  text not null check (char_length(request_hash) = 64),
  device_hash   text check (char_length(device_hash) = 64),   -- HMAC(secret, store_id:device_id)，30 天后置空
  ip_hash       text check (char_length(ip_hash) = 64),       -- HMAC(secret, store_id:ip)，30 天后置空
  bill_token_id uuid references public.bill_access_tokens (id) on delete set null,  -- 【H1】令牌只看本设备的订单
  created_at    timestamptz not null default now(),
  foreign key (order_id, store_id) references public.orders (id, store_id) on delete cascade
);
create index order_client_meta_ip_idx     on public.order_client_meta (store_id, ip_hash, created_at);
create index order_client_meta_device_idx on public.order_client_meta (store_id, device_hash, created_at);
create index order_client_meta_token_idx  on public.order_client_meta (bill_token_id);

create table public.blocked_clients (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id) on delete restrict,
  kind            public.block_kind not null,
  value_hash      text not null check (char_length(value_hash) = 64),
  reason          text not null default '' check (char_length(reason) <= 100),
  source_order_id uuid,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '7 days',
  unique (store_id, kind, value_hash),
  -- 【L2】来源订单必须是本店订单
  constraint blocked_clients_source_order_fk foreign key (source_order_id, store_id)
    references public.orders (id, store_id) on delete set null (source_order_id)
);

create table public.audit_logs (
  id            bigint generated always as identity primary key,
  store_id      uuid references public.stores (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_type    text not null check (actor_type in ('user', 'admin', 'customer', 'system')),
  action        text not null check (char_length(action) <= 60),
  entity        text not null check (char_length(entity) <= 40),
  entity_id     uuid,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_logs_store_created_idx on public.audit_logs (store_id, created_at desc);
create index audit_logs_action_created_idx on public.audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------
-- 辅助函数（private schema，不经 PostgREST 暴露）
-- ---------------------------------------------------------------------
create or replace function private.raise_app(p_code text, p_details jsonb default '{}'::jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = p_details::text;
end $$;

create or replace function private.jwt_role() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
$$;

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
                 where p.user_id = (select auth.uid()) and p.role = 'platform_admin')
$$;

create or replace function private.is_store_member(p_store_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.store_members m
                 where m.store_id = p_store_id and m.user_id = (select auth.uid()))
$$;

create or replace function private.can_write_store(p_store_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.store_members m join public.stores s on s.id = m.store_id
                 where m.store_id = p_store_id and m.user_id = (select auth.uid()) and s.status = 'active')
$$;

create or replace function private.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin return p::uuid; exception when others then return null; end $$;

-- 四舍五入（half-up）整数除法，n >= 0
create or replace function private.div_round(n bigint, d integer) returns integer
language sql immutable set search_path = '' as $$ select ((2 * n + d) / (2 * d))::integer $$;

-- 账单金额计算（唯一实现：实时计算、quote、结清快照共用）
-- 服务费 = round(subtotal × sc_bp / 10000)；SST = round((subtotal + 服务费) × sst_bp / 10000)
-- cash_rounding：第一版不做（stores 约束固定 false，rounding_cents 恒为 0）；参数与算法保留给以后启用
create or replace function private.calc_bill(p_subtotal integer, p_sc_bp integer, p_sst_bp integer, p_cash_rounding boolean,
  out service_charge_cents integer, out sst_cents integer, out rounding_cents integer, out total_cents integer)
language plpgsql immutable set search_path = '' as $$
declare v_raw integer;
begin
  service_charge_cents := private.div_round(p_subtotal::bigint * p_sc_bp, 10000);
  sst_cents := private.div_round((p_subtotal + service_charge_cents)::bigint * p_sst_bp, 10000);
  v_raw := p_subtotal + service_charge_cents + sst_cents;
  rounding_cents := case when p_cash_rounding then ((v_raw + 2) / 5) * 5 - v_raw else 0 end;
  total_cents := v_raw + rounding_cents;
end $$;

-- RLS / Storage / Realtime 策略与 bill_overview（security_invoker）在调用者身份下需要的辅助函数；
-- raise_app、jwt_role 只在 definer 函数或触发器里调用，不授权（【H2】）。0002 末尾会再统一收回并重新授权一次。
grant execute on function private.is_platform_admin(), private.is_store_member(uuid), private.can_write_store(uuid),
  private.try_uuid(text), private.div_round(bigint, integer), private.calc_bill(integer, integer, integer, boolean)
  to authenticated;

-- ---------------------------------------------------------------------
-- 触发器
-- ---------------------------------------------------------------------
create or replace function private.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

do $$ declare t text; begin
  foreach t in array array['stores','profiles','dining_tables','categories','items','bills','orders'] loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t, t);
  end loop;
end $$;

-- 停用店铺写入拦截：店家（authenticated）对停用店的写入一律报 STORE_SUSPENDED
create or replace function private.assert_store_writable() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_status public.store_status; v_row jsonb;
begin
  if private.jwt_role() <> 'authenticated' or private.is_platform_admin() then
    return coalesce(new, old);
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_store := (case when tg_table_name = 'stores' then v_row ->> 'id' else v_row ->> 'store_id' end)::uuid;
  select status into v_status from public.stores where id = v_store;
  if v_status is distinct from 'active' then
    perform private.raise_app('STORE_SUSPENDED', jsonb_build_object('store_id', v_store));
  end if;
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['stores','dining_tables','categories','items','blocked_clients'] loop
    execute format('create trigger %I_assert_writable before insert or update or delete on public.%I for each row execute function private.assert_store_writable()', t, t);
  end loop;
end $$;

-- 订单状态机 + 不可变字段
create or replace function private.orders_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.store_id <> old.store_id or new.table_id <> old.table_id or new.bill_id <> old.bill_id
     or new.subtotal_cents <> old.subtotal_cents or new.request_id <> old.request_id
     or new.seq_in_bill <> old.seq_in_bill or new.created_at <> old.created_at then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('reason', 'immutable_column'));
  end if;
  if new.status <> old.status then
    if not ((old.status = 'new' and new.status in ('accepted', 'cancelled'))
         or (old.status = 'accepted' and new.status in ('served', 'cancelled'))) then
      perform private.raise_app('INVALID_STATUS_TRANSITION',
        jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.status = 'accepted' then new.accepted_at := now(); end if;
    if new.status = 'served'   then new.served_at   := now(); end if;
    if new.status = 'cancelled' then
      if exists (select 1 from public.bills b where b.id = new.bill_id and b.status = 'paid') then
        perform private.raise_app('ORDER_BILL_CLOSED', jsonb_build_object('bill_id', new.bill_id));
      end if;
      new.cancelled_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger orders_guard before update on public.orders for each row execute function private.orders_guard();

-- 维护 bills.subtotal_cents（未取消订单合计），并触碰 bills.updated_at 以便 Realtime / 补拉
create or replace function private.orders_sync_bill() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.bills set subtotal_cents = subtotal_cents + new.subtotal_cents where id = new.bill_id;
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.bills set subtotal_cents = subtotal_cents - new.subtotal_cents where id = new.bill_id;
  elsif new.status <> old.status then
    update public.bills set updated_at = now() where id = new.bill_id and status = 'open';
  end if;
  return null;
end $$;
create trigger orders_sync_bill after insert or update of status on public.orders
  for each row execute function private.orders_sync_bill();

-- 已结清账单不可再改（快照只写一次）
create or replace function private.bills_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'paid' then
    perform private.raise_app('BILL_ALREADY_PAID', jsonb_build_object('bill_id', old.id));
  end if;
  if new.store_id <> old.store_id or new.table_id <> old.table_id then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('reason', 'immutable_column'));
  end if;
  return new;
end $$;
create trigger bills_guard before update on public.bills for each row execute function private.bills_guard();

-- 【M5 已定】验证后才建店：邮箱或手机号任一完成验证（email_confirmed_at / phone_confirmed_at 非空）时，
-- 才建 profile + store + owner 成员（同一事务，原子，幂等）。未验证用户在库里没有任何店铺/成员行。
-- 注册时插入（autoconfirm 场景）和之后验证时的 UPDATE 都会触发；已建过的直接跳过。
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_name text; v_uid uuid;
begin
  -- Supabase 匿名登录已关闭；即使误开，匿名用户也不建店（纵深防御）
  if coalesce((to_jsonb(new) ->> 'is_anonymous')::boolean, false) then
    return new;
  end if;
  if new.email_confirmed_at is null and new.phone_confirmed_at is null then
    return new;                                   -- 未验证：不建店
  end if;
  insert into public.profiles (user_id, signup_channel)
    values (new.id, case when new.email_confirmed_at is not null then 'email' else 'phone' end)
    on conflict (user_id) do nothing
    returning user_id into v_uid;
  if v_uid is null then
    return new;                                   -- 已建过（重复验证、改邮箱/改手机号再验证）：幂等跳过
  end if;
  v_name := left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'store_name'), ''), '我的餐厅'), 50);
  insert into public.stores (slug, name)
    values ('s-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), v_name)
    returning id into v_store;
  insert into public.store_members (store_id, user_id, role) values (v_store, new.id, 'owner');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
create trigger on_auth_user_verified after update of email_confirmed_at, phone_confirmed_at on auth.users
  for each row
  when ((old.email_confirmed_at is null and new.email_confirmed_at is not null)
     or (old.phone_confirmed_at is null and new.phone_confirmed_at is not null))
  execute function private.handle_new_user();

-- ---------------------------------------------------------------------
-- 权限：anon 无任何表权限；authenticated 只拿到列级最小授权，其余走 RPC
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.stores, public.profiles, public.store_members, public.dining_tables, public.categories,
  public.items, public.bills, public.orders, public.order_items, public.blocked_clients, public.audit_logs
  to authenticated;
grant update (name, logo_path, address, opening_hours, is_accepting_orders, service_charge_bp, sst_bp) on public.stores to authenticated;  -- 服务费、SST 由店家自设
grant insert (store_id, label, is_active, sort_order) on public.dining_tables to authenticated;
grant update (label, is_active, sort_order) on public.dining_tables to authenticated;
grant insert (store_id, name, sort_order, is_hidden) on public.categories to authenticated;
grant update (name, sort_order, is_hidden) on public.categories to authenticated;
grant insert (store_id, category_id, name, description, price_cents, image_path, thumb_path, is_sold_out, is_hidden, sort_order)
  on public.items to authenticated;
grant update (category_id, name, description, price_cents, image_path, thumb_path, is_sold_out, is_hidden, sort_order)
  on public.items to authenticated;
grant delete on public.blocked_clients to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.stores             enable row level security;
alter table public.profiles           enable row level security;
alter table public.store_members      enable row level security;
alter table public.dining_tables      enable row level security;
alter table public.categories         enable row level security;
alter table public.items              enable row level security;
alter table public.bills              enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.bill_access_tokens enable row level security;  -- 无任何 policy：只有 service_role / definer 函数可读
alter table public.order_client_meta  enable row level security;  -- 无任何 policy、无任何 grant（【L6】）
alter table public.blocked_clients    enable row level security;
alter table public.audit_logs         enable row level security;

create policy stores_select on public.stores for select to authenticated
  using (private.is_store_member(id) or private.is_platform_admin());
create policy stores_update on public.stores for update to authenticated
  using (private.is_store_member(id)) with check (private.can_write_store(id));

create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or private.is_platform_admin());
create policy store_members_select on public.store_members for select to authenticated
  using (user_id = (select auth.uid()) or private.is_platform_admin());

-- 菜单类三张表：本店成员可读；写入要求店铺 active（触发器先给出 STORE_SUSPENDED）
create policy dining_tables_select on public.dining_tables for select to authenticated using (private.is_store_member(store_id));
create policy dining_tables_insert on public.dining_tables for insert to authenticated with check (private.can_write_store(store_id));
create policy dining_tables_update on public.dining_tables for update to authenticated
  using (private.is_store_member(store_id)) with check (private.can_write_store(store_id));

create policy categories_select on public.categories for select to authenticated using (private.is_store_member(store_id));
create policy categories_insert on public.categories for insert to authenticated with check (private.can_write_store(store_id));
create policy categories_update on public.categories for update to authenticated
  using (private.is_store_member(store_id)) with check (private.can_write_store(store_id));

create policy items_select on public.items for select to authenticated using (private.is_store_member(store_id));
create policy items_insert on public.items for insert to authenticated with check (private.can_write_store(store_id));
create policy items_update on public.items for update to authenticated
  using (private.is_store_member(store_id)) with check (private.can_write_store(store_id));

-- 订单/账单：只读；所有写入经 RPC
create policy bills_select       on public.bills       for select to authenticated using (private.is_store_member(store_id));
create policy orders_select      on public.orders      for select to authenticated using (private.is_store_member(store_id));
create policy order_items_select on public.order_items for select to authenticated using (private.is_store_member(store_id));

create policy blocked_clients_select on public.blocked_clients for select to authenticated using (private.is_store_member(store_id));
create policy blocked_clients_delete on public.blocked_clients for delete to authenticated using (private.can_write_store(store_id));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((store_id is not null and private.is_store_member(store_id)) or private.is_platform_admin());

-- ---------------------------------------------------------------------
-- 视图：账单列表（security_invoker → 沿用调用者 RLS）；open 账单按当前费率实时计算
-- ---------------------------------------------------------------------
create or replace view public.bill_overview with (security_invoker = true) as
select b.id, b.store_id, b.table_id, t.label as table_label, b.status, b.opened_at, b.paid_at, b.updated_at,
       b.subtotal_cents,
       coalesce(b.service_charge_bp, s.service_charge_bp) as service_charge_bp,
       coalesce(b.service_charge_cents, c.service_charge_cents) as service_charge_cents,
       coalesce(b.sst_bp, s.sst_bp) as sst_bp,
       coalesce(b.sst_cents, c.sst_cents) as sst_cents,
       coalesce(b.rounding_cents, c.rounding_cents) as rounding_cents,
       coalesce(b.total_cents, c.total_cents) as total_cents,
       (b.status = 'open') as is_estimate,
       (select count(*) from public.orders o where o.bill_id = b.id)::int as order_count,
       (select count(*) from public.orders o where o.bill_id = b.id and o.status in ('new', 'accepted'))::int as unserved_count,
       b.currency
from public.bills b
join public.stores s on s.id = b.store_id
join public.dining_tables t on t.id = b.table_id
cross join lateral private.calc_bill(b.subtotal_cents, s.service_charge_bp, s.sst_bp, s.cash_rounding) c;
revoke all on public.bill_overview from anon, authenticated;   -- 【M1】兜底：只给 authenticated SELECT
grant select on public.bill_overview to authenticated;

-- ---------------------------------------------------------------------
-- Storage：菜品图片与 Logo（公开读，按店铺目录写）
-- 路径：{store_id}/items/{uuid}.webp | {store_id}/items/{uuid}_thumb.webp | {store_id}/logo/{uuid}.webp
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy menu_images_select on storage.objects for select to authenticated
  using (bucket_id = 'menu-images' and private.is_store_member(private.try_uuid((storage.foldername(name))[1])));
-- 【L5】insert / update 的 with check 统一：两级目录、目录名白名单、文件名格式
create policy menu_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and private.can_write_store(private.try_uuid((storage.foldername(name))[1]))
              and array_length(storage.foldername(name), 1) = 2
              and (storage.foldername(name))[2] in ('items', 'logo')
              and storage.filename(name) ~ '^[0-9a-f-]{36}(_thumb)?\.(webp|jpe?g|png)$');
create policy menu_images_update on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and private.can_write_store(private.try_uuid((storage.foldername(name))[1])))
  with check (bucket_id = 'menu-images' and private.can_write_store(private.try_uuid((storage.foldername(name))[1]))
              and array_length(storage.foldername(name), 1) = 2
              and (storage.foldername(name))[2] in ('items', 'logo')
              and storage.filename(name) ~ '^[0-9a-f-]{36}(_thumb)?\.(webp|jpe?g|png)$');
create policy menu_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'menu-images' and private.can_write_store(private.try_uuid((storage.foldername(name))[1])));

-- ---------------------------------------------------------------------
-- Realtime：店家端订阅 orders / bills（postgres_changes 按 RLS 授权）
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders, public.bills;
  end if;
end $$;

-- 【M8】私有频道授权：店家端用 channel('store:'+id, { config: { private: true } })，
-- Dashboard → Realtime Settings 关闭「Allow public access」。只有本店成员能加入 store:{id}；
-- realtime.messages 不建 insert 策略 = 客户端不能发 Broadcast/Presence（需要时再按需放开）。
do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute $p$create policy store_channel_select on realtime.messages for select to authenticated
      using (realtime.topic() like 'store:%'
             and private.is_store_member(private.try_uuid(split_part(realtime.topic(), ':', 2))))$p$;
  end if;
end $$;
