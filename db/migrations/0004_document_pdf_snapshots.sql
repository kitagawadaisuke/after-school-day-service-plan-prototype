begin;

-- A snapshot is evidence of one exact row-version of a document.  Keeping the
-- source status makes the distinction between a review copy and an official
-- record explicit even after the source document moves to a later state.
-- No production writer existed before this migration.  If a database contains
-- manually imported rows, fail instead of inventing a historical source status
-- from the document's current state; operations must perform an explicit,
-- evidence-backed backfill first.
do $$
begin
  if exists (select 1 from public.document_snapshots) then
    raise exception using
      errcode = '55000',
      message = 'preexisting document snapshots require an explicit source-version backfill';
  end if;
end
$$;

alter table public.document_snapshots
  add column document_row_version bigint,
  add column source_status text;

alter table public.document_snapshots
  alter column document_row_version set not null,
  alter column source_status set not null,
  add constraint document_snapshots_row_version_positive
    check (document_row_version > 0),
  add constraint document_snapshots_source_status_known
    check (source_status in (
      'draft', 'internal_review', 'explanation_pending', 'consented',
      'approved', 'distributed', 'active', 'superseded', 'closed', 'void'
    ));

-- One rendering per immutable source state.  Concurrent requests either reuse
-- the committed row or wait on the source document lock in the application.
create unique index document_snapshots_source_version_kind_idx
  on public.document_snapshots (
    tenant_id, document_id, document_row_version, snapshot_kind
  );

create or replace function app_private.validate_document_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_document public.case_documents%rowtype;
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
     and source_document.status not in (
       'draft', 'internal_review', 'explanation_pending', 'consented'
     ) then
    raise exception using errcode = '55000', message = 'draft snapshot is not valid for a finalized document';
  end if;

  if new.snapshot_kind in ('official', 'corrected')
     and source_document.status not in (
       'approved', 'distributed', 'active', 'superseded', 'closed'
     ) then
    raise exception using errcode = '55000', message = 'official snapshot requires an approved document';
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

create trigger document_snapshots_validate_source
before insert on public.document_snapshots
for each row execute function app_private.validate_document_snapshot();

-- EXPORT_PDF is granted to these roles in the application policy.  The
-- database independently enforces the same deny-by-default boundary.
drop policy document_snapshots_insert on public.document_snapshots;
create policy document_snapshots_insert on public.document_snapshots
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array[
      'tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'auditor'
    ])
    and generated_by = app_private.current_user_id()
  );

commit;
