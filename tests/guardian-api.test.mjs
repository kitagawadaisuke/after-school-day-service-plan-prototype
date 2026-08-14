import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98f101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98f201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98f301",
  membership: "018f1db5-c170-7c35-a784-3cfc6f98f401",
  child: "018f1db5-c170-7c35-a784-3cfc6f98f501",
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
    auditHashKey: "guardian-api-test-audit-key",
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
      "cognito-guardian-test",
      "guardian-test@example.invalid",
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

test("保護者情報を利用児に紐づけ、主たる保護者の切替と競合を安全に扱う", async () => {
  const db = await setupDatabase();
  const encryptedValues = [];
  const app = await buildApp({
    config: testConfig(),
    pool: pglitePool(db),
    fieldEncryption: {
      async encrypt(value) {
        encryptedValues.push(value);
        return Buffer.from("opaque-kms-ciphertext");
      },
    },
  });
  try {
    const createChildRequest = {
      method: "POST",
      url: "/api/v1/children",
      headers: { "idempotency-key": "child-create-test-0001" },
      payload: {
        facilityId: IDS.facility,
        managementCode: "C-002",
        displayName: "Bさん",
        legalName: "テスト 利用児二",
      },
    };
    const firstCreate = await app.inject(createChildRequest);
    const replayedCreate = await app.inject(createChildRequest);
    assert.equal(firstCreate.statusCode, 201);
    assert.equal(replayedCreate.statusCode, 201);
    assert.equal(replayedCreate.headers["idempotency-replayed"], "true");
    assert.equal(replayedCreate.json().id, firstCreate.json().id);

    const reusedKey = await app.inject({
      ...createChildRequest,
      payload: { ...createChildRequest.payload, managementCode: "C-003" },
    });
    assert.equal(reusedKey.statusCode, 409);
    assert.equal(reusedKey.json().error.code, "IDEMPOTENCY_KEY_REUSED");

    const child = await app.inject({ method: "GET", url: `/api/v1/children/${IDS.child}` });
    const protectedCertificate = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}`,
      headers: { "if-match": child.headers.etag },
      payload: { recipientCertificateNumber: "999-900-0012" },
    });
    assert.equal(protectedCertificate.statusCode, 200);
    assert.equal(protectedCertificate.json().recipientCertificateMasked, "••••0012");
    assert.equal(protectedCertificate.body.includes("9999000012"), false);
    assert.deepEqual(encryptedValues, [{
      tenantId: IDS.tenant,
      fieldName: "recipient_certificate_number",
      plaintext: "9999000012",
    }]);

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/guardians`,
      payload: {
        legalName: "保護者 一",
        relationship: "母",
        phone: "000-0000-0000",
        isPrimary: true,
      },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.headers.etag, '"1"');
    assert.equal(first.json().isPrimary, true);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/guardians`,
      payload: {
        legalName: "保護者 二",
        relationship: "父",
        email: "guardian@example.invalid",
        isPrimary: true,
      },
    });
    assert.equal(second.statusCode, 201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/guardians`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 2);
    assert.equal(list.json().items.filter((guardian) => guardian.isPrimary).length, 1);
    assert.equal(list.json().items[0].id, second.json().id);

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/guardians/${second.json().id}`,
      headers: { "if-match": second.headers.etag },
      payload: { relationship: "父（主連絡先）" },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.headers.etag, '"2"');

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/guardians/${second.json().id}`,
      headers: { "if-match": second.headers.etag },
      payload: { legalName: "SECRET-GUARDIAN-VALUE" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "EDIT_CONFLICT");
    assert.equal(stale.body.includes("SECRET-GUARDIAN-VALUE"), false);
  } finally {
    await app.close();
    await db.close();
  }
});

test("閲覧者は保護者情報を登録できず、不正なメールもPIIなしで拒否する", async () => {
  const viewerApp = await buildApp({ config: testConfig("viewer"), pool: null });
  try {
    const forbidden = await viewerApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/guardians`,
      payload: {
        legalName: "SECRET-GUARDIAN-NAME",
        relationship: "保護者",
      },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.body.includes("SECRET-GUARDIAN-NAME"), false);
  } finally {
    await viewerApp.close();
  }

  const adminApp = await buildApp({ config: testConfig(), pool: null });
  try {
    const invalid = await adminApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/guardians`,
      payload: {
        legalName: "SECRET-GUARDIAN-NAME",
        relationship: "保護者",
        email: "not-an-email",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.includes("SECRET-GUARDIAN-NAME"), false);
  } finally {
    await adminApp.close();
  }
});
