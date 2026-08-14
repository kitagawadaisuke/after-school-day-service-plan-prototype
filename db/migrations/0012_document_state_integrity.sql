begin;

alter table public.case_documents
  add column last_transition_from_status text,
  add column last_transition_to_status text,
  add column last_transition_row_version bigint,
  add constraint case_documents_transition_marker_check check (
    (
      last_transition_from_status is null
      and last_transition_to_status is null
      and last_transition_row_version is null
    )
    or (
      last_transition_from_status in (
        'draft', 'internal_review', 'explanation_pending', 'consented',
        'approved', 'distributed', 'active', 'superseded', 'closed', 'void'
      )
      and last_transition_to_status = status
      and last_transition_from_status <> last_transition_to_status
      and last_transition_row_version > 0
      and last_transition_row_version <= row_version
    )
  );

-- Keep the workflow event bound to the exact aggregate revision it records.
-- The columns remain nullable for pre-migration history; every event appended by
-- the runtime function below receives a complete transition identity.
alter table public.document_events
  add column document_row_version bigint,
  add column from_status text,
  add column to_status text,
  add column consent_record_id uuid,
  add column distribution_record_id uuid,
  add constraint document_events_transition_identity_check check (
    (
      document_row_version is null
      and from_status is null
      and to_status is null
    )
    or (
      document_row_version > 0
      and from_status in (
        'draft', 'internal_review', 'explanation_pending', 'consented',
        'approved', 'distributed', 'active', 'superseded', 'closed', 'void'
      )
      and to_status in (
        'draft', 'internal_review', 'explanation_pending', 'consented',
        'approved', 'distributed', 'active', 'superseded', 'closed', 'void'
      )
      and from_status <> to_status
    )
  ),
  add constraint document_events_consent_pointer_type_check check (
    consent_record_id is null or event_type in ('consented', 'approved')
  ),
  add constraint document_events_distribution_pointer_type_check check (
    distribution_record_id is null or event_type = 'distributed'
  ),
  add constraint document_events_consent_source_fkey
    foreign key (tenant_id, consent_record_id)
    references public.document_consent_sources(tenant_id, consent_record_id)
    on delete restrict,
  add constraint document_events_distribution_record_fkey
    foreign key (tenant_id, distribution_record_id)
    references public.document_distribution_records(tenant_id, id)
    on delete restrict;

create unique index document_events_transition_revision_uidx
  on public.document_events (
    tenant_id, document_id, document_row_version
  )
  where document_row_version is not null;

create index document_events_consent_source_idx
  on public.document_events (tenant_id, consent_record_id)
  where consent_record_id is not null;

create index document_events_distribution_record_idx
  on public.document_events (tenant_id, distribution_record_id)
  where distribution_record_id is not null;

