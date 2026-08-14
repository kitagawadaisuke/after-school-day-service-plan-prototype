begin;

-- Tenant-global audit rows can contain actor and resource identifiers. They
-- are visible only to tenant administrators; facility-scoped administrators
-- and auditors receive rows explicitly attributed to an assigned facility.
drop policy if exists audit_events_read on public.audit_events;
create policy audit_events_read on public.audit_events
  for select using (
    tenant_id = app_private.current_tenant_id()
    and (
      (
        app_private.has_tenant_role(array['tenant_admin'])
        and (facility_id is null or app_private.can_access_facility(facility_id))
      )
      or (
        facility_id is not null
        and app_private.can_access_facility(facility_id)
        and app_private.has_tenant_role(array['facility_admin', 'auditor'])
      )
    )
  );

commit;
