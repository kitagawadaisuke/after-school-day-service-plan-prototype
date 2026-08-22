import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";

const IDS = {
  tenantA: "018f1db5-c170-7c35-a784-3cfc6f98a101",
  adminA: "018f1db5-c170-7c35-a784-3cfc6f98a201",
  approverA: "018f1db5-c170-7c35-a784-3cfc6f98a202",
  viewerA: "018f1db5-c170-7c35-a784-3cfc6f98a203",
  facilityA: "018f1db5-c170-7c35-a784-3cfc6f98a301",
  adminMembershipA: "018f1db5-c170-7c35-a784-3cfc6f98a401",
  approverMembershipA: "018f1db5-c170-7c35-a784-3cfc6f98a402",
  viewerMembershipA: "018f1db5-c170-7c35-a784-3cfc6f98a403",
  childA: "018f1db5-c170-7c35-a784-3cfc6f98a501",
  childA2: "018f1db5-c170-7c35-a784-3cfc6f98a502",
  tenantB: "018f1db5-c170-7c35-a784-3cfc6f98b101",
  adminB: "018f1db5-c170-7c35-a784-3cfc6f98b201",
  facilityB: "018f1db5-c170-7c35-a784-3cfc6f98b301",
  membershipB: "018f1db5-c170-7c35-a784-3cfc6f98b401",
  childB: "018f1db5-c170-7c35-a784-3cfc6f98b501",
};

const migrationsDirectory = new URL("../db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrationSql = (await Promise.all(
  migrationFiles.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
)).join("\n");
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function testConfig({ tenantId, userId, facilityId, role }) {
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
    auditHashKey: "case-context-api-test-audit-key",
    cognito: null,
    devActor: {
      userId,
      tenantId,
      facilityIds: [facilityId],
      role,
      displayName: "テスト職員",
    },
  };
}

function actorA(role = "plan_approver") {
  return testConfig({
    tenantId: IDS.tenantA,
    userId: role === "viewer" ? IDS.viewerA : IDS.approverA,
    facilityId: IDS.facilityA,
    role,
  });
}

