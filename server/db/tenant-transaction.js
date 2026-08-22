import { serviceUnavailable } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertActor(actor) {
  if (!actor || !UUID_PATTERN.test(actor.tenantId || "") || !UUID_PATTERN.test(actor.userId || "")) {
    throw new TypeError("tenant transaction requires a valid actor");
  }
}

export async function withTenantTransaction(pool, actor, operation, options = {}) {
  if (!pool) throw serviceUnavailable();
  assertActor(actor);
  const isolationLevel = options.isolationLevel || "read committed";
  if (!new Set(["read committed", "repeatable read", "serializable"]).has(isolationLevel)) {
    throw new TypeError("unsupported transaction isolation level");
  }

  const client = await pool.connect();
  try {
    await client.query(
      isolationLevel === "read committed" ? "begin" : `begin isolation level ${isolationLevel}`,
    );
    await client.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [actor.tenantId, actor.userId],
    );
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original error. The pool will discard a broken client.
    }
    throw error;
  } finally {
    client.release();
  }
}
