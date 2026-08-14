begin;

-- This receipt is the durable boundary of the Cognito -> PostgreSQL saga. It
-- deliberately lives outside public API grants and stores only stable IDs plus
-- a fingerprint. Exact replay is checked against canonical rows, avoiding an
-- indefinite duplicate copy of names, email and Cognito subject.
create table app_private.tenant_provisioning_receipts (
  operation_id uuid primary key,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null unique references public.organizations(id) on delete restrict,
  administrator_user_id uuid not null unique references public.app_users(id) on delete restrict,
  administrator_membership_id uuid not null unique,
  first_facility_id uuid not null unique,
  completed_at timestamptz not null default now(),
  foreign key (organization_id, administrator_membership_id)
    references public.memberships(tenant_id, id) on delete restrict,
  foreign key (organization_id, first_facility_id)
    references public.facilities(tenant_id, id) on delete restrict
);

revoke all on app_private.tenant_provisioning_receipts from public;

create or replace function app_private.prevent_tenant_provisioning_receipt_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'tenant provisioning receipts are immutable';
end
$$;

create or replace function app_private.claim_initial_admin_invitation_resend(
  requested_onboarding_operation_id uuid,
  requested_resend_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  provisioning_receipt app_private.tenant_provisioning_receipts%rowtype;
  existing_event public.audit_events%rowtype;
begin
  if requested_onboarding_operation_id is null
     or requested_resend_event_id is null
     or requested_onboarding_operation_id = requested_resend_event_id then
    raise exception using errcode = '22023', message = 'distinct onboarding and resend identifiers are required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(requested_resend_event_id::text)
  );
  select *
  into provisioning_receipt
  from app_private.tenant_provisioning_receipts
  where operation_id = requested_onboarding_operation_id;
  if not found then
    raise exception using errcode = '22023', message = 'completed onboarding operation is required before invitation resend';
  end if;

  select *
  into existing_event
  from public.audit_events
  where id = requested_resend_event_id;
  if found then
    if existing_event.tenant_id is distinct from provisioning_receipt.organization_id
       or existing_event.facility_id is distinct from provisioning_receipt.first_facility_id
       or existing_event.resource_id is distinct from provisioning_receipt.administrator_user_id
       or existing_event.action <> 'tenant.initial_admin_invitation_resend_requested'
       or existing_event.metadata ->> 'onboardingOperationId'
          is distinct from requested_onboarding_operation_id::text
       or existing_event.metadata ->> 'resendEventId'
          is distinct from requested_resend_event_id::text then
      raise exception using errcode = '22023', message = 'invitation resend identifier conflicts with existing evidence';
    end if;
    return false;
  end if;

  insert into public.audit_events (
    id, tenant_id, facility_id, actor_user_id, action, resource_type,
    resource_id, request_id, outcome, changed_fields, metadata
  ) values (
    requested_resend_event_id,
    provisioning_receipt.organization_id,
    provisioning_receipt.first_facility_id,
    null,
    'tenant.initial_admin_invitation_resend_requested',
    'app_user',
    provisioning_receipt.administrator_user_id,
    'initial-admin-invitation-resend',
    'success',
    array['cognito_invitation'],
    jsonb_build_object(
      'onboardingOperationId', requested_onboarding_operation_id,
      'resendEventId', requested_resend_event_id,
      'source', 'one_off_onboarding_task'
    )
  );
  return true;
end
$$;

create or replace function app_private.record_initial_admin_invitation_resend_result(
  requested_onboarding_operation_id uuid,
  requested_resend_event_id uuid,
  requested_result_event_id uuid,
  requested_result text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  provisioning_receipt app_private.tenant_provisioning_receipts%rowtype;
  claim_event public.audit_events%rowtype;
  existing_event public.audit_events%rowtype;
begin
  if requested_result not in ('success', 'not_required', 'failed') then
    raise exception using errcode = '22023', message = 'invalid invitation resend result';
  end if;
  if requested_onboarding_operation_id is null
     or requested_resend_event_id is null
     or requested_result_event_id is null
     or requested_result_event_id in (requested_onboarding_operation_id, requested_resend_event_id) then
    raise exception using errcode = '22023', message = 'distinct invitation result identifier is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(requested_result_event_id::text)
  );
  select *
  into provisioning_receipt
  from app_private.tenant_provisioning_receipts
  where operation_id = requested_onboarding_operation_id;
  if not found then
    raise exception using errcode = '22023', message = 'completed onboarding operation is required';
  end if;

  select *
  into claim_event
  from public.audit_events
  where id = requested_resend_event_id;
  if not found
     or claim_event.tenant_id is distinct from provisioning_receipt.organization_id
     or claim_event.action <> 'tenant.initial_admin_invitation_resend_requested'
     or claim_event.metadata ->> 'onboardingOperationId'
        is distinct from requested_onboarding_operation_id::text then
    raise exception using errcode = '22023', message = 'matching invitation resend claim is required';
  end if;

  select *
  into existing_event
  from public.audit_events
  where id = requested_result_event_id;
  if found then
    if existing_event.tenant_id is distinct from provisioning_receipt.organization_id
       or existing_event.action <> 'tenant.initial_admin_invitation_resend_completed'
       or existing_event.metadata ->> 'resendEventId'
          is distinct from requested_resend_event_id::text
       or existing_event.metadata ->> 'result'
          is distinct from requested_result then
      raise exception using errcode = '22023', message = 'invitation resend result identifier conflicts with existing evidence';
    end if;
    return 'unchanged';
  end if;

  insert into public.audit_events (
    id, tenant_id, facility_id, actor_user_id, action, resource_type,
    resource_id, request_id, outcome, changed_fields, metadata
  ) values (
    requested_result_event_id,
    provisioning_receipt.organization_id,
    provisioning_receipt.first_facility_id,
    null,
    'tenant.initial_admin_invitation_resend_completed',
    'app_user',
    provisioning_receipt.administrator_user_id,
    'initial-admin-invitation-resend-result',
    case when requested_result = 'failed' then 'failed' else 'success' end,
    array['cognito_invitation'],
    jsonb_build_object(
      'onboardingOperationId', requested_onboarding_operation_id,
      'resendEventId', requested_resend_event_id,
      'result', requested_result,
      'source', 'one_off_onboarding_task'
    )
  );
  return 'created';
