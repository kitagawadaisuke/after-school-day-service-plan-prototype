begin;

alter table app_private.local_password_reset_tokens
  add column if not exists purpose text not null default 'reset'
  check (purpose in ('signup', 'reset'));

-- Creates a pending local account and its one-time password-setup link.
-- No password is transmitted by email or stored until the account owner sets it.
create or replace function app_private.request_local_open_signup(
  target_tenant_id uuid,
  login_email text,
  requested_display_name text,
  setup_token_hash text
)
returns table (email text, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(login_email));
  new_user_id uuid;
  new_membership_id uuid;
begin
  if target_tenant_id is null
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or btrim(coalesce(requested_display_name, '')) = ''
     or char_length(btrim(requested_display_name)) > 100
     or setup_token_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;

  if not exists (select 1 from public.organizations where id = target_tenant_id and status = 'active') then
    return;
  end if;

  insert into public.app_users (id, email, display_name, status)
  values (pg_catalog.gen_random_uuid(), normalized_email, btrim(requested_display_name), 'active')
  on conflict do nothing
  returning id into new_user_id;

  if new_user_id is null then return; end if;

  new_membership_id := pg_catalog.gen_random_uuid();
  insert into public.memberships (id, tenant_id, user_id, role, status, invited_at, joined_at)
  values (new_membership_id, target_tenant_id, new_user_id, 'support_staff', 'active', now(), now());

  insert into public.membership_facilities (tenant_id, membership_id, facility_id)
  select target_tenant_id, new_membership_id, id
    from public.facilities
   where tenant_id = target_tenant_id and status = 'active';

  insert into app_private.local_password_reset_tokens (token_hash, user_id, expires_at, purpose)
  values (setup_token_hash, new_user_id, now() + interval '30 minutes', 'signup');

  return query
  select u.email, u.display_name from public.app_users u where u.id = new_user_id;
end
$$;

create or replace function app_private.consume_local_password_setup_result(
  reset_token_hash text,
  new_password_hash text
)
returns table (email text, display_name text, purpose text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_user_id uuid;
  token_purpose text;
begin
  if reset_token_hash !~ '^[a-f0-9]{64}$' or new_password_hash !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'invalid password setup';
  end if;

  update app_private.local_password_reset_tokens
     set consumed_at = now()
   where token_hash = reset_token_hash
     and consumed_at is null
     and expires_at > now()
   returning user_id, purpose into matched_user_id, token_purpose;

  if matched_user_id is null then return; end if;

  insert into app_private.local_account_credentials (user_id, password_hash, password_changed_at, failed_attempts, locked_until)
  values (matched_user_id, new_password_hash, now(), 0, null)
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        password_changed_at = now(),
        failed_attempts = 0,
        locked_until = null,
        updated_at = now();

  return query
  select u.email, u.display_name, token_purpose
    from public.app_users u
   where u.id = matched_user_id;
end
$$;

revoke all on function app_private.request_local_open_signup(uuid, text, text, text) from public;
revoke all on function app_private.consume_local_password_setup_result(text, text) from public;
revoke all on function app_private.register_local_user(uuid, text, text, text) from michinote_runtime;

commit;
