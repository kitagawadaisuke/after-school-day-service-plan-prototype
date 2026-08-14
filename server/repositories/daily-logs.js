import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

function serializeDailyLog(row) {
  return {
    id: row.id,
    childId: row.child_id,
    facilityId: row.facility_id,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    activity: row.activity,
    observation: row.observation,
    supportProvided: row.support_provided,
    childResponse: row.child_response,
    healthNote: row.health_note,
    fiveDomains: row.five_domains || [],
    relatedGoalIds: row.related_goal_ids || [],
    recordedBy: row.recorded_by,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    rowVersion: Number(row.row_version),
  };
}

export async function listDailyLogs(client, tenantId, childId, options = {}) {
  const limit = Math.min(Math.max(options.limit || 50, 1), 100);
  const parameters = [tenantId, childId];
  const conditions = ["tenant_id = $1", "child_id = $2", "deleted_at is null"];

  if (options.from) {
    parameters.push(options.from);
    conditions.push(`occurred_at >= $${parameters.length}::timestamptz`);
  }
  if (options.to) {
    parameters.push(options.to);
    conditions.push(`occurred_at < $${parameters.length}::timestamptz`);
  }
  parameters.push(limit);

  const result = await client.query(
    `select l.*,
       coalesce(
         (select array_agg(dlg.goal_id order by dlg.goal_id)
          from public.daily_log_goals dlg
          where dlg.tenant_id = l.tenant_id and dlg.daily_log_id = l.id),
         '{}'::uuid[]
       ) as related_goal_ids
     from public.daily_logs l
     where ${conditions.join(" and ")}
     order by occurred_at desc, id desc
     limit $${parameters.length}`,
    parameters,
  );
  return { items: result.rows.map(serializeDailyLog) };
}

export async function createDailyLog(client, actor, childId, input) {
  const child = await client.query(
    "select facility_id from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!child.rows[0]) throw notFound("利用児が見つかりません。");

  const id = uuidv7();
  const result = await client.query(
    `insert into public.daily_logs (
      id, tenant_id, facility_id, child_id, occurred_at, activity, observation,
      support_provided, child_response, health_note, five_domains, recorded_by, updated_by
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11::text[], $12, $12
    ) returning *`,
    [
      id,
      actor.tenantId,
      child.rows[0].facility_id,
      childId,
      input.occurredAt,
      input.activity,
      input.observation,
      input.supportProvided,
      input.childResponse,
      input.healthNote || null,
      input.fiveDomains || [],
      actor.userId,
    ],
  );
  if (input.relatedGoalIds?.length) {
    await client.query(
      `insert into public.daily_log_goals (tenant_id, daily_log_id, goal_id)
       select $1, $2, unnest($3::uuid[])`,
      [actor.tenantId, id, input.relatedGoalIds],
    );
  }
  return serializeDailyLog({ ...result.rows[0], related_goal_ids: input.relatedGoalIds || [] });
}

const PATCH_COLUMNS = Object.freeze({
  occurredAt: "occurred_at",
  activity: "activity",
  observation: "observation",
  supportProvided: "support_provided",
  childResponse: "child_response",
  healthNote: "health_note",
  fiveDomains: "five_domains",
});

export async function updateDailyLog(client, actor, childId, logId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => PATCH_COLUMNS[key]);
  const hasGoalChanges = Object.hasOwn(changes, "relatedGoalIds");
  if (!entries.length && !hasGoalChanges) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const parameters = [actor.tenantId, childId, logId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    parameters.push(value === "" ? null : value);
    const cast = key === "fiveDomains" ? "::text[]" : "";
    return `${PATCH_COLUMNS[key]} = $${parameters.length}${cast}`;
  });
  parameters.push(actor.userId);

  const result = await client.query(
    `update public.daily_logs
     set ${assignments.length ? `${assignments.join(", ")},` : ""} updated_at = now(), row_version = row_version + 1
         , updated_by = $${parameters.length}
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4 and deleted_at is null
     returning *`,
    parameters,
  );
  if (result.rows[0]) {
    if (hasGoalChanges) {
      await client.query(
        "delete from public.daily_log_goals where tenant_id = $1 and daily_log_id = $2",
        [actor.tenantId, logId],
      );
      if (changes.relatedGoalIds.length) {
        await client.query(
          `insert into public.daily_log_goals (tenant_id, daily_log_id, goal_id)
           select $1, $2, unnest($3::uuid[])`,
          [actor.tenantId, logId, changes.relatedGoalIds],
        );
      }
    }
    const relatedGoals = hasGoalChanges
      ? changes.relatedGoalIds
      : (await client.query(
          "select goal_id from public.daily_log_goals where tenant_id = $1 and daily_log_id = $2 order by goal_id",
          [actor.tenantId, logId],
        )).rows.map((row) => row.goal_id);
    return serializeDailyLog({ ...result.rows[0], related_goal_ids: relatedGoals });
  }

  const current = await client.query(
    "select row_version, updated_at, updated_by from public.daily_logs where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null",
    [actor.tenantId, childId, logId],
  );
  if (!current.rows[0]) throw notFound("日誌が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が日誌を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: current.rows[0].updated_at,
    updatedBy: current.rows[0].updated_by,
  });
}
