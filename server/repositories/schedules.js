import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeItem(row) {
  return {
    id: row.id,
    dayOfWeek: Number(row.day_of_week),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute),
    activity: row.activity,
    location: row.location,
    serviceKind: row.service_kind,
    recurrenceNote: row.recurrence_note,
    sortOrder: Number(row.sort_order),
    rowVersion: Number(row.row_version),
  };
}

function serializeSchedule(row, items) {
  const result = {
    id: row.id,
    childId: row.child_id,
    facilityId: row.facility_id,
    scheduleKind: row.schedule_kind,
    versionNumber: Number(row.version_number),
    status: row.status,
    validFrom: dateOnly(row.valid_from),
    validTo: dateOnly(row.valid_to),
    summary: row.summary,
    createdBy: row.created_by,
    finalizedAt: dateTime(row.finalized_at),
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
  if (items) result.items = items.map(serializeItem);
  return result;
}

async function readSchedule(client, tenantId, childId, scheduleId, forUpdate = false) {
  const result = await client.query(
    `select * from public.schedule_versions
     where tenant_id = $1 and child_id = $2 and id = $3
     ${forUpdate ? "for update" : ""}`,
    [tenantId, childId, scheduleId],
  );
  if (!result.rows[0]) throw notFound("週間予定が見つかりません。");
  return result.rows[0];
}

async function readItems(client, tenantId, scheduleId) {
  const result = await client.query(
    `select * from public.schedule_items
     where tenant_id = $1 and schedule_version_id = $2
     order by day_of_week, start_minute, sort_order, id`,
    [tenantId, scheduleId],
  );
  return result.rows;
}

async function insertItems(client, tenantId, scheduleId, items) {
  for (const item of items || []) {
    await client.query(
      `insert into public.schedule_items (
        id, tenant_id, schedule_version_id, day_of_week, start_minute, end_minute,
        activity, location, service_kind, recurrence_note, sort_order
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        uuidv7(),
        tenantId,
        scheduleId,
        item.dayOfWeek,
        item.startMinute,
        item.endMinute,
        item.activity,
        item.location || null,
        item.serviceKind || null,
        item.recurrenceNote || null,
        item.sortOrder ?? 0,
      ],
    );
  }
}

function scheduleConflict(row) {
  return conflict("EDIT_CONFLICT", "別の職員が週間予定を更新しました。最新内容を確認してください。", {
    currentVersion: Number(row.row_version),
    updatedAt: dateTime(row.updated_at),
  });
}

export async function listSchedules(client, tenantId, childId, scheduleKind) {
  const parameters = [tenantId, childId];
  const kindFilter = scheduleKind ? "and schedule_kind = $3" : "";
  if (scheduleKind) parameters.push(scheduleKind);
  const result = await client.query(
    `select * from public.schedule_versions
     where tenant_id = $1 and child_id = $2 ${kindFilter}
     order by schedule_kind, version_number desc`,
    parameters,
  );
  return { items: result.rows.map((row) => serializeSchedule(row)) };
}

export async function getSchedule(client, tenantId, childId, scheduleId) {
  const schedule = await readSchedule(client, tenantId, childId, scheduleId);
  return serializeSchedule(schedule, await readItems(client, tenantId, scheduleId));
}

export async function createSchedule(client, actor, childId, input) {
  const child = await client.query(
    "select facility_id from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!child.rows[0]) throw notFound("利用児が見つかりません。");

  const latest = await client.query(
    `select id, status, version_number from public.schedule_versions
     where tenant_id = $1 and child_id = $2 and schedule_kind = $3
     order by version_number desc limit 1 for update`,
    [actor.tenantId, childId, input.scheduleKind],
  );
  if (latest.rows[0]?.status === "draft") {
    throw conflict("DRAFT_EXISTS", "編集中の週間予定があります。既存の下書きを更新してください。", {
      scheduleId: latest.rows[0].id,
      versionNumber: Number(latest.rows[0].version_number),
    });
  }

  const id = uuidv7();
  const versionNumber = Number(latest.rows[0]?.version_number || 0) + 1;
  const result = await client.query(
    `insert into public.schedule_versions (
      id, tenant_id, facility_id, child_id, schedule_kind, version_number,
      valid_from, valid_to, summary, created_by
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    returning *`,
    [
      id,
      actor.tenantId,
      child.rows[0].facility_id,
      childId,
      input.scheduleKind,
      versionNumber,
      input.validFrom || null,
      input.validTo || null,
      input.summary || null,
      actor.userId,
    ],
  );
  await insertItems(client, actor.tenantId, id, input.items || []);
  return serializeSchedule(result.rows[0], await readItems(client, actor.tenantId, id));
}

export async function updateSchedule(client, actor, childId, scheduleId, expectedVersion, input) {
  const current = await readSchedule(client, actor.tenantId, childId, scheduleId, true);
  if (Number(current.row_version) !== expectedVersion) throw scheduleConflict(current);
  if (current.status !== "draft") {
    throw conflict("IMMUTABLE_SCHEDULE", "確定済みの週間予定は変更できません。新しい版を作成してください。");
  }

  const assignments = [];
  const parameters = [actor.tenantId, childId, scheduleId, expectedVersion];
  for (const [key, column] of Object.entries({ validFrom: "valid_from", validTo: "valid_to", summary: "summary" })) {
    if (!Object.hasOwn(input, key)) continue;
    parameters.push(input[key] || null);
    assignments.push(`${column} = $${parameters.length}`);
  }
  if (!assignments.length && !Object.hasOwn(input, "items")) {
    throw badRequest("NO_CHANGES", "変更する項目がありません。");
  }
  if (!assignments.length) assignments.push("summary = summary");

  const updated = await client.query(
    `update public.schedule_versions
     set ${assignments.join(", ")}
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4 and status = 'draft'
     returning *`,
    parameters,
  );
  if (!updated.rows[0]) throw scheduleConflict(await readSchedule(client, actor.tenantId, childId, scheduleId));

  if (Object.hasOwn(input, "items")) {
    await client.query(
      "delete from public.schedule_items where tenant_id = $1 and schedule_version_id = $2",
      [actor.tenantId, scheduleId],
    );
    await insertItems(client, actor.tenantId, scheduleId, input.items);
  }
  return serializeSchedule(updated.rows[0], await readItems(client, actor.tenantId, scheduleId));
}

export async function finalizeSchedule(client, actor, childId, scheduleId, expectedVersion) {
  const result = await client.query(
    `update public.schedule_versions
     set status = 'finalized', finalized_at = now()
     where tenant_id = $1 and child_id = $2 and id = $3
       and row_version = $4 and status = 'draft'
     returning *`,
    [actor.tenantId, childId, scheduleId, expectedVersion],
  );
  if (result.rows[0]) {
    return serializeSchedule(result.rows[0], await readItems(client, actor.tenantId, scheduleId));
  }
  const current = await readSchedule(client, actor.tenantId, childId, scheduleId);
  if (current.status !== "draft") {
    throw conflict("IMMUTABLE_SCHEDULE", "週間予定はすでに確定されています。新しい版を作成してください。");
  }
  throw scheduleConflict(current);
}
