import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";
import { approveDocumentFixture } from "./helpers/document-workflow-fixture.mjs";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98d101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98d201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98d301",
  membership: "018f1db5-c170-7c35-a784-3cfc6f98d401",
  child: "018f1db5-c170-7c35-a784-3cfc6f98d501",
};

const migrationsDirectory = new URL("../db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrationSql = (await Promise.all(
  migrationFiles.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
)).join("\n");
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function testConfig(role = "tenant_admin") {
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
    auditHashKey: "document-api-test-audit-key",
    cognito: null,
    devActor: {
      userId: IDS.user,
      tenantId: IDS.tenant,
      facilityIds: [IDS.facility],
      role,
      displayName: "テスト管理者",
    },
  };
}

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "テスト法人",
      IDS.user,
      "cognito-document-test",
      "document-test@example.invalid",
      "テスト管理者",
      IDS.membership,
      IDS.facility,
      "F-001",
      "テスト事業所",
    ],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values ($1, $2, $3, 'C-001', 'Aさん', 'テスト 利用児', $4, $4)`,
    [IDS.child, IDS.tenant, IDS.facility, IDS.user],
  );
  await db.exec("set role michinote_runtime");
  return db;
}

function pglitePool(db) {
  return {
    async connect() {
      return {
        query(sql, parameters) {
          return db.query(sql, parameters);
        },
        release() {},
      };
    },
    query(sql, parameters) {
      return db.query(sql, parameters);
    },
  };
}

async function createPlan(app, documentKind, payload) {
  return app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.child}/documents`,
    payload: {
      documentKind,
      templateVersion: "2026-01",
      periodStart: "2026-04-01",
      periodEnd: "2026-09-30",
      payload,
    },
  });
}

test("アセスメントとモニタリングを計画書とは別の版系列で保存できる", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const assessment = await createPlan(app, "basic_assessment", {
      childAndFamilyWishes: "架空の希望",
      currentSituation: "架空の現状",
    });
    const monitoring = await createPlan(app, "monitoring_record", {
      overallEvaluation: "架空のモニタリング結果",
    });
    assert.equal(assessment.statusCode, 201);
    assert.equal(monitoring.statusCode, 201);
    assert.equal(assessment.json().documentKind, "basic_assessment");
    assert.equal(monitoring.json().documentKind, "monitoring_record");
    assert.equal(assessment.json().versionNumber, 1);
    assert.equal(monitoring.json().versionNumber, 1);
    assert.notEqual(assessment.json().id, monitoring.json().id);
  } finally {
    await app.close();
    await db.close();
  }
});

test("相談支援計画と事業所個別支援計画を分離し、下書きと目標を楽観ロックで編集できる", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const consultation = await createPlan(app, "consultation_plan", {
      source: "consultation_support_office",
      overallPolicy: "本人と家族の希望をまとめた全体方針",
    });
    assert.equal(consultation.statusCode, 201);
    assert.equal(consultation.headers.etag, '"1"');
    assert.equal(consultation.json().documentKind, "consultation_plan");
    assert.equal(consultation.json().versionNumber, 1);

    const individual = await createPlan(app, "individual_support_plan", {
      sourceConsultationPlanId: consultation.json().id,
      overallPolicy: "事業所で実施する支援方針",
    });
    assert.equal(individual.statusCode, 201);
    assert.equal(individual.json().documentKind, "individual_support_plan");
    assert.equal(individual.json().versionNumber, 1);
    assert.notEqual(individual.json().id, consultation.json().id);

    const consultationList = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents?documentKind=consultation_plan`,
    });
    assert.equal(consultationList.statusCode, 200);
    assert.deepEqual(consultationList.json().items.map((item) => item.id), [consultation.json().id]);
    assert.equal(Object.hasOwn(consultationList.json().items[0], "payload"), false);

    const secondReference = await createPlan(app, "consultation_plan", { note: "別の参考資料" });
    assert.equal(secondReference.statusCode, 201);
    assert.equal(secondReference.json().versionNumber, 2);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${individual.json().id}`,
      headers: { "if-match": individual.headers.etag },
      payload: { payload: { overallPolicy: "日誌の根拠を反映した支援方針" } },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.headers.etag, '"2"');
    assert.equal(updated.json().updatedBy, IDS.user);

    const staleDocument = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${individual.json().id}`,
      headers: { "if-match": '"1"' },
      payload: { payload: { privateMarker: "SECRET-CHILD-NAME" } },
    });
    assert.equal(staleDocument.statusCode, 409);
    assert.equal(staleDocument.json().error.code, "EDIT_CONFLICT");
    assert.equal(staleDocument.body.includes("SECRET-CHILD-NAME"), false);

    const goal = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${individual.json().id}/goals`,
      payload: {
        goalKind: "support",
        title: "活動の見通しを持つ",
        desiredOutcome: "予定を確認して安心して参加できる",
        fiveDomains: ["cognition_behavior", "language_communication"],
      },
    });
    assert.equal(goal.statusCode, 201);
    assert.equal(goal.headers.etag, '"1"');

    const changedGoal = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${individual.json().id}/goals/${goal.json().id}`,
      headers: { "if-match": goal.headers.etag },
      payload: { supportDetails: "写真カードで予定を一緒に確認する" },
    });
    assert.equal(changedGoal.statusCode, 200);
    assert.equal(changedGoal.headers.etag, '"2"');

    const staleGoal = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${individual.json().id}/goals/${goal.json().id}`,
      headers: { "if-match": '"1"' },
      payload: { title: "古い画面からの更新" },
    });
    assert.equal(staleGoal.statusCode, 409);
    assert.equal(staleGoal.json().error.code, "EDIT_CONFLICT");

    const deletedGoal = await app.inject({
      method: "DELETE",
      url: `/api/v1/children/${IDS.child}/documents/${individual.json().id}/goals/${goal.json().id}`,
      headers: { "if-match": changedGoal.headers.etag },
    });
    assert.equal(deletedGoal.statusCode, 204);

    await db.exec("reset role");
    const storedActors = await db.query(
      "select created_by, updated_by from public.case_documents where id = $1",
      [individual.json().id],
    );
    assert.deepEqual(storedActors.rows[0], { created_by: IDS.user, updated_by: IDS.user });
    await db.exec("set role michinote_runtime");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("参考資料は下書きの有無にかかわらず添付・確認・削除できる", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const reference = await createPlan(app, "consultation_plan", { note: "受け取った相談支援計画" });
    const documentId = reference.json().id;
    const pdfBytes = Buffer.from("%PDF-1.7\n% reference-material\n", "utf8");

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/reference-materials`,
      payload: {
        fileName: "相談支援計画.pdf",
        contentType: "application/pdf",
        dataBase64: pdfBytes.toString("base64"),
      },
    });
    assert.equal(uploaded.statusCode, 201);
    assert.equal(uploaded.json().fileName, "相談支援計画.pdf");
    assert.equal(uploaded.json().byteSize, pdfBytes.byteLength);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().attachments.length, 1);
    assert.equal(detail.json().attachments[0].contentType, "application/pdf");

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/reference-materials/${uploaded.json().id}/download`,
    });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.rawPayload, pdfBytes);
    assert.match(downloaded.headers["content-disposition"], /filename\*=UTF-8''/);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/reference-materials/${uploaded.json().id}`,
      headers: { "if-match": `"${uploaded.json().rowVersion}"` },
    });
    assert.equal(deleted.statusCode, 204);

    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}`,
    });
    assert.equal(afterDelete.json().attachments.length, 0);

    const removedReference = await app.inject({
      method: "DELETE",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/reference-material`,
      headers: { "if-match": reference.headers.etag },
    });
    assert.equal(removedReference.statusCode, 204);

    const removedDetail = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}`,
    });
    assert.equal(removedDetail.json().status, "void");
  } finally {
    await app.close();
    await db.close();
  }
});

