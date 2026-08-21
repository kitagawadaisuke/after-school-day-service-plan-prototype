begin;

create table app_private.local_password_reset_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references public.app_users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  requested_at timestamptz not null default now()
);

create index local_password_reset_tokens_active_idx
  on app_private.local_password_reset_tokens (user_id, expires_at)
  where consumed_at is null;

create or replace function app_private.request_local_password_setup(login_email text, reset_token_hash text)
returns table (email text, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_user_id uuid;
begin
  if reset_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid reset token';
  end if;

  select u.id into matched_user_id
    from public.app_users u
   where lower(u.email) = lower(trim(login_email))
     and u.status = 'active'
     and exists (
       select 1 from public.memberships m
        join public.organizations o on o.id = m.tenant_id and o.status = 'active'
       where m.user_id = u.id and m.status = 'active'
     )
   limit 1;

  if matched_user_id is null then return; end if;

  update app_private.local_password_reset_tokens
     set consumed_at = now()
   where user_id = matched_user_id and consumed_at is null;

  insert into app_private.local_password_reset_tokens (token_hash, user_id, expires_at)
  values (reset_token_hash, matched_user_id, now() + interval '30 minutes');

  return query select u.email, u.display_name from public.app_users u where u.id = matched_user_id;
end;
$$;

create or replace function app_private.consume_local_password_setup(reset_token_hash text, new_password_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_user_id uuid;
begin
  if reset_token_hash !~ '^[a-f0-9]{64}$' or new_password_hash !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'invalid password setup';
  end if;

  update app_private.local_password_reset_tokens
     set consumed_at = now()
   where token_hash = reset_token_hash
     and consumed_at is null
     and expires_at > now()
   returning user_id into matched_user_id;

  if matched_user_id is null then return false; end if;

  insert into app_private.local_account_credentials (user_id, password_hash, password_changed_at, failed_attempts, locked_until)
  values (matched_user_id, new_password_hash, now(), 0, null)
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        password_changed_at = now(),
        failed_attempts = 0,
        locked_until = null,
        updated_at = now();
  return true;
end;
$$;

revoke all on app_private.local_password_reset_tokens from public;
revoke all on function app_private.request_local_password_setup(text, text) from public;
revoke all on function app_private.consume_local_password_setup(text, text) from public;

commit;
