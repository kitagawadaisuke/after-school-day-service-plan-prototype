import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { notFound } from "../errors.js";
import { parseInput, uuidSchema } from "./validation.js";

const dailyFieldSchema = z.enum(["observation", "supportProvided", "childResponse", "healthNote"]);
const assessmentFieldSchema = z.enum([
  "childWishes", "familyWishes", "concerns", "desiredLife",
  "healthManagement", "movementSensory", "cognitionBehavior", "languageCommunication",
  "relationshipsSocial", "familySituation", "strengths", "priorityNeeds",
  "overallAssessment", "supportConsiderations", "medicalSafetyNotes", "supportNetwork", "planningNotes",
]);
const individualPlanFieldSchema = z.enum([
  "userAndFamilyWishes", "overallSupportPolicy", "consultationPlanBasis", "supportConsiderations",
  "serviceDelivery", "coordination", "monitoringPlan", "explanationNotes",
]);
const requestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daily_log"),
    field: dailyFieldSchema,
    sourceText: z.string().trim().min(1).max(4_000),
    activity: z.string().trim().max(500).optional(),
    targetCharacters: z.number().int().min(80).max(800),
  }).strict(),
  z.object({
    kind: z.literal("contact_reply"),
    familyMessage: z.string().trim().max(4_000).optional(),
    requestSummary: z.string().trim().max(2_000).optional(),
    facilityReply: z.string().trim().max(4_000).optional(),
    reflectedInSupport: z.boolean().default(false),
    targetCharacters: z.number().int().min(80).max(800),
  }).strict().refine((value) => Boolean(value.familyMessage || value.requestSummary || value.facilityReply), "入力内容を追加してください"),
  z.object({
    kind: z.literal("contact_request_summary"),
    familyMessage: z.string().trim().max(4_000).optional(),
    requestSummary: z.string().trim().max(2_000).optional(),
    targetCharacters: z.number().int().min(60).max(400),
  }).strict().refine((value) => Boolean(value.familyMessage || value.requestSummary), "家庭からの連絡または支援時の引継ぎを入力してください"),
  z.object({
    kind: z.literal("basic_assessment"),
    field: assessmentFieldSchema,
    sourceText: z.string().trim().min(1).max(8_000),
    targetCharacters: z.number().int().min(80).max(800),
  }).strict(),
  z.object({
    kind: z.literal("individual_support_plan"),
    field: individualPlanFieldSchema,
    sourceText: z.string().trim().min(1).max(8_000),
    targetCharacters: z.number().int().min(80).max(800),
  }).strict(),
]);

const paramsSchema = z.object({ childId: uuidSchema }).strict();

async function requireChildFacility(app, actor, childId) {
  return withTenantTransaction(app.db, actor, async (client) => {
    const result = await client.query(
      "select facility_id from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
      [actor.tenantId, childId],
    );
    if (!result.rows[0]) throw notFound("利用児が見つかりません。");
    return result.rows[0].facility_id;
  });
}

export async function writingAssistRoutes(app) {
  app.post("/children/:childId/writing-assist", async (request) => {
    const { childId } = parseInput(paramsSchema, request.params);
    const input = parseInput(requestSchema, request.body);
    requirePermission(request.actor, ["basic_assessment", "individual_support_plan"].includes(input.kind) ? PERMISSIONS.EDIT_DOCUMENTS : PERMISSIONS.EDIT_JOURNALS);
    const facilityId = await requireChildFacility(app, request.actor, childId);
    const generated = await app.writingAssistant.generate(input);
    const audit = auditContextFromRequest(request, app.config);
    await withTenantTransaction(app.db, request.actor, async (client) => {
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId,
        actorUserId: request.actor.userId,
        action: "ai_writing.generated",
        resourceType: input.kind,
        resourceId: childId,
        changedFields: [input.kind === "daily_log" || input.kind === "basic_assessment" || input.kind === "individual_support_plan" ? input.field : input.kind === "contact_request_summary" ? "requestSummary" : "facilityReply"],
        metadata: { targetCharacters: input.targetCharacters },
      });
    });
    return generated;
  });
}
