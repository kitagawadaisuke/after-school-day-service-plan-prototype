begin;

-- The staging single-organization service can enrol staff from its private URL.
-- Every account is limited to the configured organization and begins as support staff.
create or replace function app_private.register_local_user(
  target_tenant_id uuid,
  login_email text,
  requested_display_name text,
  new_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(login_email));
  new_user_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
begin
  if target_tenant_id is null
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or btrim(coalesce(requested_display_name, '')) = ''
     or char_length(btrim(requested_display_name)) > 100
     or new_password_hash !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$' then
    return false;
  end if;

  if not exists (select 1 from public.organizations where id = target_tenant_id and status = 'active')
     or exists (select 1 from public.app_users where lower(email) = normalized_email) then
    return false;
  end if;

  insert into public.app_users (id, email, display_name, status)
  values (new_user_id, normalized_email, btrim(requested_display_name), 'active');

  insert into public.memberships (id, tenant_id, user_id, role, status, invited_at, joined_at)
  values (new_membership_id, target_tenant_id, new_user_id, 'support_staff', 'active', now(), now());

  insert into public.membership_facilities (tenant_id, membership_id, facility_id)
  select target_tenant_id, new_membership_id, id
    from public.facilities
   where tenant_id = target_tenant_id and status = 'active';

  insert into app_private.local_account_credentials (user_id, password_hash)
  values (new_user_id, new_password_hash);

  return true;
end
$$;

revoke all on function app_private.register_local_user(uuid, text, text, text) from public;

commit;
