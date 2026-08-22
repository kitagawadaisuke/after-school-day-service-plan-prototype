const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export async function purgeExpiredIdempotency(pool, { batchSize = 250, maxBatches = 20 } = {}) {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query(
      "select app_private.purge_expired_idempotency_records($1) as deleted",
      [batchSize],
    );
    const deleted = Number(result.rows[0]?.deleted || 0);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export function startIdempotencyRetentionWorker({
  pool,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  let stopped = false;
  let running = false;

  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const deleted = await purgeExpiredIdempotency(pool);
      if (deleted > 0) logger?.info?.({ event: "idempotency_retention_purged", deleted });
    } catch (error) {
      logger?.warn?.({
        event: "idempotency_retention_failed",
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
  return Object.freeze({
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  });
}
