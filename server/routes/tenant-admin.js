import { z } from "zod";
import { randomUUID } from "node:crypto";
import { classifyCognitoDeliveryError } from "../aws/cognito-admin.js";
import { auditContextFromRequest, writeAuditEvent } from "../audit.js";
import { PERMISSIONS, requirePermission } from "../auth/permissions.js";
import {
  applyIdempotencyReply,
  describeIdempotentRequest,
  readIdempotentTenantResult,
  withIdempotentTenantTransaction,
} from "../db/idempotency.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { AppError } from "../errors.js";
import {
  inviteStaff,
  claimInvitationDelivery,
  completeInvitationDeliveryClaim,
  getInvitationDeliveryState,
  getVisibleStaff,
  listStaff,
  markInvitationDeliveryClaimAmbiguous,
  recordInvitationDelivery,
  updateStaffMembership,
} from "../repositories/tenant-admin.js";
import { parseIfMatch, setVersionEtag, uuidSchema } from "./validation.js";

const staffRoleSchema = z.enum([
  "tenant_admin",
  "facility_admin",
  "plan_approver",
  "support_staff",
  "viewer",
  "auditor",
]);
const staffStatusSchema = z.enum(["active", "suspended", "ended"]);
const facilityIdsSchema = z.array(uuidSchema).max(100);

const invitationSchema = z
  .object({
    email: z.string().trim().email().max(320),
    displayName: z.string().trim().min(1).max(100),
    role: staffRoleSchema,
    facilityIds: facilityIdsSchema.default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role !== "tenant_admin" && value.facilityIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["facilityIds"],
        message: "この権限には担当施設を1件以上指定してください。",
      });
    }
  });

const updateSchema = z
  .object({
    role: staffRoleSchema.optional(),
    status: staffStatusSchema.optional(),
    facilityIds: facilityIdsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "変更する項目を指定してください。",
  });

