import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";
import { DRAFT_BUILDER_LIMITS } from "../server/services/draft-builder.js";
import {
  advanceDocumentFixture,
  approveDocumentFixture,
} from "./helpers/document-workflow-fixture.mjs";

const IDS = {
  tenant: "018f2db5-c170-7c35-a784-3cfc6f98d101",
  user: "018f2db5-c170-7c35-a784-3cfc6f98d201",
  facility: "018f2db5-c170-7c35-a784-3cfc6f98d301",
  membership: "018f2db5-c170-7c35-a784-3cfc6f98d401",
  child: "018f2db5-c170-7c35-a784-3cfc6f98d501",
  otherChild: "018f2db5-c170-7c35-a784-3cfc6f98d502",
  scheduleFreeChild: "018f2db5-c170-7c35-a784-3cfc6f98d503",
  guardian: "018f2db5-c170-7c35-a784-3cfc6f98d601",
  schedule: "018f2db5-c170-7c35-a784-3cfc6f98d701",
  scheduleItem: "018f2db5-c170-7c35-a784-3cfc6f98d702",
  consultation: "018f2db5-c170-7c35-a784-3cfc6f98d801",
  otherConsultation: "018f2db5-c170-7c35-a784-3cfc6f98d802",
  assessment: "018f2db5-c170-7c35-a784-3cfc6f98d803",
  activePlan: "018f2db5-c170-7c35-a784-3cfc6f98d804",
  previousMonitoring: "018f2db5-c170-7c35-a784-3cfc6f98d805",
  otherMonitoring: "018f2db5-c170-7c35-a784-3cfc6f98d806",
  consultationGoal: "018f2db5-c170-7c35-a784-3cfc6f98d901",
  activeGoalOne: "018f2db5-c170-7c35-a784-3cfc6f98d902",
  activeGoalTwo: "018f2db5-c170-7c35-a784-3cfc6f98d903",
  previousResult: "018f2db5-c170-7c35-a784-3cfc6f98da01",
  logOne: "018f2db5-c170-7c35-a784-3cfc6f98db01",
  logTwo: "018f2db5-c170-7c35-a784-3cfc6f98db02",
  logThree: "018f2db5-c170-7c35-a784-3cfc6f98db03",
  contact: "018f2db5-c170-7c35-a784-3cfc6f98dc01",
};

const migrationsDirectory = new URL("../db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrationSql = (await Promise.all(
  migrationFiles.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
)).join("\n");
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function config(role = "tenant_admin") {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    appBaseUrl: "http://127.0.0.1",
    databaseUrl: "postgresql://unused-in-pglite",
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "development",
    cookieSecret: undefined,
    auditHashKey: "draft-generation-test-audit-key",
    cognito: null,
    devActor: {
      userId: IDS.user,
      tenantId: IDS.tenant,
      facilityIds: [IDS.facility],
      role,
      displayName: "架空事業所 管理者",
    },
  };
}

function pglitePool(db) {
  return {
    async connect() {
      return { query: (sql, parameters) => db.query(sql, parameters), release() {} };
    },
    query: (sql, parameters) => db.query(sql, parameters),
  };
}

async function insertDocument(db, {
  id,
  childId = IDS.child,
  kind,
  status: _requestedStatus = "draft",
  version = 1,
  payload = {},
  periodStart = "2026-04-01",
  periodEnd = "2026-09-30",
}) {
  await db.query(
    `insert into public.case_documents (
      id, tenant_id, facility_id, child_id, document_kind, status, version_number,
      template_version, period_start, period_end, payload, created_by, updated_by,
      approved_by, approved_at
    ) values ($1, $2, $3, $4, $5, 'draft', $6, 'test-v1', $7, $8, $9::jsonb, $10::uuid, $10::uuid,
      null, null)`,
    [id, IDS.tenant, IDS.facility, childId, kind, version, periodStart, periodEnd, JSON.stringify(payload), IDS.user],
  );
}

