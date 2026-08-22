-- Resolve a verified Cognito subject to one active application membership.
-- Authentication happens before an application tenant context exists, so this
-- narrowly scoped SECURITY DEFINER function is the only runtime entry point.

begin;

-- The migration owner must own these tables and must not be the runtime LOGIN
-- role. RLS remains enabled for ordinary queries; the owner is needed only by
-- the restricted identity resolver below. memberships was set NO FORCE in 0001.
alter table public.app_users no force row level security;
alter table public.organizations no force row level security;

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
  with selected_membership as (
    select
      u.id as user_id,
      m.tenant_id,
      m.id as membership_id,
      m.role,
      u.display_name
    from public.app_users u
    join public.memberships m on m.user_id = u.id
    join public.organizations o on o.id = m.tenant_id
    where external_subject is not null
      and external_subject <> ''
      and u.cognito_sub = external_subject
      and u.status = 'active'
      and m.status = 'active'
      and o.status = 'active'
    order by m.joined_at asc nulls last, m.created_at, m.id
    limit 1
  ), touched_user as (
    update public.app_users u
    set last_login_at = now(), updated_at = now()
    from selected_membership sm
    where u.id = sm.user_id
    returning u.id
  )
  select
    sm.user_id,
    sm.tenant_id,
    sm.role,
    sm.display_name,
    coalesce(
      array_agg(mf.facility_id order by mf.facility_id)
        filter (where mf.facility_id is not null),
      '{}'::uuid[]
    ) as facility_ids
  from selected_membership sm
  join touched_user tu on tu.id = sm.user_id
  left join public.membership_facilities mf
    on mf.tenant_id = sm.tenant_id and mf.membership_id = sm.membership_id
  group by sm.user_id, sm.tenant_id, sm.role, sm.display_name
$$;

revoke all on function app_private.resolve_cognito_identity(text) from public;

commit;
