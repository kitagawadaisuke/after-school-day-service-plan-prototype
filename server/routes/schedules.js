import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import {
  createSchedule,
  finalizeSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "../repositories/schedules.js";
import { dateSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const scheduleKindSchema = z.enum(["current", "planned"]);

const scheduleItemSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    // Values above 1440 represent an activity ending after midnight.
    endMinute: z.number().int().min(1).max(2880),
    activity: z.string().trim().min(1).max(500),
    location: z.string().trim().max(500).optional(),
    serviceKind: z.string().trim().max(200).optional(),
    recurrenceNote: z.string().trim().max(1000).optional(),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict()
  .refine((value) => value.endMinute > value.startMinute, {
    path: ["endMinute"],
    message: "終了時刻は開始時刻より後にしてください",
  });

function hasValidPeriod(value) {
  return !value.validFrom || !value.validTo || value.validTo >= value.validFrom;
}

const createSchema = z
  .object({
    scheduleKind: scheduleKindSchema,
    validFrom: dateSchema.optional(),
    validTo: dateSchema.optional(),
    summary: z.string().trim().max(8000).optional(),
    items: z.array(scheduleItemSchema).max(200).default([]),
  })
  .strict()
  .refine(hasValidPeriod, {
    path: ["validTo"],
    message: "終了日は開始日以降を指定してください",
  });

const updateSchema = z
  .object({
    validFrom: dateSchema.nullable().optional(),
    validTo: dateSchema.nullable().optional(),
    summary: z.string().trim().max(8000).nullable().optional(),
    items: z.array(scheduleItemSchema).max(200).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください")
  .refine(hasValidPeriod, {
    path: ["validTo"],
    message: "終了日は開始日以降を指定してください",
  });

const listQuerySchema = z.object({ scheduleKind: scheduleKindSchema.optional() }).strict();
const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const scheduleParamsSchema = z.object({ childId: uuidSchema, scheduleId: uuidSchema }).strict();

export async function scheduleRoutes(app) {
  app.get("/children/:childId/schedules", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const { scheduleKind } = parseInput(listQuerySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listSchedules(client, request.actor.tenantId, childId, scheduleKind),
    );
  });

  app.post("/children/:childId/schedules", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseInput(createSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createSchedule(client, request.actor, childId, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: created.facilityId,
        action: "schedule.created",
        resourceType: "schedule_version",
        resourceId: created.id,
        changedFields: ["scheduleKind", "validFrom", "validTo", "summary", "items"],
        metadata: {
          scheduleKind: created.scheduleKind,
          versionNumber: created.versionNumber,
          itemCount: created.items.length,
        },
      });
      return created;
    });
    const schedule = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, schedule);
  });

  app.get("/children/:childId/schedules/:scheduleId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, scheduleId } = parseInput(scheduleParamsSchema, request.params);
    const schedule = await withTenantTransaction(app.db, request.actor, (client) =>
      getSchedule(client, request.actor.tenantId, childId, scheduleId),
    );
    return setVersionEtag(reply, schedule);
  });

  app.patch("/children/:childId/schedules/:scheduleId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, scheduleId } = parseInput(scheduleParamsSchema, request.params);
    const input = parseInput(updateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const schedule = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateSchedule(
        client,
        request.actor,
        childId,
        scheduleId,
        expectedVersion,
        input,
      );
      await writeAuditEvent(client, {
        ...audit,
        facilityId: updated.facilityId,
        action: "schedule.updated",
        resourceType: "schedule_version",
        resourceId: scheduleId,
        changedFields: Object.keys(input),
        metadata: {
          scheduleKind: updated.scheduleKind,
          versionNumber: updated.versionNumber,
          itemCount: updated.items.length,
        },
      });
      return updated;
    });
    return setVersionEtag(reply, schedule);
  });

  app.post("/children/:childId/schedules/:scheduleId/finalize", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.APPROVE_DOCUMENTS);
    const { childId, scheduleId } = parseInput(scheduleParamsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const schedule = await withTenantTransaction(app.db, request.actor, async (client) => {
      const finalized = await finalizeSchedule(client, request.actor, childId, scheduleId, expectedVersion);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: finalized.facilityId,
        action: "schedule.finalized",
        resourceType: "schedule_version",
        resourceId: scheduleId,
        changedFields: ["status", "finalizedAt"],
        metadata: {
          scheduleKind: finalized.scheduleKind,
          versionNumber: finalized.versionNumber,
          itemCount: finalized.items.length,
        },
      });
      return finalized;
    });
    return setVersionEtag(reply, schedule);
  });
}
