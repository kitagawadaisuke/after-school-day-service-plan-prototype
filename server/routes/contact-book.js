import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import {
  createContactBookEntry,
  listContactBookEntries,
  updateContactBookEntry,
} from "../repositories/contact-book.js";
import { dateSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const messageSchema = z.string().trim().max(4000);
const createSchema = z
  .object({
    entryDate: dateSchema,
    familyMessage: messageSchema.optional(),
    facilityReply: messageSchema.optional(),
    requestSummary: z.string().trim().max(2000).optional(),
    reflectedInSupport: z.boolean().default(false),
  })
  .strict()
  .refine((value) => Boolean(value.familyMessage || value.facilityReply), {
    message: "家庭からの連絡または事業所からの返信を入力してください",
    path: ["familyMessage"],
  });

const updateSchema = z
  .object({
    entryDate: dateSchema.optional(),
    familyMessage: messageSchema.optional(),
    facilityReply: messageSchema.optional(),
    requestSummary: z.string().trim().max(2000).optional(),
    reflectedInSupport: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");

const listQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "終了日は開始日以降を指定してください",
    path: ["to"],
  });

const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const entryParamsSchema = z.object({ childId: uuidSchema, entryId: uuidSchema }).strict();

export async function contactBookRoutes(app) {
  app.get("/children/:childId/contact-book", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_JOURNALS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const query = parseInput(listQuerySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listContactBookEntries(client, request.actor.tenantId, childId, query),
    );
  });

  app.post("/children/:childId/contact-book", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseInput(createSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createContactBookEntry(client, request.actor, childId, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: created.facilityId,
        action: "contact_book.created",
        resourceType: "contact_book_entry",
        resourceId: created.id,
        changedFields: Object.keys(input),
      });
      return created;
    });
    const entry = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, entry);
  });

  app.patch("/children/:childId/contact-book/:entryId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId, entryId } = parseInput(entryParamsSchema, request.params);
    const input = parseInput(updateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const entry = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateContactBookEntry(client, request.actor, childId, entryId, expectedVersion, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: updated.facilityId,
        action: "contact_book.updated",
        resourceType: "contact_book_entry",
        resourceId: entryId,
        changedFields: Object.keys(input),
      });
      return updated;
    });
    return setVersionEtag(reply, entry);
  });
}
