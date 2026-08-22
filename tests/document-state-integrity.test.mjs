import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";
import { advanceDocumentFixture } from "./helpers/document-workflow-fixture.mjs";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98f101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98f201",
  membership: "018f1db5-c170-7c35-a784-3cfc6f98f301",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98f401",
  child: "018f1db5-c170-7c35-a784-3cfc6f98f501",
  invalidDocument: "018f1db5-c170-7c35-a784-3cfc6f98f601",
  fakeConsentEvent: "018f1db5-c170-7c35-a784-3cfc6f98f701",
  fakeDistributionEvent: "018f1db5-c170-7c35-a784-3cfc6f98f702",
  fakeStandaloneEvent: "018f1db5-c170-7c35-a784-3cfc6f98f703",
  fakeApprovalEvent: "018f1db5-c170-7c35-a784-3cfc6f98f704",
};

const migrationsDirectory = new URL("../db/migrations/", import.meta.url);
const migrationSql = (
  await Promise.all(
    (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
      .sort()
      .map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
  )
).join("\n");
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function testConfig() {
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
    auditHashKey: "document-state-integrity-test-key",
    cognito: null,
    devActor: {
      userId: IDS.user,
      tenantId: IDS.tenant,
      facilityIds: [IDS.facility],
      role: "tenant_admin",
      displayName: "Integrity Test Admin",
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

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "Integrity Test Organization",
      IDS.user,
      "cognito-integrity-admin",
      "integrity-admin@example.invalid",
      "Integrity Test Admin",
      IDS.membership,
      IDS.facility,
      "INT-01",
      "Integrity Test Facility",
    ],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name,
      created_by, updated_by
    ) values ($1, $2, $3, 'INT-C001', 'Integrity Child', 'Integrity Child', $4, $4)`,
    [IDS.child, IDS.tenant, IDS.facility, IDS.user],
  );
  await db.exec("set role michinote_runtime");
  return db;
}

async function beginAsRuntime(db) {
  await db.exec("set role michinote_runtime");
  await db.exec("begin");
  await db.query(
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [IDS.tenant, IDS.user],
  );
}

async function rollbackQuietly(db) {
  try {
    await db.exec("rollback");
  } catch {
    // PostgreSQL may already have ended a transaction rejected at COMMIT.
  }
}

test("document state integrity rejects direct formal SQL and accepts the API transaction", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    await beginAsRuntime(db);
    await assert.rejects(
      () => db.query(
        `insert into public.case_documents (
          id, tenant_id, facility_id, child_id, document_kind, status,
          version_number, template_version, payload, created_by, updated_by,
          consented_at, approved_at, approved_by
        ) values (
          $1, $2, $3, $4, 'individual_support_plan', 'approved',
          1, '2026-01', '{}'::jsonb, $5, $5, now(), now(), $5
        )`,
        [IDS.invalidDocument, IDS.tenant, IDS.facility, IDS.child, IDS.user],
      ),
      (error) => error.code === "23514",
    );
    await rollbackQuietly(db);

    await beginAsRuntime(db);
    await assert.rejects(
      () => db.query(
        `insert into public.case_documents (
          id, tenant_id, facility_id, child_id, document_kind,
          version_number, template_version, payload, created_by, updated_by,
          consented_at
        ) values (
          $1, $2, $3, $4, 'individual_support_plan',
          1, '2026-01', '{}'::jsonb, $5, $5, now()
        )`,
        [IDS.invalidDocument, IDS.tenant, IDS.facility, IDS.child, IDS.user],
      ),
      (error) => error.code === "23514",
    );
    await rollbackQuietly(db);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents`,
      payload: {
        documentKind: "individual_support_plan",
        templateVersion: "2026-01",
        periodStart: "2026-04-01",
        periodEnd: "2026-09-30",
        payload: { overallPolicy: "Integrity test policy" },
      },
    });
    assert.equal(created.statusCode, 201);
    const documentId = created.json().id;

    await beginAsRuntime(db);
    await assert.rejects(
      () => db.query(
        "select app_private.append_document_event($1, $2, 'returned', null, $3::jsonb)",
        [
          IDS.fakeStandaloneEvent,
          documentId,
          JSON.stringify({
            action: "return",
            fromStatus: "internal_review",
            toStatus: "draft",
            documentVersionNumber: 1,
            documentRowVersion: 1,
          }),
        ],
      ),
      (error) => error.code === "55000",
    );
    await rollbackQuietly(db);

    await beginAsRuntime(db);
    await db.query(
      `update public.case_documents
       set status = 'internal_review', updated_by = $2
       where tenant_id = $3 and id = $1`,
      [documentId, IDS.user, IDS.tenant],
    );
    await assert.rejects(
      () => db.exec("commit"),
      (error) => error.code === "23514"
        && error.message.includes("exact row version"),
    );
    await rollbackQuietly(db);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/transitions`,
      headers: { "if-match": created.headers.etag },
      payload: { action: "submit" },
    });
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.json().status, "internal_review");

    const explained = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${documentId}/transitions`,
      headers: { "if-match": submitted.headers.etag },
      payload: { action: "explain" },
    });
    assert.equal(explained.statusCode, 200);
    assert.equal(explained.json().status, "explanation_pending");

    await db.exec("reset role");
    const storedEvents = await db.query(
      `select event_type, document_row_version, from_status, to_status
       from public.document_events
       where tenant_id = $1 and document_id = $2
       order by document_row_version`,
      [IDS.tenant, documentId],
    );
    assert.deepEqual(storedEvents.rows.map((row) => ({
      ...row,
      document_row_version: Number(row.document_row_version),
    })), [
      {
        event_type: "submitted",
        document_row_version: 2,
        from_status: "draft",
        to_status: "internal_review",
      },
      {
        event_type: "explained",
        document_row_version: 3,
        from_status: "internal_review",
        to_status: "explanation_pending",
      },
    ]);

    // Even a hand-written event with the right transition and row version is
    // insufficient for consent when its exact consent record/source is absent.
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    const directConsent = await db.query(
      `update public.case_documents
       set status = 'consented', consented_at = '2026-04-10T09:30:00+09:00', updated_by = $2
       where tenant_id = $3 and id = $1
       returning row_version, version_number`,
      [documentId, IDS.user, IDS.tenant],
    );
    const rowVersion = Number(directConsent.rows[0].row_version);
    const versionNumber = Number(directConsent.rows[0].version_number);
    await db.query(
      `insert into public.document_events (
        id, tenant_id, document_id, event_type, actor_user_id,
        actor_name_snapshot, actor_role_snapshot, metadata,
        document_row_version, from_status, to_status
      ) values (
        $1, $2, $3, 'consented', $4,
        'Integrity Test Admin', 'tenant_admin', $5::jsonb,
        $6, 'explanation_pending', 'consented'
      )`,
      [
        IDS.fakeConsentEvent,
        IDS.tenant,
        documentId,
        IDS.user,
        JSON.stringify({
          action: "consent",
          fromStatus: "explanation_pending",
          toStatus: "consented",
          documentVersionNumber: versionNumber,
          documentRowVersion: rowVersion,
        }),
        rowVersion,
      ],
    );
    await assert.rejects(
      () => db.exec("commit"),
      (error) => error.code === "23514"
        && error.message.includes("exact consent record"),
    );
    await rollbackQuietly(db);

    const unchanged = await db.query(
      "select status, row_version from public.case_documents where id = $1",
      [documentId],
    );
    assert.equal(unchanged.rows[0].status, "explanation_pending");
    assert.equal(Number(unchanged.rows[0].row_version), 3);

    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    await advanceDocumentFixture(db, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      documentId,
      action: "consent",
    });
    await db.exec("commit");

    // Approval metadata and a syntactically correct event are not enough: the
    // approval event itself must point to the immutable source just consented.
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    const directApproval = await db.query(
      `update public.case_documents
       set status = 'approved', approved_at = now(), approved_by = $2, updated_by = $2
       where tenant_id = $3 and id = $1
       returning row_version, version_number`,
      [documentId, IDS.user, IDS.tenant],
    );
    const approvedRowVersion = Number(directApproval.rows[0].row_version);
    const approvedVersionNumber = Number(directApproval.rows[0].version_number);
    await db.query(
      `insert into public.document_events (
        id, tenant_id, document_id, event_type, actor_user_id,
        actor_name_snapshot, actor_role_snapshot, metadata,
        document_row_version, from_status, to_status
      ) values (
        $1, $2, $3, 'approved', $4,
        'Integrity Test Admin', 'tenant_admin', $5::jsonb,
        $6, 'consented', 'approved'
      )`,
      [
        IDS.fakeApprovalEvent,
        IDS.tenant,
        documentId,
        IDS.user,
        JSON.stringify({
          action: "approve",
          fromStatus: "consented",
          toStatus: "approved",
          documentVersionNumber: approvedVersionNumber,
          documentRowVersion: approvedRowVersion,
        }),
        approvedRowVersion,
      ],
    );
    await assert.rejects(
      () => db.exec("commit"),
      (error) => error.code === "23514"
        && error.message.includes("immutable consent source"),
    );
    await rollbackQuietly(db);

    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    await advanceDocumentFixture(db, {
      tenantId: IDS.tenant,
      userId: IDS.user,
      documentId,
      action: "approve",
    });
    await db.exec("commit");

    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    const directDistribution = await db.query(
      `update public.case_documents
       set status = 'distributed', distributed_at = now(), updated_by = $2
       where tenant_id = $3 and id = $1
       returning row_version, version_number`,
      [documentId, IDS.user, IDS.tenant],
    );
    const distributedRowVersion = Number(directDistribution.rows[0].row_version);
    const distributedVersionNumber = Number(directDistribution.rows[0].version_number);
    await db.query(
      `insert into public.document_events (
        id, tenant_id, document_id, event_type, actor_user_id,
        actor_name_snapshot, actor_role_snapshot, metadata,
        document_row_version, from_status, to_status
      ) values (
        $1, $2, $3, 'distributed', $4,
        'Integrity Test Admin', 'tenant_admin', $5::jsonb,
        $6, 'approved', 'distributed'
      )`,
      [
        IDS.fakeDistributionEvent,
        IDS.tenant,
        documentId,
        IDS.user,
        JSON.stringify({
          action: "distribute",
          fromStatus: "approved",
          toStatus: "distributed",
          documentVersionNumber: distributedVersionNumber,
          documentRowVersion: distributedRowVersion,
        }),
        distributedRowVersion,
      ],
    );
    await assert.rejects(
      () => db.exec("commit"),
      (error) => error.code === "23514"
        && error.message.includes("exact distribution record"),
    );
    await rollbackQuietly(db);

    const stillApproved = await db.query(
      "select status from public.case_documents where id = $1",
      [documentId],
    );
    assert.equal(stillApproved.rows[0].status, "approved");
  } finally {
    await app.close();
    await rollbackQuietly(db);
    await db.exec("reset role");
    await db.close();
  }
});