create or replace function app_private.document_transition_event_type(
  previous_status text,
  next_status text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when previous_status = 'draft' and next_status = 'internal_review' then 'submitted'
    when previous_status = 'internal_review' and next_status = 'draft' then 'returned'
    when previous_status = 'internal_review' and next_status = 'explanation_pending' then 'explained'
    when previous_status = 'explanation_pending' and next_status = 'internal_review' then 'returned'
    when previous_status = 'explanation_pending' and next_status = 'consented' then 'consented'
    when previous_status = 'consented' and next_status = 'internal_review' then 'returned'
    when previous_status = 'consented' and next_status = 'approved' then 'approved'
    when previous_status = 'approved' and next_status = 'distributed' then 'distributed'
    when previous_status = 'distributed' and next_status = 'active' then 'activated'
    when previous_status = 'active' and next_status = 'superseded' then 'superseded'
    when previous_status = 'active' and next_status = 'closed' then 'closed'
    when next_status = 'void'
      and previous_status in (
        'draft', 'internal_review', 'explanation_pending', 'consented',
        'approved', 'distributed', 'active'
      ) then 'voided'
    else null
  end
$$;

create or replace function app_private.document_event_action(requested_event_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case requested_event_type
    when 'submitted' then 'submit'
    when 'returned' then 'return'
    when 'explained' then 'explain'
    when 'consented' then 'consent'
    when 'approved' then 'approve'
    when 'distributed' then 'distribute'
    when 'activated' then 'activate'
    when 'superseded' then 'supersede'
    when 'closed' then 'close'
    when 'voided' then 'void'
    else null
  end
$$;

-- New aggregates always start as editable drafts. Formal timestamps cannot be
-- smuggled into an INSERT and later treated as historical workflow evidence.
create or replace function app_private.enforce_case_document_draft_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from 'draft'
     or new.consented_at is not null
     or new.approved_at is not null
     or new.approved_by is not null
     or new.distributed_at is not null
     or new.last_transition_from_status is not null
     or new.last_transition_to_status is not null
     or new.last_transition_row_version is not null then
    raise exception using
      errcode = '23514',
      message = 'case documents must be inserted as drafts without formal metadata';
  end if;
  return new;
end
$$;

create trigger case_documents_enforce_draft_insert
before insert on public.case_documents
for each row execute function app_private.enforce_case_document_draft_insert();

-- A runtime caller cannot manufacture an event for a transition that never
-- happened: these markers are overwritten by a trigger on every UPDATE.
create or replace function app_private.record_case_document_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.last_transition_from_status := old.status;
    new.last_transition_to_status := new.status;
    new.last_transition_row_version := old.row_version + 1;
  else
    new.last_transition_from_status := old.last_transition_from_status;
    new.last_transition_to_status := old.last_transition_to_status;
    new.last_transition_row_version := old.last_transition_row_version;
  end if;
  return new;
end
$$;

create trigger case_documents_record_status_transition
before update on public.case_documents
for each row execute function app_private.record_case_document_status_transition();

-- Preserve the metadata shape for each state and prevent a formal revision
-- from being bumped without a workflow transition and its corresponding event.
create or replace function app_private.validate_case_document_formal_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.consented_at is not null
     and new.status <> 'internal_review'
     and new.consented_at is distinct from old.consented_at then
    raise exception using
      errcode = '55000',
      message = 'workflow transitions cannot replace consent metadata';
  end if;

  if old.distributed_at is not null
     and new.distributed_at is distinct from old.distributed_at then
    raise exception using
      errcode = '55000',
      message = 'workflow transitions cannot replace distribution metadata';
  end if;

  if new.status is not distinct from old.status
     and old.status in (
       'consented', 'approved', 'distributed', 'active',
       'superseded', 'closed', 'void'
     ) then
    raise exception using
      errcode = '55000',
      message = 'formal document revisions require a workflow transition';
  end if;

  if new.status in ('draft', 'internal_review', 'explanation_pending')
     and (
       new.consented_at is not null
       or new.approved_at is not null
       or new.approved_by is not null
       or new.distributed_at is not null
     ) then
    raise exception using
      errcode = '23514',
      message = 'pre-consent document state cannot carry formal metadata';
  end if;

  if new.status = 'consented'
     and (
       new.consented_at is null
       or new.approved_at is not null
       or new.approved_by is not null
       or new.distributed_at is not null
     ) then
    raise exception using
      errcode = '23514',
      message = 'consented document metadata is inconsistent';
  end if;

  if new.status = 'approved'
     and (
       new.consented_at is null
       or new.approved_at is null
       or new.approved_by is null
       or new.distributed_at is not null
     ) then
    raise exception using
      errcode = '23514',
      message = 'approved document metadata is inconsistent';
  end if;

  if new.status in ('distributed', 'active', 'superseded', 'closed')
     and (
       new.consented_at is null
       or new.approved_at is null
       or new.approved_by is null
       or new.distributed_at is null
     ) then
    raise exception using
      errcode = '23514',
      message = 'post-distribution document metadata is inconsistent';
  end if;

  if new.status = 'void'
     and (
       new.consented_at is distinct from old.consented_at
       or new.approved_at is distinct from old.approved_at
       or new.approved_by is distinct from old.approved_by
       or new.distributed_at is distinct from old.distributed_at
     ) then
    raise exception using
      errcode = '23514',
      message = 'voiding cannot add or alter formal metadata';
  end if;

  return new;
end
$$;

create trigger case_documents_validate_formal_metadata
before update on public.case_documents
for each row execute function app_private.validate_case_document_formal_metadata();

-- Replace the event appender without changing its public signature. Transition
-- identity is copied from the API metadata into typed, indexed columns only
-- after it has been matched to the locked current document revision.
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
  document_version_number integer;
  current_document_row_version bigint;
  document_consented_at timestamptz;
  document_approved_at timestamptz;
  document_approved_by uuid;
  document_distributed_at timestamptz;
  document_transition_from_status text;
  document_transition_to_status text;
  document_transition_row_version bigint;
  requested_from_status text;
  requested_to_status text;
  requested_action text;
  requested_row_version bigint;
  requested_version_number integer;
  expected_event_type text;
  linked_consent_record_id uuid;
  linked_distribution_record_id uuid;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'document event actor context is required';
  end if;

  select
    d.status,
    d.version_number,
    d.row_version,
    d.consented_at,
    d.approved_at,
    d.approved_by,
    d.distributed_at,
    d.last_transition_from_status,
    d.last_transition_to_status,
    d.last_transition_row_version
  into
    document_status,
    document_version_number,
    current_document_row_version,
    document_consented_at,
    document_approved_at,
    document_approved_by,
    document_distributed_at,
    document_transition_from_status,
    document_transition_to_status,
    document_transition_row_version
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

  if event_metadata is null or jsonb_typeof(event_metadata) <> 'object'
     or coalesce(event_metadata ->> 'documentRowVersion', '') !~ '^[1-9][0-9]*$'
     or coalesce(event_metadata ->> 'documentVersionNumber', '') !~ '^[1-9][0-9]*$' then
    raise exception using errcode = '22023', message = 'complete document transition metadata is required';
  end if;

  requested_from_status := event_metadata ->> 'fromStatus';
  requested_to_status := event_metadata ->> 'toStatus';
  requested_action := event_metadata ->> 'action';
  requested_row_version := (event_metadata ->> 'documentRowVersion')::bigint;
  requested_version_number := (event_metadata ->> 'documentVersionNumber')::integer;
  expected_event_type := app_private.document_transition_event_type(
    requested_from_status,
    requested_to_status
  );

  if expected_event_type is null
     or requested_event_type is distinct from expected_event_type
     or requested_action is distinct from app_private.document_event_action(expected_event_type)
     or requested_to_status is distinct from document_status
     or requested_row_version is distinct from current_document_row_version
     or requested_version_number is distinct from document_version_number
     or requested_from_status is distinct from document_transition_from_status
     or requested_to_status is distinct from document_transition_to_status
     or requested_row_version is distinct from document_transition_row_version then
    raise exception using errcode = '55000', message = 'document event does not match the current transition';
  end if;

  if requested_event_type = 'consented' then
    select s.consent_record_id
      into linked_consent_record_id
    from public.document_consent_sources s
    join public.document_consent_records c
      on c.tenant_id = s.tenant_id
     and c.id = s.consent_record_id
    where s.tenant_id = app_private.current_tenant_id()
      and s.document_id = requested_document_id
      and s.target_version_number = document_version_number
      and s.document_row_version = current_document_row_version
      and c.document_row_version = current_document_row_version
      and c.consented_at = document_consented_at
    limit 1;

    if linked_consent_record_id is null then
      raise exception using errcode = '55000', message = 'consent event requires its exact immutable source';
    end if;
  elsif requested_event_type = 'approved' then
    if document_approved_at is null
       or document_approved_by is distinct from app_private.current_user_id() then
      raise exception using errcode = '55000', message = 'approval event does not match approval metadata';
    end if;

    select s.consent_record_id
      into linked_consent_record_id
    from public.document_consent_sources s
    join public.document_consent_records c
      on c.tenant_id = s.tenant_id
     and c.id = s.consent_record_id
    where s.tenant_id = app_private.current_tenant_id()
      and s.document_id = requested_document_id
      and s.target_version_number = document_version_number
      and s.document_row_version = current_document_row_version - 1
      and c.document_row_version = s.document_row_version
      and c.consented_at = document_consented_at
    order by s.captured_at desc, s.consent_record_id desc
    limit 1;

    if linked_consent_record_id is null then
      raise exception using errcode = '55000', message = 'approval event requires an immutable consent source';
    end if;
  elsif requested_event_type = 'distributed' then
    select r.id
      into linked_distribution_record_id
    from public.document_distribution_records r
    where r.tenant_id = app_private.current_tenant_id()
      and r.document_id = requested_document_id
      and r.target_version_number = document_version_number
      and r.document_row_version = current_document_row_version
      and r.distributed_at = document_distributed_at
    limit 1;

    if linked_distribution_record_id is null then
      raise exception using errcode = '55000', message = 'distribution event requires its exact record';
    end if;
  end if;

  insert into public.document_events (
    id,
    tenant_id,
    document_id,
    event_type,
    actor_user_id,
    actor_name_snapshot,
    actor_role_snapshot,
    reason,
    metadata,
    document_row_version,
    from_status,
    to_status,
    consent_record_id,
    distribution_record_id
  ) values (
    event_id,
    app_private.current_tenant_id(),
    requested_document_id,
    requested_event_type,
    app_private.current_user_id(),
    actor_name,
    actor_role,
    nullif(event_reason, ''),
    event_metadata,
    requested_row_version,
    requested_from_status,
    requested_to_status,
    linked_consent_record_id,
    linked_distribution_record_id
  );
end
$$;

-- DEFERRABLE is essential: the repository first updates the aggregate and then
-- appends the consent/distribution records and event in the same transaction.
-- At COMMIT every status-changing row revision must have all of its evidence.
create or replace function app_private.check_case_document_transition_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_event_type text;
  expected_action text;
  transition_event public.document_events%rowtype;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  expected_event_type := app_private.document_transition_event_type(old.status, new.status);
  expected_action := app_private.document_event_action(expected_event_type);
  if expected_event_type is null then
    raise exception using errcode = '23514', message = 'invalid document status transition';
  end if;

  select e.*
    into transition_event
  from public.document_events e
  where e.tenant_id = new.tenant_id
    and e.document_id = new.id
    and e.document_row_version = new.row_version
    and e.from_status = old.status
    and e.to_status = new.status
    and e.event_type = expected_event_type
    and e.actor_user_id = new.updated_by
    and e.metadata ->> 'action' = expected_action
    and e.metadata ->> 'fromStatus' = old.status
    and e.metadata ->> 'toStatus' = new.status
    and e.metadata ->> 'documentRowVersion' = new.row_version::text
    and e.metadata ->> 'documentVersionNumber' = new.version_number::text
  order by e.event_at, e.id
  limit 1;

  if transition_event.id is null then
    raise exception using
      errcode = '23514',
      message = 'document transition requires an event for the exact row version';
  end if;

  if new.status = 'consented' and not exists (
    select 1
    from public.document_consent_records c
    join public.document_consent_sources s
      on s.tenant_id = c.tenant_id
     and s.consent_record_id = c.id
    where c.tenant_id = new.tenant_id
      and c.document_id = new.id
      and c.target_version_number = new.version_number
      and c.document_row_version = new.row_version
      and c.consented_at = new.consented_at
      and s.document_id = new.id
      and s.target_version_number = new.version_number
      and s.document_row_version = new.row_version
      and s.consent_record_id = transition_event.consent_record_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'consented transition requires its exact consent record and immutable source';
  end if;

  if new.approved_at is not null and not exists (
    select 1
    from public.document_events approval_event
    join public.document_consent_sources s
      on s.tenant_id = approval_event.tenant_id
     and s.consent_record_id = approval_event.consent_record_id
    join public.document_consent_records c
      on c.tenant_id = s.tenant_id
     and c.id = s.consent_record_id
    where approval_event.tenant_id = new.tenant_id
      and approval_event.document_id = new.id
      and approval_event.event_type = 'approved'
      and approval_event.to_status = 'approved'
      and approval_event.actor_user_id = new.approved_by
      and approval_event.document_row_version <= new.row_version
      and s.document_id = new.id
      and s.target_version_number = new.version_number
      and c.consented_at = new.consented_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'finalized document requires approval evidence and an immutable consent source';
  end if;

  if new.status = 'approved'
     and not exists (
       select 1
       from public.document_consent_sources s
       join public.document_consent_records c
         on c.tenant_id = s.tenant_id
        and c.id = s.consent_record_id
       where s.tenant_id = new.tenant_id
         and s.document_id = new.id
         and s.target_version_number = new.version_number
         and s.document_row_version = old.row_version
         and c.document_row_version = old.row_version
         and c.consented_at = old.consented_at
         and s.consent_record_id = transition_event.consent_record_id
         and transition_event.actor_user_id = new.approved_by
     ) then
    raise exception using
      errcode = '23514',
      message = 'approved transition requires exact approval event metadata';
  end if;

  if new.status = 'distributed' and not exists (
    select 1
    from public.document_distribution_records r
    where r.tenant_id = new.tenant_id
      and r.document_id = new.id
      and r.target_version_number = new.version_number
      and r.document_row_version = new.row_version
      and r.distributed_at = new.distributed_at
      and r.id = transition_event.distribution_record_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'distributed transition requires its exact distribution record';
  end if;

  if new.distributed_at is not null and not exists (
    select 1
    from public.document_events distribution_event
    join public.document_distribution_records r
      on r.tenant_id = distribution_event.tenant_id
     and r.id = distribution_event.distribution_record_id
    where distribution_event.tenant_id = new.tenant_id
      and distribution_event.document_id = new.id
      and distribution_event.event_type = 'distributed'
      and distribution_event.to_status = 'distributed'
      and distribution_event.document_row_version <= new.row_version
      and r.document_id = new.id
      and r.target_version_number = new.version_number
      and r.distributed_at = new.distributed_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'post-distribution document requires immutable distribution evidence';
  end if;

  return null;
end
$$;

create constraint trigger case_documents_transition_integrity
after update on public.case_documents
deferrable initially deferred
for each row execute function app_private.check_case_document_transition_integrity();

revoke execute on function app_private.document_transition_event_type(text, text) from public;
revoke execute on function app_private.document_event_action(text) from public;
revoke execute on function app_private.enforce_case_document_draft_insert() from public;
revoke execute on function app_private.record_case_document_status_transition() from public;
revoke execute on function app_private.validate_case_document_formal_metadata() from public;
revoke execute on function app_private.check_case_document_transition_integrity() from public;

commit;
