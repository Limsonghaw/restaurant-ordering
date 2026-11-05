-- =====================================================================
-- 0002_rpc.sql  RPC 函数（v7：按安全审查修订；admin_list_stores 增加 owner_phone）
--  customer_*  ：只授权最小权限角色 customer_api（【M7】），由 Next.js Route Handler 验签/限流后
--                用短期 JWT（role=customer_api）调用；service_role 不再用于顾客流量
--  其余        ：授权 authenticated，函数内自行校验店铺成员与店铺状态
-- 错误约定：raise exception errcode 'P0001'，message = 错误码，detail = JSON 字符串
-- NULL 安全（【M2】）：所有入参显式判空，比较一律用 is distinct from
-- =====================================================================

create or replace function private.is_hex64(p text) returns boolean
language sql immutable set search_path = '' as $$ select coalesce(p ~ '^[0-9a-f]{64}$', false) $$;

-- ---------------------------------------------------------------------
-- 内部：校验桌子与店铺，返回 store 行
-- p_mode: 'menu'（看菜单）| 'order'（下单，加锁 + 校验营业中）| 'bill'（查账单）
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
    select * into v_t from public.dining_tables where id = p_table_id for update;  -- 同桌下单串行化
  else
    select * into v_t from public.dining_tables where id = p_table_id;
  end if;
  if not found or v_t.store_id is distinct from p_store_id or v_t.deleted_at is not null
     or v_t.qr_version is distinct from p_qr_version or (p_mode <> 'bill' and v_t.is_active is not true) then
    perform private.raise_app('TABLE_INVALID');
  end if;
  select * into v_s from public.stores where id = p_store_id;
  if not found or v_s.status is distinct from 'active' then
    perform private.raise_app('STORE_SUSPENDED');
  end if;
  if p_mode = 'order' and v_s.is_accepting_orders is not true then
    perform private.raise_app('STORE_CLOSED');
  end if;
  return v_s;
end $$;

-- 这桌现在有没有 open 账单（【L7】不带令牌只返回布尔值，不再返回单数）
create or replace function private.table_in_use(p_table_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bills b where b.table_id = p_table_id and b.status = 'open')
$$;

-- ---------------------------------------------------------------------
-- 内部：购物车校验与计价（quote 与下单共用）
-- p_items: [{item_id uuid, quantity int, unit_price_cents int, note text}]
-- 返回 {lines:[...], subtotal_cents, item_count, unavailable:[...], price_changes:[...]}
-- ---------------------------------------------------------------------
create or replace function private.validate_cart(p_store public.stores, p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_line jsonb; v_no int := 0; v_item public.items;
  v_lines jsonb := '[]'; v_unavail jsonb := '[]'; v_changes jsonb := '[]';
  v_qty int; v_client_price int; v_note text; v_subtotal bigint := 0; v_count int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'items', 'rule', '1..30 lines'));
  end if;
  for v_line in select * from jsonb_array_elements(p_items) loop
    v_no := v_no + 1;
    if jsonb_typeof(v_line) is distinct from 'object' then
      perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'items[' || (v_no - 1) || ']'));
    end if;
    v_qty := (v_line ->> 'quantity')::int;
    v_client_price := (v_line ->> 'unit_price_cents')::int;
    v_note := coalesce(btrim(v_line ->> 'note'), '');
    if v_qty is null or v_qty not between 1 and 99 or v_client_price is null or char_length(v_note) > 50
       or private.try_uuid(v_line ->> 'item_id') is null then
      perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'items[' || (v_no - 1) || ']'));
    end if;
    select * into v_item from public.items i
     where i.id = private.try_uuid(v_line ->> 'item_id') and i.store_id = p_store.id;
    if not found or v_item.deleted_at is not null or v_item.is_hidden
       or exists (select 1 from public.categories c where c.id = v_item.category_id and (c.is_hidden or c.deleted_at is not null)) then
      v_unavail := v_unavail || jsonb_build_object('item_id', v_line ->> 'item_id', 'reason', 'unavailable');
      continue;
    end if;
    if v_item.is_sold_out then
      v_unavail := v_unavail || jsonb_build_object('item_id', v_item.id, 'reason', 'sold_out', 'name', v_item.name);
      continue;
    end if;
    if v_item.price_cents is distinct from v_client_price then
      v_changes := v_changes || jsonb_build_object('item_id', v_item.id, 'name', v_item.name,
        'client_unit_price_cents', v_client_price, 'current_unit_price_cents', v_item.price_cents);
    end if;
    v_subtotal := v_subtotal + v_item.price_cents::bigint * v_qty;
    v_count := v_count + v_qty;
    v_lines := v_lines || jsonb_build_object('line_no', v_no, 'item_id', v_item.id, 'item_name', v_item.name,
      'unit_price_cents', v_item.price_cents, 'quantity', v_qty, 'line_total_cents', v_item.price_cents * v_qty, 'note', v_note);
  end loop;
  return jsonb_build_object('lines', v_lines, 'subtotal_cents', v_subtotal, 'item_count', v_count,
    'unavailable', v_unavail, 'price_changes', v_changes);
