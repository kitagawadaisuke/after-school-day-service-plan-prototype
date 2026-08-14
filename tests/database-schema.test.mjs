import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { approveDocumentFixture } from "./helpers/document-workflow-fixture.mjs";

const IDS = {
  tenantA: "018f1db5-c170-7c35-a784-3cfc6f98c101",
  tenantB: "018f1db5-c170-7c35-a784-3cfc6f98c102",
  userA: "018f1db5-c170-7c35-a784-3cfc6f98c201",
  userB: "018f1db5-c170-7c35-a784-3cfc6f98c202",
  facilityA: "018f1db5-c170-7c35-a784-3cfc6f98c301",
  facilityA2: "018f1db5-c170-7c35-a784-3cfc6f98c303",
  facilityB: "018f1db5-c170-7c35-a784-3cfc6f98c302",
  membershipA: "018f1db5-c170-7c35-a784-3cfc6f98c401",
  membershipB: "018f1db5-c170-7c35-a784-3cfc6f98c402",
  childA: "018f1db5-c170-7c35-a784-3cfc6f98c501",
  childB: "018f1db5-c170-7c35-a784-3cfc6f98c502",
  documentA: "018f1db5-c170-7c35-a784-3cfc6f98c601",
  goalA: "018f1db5-c170-7c35-a784-3cfc6f98c701",
  invitedUser: "018f1db5-c170-7c35-a784-3cfc6f98c901",
  invitedMembership: "018f1db5-c170-7c35-a784-3cfc6f98c902",
  invitation: "018f1db5-c170-7c35-a784-3cfc6f98c903",
};

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationSql = await Promise.all(
  (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort()
    .map((name) => readFile(new URL(name, migrationsUrl), "utf8")),
);
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

async function setupDatabase() {
  const db = new PGlite();
  for (const sql of migrationSql) await db.exec(sql);
  await db.exec(grantsSql);

  await db.query(
    `select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [IDS.tenantA, "架空法人A", IDS.userA, "cognito-a", "admin-a@example.invalid", "管理者A", IDS.membershipA, IDS.facilityA, "A-01", "架空事業所A"],
  );
  await db.query(
    `select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [IDS.tenantB, "架空法人B", IDS.userB, "cognito-b", "admin-b@example.invalid", "管理者B", IDS.membershipB, IDS.facilityB, "B-01", "架空事業所B"],
  );

  await db.query(
    "insert into public.facilities (id, tenant_id, code, name) values ($1, $2, 'A-02', '架空事業所A-2')",
    [IDS.facilityA2, IDS.tenantA],
  );
  await db.query(
    "insert into public.membership_facilities (tenant_id, membership_id, facility_id) values ($1, $2, $3)",
    [IDS.tenantA, IDS.membershipA, IDS.facilityA2],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values ($1, $2, $3, 'A-C001', 'Aさん', '架空 利用児A', $4, $4)`,
    [IDS.childA, IDS.tenantA, IDS.facilityA, IDS.userA],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values ($1, $2, $3, 'B-C001', 'Bさん', '架空 利用児B', $4, $4)`,
    [IDS.childB, IDS.tenantB, IDS.facilityB, IDS.userB],
  );
  return db;
}

async function beginAs(db, tenantId, userId) {
  await db.exec("set role michinote_runtime");
  await db.exec("begin");
  await db.query(
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [tenantId, userId],
  );
}

async function rollbackAndClose(db) {
  try {
    await db.exec("rollback");
    await db.exec("reset role");
  } finally {
    await db.close();
  }
}

test("マイグレーションと最小権限設定をクリーンDBへ適用できる", async () => {
  const db = new PGlite();
  for (const sql of migrationSql) await assert.doesNotReject(() => db.exec(sql));
  await assert.doesNotReject(() => db.exec(grantsSql));
  await db.close();
});

test("RLSは別法人の利用児を返さない", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    const result = await db.query("select id, tenant_id from public.children order by id");
    assert.deepEqual(result.rows, [{ id: IDS.childA, tenant_id: IDS.tenantA }]);
  } finally {
    await rollbackAndClose(db);
  }
});

test("idempotency応答は別法人・別操作者から参照できない", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    await db.query(
      `insert into app_private.idempotency_records (
        tenant_id, actor_user_id, idempotency_key, request_fingerprint,
        response_status, response_body, expires_at
      ) values ($1, $2, 'test-key-0001', $3, 201, '{"id":"private-resource"}', now() + interval '1 hour')`,
      [IDS.tenantA, IDS.userA, "a".repeat(64)],
    );
    await db.exec("commit");

    await beginAs(db, IDS.tenantB, IDS.userB);
    const hidden = await db.query("select idempotency_key from app_private.idempotency_records");
    assert.deepEqual(hidden.rows, []);
  } finally {
    await rollbackAndClose(db);
  }
});

test("idempotency応答は24時間以内に制限され、期限切れを一括削除する", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    await assert.rejects(
      () => db.query(
        `insert into app_private.idempotency_records (
          tenant_id, actor_user_id, idempotency_key, request_fingerprint,
          response_status, response_body, expires_at
        ) values ($1, $2, 'too-long-ttl', $3, 201, '{}', now() + interval '25 hours')`,
        [IDS.tenantA, IDS.userA, "b".repeat(64)],
      ),
      (error) => error.code === "23514",
    );
    await db.exec("rollback");
    await beginAs(db, IDS.tenantA, IDS.userA);
    await db.query(
      `insert into app_private.idempotency_records (
        tenant_id, actor_user_id, idempotency_key, request_fingerprint,
        response_status, response_body, created_at, expires_at
      ) values ($1, $2, 'expired-key-0001', $3, 201, '{"private":"transient"}',
        now() - interval '2 days', now() - interval '1 day')`,
      [IDS.tenantA, IDS.userA, "c".repeat(64)],
    );
    const purged = await db.query(
      "select app_private.purge_expired_idempotency_records(250) as count",
    );
    assert.equal(Number(purged.rows[0].count), 1);
    const remaining = await db.query(
      "select count(*)::integer as count from app_private.idempotency_records where idempotency_key = 'expired-key-0001'",
    );
    assert.equal(remaining.rows[0].count, 0);
  } finally {
    await rollbackAndClose(db);
  }
});

