begin;

-- `append_document_consent` runs as SECURITY DEFINER, but this table is
-- FORCE ROW LEVEL SECURITY so the immutable source insert still needs an
-- explicit policy.  The runtime role has no INSERT grant on this table;
-- records can therefore only be added through the audited consent function.
create policy document_consent_sources_insert on public.document_consent_sources
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

commit;
