import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function serializeEntry(row) {
  return {
    id: row.id,
    childId: row.child_id,
    facilityId: row.facility_id,
    entryDate: dateOnly(row.entry_date),
    familyMessage: row.family_message,
    facilityReply: row.facility_reply,
    requestSummary: row.request_summary,
    reflectedInSupport: row.reflected_in_support,
    recordedBy: row.recorded_by,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    rowVersion: Number(row.row_version),
  };
}

export async function listContactBookEntries(client, tenantId, childId, options = {}) {
  const limit = Math.min(Math.max(options.limit || 50, 1), 100);
  const parameters = [tenantId, childId];
  const conditions = ["tenant_id = $1", "child_id = $2", "deleted_at is null"];
  if (options.from) {
    parameters.push(options.from);
    conditions.push(`entry_date >= $${parameters.length}::date`);
  }
  if (options.to) {
    parameters.push(options.to);
    conditions.push(`entry_date <= $${parameters.length}::date`);
  }
  parameters.push(limit);
  const result = await client.query(
    `select * from public.contact_book_entries
     where ${conditions.join(" and ")}
     order by entry_date desc, id desc
     limit $${parameters.length}`,
    parameters,
  );
  return { items: result.rows.map(serializeEntry) };
}

export async function createContactBookEntry(client, actor, childId, input) {
  const child = await client.query(
    "select facility_id from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!child.rows[0]) throw notFound("利用児が見つかりません。");

  const id = uuidv7();
  const result = await client.query(
    `insert into public.contact_book_entries (
      id, tenant_id, facility_id, child_id, entry_date, family_message,
      facility_reply, request_summary, reflected_in_support, recorded_by, updated_by
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
    returning *`,
    [
      id,
      actor.tenantId,
      child.rows[0].facility_id,
      childId,
      input.entryDate,
      input.familyMessage || null,
      input.facilityReply || null,
      input.requestSummary || null,
      input.reflectedInSupport || false,
      actor.userId,
    ],
  );
  return serializeEntry(result.rows[0]);
}

const PATCH_COLUMNS = Object.freeze({
  entryDate: "entry_date",
  familyMessage: "family_message",
  facilityReply: "facility_reply",
  requestSummary: "request_summary",
  reflectedInSupport: "reflected_in_support",
});

export async function updateContactBookEntry(client, actor, childId, entryId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => PATCH_COLUMNS[key]);
  if (!entries.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const parameters = [actor.tenantId, childId, entryId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    parameters.push(value === "" ? null : value);
    return `${PATCH_COLUMNS[key]} = $${parameters.length}`;
  });
  parameters.push(actor.userId);

  const result = await client.query(
    `update public.contact_book_entries
     set ${assignments.join(", ")}, updated_by = $${parameters.length}
     where tenant_id = $1 and child_id = $2 and id = $3
       and row_version = $4 and deleted_at is null
     returning *`,
    parameters,
  );
  if (result.rows[0]) return serializeEntry(result.rows[0]);

  const current = await client.query(
    `select row_version, updated_at, updated_by
     from public.contact_book_entries
     where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null`,
    [actor.tenantId, childId, entryId],
  );
  if (!current.rows[0]) throw notFound("連絡帳が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が連絡帳を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: current.rows[0].updated_at,
    updatedBy: current.rows[0].updated_by,
  });
}
