import { v7 as uuidv7 } from "uuid";
import { conflict, notFound } from "../errors.js";

export const MAX_CONTACT_BOOK_PHOTOS = 4;

function dateTime(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function serializePhoto(row) {
  return {
    id: row.id,
    fileName: row.original_filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    createdAt: dateTime(row.created_at),
    rowVersion: Number(row.row_version),
  };
}

export async function listContactBookPhotos(client, tenantId, entryIds) {
  if (!entryIds.length) return new Map();
  const result = await client.query(
    `select id, contact_book_entry_id, original_filename, content_type, byte_size, created_at, row_version
       from public.contact_book_photos
      where tenant_id = $1 and contact_book_entry_id = any($2::uuid[]) and deleted_at is null
      order by created_at, id`,
    [tenantId, entryIds],
  );
  const photosByEntry = new Map(entryIds.map((entryId) => [entryId, []]));
  for (const row of result.rows) photosByEntry.get(row.contact_book_entry_id)?.push(serializePhoto(row));
  return photosByEntry;
}

export async function createContactBookPhoto(client, actor, childId, entryId, input) {
  const entry = await client.query(
    `select id, facility_id from public.contact_book_entries
      where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null
      for update`,
    [actor.tenantId, childId, entryId],
  );
  if (!entry.rows[0]) throw notFound("連絡帳が見つかりません。");
  const count = await client.query(
    `select count(*)::int as count from public.contact_book_photos
      where tenant_id = $1 and contact_book_entry_id = $2 and deleted_at is null`,
    [actor.tenantId, entryId],
  );
  if (count.rows[0].count >= MAX_CONTACT_BOOK_PHOTOS) {
    throw conflict("CONTACT_PHOTO_LIMIT", "連絡帳に添付できる写真は4枚までです。");
  }
  const created = await client.query(
    `insert into public.contact_book_photos (
      id, tenant_id, contact_book_entry_id, original_filename, content_type,
      byte_size, content, created_by
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)
    returning *`,
    [uuidv7(), actor.tenantId, entryId, input.fileName, input.contentType, input.bytes.byteLength, input.bytes, actor.userId],
  );
  return { facilityId: entry.rows[0].facility_id, photo: serializePhoto(created.rows[0]) };
}

export async function getContactBookPhotoContent(client, tenantId, childId, entryId, photoId) {
  const result = await client.query(
    `select photo.original_filename, photo.content_type, photo.content
       from public.contact_book_photos photo
       join public.contact_book_entries entry
         on entry.tenant_id = photo.tenant_id and entry.id = photo.contact_book_entry_id
      where photo.tenant_id = $1 and entry.child_id = $2 and entry.id = $3 and photo.id = $4
        and entry.deleted_at is null and photo.deleted_at is null`,
    [tenantId, childId, entryId, photoId],
  );
  if (!result.rows[0]) throw notFound("連絡帳の写真が見つかりません。");
  return { fileName: result.rows[0].original_filename, contentType: result.rows[0].content_type, bytes: result.rows[0].content };
}

export async function deleteContactBookPhoto(client, actor, childId, entryId, photoId, expectedVersion) {
  const result = await client.query(
    `update public.contact_book_photos photo
        set deleted_at = now(), deleted_by = $6
       from public.contact_book_entries entry
      where photo.tenant_id = $1 and photo.contact_book_entry_id = $3 and photo.id = $4
        and photo.row_version = $5 and photo.deleted_at is null
        and entry.tenant_id = photo.tenant_id and entry.id = photo.contact_book_entry_id
        and entry.child_id = $2 and entry.deleted_at is null
    returning photo.id, entry.facility_id, photo.deleted_at, photo.row_version`,
    [actor.tenantId, childId, entryId, photoId, expectedVersion, actor.userId],
  );
  if (result.rows[0]) return { id: result.rows[0].id, facilityId: result.rows[0].facility_id, deletedAt: dateTime(result.rows[0].deleted_at), rowVersion: Number(result.rows[0].row_version) };
  const current = await client.query(
    `select photo.row_version from public.contact_book_photos photo
      join public.contact_book_entries entry on entry.tenant_id = photo.tenant_id and entry.id = photo.contact_book_entry_id
      where photo.tenant_id = $1 and entry.child_id = $2 and entry.id = $3 and photo.id = $4 and photo.deleted_at is null`,
    [actor.tenantId, childId, entryId, photoId],
  );
  if (!current.rows[0]) throw notFound("連絡帳の写真が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が写真を変更しました。最新の内容を確認してください。", { currentVersion: Number(current.rows[0].row_version) });
}
