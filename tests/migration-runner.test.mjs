import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  applyMigrationSource,
  buildMigrationConnectionOptions,
  createPostgresScramVerifier,
  runMigrations,
  unwrapMigrationTransaction,
} from "../scripts/migrate.mjs";

const RUNTIME_LOGIN = Object.freeze({
  user: "michinote_runtime",
  password: "runtime-secret-value-that-is-never-logged-1234567890",
});
const PROVISIONER_LOGIN = Object.freeze({
  user: "michinote_provisioner",
  password: "provisioner-secret-value-that-is-never-logged-1234567890",
});
const PDF_FINALIZATION_SECRET = "P".repeat(64);

function fakeMigrationClient() {
  const history = new Map();
  const executedSources = [];
  const calls = [];
  return {
    history,
    executedSources,
    calls,
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select sha256 from public.michinote_schema_migrations")) {
        const value = history.get(parameters[0]);
        return { rows: value ? [{ sha256: value }] : [] };
      }
      if (normalized.startsWith("insert into public.michinote_schema_migrations")) {
        history.set(parameters[0], parameters[1]);
        return { rows: [] };
      }
      if (normalized.startsWith("select 'migration-") || normalized.startsWith("select 'repeatable-")) {
        executedSources.push(sql);
      }
      return { rows: [] };
    },
  };
}

test("版付きマイグレーションは一度だけ、repeatable grantsはchecksum変更時だけ再適用する", async () => {
  const client = fakeMigrationClient();
  const silentLogger = { info() {} };
  const base = [
    { name: "0001_base.sql", sql: "select 'migration-v1'", sha256: "a".repeat(64), repeatable: false },
    { name: "R__runtime-grants.sql", sql: "select 'repeatable-v1'", sha256: "b".repeat(64), repeatable: true },
  ];

  await runMigrations({ client, sources: base, logger: silentLogger, runtimeLogin: RUNTIME_LOGIN, provisionerLogin: PROVISIONER_LOGIN, pdfFinalizationSecret: PDF_FINALIZATION_SECRET });
  assert.equal(client.executedSources.length, 2);
  await runMigrations({ client, sources: base, logger: silentLogger, runtimeLogin: RUNTIME_LOGIN, provisionerLogin: PROVISIONER_LOGIN, pdfFinalizationSecret: PDF_FINALIZATION_SECRET });
  assert.equal(client.executedSources.length, 2);

  await runMigrations({
    client,
    sources: [base[0], { ...base[1], sql: "select 'repeatable-v2'", sha256: "c".repeat(64) }],
    logger: silentLogger,
    runtimeLogin: RUNTIME_LOGIN,
    provisionerLogin: PROVISIONER_LOGIN,
    pdfFinalizationSecret: PDF_FINALIZATION_SECRET,
  });
  assert.equal(client.executedSources.length, 3);
  assert.match(client.executedSources.at(-1), /repeatable-v2/);
});

test("適用済みの版付きSQLが書き換えられた場合は起動前に拒否する", async () => {
  const client = fakeMigrationClient();
  const source = {
    name: "0001_base.sql",
    sql: "select 'migration-v1'",
    sha256: "a".repeat(64),
    repeatable: false,
  };
  await runMigrations({ client, sources: [source], logger: { info() {} }, runtimeLogin: RUNTIME_LOGIN, provisionerLogin: PROVISIONER_LOGIN, pdfFinalizationSecret: PDF_FINALIZATION_SECRET });
  await assert.rejects(
    runMigrations({
      client,
      sources: [{ ...source, sql: "select 'migration-mutated'", sha256: "d".repeat(64) }],
      logger: { info() {} },
      runtimeLogin: RUNTIME_LOGIN,
      provisionerLogin: PROVISIONER_LOGIN,
      pdfFinalizationSecret: PDF_FINALIZATION_SECRET,
    }),
    /checksum changed: 0001_base\.sql/,
  );
});

