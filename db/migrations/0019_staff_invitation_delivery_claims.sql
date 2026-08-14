begin;

-- Cognito delivery is external I/O. A durable claim is committed before the
-- call so concurrent HTTP retries with the same Idempotency-Key cannot both
-- send an invitation. The table is private and contains no email/name.
create table app_private.staff_invitation_delivery_claims (
  tenant_id uuid not null,
  actor_user_id uuid not null references public.app_users(id) on delete restrict,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  membership_id uuid not null,
  invitation_id uuid not null,
  claim_token uuid,
  status text not null check (status in ('available', 'in_progress', 'ambiguous', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Za-z0-9_]{1,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (tenant_id, actor_user_id, idempotency_key),
  foreign key (tenant_id, membership_id)
    references public.memberships(tenant_id, id) on delete restrict,
  foreign key (tenant_id, invitation_id)
    references public.staff_invitations(tenant_id, id) on delete restrict,
  check (expires_at <= created_at + interval '24 hours'),
  check (
    (status = 'in_progress' and claim_token is not null and lease_expires_at is not null)
    or status <> 'in_progress'
  ),
  check ((status in ('succeeded', 'failed')) = (completed_at is not null))
);

create index staff_invitation_delivery_claims_expiry_idx
  on app_private.staff_invitation_delivery_claims (expires_at, tenant_id);

revoke all on app_private.staff_invitation_delivery_claims from public;

create or replace function app_private.claim_staff_invitation_delivery(
  requested_membership_id uuid,
  requested_invitation_id uuid,
  requested_idempotency_key text,
  requested_fingerprint text,
  requested_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_id_value uuid := app_private.current_tenant_id();
  actor_id_value uuid := app_private.current_user_id();
  claim app_private.staff_invitation_delivery_claims%rowtype;
begin
  if tenant_id_value is null or actor_id_value is null
     or requested_membership_id is null or requested_invitation_id is null
     or requested_claim_token is null
     or requested_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
     or requested_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid invitation delivery claim';
  end if;
  if not app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
     or not app_private.can_view_staff_membership(requested_membership_id)
     or not exists (
       select 1 from public.staff_invitations invitation
       where invitation.tenant_id = tenant_id_value
         and invitation.id = requested_invitation_id
         and invitation.membership_id = requested_membership_id
         and invitation.status in ('pending', 'failed', 'sent')
     ) then
    raise exception using errcode = '42501', message = 'invitation delivery claim denied';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant_id_value::text || ':' || requested_invitation_id::text, 0)
  );
  -- A lease expiring does not prove that Cognito rejected the request. The
  -- process may have stopped after Cognito sent the email but before the DB
  -- commit. Freeze that invitation for owner-led reconciliation instead of
  -- risking an automatic duplicate send.
  update app_private.staff_invitation_delivery_claims stale_claim
  set status = 'ambiguous',
      claim_token = null,
      lease_expires_at = null,
      safe_error_code = 'DELIVERY_OUTCOME_UNKNOWN',
      updated_at = now()
  where stale_claim.tenant_id = tenant_id_value
    and stale_claim.invitation_id = requested_invitation_id
    and stale_claim.status = 'in_progress'
    and stale_claim.lease_expires_at <= now();

  if exists (
    select 1
    from app_private.staff_invitation_delivery_claims ambiguous_claim
    where ambiguous_claim.tenant_id = tenant_id_value
      and ambiguous_claim.invitation_id = requested_invitation_id
      and ambiguous_claim.status = 'ambiguous'
  ) then
    return 'reconciliation_required';
  end if;

  if exists (
    select 1
    from app_private.staff_invitation_delivery_claims active_claim
    where active_claim.tenant_id = tenant_id_value
      and active_claim.invitation_id = requested_invitation_id
      and active_claim.status = 'in_progress'
      and not (
        active_claim.actor_user_id = actor_id_value
        and active_claim.idempotency_key = requested_idempotency_key
        and active_claim.claim_token = requested_claim_token
      )
  ) then
    return 'busy';
  end if;

  delete from app_private.staff_invitation_delivery_claims expired
  where (expired.tenant_id, expired.actor_user_id, expired.idempotency_key) in (
    select candidate.tenant_id, candidate.actor_user_id, candidate.idempotency_key
    from app_private.staff_invitation_delivery_claims candidate
    where candidate.expires_at <= now()
      and candidate.status not in ('in_progress', 'ambiguous')
    order by candidate.expires_at
    limit 100
    for update skip locked
  );

  insert into app_private.staff_invitation_delivery_claims (
    tenant_id, actor_user_id, idempotency_key, request_fingerprint,
    membership_id, invitation_id, status
  ) values (
    tenant_id_value, actor_id_value, requested_idempotency_key,
    requested_fingerprint, requested_membership_id, requested_invitation_id,
    'available'
  ) on conflict (tenant_id, actor_user_id, idempotency_key) do nothing;

  select * into claim
  from app_private.staff_invitation_delivery_claims existing
  where existing.tenant_id = tenant_id_value
    and existing.actor_user_id = actor_id_value
    and existing.idempotency_key = requested_idempotency_key
  for update;

  if claim.request_fingerprint is distinct from requested_fingerprint
     or claim.membership_id is distinct from requested_membership_id
     or claim.invitation_id is distinct from requested_invitation_id then
    raise exception using errcode = '22023', message = 'idempotency key belongs to a different invitation request';
  end if;
  if claim.status = 'succeeded' then return 'replayed'; end if;
  if claim.status = 'ambiguous' then return 'reconciliation_required'; end if;
  if claim.status = 'in_progress' then return 'busy'; end if;

  update app_private.staff_invitation_delivery_claims
  set status = 'in_progress',
      claim_token = requested_claim_token,
      lease_expires_at = now() + interval '2 minutes',
      attempt_count = attempt_count + 1,
      safe_error_code = null,
      completed_at = null,
      updated_at = now()
  where tenant_id = tenant_id_value
    and actor_user_id = actor_id_value
    and idempotency_key = requested_idempotency_key;
  return 'claimed';
end
$$;

-- Break-glass reconciliation is intentionally owner-only. Before invoking it,
-- operations must inspect CloudTrail/Cognito delivery evidence and record the
-- approved incident ticket. Web/provisioner roles are never granted EXECUTE.
create or replace function app_private.reconcile_staff_invitation_delivery_claim(
  requested_tenant_id uuid,
  requested_invitation_id uuid,
  requested_operator_user_id uuid,
  delivery_succeeded boolean,
  delivered_cognito_username text,
  requested_safe_error_code text,
  requested_incident_reference text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_membership_id uuid;
  target_facility_id uuid;
begin
  if requested_tenant_id is null or requested_invitation_id is null
     or requested_operator_user_id is null
     or coalesce(requested_incident_reference, '') !~ '^[A-Za-z0-9._:/-]{3,100}$'
     or (delivery_succeeded and btrim(coalesce(delivered_cognito_username, '')) = '')
     or (not delivery_succeeded and coalesce(requested_safe_error_code, '') !~ '^[A-Za-z0-9_]{1,100}$') then
    raise exception using errcode = '22023', message = 'invalid invitation delivery reconciliation';
  end if;
  if not exists (
    select 1
    from public.memberships operator_membership
    join public.app_users operator_user
      on operator_user.id = operator_membership.user_id
    where operator_membership.tenant_id = requested_tenant_id
      and operator_membership.user_id = requested_operator_user_id
      and operator_membership.role = 'tenant_admin'
      and operator_membership.status = 'active'
      and operator_user.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'active tenant administrator is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_tenant_id::text || ':' || requested_invitation_id::text, 0)
  );
  if not exists (
    select 1
    from app_private.staff_invitation_delivery_claims claim
    where claim.tenant_id = requested_tenant_id
      and claim.invitation_id = requested_invitation_id
      and claim.status = 'ambiguous'
  ) then
    raise exception using errcode = 'P0002', message = 'ambiguous invitation delivery was not found';
  end if;

  update public.staff_invitations invitation
  set status = case when delivery_succeeded then 'sent' else 'failed' end,
      cognito_username = case
        when delivery_succeeded then btrim(delivered_cognito_username)
        else invitation.cognito_username
      end,
      delivery_error_code = case
        when delivery_succeeded then null
        else requested_safe_error_code
      end,
      last_delivery_at = now()
  where invitation.tenant_id = requested_tenant_id
    and invitation.id = requested_invitation_id
    and invitation.status in ('pending', 'failed', 'sent')
  returning invitation.membership_id into target_membership_id;
  if target_membership_id is null then
    raise exception using errcode = 'P0002', message = 'staff invitation was not found';
  end if;

  update app_private.staff_invitation_delivery_claims claim
  set status = case when delivery_succeeded then 'succeeded' else 'failed' end,
      safe_error_code = case when delivery_succeeded then null else requested_safe_error_code end,
      claim_token = null,
      lease_expires_at = null,
      completed_at = now(),
      updated_at = now()
  where claim.tenant_id = requested_tenant_id
    and claim.invitation_id = requested_invitation_id
    and claim.status = 'ambiguous';

  for target_facility_id in
    select membership_facility.facility_id
    from public.membership_facilities membership_facility
    where membership_facility.tenant_id = requested_tenant_id
      and membership_facility.membership_id = target_membership_id
    order by membership_facility.facility_id
  loop
    insert into public.audit_events (
      id, tenant_id, facility_id, actor_user_id, action, resource_type,
      resource_id, request_id, outcome, changed_fields, metadata
    ) values (
      pg_catalog.gen_random_uuid(), requested_tenant_id, target_facility_id,
      requested_operator_user_id, 'staff.invitation_delivery_reconciled',
      'staff_membership', target_membership_id,
      left('break-glass:' || requested_incident_reference, 255), 'success',
      array['invitation.status'],
      jsonb_build_object(
        'deliveryOutcome', case when delivery_succeeded then 'succeeded' else 'failed' end,
        'incidentReference', requested_incident_reference
      )
    );
  end loop;

  if not exists (
    select 1 from public.membership_facilities membership_facility
    where membership_facility.tenant_id = requested_tenant_id
      and membership_facility.membership_id = target_membership_id
  ) then
    insert into public.audit_events (
      id, tenant_id, facility_id, actor_user_id, action, resource_type,
      resource_id, request_id, outcome, changed_fields, metadata
    ) values (
      pg_catalog.gen_random_uuid(), requested_tenant_id, null,
      requested_operator_user_id, 'staff.invitation_delivery_reconciled',
      'staff_membership', target_membership_id,
      left('break-glass:' || requested_incident_reference, 255), 'success',
      array['invitation.status'],
      jsonb_build_object(
        'deliveryOutcome', case when delivery_succeeded then 'succeeded' else 'failed' end,
        'incidentReference', requested_incident_reference
      )
    );
  end if;
end
$$;

create or replace function app_private.complete_staff_invitation_delivery_claim(
  requested_claim_token uuid,
  delivery_succeeded boolean,
  requested_safe_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if requested_claim_token is null
     or (not delivery_succeeded and coalesce(requested_safe_error_code, '') !~ '^[A-Za-z0-9_]{1,100}$') then
    raise exception using errcode = '22023', message = 'invalid invitation delivery result';
  end if;
  update app_private.staff_invitation_delivery_claims claim
  set status = case when delivery_succeeded then 'succeeded' else 'failed' end,
      safe_error_code = case when delivery_succeeded then null else requested_safe_error_code end,
      claim_token = null,
      lease_expires_at = null,
      completed_at = now(),
      updated_at = now()
  where claim.tenant_id = app_private.current_tenant_id()
    and claim.actor_user_id = app_private.current_user_id()
    and claim.claim_token = requested_claim_token
    and claim.status = 'in_progress'
    and claim.lease_expires_at > now();
  if not found then
    raise exception using errcode = '40001', message = 'invitation delivery claim is no longer current';
  end if;
end
$$;

create or replace function app_private.mark_staff_invitation_delivery_claim_ambiguous(
  requested_claim_token uuid,
  requested_safe_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if requested_claim_token is null
     or coalesce(requested_safe_error_code, '') !~ '^[A-Za-z0-9_]{1,100}$' then
    raise exception using errcode = '22023', message = 'invalid ambiguous invitation delivery result';
  end if;
  update app_private.staff_invitation_delivery_claims claim
  set status = 'ambiguous',
      safe_error_code = requested_safe_error_code,
      claim_token = null,
      lease_expires_at = null,
      completed_at = null,
      updated_at = now()
  where claim.tenant_id = app_private.current_tenant_id()
    and claim.actor_user_id = app_private.current_user_id()
    and claim.claim_token = requested_claim_token
    and claim.status = 'in_progress';
  if not found then
    raise exception using errcode = '40001', message = 'invitation delivery claim is no longer current';
  end if;
end
$$;

revoke all on function app_private.claim_staff_invitation_delivery(uuid, uuid, text, text, uuid) from public;
revoke all on function app_private.complete_staff_invitation_delivery_claim(uuid, boolean, text) from public;
revoke all on function app_private.mark_staff_invitation_delivery_claim_ambiguous(uuid, text) from public;
revoke all on function app_private.reconcile_staff_invitation_delivery_claim(
  uuid, uuid, uuid, boolean, text, text, text
) from public;

commit;
