import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildProvisioningCognitoClientOptions,
  buildProvisioningConnectionOptions,
  fingerprintOnboardingRequest,
  loadOnboardingInput,
  reconcileCognitoAdministrator,
  reconcileDatabaseTenant,
  runProvisioning,
} from "../scripts/provision-tenant.mjs";

const IDS = Object.freeze({
  operation: "018f1db5-c170-7c35-a784-3cfc6f989101",
  tenant: "018f1db5-c170-7c35-a784-3cfc6f989102",
  user: "018f1db5-c170-7c35-a784-3cfc6f989103",
  membership: "018f1db5-c170-7c35-a784-3cfc6f989104",
  facility: "018f1db5-c170-7c35-a784-3cfc6f989105",
  sub: "018f1db5-c170-7c35-a784-3cfc6f989106",
});

const INPUT_ENV = Object.freeze({
  COGNITO_USER_POOL_ID: "ap-northeast-3_example",
  ONBOARDING_OPERATION_ID: IDS.operation,
  ONBOARDING_ORGANIZATION_ID: IDS.tenant,
  ONBOARDING_ORGANIZATION_NAME: "架空法人みらい",
  ONBOARDING_ADMIN_USER_ID: IDS.user,
  ONBOARDING_ADMIN_EMAIL: "INITIAL.ADMIN@EXAMPLE.INVALID",
  ONBOARDING_ADMIN_DISPLAY_NAME: "架空 管理者",
  ONBOARDING_ADMIN_MEMBERSHIP_ID: IDS.membership,
  ONBOARDING_FACILITY_ID: IDS.facility,
  ONBOARDING_FACILITY_CODE: "MIRAI-01",
  ONBOARDING_FACILITY_NAME: "架空みらい事業所",
});

test("onboarding Cognito client disables SDK retries for non-idempotent invitations", () => {
  assert.deepEqual(
    buildProvisioningCognitoClientOptions({ AWS_REGION: "ap-northeast-3" }),
    { region: "ap-northeast-3", maxAttempts: 1 },
  );
});

function cognitoUser({
  username = "generated-internal-username",
  email = "initial.admin@example.invalid",
  emailVerified = "true",
  sub = IDS.sub,
  enabled = true,
  status = "FORCE_CHANGE_PASSWORD",
} = {}) {
  return {
    Username: username,
    Enabled: enabled,
    UserStatus: status,
    UserAttributes: [
      { Name: "sub", Value: sub },
      { Name: "email", Value: email },
      { Name: "email_verified", Value: emailVerified },
    ],
  };
}

class FakeCognito {
  constructor(user = null) {
    this.user = user;
    this.calls = [];
    this.deliveryCount = 0;
  }

