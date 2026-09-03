import { v7 as uuidv7 } from "uuid";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import {
  buildBasicAssessmentDraft,
  buildIndividualSupportPlanDraft,
  buildMonitoringRecordDraft,
} from "../services/draft-builder.js";
import { createDocument, createDocumentGoal } from "./documents.js";

const EDITABLE_STATUSES = Object.freeze(["draft", "internal_review", "explanation_pending"]);
const MAX_DAILY_LOG_EVIDENCE = 2_000;
const MAX_CONTACT_EVIDENCE = 500;
const MAX_PREVIOUS_MONITORING_RESULTS = 100;

function unprocessable(code, message) {
  return new AppError(422, code, message);
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeChild(row) {
  return {
    id: row.id,
    facilityId: row.facility_id,
    managementCode: row.management_code,
    displayName: row.display_name,
    legalName: row.legal_name,
    birthDate: dateOnly(row.birth_date),
    grade: row.grade,
    gender: row.gender,
    disabilityCategory: row.disability_category,
    rowVersion: Number(row.row_version),
  };
}

function normalizeGuardian(row) {
  return {
    id: row.id,
    legalName: row.legal_name,
    relationship: row.relationship,
    isPrimary: Boolean(row.is_primary),
    rowVersion: Number(row.row_version),
  };
}

function normalizeDocument(row) {
  return {
    id: row.id,
    facilityId: row.facility_id,
    childId: row.child_id,
    documentKind: row.document_kind,
    status: row.status,
    versionNumber: Number(row.version_number),
    templateVersion: row.template_version,
    periodStart: dateOnly(row.period_start),
    periodEnd: dateOnly(row.period_end),
    payload: row.payload || {},
    rowVersion: Number(row.row_version),
  };
}

function normalizeGoal(row) {
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
  };
}

function normalizeSchedule(row, items) {
  return {
    id: row.id,
    status: row.status,
    versionNumber: Number(row.version_number),
    validFrom: dateOnly(row.valid_from),
    validTo: dateOnly(row.valid_to),
    summary: row.summary,
    rowVersion: Number(row.row_version),
    items: items.map((item) => ({
      id: item.id,
      dayOfWeek: Number(item.day_of_week),
      startMinute: Number(item.start_minute),
      endMinute: Number(item.end_minute),
      activity: item.activity,
      location: item.location,
      serviceKind: item.service_kind,
    })),
  };
}

