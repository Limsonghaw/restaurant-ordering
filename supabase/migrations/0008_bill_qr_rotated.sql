create or replace function public.customer_get_bill(p_store_id uuid, p_table_id uuid, p_qr_version integer,
  p_bill_token_hash text, p_device_hash text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '3s' as $$
declare v_s public.stores; v_tok public.bill_access_tokens; v_bill public.bills; v_sub int; c record; v_amounts jsonb; v_cur integer; v_stale boolean;
begin
  if p_store_id is null or p_table_id is null or p_qr_version is null then
    perform private.raise_app('TABLE_INVALID');
  end if;
  select qr_version into v_cur from public.dining_tables
   where id = p_table_id and store_id = p_store_id and deleted_at is null;
  if not found then perform private.raise_app('TABLE_INVALID'); end if;
  v_s := private.resolve_table(p_store_id, p_table_id, v_cur, 'bill');
  v_stale := p_qr_version is distinct from v_cur;
  if p_bill_token_hash is null then
    if v_stale then perform private.raise_app('TABLE_INVALID'); end if;
    return jsonb_build_object('view', 'table', 'store', jsonb_build_object('name', v_s.name, 'is_accepting_orders', v_s.is_accepting_orders),
      'table', jsonb_build_object('label', (select label from public.dining_tables where id = p_table_id)),
      'table_in_use', private.table_in_use(p_table_id), 'bill', null, 'orders', '[]'::jsonb, 'poll_after_ms', null);
  end if;
  if private.is_hex64(p_bill_token_hash) then
    select * into v_tok from public.bill_access_tokens where token_hash = p_bill_token_hash and store_id = p_store_id;
    select * into v_bill from public.bills where id = v_tok.bill_id;
  end if;
  if v_tok.id is null or v_bill.table_id is distinct from p_table_id
     or v_tok.device_hash is distinct from p_device_hash then
    if v_stale then perform private.raise_app('TABLE_INVALID'); end if;
    perform private.raise_app('BILL_TOKEN_INVALID');
  end if;
  if v_tok.revoked_at is not null then
    perform private.raise_app('BILL_TOKEN_EXPIRED', jsonb_build_object('reason', v_tok.revoked_reason));
  end if;
  if v_tok.expires_at <= now() then
    perform private.raise_app('BILL_TOKEN_EXPIRED', jsonb_build_object('reason', 'expired'));
  end if;
  if v_stale then perform private.raise_app('TABLE_INVALID'); end if;
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

revoke execute on function public.customer_get_bill(uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.customer_get_bill(uuid, uuid, integer, text, text) to customer_api;
