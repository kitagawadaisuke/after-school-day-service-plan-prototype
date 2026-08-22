import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import {
  createChild,
  deleteChild,
  getChild,
  getChildProfilePhoto,
  listChildren,
  removeChildProfilePhoto,
  updateChild,
  updateChildProfilePhoto,
} from "../repositories/children.js";
import { AppError } from "../errors.js";
import {
  addressSchema,
  dateSchema,
  emergencyContactSchema,
  parseIfMatch,
  parseInput,
  setVersionEtag,
  uuidSchema,
} from "./validation.js";

const genderSchema = z.enum(["male", "female", "other", "not_stated"]);
const statusSchema = z.enum(["active", "inactive", "transferred", "closed"]);
const certificateNumberSchema = z
  .string()
  .trim()
  .min(4)
  .max(50)
  .regex(/^[0-9\-\s]+$/, "受給者証番号は数字、空白、ハイフンで入力してください")
  .refine((value) => value.replace(/\D/g, "").length >= 4, "受給者証番号は4桁以上入力してください");

const createSchema = z
  .object({
    facilityId: uuidSchema,
    managementCode: z.string().trim().min(1).max(50),
    displayName: z.string().trim().min(1).max(100),
    legalName: z.string().trim().min(1).max(100),
    birthDate: dateSchema.optional(),
    grade: z.string().trim().max(50).optional(),
    gender: genderSchema.optional(),
    address: addressSchema.optional(),
    primaryPhone: z.string().trim().max(50).optional(),
    emergencyContact: emergencyContactSchema.optional(),
    disabilityCategory: z.string().trim().max(200).optional(),
    medicalSummary: z.string().trim().max(4000).optional(),
    recipientCertificateNumber: certificateNumberSchema.optional(),
    municipalityName: z.string().trim().max(200).optional(),
    copaymentLimitYen: z.number().int().min(0).max(10_000_000).optional(),
    certificateValidFrom: dateSchema.optional(),
    certificateValidTo: dateSchema.optional(),
  })
  .strict();