  async send(command) {
    this.calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "AdminCreateUserCommand") {
      if (command.input.MessageAction === "RESEND") {
        if (!this.user) {
          const error = new Error("not found");
          error.name = "UserNotFoundException";
          throw error;
        }
        assert.equal(command.input.Username, this.user.Username);
        this.deliveryCount += 1;
        return { User: this.user };
      }
      if (this.user) {
        const error = new Error("already exists");
        error.name = "UsernameExistsException";
        throw error;
      }
      this.user = cognitoUser({ email: command.input.Username });
      this.deliveryCount += 1;
      return { User: this.user };
    }
    if (command.constructor.name === "AdminGetUserCommand") {
      if (!this.user) {
        const error = new Error("not found");
        error.name = "UserNotFoundException";
        throw error;
      }
      return this.user;
    }
    throw new Error("unexpected Cognito command");
  }
}

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationSql = await Promise.all(
  (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort()
    .map((name) => readFile(new URL(name, migrationsUrl), "utf8")),
);
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

async function cleanDatabase() {
  const database = new PGlite();
  for (const sql of migrationSql) await database.exec(sql);
  await database.exec(grantsSql);
  return database;
}

test("onboarding input canonicalizes email and fingerprints every accepted value", () => {
  const input = loadOnboardingInput(INPUT_ENV);
  assert.equal(input.administratorEmail, "initial.admin@example.invalid");
  const first = fingerprintOnboardingRequest(input, IDS.sub);
  const second = fingerprintOnboardingRequest(input, IDS.sub);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(
    first,
    fingerprintOnboardingRequest({ ...input, firstFacilityName: "別の架空事業所" }, IDS.sub),
  );
  assert.throws(
    () => loadOnboardingInput({ ...INPUT_ENV, ONBOARDING_ADMIN_DISPLAY_NAME: " 前後空白" }),
    /must be trimmed/,
  );
  assert.throws(
    () => loadOnboardingInput({ ...INPUT_ENV, ONBOARDING_FACILITY_ID: IDS.tenant }),
    /UUIDs must be distinct/,
  );
  assert.throws(
    () => loadOnboardingInput({ ...INPUT_ENV, ONBOARDING_RESEND_INVITATION: "yes" }),
    /must be true or false/,
  );
  assert.throws(
    () => loadOnboardingInput({ ...INPUT_ENV, ONBOARDING_RESEND_INVITATION: "true" }),
    /ONBOARDING_RESEND_EVENT_ID is required/,
  );
});

test("Cognito reconciliation accepts only the exact verified enabled identity", async () => {
  const existing = new FakeCognito(cognitoUser());
  const result = await reconcileCognitoAdministrator({
    cognitoClient: existing,
    userPoolId: INPUT_ENV.COGNITO_USER_POOL_ID,
    administratorEmail: "initial.admin@example.invalid",
  });
  assert.deepEqual(result, {
    cognitoSub: IDS.sub,
    cognitoUsername: "generated-internal-username",
    created: false,
    userStatus: "FORCE_CHANGE_PASSWORD",
  });
  assert.deepEqual(existing.calls.map((call) => call.name), ["AdminGetUserCommand"]);

  for (const user of [
    cognitoUser({ username: "" }),
    cognitoUser({ email: "different@example.invalid" }),
    cognitoUser({ emailVerified: "false" }),
    cognitoUser({ enabled: false }),
    cognitoUser({ status: "UNCONFIRMED" }),
  ]) {
    await assert.rejects(
      reconcileCognitoAdministrator({
        cognitoClient: new FakeCognito(user),
        userPoolId: INPUT_ENV.COGNITO_USER_POOL_ID,
        administratorEmail: "initial.admin@example.invalid",
      }),
      /does not match|allowed account state/,
    );
  }
});

test("Cognito-created then DB-crashed saga resumes without a second invitation or PII logs", async () => {
  const cognito = new FakeCognito();
  const logLines = [];
  const logger = { info(value) { logLines.push(value); } };
  const failedDatabase = {
    async query() {
      const error = new Error("injected database outage");
      error.code = "TEST_DB_DOWN";
      throw error;
    },
  };
  await assert.rejects(
    runProvisioning({
      env: INPUT_ENV,
      logger,
      cognitoClient: cognito,
      databaseClient: failedDatabase,
    }),
    /injected database outage/,
  );

  const successfulDatabase = {
    calls: [],
    async query(sql, parameters) {
      this.calls.push({ sql, parameters });
      return {
        rows: [{
          receipt: {
            outcome: "created",
            operationId: IDS.operation,
            tenantId: IDS.tenant,
            facilityId: IDS.facility,
          },
        }],
      };
    },
  };
  const receipt = await runProvisioning({
    env: INPUT_ENV,
    logger,
    cognitoClient: cognito,
    databaseClient: successfulDatabase,
  });
  assert.equal(receipt.outcome, "created");
  assert.deepEqual(cognito.calls.map((call) => call.name), [
    "AdminGetUserCommand",
    "AdminCreateUserCommand",
    "AdminGetUserCommand",
    "AdminGetUserCommand",
  ]);
  assert.equal(cognito.deliveryCount, 1);
  const logs = logLines.join("\n");
  assert.equal(logs.includes(INPUT_ENV.ONBOARDING_ADMIN_EMAIL), false);
  assert.equal(logs.includes("initial.admin@example.invalid"), false);
  assert.equal(logs.includes(INPUT_ENV.ONBOARDING_ADMIN_DISPLAY_NAME), false);
  assert.equal(logs.includes(INPUT_ENV.ONBOARDING_ORGANIZATION_NAME), false);
});

test("invitation recovery never creates a missing or different Cognito identity", async () => {
  const cognito = new FakeCognito();
  const database = { async query() { throw new Error("database must not be reached"); } };
  await assert.rejects(
    runProvisioning({
      env: {
        ...INPUT_ENV,
        ONBOARDING_RESEND_INVITATION: "true",
        ONBOARDING_RESEND_EVENT_ID: "018f1db5-c170-7c35-a784-3cfc6f989110",
      },
      logger: { info() {} },
      cognitoClient: cognito,
      databaseClient: database,
    }),
    /existing Cognito administrator is required/,
  );
  assert.deepEqual(cognito.calls.map((call) => call.name), ["AdminGetUserCommand"]);
  assert.equal(cognito.deliveryCount, 0);
});

test("clean database onboarding is atomic, immutable and exactly idempotent", async () => {
  const database = await cleanDatabase();
  try {
    const input = loadOnboardingInput(INPUT_ENV);
    const first = await reconcileDatabaseTenant({ databaseClient: database, input, cognitoSub: IDS.sub });
    const second = await reconcileDatabaseTenant({ databaseClient: database, input, cognitoSub: IDS.sub });
    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "unchanged");

    for (const [table, count] of [
      ["organizations", 1],
      ["facilities", 1],
      ["app_users", 1],
      ["memberships", 1],
      ["membership_facilities", 1],
      ["audit_events", 1],
    ]) {
      const result = await database.query(`select count(*)::integer as count from public.${table}`);
      assert.equal(result.rows[0].count, count, table);
    }
    const receiptCount = await database.query(
      "select count(*)::integer as count from app_private.tenant_provisioning_receipts",
    );
    assert.equal(receiptCount.rows[0].count, 1);
    const receiptColumns = await database.query(
      `select column_name
       from information_schema.columns
       where table_schema = 'app_private'
         and table_name = 'tenant_provisioning_receipts'
       order by ordinal_position`,
    );
    assert.deepEqual(receiptColumns.rows.map((row) => row.column_name), [
      "operation_id",
      "request_fingerprint",
      "organization_id",
      "administrator_user_id",
      "administrator_membership_id",
      "first_facility_id",
      "completed_at",
    ]);

    const audit = await database.query(
      `select actor_user_id, request_id, action, metadata
       from public.audit_events where id = $1`,
      [IDS.operation],
    );
    assert.equal(audit.rows[0].actor_user_id, null);
    assert.equal(audit.rows[0].request_id, "initial-tenant-onboarding");
    assert.equal(audit.rows[0].action, "tenant.initial_provisioning_completed");
    const serializedAudit = JSON.stringify(audit.rows[0]);
    assert.equal(serializedAudit.includes("initial.admin@example.invalid"), false);
    assert.equal(serializedAudit.includes(INPUT_ENV.ONBOARDING_ADMIN_DISPLAY_NAME), false);

    await assert.rejects(
      reconcileDatabaseTenant({
        databaseClient: database,
        input: { ...input, organizationName: "差分のある架空法人" },
        cognitoSub: IDS.sub,
      }),
      /does not match its completed request/,
    );
    await assert.rejects(
      reconcileDatabaseTenant({
        databaseClient: database,
        input: { ...input, operationId: "018f1db5-c170-7c35-a784-3cfc6f989107" },
        cognitoSub: IDS.sub,
      }),
      /identifiers conflict with existing data/,
    );
    await assert.rejects(
      database.query(
        "update app_private.tenant_provisioning_receipts set completed_at = now() where operation_id = $1",
        [IDS.operation],
      ),
      /immutable/,
    );
  } finally {
    await database.close();
  }
});

