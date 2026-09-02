import { v7 as uuidv7 } from "uuid";
import { createHash } from "node:crypto";
import { AppError, badRequest, conflict, notFound } from "../errors.js";

export const SUPPORTED_DOCUMENT_KINDS = Object.freeze([
  "basic_assessment",
  "consultation_plan",
  "individual_support_plan",
  "specialized_support_plan",
  "monitoring_record",
]);

export const EDITABLE_DOCUMENT_STATUSES = Object.freeze([
  "draft",
  "internal_review",
  "explanation_pending",
]);

const DOCUMENT_LIST_SELECT = `
  select
    id,
    facility_id,
    child_id,
    document_kind,
    status,
    version_number,
    previous_version_id,
    template_version,
    period_start,
    period_end,
    created_by,
    updated_by,
    approved_by,
    approved_at,
    consented_at,
    distributed_at,
    created_at,
    updated_at,
    row_version
  from public.case_documents
`;

const DOCUMENT_DETAIL_SELECT = `
  select
    id,
    facility_id,
    child_id,
    document_kind,
    status,
    version_number,
    previous_version_id,
    template_version,
    period_start,
    period_end,
    payload,
    created_by,
    updated_by,
    approved_by,
    approved_at,
    consented_at,
    distributed_at,
    created_at,
    updated_at,
    row_version
  from public.case_documents
`;

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeDocument(row, goals) {
  const serialized = {
    id: row.id,
    facilityId: row.facility_id,
    childId: row.child_id,
    documentKind: row.document_kind,
    status: row.status,
    versionNumber: Number(row.version_number),
    previousVersionId: row.previous_version_id,
    templateVersion: row.template_version,
    periodStart: dateOnly(row.period_start),
    periodEnd: dateOnly(row.period_end),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    approvedBy: row.approved_by,
    approvedAt: dateTime(row.approved_at),
    consentedAt: dateTime(row.consented_at),
    distributedAt: dateTime(row.distributed_at),
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
  if (Object.hasOwn(row, "payload")) serialized.payload = row.payload || {};
  if (goals) serialized.goals = goals.map(serializeGoal);
  return serialized;
}

function serializeGoal(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    predecessorGoalId: row.predecessor_goal_id,
    goalKind: row.goal_kind,
    title: row.title,
    desiredOutcome: row.desired_outcome,
    supportDetails: row.support_details,
    evaluationMethod: row.evaluation_method,
    responsibleParty: row.responsible_party,
    targetDate: dateOnly(row.target_date),
    fiveDomains: row.five_domains || [],
    sortOrder: Number(row.sort_order),
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

function serializeReferenceAttachment(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    fileName: row.original_filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    createdAt: dateTime(row.created_at),
    rowVersion: Number(row.row_version),
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded.updatedAt || !decoded.id) throw new Error("missing cursor fields");
    return decoded;
  } catch {
    throw badRequest("INVALID_CURSOR", "一覧の続き位置が不正です。最初から読み込み直してください。");
  }
}

function immutableDocument() {
  return conflict(
    "IMMUTABLE_DOCUMENT",
    "同意・確定済みの計画書は上書きできません。新しい版を作成してください。",
  );
}

function editConflict(row) {
  return conflict("EDIT_CONFLICT", "別の職員が計画書を更新しました。最新内容を確認してください。", {
    currentVersion: Number(row.row_version),
    updatedAt: dateTime(row.updated_at),
    updatedBy: row.updated_by,
  });
}

function goalEditConflict(row) {
  return conflict("EDIT_CONFLICT", "別の職員が目標を更新しました。最新内容を確認してください。", {
    currentVersion: Number(row.row_version),
    updatedAt: dateTime(row.updated_at),
  });
}

async function readDocumentState(client, tenantId, childId, documentId, options = {}) {
  const result = await client.query(
    `select id, facility_id, document_kind, status, row_version, updated_at, updated_by
     from public.case_documents
     where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null
     ${options.forUpdate ? "for update" : ""}`,
    [tenantId, childId, documentId],
  );
  if (!result.rows[0]) throw notFound("計画書が見つかりません。");
  return result.rows[0];
}

