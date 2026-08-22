import { z } from "zod";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { listAuditEvents } from "../repositories/audit-events.js";
import { dateTimeSchema, parseInput, uuidSchema } from "./validation.js";

const querySchema = z
  .object({
    facilityId: uuidSchema.optional(),
    action: z.string().trim().min(1).max(100).optional(),
    resourceType: z.string().trim().min(1).max(100).optional(),
    from: dateTimeSchema.optional(),
    to: dateTimeSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ["to"],
    message: "終了日時は開始日時以降を指定してください",
  });

export async function auditEventRoutes(app) {
  app.get("/audit-events", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_AUDIT_LOG);
    const query = parseInput(querySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listAuditEvents(client, request.actor.tenantId, query),
    );
  });
}