end $$;

create or replace function private.assert_cart_ok(p_store public.stores, p_cart jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  if jsonb_array_length(p_cart -> 'unavailable') > 0 then
    perform private.raise_app('ITEM_UNAVAILABLE', jsonb_build_object('items', p_cart -> 'unavailable',
      'price_changes', p_cart -> 'price_changes'));
  end if;
  if jsonb_array_length(p_cart -> 'price_changes') > 0 then
    perform private.raise_app('PRICE_CHANGED', jsonb_build_object('items', p_cart -> 'price_changes'));
  end if;
  if (p_cart ->> 'subtotal_cents')::bigint > p_store.max_order_cents or (p_cart ->> 'item_count')::int > 200 then
    perform private.raise_app('ORDER_LIMIT_EXCEEDED', jsonb_build_object('max_order_cents', p_store.max_order_cents,
      'max_item_count', 200, 'subtotal_cents', (p_cart ->> 'subtotal_cents')::bigint, 'item_count', (p_cart ->> 'item_count')::int));
  end if;
end $$;

-- 金额 JSON（open 用店铺当前费率实时算；paid 用快照）
create or replace function private.bill_amounts_json(p_bill public.bills, p_store public.stores)
returns jsonb language plpgsql stable set search_path = '' as $$
declare c record;
begin
  if p_bill.status = 'paid' then
    return jsonb_build_object('subtotal_cents', p_bill.subtotal_cents, 'service_charge_bp', p_bill.service_charge_bp,
      'service_charge_cents', p_bill.service_charge_cents, 'sst_bp', p_bill.sst_bp, 'sst_cents', p_bill.sst_cents,
      'rounding_cents', p_bill.rounding_cents, 'total_cents', p_bill.total_cents, 'is_estimate', false);
  end if;
  select * into c from private.calc_bill(p_bill.subtotal_cents, p_store.service_charge_bp, p_store.sst_bp, p_store.cash_rounding);
  return jsonb_build_object('subtotal_cents', p_bill.subtotal_cents, 'service_charge_bp', p_store.service_charge_bp,
    'service_charge_cents', c.service_charge_cents, 'sst_bp', p_store.sst_bp, 'sst_cents', c.sst_cents,
    'rounding_cents', c.rounding_cents, 'total_cents', c.total_cents, 'is_estimate', true);
end $$;

-- 订单 JSON（顾客端，不含任何指纹）
create or replace function private.customer_order_json(p_order public.orders) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p_order.id, 'seq_in_bill', p_order.seq_in_bill, 'status', p_order.status,
    'subtotal_cents', p_order.subtotal_cents, 'item_count', p_order.item_count, 'created_at', p_order.created_at,
    'cancel_reason', p_order.cancel_reason,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('item_name', oi.item_name, 'quantity', oi.quantity,
               'unit_price_cents', oi.unit_price_cents, 'line_total_cents', oi.line_total_cents, 'note', oi.note)
             order by oi.line_no) from public.order_items oi where oi.order_id = p_order.id), '[]'))
$$;

-- =====================================================================
-- 顾客端（customer_api only）
-- =====================================================================
create or replace function public.customer_get_menu(p_store_id uuid, p_table_id uuid, p_qr_version integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_s public.stores; v_label text;
begin
  v_s := private.resolve_table(p_store_id, p_table_id, p_qr_version, 'menu');
  select label into v_label from public.dining_tables where id = p_table_id;
  return jsonb_build_object(
    'store', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'logo_path', v_s.logo_path, 'address', v_s.address,
       'opening_hours', v_s.opening_hours, 'is_accepting_orders', v_s.is_accepting_orders, 'currency', v_s.currency,
       'service_charge_bp', v_s.service_charge_bp, 'sst_bp', v_s.sst_bp),
    'table', jsonb_build_object('id', p_table_id, 'label', v_label),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort_order', c.sort_order)
                              order by c.sort_order, c.created_at)
                            from public.categories c
                            where c.store_id = v_s.id and c.deleted_at is null and not c.is_hidden), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'category_id', i.category_id, 'name', i.name,
                          'description', i.description, 'price_cents', i.price_cents, 'image_path', i.image_path,
                          'thumb_path', i.thumb_path, 'is_sold_out', i.is_sold_out, 'sort_order', i.sort_order)
                        order by i.sort_order, i.created_at)
                       from public.items i join public.categories c on c.id = i.category_id
                       where i.store_id = v_s.id and i.deleted_at is null and not i.is_hidden
                         and c.deleted_at is null and not c.is_hidden), '[]'),
    'table_in_use', private.table_in_use(p_table_id)
  );