test("一つのログインを複数法人へ暗黙加入させない", async () => {
  const db = await setupDatabase();
  try {
    await assert.rejects(
      () => db.query(
        `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
         values ($1, $2, $3, 'viewer', 'active', now())`,
        ["018f1db5-c170-7c35-a784-3cfc6f98c904", IDS.tenantB, IDS.userA],
      ),
      (error) => error.code === "23505",
    );
  } finally {
    await db.close();
  }
});

test("別施設のfacility_idと利用児を一つの記録へ関連付けられない", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    await assert.rejects(
      () => db.query(
        `insert into public.daily_logs (
          id, tenant_id, facility_id, child_id, occurred_at, activity, observation,
          support_provided, child_response, recorded_by, updated_by
        ) values ($1, $2, $3, $4, now(), '活動', '観察', '支援', '反応', $5, $5)`,
        ["018f1db5-c170-7c35-a784-3cfc6f98c801", IDS.tenantA, IDS.facilityA2, IDS.childA, IDS.userA],
      ),
      (error) => error.code === "23503",
    );
  } finally {
    await rollbackAndClose(db);
  }
});

test("確定文書の本文と目標は上書きできない", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    await db.query(
      `insert into public.case_documents (
        id, tenant_id, facility_id, child_id, document_kind, version_number,
        template_version, payload, created_by, updated_by
      ) values ($1, $2, $3, $4, 'individual_support_plan', 1, '2026-01', '{"summary":"draft"}', $5, $5)`,
      [IDS.documentA, IDS.tenantA, IDS.facilityA, IDS.childA, IDS.userA],
    );
    await db.query(
      `insert into public.document_goals (
        id, tenant_id, document_id, goal_kind, title
      ) values ($1, $2, $3, 'support', '架空の支援目標')`,
      [IDS.goalA, IDS.tenantA, IDS.documentA],
    );
    const aggregateAfterGoal = await db.query(
      "select row_version from public.case_documents where id = $1",
      [IDS.documentA],
    );
    assert.equal(Number(aggregateAfterGoal.rows[0].row_version), 2);
    await approveDocumentFixture(db, {
      tenantId: IDS.tenantA,
      userId: IDS.userA,
      documentId: IDS.documentA,
    });

    const version = await db.query("select row_version from public.case_documents where id = $1", [IDS.documentA]);
    assert.equal(Number(version.rows[0].row_version), 6);

    await db.exec("commit");
    await beginAs(db, IDS.tenantA, IDS.userA);

    await assert.rejects(
      () => db.query("update public.case_documents set payload = '{\"summary\":\"tampered\"}' where id = $1", [IDS.documentA]),
      (error) => error.code === "55000",
    );
    await db.exec("rollback");
    await beginAs(db, IDS.tenantA, IDS.userA);
    await assert.rejects(
      () => db.query(
        "insert into public.document_goals (id, tenant_id, document_id, goal_kind, title) values ($1, $2, $3, 'support', '後付け目標')",
        ["018f1db5-c170-7c35-a784-3cfc6f98c702", IDS.tenantA, IDS.documentA],
      ),
      (error) => error.code === "55000",
    );
  } finally {
    await rollbackAndClose(db);
  }
});

test("法人管理者の招待を検証済みCognitoメールへ安全に関連付ける", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    const invited = await db.query(
      `select app_private.invite_staff_member(
        $1, $2, $3, $4, $5, $6, $7::uuid[]
      ) as result`,
      [
        IDS.invitation,
        IDS.invitedUser,
        IDS.invitedMembership,
        "new-staff@example.invalid",
        "新規職員",
        "support_staff",
        [IDS.facilityA],
      ],
    );
    assert.equal(invited.rows[0].result.status, "invited");
    await db.exec("commit");

    const resolved = await db.query(
      `select user_id, tenant_id, role, facility_ids
       from app_private.resolve_cognito_identity($1, $2, true)`,
      ["new-cognito-subject", "new-staff@example.invalid"],
    );
    assert.equal(resolved.rows[0].user_id, IDS.invitedUser);
    assert.equal(resolved.rows[0].tenant_id, IDS.tenantA);
    assert.equal(resolved.rows[0].role, "support_staff");
    assert.deepEqual(resolved.rows[0].facility_ids, [IDS.facilityA]);

    await beginAs(db, IDS.tenantA, IDS.userA);
    const invitation = await db.query(
      "select status, accepted_at from public.staff_invitations where id = $1",
      [IDS.invitation],
    );
    assert.equal(invitation.rows[0].status, "accepted");
    assert.ok(invitation.rows[0].accepted_at);
  } finally {
    await rollbackAndClose(db);
  }
});

test("最後の法人管理者を停止できない", async () => {
  const db = await setupDatabase();
  try {
    await beginAs(db, IDS.tenantA, IDS.userA);
    await assert.rejects(
      () => db.query(
        "select app_private.update_staff_membership($1, 'tenant_admin', 'suspended', '{}'::uuid[])",
        [IDS.membershipA],
      ),
      (error) => error.code === "23514",
    );
  } finally {
    await rollbackAndClose(db);
  }
});