test("explicit invitation recovery resends once, audits without PII, and CONFIRMED is a no-op", async () => {
  const database = await cleanDatabase();
  const cognito = new FakeCognito();
  const logs = [];
  const logger = { info(value) { logs.push(value); } };
  const resendEventId = "018f1db5-c170-7c35-a784-3cfc6f989108";
  const confirmedEventId = "018f1db5-c170-7c35-a784-3cfc6f989109";
  try {
    await runProvisioning({ env: INPUT_ENV, logger, cognitoClient: cognito, databaseClient: database });
    assert.equal(cognito.deliveryCount, 1, "the initial invitation is delivered once");

    const resendEnv = {
      ...INPUT_ENV,
      ONBOARDING_RESEND_INVITATION: "true",
      ONBOARDING_RESEND_EVENT_ID: resendEventId,
    };
    const resent = await runProvisioning({
      env: resendEnv,
      logger,
      cognitoClient: cognito,
      databaseClient: database,
    });
    assert.equal(resent.invitationResendOutcome, "success");
    assert.equal(cognito.deliveryCount, 2);
    const resendCommand = cognito.calls.find((call) => call.input.MessageAction === "RESEND");
    assert.ok(resendCommand);
    assert.equal(resendCommand.input.Username, "generated-internal-username");

    const repeated = await runProvisioning({
      env: resendEnv,
      logger,
      cognitoClient: cognito,
      databaseClient: database,
    });
    assert.equal(repeated.invitationResendOutcome, "unchanged");
    assert.equal(cognito.deliveryCount, 2, "same resend event must never send twice");

    await assert.rejects(
      runProvisioning({
        env: {
          ...resendEnv,
          ONBOARDING_ORGANIZATION_NAME: "差分のある架空法人",
          ONBOARDING_RESEND_EVENT_ID: "018f1db5-c170-7c35-a784-3cfc6f989111",
        },
        logger,
        cognitoClient: cognito,
        databaseClient: database,
      }),
      /does not match its completed request/,
    );
    assert.equal(cognito.deliveryCount, 2, "changed payload is rejected before AWS resend");

    cognito.user.UserStatus = "CONFIRMED";
    const confirmed = await runProvisioning({
      env: {
        ...resendEnv,
        ONBOARDING_RESEND_EVENT_ID: confirmedEventId,
      },
      logger,
      cognitoClient: cognito,
      databaseClient: database,
    });
    assert.equal(confirmed.invitationResendOutcome, "not_required");
    assert.equal(cognito.deliveryCount, 2, "confirmed accounts do not receive an invitation");

    const audit = await database.query(
      `select action, outcome, metadata
       from public.audit_events
       where action like 'tenant.initial_admin_invitation_resend_%'
       order by occurred_at, id`,
    );
    assert.equal(audit.rows.filter((row) =>
      row.action === "tenant.initial_admin_invitation_resend_requested").length, 2);
    assert.deepEqual(
      audit.rows
        .filter((row) => row.action === "tenant.initial_admin_invitation_resend_completed")
        .map((row) => row.metadata.result)
        .sort(),
      ["not_required", "success"],
    );
    const serialized = `${JSON.stringify(audit.rows)}\n${logs.join("\n")}`;
    assert.equal(serialized.includes("initial.admin@example.invalid"), false);
    assert.equal(serialized.includes(INPUT_ENV.ONBOARDING_ADMIN_DISPLAY_NAME), false);
    assert.equal(serialized.includes(IDS.sub), false);
  } finally {
    await database.close();
  }
});