end $$;

create or replace function public.customer_quote(p_store_id uuid, p_table_id uuid, p_qr_version integer, p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_s public.stores; v_cart jsonb; c record; v_sub bigint; v_over boolean;
begin
  v_s := private.resolve_table(p_store_id, p_table_id, p_qr_version, 'menu');
  v_cart := private.validate_cart(v_s, p_items);
  v_sub := (v_cart ->> 'subtotal_cents')::bigint;
  v_over := v_sub > v_s.max_order_cents or (v_cart ->> 'item_count')::int > 200;
  if not v_over then   -- 【L4】超上限时不再计算（避免 int 溢出），直接返回 can_order=false
    select * into c from private.calc_bill(v_sub::int, v_s.service_charge_bp, v_s.sst_bp, v_s.cash_rounding);
  end if;
  return jsonb_build_object('can_order', v_s.is_accepting_orders and not v_over
            and jsonb_array_length(v_cart -> 'unavailable') = 0,
         'is_accepting_orders', v_s.is_accepting_orders,
         'limit_exceeded', v_over,
         'lines', v_cart -> 'lines', 'subtotal_cents', v_sub,
         'item_count', (v_cart ->> 'item_count')::int,
         'estimated_service_charge_cents', case when v_over then null else c.service_charge_cents end,
         'estimated_sst_cents', case when v_over then null else c.sst_cents end,
         'unavailable', v_cart -> 'unavailable', 'price_changes', v_cart -> 'price_changes',
         'max_order_cents', v_s.max_order_cents);
end $$;

-- 下单。p_device_hash / p_ip_hash 由 Route Handler 计算：HMAC(CLIENT_HASH_SECRET, store_id || ':' || 值)（【L6】）；
-- device 值来自服务端签发的 HttpOnly cookie，IP 只取 Vercel 可信来源（【M3】）。
-- p_captcha_verified：Route Handler 已通过 Turnstile 校验时传 true（stores.require_captcha 或 Redis 故障时要求）。
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
  v_recent int; v_token_issued boolean := false; v_line jsonb;
begin
  -- 0. 入参（【M2】【M3】：哈希必须非空且格式正确）
  if p_request_id is null or not private.is_hex64(p_request_hash) or not private.is_hex64(p_device_hash)
     or not private.is_hex64(p_ip_hash) or not private.is_hex64(p_new_bill_token_hash)
     or (p_bill_token_hash is not null and not private.is_hex64(p_bill_token_hash)) then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'client_context'));
  end if;

  -- 1. 桌子加锁 + 店铺状态（同桌并发下单在此串行）
  v_s := private.resolve_table(p_store_id, p_table_id, p_qr_version, 'order');

  -- 2. 幂等：同 request_id 返回原单；内容不同报错（details 不带 order_id）
  select * into v_existing from public.orders where store_id = p_store_id and request_id = p_request_id;
  if found then
    select * into v_meta from public.order_client_meta where order_id = v_existing.id;
    if v_meta.request_hash is distinct from p_request_hash then
      perform private.raise_app('IDEMPOTENCY_KEY_REUSED');
    end if;
    -- 原请求的令牌 cookie 可能没送到：同一设备重放时，把该令牌换成新哈希重新下发
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

  -- 3. 验证码（数据库兜底，Route Handler 漏判也挡住）
  if v_s.require_captcha and p_captcha_verified is not true then
    perform private.raise_app('CAPTCHA_REQUIRED');
  end if;

  -- 4. 拉黑设备 / IP
  if exists (select 1 from public.blocked_clients b where b.store_id = p_store_id and b.expires_at > now()
               and ((b.kind = 'device' and b.value_hash = p_device_hash) or (b.kind = 'ip' and b.value_hash = p_ip_hash))) then
    perform private.raise_app('DEVICE_BLOCKED');
  end if;

  -- 5. 数据库兜底限流（Redis 失效时仍生效）：同桌 10 单 / 同店同 IP 20 单 / 同店同设备 10 单，均为 10 分钟
  select count(*) into v_recent from public.orders
   where table_id = p_table_id and created_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    perform private.raise_app('RATE_LIMITED', jsonb_build_object('scope', 'table_db', 'retry_after_seconds', 120));
  end if;
  select count(*) into v_recent from public.order_client_meta
   where store_id = p_store_id and ip_hash = p_ip_hash and created_at > now() - interval '10 minutes';
  if v_recent >= 20 then
    perform private.raise_app('RATE_LIMITED', jsonb_build_object('scope', 'ip_db', 'retry_after_seconds', 120));
  end if;
  select count(*) into v_recent from public.order_client_meta
   where store_id = p_store_id and device_hash = p_device_hash and created_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    perform private.raise_app('RATE_LIMITED', jsonb_build_object('scope', 'device_db', 'retry_after_seconds', 120));
  end if;

  -- 6. 校验菜品与价格（以数据库为准）
  v_cart := private.validate_cart(v_s, p_items);
  perform private.assert_cart_ok(v_s, v_cart);

  -- 7. 取或开账单（一桌一张 open 账单；部分唯一索引兜底）
  select * into v_bill from public.bills where table_id = p_table_id and status = 'open' for update;
  if not found then
    insert into public.bills (store_id, table_id) values (p_store_id, p_table_id) returning * into v_bill;
  end if;
  if (select count(*) from public.orders where bill_id = v_bill.id) >= 60 then
    perform private.raise_app('ORDER_LIMIT_EXCEEDED', jsonb_build_object('max_orders_per_bill', 60));
  end if;

  -- 8. 账单令牌（【H1】）：沿用本设备在本账单上仍有效的令牌；否则签一个新的，作用域 own_orders（只看本设备的订单）
  select * into v_tok from public.bill_access_tokens
   where token_hash = p_bill_token_hash and bill_id = v_bill.id and device_hash = p_device_hash
     and revoked_at is null and expires_at > now();
  if not found then
    insert into public.bill_access_tokens (bill_id, store_id, token_hash, device_hash, scope)
    values (v_bill.id, p_store_id, p_new_bill_token_hash, p_device_hash, 'own_orders') returning * into v_tok;
    v_token_issued := true;
  end if;

  -- 9. 写订单 + 指纹 + 明细（快照菜名、单价）
  insert into public.orders (store_id, table_id, bill_id, seq_in_bill, subtotal_cents, item_count, request_id)
  values (p_store_id, p_table_id, v_bill.id,
          coalesce((select max(seq_in_bill) from public.orders where bill_id = v_bill.id), 0) + 1,
          (v_cart ->> 'subtotal_cents')::int, (v_cart ->> 'item_count')::int, p_request_id)
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