async function insertGoal(db, { id, documentId, kind = "support", title, sortOrder = 0 }) {
  await db.query(
    `insert into public.document_goals (
      id, tenant_id, document_id, goal_kind, title, desired_outcome,
      support_details, evaluation_method, responsible_party, five_domains, sort_order
    ) values ($1, $2, $3, $4, $5, '本人が選んだ方法で参加できる',
      '見通しを示し、選択肢を提示する', '関連日誌と面談で確認', '支援員',
      array['cognition_behavior','language_communication'], $6)`,
    [id, IDS.tenant, documentId, kind, title, sortOrder],
  );
}

async function approveDocument(db, documentId) {
  await db.exec("begin");
  try {
    await approveDocumentFixture(db, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      documentId,
    });
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "架空福祉法人みらい",
      IDS.user,
      "cognito-draft-test",
      "draft-test@example.invalid",
      "架空事業所 管理者",
      IDS.membership,
      IDS.facility,
      "F-001",
      "架空放課後等デイサービス",
    ],
  );
  await db.query(
    "select set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)",
    [IDS.tenant, IDS.user],
  );
  for (const [id, code, displayName] of [
    [IDS.child, "C-001", "Aさん（架空）"],
    [IDS.otherChild, "C-002", "Bさん（架空）"],
  ]) {
    await db.query(
      `insert into public.children (
        id, tenant_id, facility_id, management_code, display_name, legal_name,
        birth_date, grade, disability_category, created_by, updated_by
      ) values ($1, $2, $3, $4, $5, $5, '2018-05-10', '小学2年', '発達支援', $6, $6)`,
      [id, IDS.tenant, IDS.facility, code, displayName, IDS.user],
    );
  }
  await db.query(
    `insert into public.guardians (
      id, tenant_id, child_id, legal_name, relationship, is_primary
    ) values ($1, $2, $3, 'Aさん保護者（架空）', '母', true)`,
    [IDS.guardian, IDS.tenant, IDS.child],
  );
  await db.query(
    `insert into public.schedule_versions (
      id, tenant_id, facility_id, child_id, schedule_kind, version_number, status,
      valid_from, valid_to, summary, created_by
    ) values ($1, $2, $3, $4, 'current', 1, 'draft', '2026-04-01', '2026-09-30',
      '平日は学校後に事業所を利用する', $5)`,
    [IDS.schedule, IDS.tenant, IDS.facility, IDS.child, IDS.user],
  );
  await db.query(
    `insert into public.schedule_items (
      id, tenant_id, schedule_version_id, day_of_week, start_minute, end_minute,
      activity, location, service_kind
    ) values ($1, $2, $3, 1, 900, 1020, '放課後等デイサービス', '架空事業所', 'day_service')`,
    [IDS.scheduleItem, IDS.tenant, IDS.schedule],
  );
  await db.query(
    "update public.schedule_versions set status = 'finalized', finalized_at = now() where id = $1",
    [IDS.schedule],
  );

  await insertDocument(db, {
    id: IDS.consultation,
    kind: "consultation_plan",
    payload: {
      personWish: "好きな活動を自分で選びたい",
      guardianWish: "安心して友達と過ごしてほしい",
      overallGoal: "見通しを持って地域生活に参加する",
      currentSituation: "予定が分かると落ち着いて参加できる",
    },
  });
  await insertDocument(db, {
    id: IDS.otherConsultation,
    childId: IDS.otherChild,
    kind: "consultation_plan",
    payload: { overallGoal: "別の利用児の架空目標" },
  });
  await insertDocument(db, {
    id: IDS.assessment,
    kind: "basic_assessment",
    payload: {
      childWishes: "好きな活動を自分で選びたい",
      familyWishes: "安心して友達と過ごしてほしい",
      overallAssessment: "予定を視覚的に共有する",
      supportConsiderations: "予定を視覚的に共有する",
      assessment: {
        strengths: "絵や写真を見て順序を理解できる",
        needs: "切り替え前の予告が必要",
        supportDirection: "予定を視覚的に共有する",
      },
    },
  });
  await insertDocument(db, {
    id: IDS.activePlan,
    kind: "individual_support_plan",
    status: "active",
    payload: { plan: { comprehensiveSupportPolicy: "人が確認して決めた支援方針" } },
  });
  await insertDocument(db, {
    id: IDS.previousMonitoring,
    kind: "monitoring_record",
    payload: { overallEvaluation: "前期の架空評価", nextPlanDirection: "会議で要検討" },
  });
  await insertDocument(db, {
    id: IDS.otherMonitoring,
    childId: IDS.otherChild,
    kind: "monitoring_record",
    payload: { monitoring: { overallEvaluation: "別の利用児の非公開評価" } },
  });
  await insertGoal(db, {
    id: IDS.consultationGoal,
    documentId: IDS.consultation,
    kind: "long_term",
    title: "地域生活へ安心して参加する",
  });
  await insertGoal(db, {
    id: IDS.activeGoalOne,
    documentId: IDS.activePlan,
    title: "予定を確認して活動を選ぶ",
    sortOrder: 1,
  });
  await insertGoal(db, {
    id: IDS.activeGoalTwo,
    documentId: IDS.activePlan,
    title: "困ったときに援助を伝える",
    sortOrder: 2,
  });
  await db.query(
    `insert into public.monitoring_goal_results (
      id, tenant_id, monitoring_document_id, goal_id, progress_status,
      progress_summary, next_goal_action
    ) values ($1, $2, $3, $4, 'maintained', '人が確認した前期の架空評価', 'continue')`,
    [IDS.previousResult, IDS.tenant, IDS.previousMonitoring, IDS.activeGoalOne],
  );
  await approveDocument(db, IDS.assessment);
  await approveDocument(db, IDS.previousMonitoring);
  await approveDocument(db, IDS.activePlan);
  await db.exec("begin");
  try {
    await advanceDocumentFixture(db, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      documentId: IDS.activePlan,
      action: "distribute",
    });
    await advanceDocumentFixture(db, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      documentId: IDS.activePlan,
      action: "activate",
    });
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }

  for (const [id, occurredAt, activity, observation, supportProvided, childResponse] of [
    [IDS.logOne, "2026-05-01T06:00:00.000Z", "工作", "【サンプル】制作活動では、手順を確認しながら集中して取り組み、完成した作品を職員に見せていました。", "手順を一つずつ示した。", "完成後に笑顔で作品を見せた。"],
    [IDS.logTwo, "2026-05-08T06:00:00.000Z", "集団活動", "【サンプル】集団活動では、順番を待って友だちと役割を分担することができました。", "役割を視覚的に伝えた。", "友だちに道具を渡した。"],
    [IDS.logThree, "2026-05-15T06:00:00.000Z", "外出", "【サンプル】外出先で予定と異なることに戸惑いが見られましたが、選べる方法を二つ提示すると気持ちを切り替え、安心して活動を続けられました。", "選べる方法を二つ提示した。", "選択後は落ち着いて再開した。"],
  ]) {
    await db.query(
      `insert into public.daily_logs (
        id, tenant_id, facility_id, child_id, occurred_at, activity, observation,
        support_provided, child_response, five_domains, recorded_by, updated_by
      ) values ($1, $2, $3, $4, $5, $6, $7, $8,
        $9, array['cognition_behavior'], $10, $10)`,
      [id, IDS.tenant, IDS.facility, IDS.child, occurredAt, activity, observation, supportProvided, childResponse, IDS.user],
    );
  }
  for (const logId of [IDS.logOne, IDS.logTwo]) {
    await db.query(
      "insert into public.daily_log_goals (tenant_id, daily_log_id, goal_id) values ($1, $2, $3)",
      [IDS.tenant, logId, IDS.activeGoalOne],
    );
  }
  await db.query(
    `insert into public.contact_book_entries (
      id, tenant_id, facility_id, child_id, entry_date, family_message,
      request_summary, reflected_in_support, recorded_by, updated_by
    ) values ($1, $2, $3, $4, '2026-05-10', '架空の家庭での様子',
      '休憩の選び方も相談したい', false, $5, $5)`,
    [IDS.contact, IDS.tenant, IDS.facility, IDS.child, IDS.user],
  );
  await db.exec("set role michinote_runtime");
  return db;
}

