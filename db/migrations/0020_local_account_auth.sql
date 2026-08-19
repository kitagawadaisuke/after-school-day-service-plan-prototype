begin;

-- Local accounts are used only by the single-server deployment. Passwords are
-- scrypt hashes created by the application; clear-text values never enter SQL.
create table app_private.local_account_credentials (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  password_hash text not null,
  password_changed_at timestamptz not null default now(),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_private.platform_operators (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function app_private.resolve_local_login(login_email text)
returns table (
  user_id uuid,
  tenant_id uuid,
  tenant_name text,
  role text,
  display_name text,
  facility_ids uuid[],
  password_hash text,
  locked_until timestamptz,
  is_platform_operator boolean
)
language sql
security definer
set search_path = ''
as $$
  select u.id,
         m.tenant_id,
         o.name,
         m.role,
         u.display_name,
         coalesce(array_agg(f.id order by f.id) filter (where f.id is not null), '{}'),
         c.password_hash,
         c.locked_until,
         exists(select 1 from app_private.platform_operators p where p.user_id = u.id)
    from public.app_users u
    join app_private.local_account_credentials c on c.user_id = u.id
    join lateral (
      select m.*
        from public.memberships m
        join public.organizations o on o.id = m.tenant_id and o.status = 'active'
       where m.user_id = u.id and m.status = 'active'
       order by m.joined_at nulls last, m.created_at, m.id
       limit 1
    ) m on true
    join public.organizations o on o.id = m.tenant_id
    left join public.facilities f
      on f.tenant_id = m.tenant_id
     and f.status = 'active'
     and (m.role = 'tenant_admin' or exists (
       select 1 from public.membership_facilities mf
        where mf.tenant_id = m.tenant_id and mf.membership_id = m.id and mf.facility_id = f.id
     ))
   where lower(u.email) = lower(login_email)
     and u.status = 'active'
   group by u.id, m.tenant_id, o.name, m.role, u.display_name, c.password_hash, c.locked_until;
$$;

create or replace function app_private.record_local_login_attempt(login_user_id uuid, succeeded boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if succeeded then
    update app_private.local_account_credentials
       set failed_attempts = 0, locked_until = null, updated_at = now()
     where user_id = login_user_id;
  else
    update app_private.local_account_credentials
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
           updated_at = now()
     where user_id = login_user_id;
  end if;
end
$$;

revoke all on app_private.local_account_credentials, app_private.platform_operators from public;
revoke all on function app_private.resolve_local_login(text) from public;
revoke all on function app_private.record_local_login_attempt(uuid, boolean) from public;

commit;
