import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import { createDailyLog, listDailyLogs, updateDailyLog } from "../repositories/daily-logs.js";
import { dateTimeSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const fiveDomainSchema = z.enum(["health_life", "motor_sensory", "cognition_behavior", "language_communication", "human_relations_sociality"]);

const createSchema = z
  .object({
    occurredAt: dateTimeSchema,
    activity: z.string().trim().min(1).max(500),
    observation: z.string().trim().min(1).max(4000),
    supportProvided: z.string().trim().min(1).max(4000),
    childResponse: z.string().trim().min(1).max(4000),
    healthNote: z.string().trim().max(2000).optional(),
    fiveDomains: z.array(fiveDomainSchema).max(5).default([]),
    relatedGoalIds: z.array(uuidSchema).max(30).default([]),
  })
  .strict();

const updateSchema = createSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");

const listQuerySchema = z
  .object({
    from: dateTimeSchema.optional(),
    to: dateTimeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const logParamsSchema = z.object({ childId: uuidSchema, logId: uuidSchema }).strict();

export async function dailyLogRoutes(app) {
  app.get("/children/:childId/daily-logs", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_JOURNALS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const query = parseInput(listQuerySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listDailyLogs(client, request.actor.tenantId, childId, query),
    );
  });

  app.post("/children/:childId/daily-logs", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseInput(createSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createDailyLog(client, request.actor, childId, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: created.facilityId,
        actorUserId: request.actor.userId,
        action: "daily_log.created",
        resourceType: "daily_log",
        resourceId: created.id,
        changedFields: Object.keys(input),
      });
      return created;
    });
    const log = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, log);
  });

  app.patch("/children/:childId/daily-logs/:logId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId, logId } = parseInput(logParamsSchema, request.params);
    const input = parseInput(updateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const log = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateDailyLog(client, request.actor, childId, logId, expectedVersion, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: updated.facilityId,
        actorUserId: request.actor.userId,
        action: "daily_log.updated",
        resourceType: "daily_log",
        resourceId: logId,
        changedFields: Object.keys(input),
      });
      return updated;
    });
    return setVersionEtag(reply, log);
  });
}
