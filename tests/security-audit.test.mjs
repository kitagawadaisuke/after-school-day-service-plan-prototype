import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { AppError } from "../server/errors.js";
import { piiReadDescriptor, writePiiReadAudit } from "../server/pii-read-audit.js";
import { authFailureReason, createSecurityAuthAudit } from "../server/security-auth-audit.js";
import { purgeSecurityRetention } from "../server/db/security-retention.js";
import { buildApp } from "../server/app.js";

const ACTOR = Object.freeze({
  tenantId: "038f1db5-c170-7c35-a784-3cfc6f98c101",
  userId: "038f1db5-c170-7c35-a784-3cfc6f98c201",
  facilityIds: ["038f1db5-c170-7c35-a784-3cfc6f98c301"],
  role: "viewer",
});

function request(overrides = {}) {
  return {
    id: "request-safe-id",
    method: "GET",
    routeOptions: { url: "/api/v1/children/:childId/daily-logs" },
    url: "/api/v1/children/private-value/daily-logs?status=private-value",
    params: { childId: "038f1db5-c170-7c35-a784-3cfc6f98c501" },
    query: { status: "private-search-value", limit: "30" },
    headers: { "user-agent": "Mozilla/5.0 Chrome/120.0 private-tail" },
    ip: "192.0.2.123",
    actor: ACTOR,
    ...overrides,
  };
}

