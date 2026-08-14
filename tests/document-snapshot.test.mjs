import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";
import { withTenantTransaction } from "../server/db/tenant-transaction.js";
import { createS3DocumentStorage } from "../server/pdf/storage.js";
import { createBoundedPdfRenderer } from "../server/pdf/renderer.js";
import { renderDocumentTemplate } from "../server/pdf/templates/index.js";
import { prepareDocumentSnapshot } from "../server/repositories/document-snapshots.js";
import { signPdfUpload } from "../server/security/pdf-finalization.js";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98a101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98a201",
  auditorUser: "018f1db5-c170-7c35-a784-3cfc6f98a202",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98a301",
  membership: "018f1db5-c170-7c35-a784-3cfc6f98a401",
  auditorMembership: "018f1db5-c170-7c35-a784-3cfc6f98a402",
  child: "018f1db5-c170-7c35-a784-3cfc6f98a501",
  finalizedSchedule: "018f1db5-c170-7c35-a784-3cfc6f98a701",
  draftSchedule: "018f1db5-c170-7c35-a784-3cfc6f98a702",
  laterSchedule: "018f1db5-c170-7c35-a784-3cfc6f98a703",
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
    auditHashKey: "document-snapshot-test-audit-key",
    pdfFinalizationSecret: "b".repeat(64),
    awsRegion: "ap-northeast-3",
    documentBucket: undefined,
    documentKmsKeyArn: undefined,
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
    "select app_private.configure_document_snapshot_finalization($1)",
    ["b".repeat(64)],
  );
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "テスト法人",
      IDS.user,
      "cognito-pdf-admin",
      "pdf-admin@example.invalid",
      "テスト管理者",
      IDS.membership,
      IDS.facility,
      "F-001",
      "テスト事業所",
    ],
  );
  await db.query(
    `insert into public.app_users (id, cognito_sub, email, display_name, status)
     values ($1, 'cognito-pdf-auditor', 'pdf-auditor@example.invalid', 'テスト監査者', 'active')`,
    [IDS.auditorUser],
  );
  await db.query(
    `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
     values ($1, $2, $3, 'auditor', 'active', now())`,
    [IDS.auditorMembership, IDS.tenant, IDS.auditorUser],
  );
  await db.query(
    `insert into public.membership_facilities (tenant_id, membership_id, facility_id)
     values ($1, $2, $3)`,
    [IDS.tenant, IDS.auditorMembership, IDS.facility],
  );
  await db.query(
    `insert into public.children (
       id, tenant_id, facility_id, management_code, display_name, legal_name,
       birth_date, grade, created_by, updated_by
     ) values ($1, $2, $3, 'C-001', 'Aさん', 'テスト利用児', '2018-05-01', '小学2年', $4, $4)`,
    [IDS.child, IDS.tenant, IDS.facility, IDS.user],
  );
  await db.query(
    `insert into public.guardians (id, tenant_id, child_id, legal_name, relationship, is_primary)
     values ('018f1db5-c170-7c35-a784-3cfc6f98a601', $1, $2, 'テスト保護者', '母', true)`,
    [IDS.tenant, IDS.child],
  );
  await db.query(
    `insert into public.schedule_versions (
       id, tenant_id, facility_id, child_id, schedule_kind, version_number,
       status, summary, created_by, finalized_at
     ) values
       ($1, $3, $4, $5, 'current', 1, 'draft', '同意時の確定スケジュール', $6, null),
       ($2, $3, $4, $5, 'current', 2, 'draft', '未確定の新しいスケジュール', $6, null)`,
    [IDS.finalizedSchedule, IDS.draftSchedule, IDS.tenant, IDS.facility, IDS.child, IDS.user],
  );
  await db.query(
    `insert into public.schedule_items (
       id, tenant_id, schedule_version_id, day_of_week, start_minute,
       end_minute, activity, sort_order
     ) values
       ('018f1db5-c170-7c35-a784-3cfc6f98a711', $1, $2, 1, 900, 960, '同意時の確定活動', 1),
       ('018f1db5-c170-7c35-a784-3cfc6f98a712', $1, $3, 1, 960, 1020, '未確定の活動', 1)`,
    [IDS.tenant, IDS.finalizedSchedule, IDS.draftSchedule],
  );
  await db.exec("begin");
  await db.query(
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [IDS.tenant, IDS.user],
  );
  await db.query(
    "update public.schedule_versions set status = 'finalized', finalized_at = now() where id = $1",
    [IDS.finalizedSchedule],
  );
  await db.exec("commit");
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

async function assertRuntimeMutationDenied(db, sql, parameters = []) {
  await db.exec("set role michinote_runtime");
  await db.exec("begin");
  await db.query(
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [IDS.tenant, IDS.user],
  );
  await assert.rejects(() => db.query(sql, parameters), (error) => error.code === "42501");
  await db.exec("rollback");
  await db.exec("reset role");
}

function interceptingPool(db, intercept) {
  return {
    async connect() {
      return {
        query(sql, parameters) {
          const intercepted = intercept(sql, parameters);
          return intercepted === undefined ? db.query(sql, parameters) : intercepted;
        },
        release() {},
      };
    },
    query(sql, parameters) {
      const intercepted = intercept(sql, parameters);
      return intercepted === undefined ? db.query(sql, parameters) : intercepted;
    },
  };
}

