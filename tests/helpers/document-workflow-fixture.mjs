import { v7 as uuidv7 } from "uuid";

const TRANSITIONS = Object.freeze({
  submit: Object.freeze({ from: "draft", to: "internal_review", eventType: "submitted" }),
  explain: Object.freeze({ from: "internal_review", to: "explanation_pending", eventType: "explained" }),
  consent: Object.freeze({ from: "explanation_pending", to: "consented", eventType: "consented" }),
  approve: Object.freeze({ from: "consented", to: "approved", eventType: "approved" }),
  distribute: Object.freeze({ from: "approved", to: "distributed", eventType: "distributed" }),
  activate: Object.freeze({ from: "distributed", to: "active", eventType: "activated" }),
});

// Test fixtures must obey the same database workflow contract as production.
// The caller owns the surrounding transaction and actor settings.
export async function advanceDocumentFixture(db, {
  tenantId,
  userId,
  documentId,
  action,
}) {
  const transition = TRANSITIONS[action];
  if (!transition) throw new Error(`unsupported fixture transition: ${action}`);

  const currentResult = await db.query(
    `select id, child_id, status, version_number, row_version
     from public.case_documents
     where tenant_id = $1 and id = $2
     for update`,
    [tenantId, documentId],
  );
  const current = currentResult.rows[0];
  if (!current || current.status !== transition.from) {
    throw new Error(`fixture expected ${transition.from}, received ${current?.status || "missing"}`);
  }

  const assignments = ["status = $3", "updated_by = $4"];
  if (action === "consent") assignments.push("consented_at = now() - interval '1 minute'");
  if (action === "approve") assignments.push("approved_at = now()", "approved_by = $4");
  if (action === "distribute") assignments.push("distributed_at = now()");

  const updatedResult = await db.query(
    `update public.case_documents
     set ${assignments.join(", ")}
     where tenant_id = $1 and id = $2
     returning id, child_id, status, version_number, row_version,
               consented_at, distributed_at`,
    [tenantId, documentId, transition.to, userId],
  );
  const updated = updatedResult.rows[0];

  if (action === "consent") {
    await db.query(
      `select app_private.append_document_consent(
        $1, $2, $3, 'Fixture Guardian', 'guardian', 'in_person',
        now() - interval '2 minutes', $4::timestamptz
      )`,
      [
        uuidv7(),
        documentId,
        updated.row_version,
        updated.consented_at,
      ],
    );
  }

  if (action === "distribute") {
    await db.query(
      `select app_private.append_document_distribution(
        $1, $2, $3, 'Fixture Guardian', 'in_person', $4::timestamptz
      )`,
      [uuidv7(), documentId, updated.row_version, updated.distributed_at],
    );
  }

  await db.query(
    "select app_private.append_document_event($1, $2, $3, null, $4::jsonb)",
    [
      uuidv7(),
      documentId,
      transition.eventType,
      JSON.stringify({
        action,
        fromStatus: transition.from,
        toStatus: transition.to,
        documentVersionNumber: Number(updated.version_number),
        documentRowVersion: Number(updated.row_version),
      }),
    ],
  );
  return updated;
}

export async function approveDocumentFixture(db, options) {
  await advanceDocumentFixture(db, { ...options, action: "submit" });
  await advanceDocumentFixture(db, { ...options, action: "explain" });
  await advanceDocumentFixture(db, { ...options, action: "consent" });
  return advanceDocumentFixture(db, { ...options, action: "approve" });
}