-- 查进度。令牌必须：本店、本桌、本设备、未撤销、未过期。
-- scope = own_orders：只返回本令牌下的订单与这些订单的估算金额；scope = 'bill'（预留）才返回整张账单。
create or replace function public.customer_get_bill(p_store_id uuid, p_table_id uuid, p_qr_version integer,
  p_bill_token_hash text, p_device_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s public.stores; v_tok public.bill_access_tokens; v_bill public.bills; v_sub int; c record; v_amounts jsonb;
begin
  v_s := private.resolve_table(p_store_id, p_table_id, p_qr_version, 'bill');
  if p_bill_token_hash is null then
    return jsonb_build_object('view', 'table', 'store', jsonb_build_object('name', v_s.name, 'is_accepting_orders', v_s.is_accepting_orders),
      'table', jsonb_build_object('label', (select label from public.dining_tables where id = p_table_id)),
      'table_in_use', private.table_in_use(p_table_id), 'bill', null, 'orders', '[]'::jsonb, 'poll_after_ms', null);
  end if;
  if not private.is_hex64(p_bill_token_hash) then perform private.raise_app('BILL_TOKEN_INVALID'); end if;

  select * into v_tok from public.bill_access_tokens where token_hash = p_bill_token_hash and store_id = p_store_id;
  if not found then perform private.raise_app('BILL_TOKEN_INVALID'); end if;
  select * into v_bill from public.bills where id = v_tok.bill_id;
  if v_bill.table_id is distinct from p_table_id or v_tok.device_hash is distinct from p_device_hash then
    perform private.raise_app('BILL_TOKEN_INVALID');
  end if;
  if v_tok.revoked_at is not null then
    perform private.raise_app('BILL_TOKEN_EXPIRED', jsonb_build_object('reason', v_tok.revoked_reason));
  end if;
  if v_tok.expires_at <= now() then
    perform private.raise_app('BILL_TOKEN_EXPIRED', jsonb_build_object('reason', 'expired'));
  end if;
  update public.bill_access_tokens set last_used_at = now() where id = v_tok.id;

  if v_tok.scope = 'bill' then
    v_amounts := private.bill_amounts_json(v_bill, v_s);
  else
    select coalesce(sum(o.subtotal_cents), 0) into v_sub from public.orders o
      join public.order_client_meta m on m.order_id = o.id
     where o.bill_id = v_bill.id and m.bill_token_id = v_tok.id and o.status <> 'cancelled';
    select * into c from private.calc_bill(v_sub, v_s.service_charge_bp, v_s.sst_bp, v_s.cash_rounding);
    v_amounts := jsonb_build_object('subtotal_cents', v_sub, 'service_charge_bp', v_s.service_charge_bp,
      'service_charge_cents', c.service_charge_cents, 'sst_bp', v_s.sst_bp, 'sst_cents', c.sst_cents,
      'rounding_cents', c.rounding_cents, 'total_cents', c.total_cents, 'is_estimate', true);
  end if;

  return jsonb_build_object('view', 'bill', 'scope', v_tok.scope,
    'store', jsonb_build_object('name', v_s.name, 'is_accepting_orders', v_s.is_accepting_orders),
    'table', jsonb_build_object('label', (select label from public.dining_tables where id = p_table_id)),
    'bill', jsonb_build_object('id', v_bill.id, 'status', v_bill.status, 'opened_at', v_bill.opened_at, 'paid_at', v_bill.paid_at,
              'currency', v_bill.currency, 'token_expires_at', v_tok.expires_at, 'amounts_basis', v_tok.scope) || v_amounts,
    'orders', coalesce((select jsonb_agg(private.customer_order_json(o) order by o.seq_in_bill desc)
               from public.orders o
              where o.bill_id = v_bill.id
                and (v_tok.scope = 'bill' or exists (select 1 from public.order_client_meta m
                                                     where m.order_id = o.id and m.bill_token_id = v_tok.id))), '[]'),
    'poll_after_ms', case when v_bill.status = 'open' then 10000 else null end);
end $$;

-- =====================================================================
-- 店家端（authenticated）
-- =====================================================================
create or replace function private.assert_can_write(p_store_id uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_store_member(p_store_id) then perform private.raise_app('FORBIDDEN'); end if;
  if not private.can_write_store(p_store_id) then perform private.raise_app('STORE_SUSPENDED'); end if;
end $$;

-- 撤销某账单（或某桌）全部有效顾客令牌，返回撤销数
create or replace function private.revoke_bill_tokens(p_bill_id uuid, p_table_id uuid, p_reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.bill_access_tokens t set revoked_at = now(), revoked_reason = p_reason
   where t.revoked_at is null
     and (t.bill_id = p_bill_id
          or (p_table_id is not null and t.bill_id in (select b.id from public.bills b where b.table_id = p_table_id)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.update_order_status(p_order_id uuid, p_to public.order_status, p_expected public.order_status,
  p_cancel_reason public.cancel_reason default null, p_cancel_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_o public.orders;
begin
  if p_order_id is null or p_to is null or p_expected is null then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'status'));
  end if;
  select * into v_o from public.orders where id = p_order_id for update;
  if not found or not private.is_store_member(v_o.store_id) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_o.store_id);
  if v_o.status is distinct from p_expected then
    perform private.raise_app('ORDER_STATUS_CONFLICT', jsonb_build_object('current_status', v_o.status, 'order_id', v_o.id));
  end if;
  if p_to = 'cancelled' then
    if p_cancel_reason is null then perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'cancel_reason')); end if;
    if char_length(coalesce(p_cancel_note, '')) > 100 then perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'cancel_note')); end if;
    update public.orders set status = 'cancelled', cancel_reason = p_cancel_reason,
      cancel_note = case when p_cancel_reason = 'other' then nullif(btrim(p_cancel_note), '') end,
      cancelled_by = (select auth.uid())
     where id = p_order_id returning * into v_o;
  else
    update public.orders set status = p_to where id = p_order_id returning * into v_o;  -- 触发器校验状态机
  end if;
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_o.store_id, (select auth.uid()), 'user', 'order.status', 'orders', v_o.id,
          jsonb_build_object('from', p_expected, 'to', p_to, 'cancel_reason', p_cancel_reason));
  return to_jsonb(v_o);
