import { v7 as uuidv7 } from "uuid";
import { conflict, notFound } from "../errors.js";
import {
  assertConsentIntentSource,
  hasVerifiedCurrentConsentSource,
} from "./document-snapshots.js";

export const DOCUMENT_WORKFLOW_ACTIONS = Object.freeze([
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

const SIMPLE_TRANSITIONS = Object.freeze({
  submit: Object.freeze({ from: ["draft"], to: "internal_review", eventType: "submitted" }),
  explain: Object.freeze({ from: ["internal_review"], to: "explanation_pending", eventType: "explained" }),
  consent: Object.freeze({ from: ["explanation_pending"], to: "consented", eventType: "consented" }),
  approve: Object.freeze({ from: ["consented"], to: "approved", eventType: "approved" }),
  distribute: Object.freeze({ from: ["approved"], to: "distributed", eventType: "distributed" }),
  activate: Object.freeze({ from: ["distributed"], to: "active", eventType: "activated" }),
  supersede: Object.freeze({ from: ["active"], to: "superseded", eventType: "superseded" }),
  close: Object.freeze({ from: ["active"], to: "closed", eventType: "closed" }),
  void: Object.freeze({
    from: ["draft", "internal_review", "explanation_pending", "consented", "approved", "distributed", "active"],
    to: "void",
    eventType: "voided",
  }),
});

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeDocumentState(row) {
  return {
    id: row.id,
    childId: row.child_id,
    facilityId: row.facility_id,
    documentKind: row.document_kind,
    status: row.status,
    versionNumber: Number(row.version_number),
    consentedAt: dateTime(row.consented_at),
    approvedAt: dateTime(row.approved_at),
    approvedBy: row.approved_by,
    distributedAt: dateTime(row.distributed_at),
    updatedAt: dateTime(row.updated_at),
    updatedBy: row.updated_by,
    rowVersion: Number(row.row_version),
  };
}

function serializeEvent(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    actorNameSnapshot: row.actor_name_snapshot,
    actorRoleSnapshot: row.actor_role_snapshot,
    eventAt: dateTime(row.event_at),
    reason: row.reason,
    metadata: row.metadata || {},
  };
}

function serializeConsent(row) {
  return {
    id: row.id,
    targetVersionNumber: Number(row.target_version_number),
    documentRowVersion: Number(row.document_row_version),
    signerName: row.signer_name,
    signerRelationship: row.signer_relationship,
    explanationMethod: row.explanation_method,
    explainedAt: dateTime(row.explained_at),
    consentedAt: dateTime(row.consented_at),
    explainedBy: row.explained_by,
    createdAt: dateTime(row.created_at),
  };
}

function serializeDistribution(row) {
  return {
    id: row.id,
    targetVersionNumber: Number(row.target_version_number),
    documentRowVersion: Number(row.document_row_version),
    recipientName: row.recipient_name,
    deliveryMethod: row.delivery_method,
    distributedAt: dateTime(row.distributed_at),
    distributedBy: row.distributed_by,
    createdAt: dateTime(row.created_at),
  };
}

async function readDocument(client, tenantId, childId, documentId, options = {}) {
  const result = await client.query(
    `select d.*
     from public.case_documents d
     where d.tenant_id = $1 and d.child_id = $2 and d.id = $3 and d.deleted_at is null
       and d.document_kind in ('consultation_plan', 'individual_support_plan')
     ${options.forUpdate ? "for update" : ""}`,
    [tenantId, childId, documentId],
  );
  if (!result.rows[0]) throw notFound("計画書が見つかりません。");
  return result.rows[0];
}

function transitionFor(action, currentStatus) {
  if (action === "return") {
    if (currentStatus === "internal_review") {
      return { from: ["internal_review"], to: "draft", eventType: "returned" };
    }
    if (["explanation_pending", "consented"].includes(currentStatus)) {
      return { from: [currentStatus], to: "internal_review", eventType: "returned" };
    }
    return null;
  }
  const transition = SIMPLE_TRANSITIONS[action];
  return transition?.from.includes(currentStatus) ? transition : null;
}

function editConflict(row) {
  return conflict("EDIT_CONFLICT", "別の職員が計画書を更新しました。最新内容を確認してください。", {
    currentVersion: Number(row.row_version),
    updatedAt: dateTime(row.updated_at),
    updatedBy: row.updated_by,
  });
}

function invalidTransition(action, currentStatus) {
  return conflict(
    "INVALID_TRANSITION",
    "現在の工程から指定された操作へ進めません。最新の工程を確認してください。",
    { action, currentStatus },
  );
}

export async function getDocumentWorkflow(client, tenantId, childId, documentId) {
  const document = await readDocument(client, tenantId, childId, documentId);
  const events = await client.query(
    `select * from public.document_events
     where tenant_id = $1 and document_id = $2
     order by event_at, id`,
    [tenantId, documentId],
  );
  const consents = await client.query(
    `select * from public.document_consent_records
     where tenant_id = $1 and document_id = $2
     order by created_at, id`,
    [tenantId, documentId],
  );
  const distributions = await client.query(
    `select * from public.document_distribution_records
     where tenant_id = $1 and document_id = $2
     order by created_at, id`,
    [tenantId, documentId],
  );
  return {
    document: serializeDocumentState(document),
    events: events.rows.map(serializeEvent),
    consents: consents.rows.map(serializeConsent),
    distributions: distributions.rows.map(serializeDistribution),
  };
}

export async function transitionDocument(
  client,
  actor,
  childId,
  documentId,
  expectedVersion,
  input,
  options = {},
) {
  const current = await readDocument(client, actor.tenantId, childId, documentId, { forUpdate: true });
  if (Number(current.row_version) !== expectedVersion) throw editConflict(current);

  const transition = transitionFor(input.action, current.status);
  if (!transition) throw invalidTransition(input.action, current.status);
  if (
    input.action === "approve"
    && !(await hasVerifiedCurrentConsentSource(client, actor.tenantId, current))
  ) {
    throw conflict(
      "CONSENT_REQUIRED",
      "現在の計画書本文を対象とした同意記録が必要です。再度説明・同意を記録してください。",
    );
  }
  if (input.action === "consent") {
    await assertConsentIntentSource(
      client,
      actor,
      childId,
      current,
      input.consent.sourceReview,
      options.consentIntentHashKey,
    );
  }

  const assignments = ["status = $5", "updated_by = $6"];
  const parameters = [actor.tenantId, childId, documentId, expectedVersion, transition.to, actor.userId];

  if (input.action === "consent") {
    parameters.push(input.consent.consentedAt);
    assignments.push(`consented_at = $${parameters.length}::timestamptz`);
  } else if (input.action === "return" && current.status === "consented") {
    assignments.push("consented_at = null");
  } else if (input.action === "approve") {
    assignments.push("approved_at = now()", "approved_by = $6");
  } else if (input.action === "distribute") {
    parameters.push(input.distribution.distributedAt);
    assignments.push(`distributed_at = $${parameters.length}::timestamptz`);
  }

  const updatedResult = await client.query(
    `update public.case_documents
     set ${assignments.join(", ")}
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4
       and deleted_at is null
     returning *`,
    parameters,
  );
  if (!updatedResult.rows[0]) {
    const latest = await readDocument(client, actor.tenantId, childId, documentId);
    throw editConflict(latest);
  }
  const updated = updatedResult.rows[0];

  if (input.action === "consent") {
    const consentRecordId = uuidv7();
    await client.query(
      `select app_private.append_document_consent(
        $1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz
      )`,
      [
        consentRecordId,
        documentId,
        updated.row_version,
        input.consent.signerName,
        input.consent.signerRelationship,
        input.consent.explanationMethod,
        input.consent.explainedAt,
        input.consent.consentedAt,
      ],
    );
  }
  if (input.action === "distribute") {
    await client.query(
      `select app_private.append_document_distribution(
        $1, $2, $3, $4, $5, $6::timestamptz
      )`,
      [
        uuidv7(),
        documentId,
        updated.row_version,
        input.distribution.recipientName,
        input.distribution.deliveryMethod,
        input.distribution.distributedAt,
      ],
    );
  }

  await client.query(
    "select app_private.append_document_event($1, $2, $3, $4, $5::jsonb)",
    [
      uuidv7(),
      documentId,
      transition.eventType,
      input.reason || null,
      JSON.stringify({
        action: input.action,
        fromStatus: current.status,
        toStatus: transition.to,
        documentVersionNumber: Number(updated.version_number),
        documentRowVersion: Number(updated.row_version),
      }),
    ],
  );

  return serializeDocumentState(updated);
}
