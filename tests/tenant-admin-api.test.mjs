import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  cognitoAdminClientOptions,
  createCognitoAdmin,
} from "../server/aws/cognito-admin.js";
import { buildApp } from "../server/app.js";

const IDS = Object.freeze({
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98c101",
  admin: "018f1db5-c170-7c35-a784-3cfc6f98c201",
  adminMembership: "018f1db5-c170-7c35-a784-3cfc6f98c401",
  facilityA: "018f1db5-c170-7c35-a784-3cfc6f98c301",
  facilityB: "018f1db5-c170-7c35-a784-3cfc6f98c302",
  facilityAdmin: "018f1db5-c170-7c35-a784-3cfc6f98c202",
  facilityAdminMembership: "018f1db5-c170-7c35-a784-3cfc6f98c402",
  sharedStaff: "018f1db5-c170-7c35-a784-3cfc6f98c203",
  sharedStaffMembership: "018f1db5-c170-7c35-a784-3cfc6f98c403",
  otherStaff: "018f1db5-c170-7c35-a784-3cfc6f98c204",
  otherStaffMembership: "018f1db5-c170-7c35-a784-3cfc6f98c404",
  auditor: "018f1db5-c170-7c35-a784-3cfc6f98c205",
  auditorMembership: "018f1db5-c170-7c35-a784-3cfc6f98c405",
  existingCognitoUser: "018f1db5-c170-7c35-a784-3cfc6f98c206",
});

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationSql = await Promise.all(
  (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort()
    .map((name) => readFile(new URL(name, migrationsUrl), "utf8")),
);
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function appConfig(actor) {
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
    auditHashKey: "tenant-admin-test-audit-key",
    awsRegion: "ap-northeast-1",
    cognito: null,
    devActor: actor,
  };
}

function actor(userId, role, facilityIds) {
  return {
    userId,
    tenantId: IDS.tenant,
    facilityIds,
    role,
    displayName: "テスト職員",
  };
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForDeferred(deferred, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
  });
  try {
    return await Promise.race([deferred.promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function addStaff(db, values) {
  await db.query(
    `insert into public.app_users (id, cognito_sub, email, display_name, status)
     values ($1, $2, $3, $4, 'active')`,
    [values.userId, values.cognitoSub, values.email, values.displayName],
  );
  if (!values.membershipId) return;
  await db.query(
    `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
     values ($1, $2, $3, $4, 'active', now())`,
    [values.membershipId, IDS.tenant, values.userId, values.role],
  );
  for (const facilityId of values.facilityIds || []) {
    await db.query(
      `insert into public.membership_facilities (tenant_id, membership_id, facility_id)
       values ($1, $2, $3)`,
      [IDS.tenant, values.membershipId, facilityId],
    );
  }
}

async function setupDatabase() {
  const db = new PGlite();
  for (const sql of migrationSql) await db.exec(sql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "テスト法人",
      IDS.admin,
      "cognito-admin",
      "admin@example.invalid",
      "法人管理者",
      IDS.adminMembership,
      IDS.facilityA,
      "A-01",
      "第一事業所",
    ],
  );
  await db.query(
    "insert into public.facilities (id, tenant_id, code, name) values ($1, $2, 'B-01', '第二事業所')",
    [IDS.facilityB, IDS.tenant],
  );
  await addStaff(db, {
    userId: IDS.facilityAdmin,
    membershipId: IDS.facilityAdminMembership,
    cognitoSub: "cognito-facility-admin",
    email: "facility-admin@example.invalid",
    displayName: "施設管理者",
    role: "facility_admin",
    facilityIds: [IDS.facilityA],
  });
  await addStaff(db, {
    userId: IDS.sharedStaff,
    membershipId: IDS.sharedStaffMembership,
    cognitoSub: "cognito-shared-staff",
    email: "shared@example.invalid",
    displayName: "共有支援員",
    role: "support_staff",
    facilityIds: [IDS.facilityA],
  });
  await addStaff(db, {
    userId: IDS.otherStaff,
    membershipId: IDS.otherStaffMembership,
    cognitoSub: "cognito-other-staff",
    email: "other@example.invalid",
    displayName: "別施設閲覧者",
    role: "viewer",
    facilityIds: [IDS.facilityB],
  });
  await addStaff(db, {
    userId: IDS.auditor,
    membershipId: IDS.auditorMembership,
    cognitoSub: "cognito-auditor",
    email: "auditor@example.invalid",
    displayName: "監査担当",
    role: "auditor",
    facilityIds: [IDS.facilityA],
  });
  await addStaff(db, {
    userId: IDS.existingCognitoUser,
    cognitoSub: "cognito-existing-user",
    email: "existing@example.invalid",
    displayName: "既存Cognito職員",
  });
  await db.exec("set role michinote_runtime");
  return db;
}

test("Cognito管理アダプターは設定されたUser Poolだけへ招待を送る", async () => {
  const commands = [];
  const cognitoAdmin = createCognitoAdmin({
    config: {
      cognito: {
        region: "ap-northeast-1",
        userPoolId: "ap-northeast-1_testPool",
      },
    },
    client: {
      async send(command) {
        commands.push(command.input);
        return { User: { Username: "generated-cognito-username" } };
      },
    },
  });

  const result = await cognitoAdmin.inviteUser({
    email: "invitee@example.invalid",
    displayName: "招待職員",
  });
  assert.deepEqual(result, { username: "generated-cognito-username" });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].UserPoolId, "ap-northeast-1_testPool");
  assert.equal(commands[0].Username, "invitee@example.invalid");
  assert.deepEqual(commands[0].DesiredDeliveryMediums, ["EMAIL"]);
  assert.deepEqual(commands[0].UserAttributes, [
    { Name: "email", Value: "invitee@example.invalid" },
    { Name: "email_verified", Value: "true" },
    { Name: "name", Value: "招待職員" },
  ]);
  assert.deepEqual(cognitoAdminClientOptions({ cognito: {
    region: "ap-northeast-3",
  } }), { region: "ap-northeast-3", maxAttempts: 1 });
});