test("PII閲覧監査は検索値や本文を保存せず、対象とフィルター名だけを記録する", async () => {
  const descriptor = piiReadDescriptor(request());
  assert.deepEqual(descriptor, {
    action: "pii.searched",
    resourceType: "daily_log",
    resourceId: "038f1db5-c170-7c35-a784-3cfc6f98c501",
    facilityId: ACTOR.facilityIds[0],
    metadata: {
      route: "/children/:id/daily-logs",
      queryFilterNames: ["status"],
    },
  });

  const calls = [];
  const client = {
    async query(sql, parameters = []) { calls.push({ sql, parameters }); return { rows: [] }; },
    release() {},
  };
  await writePiiReadAudit({
    db: { async connect() { return client; } },
    request: request(),
    config: { auditHashKey: "audit-test-key-that-is-at-least-32-chars" },
    descriptor,
  });
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes("private-search-value"), false);
  assert.equal(serialized.includes("192.0.2.123"), false);
  assert.match(serialized, /pii\.searched/);
  assert.match(serialized, /queryFilterNames/);

  const institutionDescriptor = piiReadDescriptor(request({
    routeOptions: { url: "/api/v1/institutions/:institutionId" },
    params: { institutionId: "038f1db5-c170-7c35-a784-3cfc6f98c601" },
    query: {},
  }));
  assert.deepEqual(institutionDescriptor, {
    action: "pii.read",
    resourceType: "institution",
    resourceId: "038f1db5-c170-7c35-a784-3cfc6f98c601",
    facilityId: ACTOR.facilityIds[0],
    metadata: {
      route: "/institutions/:id",
      queryFilterNames: [],
    },
  });

  assert.equal(piiReadDescriptor(request({
    routeOptions: { url: "/api/v1/children/:childId/documents/:documentId/snapshots/:snapshotId/content" },
    params: {
      childId: "038f1db5-c170-7c35-a784-3cfc6f98c501",
      documentId: "038f1db5-c170-7c35-a784-3cfc6f98c701",
      snapshotId: "038f1db5-c170-7c35-a784-3cfc6f98c702",
    },
    query: {},
  })).action, "pii.exported");

  const multiFacilityRequest = request({
    routeOptions: { url: "/api/v1/children/:childId" },
    query: { facilityId: "038f1db5-c170-7c35-a784-3cfc6f98c301" },
    actor: {
      ...ACTOR,
      facilityIds: [
        "038f1db5-c170-7c35-a784-3cfc6f98c301",
        "038f1db5-c170-7c35-a784-3cfc6f98c302",
      ],
    },
  });
  const scopedCalls = [];
  const scopedClient = {
    async query(sql, parameters = []) {
      scopedCalls.push({ sql, parameters });
      if (sql.includes("from public.children")) {
        return { rows: [{ facility_id: "038f1db5-c170-7c35-a784-3cfc6f98c302" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  await writePiiReadAudit({
    db: { async connect() { return scopedClient; } },
    request: multiFacilityRequest,
    config: { auditHashKey: "audit-test-key-that-is-at-least-32-chars" },
    descriptor: piiReadDescriptor(multiFacilityRequest),
  });
  const appendCall = scopedCalls.find((call) => call.sql.includes("append_audit_event"));
  assert.equal(appendCall.parameters[1], "038f1db5-c170-7c35-a784-3cfc6f98c302");
});

test("匿名ログイン失敗はIPをHMAC化し、理由を固定分類して記録する", async () => {
  const calls = [];
  const recorder = createSecurityAuthAudit({
    pool: { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [] }; } },
    config: { auditHashKey: "audit-test-key-that-is-at-least-32-chars" },
    idFactory: () => "038f1db5-c170-7c35-a784-3cfc6f98c901",
  });
  await recorder(request(), new AppError(400, "INVALID_AUTH_STATE", "safe"));
  assert.equal(authFailureReason({ code: "INVALID_AUTH_CALLBACK" }), "invalid_callback");
  assert.equal(calls[0].parameters[2], "invalid_state");
  assert.match(calls[0].parameters[3], /^[0-9a-f]{32}$/);
  assert.equal(calls[0].parameters[4], "Chrome 120");
  assert.equal(JSON.stringify(calls).includes("192.0.2.123"), false);
  assert.equal(JSON.stringify(calls).includes("private-tail"), false);
});

test("Cognito callback拒否は応答前にセキュリティ監査へ渡す", async () => {
  const failures = [];
  const config = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    appBaseUrl: "https://st.example.test",
    databaseUrl: undefined,
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "cognito",
    cookieSecret: "test-cookie-secret-that-is-at-least-32-characters-long",
    auditHashKey: "test-audit-key-that-is-at-least-32-characters",
    cognito: { sessionTtlSeconds: 43_200 },
    devActor: null,
  };
  const app = await buildApp({
    config,
    pool: null,
    cognitoAuth: {
      beginLogin() { throw new Error("not called"); },
      async completeLogin() { throw new Error("not called"); },
      async logout() { return { logoutUrl: "https://login.example/logout" }; },
    },
    recordSecurityAuthFailure: async (_request, error) => failures.push(error.code),
    authenticateRequest: async () => ACTOR,
    logger: false,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/auth/callback?error=access_denied" });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(failures, ["COGNITO_AUTH_FAILED"]);
  } finally {
    await app.close();
  }
});

test("認証監査はruntimeから追記のみで、400日後に固定方針で削除される", async () => {
  const db = new PGlite();
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  const names = (await readdir(migrationsUrl)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name)).sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
  await db.exec(await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"));
  await db.query(
    `insert into app_private.security_auth_events
       (id, occurred_at, request_id, reason, user_agent_family)
     values ('038f1db5-c170-7c35-a784-3cfc6f98c902', now() - interval '401 days', 'old', 'unknown', 'unknown')`,
  );
  await db.exec("set role michinote_runtime");
  await db.query(
    "select app_private.append_security_auth_event($1,$2,$3,$4,$5)",
    ["038f1db5-c170-7c35-a784-3cfc6f98c903", "current", "authentication_rejected", "a".repeat(32), "Chrome 120"],
  );
  await assert.rejects(
    () => db.query("select * from app_private.security_auth_events"),
    (error) => error.code === "42501",
  );
  const purged = await db.query("select app_private.purge_retired_security_auth_events(100) as deleted");
  assert.equal(Number(purged.rows[0].deleted), 1);
  await db.exec("reset role");
  const remaining = await db.query("select count(*)::integer as count from app_private.security_auth_events");
  assert.equal(remaining.rows[0].count, 1);
  await db.close();
});

test("セキュリティ保持workerは認証イベントと失効セッションをbounded batchで排出する", async () => {
  const counts = new Map([
    ["purge_retired_security_auth_events", [250, 2]],
    ["purge_retired_sessions", [3]],
  ]);
  const pool = {
    async query(sql) {
      const name = [...counts.keys()].find((candidate) => sql.includes(candidate));
      return { rows: [{ deleted: counts.get(name).shift() || 0 }] };
    },
  };
  assert.deepEqual(await purgeSecurityRetention(pool), { authEvents: 252, sessions: 3 });
});

test("施設管理者の監査一覧は担当施設の行だけを返し、法人全体行と別施設行を隠す", async () => {
  const db = new PGlite();
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  const names = (await readdir(migrationsUrl)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name)).sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
  await db.exec(await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"));

  const ids = {
    tenant: "048f1db5-c170-7c35-a784-3cfc6f98c101",
    tenantAdmin: "048f1db5-c170-7c35-a784-3cfc6f98c201",
    facilityAdmin: "048f1db5-c170-7c35-a784-3cfc6f98c202",
    facilityA: "048f1db5-c170-7c35-a784-3cfc6f98c301",
    facilityB: "048f1db5-c170-7c35-a784-3cfc6f98c302",
    tenantMembership: "048f1db5-c170-7c35-a784-3cfc6f98c401",
    facilityMembership: "048f1db5-c170-7c35-a784-3cfc6f98c402",
  };
  try {
    await db.query(
      "select app_private.provision_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [ids.tenant, "架空法人", ids.tenantAdmin, "audit-admin-sub", "audit-admin@example.invalid", "管理者", ids.tenantMembership, ids.facilityA, "A-01", "架空A事業所"],
    );
    await db.query(
      "insert into public.facilities (id, tenant_id, code, name) values ($1,$2,'B-01','架空B事業所')",
      [ids.facilityB, ids.tenant],
    );
    await db.query(
      `insert into public.app_users (id, cognito_sub, email, display_name, status)
       values ($1,'facility-admin-sub','facility-admin@example.invalid','施設管理者','active')`,
      [ids.facilityAdmin],
    );
    await db.query(
      `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
       values ($1,$2,$3,'facility_admin','active',now())`,
      [ids.facilityMembership, ids.tenant, ids.facilityAdmin],
    );
    await db.query(
      "insert into public.membership_facilities (tenant_id,membership_id,facility_id) values ($1,$2,$3)",
      [ids.tenant, ids.facilityMembership, ids.facilityA],
    );
    await db.query(
      `insert into public.audit_events
         (id,tenant_id,facility_id,actor_user_id,action,resource_type,request_id,outcome)
       values
         ('048f1db5-c170-7c35-a784-3cfc6f98c701',$1,null,$2,'tenant.global','organization','global','success'),
         ('048f1db5-c170-7c35-a784-3cfc6f98c702',$1,$3,$2,'pii.read','child','facility-a','success'),
         ('048f1db5-c170-7c35-a784-3cfc6f98c703',$1,$4,$2,'pii.read','child','facility-b','success')`,
      [ids.tenant, ids.tenantAdmin, ids.facilityA, ids.facilityB],
    );

    await db.exec("set role michinote_runtime");
    await db.exec("begin");
    await db.query(
      "select set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)",
      [ids.tenant, ids.facilityAdmin],
    );
    const visible = await db.query("select request_id from public.audit_events order by request_id");
    assert.deepEqual(visible.rows.map((row) => row.request_id), ["facility-a"]);
    await db.exec("rollback");
  } finally {
    await db.exec("reset role");
    await db.close();
  }
});
