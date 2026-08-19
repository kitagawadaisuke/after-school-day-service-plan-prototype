import { AppError, conflict, notFound } from "../errors.js";
import {
  digestMatches,
  hashConsentReviewSource,
  hashCiphertext,
  verifyCiphertext,
} from "../security/document-source-integrity.js";

const DRAFT_SOURCE_STATUSES = Object.freeze([
  "draft",
  "internal_review",
  "explanation_pending",
  "consented",
]);

const OFFICIAL_SOURCE_STATUSES = Object.freeze([
  "approved",
  "distributed",
  "active",
  "superseded",
  "closed",
]);

function dateOnly(value) {
  if (!value) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeSnapshot(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    documentRowVersion: Number(row.document_row_version),
    sourceStatus: row.source_status,
    templateVersion: row.template_version,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    mimeType: row.mime_type,
    snapshotKind: row.snapshot_kind,
    generatedBy: row.generated_by,
    generatedAt: dateTime(row.generated_at),
  };
}

function assertExpectedVersion(document, expectedVersion) {
  if (Number(document.row_version) !== expectedVersion) {
    throw conflict(
      "EDIT_CONFLICT",
      "別の職員が帳票の元データを更新しました。最新の内容を確認してください。",
      { currentVersion: Number(document.row_version), updatedAt: dateTime(document.updated_at) },
    );
  }
}

function assertSnapshotAllowed(snapshotKind, sourceStatus) {
  if (snapshotKind === "draft" && !DRAFT_SOURCE_STATUSES.includes(sourceStatus)) {
    throw conflict(
      "DRAFT_PDF_NOT_AVAILABLE",
      "承認後の計画書から下書きは作成できません。正式版を使用してください。",
    );
  }
  if (snapshotKind === "official" && !OFFICIAL_SOURCE_STATUSES.includes(sourceStatus)) {
    throw conflict(
      "OFFICIAL_PDF_NOT_AVAILABLE",
      "正式版PDFは、同意・承認が完了した計画書から作成できます。",
    );
  }
}