function actorB() {
  return testConfig({
    tenantId: IDS.tenantB,
    userId: IDS.adminB,
    facilityId: IDS.facilityB,
    role: "tenant_admin",
  });
}

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenantA,
      "テスト法人A",
      IDS.adminA,
      "cognito-case-admin-a",
      "admin-a@example.invalid",
      "法人管理者A",
      IDS.adminMembershipA,
      IDS.facilityA,
      "A-001",
      "テスト事業所A",
    ],
  );
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenantB,
      "テスト法人B",
      IDS.adminB,
      "cognito-case-admin-b",
      "admin-b@example.invalid",
      "法人管理者B",
      IDS.membershipB,
      IDS.facilityB,
      "B-001",
      "テスト事業所B",
    ],
  );
  await db.query(
    `insert into public.app_users (id, cognito_sub, email, display_name)
     values ($1, 'cognito-case-approver-a', 'approver-a@example.invalid', '計画作成責任者A')`,
    [IDS.approverA],
  );
  await db.query(
    `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
     values ($1, $2, $3, 'plan_approver', 'active', now())`,
    [IDS.approverMembershipA, IDS.tenantA, IDS.approverA],
  );
  await db.query(
    `insert into public.membership_facilities (tenant_id, membership_id, facility_id)
     values ($1, $2, $3)`,
    [IDS.tenantA, IDS.approverMembershipA, IDS.facilityA],
  );
  await db.query(
    `insert into public.app_users (id, cognito_sub, email, display_name)
     values ($1, 'cognito-case-viewer-a', 'viewer-a@example.invalid', '閲覧職員A')`,
    [IDS.viewerA],
  );
  await db.query(
    `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
     values ($1, $2, $3, 'viewer', 'active', now())`,
    [IDS.viewerMembershipA, IDS.tenantA, IDS.viewerA],
  );
  await db.query(
    `insert into public.membership_facilities (tenant_id, membership_id, facility_id)
     values ($1, $2, $3)`,
    [IDS.tenantA, IDS.viewerMembershipA, IDS.facilityA],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values
      ($1, $3, $4, 'A-C001', 'Aさん', 'テスト利用児A', $5, $5),
      ($2, $3, $4, 'A-C002', 'A2さん', 'テスト利用児A2', $5, $5)`,
    [IDS.childA, IDS.childA2, IDS.tenantA, IDS.facilityA, IDS.adminA],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values ($1, $2, $3, 'B-C001', 'Bさん', 'テスト利用児B', $4, $4)`,
    [IDS.childB, IDS.tenantB, IDS.facilityB, IDS.adminB],
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

test("家族・関係機関・利用児との紐付けを版管理し、計画作成責任者が更新できる", async () => {
  const db = await setupDatabase();
  const pool = pglitePool(db);
  const app = await buildApp({ config: actorA(), pool });
  try {
    const family = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.childA}/family-members`,
      payload: {
        displayLabel: "母",
        relationship: "母",
        age: 38,
        occupationOrRole: "主たる養育者",
        cohabitationStatus: "same_household",
        supportSummary: "家庭で予定を一緒に確認する",
        sortOrder: 1,
      },
    });
    assert.equal(family.statusCode, 201);
    assert.equal(family.headers.etag, '"1"');
    assert.equal(family.json().age, 38);

    const familyList = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA}/family-members`,
    });
    assert.equal(familyList.statusCode, 200);
    assert.deepEqual(familyList.json().items.map((item) => item.id), [family.json().id]);

    const familyDetail = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA}/family-members/${family.json().id}`,
    });
    assert.equal(familyDetail.statusCode, 200);
    assert.equal(familyDetail.headers.etag, '"1"');

    const familyChanged = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.childA}/family-members/${family.json().id}`,
      headers: { "if-match": family.headers.etag },
      payload: { age: 39, supportSummary: "連絡帳で事業所と支援方法を共有する" },
    });
    assert.equal(familyChanged.statusCode, 200);
    assert.equal(familyChanged.headers.etag, '"2"');

    const familyStale = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.childA}/family-members/${family.json().id}`,
      headers: { "if-match": family.headers.etag },
      payload: { displayLabel: "SECRET-FAMILY-VALUE" },
    });
    assert.equal(familyStale.statusCode, 409);
    assert.equal(familyStale.json().error.code, "EDIT_CONFLICT");
    assert.equal(familyStale.body.includes("SECRET-FAMILY-VALUE"), false);

    const institution = await app.inject({
      method: "POST",
      url: "/api/v1/institutions",
      headers: { "idempotency-key": "case-institution-0001" },
      payload: {
        kind: "consultation_support",
        name: "ひなた相談支援事業所",
        contactName: "相談支援専門員",
        phone: "000-0000-0000",
        notes: "サービス等利用計画を共有",
      },
    });
    assert.equal(institution.statusCode, 201);
    assert.equal(institution.headers.etag, '"1"');

    const institutionReplay = await app.inject({
      method: "POST",
      url: "/api/v1/institutions",
      headers: { "idempotency-key": "case-institution-0001" },
      payload: {
        kind: "consultation_support",
        name: "ひなた相談支援事業所",
        contactName: "相談支援専門員",
        phone: "000-0000-0000",
        notes: "サービス等利用計画を共有",
      },
    });
    assert.equal(institutionReplay.statusCode, 201);
    assert.equal(institutionReplay.headers["idempotency-replayed"], "true");
    assert.equal(institutionReplay.json().id, institution.json().id);

    const institutionDetail = await app.inject({
      method: "GET",
      url: `/api/v1/institutions/${institution.json().id}`,
    });
    assert.equal(institutionDetail.statusCode, 200);
    assert.equal(institutionDetail.headers.etag, '"1"');

    const institutionList = await app.inject({
      method: "GET",
      url: "/api/v1/institutions?kind=consultation_support",
    });
    assert.equal(institutionList.statusCode, 200);
    assert.deepEqual(institutionList.json().items.map((item) => item.id), [institution.json().id]);

    const institutionChanged = await app.inject({
      method: "PATCH",
      url: `/api/v1/institutions/${institution.json().id}`,
      headers: { "if-match": institution.headers.etag },
      payload: { contactName: "担当相談支援専門員" },
    });
    assert.equal(institutionChanged.statusCode, 200);
    assert.equal(institutionChanged.headers.etag, '"2"');

    const institutionStale = await app.inject({
      method: "PATCH",
      url: `/api/v1/institutions/${institution.json().id}`,
      headers: { "if-match": institution.headers.etag },
      payload: { name: "SECRET-INSTITUTION-VALUE" },
    });
    assert.equal(institutionStale.statusCode, 409);
    assert.equal(institutionStale.body.includes("SECRET-INSTITUTION-VALUE"), false);

    const relation = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.childA}/institution-relations`,
      payload: {
        institutionId: institution.json().id,
        relationshipKind: "計画相談",
        serviceDetails: "本人・家族の希望を確認し、全体計画を調整する",
        frequencyText: "6か月ごと",
        validFrom: "2026-04-01",
        validTo: "2027-03-31",
      },
    });
    assert.equal(relation.statusCode, 201);
    assert.equal(relation.headers.etag, '"1"');
    assert.equal(relation.json().institution.name, "ひなた相談支援事業所");

    const relationList = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA}/institution-relations`,
    });
    assert.equal(relationList.statusCode, 200);
    assert.deepEqual(relationList.json().items.map((item) => item.id), [relation.json().id]);

    const relationDetail = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA}/institution-relations/${relation.json().id}`,
    });
    assert.equal(relationDetail.statusCode, 200);
    assert.equal(relationDetail.headers.etag, '"1"');

    const relationChanged = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.childA}/institution-relations/${relation.json().id}`,
      headers: { "if-match": relation.headers.etag },
      payload: { frequencyText: "必要時および6か月ごと" },
    });
    assert.equal(relationChanged.statusCode, 200);
    assert.equal(relationChanged.headers.etag, '"2"');

    const staleRelation = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.childA}/institution-relations/${relation.json().id}`,
      headers: { "if-match": relation.headers.etag },
      payload: { serviceDetails: "SECRET-RELATION-VALUE" },
    });
    assert.equal(staleRelation.statusCode, 409);
    assert.equal(staleRelation.body.includes("SECRET-RELATION-VALUE"), false);

    const invalidMergedPeriod = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.childA}/institution-relations/${relation.json().id}`,
      headers: { "if-match": relationChanged.headers.etag },
      payload: { validTo: "2026-03-31" },
    });
    assert.equal(invalidMergedPeriod.statusCode, 400);
    assert.equal(invalidMergedPeriod.json().error.code, "INVALID_PERIOD");

    const wrongChild = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA2}/institution-relations/${relation.json().id}`,
    });
    assert.equal(wrongChild.statusCode, 404);

    const noHardDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/children/${IDS.childA}/family-members/${family.json().id}`,
    });
    assert.equal(noHardDelete.statusCode, 404);

    await db.exec("reset role");
    const audits = await db.query(
      `select action, changed_fields, metadata
       from public.audit_events where tenant_id = $1 order by occurred_at, action`,
      [IDS.tenantA],
    );
    assert.deepEqual(
      new Set(audits.rows.map((row) => row.action)),
      new Set([
        "family_member.created",
        "family_member.updated",
        "institution.created",
        "institution.updated",
        "child_institution_relation.created",
        "child_institution_relation.updated",
        "pii.read",
        "pii.searched",
      ]),
    );
    assert.equal(JSON.stringify(audits.rows).includes("ひなた相談支援事業所"), false);
    assert.equal(JSON.stringify(audits.rows).includes("000-0000-0000"), false);
  } finally {
    await app.close();
    await db.close();
  }
});

test("閲覧者は参照のみで、別法人・別利用児のケース文脈を取得・関連付けできない", async () => {
  const db = await setupDatabase();
  const pool = pglitePool(db);
  const planApp = await buildApp({ config: actorA(), pool });
  const viewerApp = await buildApp({ config: actorA("viewer"), pool });
  const tenantBApp = await buildApp({ config: actorB(), pool });
  try {
    const family = await planApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.childA}/family-members`,
      payload: { displayLabel: "父", relationship: "父", sortOrder: 2 },
    });
    const institution = await planApp.inject({
      method: "POST",
      url: "/api/v1/institutions",
      payload: { kind: "school", name: "テスト小学校" },
    });
    assert.equal(family.statusCode, 201);
    assert.equal(institution.statusCode, 201);

    const viewerRead = await viewerApp.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA}/family-members`,
    });
    assert.equal(viewerRead.statusCode, 200);

    const viewerWrite = await viewerApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.childA}/family-members`,
      payload: { displayLabel: "SECRET-VIEWER-VALUE", relationship: "その他" },
    });
    assert.equal(viewerWrite.statusCode, 403);
    assert.equal(viewerWrite.json().error.code, "FORBIDDEN");
    assert.equal(viewerWrite.body.includes("SECRET-VIEWER-VALUE"), false);

    const otherTenantRead = await tenantBApp.inject({
      method: "GET",
      url: `/api/v1/institutions/${institution.json().id}`,
    });
    assert.equal(otherTenantRead.statusCode, 404);

    const crossTenantRelation = await tenantBApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.childB}/institution-relations`,
      payload: {
        institutionId: institution.json().id,
        relationshipKind: "越境参照",
      },
    });
    assert.equal(crossTenantRelation.statusCode, 404);

    const differentChildFamily = await planApp.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.childA2}/family-members/${family.json().id}`,
    });
    assert.equal(differentChildFamily.statusCode, 404);

    const invalidPeriod = await planApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.childA}/institution-relations`,
      payload: {
        institutionId: institution.json().id,
        relationshipKind: "在籍",
        validFrom: "2026-04-02",
        validTo: "2026-04-01",
      },
    });
    assert.equal(invalidPeriod.statusCode, 400);
    assert.equal(invalidPeriod.json().error.code, "VALIDATION_ERROR");
  } finally {
    await planApp.close();
    await viewerApp.close();
    await tenantBApp.close();
    await db.close();
  }
});
