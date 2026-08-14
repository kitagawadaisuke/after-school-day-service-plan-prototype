import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createFacility, listFacilities, updateFacility } from "../repositories/facilities.js";
import { parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const facilityFields = {
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  serviceType: z.string().trim().min(1).max(100).default("放課後等デイサービス"),
  timezone: z.literal("Asia/Tokyo").default("Asia/Tokyo"),
};
const createSchema = z.object(facilityFields).strict();
const updateSchema = z
  .object({
    code: facilityFields.code.optional(),
    name: facilityFields.name.optional(),
    serviceType: z.string().trim().min(1).max(100).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    timezone: z.literal("Asia/Tokyo").optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");
const paramsSchema = z.object({ facilityId: uuidSchema }).strict();

export async function facilityRoutes(app) {
  app.get("/facilities", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    return withTenantTransaction(app.db, request.actor, async (client) => {
      return listFacilities(client, request.actor.tenantId);
    });
  });

  app.post("/facilities", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.MANAGE_TENANT);
    const input = parseInput(createSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const facility = await createFacility(client, request.actor, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: facility.id,
        action: "facility.created",
        resourceType: "facility",
        resourceId: facility.id,
        changedFields: Object.keys(input),
      });
      return facility;
    });
    const facility = applyIdempotencyReply(reply, result);
    return setVersionEtag(reply, facility);
  });

  app.patch("/facilities/:facilityId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.MANAGE_TENANT);
    const { facilityId } = parseInput(paramsSchema, request.params);
    const input = parseInput(updateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const facility = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateFacility(client, request.actor, facilityId, expectedVersion, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: updated.id,
        action: "facility.updated",
        resourceType: "facility",
        resourceId: updated.id,
        changedFields: Object.keys(input),
      });
      return updated;
    });
    return setVersionEtag(reply, facility);
  });
}
