import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98e101",
  adminUser: "018f1db5-c170-7c35-a784-3cfc6f98e201",
  supportUser: "018f1db5-c170-7c35-a784-3cfc6f98e202",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98e301",
  adminMembership: "018f1db5-c170-7c35-a784-3cfc6f98e401",
  supportMembership: "018f1db5-c170-7c35-a784-3cfc6f98e402",
  child: "018f1db5-c170-7c35-a784-3cfc6f98e501",
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
  const support = role === "support_staff";
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
    auditHashKey: "document-workflow-test-audit-key",
    cognito: null,
    devActor: {
      userId: support ? IDS.supportUser : IDS.adminUser,
      tenantId: IDS.tenant,
      facilityIds: [IDS.facility],
      role,
      displayName: support ? "テスト支援員" : "テスト管理者",
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
      IDS.adminUser,
      "cognito-workflow-admin",
      "workflow-admin@example.invalid",
      "テスト管理者",
      IDS.adminMembership,
      IDS.facility,
      "F-001",
      "テスト事業所",
    ],
  );
  await db.query(
    `insert into public.app_users (id, cognito_sub, email, display_name, status)
     values ($1, 'cognito-workflow-support', 'workflow-support@example.invalid', 'テスト支援員', 'active')`,
    [IDS.supportUser],
  );
  await db.query(
    `insert into public.memberships (id, tenant_id, user_id, role, status, invited_at, joined_at)
     values ($1, $2, $3, 'support_staff', 'active', now(), now())`,
    [IDS.supportMembership, IDS.tenant, IDS.supportUser],
  );
  await db.query(
    "insert into public.membership_facilities (tenant_id, membership_id, facility_id) values ($1, $2, $3)",
    [IDS.tenant, IDS.supportMembership, IDS.facility],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values ($1, $2, $3, 'C-001', 'Aさん', 'テスト 利用児', $4, $4)`,
    [IDS.child, IDS.tenant, IDS.facility, IDS.adminUser],
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

async function createPlan(app, documentKind = "individual_support_plan") {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.child}/documents`,
    payload: {
      documentKind,
      templateVersion: "2026-01",
      periodStart: "2026-04-01",
      periodEnd: "2026-09-30",
      payload: { overallPolicy: "本人と家族の希望に沿った支援方針" },
    },
  });
  assert.equal(response.statusCode, 201);
  return response;
}

async function transition(app, documentId, etag, action, extra = {}) {
  let payload = { action, ...extra };
  if (action === "consent" && payload.consent && !payload.consent.sourceReview) {
    const intent = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/consent-intents`,
      headers: { "if-match": etag },
    });
    if (intent.statusCode !== 200) return intent;
    payload = {
      ...payload,
      consent: {
        ...payload.consent,
        sourceReview: {
          token: intent.json().token,
          expectedSourceHash: intent.json().sourceHash,
          targetVersionNumber: intent.json().targetVersionNumber,
          documentRowVersion: intent.json().documentRowVersion,
        },
      },
    };
  }
  return app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.child}/documents/${documentId}/transitions`,
    headers: { "if-match": etag },
    payload,
  });
}