function serializeMonitoringResult(row) {
  return {
    id: row.id,
    monitoringDocumentId: row.monitoring_document_id,
    goalId: row.goal_id,
    progressStatus: row.progress_status,
    progressSummary: row.progress_summary,
    currentChallenge: row.current_challenge,
    nextSupportPolicy: row.next_support_policy,
    nextGoalAction: row.next_goal_action,
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

async function readChild(client, actor, childId) {
  const result = await client.query(
    `select id, facility_id, management_code, display_name, legal_name, birth_date,
            grade, gender, disability_category, row_version
     from public.children
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [actor.tenantId, childId],
  );
  if (!result.rows[0]) throw notFound("利用児が見つかりません。");
  return normalizeChild(result.rows[0]);
}

async function readSourceDocument(client, actor, childId, documentId, expectedKind, options = {}) {
  const result = await client.query(
    `select * from public.case_documents
     where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null`,
    [actor.tenantId, childId, documentId],
  );
  const document = result.rows[0] ? normalizeDocument(result.rows[0]) : null;
  if (
    !document
    || document.documentKind !== expectedKind
    || (options.status && document.status !== options.status)
    || (!options.allowVoid && document.status === "void")
  ) {
    throw unprocessable(
      "INVALID_SOURCE_DOCUMENT",
      "指定された根拠文書を利用できません。文書の種類、状態、利用児を確認してください。",
    );
  }
  return document;
}

async function readGoals(client, actor, documentId) {
  const result = await client.query(
    `select * from public.document_goals
     where tenant_id = $1 and document_id = $2
     order by sort_order, id`,
    [actor.tenantId, documentId],
  );
  return result.rows.map(normalizeGoal);
}

async function readCurrentSchedule(client, actor, childId, scheduleVersionId) {
  const parameters = [actor.tenantId, childId];
  const idCondition = scheduleVersionId
    ? (parameters.push(scheduleVersionId), `and id = $${parameters.length}`)
    : "";
  const result = await client.query(
    `select * from public.schedule_versions
     where tenant_id = $1 and child_id = $2 and schedule_kind = 'current'
       and status = 'finalized' ${idCondition}
     order by version_number desc
     limit 1`,
    parameters,
  );
  if (!result.rows[0]) {
    throw unprocessable(
      "CURRENT_SCHEDULE_REQUIRED",
      "確定済みの現在の生活スケジュールを登録してからアセスメント下書きを作成してください。",
    );
  }
  const items = await client.query(
    `select * from public.schedule_items
     where tenant_id = $1 and schedule_version_id = $2
     order by day_of_week, start_minute, sort_order, id`,
    [actor.tenantId, result.rows[0].id],
  );
  return normalizeSchedule(result.rows[0], items.rows);
}

async function createGeneratedDocument(client, actor, childId, documentKind, built) {
  return createDocument(client, actor, childId, {
    documentKind,
    templateVersion: built.templateVersion,
    periodStart: built.periodStart,
    periodEnd: built.periodEnd,
    payload: built.payload,
  });
}

export async function generateBasicAssessment(client, actor, childId, input, options = {}) {
  const child = await readChild(client, actor, childId);
  const consultationPlan = input.consultationPlanId
    ? await readSourceDocument(
      client,
      actor,
      childId,
      input.consultationPlanId,
      "consultation_plan",
    )
    : null;
  const guardians = await client.query(
    `select id, legal_name, relationship, is_primary, row_version
     from public.guardians
     where tenant_id = $1 and child_id = $2
     order by is_primary desc, created_at, id`,
    [actor.tenantId, childId],
  );
  const currentSchedule = await readCurrentSchedule(
    client,
    actor,
    childId,
    input.currentScheduleVersionId,
  );
  const previousMonitoring = input.previousMonitoringDocumentId
    ? await readSourceDocument(
        client,
        actor,
        childId,
        input.previousMonitoringDocumentId,
        "monitoring_record",
      )
    : null;
  const previousMonitoringGoalResults = await readPreviousMonitoringGoalResults(
    client,
    actor,
    childId,
    previousMonitoring?.id,
  );
  const built = buildBasicAssessmentDraft({
    child,
    guardians: guardians.rows.map(normalizeGuardian),
    consultationPlan,
    currentSchedule,
    previousMonitoring,
    previousMonitoringGoalResults,
    generatedAt: options.generatedAt,
  });
  const document = await createGeneratedDocument(
    client,
    actor,
    childId,
    "basic_assessment",
    built,
  );
  return {
    document,
    sourceIds: [consultationPlan?.id, currentSchedule.id, previousMonitoring?.id].filter(Boolean),
    evidenceCounts: built.payload.generation.evidenceCounts,
  };
}

async function readPreviousMonitoringGoalResults(client, actor, childId, monitoringDocumentId) {
  if (!monitoringDocumentId) return [];
  const result = await client.query(
    `select r.*, g.*, r.id as result_id, r.row_version as result_row_version,
            g.id as source_goal_id, g.row_version as source_goal_row_version
     from public.monitoring_goal_results r
     join public.document_goals g
       on g.tenant_id = r.tenant_id and g.id = r.goal_id
     join public.case_documents source_document
       on source_document.tenant_id = g.tenant_id and source_document.id = g.document_id
      where r.tenant_id = $1 and r.monitoring_document_id = $2
        and source_document.child_id = $3 and source_document.deleted_at is null
      order by g.sort_order, g.id
      limit $4`,
    [actor.tenantId, monitoringDocumentId, childId, MAX_PREVIOUS_MONITORING_RESULTS + 1],
  );
  if (result.rows.length > MAX_PREVIOUS_MONITORING_RESULTS) {
    throw unprocessable(
      "EVIDENCE_LIMIT_EXCEEDED",
      "参照するモニタリング結果が多すぎます。対象文書を確認してください。",
    );
  }
  return result.rows.map((row) => ({
    id: row.result_id,
    progressStatus: row.progress_status,
    progressSummary: row.progress_summary,
    currentChallenge: row.current_challenge,
    nextSupportPolicy: row.next_support_policy,
    nextGoalAction: row.next_goal_action,
    goal: normalizeGoal({ ...row, id: row.source_goal_id, row_version: row.source_goal_row_version }),
  }));
}

export async function generateIndividualSupportPlan(client, actor, childId, input, options = {}) {
  await readChild(client, actor, childId);
  const consultationPlan = input.consultationPlanId
    ? await readSourceDocument(
      client,
      actor,
      childId,
      input.consultationPlanId,
      "consultation_plan",
    )
    : null;
  const assessment = await readSourceDocument(
    client,
    actor,
    childId,
    input.assessmentDocumentId,
    "basic_assessment",
  );
  const previousMonitoring = input.previousMonitoringDocumentId
    ? await readSourceDocument(
        client,
        actor,
        childId,
        input.previousMonitoringDocumentId,
        "monitoring_record",
      )
    : null;
  const consultationGoals = consultationPlan ? await readGoals(client, actor, consultationPlan.id) : [];
  const previousMonitoringGoalResults = await readPreviousMonitoringGoalResults(
    client,
    actor,
    childId,
    previousMonitoring?.id,
  );
  const built = buildIndividualSupportPlanDraft({
    consultationPlan,
    assessment,
    consultationGoals,
    previousMonitoring,
    previousMonitoringGoalResults,
    generatedAt: options.generatedAt,
  });
  const document = await createGeneratedDocument(
    client,
    actor,
    childId,
    "individual_support_plan",
    built,
  );
  const goals = [];
  for (const candidate of built.goals) {
    const created = await createDocumentGoal(client, actor, childId, document.id, candidate);
    goals.push(created.goal);
  }
  return {
    document: { ...document, goals },
    sourceIds: [consultationPlan?.id, assessment.id, previousMonitoring?.id].filter(Boolean),
    evidenceCounts: built.payload.generation.evidenceCounts,
  };
}

async function readActivePlan(client, actor, childId, planId) {
  if (planId) {
    return readSourceDocument(
      client,
      actor,
      childId,
      planId,
      "individual_support_plan",
      { status: "active" },
    );
  }
  const result = await client.query(
    `select * from public.case_documents
     where tenant_id = $1 and child_id = $2 and document_kind = 'individual_support_plan'
       and status = 'active' and deleted_at is null
     order by version_number desc limit 1`,
    [actor.tenantId, childId],
  );
  if (!result.rows[0]) {
    throw unprocessable(
      "ACTIVE_PLAN_REQUIRED",
      "有効中の個別支援計画を確定してからモニタリング下書きを作成してください。",
    );
  }
  return normalizeDocument(result.rows[0]);
}

async function readPeriodEvidence(client, actor, childId, planId, periodStart, periodEnd) {
  const dailyLogs = await client.query(
    `select id, occurred_at, activity, observation, support_provided, child_response
     from public.daily_logs
     where tenant_id = $1 and child_id = $2 and deleted_at is null and status = 'final'
       and occurred_at >= $3::date and occurred_at < ($4::date + interval '1 day')
     order by occurred_at, id
     limit $5`,
    [actor.tenantId, childId, periodStart, periodEnd, MAX_DAILY_LOG_EVIDENCE + 1],
  );
  const contactEntries = await client.query(
    `select id, entry_date, request_summary, reflected_in_support
     from public.contact_book_entries
     where tenant_id = $1 and child_id = $2 and deleted_at is null
       and entry_date between $3::date and $4::date
     order by entry_date, id
     limit $5`,
    [actor.tenantId, childId, periodStart, periodEnd, MAX_CONTACT_EVIDENCE + 1],
  );
  if (dailyLogs.rows.length > MAX_DAILY_LOG_EVIDENCE || contactEntries.rows.length > MAX_CONTACT_EVIDENCE) {
    throw unprocessable(
      "EVIDENCE_LIMIT_EXCEEDED",
      "指定期間の記録件数が多すぎます。期間を短く分けて下書きを作成してください。",
    );
  }
  const goals = await readGoals(client, actor, planId);
  if (!goals.length) {
    throw unprocessable(
      "SOURCE_PLAN_HAS_NO_GOALS",
      "有効中の個別支援計画に目標を登録してからモニタリング下書きを作成してください。",
    );
  }
  const links = await client.query(
    `select dlg.goal_id, dlg.daily_log_id
     from public.daily_log_goals dlg
     join public.daily_logs l
       on l.tenant_id = dlg.tenant_id and l.id = dlg.daily_log_id
     where dlg.tenant_id = $1 and l.child_id = $2 and l.deleted_at is null and l.status = 'final'
       and l.occurred_at >= $3::date and l.occurred_at < ($4::date + interval '1 day')
       and dlg.goal_id = any($5::uuid[])
     order by dlg.goal_id, l.occurred_at, dlg.daily_log_id`,
    [actor.tenantId, childId, periodStart, periodEnd, goals.map((goal) => goal.id)],
  );
  const idsByGoal = new Map(goals.map((goal) => [goal.id, []]));
  for (const row of links.rows) idsByGoal.get(row.goal_id)?.push(row.daily_log_id);
  return {
    dailyLogs: dailyLogs.rows.map((row) => ({
      id: row.id,
      occurredAt: dateTime(row.occurred_at),
      activity: row.activity,
      observation: row.observation,
      supportProvided: row.support_provided,
      childResponse: row.child_response,
    })),
    contactEntries: contactEntries.rows.map((row) => ({
      id: row.id,
      entryDate: dateOnly(row.entry_date),
      requestSummary: row.request_summary,
      reflectedInSupport: Boolean(row.reflected_in_support),
    })),
    goalsWithEvidence: goals.map((goal) => ({ goal, dailyLogIds: idsByGoal.get(goal.id) || [] })),
  };
}

export async function generateMonitoringRecord(client, actor, childId, input, options = {}) {
  await readChild(client, actor, childId);
  const activePlan = await readActivePlan(client, actor, childId, input.individualSupportPlanId);
  const evidence = await readPeriodEvidence(
    client,
    actor,
    childId,
    activePlan.id,
    input.periodStart,
    input.periodEnd,
  );
  const built = buildMonitoringRecordDraft({
    activePlan,
    ...evidence,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    generatedAt: options.generatedAt,
  });
  const document = await createGeneratedDocument(
    client,
    actor,
    childId,
    "monitoring_record",
    built,
  );
  const results = [];
  for (const candidate of built.results) {
    const inserted = await client.query(
      `insert into public.monitoring_goal_results (
        id, tenant_id, monitoring_document_id, goal_id, progress_status,
        progress_summary, current_challenge, next_support_policy, next_goal_action
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning *`,
      [
        uuidv7(),
        actor.tenantId,
        document.id,
        candidate.goalId,
        candidate.progressStatus,
        candidate.progressSummary,
        candidate.currentChallenge,
        candidate.nextSupportPolicy,
        candidate.nextGoalAction,
      ],
    );
    results.push(serializeMonitoringResult(inserted.rows[0]));
  }
  return {
    document: { ...document, monitoringResults: results },
    sourceIds: [activePlan.id, ...built.payload.provenance.dailyLogIds, ...built.payload.provenance.contactBookEntryIds],
    evidenceCounts: built.payload.generation.evidenceCounts,
  };
}

export async function generateDraft(client, actor, childId, input, options = {}) {
  // `case_documents` has no row to lock for a first version. A transaction
  // advisory lock serializes generation per tenant/child/kind so concurrent
  // devices get DRAFT_EXISTS instead of producing competing first drafts.
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':' || $3, 0))",
    [actor.tenantId, childId, input.targetDocumentKind],
  );
  if (input.targetDocumentKind === "basic_assessment") {
    return generateBasicAssessment(client, actor, childId, input, options);
  }
  if (input.targetDocumentKind === "individual_support_plan") {
    return generateIndividualSupportPlan(client, actor, childId, input, options);
  }
  if (input.targetDocumentKind === "monitoring_record") {
    return generateMonitoringRecord(client, actor, childId, input, options);
  }
  throw badRequest("UNSUPPORTED_DRAFT_KIND", "この種類の下書きは自動生成できません。");
}

async function assertEditableMonitoringDocument(client, actor, childId, documentId) {
  const result = await client.query(
    `select id, facility_id, status
     from public.case_documents
     where tenant_id = $1 and child_id = $2 and id = $3
       and document_kind = 'monitoring_record' and deleted_at is null`,
    [actor.tenantId, childId, documentId],
  );
  if (!result.rows[0]) throw notFound("モニタリング記録が見つかりません。");
  if (!EDITABLE_STATUSES.includes(result.rows[0].status)) {
    throw conflict("IMMUTABLE_DOCUMENT", "確定済みのモニタリング記録は変更できません。新しい版を作成してください。");
  }
  return result.rows[0];
}

export async function listMonitoringResults(client, actor, childId, documentId) {
  await readSourceDocument(client, actor, childId, documentId, "monitoring_record", { allowVoid: true });
  const result = await client.query(
    `select * from public.monitoring_goal_results
     where tenant_id = $1 and monitoring_document_id = $2
     order by id`,
    [actor.tenantId, documentId],
  );
  return { items: result.rows.map(serializeMonitoringResult) };
}

const RESULT_PATCH_COLUMNS = Object.freeze({
  progressStatus: "progress_status",
  progressSummary: "progress_summary",
  currentChallenge: "current_challenge",
  nextSupportPolicy: "next_support_policy",
  nextGoalAction: "next_goal_action",
});

export async function updateMonitoringResult(
  client,
  actor,
  childId,
  documentId,
  resultId,
  expectedVersion,
  changes,
) {
  const document = await assertEditableMonitoringDocument(client, actor, childId, documentId);
  const entries = Object.entries(changes).filter(([key]) => RESULT_PATCH_COLUMNS[key]);
  if (!entries.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");
  const parameters = [actor.tenantId, documentId, resultId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    parameters.push(value === "" ? null : value);
    return `${RESULT_PATCH_COLUMNS[key]} = $${parameters.length}`;
  });
  const updated = await client.query(
    `update public.monitoring_goal_results
     set ${assignments.join(", ")}, updated_at = now(), row_version = row_version + 1
     where tenant_id = $1 and monitoring_document_id = $2 and id = $3 and row_version = $4
     returning *`,
    parameters,
  );
  if (updated.rows[0]) {
    return { result: serializeMonitoringResult(updated.rows[0]), facilityId: document.facility_id };
  }
  const current = await client.query(
    `select row_version, updated_at from public.monitoring_goal_results
     where tenant_id = $1 and monitoring_document_id = $2 and id = $3`,
    [actor.tenantId, documentId, resultId],
  );
  if (!current.rows[0]) throw notFound("目標のモニタリング結果が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員がモニタリング結果を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: dateTime(current.rows[0].updated_at),
  });
}
