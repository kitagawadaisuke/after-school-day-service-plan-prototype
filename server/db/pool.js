import pg from "pg";
import { readFileSync } from "node:fs";

const { Pool } = pg;

function assertNoConnectionStringTlsOverride(connectionString) {
  const queryStart = connectionString.indexOf("?");
  if (queryStart === -1) return;
  const parameters = new URLSearchParams(connectionString.slice(queryStart + 1));
  const hasTlsOverride = [...parameters.keys()].some((key) => {
    const normalized = key.toLowerCase();
    return normalized.startsWith("ssl") || normalized === "uselibpqcompat";
  });
  if (hasTlsOverride) {
    // node-postgres gives TLS query parameters precedence over the explicit
    // ssl object. Reject them so a URL cannot disable CA/hostname checks.
    throw new Error("DATABASE_URL must not contain TLS options when DATABASE_SSL=require");
  }
}

function buildTlsOptions(config, readFile) {
  if (!config.databaseSsl) return false;
  if (!config.databaseCaFile) {
    throw new Error("CA-verified PostgreSQL TLS requires DATABASE_CA_FILE");
  }
  let ca;
  try {
    ca = readFile(config.databaseCaFile, "utf8");
  } catch {
    throw new Error("PostgreSQL CA bundle could not be read");
  }
  if (typeof ca !== "string" || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
    throw new Error("PostgreSQL CA bundle is not a PEM certificate bundle");
  }
  return { rejectUnauthorized: true, ca };
}

export function buildPgPoolOptions(config, { readFile = readFileSync } = {}) {
  if (config.databaseUrl && config.databaseSsl) {
    assertNoConnectionStringTlsOverride(config.databaseUrl);
  }
  const connection = config.databaseUrl
    ? { connectionString: config.databaseUrl }
    : config.databaseHost && config.databaseName && config.databaseUser && config.databasePassword
      ? {
          host: config.databaseHost,
          port: config.databasePort || 5432,
          database: config.databaseName,
          user: config.databaseUser,
          password: config.databasePassword,
        }
      : null;

  if (!connection) return null;

  return {
    ...connection,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: "michi-note-api",
    ssl: buildTlsOptions(config, readFile),
  };
}

export function createPgPool(config) {
  const options = buildPgPoolOptions(config);
  if (!options) return null;

  const pool = new Pool(options);

  pool.on("error", (error) => {
    // Driver messages may contain endpoint or connection details. Keep the
    // operational signal while leaving diagnostics to private infrastructure
    // metrics and never serializing connection strings or SQL values.
    console.error(JSON.stringify({
      level: "error",
      event: "postgres_pool_error",
      errorName: error?.name || "Error",
      errorCode: typeof error?.code === "string" ? error.code : "UNKNOWN",
    }));
  });

  return pool;
}