async function withApp(role, operation) {
  const db = await setupDatabase();
  const app = await buildApp({ config: config(role), pool: pglitePool(db) });
  try {
    return await operation(app, db);
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
}

function generate(app, payload) {
  return app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.child}/draft-generations`,
    payload,
  });
}

test("相談支援計画・利用児・保護者・現在スケジュールからアセスメント候補を作る", async () => {
  await withApp("tenant_admin", async (app) => {
    const response = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
      previousMonitoringDocumentId: IDS.previousMonitoring,
    });
    assert.equal(response.statusCode, 201);
    const draft = response.json();
    assert.equal(draft.documentKind, "basic_assessment");
    assert.equal(draft.status, "draft");
    assert.equal(draft.payload.consultationPlanCandidates.personWish, "好きな活動を自分で選びたい");
    assert.equal(draft.payload.assessment.personWish, null);
    assert.equal(draft.payload.generation.safeguards.personAndFamilyIntentAutomaticallyDecided, false);
    assert.deepEqual(draft.payload.provenance.currentSchedule.id, IDS.schedule);
    assert.equal(draft.payload.generation.evidenceCounts.guardians, 1);
    assert.equal(draft.payload.generation.evidenceCounts.scheduleItems, 1);
    assert.equal(draft.payload.generation.evidenceCounts.previousMonitoringResults, 1);
    assert.equal(draft.payload.provenance.previousMonitoring.id, IDS.previousMonitoring);
    assert.deepEqual(draft.payload.provenance.previousMonitoringResultIds, [IDS.previousResult]);
    assert.equal(draft.payload.previousMonitoringCandidates.overallEvaluation, "前期の架空評価");
    assert.equal(draft.payload.previousMonitoringCandidates.goalResults[0].goalId, IDS.activeGoalOne);
    assert.equal(draft.payload.previousMonitoringCandidates.goalResults[0].progressStatus, "maintained");
    assert.equal(draft.payload.assessment.supportDirection, null);
  });
});

test("指定期間の支援記録からアセスメントを作成・更新し、手入力は保持する", async () => {
  await withApp("tenant_admin", async (app) => {
    const createdResponse = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json();
    assert.equal(created.periodStart, "2026-05-01");
    assert.equal(created.periodEnd, "2026-05-31");
    assert.equal(created.payload.generation.evidenceCounts.supportRecords, 3);
    assert.deepEqual(created.payload.provenance.supportRecordIds, [IDS.logOne, IDS.logTwo, IDS.logThree]);
    assert.equal(created.payload.supportRecordEvidence.excerpts.length, 3);
    assert.match(created.payload.overallAssessment, /支援記録3件/);
    assert.match(created.payload.strengths, /制作・集団・外出などの活動/);
    assert.match(created.payload.movementSensory, /制作活動/);
    assert.match(created.payload.cognitionBehavior, /予定と異なることに戸惑い/);
    assert.match(created.payload.cognitionBehavior, /気持ちを切り替え/);
    assert.doesNotMatch(created.payload.cognitionBehavior, /サンプル/);
    assert.doesNotMatch(created.payload.cognitionBehavior, /支援の記録では/);
    assert.doesNotMatch(JSON.stringify(created.payload), /サンプル/);
    assert.match(created.payload.relationshipsSocial, /集団活動/);
    assert.match(created.payload.publicBehavior, /外出/);
    assert.equal(created.payload.healthManagement, null);
    assert.equal(created.payload.childWishes, null);
    assert.equal(created.payload.familyWishes, null);

    const manuallyEdited = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${created.id}`,
      headers: { "if-match": '"1"' },
      payload: {
      payload: {
        ...created.payload,
        strengths: "職員が確認した本人の強み",
        cognitionBehavior: "支援の記録では、【サンプル】古い候補文です。",
      },
      },
    });
    assert.equal(manuallyEdited.statusCode, 200);

    const refreshedResponse = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
      assessmentDocumentId: created.id,
      periodStart: "2026-05-08",
      periodEnd: "2026-05-31",
    });
    assert.equal(refreshedResponse.statusCode, 201);
    const refreshed = refreshedResponse.json();
    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.rowVersion, 3);
    assert.equal(refreshed.periodStart, "2026-05-08");
    assert.equal(refreshed.payload.strengths, "職員が確認した本人の強み");
    assert.doesNotMatch(refreshed.payload.cognitionBehavior, /サンプル/);
    assert.doesNotMatch(refreshed.payload.cognitionBehavior, /古い候補文/);
    assert.deepEqual(refreshed.payload.provenance.supportRecordIds, [IDS.logTwo, IDS.logThree]);
  });
});