function parseAdminInput(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(422, "VALIDATION_ERROR", "職員情報の入力内容を確認してください。", {
    details: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function invitationMetadata(created) {
  return {
    role: created.staff.role,
    membershipStatus: created.staff.status,
    facilityCount: created.staff.facilityIds.length,
    requiresCognitoInvitation: created.requiresCognitoInvitation,
  };
}

async function writeStaffAuditEvents(client, event, facilityIds = []) {
  const scopes = [...new Set(facilityIds)].sort();
  if (scopes.length === 0) scopes.push(null);
  for (const facilityId of scopes) {
    await writeAuditEvent(client, { ...event, facilityId });
  }
}

async function deliverCognitoInvitation(app, staff, cognitoUsername) {
  try {
    if (!app.cognitoAdmin) {
      const error = new Error("Cognito administrator is not configured");
      error.name = "ResourceNotFoundException";
      throw error;
    }
    const result = await app.cognitoAdmin.inviteUser({
      email: staff.email,
      displayName: staff.displayName,
      operation: cognitoUsername ? "resend" : "create",
      username: cognitoUsername,
    });
    return {
      outcome: "succeeded",
      succeeded: true,
      username: result.username,
      errorCode: null,
    };
  } catch (error) {
    const classification = classifyCognitoDeliveryError(error);
    return {
      outcome: classification.outcome,
      succeeded: false,
      username: null,
      errorCode: classification.errorCode,
    };
  }
}

async function persistInvitationDeliveryWithClient(
  client,
  request,
  audit,
  staff,
  delivery,
  claimToken,
) {
  const updated = await recordInvitationDelivery(
    client,
    request.actor,
    staff.invitation.id,
    delivery,
  );
  await writeStaffAuditEvents(client, {
    ...audit,
    action: delivery.succeeded ? "staff.invitation_sent" : "staff.invitation_delivery_failed",
    resourceType: "staff_membership",
    resourceId: staff.membershipId,
    outcome: delivery.succeeded ? "success" : "failed",
    changedFields: ["invitation.status"],
    metadata: {
      deliveryErrorCode: delivery.errorCode,
      role: staff.role,
      facilityCount: staff.facilityIds.length,
    },
  }, staff.facilityIds);
  await completeInvitationDeliveryClaim(client, claimToken, delivery);
  return updated;
}

async function persistInvitationDelivery(app, request, audit, staff, delivery, claimToken) {
  return withTenantTransaction(app.db, request.actor, (client) =>
    persistInvitationDeliveryWithClient(client, request, audit, staff, delivery, claimToken));
}

async function acquireInvitationDeliveryClaim(app, request, staff) {
  const descriptor = describeIdempotentRequest(request);
  if (!descriptor) throw new TypeError("invitation delivery requires an idempotency descriptor");
  const claimToken = randomUUID();
  const outcome = await withTenantTransaction(app.db, request.actor, (client) =>
    claimInvitationDelivery(
      client,
      staff.membershipId,
      staff.invitation.id,
      descriptor,
      claimToken,
    ));
  return { outcome, claimToken };
}

async function persistAmbiguousInvitationDelivery(app, request, audit, staff, delivery, claimToken) {
  await withTenantTransaction(app.db, request.actor, async (client) => {
    await markInvitationDeliveryClaimAmbiguous(client, claimToken, delivery);
    await writeStaffAuditEvents(client, {
      ...audit,
      action: "staff.invitation_delivery_unknown",
      resourceType: "staff_membership",
      resourceId: staff.membershipId,
      outcome: "failed",
      changedFields: [],
      metadata: {
        deliveryErrorCode: delivery.errorCode,
        role: staff.role,
        facilityCount: staff.facilityIds.length,
        reconciliationRequired: true,
      },
    }, staff.facilityIds);
  });
}

function invitationReconciliationError(membershipId) {
  return new AppError(
    409,
    "STAFF_INVITATION_RECONCILIATION_REQUIRED",
    "前回の招待メール送信結果を確認できません。運用担当者がCognitoの送信記録を確認するまで再送できません。",
    { details: { membershipId } },
  );
}

function assertInvitationDeliveryClaim(claim, membershipId) {
  if (claim.outcome === "claimed") return;
  if (claim.outcome === "replayed") return;
  if (claim.outcome === "reconciliation_required") {
    throw invitationReconciliationError(membershipId);
  }
  throw new AppError(
    409,
    "STAFF_INVITATION_DELIVERY_IN_PROGRESS",
    "同じ職員への招待メールを送信中です。少し待ってから職員一覧を更新してください。",
    { details: { membershipId } },
  );
}

export async function tenantAdminRoutes(app) {
  app.get("/staff", async (request) => {
    requirePermission(request.actor, PERMISSIONS.MANAGE_STAFF);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listStaff(client, request.actor),
    );
  });

  app.post("/staff/invitations", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.MANAGE_STAFF);
    if (request.headers["idempotency-key"] === undefined) {
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "職員招待にはIdempotency-Keyが必要です。画面を再読み込みして再度お試しください。",
      );
    }
    const input = parseAdminInput(invitationSchema, request.body);
    const audit = auditContextFromRequest(request, app.config);

    const creation = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const invitation = await inviteStaff(client, request.actor, input);
      await writeStaffAuditEvents(client, {
        ...audit,
        action: "staff.invited",
        resourceType: "staff_membership",
        resourceId: invitation.membershipId,
        changedFields: ["role", "status", "facilityIds"],
        metadata: invitationMetadata(invitation),
      }, invitation.staff.facilityIds);
      return invitation;
    });
    const created = creation.body;
    if (creation.replayed) reply.header("Idempotency-Replayed", "true");

    const deliveryState = await withTenantTransaction(app.db, request.actor, (client) =>
      getInvitationDeliveryState(client, request.actor, created.membershipId),
    );
    const currentStaff = deliveryState.staff;

    if (
      !created.requiresCognitoInvitation
      || ["sent", "accepted"].includes(currentStaff.invitation?.status)
    ) {
      reply.code(201);
      return setVersionEtag(reply, currentStaff);
    }

    const claim = await acquireInvitationDeliveryClaim(app, request, currentStaff);
    assertInvitationDeliveryClaim(claim, currentStaff.membershipId);
    if (claim.outcome === "replayed") {
      const replayedStaff = await withTenantTransaction(app.db, request.actor, (client) =>
        getVisibleStaff(client, request.actor, created.membershipId));
      reply.header("Idempotency-Replayed", "true");
      reply.code(201);
      return setVersionEtag(reply, replayedStaff);
    }

    const delivery = await deliverCognitoInvitation(
      app,
      currentStaff,
      deliveryState.cognitoUsername,
    );
    if (delivery.outcome === "unknown") {
      await persistAmbiguousInvitationDelivery(
        app,
        request,
        audit,
        currentStaff,
        delivery,
        claim.claimToken,
      );
      throw invitationReconciliationError(currentStaff.membershipId);
    }
    const staff = await persistInvitationDelivery(
      app,
      request,
      audit,
      currentStaff,
      delivery,
      claim.claimToken,
    );

    if (!delivery.succeeded) {
      throw new AppError(
        502,
        "STAFF_INVITATION_DELIVERY_FAILED",
        "職員アカウントは登録されましたが、招待メールを送信できませんでした。職員一覧から再送してください。",
        { details: { membershipId: created.membershipId } },
      );
    }

    reply.code(201);
    return setVersionEtag(reply, staff);
  });

  app.post("/staff/:membershipId/invitation-resends", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.MANAGE_STAFF);
    if (request.headers["idempotency-key"] === undefined) {
      throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "招待メールの再送にはIdempotency-Keyが必要です。");
    }
    const { membershipId } = parseAdminInput(
      z.object({ membershipId: uuidSchema }).strict(),
      request.params,
    );
    const audit = auditContextFromRequest(request, app.config);
    const replay = await readIdempotentTenantResult(app.db, request.actor, request);
    if (replay) {
      return setVersionEtag(reply, applyIdempotencyReply(reply, replay));
    }
    const deliveryState = await withTenantTransaction(app.db, request.actor, (client) =>
      getInvitationDeliveryState(client, request.actor, membershipId),
    );
    const currentStaff = deliveryState.staff;
    if (!currentStaff.invitation) {
      throw new AppError(409, "STAFF_INVITATION_NOT_AVAILABLE", "再送できる職員招待がありません。");
    }
    if (currentStaff.invitation.status === "accepted") {
      const result = await withIdempotentTenantTransaction(
        app.db,
        request.actor,
        request,
        () => currentStaff,
        { statusCode: 200 },
      );
      return setVersionEtag(reply, applyIdempotencyReply(reply, result));
    }
    if (!["pending", "failed", "sent"].includes(currentStaff.invitation.status)) {
      throw new AppError(409, "STAFF_INVITATION_NOT_AVAILABLE", "この職員招待は現在再送できません。");
    }

    const claim = await acquireInvitationDeliveryClaim(app, request, currentStaff);
    assertInvitationDeliveryClaim(claim, currentStaff.membershipId);
    if (claim.outcome === "replayed") {
      const replayedStaff = await withTenantTransaction(app.db, request.actor, (client) =>
        getVisibleStaff(client, request.actor, membershipId));
      reply.header("Idempotency-Replayed", "true");
      reply.code(200);
      return setVersionEtag(reply, replayedStaff);
    }

    const delivery = await deliverCognitoInvitation(
      app,
      currentStaff,
      deliveryState.cognitoUsername,
    );
    if (delivery.outcome === "unknown") {
      await persistAmbiguousInvitationDelivery(
        app,
        request,
        audit,
        currentStaff,
        delivery,
        claim.claimToken,
      );
      throw invitationReconciliationError(currentStaff.membershipId);
    }
    if (!delivery.succeeded) {
      await persistInvitationDelivery(
        app,
        request,
        audit,
        currentStaff,
        delivery,
        claim.claimToken,
      );
      throw new AppError(
        502,
        "STAFF_INVITATION_DELIVERY_FAILED",
        "招待メールを再送できませんでした。時間をおいて再度お試しください。",
        { details: { membershipId } },
      );
    }
    const result = await withIdempotentTenantTransaction(
      app.db,
      request.actor,
      request,
      (client) => persistInvitationDeliveryWithClient(
        client,
        request,
        audit,
        currentStaff,
        delivery,
        claim.claimToken,
      ),
      { statusCode: 200 },
    );
    return setVersionEtag(reply, applyIdempotencyReply(reply, result));
  });

  app.patch("/staff/:membershipId", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.MANAGE_STAFF);
    const { membershipId } = parseAdminInput(
      z.object({ membershipId: uuidSchema }).strict(),
      request.params,
    );
    const changes = parseAdminInput(updateSchema, request.body);
    const expectedVersion = parseIfMatch(request);
    const audit = auditContextFromRequest(request, app.config);

    const staff = await withTenantTransaction(app.db, request.actor, async (client) => {
      const previous = await getVisibleStaff(client, request.actor, membershipId);
      const updated = await updateStaffMembership(
        client,
        request.actor,
        membershipId,
        expectedVersion,
        changes,
      );
      await writeStaffAuditEvents(client, {
        ...audit,
        action: "staff.membership_updated",
        resourceType: "staff_membership",
        resourceId: membershipId,
        changedFields: Object.keys(changes),
        metadata: {
          role: updated.role,
          status: updated.status,
          facilityCount: updated.facilityIds.length,
        },
      }, [...previous.facilityIds, ...updated.facilityIds]);
      return updated;
    });
    return setVersionEtag(reply, staff);
  });
}
