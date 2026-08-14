import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeGuardian(row) {
  return {
    id: row.id,
    childId: row.child_id,
    legalName: row.legal_name,
    relationship: row.relationship,
    phone: row.phone,
    email: row.email,
    address: row.address || {},
    isPrimary: row.is_primary,
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

async function assertChildExists(client, tenantId, childId) {
  const child = await client.query(
    "select facility_id from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [tenantId, childId],
  );
  if (!child.rows[0]) throw notFound("利用児が見つかりません。");
  return child.rows[0];
}

export async function listGuardians(client, tenantId, childId) {
  await assertChildExists(client, tenantId, childId);
  const result = await client.query(
    `select * from public.guardians
     where tenant_id = $1 and child_id = $2
     order by is_primary desc, created_at, id`,
    [tenantId, childId],
  );
  return { items: result.rows.map(serializeGuardian) };
}

export async function getGuardian(client, tenantId, childId, guardianId) {
  const result = await client.query(
    "select * from public.guardians where tenant_id = $1 and child_id = $2 and id = $3",
    [tenantId, childId, guardianId],
  );
  if (!result.rows[0]) throw notFound("保護者情報が見つかりません。");
  return serializeGuardian(result.rows[0]);
}

async function clearOtherPrimaryGuardians(client, tenantId, childId, guardianId = null) {
  await client.query(
    `update public.guardians
     set is_primary = false
     where tenant_id = $1 and child_id = $2 and is_primary = true
       and ($3::uuid is null or id <> $3::uuid)`,
    [tenantId, childId, guardianId],
  );
}

export async function createGuardian(client, actor, childId, input) {
  const child = await assertChildExists(client, actor.tenantId, childId);
  if (input.isPrimary) await clearOtherPrimaryGuardians(client, actor.tenantId, childId);

  const result = await client.query(
    `insert into public.guardians (
      id, tenant_id, child_id, legal_name, relationship, phone, email, address, is_primary
    ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
    returning *`,
    [
      uuidv7(),
      actor.tenantId,
      childId,
      input.legalName,
      input.relationship,
      input.phone || null,
      input.email || null,
      JSON.stringify(input.address || {}),
      input.isPrimary || false,
    ],
  );
  return { guardian: serializeGuardian(result.rows[0]), facilityId: child.facility_id };
}

const PATCH_COLUMNS = Object.freeze({
  legalName: ["legal_name", (value) => value],
  relationship: ["relationship", (value) => value],
  phone: ["phone", (value) => value || null],
  email: ["email", (value) => value || null],
  address: ["address", (value) => JSON.stringify(value || {}), "jsonb"],
  isPrimary: ["is_primary", (value) => value],
});

export async function updateGuardian(client, actor, childId, guardianId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => PATCH_COLUMNS[key]);
  if (!entries.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");
  const child = await assertChildExists(client, actor.tenantId, childId);

  // This update and the target update share a transaction. A stale target rolls
  // the primary switch back instead of leaving the child without a primary guardian.
  if (changes.isPrimary === true) {
    await clearOtherPrimaryGuardians(client, actor.tenantId, childId, guardianId);
  }

  const parameters = [actor.tenantId, childId, guardianId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    const [column, transform, cast] = PATCH_COLUMNS[key];
    parameters.push(transform(value));
    return `${column} = $${parameters.length}${cast ? `::${cast}` : ""}`;
  });
  const result = await client.query(
    `update public.guardians
     set ${assignments.join(", ")}
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4
     returning *`,
    parameters,
  );
  if (result.rows[0]) {
    return { guardian: serializeGuardian(result.rows[0]), facilityId: child.facility_id };
  }

  const current = await client.query(
    `select row_version, updated_at
     from public.guardians where tenant_id = $1 and child_id = $2 and id = $3`,
    [actor.tenantId, childId, guardianId],
  );
  if (!current.rows[0]) throw notFound("保護者情報が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が保護者情報を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: dateTime(current.rows[0].updated_at),
  });
}