test("相談支援計画・アセスメント・前回モニタリングから計画候補と目標系譜を作る", async () => {
  await withApp("plan_approver", async (app) => {
    const response = await generate(app, {
      targetDocumentKind: "individual_support_plan",
      consultationPlanId: IDS.consultation,
      assessmentDocumentId: IDS.assessment,
      previousMonitoringDocumentId: IDS.previousMonitoring,
    });
    assert.equal(response.statusCode, 201);
    const draft = response.json();
    assert.equal(draft.documentKind, "individual_support_plan");
    assert.equal(draft.payload.userAndFamilyWishes, "本人: 好きな活動を自分で選びたい\n家族: 安心して友達と過ごしてほしい");
    assert.equal(draft.payload.overallSupportPolicy, "予定を視覚的に共有する");
    assert.equal(draft.payload.supportConsiderations, "予定を視覚的に共有する");
    assert.equal(draft.payload.plan.personWish, "本人: 好きな活動を自分で選びたい\n家族: 安心して友達と過ごしてほしい");
    assert.equal(draft.payload.assessmentCandidates.strengths, "絵や写真を見て順序を理解できる");
    assert.equal(draft.goals.length, 2);
    assert.deepEqual(
      new Set(draft.goals.map((goal) => goal.predecessorGoalId)),
      new Set([IDS.consultationGoal, IDS.activeGoalOne]),
    );
    assert.equal(draft.payload.generation.evidenceCounts.previousMonitoringResults, 1);
  });
});

