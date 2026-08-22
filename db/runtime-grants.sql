-- Run as the migration/table owner after all migrations.
-- Runtime and initial-tenant provisioner roles start NOLOGIN. The one-off
-- migration runner promotes only these two least-privilege roles to LOGIN
-- using separate passwords held in AWS Secrets Manager.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'michinote_runtime') then
    create role michinote_runtime nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'michinote_provisioner') then
    create role michinote_provisioner nologin noinherit nobypassrls;
  end if;
end
$$;

grant execute on function app_private.resolve_local_login(text) to michinote_runtime;
grant execute on function app_private.record_local_login_attempt(uuid, boolean) to michinote_runtime;
grant execute on function app_private.request_local_password_setup(text, text) to michinote_runtime;
grant execute on function app_private.consume_local_password_setup(text, text) to michinote_runtime;
grant execute on function app_private.request_local_open_signup(uuid, text, text, text) to michinote_runtime;
grant execute on function app_private.consume_local_password_setup_result(text, text) to michinote_runtime;

create or replace function app_private.configure_runtime_login(runtime_verifier text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  runtime_role pg_catalog.pg_roles%rowtype;
begin
  -- Even an accidental EXECUTE grant must not let another session rotate the
  -- runtime credential. The migration/table owner is the only valid caller.
  if session_user <> current_user then
    raise exception using errcode = '42501', message = 'runtime login configuration is owner-only';
  end if;
  if runtime_verifier is null
     or runtime_verifier !~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$' then
    raise exception using errcode = '22023', message = 'invalid runtime credential verifier';
  end if;

  select *
  into runtime_role
  from pg_catalog.pg_roles
  where rolname = 'michinote_runtime';

  if not found
     or runtime_role.rolsuper
     or runtime_role.rolcreatedb
     or runtime_role.rolcreaterole
     or runtime_role.rolreplication
     or runtime_role.rolbypassrls
     or exists (
       select 1
       from pg_catalog.pg_auth_members
       where member = runtime_role.oid
     ) then
    -- Refuse a pre-existing or tampered role instead of attempting to repair
    -- elevated attributes with the RDS non-superuser master account.
    raise exception using errcode = '42501', message = 'runtime role violates the least-privilege contract';
  end if;

  -- The verifier is derived client-side from the generated 48-character
  -- password. The plaintext secret never appears in SQL text or server logs.
  execute format(
    'alter role %I with login noinherit password %L valid until %L',
    'michinote_runtime',
    runtime_verifier,
    'infinity'
  );
end
$$;

create or replace function app_private.configure_provisioner_login(provisioner_verifier text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  provisioner_role pg_catalog.pg_roles%rowtype;
begin
  if session_user <> current_user then
    raise exception using errcode = '42501', message = 'provisioner login configuration is owner-only';
  end if;
  if provisioner_verifier is null
     or provisioner_verifier !~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$' then
    raise exception using errcode = '22023', message = 'invalid provisioner credential verifier';
  end if;

  select *
  into provisioner_role
  from pg_catalog.pg_roles
  where rolname = 'michinote_provisioner';

  if not found
     or provisioner_role.rolsuper
     or provisioner_role.rolcreatedb
     or provisioner_role.rolcreaterole
     or provisioner_role.rolreplication
     or provisioner_role.rolbypassrls
     or exists (
       select 1
       from pg_catalog.pg_auth_members
       where member = provisioner_role.oid
     ) then
    raise exception using errcode = '42501', message = 'provisioner role violates the least-privilege contract';
  end if;

  execute format(
    'alter role %I with login noinherit password %L valid until %L',
    'michinote_provisioner',
    provisioner_verifier,
    'infinity'
  );
end
$$;

revoke all on function app_private.configure_runtime_login(text)
from public, michinote_runtime, michinote_provisioner;
revoke all on function app_private.configure_provisioner_login(text)
from public, michinote_runtime, michinote_provisioner;

revoke all on schema public from public;
revoke all on all tables in schema public from public;
revoke all on all functions in schema public from public;
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Clear that
-- default from the private schema before assigning the exact runtime and
-- provisioner allowlists below.
revoke all on all functions in schema app_private
from public, michinote_runtime, michinote_provisioner;

grant usage on schema public, app_private to michinote_runtime;
grant usage on schema app_private to michinote_provisioner;

grant select on
  public.organizations,
  public.facilities,
  public.app_users,
  public.memberships,
  public.membership_facilities,
  public.children,
  public.guardians,
  public.family_members,
  public.institutions,
  public.child_institution_relations,
  public.schedule_versions,
  public.schedule_items,
  public.case_documents,
  public.document_goals,
  public.daily_logs,
  public.daily_log_goals,
  public.contact_book_entries,
  public.monitoring_goal_results,
  public.reference_material_attachments,
  public.document_events,
  public.document_snapshots,
  public.document_snapshot_jobs,
  public.document_consent_records,
  public.document_consent_sources,
  public.document_distribution_records,
  public.audit_events,
  public.staff_invitations
to michinote_runtime;

grant insert, update on
  public.facilities,
  public.children,
  public.guardians,
  public.family_members,
  public.institutions,
  public.child_institution_relations,
  public.schedule_versions,
  public.schedule_items,
  public.case_documents,
  public.daily_logs,
  public.contact_book_entries,
  public.monitoring_goal_results,
  public.reference_material_attachments
to michinote_runtime;

grant insert, delete on public.daily_log_goals to michinote_runtime;
grant delete on public.schedule_items to michinote_runtime;
grant insert, update, delete on public.document_goals to michinote_runtime;

grant select, insert, update, delete on app_private.sessions to michinote_runtime;
grant select, insert, update, delete on app_private.idempotency_records to michinote_runtime;

revoke all on app_private.security_auth_events from michinote_runtime;
grant execute on function app_private.append_security_auth_event(uuid, text, text, text, text) to michinote_runtime;
grant execute on function app_private.purge_retired_security_auth_events(integer) to michinote_runtime;
grant execute on function app_private.purge_retired_sessions(integer) to michinote_runtime;

grant execute on function app_private.current_tenant_id() to michinote_runtime;
grant execute on function app_private.current_user_id() to michinote_runtime;
grant execute on function app_private.has_tenant_role(text[]) to michinote_runtime;
grant execute on function app_private.can_access_facility(uuid) to michinote_runtime;
grant execute on function app_private.can_view_staff_membership(uuid) to michinote_runtime;
grant execute on function app_private.can_access_child(uuid) to michinote_runtime;
grant execute on function app_private.can_access_document(uuid) to michinote_runtime;
grant execute on function app_private.can_access_schedule(uuid) to michinote_runtime;
grant execute on function app_private.can_access_daily_log(uuid) to michinote_runtime;
grant execute on function app_private.lock_document_for_pdf(uuid, uuid) to michinote_runtime;
grant execute on function app_private.append_audit_event(uuid, uuid, text, text, uuid, text, text, text, text, text[], jsonb) to michinote_runtime;
grant execute on function app_private.append_document_event(uuid, uuid, text, text, jsonb) to michinote_runtime;
grant execute on function app_private.append_document_consent(
  uuid, uuid, bigint, text, text, text, timestamptz, timestamptz
) to michinote_runtime;
grant execute on function app_private.append_document_distribution(uuid, uuid, bigint, text, text, timestamptz) to michinote_runtime;
grant execute on function app_private.resolve_cognito_identity(text) to michinote_runtime;
grant execute on function app_private.resolve_cognito_identity(text, text, boolean) to michinote_runtime;
grant execute on function app_private.invite_staff_member(uuid, uuid, uuid, text, text, text, uuid[]) to michinote_runtime;
grant execute on function app_private.mark_staff_invitation_delivery(uuid, boolean, text, text) to michinote_runtime;
grant execute on function app_private.claim_staff_invitation_delivery(uuid, uuid, text, text, uuid) to michinote_runtime;
grant execute on function app_private.complete_staff_invitation_delivery_claim(uuid, boolean, text) to michinote_runtime;
grant execute on function app_private.mark_staff_invitation_delivery_claim_ambiguous(uuid, text) to michinote_runtime;
grant execute on function app_private.update_staff_membership(uuid, text, text, uuid[], bigint) to michinote_runtime;
grant execute on function app_private.purge_expired_idempotency_records(integer) to michinote_runtime;
grant execute on function app_private.create_document_snapshot_job(uuid, uuid, uuid, bigint, text, text, text, uuid, text, uuid, integer, text, text) to michinote_runtime;
grant execute on function app_private.claim_document_snapshot_job(uuid, uuid, integer) to michinote_runtime;
grant execute on function app_private.record_document_snapshot_job_upload(uuid, uuid, text, text, bigint, text) to michinote_runtime;
grant execute on function app_private.fail_document_snapshot_job(uuid, uuid, text) to michinote_runtime;
grant execute on function app_private.finalize_document_snapshot_job(uuid) to michinote_runtime;
grant execute on function app_private.quarantine_stale_document_snapshot_job(uuid) to michinote_runtime;
grant execute on function app_private.backfill_document_snapshot_storage_version(uuid, text, bigint, text) to michinote_runtime;
grant select, insert on public.document_snapshot_blobs to michinote_runtime;
grant execute on function app_private.store_database_document_snapshot_blob(uuid, uuid, text, text, bytea) to michinote_runtime;
grant execute on function app_private.record_database_document_snapshot_job_upload(uuid, uuid) to michinote_runtime;
grant execute on function app_private.read_database_document_snapshot_blob(text, text) to michinote_runtime;
grant execute on function app_private.register_local_user(uuid, text, text, text) to michinote_runtime;

revoke all on function app_private.provision_tenant(uuid, text, uuid, text, text, text, uuid, uuid, text, text)
from michinote_provisioner;

grant execute on function app_private.reconcile_initial_tenant(
  uuid, text, uuid, text, uuid, text, text, text, uuid, uuid, text, text
) to michinote_provisioner;
grant execute on function app_private.claim_initial_admin_invitation_resend(uuid, uuid)
to michinote_provisioner;
grant execute on function app_private.record_initial_admin_invitation_resend_result(
  uuid, uuid, uuid, text
) to michinote_provisioner;