test("CognitoのUsernameExistsを自動再送せず、明示操作だけがRESENDする", async () => {
  const commands = [];
  const cognitoAdmin = createCognitoAdmin({
    config: {
      cognito: {
        region: "ap-northeast-1",
        userPoolId: "ap-northeast-1_testPool",
      },
    },
    client: {
      async send(command) {
        commands.push({ name: command.constructor.name, input: command.input });
        if (command.input.MessageAction === "RESEND") {
          assert.equal(command.input.Username, "generated-retry-username");
          return { User: { Username: "generated-retry-username" } };
        }
        const error = new Error("already created by the previous attempt");
        error.name = "UsernameExistsException";
        throw error;
      },
    },
  });

  await assert.rejects(
    cognitoAdmin.inviteUser({
      email: "retry@example.invalid",
      displayName: "再送対象職員",
    }),
    (error) => error?.name === "UsernameExistsException",
  );
  assert.deepEqual(commands.map((item) => item.name), ["AdminCreateUserCommand"]);

  const result = await cognitoAdmin.inviteUser({
    email: "retry@example.invalid",
    displayName: "再送対象職員",
    operation: "resend",
    username: "generated-retry-username",
  });
  assert.deepEqual(result, { username: "generated-retry-username" });
  assert.deepEqual(commands.map((item) => item.name), [
    "AdminCreateUserCommand",
    "AdminCreateUserCommand",
  ]);
  assert.equal(commands[1].input.MessageAction, "RESEND");
});