test("アセスメントから個別支援計画を作成し、再反映では入力済みの項目と目標を保持する", async () => {
  await withApp("plan_approver", async (app) => {
    const createdResponse = await generate(app, {
      targetDocumentKind: "individual_support_plan",
      assessmentDocumentId: IDS.assessment,
    });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json();
    assert.equal(created.payload.overallSupportPolicy, "予定を視覚的に共有する");
    assert.equal(created.goals.length, 0);

    const editedResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${created.id}`,
      headers: { "if-match": '"1"' },
      payload: {
        payload: { ...created.payload, overallSupportPolicy: "会議で確認した支援方針" },
      },
    });
    assert.equal(editedResponse.statusCode, 200);

    const refreshedResponse = await generate(app, {
      targetDocumentKind: "individual_support_plan",
      assessmentDocumentId: IDS.assessment,
      individualSupportPlanDocumentId: created.id,
    });
    assert.equal(refreshedResponse.statusCode, 201);
    const refreshed = refreshedResponse.json();
    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.rowVersion, 3);
    assert.equal(refreshed.payload.overallSupportPolicy, "会議で確認した支援方針");
    assert.equal(refreshed.goals.length, 0);
    assert.equal(refreshed.payload.assessmentCandidates.strengths, "絵や写真を見て順序を理解できる");
  });
});

test("相談支援計画がなくても、事業所のアセスメントと個別支援計画を作れる", async () => {
  await withApp("plan_approver", async (app) => {
    const assessment = await generate(app, {
      targetDocumentKind: "basic_assessment",
      currentScheduleVersionId: IDS.schedule,
    });
    assert.equal(assessment.statusCode, 201);
    assert.equal(assessment.json().payload.consultationPlanCandidates.personWish, null);
    assert.equal(assessment.json().payload.generation.sourceDocuments.some((document) => document.documentKind === "consultation_plan"), false);

    const individual = await generate(app, {
      targetDocumentKind: "individual_support_plan",
      assessmentDocumentId: IDS.assessment,
    });
    assert.equal(individual.statusCode, 201);
    assert.equal(individual.json().payload.generation.sourceDocuments.some((document) => document.documentKind === "consultation_plan"), false);
    assert.equal(individual.json().payload.generation.evidenceCounts.consultationGoals, 0);
  });
});

test("週間予定がなくても、アセスメント下書きを作れる", async () => {
  await withApp("plan_approver", async (app, db) => {
    await db.query(
      `insert into public.children (
        id, tenant_id, facility_id, management_code, display_name, legal_name,
        birth_date, grade, disability_category, created_by, updated_by
      ) values ($1, $2, $3, 'C-003', '予定なし利用児（架空）', '予定なし利用児（架空）',
        '2018-05-10', '小学2年', '発達支援', $4, $4)`,
      [IDS.scheduleFreeChild, IDS.tenant, IDS.facility, IDS.user],
    );

    const assessment = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.scheduleFreeChild}/draft-generations`,
      payload: { targetDocumentKind: "basic_assessment" },
    });

    assert.equal(assessment.statusCode, 201);
    assert.equal(assessment.json().payload.provenance.currentSchedule, null);
    assert.equal(assessment.json().payload.currentScheduleFacts, null);
    assert.equal(assessment.json().payload.generation.evidenceCounts.scheduleItems, 0);
  });
});