test("runtime and provisioner secrets are converted to SCRAM and passed only as bind values", async () => {
  const client = fakeMigrationClient();
  const logs = [];
  await runMigrations({
    client,
    sources: [{
      name: "R__runtime-grants.sql",
      sql: "select 'repeatable-runtime-grants'",
      sha256: "e".repeat(64),
      repeatable: true,
    }],
    runtimeLogin: RUNTIME_LOGIN,
    provisionerLogin: PROVISIONER_LOGIN,
    pdfFinalizationSecret: PDF_FINALIZATION_SECRET,
    logger: { info(value) { logs.push(value); } },
  });

  const configure = client.calls.find(({ sql }) =>
    sql === "select app_private.configure_runtime_login($1)");
  assert.ok(configure);
  assert.equal(configure.parameters.length, 1);
  assert.match(configure.parameters[0], /^SCRAM-SHA-256\$4096:/);
  assert.equal(configure.parameters[0].includes(RUNTIME_LOGIN.password), false);
  assert.equal(client.calls.some(({ sql }) => sql.includes(RUNTIME_LOGIN.password)), false);
  assert.equal(JSON.stringify(logs).includes(RUNTIME_LOGIN.password), false);
  const provisionerConfigure = client.calls.find(({ sql }) =>
    sql === "select app_private.configure_provisioner_login($1)");
  assert.ok(provisionerConfigure);
  assert.match(provisionerConfigure.parameters[0], /^SCRAM-SHA-256\$4096:/);
  assert.equal(provisionerConfigure.parameters[0].includes(PROVISIONER_LOGIN.password), false);
  assert.equal(JSON.stringify(client.calls).includes(PROVISIONER_LOGIN.password), false);
  assert.equal(JSON.stringify(logs).includes(PROVISIONER_LOGIN.password), false);
  const finalizationConfigure = client.calls.find(({ sql }) =>
    sql === "select app_private.configure_document_snapshot_finalization($1)");
  assert.ok(finalizationConfigure);
  assert.deepEqual(finalizationConfigure.parameters, [PDF_FINALIZATION_SECRET]);
  assert.equal(PDF_FINALIZATION_SECRET.includes(RUNTIME_LOGIN.password), false);
  assert.equal(JSON.stringify(logs).includes(PDF_FINALIZATION_SECRET), false);
  assert.ok(client.calls.some(({ sql }) => sql === "set local log_parameter_max_length = 0"));
  assert.ok(client.calls.some(({ sql }) => sql === "set local log_parameter_max_length_on_error = 0"));
  assert.ok(logs.some((entry) => /runtime_database_login_configured/.test(entry)));
  assert.match(logs.at(-1), /provisioner_database_login_configured/);
});

test("SCRAM verifier is deterministic for an explicit salt and contains no plaintext", () => {
  const verifier = createPostgresScramVerifier(RUNTIME_LOGIN.password, {
    salt: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    iterations: 4096,
  });
  assert.equal(
    verifier,
    "SCRAM-SHA-256$4096:ABEiM0RVZneImaq7zN3u/w==$NWZ8FxxjjHV40u4fxG99PRpKZzM5aQgJTW5/NLDW/aM=:fPrblV4WCUXpDSKKO9Lm8hGWY8LUwLLO6zx2MOpDtQQ=",
  );
  assert.equal(verifier.includes(RUNTIME_LOGIN.password), false);
});

test("runtime login contract rejects another role or a weak password before DB access", async () => {
  for (const runtimeLogin of [
    { user: "michinote_admin", password: RUNTIME_LOGIN.password },
    { user: "michinote_runtime", password: "too-short" },
  ]) {
    const client = fakeMigrationClient();
    await assert.rejects(
      runMigrations({ client, sources: [], logger: { info() {} }, runtimeLogin, provisionerLogin: PROVISIONER_LOGIN, pdfFinalizationSecret: PDF_FINALIZATION_SECRET }),
      /RUNTIME_DATABASE_USER|RUNTIME_DATABASE_PASSWORD/,
    );
    assert.equal(client.calls.length, 0);
  }
});

test("provisioner login contract rejects another role or a weak password before DB access", async () => {
  for (const provisionerLogin of [
    { user: "michinote_runtime", password: PROVISIONER_LOGIN.password },
    { user: "michinote_provisioner", password: "too-short" },
  ]) {
    const client = fakeMigrationClient();
    await assert.rejects(
      runMigrations({
        client,
        sources: [],
        logger: { info() {} },
        runtimeLogin: RUNTIME_LOGIN,
        provisionerLogin,
        pdfFinalizationSecret: PDF_FINALIZATION_SECRET,
      }),
      /PROVISION_DATABASE_USER|PROVISION_DATABASE_PASSWORD/,
    );
    assert.equal(client.calls.length, 0);
  }
});

