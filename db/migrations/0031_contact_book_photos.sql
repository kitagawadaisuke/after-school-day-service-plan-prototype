begin;

create table public.contact_book_photos (
  id uuid primary key,
  tenant_id uuid not null,
  contact_book_entry_id uuid not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5 * 1024 * 1024),
  content bytea not null,
  created_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.app_users(id) on delete restrict,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, contact_book_entry_id)
    references public.contact_book_entries(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  check ((deleted_at is null and deleted_by is null) or (deleted_at is not null and deleted_by is not null))
);

create index contact_book_photos_entry_idx
  on public.contact_book_photos (tenant_id, contact_book_entry_id, created_at)
  where deleted_at is null;

create or replace function app_private.protect_contact_book_photo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'contact-book photo is already deleted';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.contact_book_entry_id is distinct from old.contact_book_entry_id
     or new.original_filename is distinct from old.original_filename
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.content is distinct from old.content
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.deleted_at is null
     or new.deleted_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '55000', message = 'contact-book photo is append-only';
  end if;
  new.row_version := old.row_version + 1;
  return new;
end
$$;

create trigger contact_book_photos_soft_delete_only
before update on public.contact_book_photos
for each row execute function app_private.protect_contact_book_photo();

alter table public.contact_book_photos enable row level security;
alter table public.contact_book_photos force row level security;

create policy contact_book_photos_read on public.contact_book_photos
for select using (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.contact_book_entries entry
    where entry.tenant_id = contact_book_photos.tenant_id
      and entry.id = contact_book_photos.contact_book_entry_id
      and entry.deleted_at is null
      and app_private.can_access_facility(entry.facility_id)
  )
);

create policy contact_book_photos_insert on public.contact_book_photos
for insert with check (
  tenant_id = app_private.current_tenant_id()
  and created_by = app_private.current_user_id()
  and exists (
    select 1 from public.contact_book_entries entry
    where entry.tenant_id = contact_book_photos.tenant_id
      and entry.id = contact_book_photos.contact_book_entry_id
      and entry.deleted_at is null
      and app_private.can_access_facility(entry.facility_id)
      and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  )
);

create policy contact_book_photos_delete on public.contact_book_photos
for update using (
  tenant_id = app_private.current_tenant_id()
  and exists (
    select 1 from public.contact_book_entries entry
    where entry.tenant_id = contact_book_photos.tenant_id
      and entry.id = contact_book_photos.contact_book_entry_id
      and entry.deleted_at is null
      and app_private.can_access_facility(entry.facility_id)
      and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  )
) with check (
  tenant_id = app_private.current_tenant_id()
  and deleted_by = app_private.current_user_id()
);

revoke all on public.contact_book_photos from public;

commit;
