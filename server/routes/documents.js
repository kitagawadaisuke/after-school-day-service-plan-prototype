import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import { AppError } from "../errors.js";
import { transitionDocument } from "../repositories/document-workflow.js";
import {
  createDocument,
  createDocumentGoal,
  createReferenceMaterialAttachment,
  deleteReferenceMaterialAttachment,
  deleteDocumentGoal,
  getDocument,
  getDocumentGoal,
  getReferenceMaterialAttachmentContent,
  listDocumentGoals,
  listDocuments,
  listReferenceMaterialAttachments,
  updateDocument,
  updateDocumentGoal,
} from "../repositories/documents.js";
import { dateSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const documentKindSchema = z.enum([
  "basic_assessment",
  "consultation_plan",
  "individual_support_plan",
  "monitoring_record",
]);
const documentStatusSchema = z.enum([
  "draft",
  "internal_review",
  "explanation_pending",
  "consented",
  "approved",
  "distributed",
  "active",
  "superseded",
  "closed",
  "void",
]);
const goalKindSchema = z.enum(["long_term", "short_term", "support"]);
const fiveDomainSchema = z.enum([
  "health_life",
  "motor_sensory",
  "cognition_behavior",
  "language_communication",
  "human_relations_sociality",
]);

const payloadSchema = z
  .record(z.string().trim().min(1).max(120), z.unknown())
  .superRefine((payload, context) => {
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 262_144) {
      context.addIssue({
        code: "custom",
        message: "帳票本文は256KB以下にしてください。",
      });
    }
  });

function hasValidPeriod(value) {
  return !value.periodStart || !value.periodEnd || value.periodEnd >= value.periodStart;
}

const createDocumentSchema = z
  .object({
    documentKind: documentKindSchema,
    templateVersion: z.string().trim().min(1).max(50),
    periodStart: dateSchema.optional(),
    periodEnd: dateSchema.optional(),
    payload: payloadSchema.default({}),
  })
  .strict()
  .refine(hasValidPeriod, { path: ["periodEnd"], message: "終了日は開始日以降にしてください。" });