test("PDF finalization key must be independent and valid before DB access", async () => {
  for (const pdfFinalizationSecret of ["too-short", "R".repeat(64)]) {
    const runtimeLogin = pdfFinalizationSecret === "too-short"
      ? RUNTIME_LOGIN
      : { ...RUNTIME_LOGIN, password: pdfFinalizationSecret };
    const client = fakeMigrationClient();
    await assert.rejects(
      runMigrations({
        client,
        sources: [],
        logger: { info() {} },
        runtimeLogin,
        provisionerLogin: PROVISIONER_LOGIN,
        pdfFinalizationSecret,
      }),
      /PDF finalization secret|PDF_FINALIZATION_SECRET/,
    );
    assert.equal(client.calls.length, 0);
  }
});

test("migration runner owns the only transaction and rolls back DDL with failed history", async () => {
  const wrapped = "-- migration comment\nbegin;\ncreate table public.atomic_probe (id integer);\ncommit;\n";
  const unwrapped = unwrapMigrationTransaction(wrapped);
  assert.doesNotMatch(unwrapped, /^\s*(begin|commit)\s*;/im);
  assert.match(unwrapped, /create table public\.atomic_probe/);
  assert.throws(
    () => unwrapMigrationTransaction("begin;\nselect 1;\ncommit;\ncommit;"),
    /unsupported transaction control/,
  );

  const database = new PGlite();
  try {
    await database.exec(`
      create table public.michinote_schema_migrations (
        name text primary key,
        sha256 text not null,
        applied_at timestamptz not null default now()
      )
    `);
    const client = {
      async query(sql, parameters) {
        if (/insert into public\.michinote_schema_migrations/i.test(sql)) {
          const error = new Error("injected history failure");
          error.code = "TEST_FAILURE";
          throw error;
        }
        return database.query(sql, parameters);
      },
    };
    await assert.rejects(
      applyMigrationSource(client, {
        name: "9999_atomic_probe.sql",
        sql: wrapped,
        sha256: "f".repeat(64),
        repeatable: false,
      }),
      /injected history failure/,
    );
    const probe = await database.query("select to_regclass('public.atomic_probe') as relation");
    assert.equal(probe.rows[0].relation, null);
  } finally {
    await database.close();
  }
});

test("runtime grants keep bootstrap owner-only and never embed a credential", async () => {
  const sql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");
  assert.match(sql, /create role michinote_runtime nologin noinherit nobypassrls/i);
  assert.match(sql, /configure_runtime_login\(runtime_verifier text\)/i);
  assert.match(sql, /configure_provisioner_login\(provisioner_verifier text\)/i);
  assert.match(sql, /session_user <> current_user/i);
  assert.match(sql, /runtime_role\.rolsuper/i);
  assert.match(sql, /runtime_role\.rolcreatedb/i);
  assert.match(sql, /runtime_role\.rolcreaterole/i);
  assert.match(sql, /runtime_role\.rolreplication/i);
  assert.match(sql, /runtime_role\.rolbypassrls/i);
  assert.match(sql, /pg_catalog\.pg_auth_members/i);
  assert.match(sql, /alter role %I with login noinherit password %L/i);
  assert.match(sql, /revoke all on function app_private\.configure_runtime_login\(text\)/i);
  assert.match(sql, /revoke all on function app_private\.configure_provisioner_login\(text\)/i);
  assert.match(sql, /grant execute on function app_private\.reconcile_initial_tenant/i);
  assert.match(sql, /revoke all on function app_private\.provision_tenant/i);
  assert.ok(
    sql.lastIndexOf("grant execute on function app_private.resolve_local_login")
      > sql.lastIndexOf("revoke all on all functions in schema app_private"),
    "local-login function grants must follow the blanket private-function revoke",
  );
  assert.equal(sql.includes(RUNTIME_LOGIN.password), false);
});

