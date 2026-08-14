begin;

-- Keep the database authorization layer aligned with the application RBAC
-- matrix.  plan_approver may review plans and edit case context, but may not
-- change the client master or staff-authored daily/contact records.

drop policy children_write on public.children;
create policy children_write on public.children
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
    and created_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );

drop policy children_update on public.children;
create policy children_update on public.children
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
    and updated_by = app_private.current_user_id()
  );

drop policy guardians_write on public.guardians;
create policy guardians_write on public.guardians
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
  );

drop policy daily_logs_write on public.daily_logs;
create policy daily_logs_write on public.daily_logs
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
    and recorded_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );

drop policy daily_logs_update on public.daily_logs;
create policy daily_logs_update on public.daily_logs
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
    and updated_by = app_private.current_user_id()
  );

drop policy daily_log_goals_write on public.daily_log_goals;
create policy daily_log_goals_write on public.daily_log_goals
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_daily_log(daily_log_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_daily_log(daily_log_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
  );

drop policy contact_book_entries_write on public.contact_book_entries;
create policy contact_book_entries_write on public.contact_book_entries
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
    and recorded_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );

drop policy contact_book_entries_update on public.contact_book_entries;
create policy contact_book_entries_update on public.contact_book_entries
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'support_staff'])
    and updated_by = app_private.current_user_id()
  );

commit;