test("provisioner role can call only receipt-backed onboarding functions, not tables or legacy bootstrap", async () => {
  const database = await cleanDatabase();
  try {
    const privileges = await database.query(`
      select
        has_schema_privilege('michinote_provisioner', 'app_private', 'usage') as schema_usage,
        has_table_privilege('michinote_provisioner', 'public.organizations', 'select') as organizations_select,
        has_table_privilege('michinote_provisioner', 'app_private.tenant_provisioning_receipts', 'select') as receipt_select,
        has_function_privilege(
          'michinote_provisioner',
          'app_private.provision_tenant(uuid,text,uuid,text,text,text,uuid,uuid,text,text)',
          'execute'
        ) as legacy_execute,
        has_function_privilege(
          'michinote_provisioner',
          'app_private.reconcile_initial_tenant(uuid,text,uuid,text,uuid,text,text,text,uuid,uuid,text,text)',
          'execute'
        ) as reconcile_execute,
        has_function_privilege(
          'michinote_provisioner',
          'app_private.current_tenant_id()',
          'execute'
        ) as unrelated_execute,
        has_function_privilege(
          'michinote_provisioner',
          'app_private.claim_initial_admin_invitation_resend(uuid,uuid)',
          'execute'
        ) as resend_claim_execute,
        has_function_privilege(
          'michinote_provisioner',
          'app_private.record_initial_admin_invitation_resend_result(uuid,uuid,uuid,text)',
          'execute'
        ) as resend_result_execute
    `);
    assert.deepEqual(privileges.rows[0], {
      schema_usage: true,
      organizations_select: false,
      receipt_select: false,
      legacy_execute: false,
      reconcile_execute: true,
      unrelated_execute: false,
      resend_claim_execute: true,
      resend_result_execute: true,
    });

    await database.exec("set role michinote_provisioner");
    try {
      const receipt = await reconcileDatabaseTenant({
        databaseClient: database,
        input: loadOnboardingInput(INPUT_ENV),
        cognitoSub: IDS.sub,
      });
      assert.equal(receipt.outcome, "created");
      await assert.rejects(
        database.query(
          `select app_private.provision_tenant(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           )`,
          [
            IDS.tenant,
            "架空法人みらい",
            IDS.user,
            IDS.sub,
            "initial.admin@example.invalid",
            "架空 管理者",
            IDS.membership,
            IDS.facility,
            "MIRAI-01",
            "架空みらい事業所",
          ],
        ),
        /permission denied/i,
      );
      await assert.rejects(
        database.query("select count(*) from public.organizations"),
        /permission denied/i,
      );
    } finally {
      await database.exec("reset role");
    }
  } finally {
    await database.close();
  }
});

test("provisioning database connection pins CA verification and never builds a URL", async () => {
  const ca = "-----BEGIN CERTIFICATE-----\nZmFrZS1vbmJvYXJkaW5nLWNh\n-----END CERTIFICATE-----\n";
  const env = {
    PROVISION_DATABASE_HOST: "database.private.example",
    PROVISION_DATABASE_PORT: "5432",
    PROVISION_DATABASE_NAME: "michinote",
    PROVISION_DATABASE_USER: "michinote_provisioner",
    PROVISION_DATABASE_PASSWORD: "provisioner-password-with-at-least-thirty-two-characters",
    PROVISION_DATABASE_SSL: "require",
    PROVISION_DATABASE_CA_FILE: "/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem",
  };
  const options = await buildProvisioningConnectionOptions(env, {
    readFileImpl: async () => ca,
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca });
  assert.equal(options.user, "michinote_provisioner");
  assert.equal(Object.hasOwn(options, "connectionString"), false);
  await assert.rejects(
    buildProvisioningConnectionOptions(
      { ...env, PROVISION_DATABASE_CA_FILE: undefined },
      { readFileImpl: async () => ca },
    ),
    /PROVISION_DATABASE_CA_FILE is required/,
  );
});
