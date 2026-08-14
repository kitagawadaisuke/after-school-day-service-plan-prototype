begin;

-- The exact aggregate that a guardian consented to.  PDF files produced after
-- consent must read this append-only evidence instead of mutable child,
-- guardian, schedule, goal or payload rows.  Certificate ciphertext is kept in
-- a separate bytea column so plaintext and binary ciphertext can never leak
-- into JSON logs, API serialization or database JSON tooling.
create table public.document_consent_sources (
  consent_record_id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  target_version_number integer not null check (target_version_number > 0),
  document_row_version bigint not null check (document_row_version > 0),
  source_schema_version integer not null default 1 check (source_schema_version = 1),
  source_json jsonb not null check (jsonb_typeof(source_json) = 'object'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_certificate_ciphertext bytea,
  recipient_certificate_ciphertext_sha256 text,
  captured_at timestamptz not null default now(),
  foreign key (tenant_id, consent_record_id)
    references public.document_consent_records(tenant_id, id) on delete restrict,
  foreign key (tenant_id, document_id)
    references public.case_documents(tenant_id, id) on delete restrict,
  unique (tenant_id, consent_record_id),
  unique (tenant_id, document_id, document_row_version),
  check (
    (recipient_certificate_ciphertext is null and recipient_certificate_ciphertext_sha256 is null)
    or (
      recipient_certificate_ciphertext is not null
      and recipient_certificate_ciphertext_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  check (
    coalesce(jsonb_typeof(source_json -> 'child'), '') = 'object'
    and not ((source_json -> 'child') ?| array[
      'recipient_certificate_number',
      'recipient_certificate_ciphertext'
    ])
  )
);

create index document_consent_sources_document_idx
  on public.document_consent_sources (
    tenant_id, document_id, target_version_number, captured_at desc, consent_record_id
  );

create trigger document_consent_sources_append_only
before update or delete on public.document_consent_sources
for each row execute function app_private.prevent_document_history_mutation();

alter table public.document_consent_sources enable row level security;
alter table public.document_consent_sources force row level security;

create policy document_consent_sources_read on public.document_consent_sources
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
  );

revoke all on public.document_consent_sources from public;

alter table public.document_snapshots
  add column consent_record_id uuid,
  add constraint document_snapshots_consent_source_fkey
    foreign key (tenant_id, consent_record_id)
    references public.document_consent_sources(tenant_id, consent_record_id) on delete restrict;

create index document_snapshots_consent_source_idx
  on public.document_snapshots (tenant_id, consent_record_id)
  where consent_record_id is not null;

create or replace function app_private.validate_document_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_document public.case_documents%rowtype;
  consent_source public.document_consent_sources%rowtype;
  expected_key text;
begin
  select d.*
    into source_document
  from public.case_documents d
  where d.tenant_id = new.tenant_id
    and d.id = new.document_id
    and d.deleted_at is null;

  if source_document.id is null then
    raise exception using errcode = '23503', message = 'snapshot source document is unavailable';
  end if;
  if new.document_row_version <> source_document.row_version
     or new.source_status <> source_document.status
     or new.template_version <> source_document.template_version then
    raise exception using errcode = '40001', message = 'snapshot source document changed';
  end if;
  if new.snapshot_kind = 'draft'
     and source_document.status not in ('draft', 'internal_review', 'explanation_pending', 'consented') then
    raise exception using errcode = '55000', message = 'draft snapshot is not valid for a finalized document';
  end if;
  if new.snapshot_kind in ('official', 'corrected')
     and source_document.status not in ('approved', 'distributed', 'active', 'superseded', 'closed') then
    raise exception using errcode = '55000', message = 'official snapshot requires an approved document';
  end if;

  if new.snapshot_kind in ('official', 'corrected') or source_document.status = 'consented' then
    if new.consent_record_id is null then
      raise exception using errcode = '55000', message = 'snapshot requires an immutable consent source';
    end if;
    select s.*
      into consent_source
    from public.document_consent_sources s
    where s.tenant_id = new.tenant_id
      and s.consent_record_id = new.consent_record_id
      and s.document_id = new.document_id
      and s.target_version_number = source_document.version_number;
    if consent_source.consent_record_id is null then
      raise exception using errcode = '23503', message = 'snapshot consent source is unavailable';
    end if;
  elsif new.consent_record_id is not null then
    raise exception using errcode = '23514', message = 'pre-consent draft cannot reference a consent source';
  end if;

  expected_key := 'tenants/' || new.tenant_id::text
    || '/documents/' || new.document_id::text
    || '/' || new.id::text || '.pdf';
  if new.storage_key <> expected_key then
    raise exception using errcode = '23514', message = 'snapshot storage key does not match its tenant and document';
  end if;
  return new;
end
$$;

-- Replace the old signature: the consent record and its exact rendering source
-- are one atomic append.  A consent without a source can no longer be created
-- through the supported runtime path.
drop function app_private.append_document_consent(
  uuid, uuid, bigint, text, text, text, timestamptz, timestamptz
);

create function app_private.append_document_consent(
  record_id uuid,
  requested_document_id uuid,
  expected_document_row_version bigint,
  requested_signer_name text,
  requested_signer_relationship text,
  requested_explanation_method text,
  requested_explained_at timestamptz,
  requested_consented_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_document public.case_documents%rowtype;
  consent_source_json jsonb;
  consent_child_json jsonb;
  consent_guardian_json jsonb;
  consent_facility_json jsonb;
  consent_organization_json jsonb;
  consent_goals_json jsonb;
  consent_monitoring_json jsonb;
  consent_schedules_json jsonb;
  consent_certificate_ciphertext bytea;
  computed_source_sha256 text;
  computed_certificate_sha256 text;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'consent actor context is required';
  end if;
  if not app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver']) then
    raise exception using errcode = '42501', message = 'consent requires an approver role';
  end if;
  if requested_signer_name is null or btrim(requested_signer_name) = ''
     or requested_signer_relationship is null or btrim(requested_signer_relationship) = ''
     or requested_explanation_method not in ('in_person', 'online', 'telephone', 'written', 'other')
     or requested_explained_at is null
     or requested_consented_at is null
     or requested_consented_at < requested_explained_at
     or requested_explained_at > now() + interval '5 minutes'
     or requested_consented_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'valid consent details are required';
  end if;
  select d.*
    into source_document
  from public.case_documents d
  where d.tenant_id = app_private.current_tenant_id()
    and d.id = requested_document_id
    and d.status = 'consented'
    and d.row_version = expected_document_row_version
    and d.consented_at = requested_consented_at
    and d.deleted_at is null
    and app_private.can_access_facility(d.facility_id)
  for update;

  if source_document.id is null then
    raise exception using errcode = '55000', message = 'consent does not match the current document version';
  end if;

  -- Build the rendering aggregate from authoritative rows inside this
  -- SECURITY DEFINER function. The runtime caller never supplies PDF source
  -- JSON or its digest, so a direct SQL client cannot self-sign forged content.
  select
    jsonb_build_object(
      'id', c.id,
      'management_code', c.management_code,
      'display_name', c.display_name,
      'legal_name', c.legal_name,
      'birth_date', c.birth_date,
      'grade', c.grade,
      'gender', c.gender,
      'disability_category', c.disability_category,
      'municipality_name', c.municipality_name,
      'copayment_limit_yen', c.copayment_limit_yen,
      'recipient_certificate_last4', c.recipient_certificate_last4,
      'certificate_valid_from', c.certificate_valid_from,
      'certificate_valid_to', c.certificate_valid_to
    ),
    c.recipient_certificate_ciphertext
    into consent_child_json, consent_certificate_ciphertext
  from public.children c
  where c.tenant_id = source_document.tenant_id
    and c.id = source_document.child_id
    and c.deleted_at is null;

  select
    jsonb_build_object(
      'id', f.id,
      'code', f.code,
      'name', f.name,
      'service_type', f.service_type
    ),
    jsonb_build_object('id', o.id, 'name', o.name)
    into consent_facility_json, consent_organization_json
  from public.facilities f
  join public.organizations o on o.id = f.tenant_id
  where f.tenant_id = source_document.tenant_id
    and f.id = source_document.facility_id;

  if consent_child_json is null
     or consent_facility_json is null
     or consent_organization_json is null then
    raise exception using errcode = '55000', message = 'consent source rows are unavailable';
  end if;

  select jsonb_build_object('legal_name', g.legal_name, 'relationship', g.relationship)
    into consent_guardian_json
  from public.guardians g
  where g.tenant_id = source_document.tenant_id
    and g.child_id = source_document.child_id
  order by g.is_primary desc, g.created_at, g.id
  limit 1;

  select coalesce(
    jsonb_agg(to_jsonb(g) order by g.sort_order, g.id),
    '[]'::jsonb
  )
    into consent_goals_json
  from public.document_goals g
  where g.tenant_id = source_document.tenant_id
    and g.document_id = source_document.id;

  select coalesce(
    jsonb_agg(
      to_jsonb(r) || jsonb_build_object('goal_title', g.title)
      order by g.sort_order, r.id
    ),
    '[]'::jsonb
  )
    into consent_monitoring_json
  from public.monitoring_goal_results r
  join public.document_goals g
    on g.tenant_id = r.tenant_id
   and g.id = r.goal_id
  where r.tenant_id = source_document.tenant_id
    and r.monitoring_document_id = source_document.id;

  select coalesce(
    jsonb_agg(
      to_jsonb(latest_schedule)
      || jsonb_build_object(
        'items', coalesce(
          (
            select jsonb_agg(to_jsonb(i) order by i.day_of_week, i.start_minute, i.sort_order, i.id)
            from public.schedule_items i
            where i.tenant_id = source_document.tenant_id
              and i.schedule_version_id = latest_schedule.id
          ),
          '[]'::jsonb
        )
      )
      order by latest_schedule.schedule_kind
    ),
    '[]'::jsonb
  )
    into consent_schedules_json
  from (
    select distinct on (s.schedule_kind) s.*
    from public.schedule_versions s
    where s.tenant_id = source_document.tenant_id
      and s.child_id = source_document.child_id
      and s.status = 'finalized'
    order by s.schedule_kind, s.version_number desc, s.id desc
  ) latest_schedule;

  consent_source_json := jsonb_build_object(
    'document', jsonb_build_object(
      'id', source_document.id,
      'document_kind', source_document.document_kind,
      'status', source_document.status,
      'version_number', source_document.version_number,
      'template_version', source_document.template_version,
      'period_start', source_document.period_start,
      'period_end', source_document.period_end,
      'payload', coalesce(source_document.payload, '{}'::jsonb),
      'row_version', source_document.row_version,
      'updated_at', source_document.updated_at
    ),
    'child', consent_child_json,
    'guardian', consent_guardian_json,
    'facility', consent_facility_json,
    'organization', consent_organization_json,
    'approval', jsonb_build_object('approved_by_name', null, 'approved_at', null),
    'consent', jsonb_build_object(
      'signer_name', requested_signer_name,
      'signer_relationship', requested_signer_relationship,
      'explanation_method', requested_explanation_method,
      'explained_at', requested_explained_at,
      'consented_at', requested_consented_at
    ),
    'distribution', null,
    'goals', consent_goals_json,
    'monitoringResults', consent_monitoring_json,
    'schedules', consent_schedules_json
  );
  computed_source_sha256 := encode(
    sha256(convert_to(consent_source_json::text, 'UTF8')),
    'hex'
  );
  computed_certificate_sha256 := case
    when consent_certificate_ciphertext is null then null
    else encode(sha256(consent_certificate_ciphertext), 'hex')
  end;

  insert into public.document_consent_records (
    id, tenant_id, document_id, target_version_number, document_row_version,
    signer_name, signer_relationship, explanation_method, explained_at,
    consented_at, explained_by
  ) values (
    record_id,
    app_private.current_tenant_id(),
    requested_document_id,
    source_document.version_number,
    expected_document_row_version,
    requested_signer_name,
    requested_signer_relationship,
    requested_explanation_method,
    requested_explained_at,
    requested_consented_at,
    app_private.current_user_id()
  );

  insert into public.document_consent_sources (
    consent_record_id, tenant_id, document_id, target_version_number,
    document_row_version, source_json, source_sha256,
    recipient_certificate_ciphertext,
    recipient_certificate_ciphertext_sha256
  ) values (
    record_id,
    app_private.current_tenant_id(),
    requested_document_id,
    source_document.version_number,
    expected_document_row_version,
    consent_source_json,
    computed_source_sha256,
    consent_certificate_ciphertext,
    computed_certificate_sha256
  );
end
$$;

revoke execute on function app_private.append_document_consent(
  uuid, uuid, bigint, text, text, text, timestamptz, timestamptz
) from public;

-- Every goal mutation locks the parent document first and increments the
-- aggregate ETag.  Consent takes the same lock, so it cannot race a goal edit.
create or replace function app_private.lock_document_for_goal_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_tenant_id uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  requested_document_id uuid := case when tg_op = 'DELETE' then old.document_id else new.document_id end;
  parent_document public.case_documents%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.tenant_id is distinct from old.tenant_id
    or new.document_id is distinct from old.document_id
    or new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception using errcode = '55000', message = 'goal identity is immutable';
  end if;
  if requested_tenant_id is distinct from app_private.current_tenant_id()
     or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'goal mutation actor context is required';
  end if;

  select d.*
    into parent_document
  from public.case_documents d
  where d.tenant_id = requested_tenant_id
    and d.id = requested_document_id
    and d.deleted_at is null
    and app_private.can_access_facility(d.facility_id)
  for update;

  if parent_document.id is null then
    raise exception using errcode = '42501', message = 'goal parent document is unavailable';
  end if;
  if parent_document.status not in ('draft', 'internal_review', 'explanation_pending') then
    raise exception using errcode = '55000', message = 'finalized document goals are immutable';
  end if;

  update public.case_documents
     set updated_by = app_private.current_user_id()
   where tenant_id = requested_tenant_id and id = requested_document_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger document_goals_lock_parent_and_bump
before insert or update or delete on public.document_goals
for each row execute function app_private.lock_document_for_goal_mutation();

revoke execute on function app_private.lock_document_for_goal_mutation() from public;

-- SELECT FOR UPDATE is also checked against UPDATE RLS policies. Auditors have
-- PDF export permission but intentionally cannot edit documents, so acquire
-- the serialization lock through this narrowly scoped definer function.
create or replace function app_private.lock_document_for_pdf(
  requested_child_id uuid,
  requested_document_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_document_id uuid;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null
     or not app_private.has_tenant_role(array[
       'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
     ]) then
    raise exception using errcode = '42501', message = 'document PDF lock is not permitted';
  end if;

  select d.id
    into locked_document_id
  from public.case_documents d
  where d.tenant_id = app_private.current_tenant_id()
    and d.child_id = requested_child_id
    and d.id = requested_document_id
    and d.deleted_at is null
    and app_private.can_access_facility(d.facility_id)
  for update;

  if locked_document_id is null then
    raise exception using errcode = '42501', message = 'document PDF lock is not permitted';
  end if;
end
$$;

revoke execute on function app_private.lock_document_for_pdf(uuid, uuid) from public;

commit;
