begin;

create table app_private.document_snapshot_finalization_config (
  singleton boolean primary key default true check (singleton),
  secret text not null check (secret ~ '^[A-Za-z0-9]{64}$'),
  configured_at timestamptz not null default now()
);

create or replace function app_private.configure_document_snapshot_finalization(secret_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> current_user then
    raise exception using errcode = '42501', message = 'snapshot finalization configuration is owner-only';
  end if;
  if secret_value !~ '^[A-Za-z0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid snapshot finalization secret';
  end if;
  insert into app_private.document_snapshot_finalization_config (singleton, secret, configured_at)
  values (true, secret_value, now())
  on conflict (singleton) do update
    set secret = excluded.secret, configured_at = excluded.configured_at;
end
$$;

revoke all on app_private.document_snapshot_finalization_config from public;
revoke execute on function app_private.configure_document_snapshot_finalization(text) from public;

-- A PDF render can take tens of seconds and S3 is an external system.  Jobs
-- make the database boundary explicit: reserve in one short transaction,
-- render/upload without a database connection, then finalize in another short
-- transaction.  The stable snapshot id and object key make every retry safe.
create table public.document_snapshot_jobs (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  child_id uuid not null,
  document_row_version bigint not null check (document_row_version > 0),
  source_status text not null check (source_status in (
    'draft', 'internal_review', 'explanation_pending', 'consented',
    'approved', 'distributed', 'active', 'superseded', 'closed'
  )),
  template_version text not null,
  snapshot_kind text not null check (snapshot_kind in ('draft', 'official', 'corrected')),
  consent_record_id uuid,
  storage_key text not null,
  generated_by uuid not null references public.app_users(id) on delete restrict,
  lease_owner_id uuid not null references public.app_users(id) on delete restrict,
  status text not null check (status in (
    'pending', 'rendering', 'uploaded', 'reconciling', 'completed', 'failed', 'quarantined'
  )),
  lease_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint check (byte_size is null or byte_size > 0),
  storage_version_id text check (
    storage_version_id is null or (length(storage_version_id) between 1 and 1024 and storage_version_id !~ '[[:space:]]')
  ),
  idempotency_key text check (
    idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'
  ),
  request_fingerprint text check (
    request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (tenant_id, document_id)
    references public.case_documents(tenant_id, id) on delete restrict,
  foreign key (tenant_id, child_id)
    references public.children(tenant_id, id) on delete restrict,
  foreign key (tenant_id, consent_record_id)
    references public.document_consent_records(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, storage_key),
  unique (tenant_id, document_id, document_row_version, snapshot_kind),
  check ((idempotency_key is null) = (request_fingerprint is null)),
  check (
    (status in ('rendering', 'reconciling') and lease_token is not null and lease_expires_at is not null)
    or (status not in ('rendering', 'reconciling'))
  ),
  check (
    status not in ('uploaded', 'completed')
    or (sha256 is not null and byte_size is not null and storage_version_id is not null)
  ),
  check ((status = 'completed') = (completed_at is not null))
);

create unique index document_snapshot_jobs_idempotency_idx
  on public.document_snapshot_jobs (tenant_id, generated_by, idempotency_key)
  where idempotency_key is not null;
create index document_snapshot_jobs_reconcile_idx
  on public.document_snapshot_jobs (status, lease_expires_at, available_at, created_at)
  where status in ('pending', 'rendering', 'uploaded', 'failed', 'reconciling');

create or replace function app_private.protect_document_snapshot_job()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.document_id is distinct from old.document_id
     or new.child_id is distinct from old.child_id
     or new.document_row_version is distinct from old.document_row_version
     or new.source_status is distinct from old.source_status
     or new.template_version is distinct from old.template_version
     or new.snapshot_kind is distinct from old.snapshot_kind
     or new.consent_record_id is distinct from old.consent_record_id
     or new.storage_key is distinct from old.storage_key
     or new.generated_by is distinct from old.generated_by
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'snapshot job identity is immutable';
  end if;
  if old.status in ('completed', 'quarantined') and new.status is distinct from old.status then
    raise exception using errcode = '55000', message = 'terminal snapshot job is immutable';
  end if;
  if old.storage_version_id is not null and (
    new.storage_version_id is distinct from old.storage_version_id
    or new.sha256 is distinct from old.sha256
    or new.byte_size is distinct from old.byte_size
  ) then
    raise exception using errcode = '55000', message = 'uploaded snapshot identity is immutable';
  end if;
  return new;
end
$$;

create trigger document_snapshot_jobs_protect_identity
before update or delete on public.document_snapshot_jobs
for each row execute function app_private.protect_document_snapshot_job();

alter table public.document_snapshot_jobs enable row level security;
alter table public.document_snapshot_jobs force row level security;

create policy document_snapshot_jobs_read on public.document_snapshot_jobs
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
  );
create policy document_snapshot_jobs_insert on public.document_snapshot_jobs
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and generated_by = app_private.current_user_id()
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
  );