test("期間内の日誌と連絡帳からモニタリング下書きを作り、根拠不足は未評価にする", async () => {
  await withApp("support_staff", async (app) => {
    const response = await generate(app, {
      targetDocumentKind: "monitoring_record",
      individualSupportPlanId: IDS.activePlan,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    assert.equal(response.statusCode, 201);
    const draft = response.json();
    assert.equal(draft.payload.generation.evidenceCounts.dailyLogs, 3);
    assert.equal(draft.payload.generation.evidenceCounts.contactBookEntries, 1);
    assert.equal(draft.payload.monitoring.overallEvaluation, null);
    assert.deepEqual(draft.payload.provenance.dailyLogIds, [IDS.logOne, IDS.logTwo, IDS.logThree]);
    assert.equal(draft.monitoringResults.length, 2);
    const enough = draft.monitoringResults.find((result) => result.goalId === IDS.activeGoalOne);
    const insufficient = draft.monitoringResults.find((result) => result.goalId === IDS.activeGoalTwo);
    const enoughEvidence = draft.payload.provenance.goalEvidence[IDS.activeGoalOne];
    const insufficientEvidence = draft.payload.provenance.goalEvidence[IDS.activeGoalTwo];
    assert.equal(enough.progressStatus, "needs_review");
    assert.equal(insufficient.progressStatus, "not_evaluated");
    assert.equal(insufficient.nextGoalAction, null);
    assert.equal(enoughEvidence.excerpts.length, 2);
    assert.deepEqual(enoughEvidence.excerpts.map((entry) => entry.date), ["2026-05-01", "2026-05-08"]);
    assert.equal(enoughEvidence.excerpts[0].activity, "工作");
    assert.match(enoughEvidence.excerpts[0].observation, /制作活動/);
    assert.equal(enoughEvidence.excerpts[0].supportProvided, "手順を一つずつ示した。");
    assert.equal(enoughEvidence.excerpts[0].childResponse, "完成後に笑顔で作品を見せた。");
    assert.equal(insufficientEvidence.excerpts.length, 0);
    assert.equal(insufficient.progressSummary.includes("未評価"), true);

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${draft.id}/monitoring-results/${insufficient.id}`,
      headers: { "if-match": '"1"' },
      payload: {
        progressStatus: "maintained",
        progressSummary: "面談と記録を人が確認し、維持と評価した",
        nextGoalAction: "continue",
      },
    });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().progressStatus, "maintained");
    assert.equal(edited.headers.etag, '"2"');

    const duplicate = await generate(app, {
      targetDocumentKind: "monitoring_record",
      individualSupportPlanId: IDS.activePlan,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, "DRAFT_EXISTS");
  });
});

test("モニタリング下書きの根拠を次期アセスメントと個別支援計画へ引き継ぐ", async () => {
  await withApp("plan_approver", async (app) => {
    const monitoringResponse = await generate(app, {
      targetDocumentKind: "monitoring_record",
      individualSupportPlanId: IDS.activePlan,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    assert.equal(monitoringResponse.statusCode, 201);
    const monitoring = monitoringResponse.json();
    const monitoringResult = monitoring.monitoringResults.find((result) => result.goalId === IDS.activeGoalOne);
    const reviewed = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${monitoring.id}/monitoring-results/${monitoringResult.id}`,
      headers: { "if-match": '"1"' },
      payload: {
        progressStatus: "maintained",
        progressSummary: "日誌と面談を確認し、見通しを持って活動に取り組む様子が維持できていると評価した。",
        currentChallenge: "予定変更時は、事前の説明がないと不安定になりやすい。",
        nextSupportPolicy: "予定を視覚的に共有し、変更前に短く伝える。",
        nextGoalAction: "continue",
      },
    });
    assert.equal(reviewed.statusCode, 200);

    const assessmentResponse = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
      previousMonitoringDocumentId: monitoring.id,
    });
    assert.equal(assessmentResponse.statusCode, 201);
    const assessment = assessmentResponse.json();
    assert.equal(assessment.payload.provenance.previousMonitoring.id, monitoring.id);
    assert.equal(assessment.payload.previousMonitoringCandidates.goalResults.length, 2);
    assert.match(assessment.payload.concerns, /予定変更時は、事前の説明がないと不安定になりやすい/);
    assert.match(assessment.payload.overallAssessment, /日誌と面談を確認し/);
    assert.match(assessment.payload.supportConsiderations, /予定を視覚的に共有し/);
    assert.equal(
      assessment.payload.previousMonitoringCandidates.goalResults.some(
        (result) => result.progressStatus === "not_evaluated",
      ),
      true,
    );

    const planResponse = await generate(app, {
      targetDocumentKind: "individual_support_plan",
      consultationPlanId: IDS.consultation,
      assessmentDocumentId: assessment.id,
      previousMonitoringDocumentId: monitoring.id,
    });
    assert.equal(planResponse.statusCode, 201);
    const plan = planResponse.json();
    assert.equal(plan.payload.previousMonitoringCandidates.goalResults.length, 2);
    assert.equal(plan.payload.generation.evidenceCounts.previousMonitoringResults, 2);
    assert.match(plan.payload.plan.comprehensiveSupportPolicy, /日誌と面談を確認し/);
  });
});

