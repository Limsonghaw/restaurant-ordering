-- L-9: Preview 必须先确认不影响 Supabase 内部角色；如有影响，改为只对
-- customer_api 收回（同时确认 PUBLIC 的继承授权不会使收回失效）。
revoke temporary on database postgres from public;

-- Function configuration takes precedence over a caller's session SET.
-- Signatures match 0002/0003/0004 (and the 0006 place-order replacement).
alter function public.customer_get_menu(uuid, uuid, integer) set statement_timeout = '3s';
alter function public.customer_quote(uuid, uuid, integer, jsonb) set statement_timeout = '3s';
alter function public.customer_place_order(uuid, uuid, integer, uuid, text, jsonb, text, text, text, text, boolean) set statement_timeout = '3s';
alter function public.customer_get_bill(uuid, uuid, integer, text, text) set statement_timeout = '3s';