async function readDocumentForSnapshot(client, tenantId, childId, documentId, expectedVersion) {
  await client.query("select app_private.lock_document_for_pdf($1, $2)", [childId, documentId]);
  const result = await client.query(
    `select d.*
     from public.case_documents d
     where d.tenant_id = $1 and d.child_id = $2 and d.id = $3 and d.deleted_at is null`,
    [tenantId, childId, documentId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("帳票の元となる計画書が見つかりません。");
  assertExpectedVersion(row, expectedVersion);
  return row;
}

async function readSnapshotSourceDetails(
  client,
  tenantId,
  childId,
  documentRow,
  { finalizedSchedulesOnly = false } = {},
) {
  const [
    childResult,
    facilityResult,
    guardianResult,
    goalsResult,
    monitoringResult,
    scheduleResult,
    consentResult,
    distributionResult,
    approvalResult,
  ] = await Promise.all([
    client.query(
      `select id, management_code, display_name, legal_name, birth_date, grade,
              gender, disability_category, municipality_name, copayment_limit_yen,
              recipient_certificate_ciphertext, recipient_certificate_last4,
              certificate_valid_from, certificate_valid_to
       from public.children
       where tenant_id = $1 and id = $2 and deleted_at is null`,
      [tenantId, childId],
    ),
    client.query(
      `select f.id, f.code, f.name, f.service_type,
              o.id as organization_id, o.name as organization_name
       from public.facilities f
       join public.organizations o on o.id = f.tenant_id
       where f.tenant_id = $1 and f.id = $2`,
      [tenantId, documentRow.facility_id],
    ),
    client.query(
      `select legal_name, relationship
       from public.guardians
       where tenant_id = $1 and child_id = $2
       order by is_primary desc, created_at, id
       limit 1`,
      [tenantId, childId],
    ),
    client.query(
      `select * from public.document_goals
       where tenant_id = $1 and document_id = $2
       order by sort_order, id`,
      [tenantId, documentRow.id],
    ),
    client.query(
      `select r.*, g.title as goal_title
       from public.monitoring_goal_results r
       join public.document_goals g
         on g.tenant_id = r.tenant_id and g.id = r.goal_id
       where r.tenant_id = $1 and r.monitoring_document_id = $2
       order by g.sort_order, r.id`,
      [tenantId, documentRow.id],
    ),
    client.query(
      `select * from public.schedule_versions
       where tenant_id = $1 and child_id = $2
         ${finalizedSchedulesOnly ? "and status = 'finalized'" : ""}
       order by schedule_kind, version_number desc`,
      [tenantId, childId],
    ),
    client.query(
      `select signer_name, signer_relationship, explanation_method, explained_at, consented_at
       from public.document_consent_records
       where tenant_id = $1 and document_id = $2
       order by created_at desc, id desc
       limit 1`,
      [tenantId, documentRow.id],
    ),
    client.query(
      `select recipient_name, delivery_method, distributed_at
       from public.document_distribution_records
       where tenant_id = $1 and document_id = $2
       order by created_at desc, id desc
       limit 1`,
      [tenantId, documentRow.id],
    ),
    client.query(
      `select actor_name_snapshot, event_at
       from public.document_events
       where tenant_id = $1 and document_id = $2 and event_type = 'approved'
       order by event_at desc, id desc
       limit 1`,
      [tenantId, documentRow.id],
    ),
  ]);

  const child = childResult.rows[0];
  const facility = facilityResult.rows[0];
  if (!child || !facility) throw notFound("帳票の元となる基本情報が見つかりません。");

  const schedules = [];
  for (const schedule of scheduleResult.rows) {
    if (schedules.some((existing) => existing.schedule_kind === schedule.schedule_kind)) continue;
    const items = await client.query(
      `select * from public.schedule_items
       where tenant_id = $1 and schedule_version_id = $2
       order by day_of_week, start_minute, sort_order, id`,
      [tenantId, schedule.id],
    );
    schedules.push({ ...schedule, items: items.rows });
  }

  return {
    document: {
      id: documentRow.id,
      document_kind: documentRow.document_kind,
      status: documentRow.status,
      version_number: Number(documentRow.version_number),
      template_version: documentRow.template_version,
      period_start: dateOnly(documentRow.period_start),
      period_end: dateOnly(documentRow.period_end),
      payload: documentRow.payload || {},
      row_version: Number(documentRow.row_version),
      updated_at: dateTime(documentRow.updated_at),
    },
    child: {
      id: childId,
      management_code: child.management_code,
      display_name: child.display_name,
      legal_name: child.legal_name,
      birth_date: dateOnly(child.birth_date),
      grade: child.grade,
      gender: child.gender,
      disability_category: child.disability_category,
      municipality_name: child.municipality_name,
      copayment_limit_yen: child.copayment_limit_yen === null
        ? null
        : Number(child.copayment_limit_yen),
      recipient_certificate_ciphertext: child.recipient_certificate_ciphertext,
      recipient_certificate_last4: child.recipient_certificate_last4,
      certificate_valid_from: dateOnly(child.certificate_valid_from),
      certificate_valid_to: dateOnly(child.certificate_valid_to),
    },
    guardian: guardianResult.rows[0] || null,
    facility: {
      id: facility.id,
      code: facility.code,
      name: facility.name,
      service_type: facility.service_type,
    },
    organization: { id: facility.organization_id, name: facility.organization_name },
    approval: {
      approved_by_name: approvalResult.rows[0]?.actor_name_snapshot || null,
      approved_at: dateTime(approvalResult.rows[0]?.event_at),
    },
    consent: consentResult.rows[0] || null,
    distribution: distributionResult.rows[0] || null,
    goals: goalsResult.rows,
    monitoringResults: monitoringResult.rows,
    schedules,
  };
}

async function consentReviewSourceHash(client, actor, childId, documentRow, hashKey) {
  const source = await readSnapshotSourceDetails(
    client,
    actor.tenantId,
    childId,
    documentRow,
    { finalizedSchedulesOnly: true },
  );
  const certificateCiphertext = source.child.recipient_certificate_ciphertext || null;
  delete source.child.recipient_certificate_ciphertext;
  delete source.child.recipient_certificate_number;
  source.child.recipient_certificate_ciphertext_sha256 = hashCiphertext(certificateCiphertext);
  // These records describe workflow actions, not the care-plan content being
  // shown for consent. A prior returned consent must never affect a new review.
  source.approval = null;
  source.consent = null;
  source.distribution = null;
  return hashConsentReviewSource(source, hashKey);
}

export async function prepareConsentIntent(
  client,
  actor,
  childId,
  documentId,
  expectedVersion,
  hashKey,
) {
  const documentRow = await readDocumentForSnapshot(
    client,
    actor.tenantId,
    childId,
    documentId,
    expectedVersion,
  );
  if (documentRow.status !== "explanation_pending") {
    throw conflict(
      "CONSENT_INTENT_NOT_AVAILABLE",
      "説明待ちの計画書だけ同意内容を確認できます。最新の工程を確認してください。",
    );
  }
  return {
    facilityId: documentRow.facility_id,
    documentRowVersion: Number(documentRow.row_version),
    targetVersionNumber: Number(documentRow.version_number),
    sourceHash: await consentReviewSourceHash(client, actor, childId, documentRow, hashKey),
  };
}

export async function assertConsentIntentSource(
  client,
  actor,
  childId,
  documentRow,
  sourceReview,
  hashKey,
) {
  if (
    Number(sourceReview.documentRowVersion) !== Number(documentRow.row_version)
    || Number(sourceReview.targetVersionNumber) !== Number(documentRow.version_number)
  ) {
    throw conflict(
      "CONSENT_SOURCE_CHANGED",
      "確認後に計画書の内容が更新されました。最新内容を確認してから同意を記録してください。",
    );
  }
  const currentSourceHash = await consentReviewSourceHash(
    client,
    actor,
    childId,
    documentRow,
    hashKey,
  );
  if (!digestMatches(sourceReview.expectedSourceHash, currentSourceHash)) {
    throw conflict(
      "CONSENT_SOURCE_CHANGED",
      "確認後に計画書の内容が更新されました。最新内容を確認してから同意を記録してください。",
    );
  }
}

function missingConsentSource() {
  return conflict(
    "CONSENT_SOURCE_REQUIRED",
    "同意時点の帳票データを確認できません。再度、説明・同意を記録してください。",
  );
}

function consentSourceIntegrityError() {
  return new AppError(
    503,
    "CONSENT_SOURCE_INTEGRITY_ERROR",
    "同意時点の帳票データの完全性を確認できません。管理者に連絡してください。",
  );
}

async function readConsentSourceRow(client, tenantId, documentRow, { exactRowVersion = false } = {}) {
  const parameters = [
    tenantId,
    documentRow.id,
    documentRow.version_number,
    documentRow.consented_at,
  ];
  const result = await client.query(
    `select s.*,
            encode(sha256(convert_to(s.source_json::text, 'UTF8')), 'hex') as computed_source_sha256,
            case when s.recipient_certificate_ciphertext is null then null
                 else encode(sha256(s.recipient_certificate_ciphertext), 'hex') end
              as computed_certificate_ciphertext_sha256,
            c.signer_name, c.signer_relationship, c.explanation_method,
            c.explained_at, c.consented_at
     from public.document_consent_sources s
     join public.document_consent_records c
       on c.tenant_id = s.tenant_id and c.id = s.consent_record_id
     where s.tenant_id = $1 and s.document_id = $2
       and s.target_version_number = $3 and c.consented_at = $4
       ${exactRowVersion ? "and s.document_row_version = $5" : ""}
     order by s.captured_at desc, s.consent_record_id desc
     limit 1`,
    exactRowVersion ? [...parameters, documentRow.row_version] : parameters,
  );
  return result.rows[0] || null;
}

function verifiedSourceFromRow(row, tenantId, documentRow) {
  let source;
  try {
    source = typeof row.source_json === "string" ? JSON.parse(row.source_json) : structuredClone(row.source_json);
  } catch {
    throw consentSourceIntegrityError();
  }
  const certificateEvidenceValid = row.recipient_certificate_ciphertext === null
    ? row.recipient_certificate_ciphertext_sha256 === null
      && row.computed_certificate_ciphertext_sha256 === null
    : digestMatches(
        row.recipient_certificate_ciphertext_sha256,
        row.computed_certificate_ciphertext_sha256,
      )
      && verifyCiphertext(
        row.recipient_certificate_ciphertext,
        row.recipient_certificate_ciphertext_sha256,
      );
  if (
    !digestMatches(row.source_sha256, row.computed_source_sha256)
    || !certificateEvidenceValid
    || source?.organization?.id !== tenantId
    || source?.document?.id !== documentRow.id
    || source?.child?.id !== documentRow.child_id
    || Number(source?.document?.version_number) !== Number(documentRow.version_number)
    || Number(source?.document?.row_version) !== Number(row.document_row_version)
    || source?.document?.status !== "consented"
    || Object.hasOwn(source?.child || {}, "recipient_certificate_number")
    || Object.hasOwn(source?.child || {}, "recipient_certificate_ciphertext")
  ) {
    throw consentSourceIntegrityError();
  }
  return source;
}

export async function hasVerifiedCurrentConsentSource(client, tenantId, documentRow) {
  const row = await readConsentSourceRow(client, tenantId, documentRow, { exactRowVersion: true });
  if (!row) return false;
  verifiedSourceFromRow(row, tenantId, documentRow);
  return true;
}

async function readImmutableConsentSource(client, tenantId, documentRow) {
  const row = await readConsentSourceRow(client, tenantId, documentRow);
  if (!row) throw missingConsentSource();
  const source = verifiedSourceFromRow(row, tenantId, documentRow);

  const [eventsResult, distributionResult] = await Promise.all([
    client.query(
      `select event_type, actor_name_snapshot, event_at
       from public.document_events
       where tenant_id = $1 and document_id = $2
         and event_type in ('approved', 'distributed', 'activated', 'superseded', 'closed')
       order by event_at, id`,
      [tenantId, documentRow.id],
    ),
    client.query(
      `select recipient_name, delivery_method, distributed_at
       from public.document_distribution_records
       where tenant_id = $1 and document_id = $2
         and target_version_number = $3
       order by created_at desc, id desc
       limit 1`,
      [tenantId, documentRow.id, documentRow.version_number],
    ),
  ]);
  const approvalEvent = eventsResult.rows.find((event) => event.event_type === "approved");
  if (OFFICIAL_SOURCE_STATUSES.includes(documentRow.status) && !approvalEvent) {
    throw missingConsentSource();
  }

  const eventStatus = {
    approved: "approved",
    distributed: "distributed",
    activated: "active",
    superseded: "superseded",
    closed: "closed",
  };
  const latestFormalEvent = eventsResult.rows.at(-1);
  if (latestFormalEvent && eventStatus[latestFormalEvent.event_type]) {
    source.document.status = eventStatus[latestFormalEvent.event_type];
  }
  source.approval = {
    approved_by_name: approvalEvent?.actor_name_snapshot || null,
    approved_at: dateTime(approvalEvent?.event_at),
  };
  source.consent = {
    signer_name: row.signer_name,
    signer_relationship: row.signer_relationship,
    explanation_method: row.explanation_method,
    explained_at: dateTime(row.explained_at),
    consented_at: dateTime(row.consented_at),
  };
  source.distribution = distributionResult.rows[0] || null;
  if (row.recipient_certificate_ciphertext) {
    source.child.recipient_certificate_ciphertext = row.recipient_certificate_ciphertext;
  }
  return { source, consentRecordId: row.consent_record_id };
}

export async function prepareDocumentSnapshot(client, actor, childId, documentId, expectedVersion, snapshotKind) {
  const documentRow = await readDocumentForSnapshot(
    client,
    actor.tenantId,
    childId,
    documentId,
    expectedVersion,
  );
  assertSnapshotAllowed(snapshotKind, documentRow.status);

  const existing = await client.query(
    `select * from public.document_snapshots
     where tenant_id = $1 and document_id = $2
       and document_row_version = $3 and snapshot_kind = $4`,
    [actor.tenantId, documentId, expectedVersion, snapshotKind],
  );
  if (existing.rows[0]) {
    return { existing: serializeSnapshot(existing.rows[0]), source: null, facilityId: documentRow.facility_id };
  }

  const immutableSourceRequired = documentRow.status === "consented"
    || snapshotKind === "official"
    || snapshotKind === "corrected";
  const preparedSource = immutableSourceRequired
    ? await readImmutableConsentSource(client, actor.tenantId, documentRow)
    : {
        source: await readSnapshotSourceDetails(client, actor.tenantId, childId, documentRow),
        consentRecordId: null,
      };

  return {
    existing: null,
    source: preparedSource.source,
    consentRecordId: preparedSource.consentRecordId,
    documentRowVersion: Number(documentRow.row_version),
    sourceStatus: documentRow.status,
    templateVersion: preparedSource.source.document.template_version,
    facilityId: documentRow.facility_id,
  };
}

export async function insertDocumentSnapshot(client, actor, input) {
  const result = await client.query(
    `insert into public.document_snapshots (
       id, tenant_id, document_id, document_row_version, source_status,
       template_version, storage_key, storage_version_id, sha256, byte_size, mime_type,
       snapshot_kind, generated_by, consent_record_id
     ) values (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, 'application/pdf',
       $11, $12, $13
     ) returning *`,
    [
      input.id,
      actor.tenantId,
      input.documentId,
      input.documentRowVersion,
      input.sourceStatus,
      input.templateVersion,
      input.storageKey,
      input.storageVersionId,
      input.sha256,
      input.byteSize,
      input.snapshotKind,
      actor.userId,
      input.consentRecordId,
    ],
  );
  return serializeSnapshot(result.rows[0]);
}

function serializeSnapshotJob(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    childId: row.child_id,
    documentRowVersion: Number(row.document_row_version),
    sourceStatus: row.source_status,
    templateVersion: row.template_version,
    snapshotKind: row.snapshot_kind,
    consentRecordId: row.consent_record_id,
    storageKey: row.storage_key,
    generatedBy: row.generated_by,
    leaseOwnerId: row.lease_owner_id,
    status: row.status,
    leaseToken: row.lease_token,
    leaseExpiresAt: dateTime(row.lease_expires_at),
    sha256: row.sha256,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    storageVersionId: row.storage_version_id,
    attemptCount: Number(row.attempt_count),
  };
}

function pdfBusy(retryAfterSeconds = 5) {
  return new AppError(
    503,
    "PDF_GENERATION_BUSY",
    "PDF generation is already in progress. Please retry shortly.",
    { details: { retryAfterSeconds } },
  );
}

export async function reserveDocumentSnapshotJob(client, actor, input) {
  if (input.idempotency) {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${actor.tenantId}:${actor.userId}:${input.idempotency.key}`],
    );
  }
  let row = (await client.query(
    `select * from public.document_snapshot_jobs
     where tenant_id = $1 and document_id = $2
       and document_row_version = $3 and snapshot_kind = $4
    `,
    [actor.tenantId, input.documentId, input.documentRowVersion, input.snapshotKind],
  )).rows[0];

  if (!row && input.idempotency) {
    const reusedKey = (await client.query(
      `select id, request_fingerprint from public.document_snapshot_jobs
       where tenant_id = $1 and generated_by = $2 and idempotency_key = $3
      `,
      [actor.tenantId, actor.userId, input.idempotency.key],
    )).rows[0];
    if (reusedKey && reusedKey.request_fingerprint !== input.idempotency.fingerprint) {
      throw conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key is already associated with a different PDF request.",
      );
    }
    if (reusedKey) {
      row = (await client.query(
        "select * from public.document_snapshot_jobs where tenant_id = $1 and id = $2",
        [actor.tenantId, reusedKey.id],
      )).rows[0];
    }
  }

  if (!row) {
    const inserted = await client.query(
      `select * from app_private.create_document_snapshot_job(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )`,
      [
        input.id,
        input.documentId,
        input.childId,
        input.documentRowVersion,
        input.sourceStatus,
        input.templateVersion,
        input.snapshotKind,
        input.consentRecordId,
        input.storageKey,
        input.leaseToken,
        input.leaseSeconds,
        input.idempotency?.key || null,
        input.idempotency?.fingerprint || null,
      ],
    );
    row = inserted.rows[0];
    if (!row) {
      row = (await client.query(
        `select * from public.document_snapshot_jobs
         where tenant_id = $1 and document_id = $2
           and document_row_version = $3 and snapshot_kind = $4
        `,
        [actor.tenantId, input.documentId, input.documentRowVersion, input.snapshotKind],
      )).rows[0];
    }
  }

  if (!row) throw pdfBusy();
  if (row.status === "completed") {
    const snapshot = (await client.query(
      "select * from public.document_snapshots where tenant_id = $1 and id = $2",
      [actor.tenantId, row.id],
    )).rows[0];
    if (snapshot) return { job: serializeSnapshotJob(row), snapshot: serializeSnapshot(snapshot), needsRender: false };
  }
  if (row.status === "quarantined") {
    throw conflict("PDF_GENERATION_QUARANTINED", "The prior PDF object could not be safely attached. Contact an administrator.");
  }
  if (row.status === "uploaded") {
    return { job: serializeSnapshotJob(row), snapshot: null, needsRender: false };
  }
  const activeLease = ["rendering", "reconciling"].includes(row.status)
    && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now();
  if (activeLease && row.lease_token !== input.leaseToken) throw pdfBusy();
  if (row.lease_token !== input.leaseToken || row.status !== "rendering") {
    row = (await client.query(
      "select * from app_private.claim_document_snapshot_job($1, $2, $3)",
      [row.id, input.leaseToken, input.leaseSeconds],
    )).rows[0];
    if (!row) throw pdfBusy();
  }
  return { job: serializeSnapshotJob(row), snapshot: null, needsRender: true };
}

export async function markDocumentSnapshotUploaded(client, actor, input) {
  const row = (await client.query(
    `select * from app_private.record_document_snapshot_job_upload($1, $2, $3, $4, $5, $6)`,
    [
      input.jobId,
      input.leaseToken,
      input.storageVersionId,
      input.sha256,
      input.byteSize,
      input.uploadAttestation,
    ],
  )).rows[0];
  if (!row) throw pdfBusy();
  return serializeSnapshotJob(row);
}

export async function markDatabaseDocumentSnapshotUploaded(client, actor, input) {
  const row = (await client.query(
    "select * from app_private.record_database_document_snapshot_job_upload($1, $2)",
    [input.jobId, input.leaseToken],
  )).rows[0];
  if (!row) throw pdfBusy();
  return serializeSnapshotJob(row);
}

export async function releaseDocumentSnapshotJob(client, actor, input) {
  await client.query(
    "select app_private.fail_document_snapshot_job($1, $2, $3)",
    [input.jobId, input.leaseToken, input.errorCode],
  );
}

export async function finalizeDocumentSnapshotJob(client, actor, jobId) {
  const row = (await client.query(
    "select * from app_private.finalize_document_snapshot_job($1)",
    [jobId],
  )).rows[0];
  if (!row) throw pdfBusy();
  return serializeSnapshot(row);
}

export async function listDocumentSnapshots(client, tenantId, childId, documentId) {
  const document = await client.query(
    `select 1 from public.case_documents
     where tenant_id = $1 and child_id = $2 and id = $3 and deleted_at is null`,
    [tenantId, childId, documentId],
  );
  if (!document.rows[0]) throw notFound("計画書が見つかりません。");
  const result = await client.query(
    `select * from public.document_snapshots
     where tenant_id = $1 and document_id = $2
     order by generated_at desc, id desc`,
    [tenantId, documentId],
  );
  return { items: result.rows.map(serializeSnapshot) };
}

export async function getDocumentSnapshot(client, tenantId, childId, documentId, snapshotId) {
  const result = await client.query(
    `select s.*, d.version_number, d.document_kind, d.facility_id
     from public.document_snapshots s
     join public.case_documents d
       on d.tenant_id = s.tenant_id and d.id = s.document_id and d.deleted_at is null
     where s.tenant_id = $1 and d.child_id = $2 and s.document_id = $3 and s.id = $4`,
    [tenantId, childId, documentId, snapshotId],
  );
  if (!result.rows[0]) throw notFound("帳票PDFが見つかりません。");
  return result.rows[0];
}

export function snapshotStorageKey(tenantId, documentId, snapshotId) {
  return `tenants/${tenantId}/documents/${documentId}/${snapshotId}.pdf`;
}

export { DRAFT_SOURCE_STATUSES, OFFICIAL_SOURCE_STATUSES };
