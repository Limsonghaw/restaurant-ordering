-- Read-only counterpart of 0006's validation/replay branch. Token recovery remains
-- in customer_place_order. resolve_table(order) locks, so mirror its checks here.
create or replace function public.customer_check_replay(
  p_store_id uuid, p_table_id uuid, p_qr_version integer,
  p_request_id uuid, p_request_hash text, p_device_hash text)
returns jsonb language plpgsql stable security definer
set search_path = '' set statement_timeout = '3s' as $$
declare
  v_t public.dining_tables; v_s public.stores;
  v_existing public.orders; v_meta public.order_client_meta;
begin
  if p_request_id is null or not private.is_hex64(p_request_hash) or not private.is_hex64(p_device_hash) then
    perform private.raise_app('VALIDATION_FAILED', jsonb_build_object('field', 'client_context'));
  end if;
  if p_store_id is null or p_table_id is null or p_qr_version is null then
    perform private.raise_app('TABLE_INVALID');
  end if;
  select * into v_t from public.dining_tables where id = p_table_id;
  if not found or v_t.store_id is distinct from p_store_id or v_t.deleted_at is not null
     or v_t.qr_version is distinct from p_qr_version or v_t.is_active is not true then
    perform private.raise_app('TABLE_INVALID');
  end if;
  select * into v_s from public.stores where id = p_store_id;
  if not found or v_s.status is distinct from 'active' then
    perform private.raise_app('STORE_SUSPENDED');
  end if;
  if v_s.is_accepting_orders is not true then
    perform private.raise_app('STORE_CLOSED');
  end if;
  -- orders_store_id_request_id_key UNIQUE (store_id, request_id).
  select * into v_existing from public.orders where store_id = p_store_id and request_id = p_request_id;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  select * into v_meta from public.order_client_meta where order_id = v_existing.id;
  if v_meta.device_hash is distinct from p_device_hash
     or v_existing.table_id is distinct from p_table_id
     or v_meta.request_hash is distinct from p_request_hash then
    return jsonb_build_object('status', 'mismatch', 'code', 'IDEMPOTENCY_KEY_REUSED');
  end if;
  -- No order content or token mutation: caller must use the authoritative RPC.
  return jsonb_build_object('status', 'replay');
end $$;
revoke execute on function public.customer_check_replay(uuid,uuid,integer,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.customer_check_replay(uuid,uuid,integer,uuid,text,text) to customer_api;
