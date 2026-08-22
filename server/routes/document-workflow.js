import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { AppError, conflict } from "../errors.js";
import { prepareConsentIntent } from "../repositories/document-snapshots.js";
import { getDocumentWorkflow, transitionDocument } from "../repositories/document-workflow.js";
import {
  createConsentIntentToken,
  verifyConsentIntentToken,
} from "../security/document-source-integrity.js";
import { dateTimeSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const actionSchema = z.enum([
  "submit",
  "return",
  "explain",
  "consent",
  "approve",
  "distribute",
  "activate",
  "supersede",
  "close",
  "void",
]);

const consentSourceReviewSchema = z
  .object({
    token: z.string().min(80).max(256),
    expectedSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    targetVersionNumber: z.number().int().positive(),
    documentRowVersion: z.number().int().positive(),
  })
  .strict();

const consentSchema = z
  .object({
    signerName: z.string().trim().min(1).max(200),
    signerRelationship: z.string().trim().min(1).max(100),
    explanationMethod: z.enum(["in_person", "online", "telephone", "written", "other"]),
    explainedAt: dateTimeSchema,
    consentedAt: dateTimeSchema,
    sourceReview: consentSourceReviewSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.consentedAt) < Date.parse(value.explainedAt)) {
      context.addIssue({
        code: "custom",
        path: ["consentedAt"],
        message: "同意日時は説明日時以降にしてください。",
      });
    }
    const latestAcceptedTime = Date.now() + 5 * 60 * 1000;
    if (Date.parse(value.explainedAt) > latestAcceptedTime) {
      context.addIssue({
        code: "custom",
        path: ["explainedAt"],
        message: "説明日時に未来の時刻は指定できません。",
      });
    }
    if (Date.parse(value.consentedAt) > latestAcceptedTime) {
      context.addIssue({
        code: "custom",
        path: ["consentedAt"],
        message: "同意日時に未来の時刻は指定できません。",
      });
    }
  });

const distributionSchema = z
  .object({
    recipientName: z.string().trim().min(1).max(200),
    deliveryMethod: z.enum(["in_person", "postal_mail", "email", "portal", "other"]),
    distributedAt: dateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.distributedAt) > Date.now() + 5 * 60 * 1000) {
      context.addIssue({
        code: "custom",
        path: ["distributedAt"],
        message: "交付日時に未来の時刻は指定できません。",
      });
    }
  });

const transitionSchema = z
  .object({
    action: actionSchema,
    reason: z.string().trim().min(1).max(2000).optional(),
    consent: consentSchema.optional(),
    distribution: distributionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "consent" && !value.consent) {
      context.addIssue({ code: "custom", path: ["consent"], message: "同意記録を入力してください。" });
    }
    if (value.action !== "consent" && value.consent) {
      context.addIssue({ code: "custom", path: ["consent"], message: "同意操作のときだけ入力できます。" });
    }
    if (value.action === "distribute" && !value.distribution) {
      context.addIssue({ code: "custom", path: ["distribution"], message: "交付記録を入力してください。" });
    }
    if (value.action !== "distribute" && value.distribution) {
      context.addIssue({ code: "custom", path: ["distribution"], message: "交付操作のときだけ入力できます。" });
    }
    if (["return", "supersede", "close", "void"].includes(value.action) && !value.reason) {
      context.addIssue({ code: "custom", path: ["reason"], message: "この操作には理由が必要です。" });
    }
  });

const paramsSchema = z.object({ childId: uuidSchema, documentId: uuidSchema }).strict();

function parseWorkflowBody(value) {
  const parsed = transitionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(422, "VALIDATION_ERROR", "入力内容を確認してください。", {
    details: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function requireWorkflowPermission(actor, requestedAction) {
  if (requestedAction === "submit") {
    requirePermission(actor, PERMISSIONS.EDIT_DOCUMENTS);
    return;
  }
  requirePermission(actor, PERMISSIONS.APPROVE_DOCUMENTS);
}

function consentIntentContext(actor, childId, documentId, sourceReview) {
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    childId,
    documentId,
    documentRowVersion: sourceReview.documentRowVersion,
    targetVersionNumber: sourceReview.targetVersionNumber,
    expectedSourceHash: sourceReview.expectedSourceHash,
  };
}

export async function documentWorkflowRoutes(app) {
  app.get("/children/:childId/documents/:documentId/workflow", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
    const { childId, documentId } = parseInput(paramsSchema, request.params);
    const workflow = await withTenantTransaction(app.db, request.actor, (client) =>
      getDocumentWorkflow(client, request.actor.tenantId, childId, documentId),
    );
    setVersionEtag(reply, workflow.document);
    return workflow;
  });

  app.post("/children/:childId/documents/:documentId/consent-intents", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.APPROVE_DOCUMENTS);
    const { childId, documentId } = parseInput(paramsSchema, request.params);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const prepared = await withTenantTransaction(app.db, request.actor, async (client) => {
      const intent = await prepareConsentIntent(
        client,
        request.actor,
        childId,
        documentId,
        expectedVersion,
        app.config.auditHashKey,
      );
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: intent.facilityId,
        actorUserId: request.actor.userId,
        action: "case_document.consent_intent_issued",
        resourceType: "case_document",
        resourceId: documentId,
        changedFields: [],
        metadata: {
          documentRowVersion: intent.documentRowVersion,
          targetVersionNumber: intent.targetVersionNumber,
        },
      });
      return intent;
    }, { isolationLevel: "repeatable read" });
    const signed = createConsentIntentToken(
      consentIntentContext(request.actor, childId, documentId, {
        documentRowVersion: prepared.documentRowVersion,
        targetVersionNumber: prepared.targetVersionNumber,
        expectedSourceHash: prepared.sourceHash,
      }),
      app.config.auditHashKey,
    );
    setVersionEtag(reply, { rowVersion: prepared.documentRowVersion });
    return {
      token: signed.token,
      sourceHash: prepared.sourceHash,
      targetVersionNumber: prepared.targetVersionNumber,
      documentRowVersion: prepared.documentRowVersion,
      expiresAt: signed.expiresAt,
    };
  });

  app.post("/children/:childId/documents/:documentId/transitions", async (request, reply) => {
    requireWorkflowPermission(request.actor, request.body?.action);
    const { childId, documentId } = parseInput(paramsSchema, request.params);
    const input = parseWorkflowBody(request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const document = await withTenantTransaction(app.db, request.actor, async (client) => {
      if (input.action === "consent") {
        const tokenValid = verifyConsentIntentToken(
          input.consent.sourceReview.token,
          consentIntentContext(request.actor, childId, documentId, input.consent.sourceReview),
          app.config.auditHashKey,
        );
        if (!tokenValid) {
          throw conflict(
            "CONSENT_INTENT_INVALID",
            "同意内容の確認期限が切れました。最新内容を確認してから同意を記録してください。",
          );
        }
      }
      const transitioned = await transitionDocument(
        client,
        request.actor,
        childId,
        documentId,
        expectedVersion,
        input,
        { consentIntentHashKey: app.config.auditHashKey },
      );
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: transitioned.facilityId,
        actorUserId: request.actor.userId,
        action: `case_document.${input.action}`,
        resourceType: "case_document",
        resourceId: documentId,
        changedFields: ["status"],
        metadata: {
          workflowAction: input.action,
          status: transitioned.status,
          documentKind: transitioned.documentKind,
          versionNumber: transitioned.versionNumber,
          rowVersion: transitioned.rowVersion,
        },
      });
      return transitioned;
    }, { isolationLevel: input.action === "consent" ? "repeatable read" : "read committed" });
    return setVersionEtag(reply, document);
  });
}
