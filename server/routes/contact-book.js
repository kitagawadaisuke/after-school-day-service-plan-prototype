import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import {
  createContactBookEntry,
  deleteContactBookEntry,
  listContactBookEntries,
  updateContactBookEntry,
} from "../repositories/contact-book.js";
import {
  createContactBookPhoto,
  deleteContactBookPhoto,
  getContactBookPhotoContent,
} from "../repositories/contact-book-photos.js";
import { AppError } from "../errors.js";
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
  .refine((value) => Boolean(value.facilityReply), {
    message: "事業所からの連絡を入力してください",
    path: ["facilityReply"],
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
const photoParamsSchema = z.object({ childId: uuidSchema, entryId: uuidSchema, photoId: uuidSchema }).strict();
const contactPhotoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxContactPhotoBytes = 5 * 1024 * 1024;
const contactPhotoSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(100),
  dataBase64: z.string().min(4).max(7 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

function hasExpectedContactPhotoSignature(contentType, bytes) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function decodeContactPhoto(input) {
  if (!contactPhotoMimeTypes.has(input.contentType)) {
    throw new AppError(422, "UNSUPPORTED_CONTACT_PHOTO", "JPEG、PNG、WebP形式の写真を選択してください。");
  }
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length || bytes.byteLength > maxContactPhotoBytes || !hasExpectedContactPhotoSignature(input.contentType, bytes)) {
    throw new AppError(422, "INVALID_CONTACT_PHOTO", "写真は5MB以下のJPEG、PNG、WebPを選択してください。");
  }
  const fileName = input.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  if (!fileName) throw new AppError(422, "INVALID_CONTACT_PHOTO", "写真のファイル名を確認してください。");
  return { fileName, contentType: input.contentType, bytes };
}

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

  app.post("/children/:childId/contact-book/:entryId/photos", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId, entryId } = parseInput(entryParamsSchema, request.params);
    const input = decodeContactPhoto(parseInput(contactPhotoSchema, request.body));
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createContactBookPhoto(client, request.actor, childId, entryId, input);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: created.facilityId,
        action: "contact_book.photo_uploaded",
        resourceType: "contact_book_photo",
        resourceId: created.photo.id,
        changedFields: ["photo"],
        metadata: { contactBookEntryId: entryId, contentType: created.photo.contentType, byteSize: created.photo.byteSize },
      });
      return created.photo;
    });
    reply.code(201);
    return applyIdempotencyReply(reply, idempotentResult);
  });

  app.get("/children/:childId/contact-book/:entryId/photos/:photoId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_JOURNALS);
    const { childId, entryId, photoId } = parseInput(photoParamsSchema, request.params);
    const photo = await withTenantTransaction(app.db, request.actor, (client) =>
      getContactBookPhotoContent(client, request.actor.tenantId, childId, entryId, photoId),
    );
    const encodedName = encodeURIComponent(photo.fileName).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `inline; filename="contact-photo"; filename*=UTF-8''${encodedName}`)
      .type(photo.contentType);
    return reply.send(photo.bytes);
  });

  app.delete("/children/:childId/contact-book/:entryId/photos/:photoId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId, entryId, photoId } = parseInput(photoParamsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const deleted = await withTenantTransaction(app.db, request.actor, async (client) => {
      const result = await deleteContactBookPhoto(client, request.actor, childId, entryId, photoId, expectedVersion);
      await writeAuditEvent(client, {
        ...audit,
        facilityId: result.facilityId,
        action: "contact_book.photo_deleted",
        resourceType: "contact_book_photo",
        resourceId: photoId,
        changedFields: ["photo"],
        metadata: { contactBookEntryId: entryId },
      });
      return result;
    });
    return reply.code(204).send(deleted);
  });

  app.delete("/children/:childId/contact-book/:entryId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_JOURNALS);
    const { childId, entryId } = parseInput(entryParamsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const deleted = await withTenantTransaction(app.db, request.actor, async (client) => {
      const result = await deleteContactBookEntry(client, request.actor, childId, entryId, expectedVersion);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: result.facilityId,
        actorUserId: request.actor.userId,
        action: "contact_book.deleted",
        resourceType: "contact_book_entry",
        resourceId: entryId,
        changedFields: ["deleted_at"],
      });
      return result;
    });
    return setVersionEtag(reply, deleted);
  });
}
