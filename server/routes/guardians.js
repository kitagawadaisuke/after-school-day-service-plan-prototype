import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import { createGuardian, getGuardian, listGuardians, updateGuardian } from "../repositories/guardians.js";
import { addressSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const guardianFields = {
  legalName: z.string().trim().min(1).max(100),
  relationship: z.string().trim().min(1).max(50),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().email().max(254).optional(),
  address: addressSchema.optional(),
  isPrimary: z.boolean().default(false),
};

const createSchema = z.object(guardianFields).strict();
const updateSchema = z
  .object({
    legalName: guardianFields.legalName.optional(),
    relationship: guardianFields.relationship.optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    address: addressSchema.nullable().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");

const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const guardianParamsSchema = z.object({ childId: uuidSchema, guardianId: uuidSchema }).strict();

export async function guardianRoutes(app) {
  app.get("/children/:childId/guardians", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listGuardians(client, request.actor.tenantId, childId),
    );
  });

  app.post("/children/:childId/guardians", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseInput(createSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createGuardian(client, request.actor, childId, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: created.facilityId,
        action: "guardian.created",
        resourceType: "guardian",
        resourceId: created.guardian.id,
        changedFields: Object.keys(input),
      });
      return created.guardian;
    });
    const guardian = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, guardian);
  });

  app.get("/children/:childId/guardians/:guardianId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId, guardianId } = parseInput(guardianParamsSchema, request.params);
    const guardian = await withTenantTransaction(app.db, request.actor, (client) =>
      getGuardian(client, request.actor.tenantId, childId, guardianId),
    );
    return setVersionEtag(reply, guardian);
  });

  app.patch("/children/:childId/guardians/:guardianId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const { childId, guardianId } = parseInput(guardianParamsSchema, request.params);
    const input = parseInput(updateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateGuardian(
        client,
        request.actor,
        childId,
        guardianId,
        expectedVersion,
        input,
      );
      await writeAuditEvent(client, {
        ...audit,
        facilityId: updated.facilityId,
        action: "guardian.updated",
        resourceType: "guardian",
        resourceId: guardianId,
        changedFields: Object.keys(input),
      });
      return updated.guardian;
    });
    return setVersionEtag(reply, result);
  });
}