test("同意・確定後の計画書本文と目標は上書きせず409を返す", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const plan = await createPlan(app, "individual_support_plan", { overallPolicy: "確定前" });
    assert.equal(plan.statusCode, 201);
    const goal = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/goals`,
      payload: { goalKind: "support", title: "確定する目標" },
    });
    assert.equal(goal.statusCode, 201);

    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    await approveDocumentFixture(db, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      documentId: plan.json().id,
    });
    await db.exec("commit");

    const current = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}`,
    });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().status, "approved");

    const overwrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}`,
      headers: { "if-match": current.headers.etag },
      payload: { payload: { privateMarker: "SECRET-FINALIZED-VALUE" } },
    });
    assert.equal(overwrite.statusCode, 409);
    assert.equal(overwrite.json().error.code, "IMMUTABLE_DOCUMENT");
    assert.equal(overwrite.body.includes("SECRET-FINALIZED-VALUE"), false);

    const goalOverwrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/goals/${goal.json().id}`,
      headers: { "if-match": goal.headers.etag },
      payload: { title: "確定後の変更" },
    });
    assert.equal(goalOverwrite.statusCode, 409);
    assert.equal(goalOverwrite.json().error.code, "IMMUTABLE_DOCUMENT");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("帳票入力は422、版番号欠落は428、権限不足は403でPIIを返さない", async () => {
  const adminApp = await buildApp({ config: testConfig(), pool: null });
  try {
    const invalid = await adminApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents`,
      payload: {
        documentKind: "same_plan_for_everything",
        templateVersion: "2026-01",
        periodStart: "2026-09-30",
        periodEnd: "2026-04-01",
        payload: { privateMarker: "SECRET-VALIDATION-VALUE" },
      },
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.includes("SECRET-VALIDATION-VALUE"), false);

    const noVersion = await adminApp.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${IDS.child}`,
      payload: { payload: { summary: "下書き" } },
    });
    assert.equal(noVersion.statusCode, 428);
    assert.equal(noVersion.json().error.code, "VERSION_REQUIRED");
  } finally {
    await adminApp.close();
  }

  const viewerApp = await buildApp({ config: testConfig("viewer"), pool: null });
  try {
    const forbidden = await viewerApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents`,
      payload: {
        documentKind: "consultation_plan",
        templateVersion: "2026-01",
        payload: { privateMarker: "SECRET-FORBIDDEN-VALUE" },
      },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");
    assert.equal(forbidden.body.includes("SECRET-FORBIDDEN-VALUE"), false);
  } finally {
    await viewerApp.close();
  }
});