test("提出から同意・承認・交付・有効化までを追記専用記録と同一トランザクションで進める", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const created = await createPlan(app);
    const documentId = created.json().id;

    const submitted = await transition(app, documentId, created.headers.etag, "submit");
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.json().status, "internal_review");
    assert.equal(submitted.headers.etag, '"2"');

    const explained = await transition(app, documentId, submitted.headers.etag, "explain");
    assert.equal(explained.statusCode, 200);
    assert.equal(explained.json().status, "explanation_pending");
    const consented = await transition(app, documentId, explained.headers.etag, "consent", {
      consent: {
        signerName: "保護者 太郎",
        signerRelationship: "父",
        explanationMethod: "in_person",
        explainedAt: "2026-04-10T09:00:00+09:00",
        consentedAt: "2026-04-10T09:30:00+09:00",
      },
    });
    assert.equal(consented.statusCode, 200, consented.body);
    assert.equal(consented.json().status, "consented");
    assert.equal(consented.headers.etag, '"4"');

    const approved = await transition(app, documentId, consented.headers.etag, "approve");
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, "approved");
    assert.equal(approved.json().approvedBy, IDS.adminUser);

    const distributed = await transition(app, documentId, approved.headers.etag, "distribute", {
      distribution: {
        recipientName: "保護者 太郎",
        deliveryMethod: "in_person",
        distributedAt: "2026-04-11T10:00:00+09:00",
      },
    });
    assert.equal(distributed.statusCode, 200);
    assert.equal(distributed.json().status, "distributed");

    const activated = await transition(app, documentId, distributed.headers.etag, "activate");
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().status, "active");
    assert.equal(activated.headers.etag, '"7"');

    const workflow = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/workflow`,
    });
    assert.equal(workflow.statusCode, 200);
    assert.equal(workflow.headers.etag, '"7"');
    assert.deepEqual(
      workflow.json().events.map((event) => event.eventType),
      ["submitted", "explained", "consented", "approved", "distributed", "activated"],
    );
    assert.equal(workflow.json().consents.length, 1);
    assert.equal(workflow.json().consents[0].targetVersionNumber, 1);
    assert.equal(workflow.json().consents[0].documentRowVersion, 4);
    assert.equal(workflow.json().consents[0].explainedBy, IDS.adminUser);
    assert.equal(workflow.json().distributions.length, 1);
    assert.equal(workflow.json().distributions[0].documentRowVersion, 6);
    assert.equal(workflow.json().distributions[0].distributedBy, IDS.adminUser);

    const closed = await transition(app, documentId, activated.headers.etag, "close", {
      reason: "支援期間満了のため",
    });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().status, "closed");

    await db.exec("reset role");
    await assert.rejects(
      () => db.query(
        "update public.document_consent_records set signer_relationship = '母' where document_id = $1",
        [documentId],
      ),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      () => db.query("delete from public.document_distribution_records where document_id = $1", [documentId]),
      (error) => error.code === "55000",
    );
    await db.exec("set role michinote_runtime");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("同意内容の確認後に別端末で利用児・保護者・予定表が変わった場合は同意を拒否する", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const created = await createPlan(app);
    const documentId = created.json().id;
    const submitted = await transition(app, documentId, created.headers.etag, "submit");
    const explained = await transition(app, documentId, submitted.headers.etag, "explain");
    const intent = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/consent-intents`,
      headers: { "if-match": explained.headers.etag },
    });
    assert.equal(intent.statusCode, 200);
    assert.match(intent.json().sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(intent.json().documentRowVersion, 3);
    assert.equal(intent.body.includes("テスト 利用児"), false);

    // Simulate changes committed by another device. Child/guardian/schedule
    // rows do not share the document ETag, so the aggregate hash must catch it.
    await db.exec("reset role");
    await db.query(
      "update public.children set legal_name = 'SECRET-CHANGED-CHILD' where id = $1",
      [IDS.child],
    );
    await db.query(
      `insert into public.guardians (id, tenant_id, child_id, legal_name, relationship, is_primary)
       values ('018f1db5-c170-7c35-a784-3cfc6f98e601', $1, $2, 'SECRET-NEW-GUARDIAN', '母', true)`,
      [IDS.tenant, IDS.child],
    );
    await db.query(
      `insert into public.schedule_versions (
         id, tenant_id, facility_id, child_id, schedule_kind, version_number,
         status, summary, created_by
       ) values (
         '018f1db5-c170-7c35-a784-3cfc6f98e701', $1, $2, $3, 'current', 1,
         'draft', 'SECRET-NEW-SCHEDULE', $4
       )`,
      [IDS.tenant, IDS.facility, IDS.child, IDS.adminUser],
    );
    await db.query(
      `insert into public.schedule_items (
         id, tenant_id, schedule_version_id, day_of_week, start_minute,
         end_minute, activity, sort_order
       ) values (
         '018f1db5-c170-7c35-a784-3cfc6f98e711', $1,
         '018f1db5-c170-7c35-a784-3cfc6f98e701', 1, 900, 960,
         'SECRET-NEW-ACTIVITY', 1
       )`,
      [IDS.tenant],
    );
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.adminUser],
    );
    await db.query(
      `update public.schedule_versions
       set status = 'finalized', finalized_at = now()
       where id = '018f1db5-c170-7c35-a784-3cfc6f98e701'`,
    );
    await db.exec("commit");
    await db.exec("set role michinote_runtime");

    const sourceReview = {
      token: intent.json().token,
      expectedSourceHash: intent.json().sourceHash,
      targetVersionNumber: intent.json().targetVersionNumber,
      documentRowVersion: intent.json().documentRowVersion,
    };
    const rejected = await transition(app, documentId, explained.headers.etag, "consent", {
      consent: {
        signerName: "SECRET-SIGNER",
        signerRelationship: "父",
        explanationMethod: "in_person",
        explainedAt: "2026-04-10T09:00:00+09:00",
        consentedAt: "2026-04-10T09:30:00+09:00",
        sourceReview,
      },
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, "CONSENT_SOURCE_CHANGED");
    for (const secret of [
      "SECRET-CHANGED-CHILD",
      "SECRET-NEW-GUARDIAN",
      "SECRET-NEW-SCHEDULE",
      "SECRET-NEW-ACTIVITY",
      "SECRET-SIGNER",
    ]) assert.equal(rejected.body.includes(secret), false);

    const workflow = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/workflow`,
    });
    assert.equal(workflow.json().document.status, "explanation_pending");
    assert.equal(workflow.json().consents.length, 0);
    const freshConsent = await transition(app, documentId, explained.headers.etag, "consent", {
      consent: {
        signerName: "確認済み保護者",
        signerRelationship: "母",
        explanationMethod: "in_person",
        explainedAt: "2026-04-10T09:00:00+09:00",
        consentedAt: "2026-04-10T09:30:00+09:00",
      },
    });
    assert.equal(freshConsent.statusCode, 200, freshConsent.body);
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("差戻し後に本文を変更した場合、旧版の同意記録を承認へ流用できない", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const created = await createPlan(app);
    const documentId = created.json().id;
    const submitted = await transition(app, documentId, created.headers.etag, "submit");
    const explained = await transition(app, documentId, submitted.headers.etag, "explain");
    const consented = await transition(app, documentId, explained.headers.etag, "consent", {
      consent: {
        signerName: "旧同意 保護者",
        signerRelationship: "母",
        explanationMethod: "online",
        explainedAt: "2026-04-10T09:00:00+09:00",
        consentedAt: "2026-04-10T09:30:00+09:00",
      },
    });
    assert.equal(consented.statusCode, 200, consented.body);

    const returnedToReview = await transition(app, documentId, consented.headers.etag, "return", {
      reason: "本人希望を追記するため",
    });
    assert.equal(returnedToReview.json().status, "internal_review");
    assert.equal(returnedToReview.json().consentedAt, null);
    const returnedToDraft = await transition(app, documentId, returnedToReview.headers.etag, "return", {
      reason: "本文を再編集するため",
    });
    assert.equal(returnedToDraft.json().status, "draft");

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}`,
      headers: { "if-match": returnedToDraft.headers.etag },
      payload: { payload: { overallPolicy: "本人希望を追記した新しい本文" } },
    });
    assert.equal(changed.statusCode, 200);
    const resubmitted = await transition(app, documentId, changed.headers.etag, "submit");
    const reexplained = await transition(app, documentId, resubmitted.headers.etag, "explain");

    // Simulate imported/legacy state that has a consent timestamp but no consent
    // record for this exact content row version. Modern writes cannot create
    // this state, so suspend only the deferred integrity trigger as an owner.
    await db.exec("reset role");
    await db.exec("alter table public.case_documents disable trigger case_documents_transition_integrity");
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.adminUser],
    );
    const legacyConsent = await db.query(
      `update public.case_documents
       set status = 'consented', consented_at = '2026-04-12T09:00:00+09:00', updated_by = $2
       where id = $1 returning row_version`,
      [documentId, IDS.adminUser],
    );
    await db.exec("commit");
    await db.exec("alter table public.case_documents enable trigger case_documents_transition_integrity");
    await db.exec("set role michinote_runtime");

    const approval = await transition(
      app,
      documentId,
      `"${legacyConsent.rows[0].row_version}"`,
      "approve",
    );
    assert.equal(approval.statusCode, 409);
    assert.equal(approval.json().error.code, "CONSENT_REQUIRED");
    assert.equal(approval.body.includes("旧同意 保護者"), false);

    const workflow = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/workflow`,
    });
    assert.equal(workflow.json().consents.length, 1);
    assert.equal(workflow.json().consents[0].documentRowVersion, 4);
    assert.notEqual(Number(legacyConsent.rows[0].row_version), 4);
    assert.equal(reexplained.statusCode, 200);
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("支援員は下書き提出だけ可能で、同意入力不備は422、競合はPIIを返さない", async () => {
  const db = await setupDatabase();
  const pool = pglitePool(db);
  const adminApp = await buildApp({ config: testConfig(), pool });
  const supportApp = await buildApp({ config: testConfig("support_staff"), pool });
  try {
    const created = await createPlan(adminApp);
    const documentId = created.json().id;
    const submitted = await transition(supportApp, documentId, created.headers.etag, "submit");
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.json().status, "internal_review");

    const forbidden = await transition(supportApp, documentId, submitted.headers.etag, "explain", {
      reason: "SECRET-SUPPORT-REASON",
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");
    assert.equal(forbidden.body.includes("SECRET-SUPPORT-REASON"), false);

    const explained = await transition(adminApp, documentId, submitted.headers.etag, "explain");
    assert.equal(explained.statusCode, 200);
    const forbiddenIntent = await supportApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/consent-intents`,
      headers: { "if-match": explained.headers.etag },
    });
    assert.equal(forbiddenIntent.statusCode, 403);
    assert.equal(forbiddenIntent.json().error.code, "FORBIDDEN");
    const missingReview = await adminApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/transitions`,
      headers: { "if-match": explained.headers.etag },
      payload: {
        action: "consent",
        consent: {
          signerName: "SECRET-MISSING-REVIEW-SIGNER",
          signerRelationship: "父",
          explanationMethod: "in_person",
          explainedAt: "2026-04-10T09:00:00+09:00",
          consentedAt: "2026-04-10T09:30:00+09:00",
        },
      },
    });
    assert.equal(missingReview.statusCode, 422);
    assert.equal(missingReview.json().error.code, "VALIDATION_ERROR");
    assert.equal(missingReview.body.includes("SECRET-MISSING-REVIEW-SIGNER"), false);
    const invalidConsent = await transition(adminApp, documentId, explained.headers.etag, "consent", {
      consent: {
        signerName: "SECRET-SIGNER-NAME",
        signerRelationship: "父",
        explanationMethod: "in_person",
        explainedAt: "2026-04-10T10:00:00+09:00",
        consentedAt: "2026-04-10T09:00:00+09:00",
      },
    });
    assert.equal(invalidConsent.statusCode, 422);
    assert.equal(invalidConsent.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalidConsent.body.includes("SECRET-SIGNER-NAME"), false);

    const stale = await transition(adminApp, documentId, '"1"', "consent", {
      consent: {
        signerName: "SECRET-STALE-SIGNER",
        signerRelationship: "父",
        explanationMethod: "in_person",
        explainedAt: "2026-04-10T09:00:00+09:00",
        consentedAt: "2026-04-10T09:30:00+09:00",
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "EDIT_CONFLICT");
    assert.equal(stale.body.includes("SECRET-STALE-SIGNER"), false);

    const workflow = await adminApp.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/workflow`,
    });
    assert.deepEqual(workflow.json().events.map((event) => event.eventType), ["submitted", "explained"]);
    assert.equal(workflow.json().consents.length, 0);
    assert.equal(workflow.json().events[0].eventType, "submitted");
    assert.equal(workflow.json().events[0].actorUserId, IDS.supportUser);
    assert.equal(workflow.json().events[0].actorRoleSnapshot, "support_staff");
  } finally {
    await supportApp.close();
    await adminApp.close();
    await db.exec("reset role");
    await db.close();
  }
});
