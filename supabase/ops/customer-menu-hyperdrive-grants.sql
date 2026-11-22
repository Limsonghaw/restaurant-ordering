-- Apply to the database used by the production menu Hyperdrive binding.
-- The binding currently connects using the role created for the A1 preview.
BEGIN;

GRANT EXECUTE ON FUNCTION
  public.customer_quote(uuid, uuid, integer, jsonb),
  public.customer_get_bill(uuid, uuid, integer, text, text)
TO customer_a1_preview;

COMMIT;
