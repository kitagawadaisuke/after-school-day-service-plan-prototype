-- Structured fields printed on service-use and support-plan forms. Certificate
-- numbers themselves remain KMS ciphertext in the existing bytea column.

alter table public.children
  add column municipality_name text,
  add column copayment_limit_yen integer
    check (copayment_limit_yen is null or copayment_limit_yen between 0 and 10000000);
