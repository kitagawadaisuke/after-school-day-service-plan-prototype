begin;

-- Development deployments do not have an S3/KMS bucket. Keep the generated
-- PDF together with its immutable snapshot job instead of falling back to an
-- unavailable storage adapter. Runtime is never granted UPDATE or DELETE;
-- rows remain append-only and tenant-scoped by RLS.
create table public.document_snapshot_blobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null,
  storage_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 10485760),
  content bytea not null check (octet_length(content) = byte_size and substr(content, 1, 5) = convert_to('%PDF-', 'UTF8')),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, job_id) references public.document_snapshot_jobs(tenant_id, id) on delete restrict,
  unique (tenant_id, job_id),
  unique (tenant_id, storage_key)
);

create index document_snapshot_blobs_job_idx on public.document_snapshot_blobs (tenant_id, job_id);

create or replace function app_private.protect_document_snapshot_blob()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'document snapshot blobs are append-only';
end
$$;
create trigger document_snapshot_blobs_append_only
before update or delete on public.document_snapshot_blobs
for each row execute function app_private.protect_document_snapshot_blob();

alter table public.document_snapshot_blobs enable row level security;
alter table public.document_snapshot_blobs force row level security;
create policy document_snapshot_blobs_read on public.document_snapshot_blobs for select using (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.document_snapshot_jobs j
    where j.tenant_id = document_snapshot_blobs.tenant_id
      and j.id = document_snapshot_blobs.job_id
      and app_private.can_access_document(j.document_id)
  )
);
create policy document_snapshot_blobs_insert on public.document_snapshot_blobs for insert with check (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.document_snapshot_jobs j
    where j.tenant_id = document_snapshot_blobs.tenant_id
      and j.id = document_snapshot_blobs.job_id
      and app_private.can_access_document(j.document_id)
  )
);

create or replace function app_private.store_database_document_snapshot_blob(
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_storage_key text,
  requested_sha256 text,
  requested_content bytea
)
returns table(storage_version_id text, sha256 text, byte_size bigint)
language plpgsql security definer set search_path = '' as $$
declare
  job public.document_snapshot_jobs%rowtype;
  blob public.document_snapshot_blobs%rowtype;
  computed_sha256 text;
begin
  select j.* into job from public.document_snapshot_jobs j
   where j.tenant_id = app_private.current_tenant_id()
     and j.id = requested_job_id
     and j.lease_owner_id = app_private.current_user_id()
     and j.status = 'rendering'
     and j.lease_token = requested_lease_token
     and j.lease_expires_at > now()
     and app_private.can_access_document(j.document_id)
   for update;
  if job.id is null then
    raise exception using errcode = '42501', message = 'snapshot blob storage is not permitted';
  end if;
  if requested_storage_key <> job.storage_key
     or requested_content is null
     or octet_length(requested_content) not between 1 and 10485760
     or substr(requested_content, 1, 5) <> convert_to('%PDF-', 'UTF8') then
    raise exception using errcode = '22023', message = 'invalid PDF blob';
  end if;
  computed_sha256 := encode(sha256(requested_content), 'hex');
  if requested_sha256 <> computed_sha256 then
    raise exception using errcode = '22023', message = 'PDF blob hash does not match';
  end if;
  insert into public.document_snapshot_blobs (tenant_id, job_id, storage_key, sha256, byte_size, content)
  values (job.tenant_id, job.id, job.storage_key, computed_sha256, octet_length(requested_content), requested_content)
  on conflict (tenant_id, job_id) do nothing;
  select b.* into blob from public.document_snapshot_blobs b
   where b.tenant_id = job.tenant_id and b.job_id = job.id;
  if blob.sha256 <> computed_sha256 or blob.byte_size <> octet_length(requested_content) then
    raise exception using errcode = '55000', message = 'existing PDF blob does not match';
  end if;
  return query select blob.id::text, blob.sha256, blob.byte_size;
end
$$;

create or replace function app_private.record_database_document_snapshot_job_upload(
  requested_job_id uuid,
  requested_lease_token uuid
)
returns setof public.document_snapshot_jobs
language sql security definer set search_path = '' as $$
  update public.document_snapshot_jobs j
     set status = 'uploaded', sha256 = b.sha256, byte_size = b.byte_size,
         storage_version_id = b.id::text, lease_token = null, lease_expires_at = null, updated_at = now()
    from public.document_snapshot_blobs b
   where j.tenant_id = app_private.current_tenant_id()
     and j.id = requested_job_id
     and j.lease_owner_id = app_private.current_user_id()
     and j.status = 'rendering'
     and j.lease_token = requested_lease_token
     and j.lease_expires_at > now()
     and b.tenant_id = j.tenant_id and b.job_id = j.id
     and app_private.can_access_document(j.document_id)
  returning j.*
$$;

create or replace function app_private.read_database_document_snapshot_blob(
  requested_storage_key text,
  requested_storage_version_id text
)
returns bytea
language plpgsql security definer set search_path = '' as $$
declare result bytea;
begin
  select b.content into result
    from public.document_snapshot_blobs b
    join public.document_snapshot_jobs j on j.tenant_id = b.tenant_id and j.id = b.job_id
   where b.tenant_id = app_private.current_tenant_id()
     and b.storage_key = requested_storage_key
     and b.id::text = requested_storage_version_id
     and app_private.can_access_document(j.document_id);
  if result is null then
    raise exception using errcode = '42501', message = 'snapshot blob read is not permitted';
  end if;
  return result;
end
$$;

revoke all on public.document_snapshot_blobs from public;
revoke all on function app_private.store_database_document_snapshot_blob(uuid, uuid, text, text, bytea) from public;
revoke all on function app_private.record_database_document_snapshot_job_upload(uuid, uuid) from public;
revoke all on function app_private.read_database_document_snapshot_blob(text, text) from public;
commit;
