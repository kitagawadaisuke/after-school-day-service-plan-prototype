begin;

-- An inactive facility is an access boundary for every facility-scoped role.
-- Tenant administrators retain access so they can reactivate, audit or export
-- historical records without re-opening the facility to its former staff.
create or replace function app_private.can_access_facility(requested_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships actor_membership
    join public.facilities requested_facility
      on requested_facility.tenant_id = actor_membership.tenant_id
     and requested_facility.id = requested_facility_id
    where actor_membership.tenant_id = app_private.current_tenant_id()
      and actor_membership.user_id = app_private.current_user_id()
      and actor_membership.status = 'active'
      and (
        actor_membership.role = 'tenant_admin'
        or (
          requested_facility.status = 'active'
          and exists (
            select 1
            from public.membership_facilities actor_facility
            where actor_facility.tenant_id = actor_membership.tenant_id
              and actor_facility.membership_id = actor_membership.id
              and actor_facility.facility_id = requested_facility_id
          )
        )
      )
  )
$$;

-- Staff roster visibility follows the same facility boundary as the HTTP API.
-- A facility administrator may see a manageable membership only when every
-- one of that membership's facilities is inside the administrator's scope.
create or replace function app_private.can_view_staff_membership(requested_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships actor_membership
    join public.memberships target_membership
      on target_membership.tenant_id = actor_membership.tenant_id
     and target_membership.id = requested_membership_id
    where actor_membership.tenant_id = app_private.current_tenant_id()
      and actor_membership.user_id = app_private.current_user_id()
      and actor_membership.status = 'active'
      and (
        target_membership.user_id = app_private.current_user_id()
        or actor_membership.role = 'tenant_admin'
        or (
          actor_membership.role = 'facility_admin'
          and target_membership.role in ('plan_approver', 'support_staff', 'viewer')
          and exists (
            select 1
            from public.membership_facilities target_facility
            where target_facility.tenant_id = target_membership.tenant_id
              and target_facility.membership_id = target_membership.id
          )
          and not exists (
            select 1
            from public.membership_facilities target_facility
            where target_facility.tenant_id = target_membership.tenant_id
              and target_facility.membership_id = target_membership.id
              and not app_private.can_access_facility(target_facility.facility_id)
          )
        )
      )
  )
$$;

drop policy if exists app_users_tenant_roster_read on public.app_users;
create policy app_users_tenant_roster_read on public.app_users
  for select using (
    exists (
      select 1
      from public.memberships target_membership
      where target_membership.user_id = app_users.id
        and target_membership.tenant_id = app_private.current_tenant_id()
        and app_private.can_view_staff_membership(target_membership.id)
    )
  );

drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_view_staff_membership(id)
  );

drop policy if exists membership_facilities_read on public.membership_facilities;
create policy membership_facilities_read on public.membership_facilities
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_view_staff_membership(membership_id)
    and app_private.can_access_facility(facility_id)
  );

drop policy if exists staff_invitations_read on public.staff_invitations;
create policy staff_invitations_read on public.staff_invitations
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin'])
    and app_private.can_view_staff_membership(membership_id)
  );

-- The first production release deliberately supports one active company per
-- login. This prevents an existing Cognito identity from being silently made
-- active in another company before an explicit tenant selector/acceptance flow
-- exists. Ended memberships remain available as immutable history.
create unique index memberships_one_open_tenant_per_user_idx
  on public.memberships (user_id)
  where status <> 'ended';

-- Idempotency replay bodies may temporarily contain the just-created resource.
-- Bound both their lifetime and size, and expose only a narrow global purge of
-- already-expired rows. The function cannot read or delete live responses.
alter table app_private.idempotency_records
  add constraint idempotency_records_max_retention
    check (expires_at <= created_at + interval '24 hours'),
  add constraint idempotency_records_response_size
    check (octet_length(response_body::text) <= 262144);

create or replace function app_private.purge_expired_idempotency_records(requested_limit integer default 250)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if requested_limit is null or requested_limit < 1 or requested_limit > 5000 then
    raise exception using errcode = '22023', message = 'purge limit is outside the supported range';
  end if;

  with expired as (
    select record.ctid
    from app_private.idempotency_records record
    where record.expires_at <= now()
    order by record.expires_at
    limit requested_limit
    for update skip locked
  )
  delete from app_private.idempotency_records record
  using expired
  where record.ctid = expired.ctid;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end
$$;

revoke execute on function app_private.can_view_staff_membership(uuid) from public;
revoke execute on function app_private.purge_expired_idempotency_records(integer) from public;

commit;
