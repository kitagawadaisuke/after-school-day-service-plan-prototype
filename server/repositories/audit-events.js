import { badRequest } from "../errors.js";

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ occurredAt: row.occurred_at, id: row.id })).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed.occurredAt || !parsed.id) throw new Error("invalid cursor");
    return parsed;
  } catch {
    throw badRequest("INVALID_CURSOR", "監査履歴の続き位置が不正です。最初から読み込み直してください。");
  }
}

function serialize(row) {
  return {
    id: row.id,
    facilityId: row.facility_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    occurredAt: dateTime(row.occurred_at),
    requestId: row.request_id,
    ipHash: row.ip_hash,
    userAgentFamily: row.user_agent_family,
    outcome: row.outcome,
    changedFields: row.changed_fields || [],
    metadata: row.metadata || {},
  };
}

export async function listAuditEvents(client, tenantId, options = {}) {
  const limit = Math.min(Math.max(options.limit || 50, 1), 100);
  const cursor = decodeCursor(options.cursor);
  const conditions = ["tenant_id = $1"];
  const parameters = [tenantId];
  for (const [key, column, cast] of [
    ["facilityId", "facility_id", "uuid"],
    ["action", "action", "text"],
    ["resourceType", "resource_type", "text"],
  ]) {
    if (!options[key]) continue;
    parameters.push(options[key]);
    conditions.push(`${column} = $${parameters.length}::${cast}`);
  }
  if (options.from) {
    parameters.push(options.from);
    conditions.push(`occurred_at >= $${parameters.length}::timestamptz`);
  }
  if (options.to) {
    parameters.push(options.to);
    conditions.push(`occurred_at <= $${parameters.length}::timestamptz`);
  }
  if (cursor) {
    parameters.push(cursor.occurredAt, cursor.id);
    conditions.push(`(occurred_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
  }
  parameters.push(limit + 1);
  const result = await client.query(
    `select * from public.audit_events
     where ${conditions.join(" and ")}
     order by occurred_at desc, id desc
     limit $${parameters.length}`,
    parameters,
  );
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map(serialize),
    nextCursor: result.rows.length > limit ? encodeCursor(rows.at(-1)) : null,
  };
}