end $$;

-- 结账 = 标已付款 + 自动清台：快照金额、撤销这张账单的全部顾客令牌（【H1】【M4】），下一单自动开新账单
create or replace function public.mark_bill_paid(p_bill_id uuid, p_expected_total_cents integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_b public.bills; v_s public.stores; c record; v_revoked int;
begin
  if p_bill_id is null or p_expected_total_cents is null then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'expected_total_cents'));
  end if;
  select * into v_b from public.bills where id = p_bill_id for update;
  if not found or not private.is_store_member(v_b.store_id) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_b.store_id);
  if v_b.status = 'paid' then perform private.raise_app('BILL_ALREADY_PAID', jsonb_build_object('paid_at', v_b.paid_at)); end if;
  select * into v_s from public.stores where id = v_b.store_id;
  select * into c from private.calc_bill(v_b.subtotal_cents, v_s.service_charge_bp, v_s.sst_bp, v_s.cash_rounding);
  if c.total_cents is distinct from p_expected_total_cents then
    perform private.raise_app('BILL_TOTAL_CHANGED', private.bill_amounts_json(v_b, v_s));
  end if;
  update public.bills set status = 'paid', paid_at = now(), paid_by = (select auth.uid()),
    service_charge_bp = v_s.service_charge_bp, service_charge_cents = c.service_charge_cents,
    sst_bp = v_s.sst_bp, sst_cents = c.sst_cents, rounding_cents = c.rounding_cents, total_cents = c.total_cents
   where id = p_bill_id returning * into v_b;
  v_revoked := private.revoke_bill_tokens(p_bill_id, null, 'bill_paid');
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_b.store_id, (select auth.uid()), 'user', 'bill.paid', 'bills', v_b.id,
          jsonb_build_object('total_cents', v_b.total_cents, 'tokens_revoked', v_revoked));
  return jsonb_build_object('id', v_b.id, 'status', v_b.status, 'paid_at', v_b.paid_at, 'table_id', v_b.table_id,
                            'tokens_revoked', v_revoked)
         || private.bill_amounts_json(v_b, v_s);
