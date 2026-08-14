import { createHash } from "node:crypto";
import { badRequest, conflict } from "../errors.js";
import { withTenantTransaction } from "./tenant-transaction.js";

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(request) {
  return createHash("sha256")
    .update(request.method)
    .update("\n")
    .update(request.url)
    .update("\n")
    .update(String(request.headers["if-match"] ?? ""))
    .update("\n")
    .update(canonicalJson(request.body ?? null))
    .digest("hex");
}

function idempotencyKey(request) {
  const header = request.headers["idempotency-key"];
  if (header === undefined) return null;
  if (typeof header !== "string" || !KEY_PATTERN.test(header)) {
    throw badRequest(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Keyは8〜128文字の英数字と . _ : - で指定してください。",
    );
  }
  return header;
}

export function describeIdempotentRequest(request) {
  const key = idempotencyKey(request);
  return key ? { key, fingerprint: requestFingerprint(request) } : null;
}

/** Read a completed replay in a short transaction before starting external I/O. */
export async function readIdempotentTenantResult(pool, actor, request) {
  const descriptor = describeIdempotentRequest(request);
  if (!descriptor) return null;
  return withTenantTransaction(pool, actor, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${actor.tenantId}:${actor.userId}:${descriptor.key}`],
    );
    const existing = await client.query(
      `select request_fingerprint, response_status, response_body
       from app_private.idempotency_records
       where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
         and expires_at > now()`,
      [actor.tenantId, actor.userId, descriptor.key],
    );
    if (!existing.rows[0]) return null;
    if (existing.rows[0].request_fingerprint !== descriptor.fingerprint) {
      throw conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key is already associated with a different request.",
      );
    }
    return {
      body: existing.rows[0].response_body,
      statusCode: Number(existing.rows[0].response_status),
      replayed: true,
    };
  });
}

/**
 * Runs a create operation and stores its successful JSON response in the same
 * transaction. Concurrent retries serialize on a transaction-scoped advisory
 * lock; a key reused for different input is rejected instead of replayed.
 */
export async function withIdempotentTenantTransaction(
  pool,
  actor,
  request,
  operation,
  { statusCode = 201, ttlHours = 24 } = {},
) {
  const key = idempotencyKey(request);
  if (!key) {
    const body = await withTenantTransaction(pool, actor, operation);
    return { body, statusCode, replayed: false };
  }
  const fingerprint = requestFingerprint(request);
  return withTenantTransaction(pool, actor, async (client) => {
    await client.query("select app_private.purge_expired_idempotency_records(250)");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${actor.tenantId}:${actor.userId}:${key}`],
    );
    const existing = await client.query(
      `select request_fingerprint, response_status, response_body
       from app_private.idempotency_records
       where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
         and expires_at > now()`,
      [actor.tenantId, actor.userId, key],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== fingerprint) {
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "同じ再送キーが異なる操作に使われました。画面を再読み込みしてやり直してください。",
        );
      }
      return {
        body: existing.rows[0].response_body,
        statusCode: Number(existing.rows[0].response_status),
        replayed: true,
      };
    }

    await client.query(
      `delete from app_private.idempotency_records
       where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
         and expires_at <= now()`,
      [actor.tenantId, actor.userId, key],
    );
    const body = await operation(client);
    await client.query(
      `insert into app_private.idempotency_records (
        tenant_id, actor_user_id, idempotency_key, request_fingerprint,
        response_status, response_body, expires_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, now() + make_interval(hours => $7))`,
      [
        actor.tenantId,
        actor.userId,
        key,
        fingerprint,
        statusCode,
        JSON.stringify(body),
        Math.min(24, Math.max(1, ttlHours)),
      ],
    );
    return { body, statusCode, replayed: false };
  });
}

export function applyIdempotencyReply(reply, result) {
  reply.code(result.statusCode);
  if (result.replayed) reply.header("Idempotency-Replayed", "true");
  return result.body;
}
