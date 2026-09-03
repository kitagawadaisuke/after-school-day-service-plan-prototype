import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertPdfFinalizationSecret } from "../server/security/pdf-finalization.js";

const { Client } = pg;
const MIGRATION_LOCK_NAME = "michinote-schema-migrations-v1";
const DEFAULT_RUNTIME_ROLE_NAME = "michinote_runtime";
const DEFAULT_PROVISIONER_ROLE_NAME = "michinote_provisioner";
const DATABASE_ROLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SCRAM_ITERATIONS = 4096;
const migrationsDirectory = new URL("../db/migrations/", import.meta.url);

function requiredEnvironment(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function checksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function runtimeLoginFromEnvironment() {
  return {
    user: requiredEnvironment("RUNTIME_DATABASE_USER"),
    password: requiredEnvironment("RUNTIME_DATABASE_PASSWORD"),
  };
}

function provisionerLoginFromEnvironment() {
  return {
    user: requiredEnvironment("PROVISION_DATABASE_USER"),
    password: requiredEnvironment("PROVISION_DATABASE_PASSWORD"),
  };
}

function validateRuntimeLogin(runtimeLogin, roleName = DEFAULT_RUNTIME_ROLE_NAME) {
  if (!DATABASE_ROLE_NAME_PATTERN.test(roleName)) {
    throw new Error("RUNTIME_DATABASE_USER is not a valid PostgreSQL role name");
  }
  if (!runtimeLogin || runtimeLogin.user !== roleName) {
    throw new Error(`RUNTIME_DATABASE_USER must be ${roleName}`);
  }
  if (
    typeof runtimeLogin.password !== "string"
    || runtimeLogin.password.length < 32
    || runtimeLogin.password.length > 1024
    || runtimeLogin.password.includes("\0")
  ) {
    throw new Error("RUNTIME_DATABASE_PASSWORD must contain between 32 and 1024 safe characters");
  }
  return runtimeLogin;
}

function validateProvisionerLogin(provisionerLogin, roleName = DEFAULT_PROVISIONER_ROLE_NAME) {
  if (!DATABASE_ROLE_NAME_PATTERN.test(roleName)) {
    throw new Error("PROVISION_DATABASE_USER is not a valid PostgreSQL role name");
  }
  if (!provisionerLogin || provisionerLogin.user !== roleName) {
    throw new Error(`PROVISION_DATABASE_USER must be ${roleName}`);
  }
  if (
    typeof provisionerLogin.password !== "string"
    || provisionerLogin.password.length < 32
    || provisionerLogin.password.length > 1024
    || provisionerLogin.password.includes("\0")
  ) {
    throw new Error("PROVISION_DATABASE_PASSWORD must contain between 32 and 1024 safe characters");
  }
  return provisionerLogin;
}

export function createPostgresScramVerifier(password, {
  salt = randomBytes(16),
  iterations = SCRAM_ITERATIONS,
} = {}) {
  if (typeof password !== "string" || password.length < 32 || password.length > 1024) {
    throw new TypeError("runtime password length is outside the supported range");
  }
  if (!Buffer.isBuffer(salt) || salt.length < 16 || salt.length > 64) {
    throw new TypeError("SCRAM salt must contain between 16 and 64 bytes");
  }
  if (!Number.isInteger(iterations) || iterations < SCRAM_ITERATIONS || iterations > 1_000_000) {
    throw new TypeError("SCRAM iteration count is outside the supported range");
  }

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key", "utf8").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key", "utf8").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

async function configureRuntimeLogin(client, runtimeLogin) {
  const verifier = createPostgresScramVerifier(runtimeLogin.password);
  // Only the randomized SCRAM verifier is sent to PostgreSQL as a bind value.
  // The Secrets Manager plaintext is never concatenated into SQL or log data.
  await client.query("select app_private.configure_runtime_login($1)", [verifier]);
}

async function configureProvisionerLogin(client, provisionerLogin) {
  const verifier = createPostgresScramVerifier(provisionerLogin.password);
  await client.query("select app_private.configure_provisioner_login($1)", [verifier]);
}

async function configureDocumentSnapshotFinalization(client, secretValue) {
  const secret = assertPdfFinalizationSecret(secretValue);
  await client.query(
    "select app_private.configure_document_snapshot_finalization($1)",
    [secret],
  );
}

function rewriteDeploymentRoleNames(sql, { runtimeRoleName, provisionerRoleName }) {
  return sql
    .replaceAll(DEFAULT_RUNTIME_ROLE_NAME, runtimeRoleName)
    .replaceAll(DEFAULT_PROVISIONER_ROLE_NAME, provisionerRoleName);
}

function migrationUserMatchesDeploymentRole(roleName) {
  const migrationUser = process.env.MIGRATION_DATABASE_USER;
  return typeof migrationUser === "string" && migrationUser === roleName;
}

async function loadSources({
  runtimeRoleName = DEFAULT_RUNTIME_ROLE_NAME,
  provisionerRoleName = DEFAULT_PROVISIONER_ROLE_NAME,
} = {}) {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const versioned = await Promise.all(names.map(async (name) => {
    const sql = rewriteDeploymentRoleNames(await readFile(new URL(name, migrationsDirectory), "utf8"), {
      runtimeRoleName,
      provisionerRoleName,
    });
    return { name, sql, sha256: checksum(sql), repeatable: false };
  }));
  const grantsSql = rewriteDeploymentRoleNames(
    await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"),
    { runtimeRoleName, provisionerRoleName },
  );
  return [
    ...versioned,
    {
      name: "R__runtime-grants.sql",
      sql: grantsSql,
      sha256: checksum(grantsSql),
      repeatable: true,
    },
  ];
}

export async function buildMigrationConnectionOptions(
  env = process.env,
  { readFileImpl = readFile } = {},
) {
  const sslMode = env.MIGRATION_DATABASE_SSL || "require";
  const caFile = sslMode === "disable"
    ? env.MIGRATION_DATABASE_CA_FILE
    : requiredEnvironment("MIGRATION_DATABASE_CA_FILE", env);
  let ca;
  if (sslMode !== "disable") {
    try {
      ca = await readFileImpl(caFile, "utf8");
    } catch {
      throw new Error("MIGRATION_DATABASE_CA_FILE could not be read");
    }
    if (typeof ca !== "string" || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
      throw new Error("MIGRATION_DATABASE_CA_FILE is not a PEM certificate bundle");
    }
  }
  const ssl = sslMode === "disable"
    ? false
    : {
        rejectUnauthorized: true,
        ca,
      };
  return {
    host: requiredEnvironment("MIGRATION_DATABASE_HOST", env),
    port: Number(env.MIGRATION_DATABASE_PORT || 5432),
    database: requiredEnvironment("MIGRATION_DATABASE_NAME", env),
    user: requiredEnvironment("MIGRATION_DATABASE_USER", env),
    password: requiredEnvironment("MIGRATION_DATABASE_PASSWORD", env),
    ssl,
    application_name: "michinote-schema-migrator",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
  };
}

async function ensureHistory(client) {
  await client.query(`
    create table if not exists public.michinote_schema_migrations (
      name text primary key,
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default now()
    )
  `);
  await client.query("revoke all on public.michinote_schema_migrations from public");
}

export function unwrapMigrationTransaction(sql) {
  const lines = String(sql).replace(/^\uFEFF/, "").split(/\r?\n/);
  const controlLines = lines
    .map((line, index) => ({ index, statement: line.trim().toLowerCase() }))
    .filter(({ statement }) => /^(begin|commit|rollback)\s*;$/.test(statement));

  if (controlLines.length === 0) return lines.join("\n");
  if (
    controlLines.length !== 2
    || controlLines[0].statement !== "begin;"
    || controlLines[1].statement !== "commit;"
  ) {
    throw new Error("migration contains unsupported transaction control");
  }

  const beforeBegin = lines.slice(0, controlLines[0].index);
  const afterCommit = lines.slice(controlLines[1].index + 1);
  const hasExecutableOutsideWrapper = [...beforeBegin, ...afterCommit]
    .some((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("--");
    });
  if (hasExecutableOutsideWrapper) {
    throw new Error("migration transaction wrapper must enclose all executable SQL");
  }

  lines.splice(controlLines[1].index, 1);
  lines.splice(controlLines[0].index, 1);
  return lines.join("\n");
}

export async function applyMigrationSource(client, source) {
  const existing = await client.query(
    "select sha256 from public.michinote_schema_migrations where name = $1",
    [source.name],
  );
  if (existing.rows[0]?.sha256 === source.sha256) return "unchanged";
  if (existing.rows[0] && !source.repeatable) {
    throw new Error(`applied migration checksum changed: ${source.name}`);
  }

  await client.query("begin");
  try {
    // Several historical files carry their own outer BEGIN/COMMIT for manual
    // use. Remove only that exact wrapper so DDL and the history row remain in
    // the runner-owned transaction. Nested COMMIT would otherwise persist the
    // schema before its checksum history record.
    await client.query(unwrapMigrationTransaction(source.sql));
    await client.query(
      `insert into public.michinote_schema_migrations (name, sha256, applied_at)
       values ($1, $2, now())
       on conflict (name) do update set sha256 = excluded.sha256, applied_at = excluded.applied_at`,
      [source.name, source.sha256],
    );
    await client.query("commit");
    return existing.rows[0] ? "reapplied" : "applied";
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function runMigrations({
  client,
  sources,
  logger = console,
  runtimeLogin,
  provisionerLogin,
  pdfFinalizationSecret,
  runtimeRoleName,
  provisionerRoleName,
} = {}) {
  const resolvedRuntimeLogin = runtimeLogin || runtimeLoginFromEnvironment();
  const resolvedProvisionerLogin = provisionerLogin || provisionerLoginFromEnvironment();
  const resolvedRuntimeRoleName = runtimeRoleName
    || process.env.RUNTIME_DATABASE_USER
    || DEFAULT_RUNTIME_ROLE_NAME;
  const resolvedProvisionerRoleName = provisionerRoleName
    || process.env.PROVISION_DATABASE_USER
    || DEFAULT_PROVISIONER_ROLE_NAME;
  validateRuntimeLogin(resolvedRuntimeLogin, resolvedRuntimeRoleName);
  validateProvisionerLogin(resolvedProvisionerLogin, resolvedProvisionerRoleName);
  const resolvedPdfFinalizationSecret = assertPdfFinalizationSecret(
    pdfFinalizationSecret || requiredEnvironment("PDF_FINALIZATION_SECRET"),
  );
  if (
    resolvedPdfFinalizationSecret === resolvedRuntimeLogin.password
    || resolvedPdfFinalizationSecret === resolvedProvisionerLogin.password
  ) {
    throw new Error("PDF_FINALIZATION_SECRET must be independent from database credentials");
  }
  const ownsClient = !client;
  const databaseClient = client || new Client(await buildMigrationConnectionOptions());
  const reuseRuntimeRoleForMigration = migrationUserMatchesDeploymentRole(resolvedRuntimeRoleName);
  const reuseProvisionerRoleForMigration = migrationUserMatchesDeploymentRole(resolvedProvisionerRoleName);
  const needsTemporaryPdfConfigurationGrant = reuseRuntimeRoleForMigration || reuseProvisionerRoleForMigration;
  if (ownsClient) await databaseClient.connect();
  let locked = false;
  try {
    await ensureHistory(databaseClient);
    await databaseClient.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    locked = true;
    for (const source of sources || await loadSources({
      runtimeRoleName: resolvedRuntimeRoleName,
      provisionerRoleName: resolvedProvisionerRoleName,
    })) {
      const outcome = await applyMigrationSource(databaseClient, source);
      logger.info?.(JSON.stringify({ event: "migration", name: source.name, outcome }));
    }
    await databaseClient.query("begin");
    try {
      // PostgreSQL can include bind values in slow-statement diagnostics.
      // Suppress parameter logging for the transaction that supplies secrets
      // and password verifiers to owner-only bootstrap functions.
      await databaseClient.query("set local log_parameter_max_length = 0");
      await databaseClient.query("set local log_parameter_max_length_on_error = 0");
      if (reuseRuntimeRoleForMigration) {
        logger.info?.(JSON.stringify({ event: "runtime_database_login_reused", role: resolvedRuntimeRoleName }));
      } else {
        await configureRuntimeLogin(databaseClient, resolvedRuntimeLogin);
      }
      if (reuseProvisionerRoleForMigration) {
        logger.info?.(JSON.stringify({ event: "provisioner_database_login_reused", role: resolvedProvisionerRoleName }));
      } else {
        await configureProvisionerLogin(databaseClient, resolvedProvisionerLogin);
      }
      if (needsTemporaryPdfConfigurationGrant) {
        // In owner-backed single-tenant deployments, the runtime account
        // intentionally cannot call this owner-only function after the grants
        // migration. The initial secret is configured at bootstrap and stays
        // unchanged on ordinary schema updates.
        logger.info?.(JSON.stringify({ event: "pdf_finalization_configuration_reused" }));
      } else {
        await configureDocumentSnapshotFinalization(databaseClient, resolvedPdfFinalizationSecret);
      }
      await databaseClient.query("commit");
    } catch (error) {
      await databaseClient.query("rollback");
      throw error;
    }
    if (!reuseRuntimeRoleForMigration) {
      logger.info?.(JSON.stringify({ event: "runtime_database_login_configured", role: resolvedRuntimeRoleName }));
    }
    if (!reuseProvisionerRoleForMigration) {
      logger.info?.(JSON.stringify({
        event: "provisioner_database_login_configured",
        role: resolvedProvisionerRoleName,
      }));
    }
  } finally {
    if (locked) {
      try {
        await databaseClient.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      } catch {
        // Closing this dedicated connection also releases the session lock.
      }
    }
    if (ownsClient) await databaseClient.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runMigrations();
  } catch (error) {
    // Database errors can contain SQL context. Log only stable classifications;
    // never include connection settings, SQL text, parameters or secret values.
    console.error(JSON.stringify({
      event: "migration_failed",
      errorName: error.name,
      errorCode: typeof error.code === "string" ? error.code : "MIGRATION_FAILED",
    }));
    process.exitCode = 1;
  }
}
