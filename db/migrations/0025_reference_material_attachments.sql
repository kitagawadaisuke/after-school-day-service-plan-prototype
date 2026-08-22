begin;

-- 受け取った計画書・面談資料を、アセスメントの参考資料として保管する。
-- 帳票PDFとは別の、利用児ごとの添付ファイルであるため、文書本文の版管理
-- やPDF生成ジョブとは混在させない。
create table public.reference_material_attachments (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  content_type text not null check (content_type in (
    'application/pdf',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )),
  byte_size integer not null check (byte_size between 1 and 15728640),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null check (octet_length(content) = byte_size),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, document_id) references public.case_documents(tenant_id, id) on delete restrict,
  foreign key (created_by) references public.app_users(id) on delete restrict,
  foreign key (deleted_by) references public.app_users(id) on delete restrict,
  unique (tenant_id, id),
  check ((deleted_at is null and deleted_by is null) or (deleted_at is not null and deleted_by is not null))
);

create index reference_material_attachments_document_idx
  on public.reference_material_attachments (tenant_id, document_id, created_at desc)
  where deleted_at is null;

create or replace function app_private.protect_reference_material_attachment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'reference material attachment is already deleted';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.document_id is distinct from old.document_id
     or new.original_filename is distinct from old.original_filename
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.sha256 is distinct from old.sha256
     or new.content is distinct from old.content
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.deleted_at is null
     or new.deleted_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '55000', message = 'reference material attachment is append-only';
  end if;
  new.row_version := old.row_version + 1;
  return new;
end
$$;

create trigger reference_material_attachments_soft_delete_only
before update on public.reference_material_attachments
for each row execute function app_private.protect_reference_material_attachment();

alter table public.reference_material_attachments enable row level security;
alter table public.reference_material_attachments force row level security;

create policy reference_material_attachments_read on public.reference_material_attachments
for select using (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.case_documents d
    where d.tenant_id = reference_material_attachments.tenant_id
      and d.id = reference_material_attachments.document_id
      and d.document_kind = 'consultation_plan'
      and app_private.can_access_document(d.id)
  )
);

create policy reference_material_attachments_insert on public.reference_material_attachments
for insert with check (
  tenant_id = app_private.current_tenant_id()
  and created_by = app_private.current_user_id()
  and exists (
    select 1 from public.case_documents d
    where d.tenant_id = reference_material_attachments.tenant_id
      and d.id = reference_material_attachments.document_id
      and d.document_kind = 'consultation_plan'
      and d.status in ('draft', 'internal_review', 'explanation_pending')
      and app_private.can_access_document(d.id)
  )
);

create policy reference_material_attachments_update on public.reference_material_attachments
for update using (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.case_documents d
    where d.tenant_id = reference_material_attachments.tenant_id
      and d.id = reference_material_attachments.document_id
      and d.document_kind = 'consultation_plan'
      and d.status in ('draft', 'internal_review', 'explanation_pending')
      and app_private.can_access_document(d.id)
  )
) with check (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.case_documents d
    where d.tenant_id = reference_material_attachments.tenant_id
      and d.id = reference_material_attachments.document_id
      and d.document_kind = 'consultation_plan'
      and d.status in ('draft', 'internal_review', 'explanation_pending')
      and app_private.can_access_document(d.id)
  )
);

revoke all on public.reference_material_attachments from public;

commit;