test("目標別の日誌抜粋を最新12件に制限し、古い順と文字数上限を保つ", async () => {
  await withApp("support_staff", async (app, db) => {
    const privateObservation = "監査ログへ入れてはいけない観察情報".repeat(20);
    for (let offset = 0; offset < 13; offset += 1) {
      const sequence = offset + 1;
      const id = `018f2db5-c170-7c35-a784-3cfc6f98e${String(sequence).padStart(3, "0")}`;
      const day = 16 + offset;
      await db.query(
        `insert into public.daily_logs (
          id, tenant_id, facility_id, child_id, occurred_at, activity, observation,
          support_provided, child_response, five_domains, recorded_by, updated_by
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
          array['cognition_behavior'], $10, $10)`,
        [
          id,
          IDS.tenant,
          IDS.facility,
          IDS.child,
          `2026-05-${String(day).padStart(2, "0")}T06:00:00.000Z`,
          `活動${sequence}`.repeat(150),
          privateObservation,
          `支援${sequence}`.repeat(150),
          `反応${sequence}`.repeat(150),
          IDS.user,
        ],
      );
      await db.query(
        "insert into public.daily_log_goals (tenant_id, daily_log_id, goal_id) values ($1, $2, $3)",
        [IDS.tenant, id, IDS.activeGoalOne],
      );
    }

    const response = await generate(app, {
      targetDocumentKind: "monitoring_record",
      individualSupportPlanId: IDS.activePlan,
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });
    assert.equal(response.statusCode, 201);
    const draft = response.json();
    const evidence = draft.payload.provenance.goalEvidence[IDS.activeGoalOne];
    const result = draft.monitoringResults.find((item) => item.goalId === IDS.activeGoalOne);

    assert.equal(evidence.dailyLogCount, 15);
    assert.equal(evidence.excerpts.length, DRAFT_BUILDER_LIMITS.maximumGoalEvidenceExcerpts);
    assert.equal(evidence.excerptsTruncated, true);
    assert.equal(evidence.excerptSelection, "most_recent_chronological");
    assert.equal(evidence.excerpts[0].date, "2026-05-17");
    assert.equal(evidence.excerpts.at(-1).date, "2026-05-28");
    assert.deepEqual(
      [...evidence.excerpts.map((entry) => entry.date)].sort(),
      evidence.excerpts.map((entry) => entry.date),
    );
    for (const excerpt of evidence.excerpts) {
      assert.deepEqual(new Set(Object.keys(excerpt)), new Set([
        "dailyLogId",
        "date",
        "activity",
        "observation",
        "supportProvided",
        "childResponse",
      ]));
      for (const field of ["activity", "observation", "supportProvided", "childResponse"]) {
        assert.ok([...excerpt[field]].length <= DRAFT_BUILDER_LIMITS.maximumEvidenceFieldCharacters);
        assert.equal(excerpt[field].endsWith("…"), true);
      }
    }
    assert.equal(result.progressStatus, "needs_review");
    assert.match(result.progressSummary, /日誌15件/);
    assert.doesNotMatch(result.progressSummary, /達成|改善|維持した/);

    const audit = await db.query(
      `select metadata from public.audit_events
       where tenant_id = $1 and action = 'case_document.draft_generated'
       order by occurred_at desc limit 1`,
      [IDS.tenant],
    );
    assert.equal(JSON.stringify(audit.rows[0].metadata).includes(privateObservation), false);
  });
});