end
$$;

create trigger tenant_provisioning_receipts_immutable
before update or delete on app_private.tenant_provisioning_receipts
for each row execute function app_private.prevent_tenant_provisioning_receipt_mutation();

revoke all on function app_private.prevent_tenant_provisioning_receipt_mutation()
from public;

create or replace function app_private.reconcile_initial_tenant(
  requested_operation_id uuid,
  requested_fingerprint text,
  requested_organization_id uuid,
  requested_organization_name text,
  requested_administrator_user_id uuid,
  requested_administrator_cognito_sub text,
  requested_administrator_email text,
  requested_administrator_display_name text,
  requested_administrator_membership_id uuid,
  requested_first_facility_id uuid,
  requested_first_facility_code text,
  requested_first_facility_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_receipt app_private.tenant_provisioning_receipts%rowtype;
begin
  if requested_operation_id is null
     or requested_organization_id is null
     or requested_administrator_user_id is null
     or requested_administrator_membership_id is null
     or requested_first_facility_id is null then
    raise exception using errcode = '22023', message = 'stable onboarding identifiers are required';
  end if;
  if requested_fingerprint is null
     or requested_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid onboarding request fingerprint';
  end if;
  if requested_organization_name is null
     or requested_organization_name <> btrim(requested_organization_name)
     or char_length(requested_organization_name) not between 1 and 200
     or requested_administrator_display_name is null
     or requested_administrator_display_name <> btrim(requested_administrator_display_name)
     or char_length(requested_administrator_display_name) not between 1 and 200
     or requested_first_facility_name is null
     or requested_first_facility_name <> btrim(requested_first_facility_name)
     or char_length(requested_first_facility_name) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid onboarding display value';
  end if;
  if requested_administrator_email is null
     or requested_administrator_email <> lower(btrim(requested_administrator_email))
     or char_length(requested_administrator_email) not between 3 and 320
     or requested_administrator_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'invalid canonical administrator email';
  end if;
  if requested_administrator_cognito_sub is null
     or requested_administrator_cognito_sub <> btrim(requested_administrator_cognito_sub)
     or char_length(requested_administrator_cognito_sub) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'invalid Cognito subject';
  end if;
  if requested_first_facility_code is null
     or requested_first_facility_code !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid facility code';
  end if;

  -- Serialize one operation so concurrent retries cannot both observe a
  -- missing receipt. The UUID itself is never included in an error message.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(requested_operation_id::text)
  );

  select *
  into existing_receipt
  from app_private.tenant_provisioning_receipts
  where operation_id = requested_operation_id;

  if found then
    if existing_receipt.request_fingerprint is distinct from requested_fingerprint
       or existing_receipt.organization_id is distinct from requested_organization_id
       or existing_receipt.administrator_user_id is distinct from requested_administrator_user_id
       or existing_receipt.administrator_membership_id is distinct from requested_administrator_membership_id
       or existing_receipt.first_facility_id is distinct from requested_first_facility_id then
      raise exception using
        errcode = '22023',
        message = 'onboarding operation does not match its completed request';
    end if;

    -- Do not duplicate names or contact data in an indefinite receipt. The
    -- canonical rows provide the exact replay comparison. A later business
    -- edit intentionally makes the onboarding operation non-replayable.
    if not exists (
      select 1
      from public.organizations organization
      join public.app_users administrator
        on administrator.id = requested_administrator_user_id
      join public.memberships membership
        on membership.id = requested_administrator_membership_id
       and membership.tenant_id = organization.id
       and membership.user_id = administrator.id
      join public.facilities facility
        on facility.id = requested_first_facility_id
       and facility.tenant_id = organization.id
      join public.membership_facilities membership_facility
        on membership_facility.tenant_id = organization.id
       and membership_facility.membership_id = membership.id
       and membership_facility.facility_id = facility.id
      where organization.id = requested_organization_id
        and organization.name = requested_organization_name
        and organization.status = 'active'
        and administrator.cognito_sub = requested_administrator_cognito_sub
        and administrator.email = requested_administrator_email
        and administrator.display_name = requested_administrator_display_name
        and administrator.status = 'active'
        and membership.role = 'tenant_admin'
        and membership.status = 'active'
        and facility.code = requested_first_facility_code
        and facility.name = requested_first_facility_name
        and facility.status = 'active'
    ) then
      raise exception using
        errcode = '55000',
        message = 'completed onboarding state no longer matches the original request';
    end if;

    return jsonb_build_object(
      'outcome', 'unchanged',
      'operationId', existing_receipt.operation_id,
      'tenantId', existing_receipt.organization_id,
      'userId', existing_receipt.administrator_user_id,
      'membershipId', existing_receipt.administrator_membership_id,
      'facilityId', existing_receipt.first_facility_id,
      'completedAt', existing_receipt.completed_at
    );
  end if;

  insert into public.organizations (id, name, status)
  values (requested_organization_id, requested_organization_name, 'active');

  insert into public.app_users (id, cognito_sub, email, display_name, status)
  values (
    requested_administrator_user_id,
    requested_administrator_cognito_sub,
    requested_administrator_email,
    requested_administrator_display_name,
    'active'
  );

  insert into public.memberships (
    id, tenant_id, user_id, role, status, invited_at, joined_at
  ) values (
    requested_administrator_membership_id,
    requested_organization_id,
    requested_administrator_user_id,
    'tenant_admin',
    'active',
    now(),
    now()
  );

  insert into public.facilities (id, tenant_id, code, name, status)
  values (
    requested_first_facility_id,
    requested_organization_id,
    requested_first_facility_code,
    requested_first_facility_name,
    'active'
  );

  insert into public.membership_facilities (tenant_id, membership_id, facility_id)
  values (
    requested_organization_id,
    requested_administrator_membership_id,
    requested_first_facility_id
  );

  -- This append-only event exists before the first human authentication. The
  -- actor is intentionally NULL (system operation), and no name/email is
  -- copied into the audit payload or request identifier.
  insert into public.audit_events (
    id, tenant_id, facility_id, actor_user_id, action, resource_type,
    resource_id, request_id, outcome, changed_fields, metadata
  ) values (
    requested_operation_id,
    requested_organization_id,
    requested_first_facility_id,
    null,
    'tenant.initial_provisioning_completed',
    'organization',
    requested_organization_id,
    'initial-tenant-onboarding',
    'success',
    array['organization', 'facility', 'tenant_admin'],
    jsonb_build_object(
      'operationId', requested_operation_id,
      'administratorUserId', requested_administrator_user_id,
      'membershipId', requested_administrator_membership_id,
      'facilityId', requested_first_facility_id,
      'source', 'one_off_onboarding_task'
    )
  );

  insert into app_private.tenant_provisioning_receipts (
    operation_id,
    request_fingerprint,
    organization_id,
    administrator_user_id,
    administrator_membership_id,
    first_facility_id
  ) values (
    requested_operation_id,
    requested_fingerprint,
    requested_organization_id,
    requested_administrator_user_id,
    requested_administrator_membership_id,
    requested_first_facility_id
  )
  returning * into existing_receipt;

  return jsonb_build_object(
    'outcome', 'created',
    'operationId', existing_receipt.operation_id,
    'tenantId', existing_receipt.organization_id,
    'userId', existing_receipt.administrator_user_id,
    'membershipId', existing_receipt.administrator_membership_id,
    'facilityId', existing_receipt.first_facility_id,
    'completedAt', existing_receipt.completed_at
  );
exception
  when unique_violation or foreign_key_violation then
    raise exception using
      errcode = '23505',
      message = 'onboarding identifiers conflict with existing data';
end
$$;

revoke all on function app_private.reconcile_initial_tenant(
  uuid, text, uuid, text, uuid, text, text, text, uuid, uuid, text, text
) from public;
revoke all on function app_private.claim_initial_admin_invitation_resend(uuid, uuid)
from public;
revoke all on function app_private.record_initial_admin_invitation_resend_result(
  uuid, uuid, uuid, text
) from public;

-- The old ten-argument bootstrap helper remains available to the migration
-- owner for deterministic test fixtures only. A LOGIN role can call only the
-- exact, receipt-backed reconciliation function above.
revoke all on function app_private.provision_tenant(
  uuid, text, uuid, text, text, text, uuid, uuid, text, text
) from public;

commit;
