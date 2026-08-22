import { z } from "zod";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import { applyIdempotencyReply, withIdempotentTenantTransaction } from "../db/idempotency.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import {
  createFamilyMember,
  createInstitution,
  createInstitutionRelation,
  getFamilyMember,
  getInstitution,
  getInstitutionRelation,
  listFamilyMembers,
  listInstitutionRelations,
  listInstitutions,
  updateFamilyMember,
  updateInstitution,
  updateInstitutionRelation,
} from "../repositories/case-context.js";
import { dateSchema, parseIfMatch, parseInput, setVersionEtag, uuidSchema } from "./validation.js";

const cohabitationStatusSchema = z.enum([
  "same_household",
  "separate_household",
  "unknown",
]);

const institutionKindSchema = z.enum([
  "consultation_support",
  "school",
  "nursery",
  "medical",
  "welfare",
  "day_service",
  "home_care",
  "community",
  "other",
]);

const familyMemberCreateSchema = z
  .object({
    displayLabel: z.string().trim().min(1).max(100),
    relationship: z.string().trim().min(1).max(100),
    age: z.number().int().min(0).max(130).optional(),
    occupationOrRole: z.string().trim().max(200).optional(),
    cohabitationStatus: cohabitationStatusSchema.optional(),
    supportSummary: z.string().trim().max(4000).optional(),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

const familyMemberUpdateSchema = z
  .object({
    displayLabel: z.string().trim().min(1).max(100).optional(),
    relationship: z.string().trim().min(1).max(100).optional(),
    age: z.number().int().min(0).max(130).nullable().optional(),
    occupationOrRole: z.string().trim().max(200).nullable().optional(),
    cohabitationStatus: cohabitationStatusSchema.nullable().optional(),
    supportSummary: z.string().trim().max(4000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");

const institutionCreateSchema = z
  .object({
    kind: institutionKindSchema,
    name: z.string().trim().min(1).max(200),
    contactName: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(50).optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict();

const institutionUpdateSchema = z
  .object({
    kind: institutionKindSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    contactName: z.string().trim().max(100).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください");

function hasValidPeriod(value) {
  return !value.validFrom || !value.validTo || value.validTo >= value.validFrom;
}

const relationCreateSchema = z
  .object({
    institutionId: uuidSchema,
    relationshipKind: z.string().trim().min(1).max(100),
    serviceDetails: z.string().trim().max(8000).optional(),
    frequencyText: z.string().trim().max(1000).optional(),
    validFrom: dateSchema.optional(),
    validTo: dateSchema.optional(),
  })
  .strict()
  .refine(hasValidPeriod, {
    path: ["validTo"],
    message: "終了日は開始日以降にしてください",
  });

const relationUpdateSchema = z
  .object({
    institutionId: uuidSchema.optional(),
    relationshipKind: z.string().trim().min(1).max(100).optional(),
    serviceDetails: z.string().trim().max(8000).nullable().optional(),
    frequencyText: z.string().trim().max(1000).nullable().optional(),
    validFrom: dateSchema.nullable().optional(),
    validTo: dateSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "変更する項目を指定してください")
  .refine(hasValidPeriod, {
    path: ["validTo"],
    message: "終了日は開始日以降にしてください",
  });

const childParamsSchema = z.object({ childId: uuidSchema }).strict();
const familyMemberParamsSchema = z
  .object({ childId: uuidSchema, familyMemberId: uuidSchema })
  .strict();
const institutionParamsSchema = z.object({ institutionId: uuidSchema }).strict();
const institutionListQuerySchema = z.object({ kind: institutionKindSchema.optional() }).strict();
const relationParamsSchema = z.object({ childId: uuidSchema, relationId: uuidSchema }).strict();

function requireCaseContextEditor(actor) {
  return requirePermission(actor, PERMISSIONS.EDIT_CASE_CONTEXT);
}

export async function caseContextRoutes(app) {
  app.get("/children/:childId/family-members", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listFamilyMembers(client, request.actor.tenantId, childId),
    );
  });

  app.post("/children/:childId/family-members", async (request, reply) => {
    requireCaseContextEditor(request.actor);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseInput(familyMemberCreateSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withIdempotentTenantTransaction(
      app.db,
      request.actor,
      request,
      async (client) => {
        const created = await createFamilyMember(client, request.actor, childId, input);
        await writeAuditEvent(client, {
          ...audit,
          facilityId: created.facilityId,
          action: "family_member.created",
          resourceType: "family_member",
          resourceId: created.entity.id,
          changedFields: Object.keys(input),
        });
        return created.entity;
      },
    );
    const entity = applyIdempotencyReply(reply, result);
    return setVersionEtag(reply, entity);
  });

  app.get("/children/:childId/family-members/:familyMemberId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId, familyMemberId } = parseInput(familyMemberParamsSchema, request.params);
    const entity = await withTenantTransaction(app.db, request.actor, (client) =>
      getFamilyMember(client, request.actor.tenantId, childId, familyMemberId),
    );
    return setVersionEtag(reply, entity);
  });

  app.patch("/children/:childId/family-members/:familyMemberId", async (request, reply) => {
    requireCaseContextEditor(request.actor);
    const { childId, familyMemberId } = parseInput(familyMemberParamsSchema, request.params);
    const input = parseInput(familyMemberUpdateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const entity = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateFamilyMember(
        client,
        request.actor,
        childId,
        familyMemberId,
        expectedVersion,
        input,
      );
      await writeAuditEvent(client, {
        ...audit,
        facilityId: updated.facilityId,
        action: "family_member.updated",
        resourceType: "family_member",
        resourceId: familyMemberId,
        changedFields: Object.keys(input),
      });
      return updated.entity;
    });
    return setVersionEtag(reply, entity);
  });

  app.get("/institutions", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { kind } = parseInput(institutionListQuerySchema, request.query);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listInstitutions(client, request.actor.tenantId, kind),
    );
  });

  app.post("/institutions", async (request, reply) => {
    requireCaseContextEditor(request.actor);
    const input = parseInput(institutionCreateSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withIdempotentTenantTransaction(
      app.db,
      request.actor,
      request,
      async (client) => {
        const created = await createInstitution(client, request.actor, input);
        await writeAuditEvent(client, {
          ...audit,
          action: "institution.created",
          resourceType: "institution",
          resourceId: created.id,
          changedFields: Object.keys(input),
          metadata: { kind: created.kind },
        });
        return created;
      },
    );
    const entity = applyIdempotencyReply(reply, result);
    return setVersionEtag(reply, entity);
  });

  app.get("/institutions/:institutionId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { institutionId } = parseInput(institutionParamsSchema, request.params);
    const entity = await withTenantTransaction(app.db, request.actor, (client) =>
      getInstitution(client, request.actor.tenantId, institutionId),
    );
    return setVersionEtag(reply, entity);
  });

  app.patch("/institutions/:institutionId", async (request, reply) => {
    requireCaseContextEditor(request.actor);
    const { institutionId } = parseInput(institutionParamsSchema, request.params);
    const input = parseInput(institutionUpdateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);
    const entity = await withTenantTransaction(app.db, request.actor, async (client) => {
      const updated = await updateInstitution(
        client,
        request.actor,
        institutionId,
        expectedVersion,
        input,
      );
      await writeAuditEvent(client, {
        ...audit,
        action: "institution.updated",
        resourceType: "institution",
        resourceId: institutionId,
        changedFields: Object.keys(input),
        metadata: { kind: updated.kind },
      });
      return updated;
    });
    return setVersionEtag(reply, entity);
  });

  app.get("/children/:childId/institution-relations", async (request) => {
    requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
    const { childId } = parseInput(childParamsSchema, request.params);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listInstitutionRelations(client, request.actor.tenantId, childId),
    );
  });

  app.post("/children/:childId/institution-relations", async (request, reply) => {
    requireCaseContextEditor(request.actor);
    const { childId } = parseInput(childParamsSchema, request.params);
    const input = parseInput(relationCreateSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);
    const result = await withIdempotentTenantTransaction(
      app.db,
      request.actor,
      request,
      async (client) => {
        const created = await createInstitutionRelation(client, request.actor, childId, input);
        await writeAuditEvent(client, {
          ...audit,
          facilityId: created.facilityId,
          action: "child_institution_relation.created",
          resourceType: "child_institution_relation",
          resourceId: created.entity.id,
          changedFields: Object.keys(input),
          metadata: { institutionKind: created.entity.institution.kind },
        });
        return created.entity;
      },
    );
    const entity = applyIdempotencyReply(reply, result);
    return setVersionEtag(reply, entity);
  });

  app.get(
    "/children/:childId/institution-relations/:relationId",
    async (request, reply) => {
      requirePermission(request.actor, PERMISSIONS.VIEW_CLIENTS);
      const { childId, relationId } = parseInput(relationParamsSchema, request.params);
      const entity = await withTenantTransaction(app.db, request.actor, (client) =>
        getInstitutionRelation(client, request.actor.tenantId, childId, relationId),
      );
      return setVersionEtag(reply, entity);
    },
  );

  app.patch(
    "/children/:childId/institution-relations/:relationId",
    async (request, reply) => {
      requireCaseContextEditor(request.actor);
      const { childId, relationId } = parseInput(relationParamsSchema, request.params);
      const input = parseInput(relationUpdateSchema, request.body);
      const expectedVersion = parseIfMatch(request);
      const audit = auditContextFromRequest(request, app.config);
      const entity = await withTenantTransaction(app.db, request.actor, async (client) => {
        const updated = await updateInstitutionRelation(
          client,
          request.actor,
          childId,
          relationId,
          expectedVersion,
          input,
        );
        await writeAuditEvent(client, {
          ...audit,
          facilityId: updated.facilityId,
          action: "child_institution_relation.updated",
          resourceType: "child_institution_relation",
          resourceId: relationId,
          changedFields: Object.keys(input),
          metadata: { institutionKind: updated.entity.institution.kind },
        });
        return updated.entity;
      });
      return setVersionEtag(reply, entity);
    },
  );
}