function assertEditableDocument(row) {
  if (!EDITABLE_DOCUMENT_STATUSES.includes(row.status)) throw immutableDocument();
}

async function validatePredecessorGoal(client, tenantId, childId, predecessorGoalId) {
  if (!predecessorGoalId) return;
  const result = await client.query(
    `select 1
     from public.document_goals g
     join public.case_documents d
       on d.tenant_id = g.tenant_id and d.id = g.document_id
     where g.tenant_id = $1 and g.id = $2 and d.child_id = $3 and d.deleted_at is null`,
    [tenantId, predecessorGoalId, childId],
  );
  if (!result.rows[0]) {
    throw new AppError(
      422,
      "INVALID_GOAL_LINEAGE",
      "引き継ぎ元の目標を確認してください。",
    );
  }
}

export async function listDocuments(client, tenantId, childId, options = {}) {
  const limit = Math.min(Math.max(options.limit || 30, 1), 100);
  const cursor = decodeCursor(options.cursor);
  const parameters = [tenantId, childId];
  const conditions = ["tenant_id = $1", "child_id = $2", "deleted_at is null"];

  if (options.documentKind) {
    parameters.push(options.documentKind);
    conditions.push(`document_kind = $${parameters.length}`);
  } else {
    parameters.push(SUPPORTED_DOCUMENT_KINDS);
    conditions.push(`document_kind = any($${parameters.length}::text[])`);
  }
  if (options.status) {
    parameters.push(options.status);
    conditions.push(`status = $${parameters.length}`);
  }
  if (cursor) {
    parameters.push(cursor.updatedAt, cursor.id);
    conditions.push(`(updated_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
  }

  parameters.push(limit + 1);
  const result = await client.query(
    `${DOCUMENT_LIST_SELECT}
     where ${conditions.join(" and ")}
     order by updated_at desc, id desc
     limit $${parameters.length}`,
    parameters,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map((row) => serializeDocument(row)),
    nextCursor: hasMore ? encodeCursor(rows.at(-1)) : null,
  };
}

export async function getDocument(client, tenantId, childId, documentId) {
  const result = await client.query(
    `${DOCUMENT_DETAIL_SELECT}
     where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null`,
    [tenantId, childId, documentId],
  );
  if (!result.rows[0]) throw notFound("計画書が見つかりません。");
  const goals = await client.query(
    `select * from public.document_goals
     where tenant_id = $1 and document_id = $2
     order by sort_order, id`,
    [tenantId, documentId],
  );
  const attachments = result.rows[0].document_kind === "consultation_plan"
    ? await listReferenceMaterialAttachments(client, tenantId, childId, documentId)
    : [];
  return { ...serializeDocument(result.rows[0], goals.rows), attachments };
}

async function readReferenceDocument(client, tenantId, childId, documentId, options = {}) {
  const result = await client.query(
    `select id, facility_id, status
       from public.case_documents
      where tenant_id = $1 and child_id = $2 and id = $3
        and document_kind = 'consultation_plan' and deleted_at is null
      ${options.forUpdate ? "for update" : ""}`,
    [tenantId, childId, documentId],
  );
  if (!result.rows[0]) throw notFound("参考資料が見つかりません。");
  return result.rows[0];
}

export async function listReferenceMaterialAttachments(client, tenantId, childId, documentId) {
  await readReferenceDocument(client, tenantId, childId, documentId);
  const result = await client.query(
    `select id, document_id, original_filename, content_type, byte_size, created_at, row_version
       from public.reference_material_attachments
      where tenant_id = $1 and document_id = $2 and deleted_at is null
      order by created_at desc, id desc`,
    [tenantId, documentId],
  );
  return result.rows.map(serializeReferenceAttachment);
}

export async function createReferenceMaterialAttachment(client, actor, childId, documentId, input) {
  const document = await readReferenceDocument(client, actor.tenantId, childId, documentId, { forUpdate: true });
  assertEditableDocument(document);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const result = await client.query(
    `insert into public.reference_material_attachments (
      id, tenant_id, document_id, original_filename, content_type,
      byte_size, sha256, content, created_by
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    returning id, document_id, original_filename, content_type, byte_size, created_at, row_version`,
    [
      uuidv7(),
      actor.tenantId,
      documentId,
      input.fileName,
      input.contentType,
      input.bytes.byteLength,
      sha256,
      input.bytes,
      actor.userId,
    ],
  );
  return { attachment: serializeReferenceAttachment(result.rows[0]), facilityId: document.facility_id };
}

export async function getReferenceMaterialAttachmentContent(client, tenantId, childId, documentId, attachmentId) {
  await readReferenceDocument(client, tenantId, childId, documentId);
  const result = await client.query(
    `select id, document_id, original_filename, content_type, byte_size, created_at, row_version, content
       from public.reference_material_attachments
      where tenant_id = $1 and document_id = $2 and id = $3 and deleted_at is null`,
    [tenantId, documentId, attachmentId],
  );
  if (!result.rows[0]) throw notFound("参考資料ファイルが見つかりません。");
  return {
    ...serializeReferenceAttachment(result.rows[0]),
    bytes: Buffer.from(result.rows[0].content),
  };
}

export async function deleteReferenceMaterialAttachment(client, actor, childId, documentId, attachmentId, expectedVersion) {
  const document = await readReferenceDocument(client, actor.tenantId, childId, documentId, { forUpdate: true });
  assertEditableDocument(document);
  const result = await client.query(
    `update public.reference_material_attachments
        set deleted_at = now(), deleted_by = $5
      where tenant_id = $1 and document_id = $2 and id = $3 and row_version = $4
        and deleted_at is null
      returning id, row_version`,
    [actor.tenantId, documentId, attachmentId, expectedVersion, actor.userId],
  );
  if (result.rows[0]) return { attachmentId, facilityId: document.facility_id };
  const current = await client.query(
    `select row_version, deleted_at
       from public.reference_material_attachments
      where tenant_id = $1 and document_id = $2 and id = $3`,
    [actor.tenantId, documentId, attachmentId],
  );
  if (!current.rows[0] || current.rows[0].deleted_at) throw notFound("参考資料ファイルが見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が参考資料を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
  });
}

export async function createDocument(client, actor, childId, input) {
  const child = await client.query(
    "select facility_id from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!child.rows[0]) throw notFound("利用児が見つかりません。");

  const latest = await client.query(
    `select id, status, version_number
     from public.case_documents
     where tenant_id = $1 and child_id = $2 and document_kind = $3 and deleted_at is null
     order by version_number desc
     limit 1
     for update`,
    [actor.tenantId, childId, input.documentKind],
  );
  const previous = latest.rows[0];
  // 相談支援計画は、このアプリではアセスメント用の「参考資料」として
  // 扱う。受け取った資料は複数あり得るため、計画書本体のように
  // 「編集中の下書きは1件だけ」という制約を適用しない。
  if (
    input.documentKind !== "consultation_plan"
    && previous
    && EDITABLE_DOCUMENT_STATUSES.includes(previous.status)
  ) {
    throw conflict(
      "DRAFT_EXISTS",
      "編集中の計画書があります。既存の下書きを更新してください。",
      { documentId: previous.id, versionNumber: Number(previous.version_number) },
    );
  }

  const id = uuidv7();
  const versionNumber = previous ? Number(previous.version_number) + 1 : 1;
  const result = await client.query(
    `insert into public.case_documents (
      id, tenant_id, facility_id, child_id, document_kind, status,
      version_number, previous_version_id, template_version,
      period_start, period_end, payload, created_by, updated_by
    ) values (
      $1, $2, $3, $4, $5, 'draft',
      $6, $7, $8, $9, $10, $11::jsonb, $12, $12
    ) returning *`,
    [
      id,
      actor.tenantId,
      child.rows[0].facility_id,
      childId,
      input.documentKind,
      versionNumber,
      previous?.id || null,
      input.templateVersion,
      input.periodStart || null,
      input.periodEnd || null,
      JSON.stringify(input.payload || {}),
      actor.userId,
    ],
  );
  return serializeDocument(result.rows[0], []);
}

const DOCUMENT_PATCH_COLUMNS = Object.freeze({
  templateVersion: ["template_version", (value) => value],
  periodStart: ["period_start", (value) => value || null],
  periodEnd: ["period_end", (value) => value || null],
  payload: ["payload", (value) => JSON.stringify(value || {}), "jsonb"],
});

export async function updateDocument(client, actor, childId, documentId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => DOCUMENT_PATCH_COLUMNS[key]);
  if (!entries.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const parameters = [actor.tenantId, childId, documentId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    const [column, transform, cast] = DOCUMENT_PATCH_COLUMNS[key];
    parameters.push(transform(value));
    return `${column} = $${parameters.length}${cast ? `::${cast}` : ""}`;
  });
  parameters.push(actor.userId, EDITABLE_DOCUMENT_STATUSES);

  const result = await client.query(
    `update public.case_documents
     set ${assignments.join(", ")},
         updated_by = $${parameters.length - 1},
         updated_at = now(),
         row_version = row_version + 1
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4
       and deleted_at is null and status = any($${parameters.length}::text[])
     returning *`,
    parameters,
  );
  if (result.rows[0]) return serializeDocument(result.rows[0]);

  const current = await readDocumentState(client, actor.tenantId, childId, documentId);
  assertEditableDocument(current);
  throw editConflict(current);
}

export async function listDocumentGoals(client, tenantId, childId, documentId) {
  await readDocumentState(client, tenantId, childId, documentId);
  const result = await client.query(
    `select * from public.document_goals
     where tenant_id = $1 and document_id = $2
     order by sort_order, id`,
    [tenantId, documentId],
  );
  return { items: result.rows.map(serializeGoal) };
}

export async function getDocumentGoal(client, tenantId, childId, documentId, goalId) {
  await readDocumentState(client, tenantId, childId, documentId);
  const result = await client.query(
    `select * from public.document_goals
     where tenant_id = $1 and document_id = $2 and id = $3`,
    [tenantId, documentId, goalId],
  );
  if (!result.rows[0]) throw notFound("支援目標が見つかりません。");
  return serializeGoal(result.rows[0]);
}

export async function createDocumentGoal(client, actor, childId, documentId, input) {
  const document = await readDocumentState(
    client,
    actor.tenantId,
    childId,
    documentId,
    { forUpdate: true },
  );
  assertEditableDocument(document);
  await validatePredecessorGoal(client, actor.tenantId, childId, input.predecessorGoalId);

  const id = uuidv7();
  const result = await client.query(
    `insert into public.document_goals (
      id, tenant_id, document_id, predecessor_goal_id, goal_kind, title,
      desired_outcome, support_details, evaluation_method, responsible_party,
      target_date, five_domains, sort_order
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12::text[], $13
    ) returning *`,
    [
      id,
      actor.tenantId,
      documentId,
      input.predecessorGoalId || null,
      input.goalKind,
      input.title,
      input.desiredOutcome || null,
      input.supportDetails || null,
      input.evaluationMethod || null,
      input.responsibleParty || null,
      input.targetDate || null,
      input.fiveDomains || [],
      input.sortOrder ?? 0,
    ],
  );
  return { goal: serializeGoal(result.rows[0]), facilityId: document.facility_id };
}

const GOAL_PATCH_COLUMNS = Object.freeze({
  predecessorGoalId: ["predecessor_goal_id", (value) => value || null],
  goalKind: ["goal_kind", (value) => value],
  title: ["title", (value) => value],
  desiredOutcome: ["desired_outcome", (value) => value || null],
  supportDetails: ["support_details", (value) => value || null],
  evaluationMethod: ["evaluation_method", (value) => value || null],
  responsibleParty: ["responsible_party", (value) => value || null],
  targetDate: ["target_date", (value) => value || null],
  fiveDomains: ["five_domains", (value) => value || [], "text[]"],
  sortOrder: ["sort_order", (value) => value],
});

async function readGoalState(client, tenantId, childId, documentId, goalId) {
  const result = await client.query(
    `select g.row_version, g.updated_at, d.status, d.facility_id
     from public.document_goals g
     join public.case_documents d
       on d.tenant_id = g.tenant_id and d.id = g.document_id
     where g.tenant_id = $1 and d.child_id = $2 and g.document_id = $3 and g.id = $4
       and d.deleted_at is null`,
    [tenantId, childId, documentId, goalId],
  );
  if (!result.rows[0]) throw notFound("支援目標が見つかりません。");
  return result.rows[0];
}

export async function updateDocumentGoal(client, actor, childId, documentId, goalId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => GOAL_PATCH_COLUMNS[key]);
  if (!entries.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");
  if (Object.hasOwn(changes, "predecessorGoalId")) {
    if (changes.predecessorGoalId === goalId) {
      throw new AppError(
        422,
        "INVALID_GOAL_LINEAGE",
        "目標自身を引き継ぎ元には指定できません。",
      );
    }
    await validatePredecessorGoal(client, actor.tenantId, childId, changes.predecessorGoalId);
  }

  const parameters = [actor.tenantId, childId, documentId, goalId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    const [column, transform, cast] = GOAL_PATCH_COLUMNS[key];
    parameters.push(transform(value));
    return `${column} = $${parameters.length}${cast ? `::${cast}` : ""}`;
  });
  parameters.push(EDITABLE_DOCUMENT_STATUSES);

  const result = await client.query(
    `update public.document_goals g
     set ${assignments.join(", ")}, updated_at = now(), row_version = g.row_version + 1
     from public.case_documents d
     where g.tenant_id = $1 and d.child_id = $2 and g.document_id = $3 and g.id = $4
       and g.row_version = $5 and d.tenant_id = g.tenant_id and d.id = g.document_id
       and d.deleted_at is null and d.status = any($${parameters.length}::text[])
     returning g.*, d.facility_id`,
    parameters,
  );
  if (result.rows[0]) {
    return { goal: serializeGoal(result.rows[0]), facilityId: result.rows[0].facility_id };
  }

  const current = await readGoalState(client, actor.tenantId, childId, documentId, goalId);
  assertEditableDocument(current);
  throw goalEditConflict(current);
}

export async function deleteDocumentGoal(client, actor, childId, documentId, goalId, expectedVersion) {
  let result;
  try {
    result = await client.query(
      `delete from public.document_goals g
       using public.case_documents d
       where g.tenant_id = $1 and d.child_id = $2 and g.document_id = $3 and g.id = $4
         and g.row_version = $5 and d.tenant_id = g.tenant_id and d.id = g.document_id
         and d.deleted_at is null and d.status = any($6::text[])
       returning g.id, d.facility_id`,
      [actor.tenantId, childId, documentId, goalId, expectedVersion, EDITABLE_DOCUMENT_STATUSES],
    );
  } catch (error) {
    if (error?.code === "23503") {
      throw conflict(
        "GOAL_IN_USE",
        "日誌やモニタリングで使用中の目標は削除できません。内容を修正するか、新しい版を作成してください。",
      );
    }
    throw error;
  }
  if (result.rows[0]) return { id: result.rows[0].id, facilityId: result.rows[0].facility_id };

  const current = await readGoalState(client, actor.tenantId, childId, documentId, goalId);
  assertEditableDocument(current);
  throw goalEditConflict(current);
}