test("法人管理者と施設管理者で職員一覧の表示範囲を分離する", async () => {
  const db = await setupDatabase();
  const pool = pglitePool(db);
  const tenantApp = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool,
    logger: false,
  });
  const facilityApp = await buildApp({
    config: appConfig(actor(IDS.facilityAdmin, "facility_admin", [IDS.facilityA])),
    pool,
    logger: false,
  });
  try {
    const allStaff = await tenantApp.inject({ method: "GET", url: "/api/v1/staff" });
    assert.equal(allStaff.statusCode, 200);
    assert.deepEqual(
      new Set(allStaff.json().items.map((item) => item.membershipId)),
      new Set([
        IDS.adminMembership,
        IDS.facilityAdminMembership,
        IDS.sharedStaffMembership,
        IDS.otherStaffMembership,
        IDS.auditorMembership,
      ]),
    );

    const manageable = await facilityApp.inject({ method: "GET", url: "/api/v1/staff" });
    assert.equal(manageable.statusCode, 200);
    assert.deepEqual(
      manageable.json().items.map((item) => item.membershipId),
      [IDS.sharedStaffMembership],
    );
    assert.deepEqual(manageable.json().items[0].facilityIds, [IDS.facilityA]);

    const outsideFacility = await facilityApp.inject({
      method: "PATCH",
      url: `/api/v1/staff/${IDS.otherStaffMembership}`,
      headers: { "if-match": '"1"' },
      payload: { status: "suspended" },
    });
    assert.equal(outsideFacility.statusCode, 404);
  } finally {
    await tenantApp.close();
    await facilityApp.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("施設管理者は別施設も兼務する職員を閲覧・変更できない", async () => {
  const db = await setupDatabase();
  await db.exec("reset role");
  await db.query(
    `insert into public.membership_facilities (tenant_id, membership_id, facility_id)
     values ($1, $2, $3)`,
    [IDS.tenant, IDS.sharedStaffMembership, IDS.facilityB],
  );
  await db.exec("set role michinote_runtime");
  const facilityActor = actor(IDS.facilityAdmin, "facility_admin", [IDS.facilityA]);
  const app = await buildApp({
    config: appConfig(facilityActor),
    pool: pglitePool(db),
    logger: false,
  });
  try {
    const list = await app.inject({ method: "GET", url: "/api/v1/staff" });
    assert.equal(list.statusCode, 200);
    assert.equal(
      list.json().items.some((item) => item.membershipId === IDS.sharedStaffMembership),
      false,
    );

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/staff/${IDS.sharedStaffMembership}`,
      headers: { "if-match": '"1"' },
      payload: { status: "suspended", facilityIds: [IDS.facilityA] },
    });
    assert.equal(update.statusCode, 404);

    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.facilityAdmin],
    );
    try {
      await assert.rejects(
        db.query(
          "select app_private.update_staff_membership($1, 'support_staff', 'suspended', $2::uuid[], 1)",
          [IDS.sharedStaffMembership, [IDS.facilityA]],
        ),
        (error) => error?.code === "42501",
      );
    } finally {
      await db.exec("rollback");
    }

    await db.exec("reset role");
    const unchanged = await db.query(
      `select m.status, array_agg(mf.facility_id order by mf.facility_id) as facility_ids
       from public.memberships m
       join public.membership_facilities mf
         on mf.tenant_id = m.tenant_id and mf.membership_id = m.id
       where m.tenant_id = $1 and m.id = $2
       group by m.status`,
      [IDS.tenant, IDS.sharedStaffMembership],
    );
    assert.equal(unchanged.rows[0].status, "active");
    assert.deepEqual(unchanged.rows[0].facility_ids, [IDS.facilityA, IDS.facilityB]);

    await db.exec("set role michinote_runtime");
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [IDS.tenant, IDS.facilityAdmin],
    );
    const visibleUsers = await db.query("select id from public.app_users order by id");
    assert.deepEqual(visibleUsers.rows, [{ id: IDS.facilityAdmin }]);
    const visibleMemberships = await db.query("select id from public.memberships order by id");
    assert.deepEqual(visibleMemberships.rows, [{ id: IDS.facilityAdminMembership }]);
    await db.exec("rollback");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("停止した事業所は旧担当者のDBアクセス範囲から外れる", async () => {
  const db = await setupDatabase();
  await db.exec("reset role");
  await db.query(
    "update public.facilities set status = 'inactive' where tenant_id = $1 and id = $2",
    [IDS.tenant, IDS.facilityA],
  );
  await db.exec("set role michinote_runtime");
  await db.exec("begin");
  await db.query(
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [IDS.tenant, IDS.facilityAdmin],
  );
  try {
    const access = await db.query(
      "select app_private.can_access_facility($1) as allowed",
      [IDS.facilityA],
    );
    assert.equal(access.rows[0].allowed, false);
    const facilities = await db.query("select id from public.facilities");
    assert.deepEqual(facilities.rows, []);
  } finally {
    await db.exec("rollback");
    await db.exec("reset role");
    await db.close();
  }
});

test("DB確定後にCognito招待を行い、成功・既存利用者・失敗を安全に記録する", async () => {
  const db = await setupDatabase();
  const deliveries = [];
  let privateFailureRemaining = 1;
  const cognitoAdmin = {
    async inviteUser(input) {
      deliveries.push(input);
      if (input.email === "private.failure@example.invalid" && privateFailureRemaining > 0) {
        privateFailureRemaining -= 1;
        const error = new Error("private.failure@example.invalid should never be returned");
        error.name = "TooManyRequestsException";
        throw error;
      }
      return { username: `cognito-${deliveries.length}` };
    },
  };
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin,
    logger: false,
  });
  try {
    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-invite-new-0001" },
      payload: {
        email: "new.staff@example.invalid",
        displayName: "新規支援員",
        role: "support_staff",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(invited.statusCode, 201);
    assert.equal(invited.headers.etag, '"1"');
    assert.equal(invited.json().status, "invited");
    assert.equal(invited.json().invitation.status, "sent");
    assert.equal(deliveries.length, 1);

    const replayedInvite = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-invite-new-0001" },
      payload: {
        email: "new.staff@example.invalid",
        displayName: "新規支援員",
        role: "support_staff",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(replayedInvite.statusCode, 201);
    assert.equal(replayedInvite.headers["idempotency-replayed"], "true");
    assert.equal(replayedInvite.json().invitation.status, "sent");
    assert.equal(deliveries.length, 1, "送信記録済みの再試行ではCognitoを再実行しない");

    const existing = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-invite-existing-0001" },
      payload: {
        email: "existing@example.invalid",
        displayName: "既存Cognito職員",
        role: "plan_approver",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(existing.statusCode, 201);
    assert.equal(existing.json().status, "active");
    assert.equal(existing.json().invitation.status, "accepted");
    assert.equal(deliveries.length, 1, "既存の有効Cognito利用者へ外部招待を再送しない");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-invite-existing-0002" },
      payload: {
        email: "existing@example.invalid",
        displayName: "既存Cognito職員",
        role: "viewer",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, "STAFF_ALREADY_REGISTERED");

    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-invite-failure-0001" },
      payload: {
        email: "private.failure@example.invalid",
        displayName: "送信失敗職員",
        role: "viewer",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().error.code, "STAFF_INVITATION_DELIVERY_FAILED");
    assert.match(failed.json().error.details.membershipId, /^[0-9a-f-]{36}$/);
    assert.equal(failed.body.includes("private.failure@example.invalid"), false);

    const recovered = await app.inject({
      method: "POST",
      url: `/api/v1/staff/${failed.json().error.details.membershipId}/invitation-resends`,
      headers: { "idempotency-key": "staff-invite-resend-0001" },
      payload: {},
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().invitation.status, "sent");

    const explicitResend = await app.inject({
      method: "POST",
      url: `/api/v1/staff/${failed.json().error.details.membershipId}/invitation-resends`,
      headers: { "idempotency-key": "staff-invite-resend-0002" },
      payload: {},
    });
    assert.equal(explicitResend.statusCode, 200);
    assert.equal(deliveries.length, 4, "送信済みでも期限切れ復旧の明示操作ではCognitoへ再送する");

    const replayedResend = await app.inject({
      method: "POST",
      url: `/api/v1/staff/${failed.json().error.details.membershipId}/invitation-resends`,
      headers: { "idempotency-key": "staff-invite-resend-0002" },
      payload: {},
    });
    assert.equal(replayedResend.statusCode, 200);
    assert.equal(replayedResend.headers["idempotency-replayed"], "true");
    assert.equal(deliveries.length, 4, "同一操作キーの通信再試行ではCognitoへ二重送信しない");

    await db.exec("reset role");
    const failedRecord = await db.query(
      `select si.status, si.delivery_error_code, si.membership_id
       from public.staff_invitations si
       where si.email_snapshot = $1`,
      ["private.failure@example.invalid"],
    );
    assert.equal(failedRecord.rows[0].status, "sent");
    assert.equal(failedRecord.rows[0].delivery_error_code, null);
    const unsafeAudit = await db.query(
      "select count(*)::integer as count from public.audit_events where metadata::text like '%@%'",
    );
    assert.equal(unsafeAudit.rows[0].count, 0);
    const scopedInviteAudit = await db.query(
      `select distinct facility_id
       from public.audit_events
       where resource_type = 'staff_membership' and resource_id = $1`,
      [invited.json().membershipId],
    );
    assert.deepEqual(
      scopedInviteAudit.rows.map((row) => row.facility_id),
      [IDS.facilityA],
      "施設に影響する招待・送達監査は法人全体行にせず対象施設へ帰属させる",
    );
    await db.exec("set role michinote_runtime");

    const prematureActivation = await app.inject({
      method: "PATCH",
      url: `/api/v1/staff/${failedRecord.rows[0].membership_id}`,
      headers: { "if-match": '"1"' },
      payload: { status: "active" },
    });
    assert.equal(prematureActivation.statusCode, 409);
    assert.equal(prematureActivation.json().error.code, "STAFF_ACCOUNT_UNAVAILABLE");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("入力は422、楽観ロックと最後の法人管理者保護は409を返す", async () => {
  const db = await setupDatabase();
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin: { async inviteUser() { throw new Error("not called"); } },
    logger: false,
  });
  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-invite-invalid-0001" },
      payload: {
        email: "SECRET-NOT-AN-EMAIL",
        displayName: "不正入力",
        role: "support_staff",
        facilityIds: [],
      },
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.includes("SECRET-NOT-AN-EMAIL"), false);

    const suspended = await app.inject({
      method: "PATCH",
      url: `/api/v1/staff/${IDS.sharedStaffMembership}`,
      headers: { "if-match": '"1"' },
      payload: { status: "suspended" },
    });
    assert.equal(suspended.statusCode, 200, suspended.body);
    assert.equal(suspended.headers.etag, '"2"');
    assert.equal(suspended.json().status, "suspended");

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/staff/${IDS.sharedStaffMembership}`,
      headers: { "if-match": '"1"' },
      payload: { status: "active" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "EDIT_CONFLICT");

    const lastAdmin = await app.inject({
      method: "PATCH",
      url: `/api/v1/staff/${IDS.adminMembership}`,
      headers: { "if-match": '"1"' },
      payload: {
        role: "support_staff",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(lastAdmin.statusCode, 409);
    assert.equal(lastAdmin.json().error.code, "LAST_TENANT_ADMIN");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("concurrent staff invitation requests never deliver the Cognito invitation twice", async () => {
  const db = await setupDatabase();
  const deliveryStarted = createDeferred();
  const releaseDelivery = createDeferred();
  let deliveryCount = 0;
  let firstRequest;
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin: {
      async inviteUser() {
        deliveryCount += 1;
        if (deliveryCount === 1) {
          deliveryStarted.resolve();
          await releaseDelivery.promise;
        }
        return { username: `concurrent-invitation-user-${deliveryCount}` };
      },
    },
    logger: false,
  });
  const request = {
    method: "POST",
    url: "/api/v1/staff/invitations",
    headers: { "idempotency-key": "staff-invite-concurrent-0001" },
    payload: {
      email: "concurrent.staff@example.invalid",
      displayName: "Concurrent Staff",
      role: "support_staff",
      facilityIds: [IDS.facilityA],
    },
  };

  try {
    firstRequest = app.inject(request);
    await waitForDeferred(deliveryStarted, "the first Cognito invitation delivery");

    const secondResponse = await app.inject(request);
    assert.equal(secondResponse.statusCode, 409, secondResponse.body);
    assert.equal(
      secondResponse.json().error.code,
      "STAFF_INVITATION_DELIVERY_IN_PROGRESS",
    );
    assert.equal(deliveryCount, 1, "only the request holding the delivery claim may call Cognito");

    releaseDelivery.resolve();
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.statusCode, 201, firstResponse.body);
    assert.equal(firstResponse.json().invitation.status, "sent");

    const replayedResponse = await app.inject(request);
    assert.equal(replayedResponse.statusCode, 201, replayedResponse.body);
    assert.equal(replayedResponse.headers["idempotency-replayed"], "true");
    assert.equal(deliveryCount, 1, "a completed idempotent replay must not call Cognito");
  } finally {
    releaseDelivery.resolve();
    if (firstRequest) await Promise.allSettled([firstRequest]);
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("concurrent explicit invitation resends never deliver the Cognito invitation twice", async () => {
  const db = await setupDatabase();
  const resendStarted = createDeferred();
  const releaseResend = createDeferred();
  let deliveryCount = 0;
  let blockDelivery = false;
  let firstResend;
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin: {
      async inviteUser() {
        deliveryCount += 1;
        if (blockDelivery && deliveryCount === 2) {
          resendStarted.resolve();
          await releaseResend.promise;
        }
        return { username: `concurrent-resend-user-${deliveryCount}` };
      },
    },
    logger: false,
  });

  try {
    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-resend-setup-0001" },
      payload: {
        email: "concurrent.resend@example.invalid",
        displayName: "Concurrent Resend Staff",
        role: "support_staff",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(invited.statusCode, 201, invited.body);
    assert.equal(deliveryCount, 1);

    blockDelivery = true;
    const resendRequest = {
      method: "POST",
      url: `/api/v1/staff/${invited.json().membershipId}/invitation-resends`,
      headers: { "idempotency-key": "staff-resend-concurrent-0001" },
      payload: {},
    };
    firstResend = app.inject(resendRequest);
    await waitForDeferred(resendStarted, "the first explicit Cognito invitation resend");

    const secondResponse = await app.inject(resendRequest);
    assert.equal(secondResponse.statusCode, 409, secondResponse.body);
    assert.equal(
      secondResponse.json().error.code,
      "STAFF_INVITATION_DELIVERY_IN_PROGRESS",
    );
    assert.equal(deliveryCount, 2, "only one explicit resend may call Cognito while claimed");

    releaseResend.resolve();
    const firstResponse = await firstResend;
    assert.equal(firstResponse.statusCode, 200, firstResponse.body);
    assert.equal(firstResponse.json().invitation.status, "sent");

    const replayedResponse = await app.inject(resendRequest);
    assert.equal(replayedResponse.statusCode, 200, replayedResponse.body);
    assert.equal(replayedResponse.headers["idempotency-replayed"], "true");
    assert.equal(deliveryCount, 2, "a completed resend replay must not call Cognito");
  } finally {
    releaseResend.resolve();
    if (firstResend) await Promise.allSettled([firstResend]);
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("an expired in-flight invitation requires owner reconciliation before another delivery", async () => {
  const db = await setupDatabase();
  const deliveryStarted = createDeferred();
  const releaseUnknownDelivery = createDeferred();
  let deliveryCount = 0;
  let firstRequest;
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin: {
      async inviteUser() {
        deliveryCount += 1;
        if (deliveryCount === 1) {
          deliveryStarted.resolve();
          await releaseUnknownDelivery.promise;
          const error = new Error("simulated worker loss after the external request started");
          error.name = "TimeoutError";
          throw error;
        }
        return { username: `reconciled-invitation-user-${deliveryCount}` };
      },
    },
    logger: false,
  });
  const invitationRequest = {
    method: "POST",
    url: "/api/v1/staff/invitations",
    headers: { "idempotency-key": "staff-invite-ambiguous-0001" },
    payload: {
      email: "ambiguous.delivery@example.invalid",
      displayName: "Ambiguous Delivery Staff",
      role: "support_staff",
      facilityIds: [IDS.facilityA],
    },
  };

  try {
    firstRequest = app.inject(invitationRequest);
    await waitForDeferred(deliveryStarted, "the invitation whose outcome becomes unknown");

    await db.exec("reset role");
    const inProgress = await db.query(
      `select invitation_id, membership_id, status
       from app_private.staff_invitation_delivery_claims
       where tenant_id = $1 and idempotency_key = $2`,
      [IDS.tenant, "staff-invite-ambiguous-0001"],
    );
    assert.equal(inProgress.rows[0].status, "in_progress");
    await db.query(
      `update app_private.staff_invitation_delivery_claims
       set lease_expires_at = now() - interval '1 second'
       where tenant_id = $1 and invitation_id = $2`,
      [IDS.tenant, inProgress.rows[0].invitation_id],
    );
    await db.exec("set role michinote_runtime");

    const blockedRetry = await app.inject(invitationRequest);
    assert.equal(blockedRetry.statusCode, 409, blockedRetry.body);
    assert.equal(
      blockedRetry.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(deliveryCount, 1, "an ambiguous outcome must block every automatic Cognito retry");

    const reconciliationParameters = [
      IDS.tenant,
      inProgress.rows[0].invitation_id,
      IDS.admin,
      false,
      null,
      "DELIVERY_CONFIRMED_NOT_SENT",
      "INC-TEST-AMBIGUOUS-001",
    ];
    await assert.rejects(
      db.query(
        "select app_private.reconcile_staff_invitation_delivery_claim($1,$2,$3,$4,$5,$6,$7)",
        reconciliationParameters,
      ),
      (error) => error?.code === "42501",
      "the runtime role must not execute the break-glass reconciliation function",
    );

    await db.exec("reset role");
    await db.query(
      "select app_private.reconcile_staff_invitation_delivery_claim($1,$2,$3,$4,$5,$6,$7)",
      reconciliationParameters,
    );
    const reconciled = await db.query(
      `select claim.status as claim_status, invitation.status as invitation_status,
              claim.safe_error_code
       from app_private.staff_invitation_delivery_claims claim
       join public.staff_invitations invitation
         on invitation.tenant_id = claim.tenant_id and invitation.id = claim.invitation_id
       where claim.tenant_id = $1 and claim.invitation_id = $2`,
      [IDS.tenant, inProgress.rows[0].invitation_id],
    );
    assert.equal(reconciled.rows[0].claim_status, "failed");
    assert.equal(reconciled.rows[0].invitation_status, "failed");
    assert.equal(reconciled.rows[0].safe_error_code, "DELIVERY_CONFIRMED_NOT_SENT");
    await db.exec("set role michinote_runtime");

    releaseUnknownDelivery.resolve();
    const abandonedResponse = await firstRequest;
    assert.ok(abandonedResponse.statusCode >= 400, abandonedResponse.body);
    assert.equal(deliveryCount, 1);

    const recovered = await app.inject({
      method: "POST",
      url: `/api/v1/staff/${inProgress.rows[0].membership_id}/invitation-resends`,
      headers: { "idempotency-key": "staff-invite-after-reconcile-0001" },
      payload: {},
    });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().invitation.status, "sent");
    assert.equal(deliveryCount, 2, "a known-failed reconciliation permits one deliberate resend");
  } finally {
    try {
      await db.exec("set role michinote_runtime");
    } catch {
      // The database may already be closing after a failed assertion.
    }
    releaseUnknownDelivery.resolve();
    if (firstRequest) await Promise.allSettled([firstRequest]);
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("a TimeoutError on the initial invitation freezes same-key and cross-endpoint retries", async () => {
  const db = await setupDatabase();
  let deliveryCount = 0;
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin: {
      async inviteUser() {
        deliveryCount += 1;
        const error = new Error("remote Cognito acceptance may have preceded the response timeout");
        error.name = "TimeoutError";
        throw error;
      },
    },
    logger: false,
  });
  const invitationRequest = {
    method: "POST",
    url: "/api/v1/staff/invitations",
    headers: { "idempotency-key": "staff-invite-timeout-0001" },
    payload: {
      email: "timeout.initial@example.invalid",
      displayName: "Timeout Initial Staff",
      role: "support_staff",
      facilityIds: [IDS.facilityA],
    },
  };

  try {
    const timedOut = await app.inject(invitationRequest);
    assert.equal(timedOut.statusCode, 409, timedOut.body);
    assert.equal(
      timedOut.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    const membershipId = timedOut.json().error.details.membershipId;
    assert.match(membershipId, /^[0-9a-f-]{36}$/);
    assert.equal(deliveryCount, 1);

    const sameKeyRetry = await app.inject(invitationRequest);
    assert.equal(sameKeyRetry.statusCode, 409, sameKeyRetry.body);
    assert.equal(
      sameKeyRetry.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(deliveryCount, 1, "the original key must not repeat an ambiguous Cognito call");

    const differentKeyRetry = await app.inject({
      method: "POST",
      url: `/api/v1/staff/${membershipId}/invitation-resends`,
      headers: { "idempotency-key": "staff-invite-timeout-cross-0001" },
      payload: {},
    });
    assert.equal(differentKeyRetry.statusCode, 409, differentKeyRetry.body);
    assert.equal(
      differentKeyRetry.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(deliveryCount, 1, "a different key and endpoint must not bypass reconciliation");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});

test("a TimeoutError on an explicit resend freezes every resend idempotency key", async () => {
  const db = await setupDatabase();
  let deliveryCount = 0;
  let timeoutResends = false;
  const app = await buildApp({
    config: appConfig(actor(IDS.admin, "tenant_admin", [IDS.facilityA])),
    pool: pglitePool(db),
    cognitoAdmin: {
      async inviteUser() {
        deliveryCount += 1;
        if (timeoutResends) {
          const error = new Error("remote Cognito resend acceptance has an unknown outcome");
          error.name = "TimeoutError";
          throw error;
        }
        return { username: "timeout-resend-setup-user" };
      },
    },
    logger: false,
  });

  try {
    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/staff/invitations",
      headers: { "idempotency-key": "staff-timeout-resend-setup-0001" },
      payload: {
        email: "timeout.resend@example.invalid",
        displayName: "Timeout Resend Staff",
        role: "support_staff",
        facilityIds: [IDS.facilityA],
      },
    });
    assert.equal(invited.statusCode, 201, invited.body);
    assert.equal(deliveryCount, 1);

    timeoutResends = true;
    const resendRequest = {
      method: "POST",
      url: `/api/v1/staff/${invited.json().membershipId}/invitation-resends`,
      headers: { "idempotency-key": "staff-timeout-resend-0001" },
      payload: {},
    };
    const timedOut = await app.inject(resendRequest);
    assert.equal(timedOut.statusCode, 409, timedOut.body);
    assert.equal(
      timedOut.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(deliveryCount, 2);

    const sameKeyRetry = await app.inject(resendRequest);
    assert.equal(sameKeyRetry.statusCode, 409, sameKeyRetry.body);
    assert.equal(
      sameKeyRetry.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(deliveryCount, 2, "the timed-out resend key must not call Cognito again");

    const differentKeyRetry = await app.inject({
      ...resendRequest,
      headers: { "idempotency-key": "staff-timeout-resend-0002" },
    });
    assert.equal(differentKeyRetry.statusCode, 409, differentKeyRetry.body);
    assert.equal(
      differentKeyRetry.json().error.code,
      "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    );
    assert.equal(deliveryCount, 2, "no new resend key may bypass an ambiguous delivery claim");
  } finally {
    await app.close();
    await db.exec("reset role");
    await db.close();
  }
});
