begin;

create table public.document_consent_records (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  target_version_number integer not null check (target_version_number > 0),
  document_row_version bigint not null check (document_row_version > 0),
  signer_name text not null check (btrim(signer_name) <> ''),
  signer_relationship text not null check (btrim(signer_relationship) <> ''),
  explanation_method text not null check (
    explanation_method in ('in_person', 'online', 'telephone', 'written', 'other')
  ),
  explained_at timestamptz not null,
  consented_at timestamptz not null,
  explained_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.case_documents(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, document_id, document_row_version),
  check (consented_at >= explained_at)
);

create index document_consent_records_document_idx
  on public.document_consent_records (tenant_id, document_id, created_at desc, id);
create index document_consent_records_explained_by_idx
  on public.document_consent_records (explained_by);

create table public.document_distribution_records (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  target_version_number integer not null check (target_version_number > 0),
  document_row_version bigint not null check (document_row_version > 0),
  recipient_name text not null check (btrim(recipient_name) <> ''),
  delivery_method text not null check (
    delivery_method in ('in_person', 'postal_mail', 'email', 'portal', 'other')
  ),
  distributed_at timestamptz not null,
  distributed_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.case_documents(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, document_id, document_row_version)
);

create index document_distribution_records_document_idx
  on public.document_distribution_records (tenant_id, document_id, created_at desc, id);
create index document_distribution_records_distributed_by_idx
  on public.document_distribution_records (distributed_by);

create trigger document_consent_records_append_only
before update or delete on public.document_consent_records
for each row execute function app_private.prevent_document_history_mutation();

create trigger document_distribution_records_append_only
before update or delete on public.document_distribution_records
for each row execute function app_private.prevent_document_history_mutation();

create or replace function app_private.authorize_document_status_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver']) then
    return new;
  end if;

  if app_private.has_tenant_role(array['support_staff'])
     and old.status = 'draft'
     and new.status = 'internal_review' then
    return new;
  end if;

  raise exception using errcode = '42501', message = 'document transition is not permitted for this role';
end
$$;

create trigger case_documents_authorize_status_transition
before update on public.case_documents
for each row execute function app_private.authorize_document_status_transition();