end $$;

-- 重置桌码（【H1】）：qr_version + 1 使旧二维码失效，并撤销这张桌子全部有效顾客令牌
create or replace function public.rotate_table_qr(p_table_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_store uuid; v_ver integer; v_revoked int;
begin
  if p_table_id is null then perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'table_id')); end if;
  select store_id into v_store from public.dining_tables where id = p_table_id and deleted_at is null for update;
  if v_store is null or not private.is_store_member(v_store) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_store);
  update public.dining_tables set qr_version = qr_version + 1 where id = p_table_id returning qr_version into v_ver;
  v_revoked := private.revoke_bill_tokens(null, p_table_id, 'qr_rotated');
  insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
  values (v_store, (select auth.uid()), 'user', 'table.qr_rotated', 'dining_tables', p_table_id,
          jsonb_build_object('qr_version', v_ver, 'tokens_revoked', v_revoked));
  return jsonb_build_object('table_id', p_table_id, 'qr_version', v_ver, 'tokens_revoked', v_revoked);
end $$;

create or replace function public.reorder_categories(p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 50 or array_position(p_ids, null) is not null then
    perform private.raise_app('VALIDATION_FAILED');
  end if;
  select store_id into v_store from public.categories where id = p_ids[1];
  if v_store is null or not private.is_store_member(v_store) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_store);
  if (select count(*) from public.categories where id = any(p_ids) and store_id = v_store and deleted_at is null) <> cardinality(p_ids) then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('reason', 'ids_must_belong_to_store'));
  end if;
  update public.categories c set sort_order = x.ord * 10 from unnest(p_ids) with ordinality as x(id, ord) where c.id = x.id;
end $$;

create or replace function public.reorder_items(p_category_id uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  if p_category_id is null or p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500
     or array_position(p_ids, null) is not null then
    perform private.raise_app('VALIDATION_FAILED');
  end if;
  select store_id into v_store from public.categories where id = p_category_id;
  if v_store is null or not private.is_store_member(v_store) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_store);
  if (select count(*) from public.items where id = any(p_ids) and category_id = p_category_id and deleted_at is null) <> cardinality(p_ids) then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('reason', 'ids_must_belong_to_category'));
  end if;
  update public.items i set sort_order = x.ord * 10 from unnest(p_ids) with ordinality as x(id, ord) where i.id = x.id;
end $$;

create or replace function public.soft_delete_item(p_item_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  select store_id into v_store from public.items where id = p_item_id and deleted_at is null;
  if v_store is null or not private.is_store_member(v_store) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_store);
  update public.items set deleted_at = now(), is_hidden = true where id = p_item_id;
