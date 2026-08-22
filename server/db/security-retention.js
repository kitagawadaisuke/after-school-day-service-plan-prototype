const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function drain(pool, functionName, { batchSize = 250, maxBatches = 20 } = {}) {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query(`select app_private.${functionName}($1) as deleted`, [batchSize]);
    const deleted = Number(result.rows[0]?.deleted || 0);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export async function purgeSecurityRetention(pool, options = {}) {
  const [authEvents, sessions] = await Promise.all([
    drain(pool, "purge_retired_security_auth_events", options),
    drain(pool, "purge_retired_sessions", options),
  ]);
  return { authEvents, sessions };
}

export function startSecurityRetentionWorker({ pool, logger, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let stopped = false;
  let running = false;
  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const deleted = await purgeSecurityRetention(pool);
      if (deleted.authEvents > 0 || deleted.sessions > 0) {
        logger?.info?.({ event: "security_retention_purged", ...deleted });
      }
    } catch (error) {
      logger?.warn?.({
        event: "security_retention_failed",
        errorName: error?.name,
        errorCode: error?.code,
      });
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return Object.freeze({ stop() { stopped = true; clearInterval(timer); } });
}
