begin;

-- Authentication can fail before a tenant or user is known. Keep these
-- operational security events outside tenant data, with HMAC identifiers only.
create table app_private.security_auth_events (
  id uuid primary key,
  occurred_at timestamptz not null default now(),
  request_id text not null check (char_length(request_id) between 1 and 200),
  reason text not null check (reason in (
    'cognito_denied',
    'invalid_callback',
    'invalid_state',
    'authentication_rejected',
    'unknown'
  )),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{32}$'),
  user_agent_family text not null check (char_length(user_agent_family) between 1 and 100),
  outcome text not null default 'denied' check (outcome = 'denied')
);

create index security_auth_events_time_idx
  on app_private.security_auth_events (occurred_at desc, id);
create index security_auth_events_reason_time_idx
  on app_private.security_auth_events (reason, occurred_at desc);

create or replace function app_private.prevent_security_auth_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and (
       current_user <> session_user
       or current_setting('role', true) = 'michinote_runtime'
     )
     and current_setting('app.security_retention_purge', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'security authentication events are append-only';
end
$$;

create trigger security_auth_events_append_only
before update or delete on app_private.security_auth_events
for each row execute function app_private.prevent_security_auth_event_mutation();

create or replace function app_private.append_security_auth_event(
  requested_id uuid,
  requested_request_id text,
  requested_reason text,
  requested_ip_hash text,
  requested_user_agent_family text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if requested_id is null
     or requested_request_id is null
     or char_length(requested_request_id) not between 1 and 200
     or requested_reason not in (
       'cognito_denied', 'invalid_callback', 'invalid_state',
       'authentication_rejected', 'unknown'
     )
     or (requested_ip_hash is not null and requested_ip_hash !~ '^[0-9a-f]{32}$')
     or requested_user_agent_family is null
     or char_length(requested_user_agent_family) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid security authentication event';
  end if;

  insert into app_private.security_auth_events (
    id, request_id, reason, ip_hash, user_agent_family
  ) values (
    requested_id,
    requested_request_id,
    requested_reason,
    requested_ip_hash,
    requested_user_agent_family
  );
end
$$;

-- Retention is fixed inside owner-defined functions so the runtime role cannot
-- choose a future cutoff and erase current evidence. Both operations are
-- bounded to keep maintenance locks short.
create or replace function app_private.purge_retired_security_auth_events(maximum_rows integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if maximum_rows not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'invalid purge batch size';
  end if;
  perform set_config('app.security_retention_purge', 'on', true);
  with candidates as (
    select id
    from app_private.security_auth_events
    where occurred_at < now() - interval '400 days'
    order by occurred_at, id
    limit maximum_rows
    for update skip locked
  ), deleted as (
    delete from app_private.security_auth_events event
    using candidates
    where event.id = candidates.id
    returning event.id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end
$$;

create or replace function app_private.purge_retired_sessions(maximum_rows integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if maximum_rows not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'invalid purge batch size';
  end if;
  with candidates as (
    select id
    from app_private.sessions
    where coalesce(revoked_at, expires_at) < now() - interval '30 days'
    order by coalesce(revoked_at, expires_at), id
    limit maximum_rows
    for update skip locked
  ), deleted as (
    delete from app_private.sessions session
    using candidates
    where session.id = candidates.id
    returning session.id
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end
$$;

revoke all on app_private.security_auth_events from public;
revoke all on function app_private.append_security_auth_event(uuid, text, text, text, text) from public;
revoke all on function app_private.purge_retired_security_auth_events(integer) from public;
revoke all on function app_private.purge_retired_sessions(integer) from public;

commit;
