-- Run once in the restaurant database before setting the role credential.
BEGIN;

CREATE ROLE customer_order_worker NOLOGIN;
GRANT CONNECT ON DATABASE postgres TO customer_order_worker;
GRANT USAGE ON SCHEMA public TO customer_order_worker;
GRANT EXECUTE ON FUNCTION
  public.customer_check_replay(uuid, uuid, integer, uuid, text, text),
  public.customer_place_order(uuid, uuid, integer, uuid, text, jsonb, text, text, text, text, boolean)
TO customer_order_worker;

COMMIT;