end $$;

create or replace function public.delete_category(p_category_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  select store_id into v_store from public.categories where id = p_category_id and deleted_at is null;
  if v_store is null or not private.is_store_member(v_store) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_store);
  if exists (select 1 from public.items where category_id = p_category_id and deleted_at is null) then
    perform private.raise_app('CATEGORY_NOT_EMPTY');
  end if;
  update public.categories set deleted_at = now(), is_hidden = true where id = p_category_id;
end $$;

create or replace function public.soft_delete_table(p_table_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid;
begin
  select store_id into v_store from public.dining_tables where id = p_table_id and deleted_at is null;
  if v_store is null or not private.is_store_member(v_store) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_store);
  if exists (select 1 from public.bills where table_id = p_table_id and status = 'open') then
    perform private.raise_app('TABLE_HAS_OPEN_BILL');
  end if;
  update public.dining_tables set deleted_at = now(), is_active = false where id = p_table_id;
end $$;

-- 营业统计：p_date 为马来西亚日期；营业额 = 当天（按 paid_at，UTC+8）已结清账单 total 合计
create or replace function public.get_store_daily_stats(p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid; v_from timestamptz; v_to timestamptz; v_paid jsonb; v_open jsonb; v_orders jsonb;
begin
  if p_date is null then perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'date')); end if;
  select store_id into v_store from public.store_members where user_id = (select auth.uid());
  if v_store is null then perform private.raise_app('FORBIDDEN'); end if;
  v_from := (p_date::timestamp) at time zone 'Asia/Kuala_Lumpur';
  v_to   := ((p_date + 1)::timestamp) at time zone 'Asia/Kuala_Lumpur';
  select jsonb_build_object('count', count(*), 'subtotal_cents', coalesce(sum(subtotal_cents), 0),
           'service_charge_cents', coalesce(sum(service_charge_cents), 0), 'sst_cents', coalesce(sum(sst_cents), 0),
           'rounding_cents', coalesce(sum(rounding_cents), 0), 'total_cents', coalesce(sum(total_cents), 0))
    into v_paid from public.bills where store_id = v_store and status = 'paid' and paid_at >= v_from and paid_at < v_to;
  select jsonb_build_object('count', count(*), 'subtotal_cents', coalesce(sum(b.subtotal_cents), 0),
           'total_cents', coalesce(sum(c.total_cents), 0))
    into v_open from public.bills b join public.stores s on s.id = b.store_id
    cross join lateral private.calc_bill(b.subtotal_cents, s.service_charge_bp, s.sst_bp, s.cash_rounding) c
   where b.store_id = v_store and b.status = 'open';
  select jsonb_build_object('count', count(*) filter (where status <> 'cancelled'), 'cancelled_count', count(*) filter (where status = 'cancelled'))
    into v_orders from public.orders where store_id = v_store and created_at >= v_from and created_at < v_to;
  return jsonb_build_object('date', p_date, 'timezone', 'Asia/Kuala_Lumpur', 'currency', 'MYR',
    'revenue_cents', v_paid -> 'total_cents', 'paid_bills', v_paid, 'open_bills', v_open, 'orders', v_orders);
end $$;

-- 一键拒单 + 拉黑设备（及可选 IP）；哈希从 order_client_meta 读（店家看不到哈希本身）
create or replace function public.block_client_from_order(p_order_id uuid, p_cancel boolean default true,
  p_include_ip boolean default false, p_days integer default 7)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_o public.orders; v_m public.order_client_meta; v_n int := 0; v_cancelled boolean := false;
begin
  if p_order_id is null or p_days is null or p_days not between 1 and 30 then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'days'));
  end if;
  select * into v_o from public.orders where id = p_order_id;
  if not found or not private.is_store_member(v_o.store_id) then perform private.raise_app('NOT_FOUND'); end if;
  perform private.assert_can_write(v_o.store_id);
  select * into v_m from public.order_client_meta where order_id = v_o.id;
  if coalesce(p_cancel, true) and v_o.status in ('new', 'accepted') then
    perform public.update_order_status(v_o.id, 'cancelled', v_o.status, 'other', '恶意下单');
    v_cancelled := true;
  end if;
  if v_m.device_hash is not null then
    insert into public.blocked_clients (store_id, kind, value_hash, reason, source_order_id, created_by, expires_at)
    values (v_o.store_id, 'device', v_m.device_hash, '店家拉黑', v_o.id, (select auth.uid()), now() + make_interval(days => p_days))
    on conflict (store_id, kind, value_hash) do update set expires_at = excluded.expires_at;
    v_n := v_n + 1;
  end if;
  if coalesce(p_include_ip, false) and v_m.ip_hash is not null then
    insert into public.blocked_clients (store_id, kind, value_hash, reason, source_order_id, created_by, expires_at)
    values (v_o.store_id, 'ip', v_m.ip_hash, '店家拉黑', v_o.id, (select auth.uid()), now() + make_interval(days => p_days))
    on conflict (store_id, kind, value_hash) do update set expires_at = excluded.expires_at;
    v_n := v_n + 1;
  end if;
  return jsonb_build_object('blocked', v_n, 'cancelled', v_cancelled);