const updateDocumentSchema = z
  .object({
    templateVersion: z.string().trim().min(1).max(50).optional(),
    periodStart: dateSchema.nullable().optional(),
    periodEnd: dateSchema.nullable().optional(),
    payload: payloadSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください。")
  .refine(hasValidPeriod, { path: ["periodEnd"], message: "終了日は開始日以降にしてください。" });

const goalFields = {
  predecessorGoalId: uuidSchema.nullable().optional(),
  goalKind: goalKindSchema,
  title: z.string().trim().min(1).max(500),
  desiredOutcome: z.string().trim().max(4000).optional(),
  supportDetails: z.string().trim().max(8000).optional(),
  evaluationMethod: z.string().trim().max(2000).optional(),
  responsibleParty: z.string().trim().max(1000).optional(),
  targetDate: dateSchema.optional(),
  fiveDomains: z.array(fiveDomainSchema).max(5).default([]),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
};

const createGoalSchema = z.object(goalFields).strict();
const updateGoalSchema = z
  .object({
    predecessorGoalId: goalFields.predecessorGoalId,
    goalKind: goalKindSchema.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    desiredOutcome: z.string().trim().max(4000).nullable().optional(),
    supportDetails: z.string().trim().max(8000).nullable().optional(),
    evaluationMethod: z.string().trim().max(2000).nullable().optional(),
    responsibleParty: z.string().trim().max(1000).nullable().optional(),
    targetDate: dateSchema.nullable().optional(),
    fiveDomains: z.array(fiveDomainSchema).max(5).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください。");

const listQuerySchema = z
  .object({
    documentKind: documentKindSchema.optional(),
    status: documentStatusSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const documentParamsSchema = z.object({ childId: uuidSchema, documentId: uuidSchema }).strict();
const goalParamsSchema = z.object({ childId: uuidSchema, documentId: uuidSchema, goalId: uuidSchema }).strict();
const referenceAttachmentParamsSchema = z.object({
  childId: uuidSchema,
  documentId: uuidSchema,
  attachmentId: uuidSchema,
}).strict();

const referenceAttachmentMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const maxReferenceAttachmentBytes = 15 * 1024 * 1024;
const referenceAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(200),
  dataBase64: z.string().min(4).max(21 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

function hasExpectedReferenceFileSignature(contentType, bytes) {
  if (contentType === "application/pdf") return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  const officeBinary = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(contentType)) return officeBinary;
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

function decodeReferenceAttachment(input) {
  if (!referenceAttachmentMimeTypes.has(input.contentType)) {
    throw new AppError(422, "UNSUPPORTED_REFERENCE_FILE", "PDF、Word、Excel、PowerPoint形式の資料を選択してください。");
  }
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length || bytes.byteLength > maxReferenceAttachmentBytes || !hasExpectedReferenceFileSignature(input.contentType, bytes)) {
    throw new AppError(422, "INVALID_REFERENCE_FILE", "資料は15MB以下のPDF、Word、Excel、PowerPointを選択してください。");
  }
  const fileName = input.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  if (!fileName) throw new AppError(422, "INVALID_REFERENCE_FILE", "資料のファイル名を確認してください。");
  return { fileName, contentType: input.contentType, bytes };
}

function parseDocumentBody(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(422, "VALIDATION_ERROR", "入力内容を確認してください。", {
    details: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export async function documentRoutes(app) {
  app.get("/children/:childId/documents", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const query = parseInput(listQuerySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listDocuments(client, request.actor.tenantId, childId, query),
    );
  });

  app.post("/children/:childId/documents", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseDocumentBody(createDocumentSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createDocument(client, request.actor, childId, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: created.facilityId,
        actorUserId: request.actor.userId,
        action: "case_document.created",
        resourceType: "case_document",
        resourceId: created.id,
        changedFields: ["documentKind", "templateVersion", "periodStart", "periodEnd", "payload"],
        metadata: { documentKind: created.documentKind, versionNumber: created.versionNumber },
      });
      return created;
    });
    const document = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, document);
  });

  app.get("/children/:childId/documents/:documentId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    const document = await withTenantTransaction(app.db, request.actor, (client) =>
      getDocument(client, request.actor.tenantId, childId, documentId),
    );
    return setVersionEtag(reply, document);
  });

  app.get("/children/:childId/documents/:documentId/reference-materials", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    const items = await withTenantTransaction(app.db, request.actor, (client) =>
      listReferenceMaterialAttachments(client, request.actor.tenantId, childId, documentId),
    );
    return { items };
  });

  app.post("/children/:childId/documents/:documentId/reference-materials", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    const input = decodeReferenceAttachment(parseInput(referenceAttachmentSchema, request.body));
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createReferenceMaterialAttachment(client, request.actor, childId, documentId, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: created.facilityId,
        actorUserId: request.actor.userId,
        action: "reference_material.uploaded",
        resourceType: "reference_material",
        resourceId: created.attachment.id,
        changedFields: ["attachment"],
        metadata: { documentId, contentType: created.attachment.contentType, byteSize: created.attachment.byteSize },
      });
      return created.attachment;
    });
    reply.code(201);
    return applyIdempotencyReply(reply, idempotentResult);
  });

  app.get("/children/:childId/documents/:documentId/reference-materials/:attachmentId/download", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, documentId, attachmentId } = parseInput(referenceAttachmentParamsSchema, request.params);
    const attachment = await withTenantTransaction(app.db, request.actor, (client) =>
      getReferenceMaterialAttachmentContent(client, request.actor.tenantId, childId, documentId, attachmentId),
    );
    const encodedName = encodeURIComponent(attachment.fileName).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `attachment; filename="reference-material"; filename*=UTF-8''${encodedName}`)
      .type("application/octet-stream");
    return reply.send(attachment.bytes);
  });

  app.delete("/children/:childId/documents/:documentId/reference-materials/:attachmentId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId, attachmentId } = parseInput(referenceAttachmentParamsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const deleted = await withTenantTransaction(app.db, request.actor, async (client) => {
      const result = await deleteReferenceMaterialAttachment(
        client,
        request.actor,
        childId,
        documentId,
        attachmentId,
        expectedVersion,
      );
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: result.facilityId,
        actorUserId: request.actor.userId,
        action: "reference_material.deleted",
        resourceType: "reference_material",
        resourceId: attachmentId,
        changedFields: ["attachment"],
        metadata: { documentId },
      });
      return result;
    });
    return reply.code(204).send(deleted);
  });

  app.delete("/children/:childId/documents/:documentId/reference-material", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    await withTenantTransaction(app.db, request.actor, async (client) => {
      const removed = await transitionDocument(
        client,
        request.actor,
        childId,
        documentId,
        expectedVersion,
        { action: "void", reason: "利用者操作により参考資料を削除" },
        { expectedDocumentKind: "consultation_plan" },
      );
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: removed.facilityId,
        actorUserId: request.actor.userId,
        action: "reference_material.removed",
        resourceType: "reference_material",
        resourceId: documentId,
        changedFields: ["status"],
        metadata: { documentKind: removed.documentKind, versionNumber: removed.versionNumber },
      });
    });
    return reply.code(204).send();
  });

  app.patch("/children/:childId/documents/:documentId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    const input = parseDocumentBody(updateDocumentSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const document = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateDocument(client, request.actor, childId, documentId, expectedVersion, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: updated.facilityId,
        actorUserId: request.actor.userId,
        action: "case_document.updated",
        resourceType: "case_document",
        resourceId: updated.id,
        changedFields: Object.keys(input),
        metadata: { documentKind: updated.documentKind, versionNumber: updated.versionNumber },
      });
      return updated;
    });
    return setVersionEtag(reply, document);
  });

  app.get("/children/:childId/documents/:documentId/goals", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listDocumentGoals(client, request.actor.tenantId, childId, documentId),
    );
  });

  app.post("/children/:childId/documents/:documentId/goals", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    const input = parseDocumentBody(createGoalSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const created = await createDocumentGoal(client, request.actor, childId, documentId, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: created.facilityId,
        actorUserId: request.actor.userId,
        action: "document_goal.created",
        resourceType: "document_goal",
        resourceId: created.goal.id,
        changedFields: Object.keys(input),
        metadata: { documentId },
      });
      return created.goal;
    });
    const goal = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, goal);
  });

  app.get("/children/:childId/documents/:documentId/goals/:goalId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, documentId, goalId } = parseInput(goalParamsSchema, request.params);
    const goal = await withTenantTransaction(app.db, request.actor, (client) =>
      getDocumentGoal(client, request.actor.tenantId, childId, documentId, goalId),
    );
    return setVersionEtag(reply, goal);
  });

  app.patch("/children/:childId/documents/:documentId/goals/:goalId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId, goalId } = parseInput(goalParamsSchema, request.params);
    const input = parseDocumentBody(updateGoalSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateDocumentGoal(
        client,
        request.actor,
        childId,
        documentId,
        goalId,
        expectedVersion,
        input,
      );
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: updated.facilityId,
        actorUserId: request.actor.userId,
        action: "document_goal.updated",
        resourceType: "document_goal",
        resourceId: goalId,
        changedFields: Object.keys(input),
        metadata: { documentId },
      });
      return updated.goal;
    });
    return setVersionEtag(reply, result);
  });

  app.delete("/children/:childId/documents/:documentId/goals/:goalId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId, documentId, goalId } = parseInput(goalParamsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    await withTenantTransaction(app.db, request.actor, async (client) => {
      const deleted = await deleteDocumentGoal(
        client,
        request.actor,
        childId,
        documentId,
        goalId,
        expectedVersion,
      );
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: deleted.facilityId,
        actorUserId: request.actor.userId,
        action: "document_goal.deleted",
        resourceType: "document_goal",
        resourceId: goalId,
        changedFields: [],
        metadata: { documentId },
      });
    });
    return reply.code(204).send();
  });
}