create policy document_snapshot_jobs_update on public.document_snapshot_jobs
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
  );

-- Existing snapshots may predate S3 version capture. NOT VALID preserves them,
-- while PostgreSQL still enforces the requirement for every new row.
alter table public.document_snapshots add column storage_version_id text;
alter table public.document_snapshots add constraint document_snapshots_storage_version_required
  check (
    storage_version_id is not null
    and length(storage_version_id) between 1 and 1024
    and storage_version_id !~ '[[:space:]]'
  ) not valid;

-- Snapshot rows remain append-only.  The sole legacy exception is filling a
-- previously unknown S3 VersionId after the exact object bytes match the
-- already-persisted SHA-256 and size. Runtime has no direct UPDATE grant.
drop trigger document_snapshots_append_only on public.document_snapshots;
create or replace function app_private.protect_document_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.storage_version_id is null
     and new.storage_version_id is not null
     and (to_jsonb(new) - 'storage_version_id') = (to_jsonb(old) - 'storage_version_id') then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'document snapshots are append-only';
end
$$;
create trigger document_snapshots_append_only
before update or delete on public.document_snapshots
for each row execute function app_private.protect_document_snapshot_mutation();

create or replace function app_private.backfill_document_snapshot_storage_version(
  requested_snapshot_id uuid,
  requested_sha256 text,
  requested_byte_size bigint,
  requested_storage_version_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot public.document_snapshots%rowtype;
begin
  select s.* into snapshot
  from public.document_snapshots s
  where s.tenant_id = app_private.current_tenant_id()
    and s.id = requested_snapshot_id
    and app_private.can_access_document(s.document_id)
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
  for update;
  if snapshot.id is null then
    raise exception using errcode = '42501', message = 'snapshot version backfill is not permitted';
  end if;
  if snapshot.storage_version_id is not null then
    return snapshot.storage_version_id = requested_storage_version_id;
  end if;
  if snapshot.sha256 <> requested_sha256
     or snapshot.byte_size <> requested_byte_size
     or requested_storage_version_id is null
     or length(requested_storage_version_id) not between 1 and 1024
     or requested_storage_version_id ~ '[[:space:]]' then
    raise exception using errcode = '22023', message = 'legacy snapshot integrity does not match';
  end if;
  update public.document_snapshots
     set storage_version_id = requested_storage_version_id
   where tenant_id = snapshot.tenant_id and id = snapshot.id;
  return true;
end
$$;

create or replace function app_private.create_document_snapshot_job(
  requested_job_id uuid,
  requested_document_id uuid,
  requested_child_id uuid,
  requested_document_row_version bigint,
  requested_source_status text,
  requested_template_version text,
  requested_snapshot_kind text,
  requested_consent_record_id uuid,
  requested_storage_key text,
  requested_lease_token uuid,
  requested_lease_seconds integer,
  requested_idempotency_key text,
  requested_request_fingerprint text
)
returns setof public.document_snapshot_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_document public.case_documents%rowtype;
  expected_key text;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null
     or not app_private.has_tenant_role(array[
       'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
     ]) or not app_private.can_access_document(requested_document_id) then
    raise exception using errcode = '42501', message = 'snapshot job reservation is not permitted';
  end if;
  if requested_job_id is null or requested_lease_token is null
     or requested_lease_seconds not between 60 and 600 then
    raise exception using errcode = '22023', message = 'invalid snapshot job lease';
  end if;

  select d.* into source_document
  from public.case_documents d
  where d.tenant_id = app_private.current_tenant_id()
    and d.id = requested_document_id
    and d.child_id = requested_child_id
    and d.deleted_at is null;
  if source_document.id is null
     or source_document.row_version <> requested_document_row_version
     or source_document.status <> requested_source_status
     or source_document.template_version <> requested_template_version then
    raise exception using errcode = '40001', message = 'snapshot source document changed';
  end if;
  if (requested_snapshot_kind = 'draft' and requested_source_status not in (
      'draft', 'internal_review', 'explanation_pending', 'consented'
    )) or (requested_snapshot_kind in ('official', 'corrected') and requested_source_status not in (
      'approved', 'distributed', 'active', 'superseded', 'closed'
    )) then
    raise exception using errcode = '55000', message = 'snapshot kind is not valid for source status';
  end if;
  expected_key := 'tenants/' || app_private.current_tenant_id()::text
    || '/documents/' || requested_document_id::text || '/' || requested_job_id::text || '.pdf';
  if requested_storage_key <> expected_key then
    raise exception using errcode = '23514', message = 'snapshot job storage key is invalid';
  end if;

  return query
  insert into public.document_snapshot_jobs (
    id, tenant_id, document_id, child_id, document_row_version, source_status,
    template_version, snapshot_kind, consent_record_id, storage_key, generated_by, lease_owner_id,
    status, lease_token, lease_expires_at, attempt_count,
    idempotency_key, request_fingerprint
  ) values (
    requested_job_id, app_private.current_tenant_id(), requested_document_id,
    requested_child_id, requested_document_row_version, requested_source_status,
    requested_template_version, requested_snapshot_kind, requested_consent_record_id,
    requested_storage_key, app_private.current_user_id(), app_private.current_user_id(), 'rendering',
    requested_lease_token, now() + make_interval(secs => requested_lease_seconds), 1,
    requested_idempotency_key, requested_request_fingerprint
  )
  on conflict (tenant_id, document_id, document_row_version, snapshot_kind) do nothing
  returning *;
end
$$;

create or replace function app_private.claim_document_snapshot_job(
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_lease_seconds integer
)
returns setof public.document_snapshot_jobs
language sql
security definer
set search_path = ''
as $$
  update public.document_snapshot_jobs j
     set status = 'rendering', lease_owner_id = app_private.current_user_id(),
         lease_token = requested_lease_token,
         lease_expires_at = now() + make_interval(secs => requested_lease_seconds),
         attempt_count = j.attempt_count + 1, last_error_code = null, updated_at = now()
   where j.tenant_id = app_private.current_tenant_id()
     and j.id = requested_job_id
     and app_private.can_access_document(j.document_id)
     and app_private.has_tenant_role(array[
       'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
     ])
     and requested_lease_token is not null
     and requested_lease_seconds between 60 and 600
     and j.status in ('pending', 'failed', 'rendering', 'reconciling')
     and (j.status not in ('rendering', 'reconciling') or j.lease_expires_at <= now())
  returning j.*
$$;

create or replace function app_private.record_document_snapshot_job_upload(
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_storage_version_id text,
  requested_sha256 text,
  requested_byte_size bigint,
  requested_attestation text
)
returns setof public.document_snapshot_jobs
language sql
security definer
set search_path = ''
as $$
  update public.document_snapshot_jobs j
     set status = 'uploaded', sha256 = requested_sha256, byte_size = requested_byte_size,
         storage_version_id = requested_storage_version_id,
         lease_token = null, lease_expires_at = null, updated_at = now()
   where j.tenant_id = app_private.current_tenant_id()
     and j.id = requested_job_id
     and j.lease_owner_id = app_private.current_user_id()
     and app_private.can_access_document(j.document_id)
     and j.status = 'rendering'
     and j.lease_token = requested_lease_token
     and j.lease_expires_at > now()
     and requested_storage_version_id is not null
     and length(requested_storage_version_id) between 1 and 1024
     and requested_storage_version_id !~ '[[:space:]]'
     and requested_sha256 ~ '^[0-9a-f]{64}$'
     and requested_byte_size > 0
     and requested_attestation = (
       select encode(sha256(convert_to(
         c.secret || E'\n' || requested_job_id::text || E'\n'
         || requested_lease_token::text || E'\n' || requested_storage_version_id || E'\n'
         || requested_sha256 || E'\n' || requested_byte_size::text || E'\n' || c.secret,
         'UTF8'
       )), 'hex')
       from app_private.document_snapshot_finalization_config c
       where c.singleton
     )
  returning j.*
$$;

create or replace function app_private.fail_document_snapshot_job(
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_error_code text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.document_snapshot_jobs j
     set status = 'failed', lease_token = null, lease_expires_at = null,
         available_at = now() + interval '2 seconds',
         last_error_code = case when requested_error_code ~ '^[A-Z0-9_]{1,64}$'
           then requested_error_code else 'PDF_FAILED' end,
         updated_at = now()
   where j.tenant_id = app_private.current_tenant_id()
     and j.id = requested_job_id
     and j.lease_owner_id = app_private.current_user_id()
     and j.status = 'rendering'
     and j.lease_token = requested_lease_token
  returning true
$$;

create or replace function app_private.finalize_document_snapshot_job(requested_job_id uuid)
returns setof public.document_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.document_snapshot_jobs%rowtype;
begin
  select j.* into job
  from public.document_snapshot_jobs j
  where j.tenant_id = app_private.current_tenant_id()
    and j.id = requested_job_id
    and app_private.can_access_document(j.document_id)
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
  for update;
  if job.id is null then return; end if;
  if job.status = 'completed' then
    return query select s.* from public.document_snapshots s
      where s.tenant_id = job.tenant_id and s.id = job.id;
    return;
  end if;
  if job.status <> 'uploaded' then return; end if;

  return query
  insert into public.document_snapshots (
    id, tenant_id, document_id, document_row_version, source_status,
    template_version, storage_key, storage_version_id, sha256, byte_size,
    mime_type, snapshot_kind, generated_by, consent_record_id
  ) values (
    job.id, job.tenant_id, job.document_id, job.document_row_version, job.source_status,
    job.template_version, job.storage_key, job.storage_version_id, job.sha256,
    job.byte_size, 'application/pdf', job.snapshot_kind, job.lease_owner_id,
    job.consent_record_id
  ) returning *;
  update public.document_snapshot_jobs
     set status = 'completed', completed_at = now(), updated_at = now()
   where id = job.id;
end
$$;

create or replace function app_private.quarantine_stale_document_snapshot_job(requested_job_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.document_snapshot_jobs j
     set status = 'quarantined', last_error_code = 'SOURCE_CHANGED', updated_at = now()
   where j.tenant_id = app_private.current_tenant_id()
     and j.id = requested_job_id
     and j.status = 'uploaded'
     and app_private.can_access_document(j.document_id)
     and app_private.has_tenant_role(array[
       'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
     ])
     and exists (
       select 1 from public.case_documents d
       where d.tenant_id = j.tenant_id and d.id = j.document_id
         and (d.deleted_at is not null
           or d.row_version <> j.document_row_version
           or d.status <> j.source_status
           or d.template_version <> j.template_version)
     )
  returning true
$$;

-- Claim only stale jobs.  This narrow definer function lets a runtime worker
-- reconcile all tenants without exposing care data; it returns object identity
-- and integrity metadata only, never names, document payloads or certificate data.
create or replace function app_private.claim_stale_document_snapshot_jobs(
  requested_lease_token uuid,
  requested_limit integer default 10
)
returns table (
  job_id uuid,
  tenant_id uuid,
  document_id uuid,
  storage_key text,
  stored_version_id text,
  stored_sha256 text,
  stored_byte_size bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if requested_lease_token is null or requested_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'invalid snapshot reconciliation claim';
  end if;

  return query
  with candidates as (
    select j.id
    from public.document_snapshot_jobs j
    where (
      (j.status in ('rendering', 'reconciling') and j.lease_expires_at <= now())
      or j.status = 'uploaded'
    )
    order by j.created_at, j.id
    for update skip locked
    limit requested_limit
  )
  update public.document_snapshot_jobs j
     set status = 'reconciling',
         lease_token = requested_lease_token,
         lease_expires_at = now() + interval '2 minutes',
         updated_at = now()
    from candidates c
   where j.id = c.id
  returning j.id, j.tenant_id, j.document_id, j.storage_key,
            j.storage_version_id, j.sha256, j.byte_size;
end
$$;

-- The worker calls this only after reading the exact S3 version and verifying
-- its byte length and SHA-256.  Source drift quarantines the WORM object rather
-- than deleting it or attaching it to a different document revision.
create or replace function app_private.finalize_reconciled_document_snapshot_job(
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_storage_version_id text,
  requested_sha256 text,
  requested_byte_size bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.document_snapshot_jobs%rowtype;
  document_facility_id uuid;
begin
  if requested_storage_version_id is null
     or length(requested_storage_version_id) not between 1 and 1024
     or requested_storage_version_id ~ '[[:space:]]'
     or requested_sha256 !~ '^[0-9a-f]{64}$'
     or requested_byte_size <= 0 then
    raise exception using errcode = '22023', message = 'invalid reconciled snapshot metadata';
  end if;

  select j.* into job
  from public.document_snapshot_jobs j
  where j.id = requested_job_id
    and j.status = 'reconciling'
    and j.lease_token = requested_lease_token
    and j.lease_expires_at > now()
  for update;
  if job.id is null then return 'lease_lost'; end if;

  if exists (
    select 1 from public.document_snapshots s
    where s.tenant_id = job.tenant_id and s.id = job.id
  ) then
    update public.document_snapshot_jobs
       set status = 'completed', completed_at = coalesce(completed_at, now()),
           lease_token = null, lease_expires_at = null, updated_at = now()
     where id = job.id;
    return 'completed';
  end if;

  update public.document_snapshot_jobs
     set status = 'uploaded', sha256 = requested_sha256,
         byte_size = requested_byte_size,
         storage_version_id = requested_storage_version_id,
         lease_token = null, lease_expires_at = null, updated_at = now()
   where id = job.id;

  begin
    insert into public.document_snapshots (
      id, tenant_id, document_id, document_row_version, source_status,
      template_version, storage_key, storage_version_id, sha256, byte_size,
      mime_type, snapshot_kind, generated_by, consent_record_id
    ) values (
      job.id, job.tenant_id, job.document_id, job.document_row_version, job.source_status,
      job.template_version, job.storage_key, requested_storage_version_id,
      requested_sha256, requested_byte_size, 'application/pdf', job.snapshot_kind,
      job.lease_owner_id, job.consent_record_id
    );
  exception
    when serialization_failure or object_not_in_prerequisite_state or foreign_key_violation then
      update public.document_snapshot_jobs
         set status = 'quarantined', last_error_code = 'SOURCE_CHANGED',
             lease_token = null, lease_expires_at = null, updated_at = now()
       where id = job.id;
      return 'quarantined';
  end;

  update public.document_snapshot_jobs
     set status = 'completed', completed_at = now(), updated_at = now()
   where id = job.id;

  select d.facility_id into document_facility_id
  from public.case_documents d
  where d.tenant_id = job.tenant_id and d.id = job.document_id;

  insert into public.audit_events (
    id, tenant_id, facility_id, actor_user_id, action, resource_type,
    resource_id, request_id, user_agent_family, outcome, changed_fields, metadata
  ) values (
    gen_random_uuid(), job.tenant_id, document_facility_id, null,
    'document_snapshot.reconciled', 'document_snapshot', job.id,
    'snapshot-reconciler', 'system', 'success', '{}',
    jsonb_build_object('documentId', job.document_id, 'snapshotKind', job.snapshot_kind)
  );
  return 'completed';
end
$$;

create or replace function app_private.release_reconciled_document_snapshot_job(
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_error_code text,
  requested_quarantine boolean default false
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.document_snapshot_jobs j
     set status = case when requested_quarantine then 'quarantined' else 'pending' end,
         lease_token = null,
         lease_expires_at = null,
         available_at = case when requested_quarantine then j.available_at else now() end,
         last_error_code = case
           when requested_error_code ~ '^[A-Z0-9_]{1,64}$' then requested_error_code
           else 'RECONCILE_FAILED'
         end,
         updated_at = now()
   where j.id = requested_job_id
     and j.status = 'reconciling'
     and j.lease_token = requested_lease_token
  returning true
$$;

revoke execute on function app_private.claim_stale_document_snapshot_jobs(uuid, integer) from public;
revoke execute on function app_private.finalize_reconciled_document_snapshot_job(uuid, uuid, text, text, bigint) from public;
revoke execute on function app_private.release_reconciled_document_snapshot_job(uuid, uuid, text, boolean) from public;
revoke execute on function app_private.create_document_snapshot_job(uuid, uuid, uuid, bigint, text, text, text, uuid, text, uuid, integer, text, text) from public;
revoke execute on function app_private.claim_document_snapshot_job(uuid, uuid, integer) from public;
revoke execute on function app_private.record_document_snapshot_job_upload(uuid, uuid, text, text, bigint, text) from public;
revoke execute on function app_private.fail_document_snapshot_job(uuid, uuid, text) from public;
revoke execute on function app_private.finalize_document_snapshot_job(uuid) from public;
revoke execute on function app_private.quarantine_stale_document_snapshot_job(uuid) from public;
revoke execute on function app_private.backfill_document_snapshot_storage_version(uuid, text, bigint, text) from public;

commit;