end $$;

-- =====================================================================
-- 平台管理员
-- =====================================================================
create or replace function public.admin_list_stores(p_status public.store_status default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then perform private.raise_app('FORBIDDEN'); end if;
  return jsonb_build_object(
    'total', (select count(*) from public.stores s where p_status is null or s.status = p_status),
    'stores', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select s.id, s.name, s.slug, s.status, s.status_reason, s.status_changed_at, s.created_at, s.is_accepting_orders,
               (select u.email from public.store_members m join auth.users u on u.id = m.user_id
                 where m.store_id = s.id and m.role = 'owner' limit 1) as owner_email,
               (select u.phone from public.store_members m join auth.users u on u.id = m.user_id
                 where m.store_id = s.id and m.role = 'owner' limit 1) as owner_phone,   -- 手机号注册的店主（E.164 去掉 +）
               (select max(o.created_at) from public.orders o where o.store_id = s.id) as last_order_at
          from public.stores s where p_status is null or s.status = p_status
         order by s.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'));
end $$;

create or replace function public.admin_set_store_status(p_store_id uuid, p_status public.store_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s public.stores;
begin
  if not private.is_platform_admin() then perform private.raise_app('FORBIDDEN'); end if;
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

-- 清理（pg_cron 每天跑）：过期/撤销 7 天的令牌、过期拉黑、30 天前的设备/IP 哈希置空（【L6】）、180 天前的审计日志
create or replace function private.purge_expired() returns void language sql security definer set search_path = '' as $$
  delete from public.bill_access_tokens
   where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days';
  delete from public.blocked_clients where expires_at < now();
  update public.order_client_meta set device_hash = null, ip_hash = null
   where created_at < now() - interval '30 days' and (device_hash is not null or ip_hash is not null);
  delete from public.audit_logs where created_at < now() - interval '180 days';
$$;

-- =====================================================================
-- 授权（【H2】先全部收回，再逐个授权；【M7】顾客 RPC 只给 customer_api）
-- =====================================================================
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

-- RLS / Storage / Realtime 策略与 bill_overview（security_invoker）需要的辅助函数
grant execute on function private.is_store_member(uuid), private.can_write_store(uuid), private.is_platform_admin(),
  private.try_uuid(text), private.calc_bill(integer, integer, integer, boolean), private.div_round(bigint, integer)
  to authenticated;

grant execute on function public.update_order_status(uuid, public.order_status, public.order_status, public.cancel_reason, text),
  public.mark_bill_paid(uuid, integer), public.rotate_table_qr(uuid),
  public.reorder_categories(uuid[]), public.reorder_items(uuid, uuid[]),
  public.soft_delete_item(uuid), public.delete_category(uuid), public.soft_delete_table(uuid),
  public.get_store_daily_stats(date), public.block_client_from_order(uuid, boolean, boolean, integer),
  public.admin_list_stores(public.store_status, integer, integer), public.admin_set_store_status(uuid, public.store_status, text)
  to authenticated;

-- 最小权限顾客角色：只能执行 4 个 customer_* 函数，没有任何表权限
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'customer_api') then
    create role customer_api nologin noinherit;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant customer_api to authenticator;   -- 让 PostgREST 能按 JWT role=customer_api 切换
  end if;
end $$;
grant usage on schema public to customer_api;
revoke execute on function public.customer_get_menu(uuid, uuid, integer), public.customer_quote(uuid, uuid, integer, jsonb),
  public.customer_place_order(uuid, uuid, integer, uuid, text, jsonb, text, text, text, text, boolean),
  public.customer_get_bill(uuid, uuid, integer, text, text) from service_role;
grant execute on function public.customer_get_menu(uuid, uuid, integer), public.customer_quote(uuid, uuid, integer, jsonb),
  public.customer_place_order(uuid, uuid, integer, uuid, text, jsonb, text, text, text, text, boolean),
  public.customer_get_bill(uuid, uuid, integer, text, text) to customer_api;