test("runtime login bootstrap succeeds on a clean database with only least-privilege attributes", async () => {
  const database = new PGlite();
  try {
    const migrationsUrl = new URL("../db/migrations/", import.meta.url);
    const names = (await readdir(migrationsUrl))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
      .sort();
    for (const name of names) {
      await database.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
    }
    await database.exec(await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"));

    const before = await database.query(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       from pg_catalog.pg_roles where rolname = 'michinote_runtime'`,
    );
    assert.deepEqual(before.rows, [{
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    }]);
    const provisionerBefore = await database.query(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       from pg_catalog.pg_roles where rolname = 'michinote_provisioner'`,
    );
    assert.deepEqual(provisionerBefore.rows, [{ ...before.rows[0] }]);

    const verifier = createPostgresScramVerifier(RUNTIME_LOGIN.password);
    await database.query("select app_private.configure_runtime_login($1)", [verifier]);
    const after = await database.query(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       from pg_catalog.pg_roles where rolname = 'michinote_runtime'`,
    );
    assert.deepEqual(after.rows, [{ ...before.rows[0], rolcanlogin: true }]);
    await database.query(
      "select app_private.configure_provisioner_login($1)",
      [createPostgresScramVerifier(PROVISIONER_LOGIN.password)],
    );
    const provisionerAfter = await database.query(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       from pg_catalog.pg_roles where rolname = 'michinote_provisioner'`,
    );
    assert.deepEqual(provisionerAfter.rows, [{ ...before.rows[0], rolcanlogin: true }]);
  } finally {
    await database.close();
  }
});

test("runtime and provisioner LOGIN changes roll back together when either configuration fails", async () => {
  const database = new PGlite();
  try {
    const migrationsUrl = new URL("../db/migrations/", import.meta.url);
    const names = (await readdir(migrationsUrl))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
      .sort();
    for (const name of names) {
      await database.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
    }
    await database.exec(await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"));
    const client = {
      async query(sql, parameters) {
        if (sql === "select app_private.configure_provisioner_login($1)") {
          const error = new Error("injected provisioner configuration failure");
          error.code = "TEST_FAILURE";
          throw error;
        }
        return database.query(sql, parameters);
      },
    };

    await assert.rejects(
      runMigrations({
        client,
        sources: [],
        logger: { info() {} },
        runtimeLogin: RUNTIME_LOGIN,
        provisionerLogin: PROVISIONER_LOGIN,
        pdfFinalizationSecret: PDF_FINALIZATION_SECRET,
      }),
      /injected provisioner configuration failure/,
    );
    const roles = await database.query(
      `select rolname, rolcanlogin
       from pg_catalog.pg_roles
       where rolname in ('michinote_runtime', 'michinote_provisioner')
       order by rolname`,
    );
    assert.deepEqual(roles.rows, [
      { rolname: "michinote_provisioner", rolcanlogin: false },
      { rolname: "michinote_runtime", rolcanlogin: false },
    ]);
  } finally {
    await database.close();
  }
});

test("migration connection requires and verifies the same pinned RDS CA bundle", async () => {
  const ca = "-----BEGIN CERTIFICATE-----\nZmFrZS1yZHMtY2E=\n-----END CERTIFICATE-----\n";
  const env = {
    MIGRATION_DATABASE_HOST: "database.private.example",
    MIGRATION_DATABASE_PORT: "5432",
    MIGRATION_DATABASE_NAME: "michinote",
    MIGRATION_DATABASE_USER: "michinote_admin",
    MIGRATION_DATABASE_PASSWORD: "master-secret-value",
    MIGRATION_DATABASE_SSL: "require",
    MIGRATION_DATABASE_CA_FILE: "/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem",
  };
  const reads = [];
  const options = await buildMigrationConnectionOptions(env, {
    async readFileImpl(path, encoding) {
      reads.push({ path, encoding });
      return ca;
    },
  });
  assert.deepEqual(reads, [{ path: env.MIGRATION_DATABASE_CA_FILE, encoding: "utf8" }]);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca });
  assert.equal(Object.hasOwn(options, "connectionString"), false);

  const { MIGRATION_DATABASE_CA_FILE: _omitted, ...missingCa } = env;
  await assert.rejects(
    buildMigrationConnectionOptions(missingCa, { readFileImpl: async () => ca }),
    /MIGRATION_DATABASE_CA_FILE is required/,
  );
  await assert.rejects(
    buildMigrationConnectionOptions(env, { readFileImpl: async () => "not-a-pem" }),
    /not a PEM certificate bundle/,
  );
});
