import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeFacility(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    serviceType: row.service_type,
    status: row.status,
    timezone: row.timezone,
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

export async function listFacilities(client, tenantId) {
  const result = await client.query(
    `select * from public.facilities
     where tenant_id = $1
     order by (status = 'active') desc, name, id`,
    [tenantId],
  );
  return { items: result.rows.map(serializeFacility) };
}

export async function createFacility(client, actor, input) {
  const result = await client.query(
    `insert into public.facilities (
      id, tenant_id, code, name, service_type, status, timezone
    ) values ($1, $2, $3, $4, $5, 'active', $6)
    returning *`,
    [
      uuidv7(),
      actor.tenantId,
      input.code,
      input.name,
      input.serviceType || "放課後等デイサービス",
      input.timezone || "Asia/Tokyo",
    ],
  );
  return serializeFacility(result.rows[0]);
}

const PATCH_COLUMNS = Object.freeze({
  code: "code",
  name: "name",
  serviceType: "service_type",
  status: "status",
  timezone: "timezone",
});

export async function updateFacility(client, actor, facilityId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => PATCH_COLUMNS[key]);
  if (!entries.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");
  const parameters = [actor.tenantId, facilityId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    parameters.push(value);
    return `${PATCH_COLUMNS[key]} = $${parameters.length}`;
  });
  const result = await client.query(
    `update public.facilities
     set ${assignments.join(", ")}
     where tenant_id = $1 and id = $2 and row_version = $3
     returning *`,
    parameters,
  );
  if (result.rows[0]) return serializeFacility(result.rows[0]);

  const current = await client.query(
    "select row_version, updated_at from public.facilities where tenant_id = $1 and id = $2",
    [actor.tenantId, facilityId],
  );
  if (!current.rows[0]) throw notFound("事業所が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の管理者が事業所情報を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: dateTime(current.rows[0].updated_at),
  });
}