test("入力不備と別利用児の根拠文書を422で拒否し、入力PIIを応答へ出さない", async () => {
  await withApp("tenant_admin", async (app) => {
    const crossChild = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.otherConsultation,
      currentScheduleVersionId: IDS.schedule,
    });
    assert.equal(crossChild.statusCode, 422);
    assert.equal(crossChild.json().error.code, "INVALID_SOURCE_DOCUMENT");

    const crossChildMonitoring = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
      previousMonitoringDocumentId: IDS.otherMonitoring,
    });
    assert.equal(crossChildMonitoring.statusCode, 422);
    assert.equal(crossChildMonitoring.json().error.code, "INVALID_SOURCE_DOCUMENT");
    assert.equal(crossChildMonitoring.body.includes("別の利用児の非公開評価"), false);

    const wrongMonitoringKind = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
      previousMonitoringDocumentId: IDS.assessment,
    });
    assert.equal(wrongMonitoringKind.statusCode, 422);
    assert.equal(wrongMonitoringKind.json().error.code, "INVALID_SOURCE_DOCUMENT");

    const invalid = await generate(app, {
      targetDocumentKind: "monitoring_record",
      individualSupportPlanId: IDS.activePlan,
      periodStart: "2026-06-30",
      periodEnd: "2026-05-01",
      privateMarker: "SECRET-CHILD-VALUE",
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.includes("SECRET-CHILD-VALUE"), false);

    const impossibleDate = await generate(app, {
      targetDocumentKind: "monitoring_record",
      individualSupportPlanId: IDS.activePlan,
      periodStart: "2026-02-30",
      periodEnd: "2026-03-31",
    });
    assert.equal(impossibleDate.statusCode, 422);
    assert.equal(impossibleDate.json().error.code, "VALIDATION_ERROR");
  });

  await withApp("viewer", async (app) => {
    const forbidden = await generate(app, {
      targetDocumentKind: "basic_assessment",
      consultationPlanId: IDS.consultation,
      currentScheduleVersionId: IDS.schedule,
    });
    assert.equal(forbidden.statusCode, 403);
  });
});
