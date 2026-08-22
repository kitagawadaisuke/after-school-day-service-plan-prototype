begin;

-- A profile image is used only to identify a child in the application UI.
-- It is intentionally kept out of the normal child SELECT list and is served
-- by an authenticated, no-store endpoint.
alter table public.children
  add column profile_photo bytea,
  add column profile_photo_content_type text,
  add column profile_photo_byte_size integer,
  add column profile_photo_updated_at timestamptz;

alter table public.children
  add constraint children_profile_photo_metadata_check check (
    (profile_photo is null
      and profile_photo_content_type is null
      and profile_photo_byte_size is null
      and profile_photo_updated_at is null)
    or
    (profile_photo is not null
      and profile_photo_content_type in ('image/jpeg', 'image/png', 'image/webp')
      and profile_photo_byte_size between 1 and 716800
      and profile_photo_updated_at is not null)
  );

commit;