create or replace function app_private.append_document_consent(
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
  document_version integer;
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

  select d.version_number
    into document_version
  from public.case_documents d
  where d.tenant_id = app_private.current_tenant_id()
    and d.id = requested_document_id
    and d.status = 'consented'
    and d.row_version = expected_document_row_version
    and d.consented_at = requested_consented_at
    and d.deleted_at is null
    and app_private.can_access_facility(d.facility_id);

  if document_version is null then
    raise exception using errcode = '55000', message = 'consent does not match the current document version';
  end if;

  insert into public.document_consent_records (
    id, tenant_id, document_id, target_version_number, document_row_version,
    signer_name, signer_relationship, explanation_method, explained_at,
    consented_at, explained_by
  ) values (
    record_id,
    app_private.current_tenant_id(),
    requested_document_id,
    document_version,
    expected_document_row_version,
    requested_signer_name,
    requested_signer_relationship,
    requested_explanation_method,
    requested_explained_at,
    requested_consented_at,
    app_private.current_user_id()
  );
end
$$;

create or replace function app_private.append_document_distribution(
  record_id uuid,
  requested_document_id uuid,
  expected_document_row_version bigint,
  requested_recipient_name text,
  requested_delivery_method text,
  requested_distributed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_version integer;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'distribution actor context is required';
  end if;
  if not app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver']) then
    raise exception using errcode = '42501', message = 'distribution requires an approver role';
  end if;
  if requested_recipient_name is null or btrim(requested_recipient_name) = ''
     or requested_delivery_method not in ('in_person', 'postal_mail', 'email', 'portal', 'other')
     or requested_distributed_at is null
     or requested_distributed_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'valid distribution details are required';
  end if;

  select d.version_number
    into document_version
  from public.case_documents d
  where d.tenant_id = app_private.current_tenant_id()
    and d.id = requested_document_id
    and d.status = 'distributed'
    and d.row_version = expected_document_row_version
    and d.distributed_at = requested_distributed_at
    and d.deleted_at is null
    and app_private.can_access_facility(d.facility_id);

  if document_version is null then
    raise exception using errcode = '55000', message = 'distribution does not match the current document version';
  end if;

  insert into public.document_distribution_records (
    id, tenant_id, document_id, target_version_number, document_row_version,
    recipient_name, delivery_method, distributed_at, distributed_by
  ) values (
    record_id,
    app_private.current_tenant_id(),
    requested_document_id,
    document_version,
    expected_document_row_version,
    requested_recipient_name,
    requested_delivery_method,
    requested_distributed_at,
    app_private.current_user_id()
  );
end
$$;

-- Support staff may append only a submission event. All other formal events
-- are restricted to a tenant/facility administrator or plan approver.
create or replace function app_private.append_document_event(
  event_id uuid,
  requested_document_id uuid,
  requested_event_type text,
  event_reason text,
  event_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_name text;
  actor_role text;
  document_status text;
  event_matches_status boolean := false;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'document event actor context is required';
  end if;

  select d.status
    into document_status
  from public.case_documents d
  where d.tenant_id = app_private.current_tenant_id()
    and d.id = requested_document_id
    and d.deleted_at is null
    and app_private.can_access_facility(d.facility_id);

  if document_status is null then
    raise exception using errcode = '42501', message = 'document access denied';
  end if;

  select u.display_name, m.role
    into actor_name, actor_role
  from public.app_users u
  join public.memberships m
    on m.user_id = u.id
   and m.tenant_id = app_private.current_tenant_id()
   and m.status = 'active'
  where u.id = app_private.current_user_id()
    and u.status = 'active';

  if actor_name is null
     or not (
       actor_role in ('tenant_admin', 'facility_admin', 'plan_approver')
       or (actor_role = 'support_staff' and requested_event_type = 'submitted')
     ) then
    raise exception using errcode = '42501', message = 'document event is not permitted for this role';
  end if;

  event_matches_status := case requested_event_type
    when 'submitted' then document_status = 'internal_review'
    when 'returned' then document_status in ('draft', 'internal_review')
    when 'explained' then document_status = 'explanation_pending'
    when 'consented' then document_status = 'consented'
    when 'approved' then document_status = 'approved'
    when 'distributed' then document_status = 'distributed'
    when 'activated' then document_status = 'active'
    when 'superseded' then document_status = 'superseded'
    when 'closed' then document_status = 'closed'
    when 'voided' then document_status = 'void'
    else false
  end;
  if not event_matches_status then
    raise exception using errcode = '55000', message = 'document event does not match the current status';
  end if;

  insert into public.document_events (
    id, tenant_id, document_id, event_type, actor_user_id,
    actor_name_snapshot, actor_role_snapshot, reason, metadata
  ) values (
    event_id,
    app_private.current_tenant_id(),
    requested_document_id,
    requested_event_type,
    app_private.current_user_id(),
    actor_name,
    actor_role,
    nullif(event_reason, ''),
    coalesce(event_metadata, '{}'::jsonb)
  );
end
$$;

alter table public.document_consent_records enable row level security;
alter table public.document_consent_records force row level security;
alter table public.document_distribution_records enable row level security;
alter table public.document_distribution_records force row level security;

create policy document_consent_records_read on public.document_consent_records
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
  );
create policy document_consent_records_insert on public.document_consent_records
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and explained_by = app_private.current_user_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

create policy document_distribution_records_read on public.document_distribution_records
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
  );
create policy document_distribution_records_insert on public.document_distribution_records
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and distributed_by = app_private.current_user_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

drop policy document_events_insert on public.document_events;
create policy document_events_insert on public.document_events
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and actor_user_id = app_private.current_user_id()
    and (
      app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
      or (
        event_type = 'submitted'
        and app_private.has_tenant_role(array['support_staff'])
      )
    )
  );

revoke all on public.document_consent_records from public;
revoke all on public.document_distribution_records from public;
revoke execute on function app_private.append_document_consent(uuid, uuid, bigint, text, text, text, timestamptz, timestamptz) from public;
revoke execute on function app_private.append_document_distribution(uuid, uuid, bigint, text, text, timestamptz) from public;
revoke execute on function app_private.authorize_document_status_transition() from public;

commit;