function fakePdfInfrastructure() {
  const objects = new Map();
  const objectMetadata = new Map();
  const renderCalls = [];
  let putCount = 0;
  return {
    objects,
    renderCalls,
    get putCount() { return putCount; },
    pdfRenderer: {
      async render(input) {
        renderCalls.push(input);
        return Buffer.from(`%PDF-1.7\n${input.orientation}\n%%EOF`, "utf8");
      },
    },
    documentStorage: {
      async putPdf({ key, body, sha256, jobId }) {
        if (objects.has(key)) {
          const error = new Error("fake object already exists");
          error.code = "DOCUMENT_OBJECT_EXISTS";
          throw error;
        }
        putCount += 1;
        objects.set(key, Buffer.from(body));
        const metadata = { versionId: `fake-version-${putCount}`, sha256, jobId };
        objectMetadata.set(key, metadata);
        return { versionId: metadata.versionId, sha256, byteSize: body.length };
      },
      async getPdf({ key }) {
        const body = objects.get(key);
        if (!body) throw new Error("missing fake object");
        return Buffer.from(body);
      },
      async inspectPdf({ key, expectedJobId }) {
        const body = objects.get(key);
        const metadata = objectMetadata.get(key);
        if (!body) return null;
        if (!metadata || metadata.jobId !== expectedJobId) {
          const error = new Error("fake object metadata mismatch");
          error.code = "DOCUMENT_STORAGE_INTEGRITY_ERROR";
          throw error;
        }
        return {
          versionId: metadata.versionId,
          sha256: createHash("sha256").update(body).digest("hex"),
          byteSize: body.length,
        };
      },
      async inspectLegacyPdf({ key, expectedSha256, expectedByteSize }) {
        const body = objects.get(key);
        const metadata = objectMetadata.get(key);
        if (!body) return null;
        const digest = createHash("sha256").update(body).digest("hex");
        if (digest !== expectedSha256 || body.length !== expectedByteSize) {
          const error = new Error("legacy fake object integrity mismatch");
          error.code = "DOCUMENT_STORAGE_INTEGRITY_ERROR";
          throw error;
        }
        return {
          versionId: metadata.versionId,
          sha256: digest,
          byteSize: body.length,
          body: Buffer.from(body),
        };
      },
    },
  };
}

test("PDF renderer bounds active work and returns a retryable 503 when its queue is full", async () => {
  const releases = [];
  const renderer = createBoundedPdfRenderer({
    render() {
      return new Promise((resolve) => releases.push(() => resolve(Buffer.from("%PDF-1.7\n%%EOF"))));
    },
  }, { maxConcurrent: 1, maxQueue: 1, retryAfterSeconds: 7 });
  const first = renderer.render({});
  const second = renderer.render({});
  await assert.rejects(
    () => renderer.render({}),
    (error) => error.statusCode === 503
      && error.code === "PDF_RENDER_CAPACITY_EXCEEDED"
      && error.details.retryAfterSeconds === 7,
  );
  assert.deepEqual(renderer.stats(), { active: 1, queued: 1, maxConcurrent: 1, maxQueue: 1 });
  releases.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await second;
  assert.equal(renderer.stats().active, 0);
});