const updateSchema = createSchema
  .omit({ facilityId: true, managementCode: true, displayName: true, legalName: true })
  .extend({
    facilityId: uuidSchema.optional(),
    managementCode: z.string().trim().min(1).max(50).optional(),
    displayName: z.string().trim().min(1).max(100).optional(),
    legalName: z.string().trim().min(1).max(100).optional(),
    birthDate: dateSchema.nullable().optional(),
    gender: genderSchema.nullable().optional(),
    recipientCertificateNumber: certificateNumberSchema.nullable().optional(),
    certificateValidFrom: dateSchema.nullable().optional(),
    certificateValidTo: dateSchema.nullable().optional(),
    municipalityName: z.string().trim().max(200).nullable().optional(),
    copaymentLimitYen: z.number().int().min(0).max(10_000_000).nullable().optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");

const listQuerySchema = z
  .object({
    facilityId: uuidSchema.optional(),
    status: statusSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

const profilePhotoSchema = z.object({
  dataUrl: z.string().trim().min(32).max(960_000),
}).strict();

const profilePhotoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxProfilePhotoBytes = 700 * 1024;

function hasExpectedImageSignature(contentType, bytes) {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function decodeProfilePhoto(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || !profilePhotoMimeTypes.has(match[1])) {
    throw new AppError(422, "INVALID_PROFILE_PHOTO", "JPEG、PNG、WebP形式の写真を選択してください。");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.byteLength > maxProfilePhotoBytes || !hasExpectedImageSignature(match[1], bytes)) {
    throw new AppError(422, "INVALID_PROFILE_PHOTO", "写真は700KB以下のJPEG、PNG、WebPを選択してください。");
  }
  return { contentType: match[1], bytes };
}

async function protectCertificateNumber(app, actor, input) {
  if (!Object.hasOwn(input, "recipientCertificateNumber")) return input;
  const { recipientCertificateNumber, ...safeInput } = input;
  if (recipientCertificateNumber === null) {
    return {
      ...safeInput,
      recipientCertificateCiphertext: null,
      recipientCertificateLast4: null,
    };
  }
  if (!app.fieldEncryption) {
    throw new AppError(
      503,
      "SECURE_STORAGE_UNAVAILABLE",
      "受給者証番号を安全に保存する暗号化機能を利用できません。管理者へ連絡してください。",
    );
  }
  const normalized = recipientCertificateNumber.replace(/\D/g, "");
  try {
    const ciphertext = await app.fieldEncryption.encrypt({
      tenantId: actor.tenantId,
      fieldName: "recipient_certificate_number",
      plaintext: normalized,
    });
    return {
      ...safeInput,
      recipientCertificateCiphertext: ciphertext,
      recipientCertificateLast4: normalized.slice(-4),
    };
  } catch (error) {
    throw new AppError(
      503,
      "SECURE_STORAGE_UNAVAILABLE",
      "受給者証番号を安全に保存できませんでした。時間をおいて再度お試しください。",
      { cause: error },
    );
  }
}

export async function childRoutes(app) {
  app.get("/children", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const query = parseInput(listQuerySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listChildren(client, request.actor.tenantId, query),
    );
  });

  app.post("/children", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const parsedInput = parseInput(createSchema, request.body);
    const changedFields = Object.keys(parsedInput);
    const input = await protectCertificateNumber(app, request.actor, parsedInput);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createChild(client, request.actor, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: created.facilityId,
        actorUserId: request.actor.userId,
        action: "child.created",
        resourceType: "child",
        resourceId: created.id,
        changedFields,
      });
      return created;
    });
    const child = applyIdempotencyReply(reply, result);
    return setVersionEtag(reply, child);
  });

  app.get("/children/:childId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId } = parseInput(z.object({ childId: uuidSchema }).strict(), request.params);
    const child = await withTenantTransaction(app.db, request.actor, (client) =>
      getChild(client, request.actor.tenantId, childId),
    );
    return setVersionEtag(reply, child);
  });

  app.patch("/children/:childId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const { childId } = parseInput(z.object({ childId: uuidSchema }).strict(), request.params);
    const parsedInput = parseInput(updateSchema, request.body);
    const changedFields = Object.keys(parsedInput);
    const input = await protectCertificateNumber(app, request.actor, parsedInput);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const child = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateChild(client, request.actor, childId, expectedVersion, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: updated.facilityId,
        actorUserId: request.actor.userId,
        action: "child.updated",
        resourceType: "child",
        resourceId: childId,
        changedFields,
      });
      return updated;
    });
    return setVersionEtag(reply, child);
  });

  app.delete("/children/:childId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const { childId } = parseInput(z.object({ childId: uuidSchema }).strict(), request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const deleted = await withTenantTransaction(app.db, request.actor, async (client) => {
      const result = await deleteChild(client, request.actor, childId, expectedVersion);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: result.facilityId,
        actorUserId: request.actor.userId,
        action: "child.deleted",
        resourceType: "child",
        resourceId: childId,
        changedFields: ["deleted_at"],
      });
      return result;
    });
    return setVersionEtag(reply, deleted);
  });

  app.get("/children/:childId/profile-photo", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId } = parseInput(z.object({ childId: uuidSchema }).strict(), request.params);
    const photo = await withTenantTransaction(app.db, request.actor, (client) =>
      getChildProfilePhoto(client, request.actor.tenantId, childId),
    );
    if (!photo) throw new AppError(404, "PROFILE_PHOTO_NOT_FOUND", "顔写真は登録されていません。");
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(photo.contentType).send(photo.bytes);
  });

  app.put("/children/:childId/profile-photo", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const { childId } = parseInput(z.object({ childId: uuidSchema }).strict(), request.params);
    const input = decodeProfilePhoto(parseInput(profilePhotoSchema, request.body).dataUrl);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const child = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateChildProfilePhoto(client, request.actor, childId, expectedVersion, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: updated.facilityId,
        actorUserId: request.actor.userId,
        action: "child.profile_photo_updated",
        resourceType: "child",
        resourceId: childId,
        changedFields: ["profilePhoto"],
      });
      return updated;
    });
    return setVersionEtag(reply, child);
  });

  app.delete("/children/:childId/profile-photo", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_CLIENTS);
    const { childId } = parseInput(z.object({ childId: uuidSchema }).strict(), request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const child = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await removeChildProfilePhoto(client, request.actor, childId, expectedVersion);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: updated.facilityId,
        actorUserId: request.actor.userId,
        action: "child.profile_photo_removed",
        resourceType: "child",
        resourceId: childId,
        changedFields: ["profilePhoto"],
      });
      return updated;
    });
    return setVersionEtag(reply, child);
  });
}
