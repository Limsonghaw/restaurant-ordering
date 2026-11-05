-- 安全审查：幂等重放必须属于同一设备、同一桌；所有不匹配统一报错。
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
    -- Fail closed, including metadata removed by retention cleanup. Do not rotate tokens
    -- or disclose the original order until its device and table are verified.
    if v_meta.device_hash is distinct from p_device_hash
       or v_existing.table_id is distinct from p_table_id
       or v_meta.request_hash is distinct from p_request_hash then
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