async function createPlan(app, documentKind = "individual_support_plan") {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.child}/documents`,
    payload: {
      documentKind,
      templateVersion: "2026-01",
      periodStart: "2026-04-01",
      periodEnd: "2026-09-30",
      payload: {
        userAndFamilyWishes: "好きな活動を通じて自信を育てたい",
        overallSupportPolicy: "<script>not executable</script> 本人の選択を大切にする",
      },
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

test("帳票種別ごとにA4向き・版・利用児識別・下書き透かしを表示する", () => {
  const source = {
    document: {
      id: IDS.child,
      document_kind: "individual_support_plan",
      status: "draft",
      version_number: 2,
      template_version: "2026-01",
      period_start: "2026-04-01",
      period_end: "2026-09-30",
      payload: { overallSupportPolicy: "<script>alert('x')</script>の実行を防ぐ" },
      row_version: 4,
    },
    child: { id: IDS.child, management_code: "C-001", legal_name: "山田 花子", birth_date: "2018-05-01", grade: "小学2年" },
    guardian: { legal_name: "山田 太郎", relationship: "父" },
    organization: { name: "テスト法人" },
    facility: { name: "テスト事業所" },
    goals: [],
    monitoringResults: [],
    schedules: [],
  };
  const expected = {
    basic_assessment: ["portrait", "アセスメントシート"],
    consultation_plan: ["landscape", "サービス等利用計画"],
    individual_support_plan: ["landscape", "個別支援計画書"],
    monitoring_record: ["portrait", "モニタリング記録"],
  };

  for (const [documentKind, [orientation, title]] of Object.entries(expected)) {
    source.document.document_kind = documentKind;
    const rendered = renderDocumentTemplate(source, "draft");
    assert.equal(rendered.orientation, orientation);
    assert.match(rendered.html, new RegExp(`data-orientation="${orientation}"`));
    assert.equal(rendered.html.includes(title), true);
    assert.equal(rendered.html.includes("山田 花子（C-001）"), true);
    assert.equal(rendered.html.includes("第2版"), true);
    assert.equal(rendered.html.includes("下書き・正式帳票ではありません"), true);
    assert.equal(rendered.html.includes("<script>alert"), false);
  }

  source.document.document_kind = "individual_support_plan";
  assert.equal(renderDocumentTemplate(source, "draft").html.includes("&lt;script&gt;alert"), true);

  source.document.status = "approved";
  const official = renderDocumentTemplate(source, "official");
  assert.equal(official.html.includes("下書き・正式帳票ではありません"), false);
  assert.equal(official.html.includes("正式版"), true);
});

test("S3アダプターはSSE-KMS・チェックサム・上書き防止を必須にする", async () => {
  const sent = [];
  const body = Buffer.from("%PDF-1.7\n%%EOF", "utf8");
  const digest = "a".repeat(64);
  const storage = createS3DocumentStorage({
    bucket: "private-document-bucket",
    kmsKeyArn: "arn:aws:kms:ap-northeast-3:111122223333:key/test",
    region: "ap-northeast-3",
    client: {
      async send(command) {
        sent.push(command);
        if (command.constructor.name === "GetObjectCommand") return { ContentType: "application/pdf", Body: body };
        return { VersionId: "s3-version-001" };
      },
    },
  });
  const key = `tenants/${IDS.tenant}/documents/${IDS.child}/018f1db5-c170-7c35-a784-3cfc6f98a701.pdf`;
  const stored = await storage.putPdf({
    key,
    body,
    sha256: digest,
    jobId: "018f1db5-c170-7c35-a784-3cfc6f98a701",
  });
  assert.equal(stored.versionId, "s3-version-001");
  const put = sent[0].input;
  assert.equal(put.Bucket, "private-document-bucket");
  assert.equal(put.Key, key);
  assert.equal(put.ServerSideEncryption, "aws:kms");
  assert.equal(put.SSEKMSKeyId.includes("arn:aws:kms"), true);
  assert.equal(put.IfNoneMatch, "*");
  assert.equal(put.ChecksumSHA256, Buffer.from(digest, "hex").toString("base64"));
  assert.deepEqual(await storage.getPdf({ key, versionId: "s3-version-001" }), body);
  assert.equal(sent[1].input.VersionId, "s3-version-001");
});

test("下書きPDFを不変スナップショットとして作成・再利用・検証ダウンロードできる", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const url = `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`;
    const generated = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag, "idempotency-key": "pdf-draft-create-0001" },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(generated.statusCode, 201);
    assert.equal(generated.json().snapshotKind, "draft");
    assert.equal(generated.json().sourceStatus, "draft");
    assert.equal(generated.json().documentRowVersion, 1);
    assert.equal(generated.json().reused, false);
    assert.equal(Object.hasOwn(generated.json(), "storageKey"), false);
    assert.equal(fake.putCount, 1);
    assert.equal(fake.renderCalls[0].orientation, "landscape");
    assert.equal(fake.renderCalls[0].html.includes("テスト利用児"), true);

    const replay = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag, "idempotency-key": "pdf-draft-create-0001" },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.equal(replay.json().id, generated.json().id);
    assert.equal(replay.json().reused, false);
    assert.equal(fake.putCount, 1);
    assert.equal(fake.renderCalls.length, 1);

    const reusedExisting = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(reusedExisting.statusCode, 201);
    assert.equal(reusedExisting.json().id, generated.json().id);
    assert.equal(reusedExisting.json().reused, true);
    assert.equal(fake.putCount, 1);

    const keyReuseWithOtherVersion = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": '"2"', "idempotency-key": "pdf-draft-create-0001" },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(keyReuseWithOtherVersion.statusCode, 409);
    assert.equal(keyReuseWithOtherVersion.json().error.code, "IDEMPOTENCY_KEY_REUSED");

    const listed = await app.inject({ method: "GET", url });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().items.map((item) => item.id), [generated.json().id]);
    assert.equal(Object.hasOwn(listed.json().items[0], "storageKey"), false);

    const content = await app.inject({
      method: "GET",
      url: `${url}/${generated.json().id}/content`,
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.headers["content-type"], "application/pdf");
    assert.equal(content.headers["cache-control"], "private, no-store");
    assert.equal(Buffer.from(content.rawPayload).subarray(0, 5).toString(), "%PDF-");

    await db.exec("reset role");
    const persisted = await db.query(
      "select storage_key, sha256, byte_size, document_row_version, source_status from public.document_snapshots where id = $1",
      [generated.json().id],
    );
    assert.match(
      persisted.rows[0].storage_key,
      new RegExp(`^tenants/${IDS.tenant}/documents/${plan.json().id}/${generated.json().id}\\.pdf$`),
    );
    assert.match(persisted.rows[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(Number(persisted.rows[0].byte_size) > 0, true);
    assert.equal(Number(persisted.rows[0].document_row_version), 1);
    assert.equal(persisted.rows[0].source_status, "draft");
    const audit = await db.query(
      "select action from public.audit_events where resource_id = $1 order by occurred_at, id",
      [generated.json().id],
    );
    assert.deepEqual(audit.rows.map((row) => row.action), [
      "document_snapshot.generated",
      "document_snapshot.reused",
      "document_snapshot.downloaded",
    ]);
    await assert.rejects(
      () => db.query("delete from public.document_snapshots where id = $1", [generated.json().id]),
      (error) => error.code === "55000",
    );
    await assertRuntimeMutationDenied(
      db,
      "update public.document_snapshot_jobs set status = 'completed', completed_at = now() where id = $1",
      [generated.json().id],
    );
    await assertRuntimeMutationDenied(
      db,
      "update public.document_snapshot_jobs set lease_token = $2 where id = $1",
      [generated.json().id, "018f1db5-c170-7c35-a784-3cfc6f98afff"],
    );
    await assertRuntimeMutationDenied(
      db,
      "update public.document_snapshot_jobs set storage_version_id = 'forged-version' where id = $1",
      [generated.json().id],
    );
    await assertRuntimeMutationDenied(
      db,
      "insert into public.document_snapshot_jobs (id) values ($1)",
      ["018f1db5-c170-7c35-a784-3cfc6f98aff1"],
    );
    await assertRuntimeMutationDenied(
      db,
      "insert into public.document_snapshots (id) values ($1)",
      ["018f1db5-c170-7c35-a784-3cfc6f98aff2"],
    );
    await assertRuntimeMutationDenied(
      db,
      "select * from app_private.claim_stale_document_snapshot_jobs($1, 10)",
      ["018f1db5-c170-7c35-a784-3cfc6f98aff4"],
    );
    await db.exec("set role michinote_runtime");
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      ["018f1db5-c170-7c35-a784-3cfc6f98aff3", IDS.user],
    );
    const crossTenantJobs = await db.query("select count(*)::int as count from public.document_snapshot_jobs");
    assert.equal(crossTenantJobs.rows[0].count, 0);
    await db.exec("rollback");
    await db.exec("reset role");
    await db.exec("set role michinote_runtime");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("正式版は承認後のみ作成し、同じ元版への再要求は一つの不変スナップショットを返す", async () => {
  const db = await setupDatabase();
  await db.exec("reset role");
  await db.query(
    `update public.children
     set recipient_certificate_ciphertext = $2,
         recipient_certificate_last4 = '7890',
         municipality_name = '神戸市',
         copayment_limit_yen = 12345,
         certificate_valid_from = '2026-04-01',
         certificate_valid_to = '2027-03-31'
     where id = $1`,
    [IDS.child, Buffer.from("encrypted-recipient-certificate")],
  );
  await db.exec("set role michinote_runtime");
  const fake = fakePdfInfrastructure();
  const decryptCalls = [];
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
    fieldEncryption: {
      async decrypt(input) {
        decryptCalls.push(input);
        return "1234567890";
      },
    },
  });
  try {
    const child = await app.inject({ method: "GET", url: `/api/v1/children/${IDS.child}` });
    assert.equal(child.statusCode, 200);
    assert.equal(child.body.includes("1234567890"), false);
    assert.equal(child.json().recipientCertificateMasked.endsWith("7890"), true);

    const plan = await createPlan(app, "consultation_plan");
    const url = `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`;
    const tooEarly = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "official" },
    });
    assert.equal(tooEarly.statusCode, 409);
    assert.equal(tooEarly.json().error.code, "OFFICIAL_PDF_NOT_AVAILABLE");
    assert.equal(fake.putCount, 0);

    const goal = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/goals`,
      payload: { goalKind: "support", title: "同意時の支援目標", supportDetails: "同意時の支援内容" },
    });
    assert.equal(goal.statusCode, 201);
    const staleAggregate = await transition(app, plan.json().id, plan.headers.etag, "submit");
    assert.equal(staleAggregate.statusCode, 409);
    assert.equal(staleAggregate.json().error.code, "EDIT_CONFLICT");
    assert.equal(staleAggregate.json().error.details.currentVersion, 2);
    const currentPlan = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}`,
    });
    assert.equal(currentPlan.headers.etag, '"2"');

    const submitted = await transition(app, plan.json().id, currentPlan.headers.etag, "submit");
    const explained = await transition(app, plan.json().id, submitted.headers.etag, "explain");
    const consented = await transition(app, plan.json().id, explained.headers.etag, "consent", {
      consent: {
        signerName: "テスト保護者",
        signerRelationship: "母",
        explanationMethod: "in_person",
        explainedAt: "2026-08-01T09:00:00+09:00",
        consentedAt: "2026-08-01T09:30:00+09:00",
      },
    });
    assert.equal(consented.statusCode, 200);

    const rejectedGoalChange = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/goals/${goal.json().id}`,
      headers: { "if-match": goal.headers.etag },
      payload: { title: "同意後に変更しようとした目標" },
    });
    assert.equal(rejectedGoalChange.statusCode, 409);
    assert.equal(rejectedGoalChange.json().error.code, "IMMUTABLE_DOCUMENT");

    await db.exec("reset role");
    const captured = await db.query(
      `select source_json, source_sha256, recipient_certificate_ciphertext,
              encode(sha256(convert_to(source_json::text, 'UTF8')), 'hex') as computed_source_sha256
       from public.document_consent_sources
       where document_id = $1`,
      [plan.json().id],
    );
    assert.equal(captured.rows.length, 1);
    assert.equal(captured.rows[0].computed_source_sha256, captured.rows[0].source_sha256);
    const capturedJson = JSON.stringify(captured.rows[0].source_json);
    assert.equal(capturedJson.includes("recipient_certificate_ciphertext"), false);
    assert.equal(capturedJson.includes("recipient_certificate_number"), false);
    assert.equal(Buffer.from(captured.rows[0].recipient_certificate_ciphertext).toString(), "encrypted-recipient-certificate");
    await db.exec("set role michinote_runtime");

    const approved = await transition(app, plan.json().id, consented.headers.etag, "approve");
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, "approved");

    // Mutable master data and even an out-of-band owner repair after consent
    // must not alter the exact content that was consented to.
    await db.exec("reset role");
    await db.query(
      `update public.children
       set legal_name = '変更後の利用児', municipality_name = '変更後市',
           recipient_certificate_ciphertext = $2, recipient_certificate_last4 = '9999'
       where id = $1`,
      [IDS.child, Buffer.from("changed-certificate-ciphertext")],
    );
    await db.query(
      "update public.guardians set legal_name = '変更後の保護者' where child_id = $1",
      [IDS.child],
    );
    await db.query("update public.organizations set name = '変更後法人' where id = $1", [IDS.tenant]);
    await db.query("update public.facilities set name = '変更後事業所' where id = $1", [IDS.facility]);
    await db.query("update public.app_users set display_name = '変更後承認者' where id = $1", [IDS.user]);
    await db.query(
      `insert into public.schedule_versions (
         id, tenant_id, facility_id, child_id, schedule_kind, version_number,
         status, summary, created_by, finalized_at
       ) values ($1, $2, $3, $4, 'current', 3, 'draft', '同意後の確定スケジュール', $5, null)`,
      [IDS.laterSchedule, IDS.tenant, IDS.facility, IDS.child, IDS.user],
    );
    await db.query(
      `insert into public.schedule_items (
         id, tenant_id, schedule_version_id, day_of_week, start_minute,
         end_minute, activity, sort_order
       ) values ('018f1db5-c170-7c35-a784-3cfc6f98a713', $1, $2, 1, 1020, 1080, '同意後の活動', 1)`,
      [IDS.tenant, IDS.laterSchedule],
    );
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    await db.query(
      "update public.schedule_versions set status = 'finalized', finalized_at = now() where id = $1",
      [IDS.laterSchedule],
    );
    await db.exec("commit");
    await db.exec("alter table public.document_goals disable trigger document_goals_lock_parent_and_bump");
    await db.exec("alter table public.document_goals disable trigger document_goals_prevent_finalized_change");
    await db.query("update public.document_goals set title = '所有者修復後の目標' where id = $1", [goal.json().id]);
    await db.exec("alter table public.document_goals enable trigger document_goals_prevent_finalized_change");
    await db.exec("alter table public.document_goals enable trigger document_goals_lock_parent_and_bump");
    await db.exec("set role michinote_runtime");

    const official = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": approved.headers.etag },
      payload: { snapshotKind: "official" },
    });
    assert.equal(official.statusCode, 201);
    assert.equal(official.json().sourceStatus, "approved");
    assert.equal(official.json().snapshotKind, "official");
    assert.equal(fake.renderCalls.at(-1).html.includes("下書き・正式帳票ではありません"), false);
    assert.equal(fake.renderCalls.at(-1).html.includes("1234567890"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("神戸市"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("12,345円"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("テスト利用児"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("テスト保護者"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("テスト法人"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("テスト事業所"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("テスト管理者"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("同意時の支援目標"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("同意時の確定活動"), true);
    assert.equal(fake.renderCalls.at(-1).html.includes("未確定の活動"), false);
    assert.equal(fake.renderCalls.at(-1).html.includes("変更後"), false);
    assert.equal(fake.renderCalls.at(-1).html.includes("所有者修復後の目標"), false);
    assert.equal(official.body.includes("1234567890"), false);
    assert.equal(decryptCalls.length, 1);
    assert.equal(decryptCalls[0].tenantId, IDS.tenant);
    assert.equal(decryptCalls[0].fieldName, "recipient_certificate_number");
    assert.equal(Buffer.from(decryptCalls[0].ciphertext).toString(), "encrypted-recipient-certificate");

    const reused = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": approved.headers.etag },
      payload: { snapshotKind: "official" },
    });
    assert.equal(reused.statusCode, 201);
    assert.equal(reused.json().id, official.json().id);
    assert.equal(fake.putCount, 1);
    assert.equal(decryptCalls.length, 1);

    const stale = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": '"1"' },
      payload: { snapshotKind: "official" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "EDIT_CONFLICT");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("同意時ソースのハッシュ不一致は正式PDFを保存せず503で拒否する", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const submitted = await transition(app, plan.json().id, plan.headers.etag, "submit");
    const explained = await transition(app, plan.json().id, submitted.headers.etag, "explain");
    const consented = await transition(app, plan.json().id, explained.headers.etag, "consent", {
      consent: {
        signerName: "テスト保護者",
        signerRelationship: "母",
        explanationMethod: "in_person",
        explainedAt: "2026-08-01T09:00:00+09:00",
        consentedAt: "2026-08-01T09:30:00+09:00",
      },
    });
    const approved = await transition(app, plan.json().id, consented.headers.etag, "approve");
    assert.equal(approved.statusCode, 200);

    await db.exec("reset role");
    await db.exec("alter table public.document_events disable trigger document_events_append_only");
    await db.query(
      "update public.document_events set consent_record_id = null where document_id = $1",
      [plan.json().id],
    );
    await db.exec("alter table public.document_events enable trigger document_events_append_only");
    await db.exec("alter table public.document_consent_sources disable trigger document_consent_sources_append_only");
    await db.query(
      "update public.document_consent_sources set source_sha256 = $2 where document_id = $1",
      [plan.json().id, "0".repeat(64)],
    );
    await db.exec("alter table public.document_consent_sources enable trigger document_consent_sources_append_only");
    await db.exec("set role michinote_runtime");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": approved.headers.etag },
      payload: { snapshotKind: "official" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "CONSENT_SOURCE_INTEGRITY_ERROR");
    assert.equal(fake.renderCalls.length, 0);
    assert.equal(fake.putCount, 0);

    await db.exec("reset role");
    await db.exec("alter table public.document_consent_sources disable trigger document_consent_sources_append_only");
    await db.query("delete from public.document_consent_sources where document_id = $1", [plan.json().id]);
    await db.exec("alter table public.document_consent_sources enable trigger document_consent_sources_append_only");
    await db.exec("set role michinote_runtime");
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": approved.headers.etag },
      payload: { snapshotKind: "official" },
    });
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().error.code, "CONSENT_SOURCE_REQUIRED");
    assert.equal(fake.renderCalls.length, 0);
    assert.equal(fake.putCount, 0);
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("正式PDFソースは管理者と監査者で同一の不変承認者情報を返す", async () => {
  const db = await setupDatabase();
  const pool = pglitePool(db);
  const app = await buildApp({
    config: testConfig(),
    pool,
    pdfRenderer: fakePdfInfrastructure().pdfRenderer,
    documentStorage: fakePdfInfrastructure().documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const submitted = await transition(app, plan.json().id, plan.headers.etag, "submit");
    const explained = await transition(app, plan.json().id, submitted.headers.etag, "explain");
    const consented = await transition(app, plan.json().id, explained.headers.etag, "consent", {
      consent: {
        signerName: "テスト保護者",
        signerRelationship: "母",
        explanationMethod: "in_person",
        explainedAt: "2026-08-01T09:00:00+09:00",
        consentedAt: "2026-08-01T09:30:00+09:00",
      },
    });
    const approved = await transition(app, plan.json().id, consented.headers.etag, "approve");
    const expectedVersion = approved.json().rowVersion;
    const adminActor = { tenantId: IDS.tenant, userId: IDS.user };
    const auditorActor = { tenantId: IDS.tenant, userId: IDS.auditorUser };

    const adminPrepared = await withTenantTransaction(pool, adminActor, (client) =>
      prepareDocumentSnapshot(client, adminActor, IDS.child, plan.json().id, expectedVersion, "official"));
    const auditorPrepared = await withTenantTransaction(pool, auditorActor, (client) =>
      prepareDocumentSnapshot(client, auditorActor, IDS.child, plan.json().id, expectedVersion, "official"));
    const adminHtml = renderDocumentTemplate(adminPrepared.source, "official").html;
    const auditorHtml = renderDocumentTemplate(auditorPrepared.source, "official").html;

    assert.equal(auditorHtml, adminHtml);
    assert.equal(adminHtml.includes("テスト管理者"), true);
    assert.equal(adminHtml.includes("テスト監査者"), false);
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("改ざんされたS3オブジェクトとPDF出力権限のない利用を拒否する", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  const adminApp = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  const viewerApp = await buildApp({
    config: testConfig("viewer"),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(adminApp);
    const url = `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`;
    const forbidden = await viewerApp.inject({ method: "GET", url });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");

    const generated = await adminApp.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    });
    const key = [...fake.objects.keys()][0];
    fake.objects.set(key, Buffer.from("%PDF-1.7\ntampered\n%%EOF", "utf8"));
    const content = await adminApp.inject({
      method: "GET",
      url: `${url}/${generated.json().id}/content`,
    });
    assert.equal(content.statusCode, 503);
    assert.equal(content.json().error.code, "DOCUMENT_STORAGE_INTEGRITY_ERROR");
    assert.equal(content.body.includes(key), false);
    assert.equal(content.body.includes(generated.json().sha256), false);
  } finally {
    await viewerApp.close();
    await adminApp.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("S3 upload後のDB確定クラッシュをジョブ再照合で復旧し、同一物を再保存しない", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  let failFinalizeOnce = true;
  const pool = interceptingPool(db, (sql) => {
    if (failFinalizeOnce && /app_private\.finalize_document_snapshot_job/i.test(sql)) {
      failFinalizeOnce = false;
      const error = new Error("injected finalize crash");
      error.code = "08006";
      return Promise.reject(error);
    }
    return undefined;
  });
  const app = await buildApp({
    config: testConfig(),
    pool,
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const url = `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`;
    const crashed = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag, "idempotency-key": "pdf-crash-recovery-0001" },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(crashed.statusCode, 500);
    assert.equal(fake.putCount, 1);
    assert.equal(fake.renderCalls.length, 1);

    await db.exec("reset role");
    const before = await db.query(
      "select status, storage_version_id from public.document_snapshot_jobs where document_id = $1",
      [plan.json().id],
    );
    assert.equal(before.rows[0].status, "uploaded");
    assert.equal(before.rows[0].storage_version_id, "fake-version-1");
    await db.exec("set role michinote_runtime");
    const retried = await app.inject({
      method: "POST",
      url,
      headers: { "if-match": plan.headers.etag, "idempotency-key": "pdf-crash-recovery-0001" },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(retried.statusCode, 201);
    await db.exec("reset role");
    const after = await db.query(
      `select j.status, s.storage_version_id
       from public.document_snapshot_jobs j
       join public.document_snapshots s on s.id = j.id and s.tenant_id = j.tenant_id
       where j.document_id = $1`,
      [plan.json().id],
    );
    assert.deepEqual(after.rows[0], { status: "completed", storage_version_id: "fake-version-1" });
    assert.equal(fake.putCount, 1);
    assert.equal(fake.renderCalls.length, 1);
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("複数ECSから同一文書版のPDFを要求してもDB leaseが二重生成を防ぐ", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const slowRenderer = {
    async render(input) {
      fake.renderCalls.push(input);
      enteredResolve();
      await release;
      return Buffer.from(`%PDF-1.7\n${input.orientation}\n%%EOF`, "utf8");
    },
  };
  const options = {
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: slowRenderer,
    documentStorage: fake.documentStorage,
  };
  const appOne = await buildApp(options);
  const appTwo = await buildApp(options);
  try {
    const plan = await createPlan(appOne);
    const request = {
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    };
    const firstPromise = appOne.inject(request);
    await entered;
    const competing = await appTwo.inject(request);
    assert.equal(competing.statusCode, 503);
    assert.equal(competing.json().error.code, "PDF_GENERATION_BUSY");
    assert.equal(competing.headers["retry-after"], "5");
    releaseResolve();
    const first = await firstPromise;
    assert.equal(first.statusCode, 201);
    assert.equal(fake.renderCalls.length, 1);
    assert.equal(fake.putCount, 1);
  } finally {
    releaseResolve?.();
    await appTwo.close();
    await appOne.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("web runtimeのDB直操作でfake VersionId/hashを正式snapshotとして確定できない", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: {
      async render(input) {
        enteredResolve();
        await release;
        return Buffer.from(`%PDF-1.7\n${input.orientation}\n%%EOF`, "utf8");
      },
    },
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const generating = app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    });
    await entered;

    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.user],
    );
    const job = await db.query(
      "select id, lease_token from public.document_snapshot_jobs where document_id = $1",
      [plan.json().id],
    );
    // Even a stolen runtime DB password cannot derive the independent upload
    // attestation key. This reproduces and rejects the former derivation path.
    const derivedFromCompromisedRuntimePassword = createHmac(
      "sha256",
      "compromised-runtime-database-password-1234567890",
    ).update("michinote/pdf-finalization/v1", "utf8").digest("hex");
    const forgedAttestation = signPdfUpload(derivedFromCompromisedRuntimePassword, {
      jobId: job.rows[0].id,
      leaseToken: job.rows[0].lease_token,
      storageVersionId: "fake-version",
      sha256: "f".repeat(64),
      byteSize: 123,
    });
    const forged = await db.query(
      `select * from app_private.record_document_snapshot_job_upload(
        $1, $2, 'fake-version', $3, 123, $4
      )`,
      [job.rows[0].id, job.rows[0].lease_token, "f".repeat(64), forgedAttestation],
    );
    assert.equal(forged.rows.length, 0);
    await assert.rejects(
      () => db.query("select * from app_private.document_snapshot_finalization_config"),
      (error) => error.code === "42501",
    );
    await db.exec("rollback");

    releaseResolve();
    const genuine = await generating;
    assert.equal(genuine.statusCode, 201);
    await db.exec("reset role");
    const snapshots = await db.query(
      "select storage_version_id, sha256 from public.document_snapshots where document_id = $1",
      [plan.json().id],
    );
    assert.equal(snapshots.rows.length, 1);
    assert.equal(snapshots.rows[0].storage_version_id, "fake-version-1");
    assert.notEqual(snapshots.rows[0].sha256, "f".repeat(64));
  } finally {
    releaseResolve?.();
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("S3 Put直後にDB記録が落ちても期限切れjobが実バイトを再検証して再接続する", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  let failUploadRecordOnce = true;
  const pool = interceptingPool(db, (sql) => {
    if (failUploadRecordOnce && /app_private\.record_document_snapshot_job_upload/i.test(sql)) {
      failUploadRecordOnce = false;
      return Promise.reject(new Error("injected crash after S3 Put"));
    }
    return undefined;
  });
  const app = await buildApp({
    config: testConfig(),
    pool,
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const request = {
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": plan.headers.etag, "idempotency-key": "pdf-orphan-recovery-0001" },
      payload: { snapshotKind: "draft" },
    };
    const crashed = await app.inject(request);
    assert.equal(crashed.statusCode, 500);
    assert.equal(fake.putCount, 1);

    await db.exec("reset role");
    await db.query(
      "update public.document_snapshot_jobs set lease_expires_at = now() - interval '1 second' where document_id = $1",
      [plan.json().id],
    );
    await db.exec("set role michinote_runtime");
    const recovered = await app.inject(request);
    assert.equal(recovered.statusCode, 201);
    assert.equal(fake.putCount, 1, "If-None-Match object must be inspected, not overwritten");
    assert.equal(fake.renderCalls.length, 2, "source is safely rerendered after an unrecorded upload");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("PDF外部I/O中に元文書が変更された場合はWORM物を誤接続せずquarantineする", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: {
      async render(input) {
        enteredResolve();
        await release;
        return Buffer.from(`%PDF-1.7\n${input.orientation}\n%%EOF`, "utf8");
      },
    },
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const generating = app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    });
    await entered;
    await db.exec("reset role");
    await db.query(
      `update public.case_documents
       set payload = payload || '{"concurrentEdit":true}'::jsonb,
           row_version = row_version + 1, updated_at = now()
       where id = $1`,
      [plan.json().id],
    );
    await db.exec("set role michinote_runtime");
    releaseResolve();
    const response = await generating;
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "PDF_SOURCE_CHANGED");

    await db.exec("reset role");
    const job = await db.query(
      "select status, last_error_code from public.document_snapshot_jobs where document_id = $1",
      [plan.json().id],
    );
    const snapshots = await db.query(
      "select count(*)::int as count from public.document_snapshots where document_id = $1",
      [plan.json().id],
    );
    assert.deepEqual(job.rows[0], { status: "quarantined", last_error_code: "SOURCE_CHANGED" });
    assert.equal(snapshots.rows[0].count, 0);
    assert.equal(fake.putCount, 1);
  } finally {
    releaseResolve?.();
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("元作成者が復旧できなくても別のPDF権限者がfailed jobをtakeoverできる", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  const failingApp = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: { async render() { throw new Error("simulated renderer exit"); } },
    documentStorage: fake.documentStorage,
  });
  const auditorConfig = testConfig("auditor");
  auditorConfig.devActor = {
    ...auditorConfig.devActor,
    userId: IDS.auditorUser,
    displayName: "テスト監査者",
  };
  const recoveryApp = await buildApp({
    config: auditorConfig,
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(failingApp);
    const request = {
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    };
    const failed = await failingApp.inject(request);
    assert.equal(failed.statusCode, 503);
    const recovered = await recoveryApp.inject(request);
    assert.equal(recovered.statusCode, 201);

    await db.exec("reset role");
    const evidence = await db.query(
      `select j.generated_by, j.lease_owner_id, s.generated_by as snapshot_generated_by
       from public.document_snapshot_jobs j
       join public.document_snapshots s on s.tenant_id = j.tenant_id and s.id = j.id
       where j.document_id = $1`,
      [plan.json().id],
    );
    assert.deepEqual(evidence.rows[0], {
      generated_by: IDS.user,
      lease_owner_id: IDS.auditorUser,
      snapshot_generated_by: IDS.auditorUser,
    });
  } finally {
    await recoveryApp.close();
    await failingApp.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("0016以前のVersionIdが無いPDFは実バイト検証後に安全にbackfillして閲覧できる", async () => {
  const db = await setupDatabase();
  const fake = fakePdfInfrastructure();
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
  });
  try {
    const plan = await createPlan(app);
    const baseUrl = `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`;
    const generated = await app.inject({
      method: "POST",
      url: baseUrl,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(generated.statusCode, 201);

    // Reproduce the exact pre-0016 shape. These owner-only fixture operations
    // are not available to the runtime role.
    await db.exec("reset role");
    await db.exec("alter table public.document_snapshots drop constraint document_snapshots_storage_version_required");
    await db.exec("alter table public.document_snapshots disable trigger document_snapshots_append_only");
    await db.query(
      "update public.document_snapshots set storage_version_id = null where id = $1",
      [generated.json().id],
    );
    await db.exec("alter table public.document_snapshots enable trigger document_snapshots_append_only");
    await db.exec(`alter table public.document_snapshots
      add constraint document_snapshots_storage_version_required
      check (storage_version_id is not null and length(storage_version_id) between 1 and 1024
        and storage_version_id !~ '[[:space:]]') not valid`);
    await db.exec("set role michinote_runtime");

    const content = await app.inject({
      method: "GET",
      url: `${baseUrl}/${generated.json().id}/content`,
    });
    assert.equal(content.statusCode, 200);
    assert.equal(Buffer.from(content.rawPayload).subarray(0, 5).toString(), "%PDF-");
    await db.exec("reset role");
    const persisted = await db.query(
      "select storage_version_id from public.document_snapshots where id = $1",
      [generated.json().id],
    );
    assert.equal(persisted.rows[0].storage_version_id, "fake-version-1");
    const audit = await db.query(
      "select action from public.audit_events where resource_id = $1 order by occurred_at, id",
      [generated.json().id],
    );
    assert.ok(audit.rows.some((row) => row.action === "document_snapshot.version_backfilled"));
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("受給者証の復号失敗時は帳票を保存せず、番号を応答・監査へ出さない", async () => {
  const db = await setupDatabase();
  await db.exec("reset role");
  await db.query(
    `update public.children
     set recipient_certificate_ciphertext = $2, recipient_certificate_last4 = '7890'
     where id = $1`,
    [IDS.child, Buffer.from("encrypted-recipient-certificate")],
  );
  await db.exec("set role michinote_runtime");
  const fake = fakePdfInfrastructure();
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    pdfRenderer: fake.pdfRenderer,
    documentStorage: fake.documentStorage,
    fieldEncryption: {
      async decrypt() {
        throw new Error("SECRET-CERTIFICATE-1234567890");
      },
    },
  });
  try {
    const plan = await createPlan(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/documents/${plan.json().id}/snapshots`,
      headers: { "if-match": plan.headers.etag },
      payload: { snapshotKind: "draft" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "SECURE_STORAGE_UNAVAILABLE");
    assert.equal(response.body.includes("SECRET-CERTIFICATE-1234567890"), false);
    assert.equal(fake.renderCalls.length, 0);
    assert.equal(fake.putCount, 0);

    await db.exec("reset role");
    const snapshots = await db.query("select count(*)::int as count from public.document_snapshots");
    const audit = await db.query(
      "select metadata::text from public.audit_events where action like 'document_snapshot.%'",
    );
    assert.equal(snapshots.rows[0].count, 0);
    assert.equal(JSON.stringify(audit.rows).includes("1234567890"), false);
    await db.exec("set role michinote_runtime");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});
