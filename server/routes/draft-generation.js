import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import { AppError } from "../errors.js";
import {
  generateDraft,
  listMonitoringResults,
  updateMonitoringResult,
} from "../repositories/draft-generation.js";
import { dateSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const basicAssessmentGenerationSchema = z
  .object({
    targetDocumentKind: z.literal("basic_assessment"),
    consultationPlanId: uuidSchema,
    currentScheduleVersionId: uuidSchema.optional(),
    previousMonitoringDocumentId: uuidSchema.optional(),
  })
  .strict();

const individualPlanGenerationSchema = z
  .object({
    targetDocumentKind: z.literal("individual_support_plan"),
    consultationPlanId: uuidSchema,
    assessmentDocumentId: uuidSchema,
    previousMonitoringDocumentId: uuidSchema.optional(),
  })
  .strict();

function isRealIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

const evidenceDateSchema = dateSchema.refine(isRealIsoDate, "実在する日付を指定してください。");

const monitoringGenerationSchema = z
  .object({
    targetDocumentKind: z.literal("monitoring_record"),
    individualSupportPlanId: uuidSchema.optional(),
    periodStart: evidenceDateSchema,
    periodEnd: evidenceDateSchema,
  })
  .strict()
  .refine((value) => value.periodEnd >= value.periodStart, {
    path: ["periodEnd"],
    message: "終了日は開始日以降にしてください。",
  })
  .refine((value) => {
    const days = (Date.parse(`${value.periodEnd}T00:00:00Z`) - Date.parse(`${value.periodStart}T00:00:00Z`)) / 86_400_000;
    return days <= 366;
  }, {
    path: ["periodEnd"],
    message: "根拠期間は366日以内にしてください。",
  });

const generationSchema = z.discriminatedUnion("targetDocumentKind", [
  basicAssessmentGenerationSchema,
  individualPlanGenerationSchema,
  monitoringGenerationSchema,
]);

const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const monitoringDocumentParamsSchema = z
  .object({ childId: uuidSchema, documentId: uuidSchema })
  .strict();
const monitoringResultParamsSchema = z
  .object({ childId: uuidSchema, documentId: uuidSchema, resultId: uuidSchema })
  .strict();

const progressStatusSchema = z.enum([
  "not_evaluated",
  "improving",
  "maintained",
  "mixed",
  "needs_review",
  "achieved",
]);
const nextGoalActionSchema = z.enum(["continue", "revise", "complete"]);
const updateMonitoringResultSchema = z
  .object({
    progressStatus: progressStatusSchema.optional(),
    progressSummary: z.string().trim().max(8000).nullable().optional(),
    currentChallenge: z.string().trim().max(8000).nullable().optional(),
    nextSupportPolicy: z.string().trim().max(8000).nullable().optional(),
    nextGoalAction: nextGoalActionSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください。");

function parseBody(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(422, "VALIDATION_ERROR", "入力内容を確認してください。", {
    details: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export async function draftGenerationRoutes(app) {
  app.post("/children/:childId/draft-generations", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseBody(generationSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const idempotentResult = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const result = await generateDraft(client, request.actor, childId, input);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: result.document.facilityId,
        actorUserId: request.actor.userId,
        action: "case_document.draft_generated",
        resourceType: "case_document",
        resourceId: result.document.id,
        changedFields: ["payload", ...(result.document.goals ? ["goals"] : []), ...(result.document.monitoringResults ? ["monitoringResults"] : [])],
        metadata: {
          targetDocumentKind: input.targetDocumentKind,
          sourceCount: result.sourceIds.length,
          evidenceCounts: result.evidenceCounts,
        },
      });
      return result.document;
    });
    const generated = applyIdempotencyReply(reply, idempotentResult);
    return setVersionEtag(reply, generated);
  });

  app.get(
    "/children/:childId/documents/:documentId/monitoring-results",
    async (request) => {
      requirePermission(request.actor, PERMISSIONS.VIEW_DOCUMENTS);
      const { childId, documentId } = parseInput(monitoringDocumentParamsSchema, request.params);
      return withTenantTransaction(app.db, request.actor, (client) =>
        listMonitoringResults(client, request.actor, childId, documentId),
      );
    },
  );

  app.patch(
    "/children/:childId/documents/:documentId/monitoring-results/:resultId",
    async (request, reply) => {
      requirePermission(request.actor, PERMISSIONS.EDIT_DOCUMENTS);
      const { childId, documentId, resultId } = parseInput(monitoringResultParamsSchema, request.params);
      const input = parseBody(updateMonitoringResultSchema, request.body);
      const expectedVersion = parseIfMatch(request);
      const audit = auditContextFromRequest(request, app.config);
      const updated = await withTenantTransaction(app.db, request.actor, async (client) => {
        const result = await updateMonitoringResult(
          client,
          request.actor,
          childId,
          documentId,
          resultId,
          expectedVersion,
          input,
        );
        await writeAuditEvent(client, {
          ...audit,
          tenantId: request.actor.tenantId,
          facilityId: result.facilityId,
          actorUserId: request.actor.userId,
          action: "monitoring_goal_result.updated",
          resourceType: "monitoring_goal_result",
          resourceId: resultId,
          changedFields: Object.keys(input),
          metadata: { documentId },
        });
        return result.result;
      });
      return setVersionEtag(reply, updated);
    },
  );
}
