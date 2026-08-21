begin;

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

  update app_private.local_password_reset_tokens as token
     set consumed_at = now()
   where token.token_hash = reset_token_hash
     and token.consumed_at is null
     and token.expires_at > now()
   returning token.user_id, token.purpose into matched_user_id, token_purpose;

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

commit;
