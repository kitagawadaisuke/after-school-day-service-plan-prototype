begin;

create table public.staff_invitations (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  membership_id uuid not null,
  invited_by uuid not null references public.app_users(id) on delete restrict,
  email_snapshot text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'accepted', 'cancelled')),
  cognito_username text,
  delivery_error_code text,
  invited_at timestamptz not null default now(),
  last_delivery_at timestamptz,
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, membership_id) references public.memberships(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index staff_invitations_membership_idx
  on public.staff_invitations (tenant_id, membership_id, invited_at desc);
create index staff_invitations_status_idx
  on public.staff_invitations (tenant_id, status, invited_at desc);
create index staff_invitations_invited_by_idx on public.staff_invitations (invited_by);

create trigger staff_invitations_bump_row_version
before update on public.staff_invitations
for each row execute function app_private.bump_row_version();

alter table public.staff_invitations enable row level security;
-- Security-definer identity resolution marks accepted invitations before a
-- tenant GUC exists. Runtime roles must never own this table.
alter table public.staff_invitations no force row level security;

create policy staff_invitations_read on public.staff_invitations
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
  );

create or replace function app_private.invite_staff_member(
  invitation_id uuid,
  requested_user_id uuid,
  requested_membership_id uuid,
  requested_email text,
  requested_display_name text,
  requested_role text,
  requested_facility_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_id_value uuid := app_private.current_tenant_id();
  actor_id_value uuid := app_private.current_user_id();
  actor_role_value text;
  normalized_email text := lower(btrim(requested_email));
  normalized_facilities uuid[];
  resolved_user_id uuid;
  resolved_user_status text;
  resolved_cognito_sub text;
  membership_status text;
begin
  select m.role into actor_role_value
  from public.memberships m
  where m.tenant_id = tenant_id_value
    and m.user_id = actor_id_value
    and m.status = 'active';

  if actor_role_value not in ('tenant_admin', 'facility_admin') then
    raise exception using errcode = '42501', message = 'staff management permission is required';
  end if;
  if normalized_email = '' or requested_display_name is null or btrim(requested_display_name) = '' then
    raise exception using errcode = '22023', message = 'email and display name are required';
  end if;
  if requested_role not in ('tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor') then
    raise exception using errcode = '22023', message = 'invalid staff role';
  end if;
  if actor_role_value = 'facility_admin'
     and requested_role in ('tenant_admin', 'facility_admin', 'auditor') then
    raise exception using errcode = '42501', message = 'facility administrator cannot grant the requested role';
  end if;

  select coalesce(array_agg(distinct facility_id order by facility_id), '{}'::uuid[])
    into normalized_facilities
  from unnest(coalesce(requested_facility_ids, '{}'::uuid[])) as facility_id;

  if requested_role <> 'tenant_admin' and cardinality(normalized_facilities) = 0 then
    raise exception using errcode = '22023', message = 'at least one facility is required for this role';
  end if;
  if exists (
    select 1 from unnest(normalized_facilities) as requested_facility_id
    where not app_private.can_access_facility(requested_facility_id)
  ) then
    raise exception using errcode = '42501', message = 'facility access denied';
  end if;

  select u.id, u.status, u.cognito_sub
    into resolved_user_id, resolved_user_status, resolved_cognito_sub
  from public.app_users u
  where lower(u.email) = normalized_email
  for update;

  if resolved_user_id is null then
    resolved_user_id := requested_user_id;
    resolved_user_status := 'invited';
    insert into public.app_users (id, email, display_name, status)
    values (resolved_user_id, normalized_email, btrim(requested_display_name), 'invited');
  elsif resolved_user_status in ('suspended', 'disabled') then
    raise exception using errcode = '55000', message = 'staff account is not available';
  end if;

  membership_status := case
    when resolved_user_status = 'active' and resolved_cognito_sub is not null then 'active'
    else 'invited'
  end;

  insert into public.memberships (
    id, tenant_id, user_id, role, status, invited_at, joined_at
  ) values (
    requested_membership_id,
    tenant_id_value,
    resolved_user_id,
    requested_role,
    membership_status,
    now(),
    case when membership_status = 'active' then now() else null end
  );

  insert into public.membership_facilities (tenant_id, membership_id, facility_id)
  select tenant_id_value, requested_membership_id, facility_id
  from unnest(normalized_facilities) as facility_id;

  insert into public.staff_invitations (
    id, tenant_id, membership_id, invited_by, email_snapshot, status, accepted_at
  ) values (
    invitation_id,
    tenant_id_value,
    requested_membership_id,
    actor_id_value,
    normalized_email,
    case when membership_status = 'active' then 'accepted' else 'pending' end,
    case when membership_status = 'active' then now() else null end
  );

  return jsonb_build_object(
    'invitationId', invitation_id,
    'userId', resolved_user_id,
    'membershipId', requested_membership_id,
    'email', normalized_email,
    'displayName', requested_display_name,
    'role', requested_role,
    'status', membership_status,
    'facilityIds', normalized_facilities,
    'requiresCognitoInvitation', membership_status = 'invited'
  );
end
$$;

create or replace function app_private.mark_staff_invitation_delivery(
  requested_invitation_id uuid,
  delivery_succeeded boolean,
  delivered_cognito_username text,
  safe_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app_private.has_tenant_role(array['tenant_admin', 'facility_admin']) then
    raise exception using errcode = '42501', message = 'staff management permission is required';
  end if;
  update public.staff_invitations
  set status = case when delivery_succeeded then 'sent' else 'failed' end,
      cognito_username = case when delivery_succeeded then nullif(delivered_cognito_username, '') else cognito_username end,
      delivery_error_code = case when delivery_succeeded then null else left(nullif(safe_error_code, ''), 100) end,
      last_delivery_at = now()
  where tenant_id = app_private.current_tenant_id()
    and id = requested_invitation_id
    and status in ('pending', 'failed', 'sent');
  if not found then
    raise exception using errcode = 'P0002', message = 'staff invitation not found';
  end if;
end
$$;

create or replace function app_private.update_staff_membership(
  requested_membership_id uuid,
  requested_role text,
  requested_status text,
  requested_facility_ids uuid[],
  requested_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_id_value uuid := app_private.current_tenant_id();
  actor_id_value uuid := app_private.current_user_id();
  actor_role_value text;
  target_user_id uuid;
  target_role_value text;
  target_status_value text;
  target_row_version bigint;
  normalized_facilities uuid[];
begin
  -- Serialize membership updates per tenant. Without this lock two
  -- administrators could concurrently demote one another and both observe an
  -- active peer, violating the last-administrator invariant (write skew).
  perform 1
  from public.organizations o
  where o.id = tenant_id_value
  for update;

  select m.role into actor_role_value
  from public.memberships m
  where m.tenant_id = tenant_id_value and m.user_id = actor_id_value and m.status = 'active';
  if actor_role_value not in ('tenant_admin', 'facility_admin') then
    raise exception using errcode = '42501', message = 'staff management permission is required';
  end if;
  if requested_role not in ('tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor')
     or requested_status not in ('active', 'suspended', 'ended') then
    raise exception using errcode = '22023', message = 'invalid staff role or status';
  end if;

  select m.user_id, m.role, m.status, m.row_version
    into target_user_id, target_role_value, target_status_value, target_row_version
  from public.memberships m
  where m.tenant_id = tenant_id_value and m.id = requested_membership_id
  for update;
  if target_user_id is null then
    raise exception using errcode = 'P0002', message = 'staff membership not found';
  end if;
  if requested_expected_version is not null
     and target_row_version <> requested_expected_version then
    raise exception using errcode = '40001', message = 'staff membership edit conflict';
  end if;
  if target_status_value = 'invited' and requested_status = 'active' then
    raise exception using errcode = '55000', message = 'Cognito acceptance is required before activation';
  end if;
  if actor_role_value = 'facility_admin' and (
       target_role_value in ('tenant_admin', 'facility_admin', 'auditor')
       or requested_role in ('tenant_admin', 'facility_admin', 'auditor')
     ) then
    raise exception using errcode = '42501', message = 'facility administrator cannot manage the requested role';
  end if;
  if actor_role_value = 'facility_admin' and (
    not exists (
      select 1
      from public.membership_facilities target_facility
      where target_facility.tenant_id = tenant_id_value
        and target_facility.membership_id = requested_membership_id
    )
    or exists (
      select 1
      from public.membership_facilities target_facility
      where target_facility.tenant_id = tenant_id_value
        and target_facility.membership_id = requested_membership_id
        and not app_private.can_access_facility(target_facility.facility_id)
    )
  ) then
    raise exception using errcode = '42501', message = 'staff membership is not wholly inside managed facilities';
  end if;

  select coalesce(array_agg(distinct facility_id order by facility_id), '{}'::uuid[])
    into normalized_facilities
  from unnest(coalesce(requested_facility_ids, '{}'::uuid[])) as facility_id;
  if requested_role <> 'tenant_admin' and cardinality(normalized_facilities) = 0 then
    raise exception using errcode = '22023', message = 'at least one facility is required for this role';
  end if;
  if exists (
    select 1 from unnest(normalized_facilities) as requested_facility_id
    where not app_private.can_access_facility(requested_facility_id)
  ) then
    raise exception using errcode = '42501', message = 'facility access denied';
  end if;

  if target_role_value = 'tenant_admin'
     and (requested_role <> 'tenant_admin' or requested_status <> 'active')
     and not exists (
       select 1 from public.memberships other_admin
       where other_admin.tenant_id = tenant_id_value
         and other_admin.id <> requested_membership_id
         and other_admin.role = 'tenant_admin'
         and other_admin.status = 'active'
     ) then
    raise exception using errcode = '23514', message = 'tenant must retain an active administrator';
  end if;

  update public.memberships
  set role = requested_role,
      status = requested_status,
      joined_at = case when requested_status = 'active' then coalesce(joined_at, now()) else joined_at end,
      ended_at = case when requested_status = 'ended' then now() else null end
  where tenant_id = tenant_id_value and id = requested_membership_id;

  delete from public.membership_facilities
  where tenant_id = tenant_id_value and membership_id = requested_membership_id;
  insert into public.membership_facilities (tenant_id, membership_id, facility_id)
  select tenant_id_value, requested_membership_id, facility_id
  from unnest(normalized_facilities) as facility_id;

  return jsonb_build_object(
    'membershipId', requested_membership_id,
    'userId', target_user_id,
    'role', requested_role,
    'status', requested_status,
    'facilityIds', normalized_facilities
  );
end
$$;

create or replace function app_private.resolve_cognito_identity(
  external_subject text,
  verified_email text,
  email_is_verified boolean
)
returns table (
  user_id uuid,
  tenant_id uuid,
  role text,
  display_name text,
  facility_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  resolved_user_id uuid;
begin
  if external_subject is null or external_subject = '' then return; end if;

  select u.id into resolved_user_id
  from public.app_users u
  where u.cognito_sub = external_subject and u.status = 'active'
  for update;

  if resolved_user_id is null and coalesce(email_is_verified, false)
     and verified_email is not null and btrim(verified_email) <> '' then
    select u.id into resolved_user_id
    from public.app_users u
    where u.cognito_sub is null
      and lower(u.email) = lower(btrim(verified_email))
      and u.status = 'invited'
    for update;
    if resolved_user_id is not null then
      update public.app_users
      set cognito_sub = external_subject, status = 'active', last_login_at = now()
      where id = resolved_user_id;
      update public.memberships m
      set status = 'active', joined_at = coalesce(m.joined_at, now())
      where m.user_id = resolved_user_id and m.status = 'invited';
      update public.staff_invitations si
      set status = 'accepted', accepted_at = now()
      from public.memberships m
      where m.user_id = resolved_user_id
        and si.tenant_id = m.tenant_id
        and si.membership_id = m.id
        and si.status in ('pending', 'sent', 'failed');
    end if;
  end if;

  if resolved_user_id is null then return; end if;
  update public.app_users set last_login_at = now() where id = resolved_user_id;

  return query
  select
    u.id,
    m.tenant_id,
    m.role,
    u.display_name,
    coalesce(
      array_agg(mf.facility_id order by mf.facility_id)
        filter (where mf.facility_id is not null),
      '{}'::uuid[]
    )
  from public.app_users u
  join public.memberships m on m.user_id = u.id
  join public.organizations o on o.id = m.tenant_id
  left join public.membership_facilities mf
    on mf.tenant_id = m.tenant_id and mf.membership_id = m.id
  where u.id = resolved_user_id
    and u.status = 'active'
    and m.status = 'active'
    and o.status = 'active'
  group by u.id, m.tenant_id, m.role, u.display_name, m.joined_at, m.created_at, m.id
  order by m.joined_at asc nulls last, m.created_at, m.id
  limit 1;
end
$$;

create or replace function app_private.resolve_cognito_identity(external_subject text)
returns table (
  user_id uuid,
  tenant_id uuid,
  role text,
  display_name text,
  facility_ids uuid[]
)
language sql
volatile
security definer
set search_path = ''
as $$
  select * from app_private.resolve_cognito_identity(external_subject, null, false)
$$;

revoke all on function app_private.invite_staff_member(uuid, uuid, uuid, text, text, text, uuid[]) from public;
revoke all on function app_private.mark_staff_invitation_delivery(uuid, boolean, text, text) from public;
revoke all on function app_private.update_staff_membership(uuid, text, text, uuid[], bigint) from public;
revoke all on function app_private.resolve_cognito_identity(text, text, boolean) from public;
revoke all on function app_private.resolve_cognito_identity(text) from public;

commit;
