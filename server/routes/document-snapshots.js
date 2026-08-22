import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
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
import { renderDocumentTemplate } from "../pdf/templates/index.js";
import { signPdfUpload } from "../security/pdf-finalization.js";
import {
  getDocumentSnapshot,
  markDatabaseDocumentSnapshotUploaded,
  finalizeDocumentSnapshotJob,
  listDocumentSnapshots,
  markDocumentSnapshotUploaded,
  prepareDocumentSnapshot,
  releaseDocumentSnapshotJob,
  reserveDocumentSnapshotJob,
  serializeSnapshot,
  snapshotStorageKey,
} from "../repositories/document-snapshots.js";
import { parseIfMatch, parseInput, uuidSchema } from "./validation.js";

const documentParamsSchema = z.object({ childId: uuidSchema, documentId: uuidSchema }).strict();
const snapshotParamsSchema = z.object({
  childId: uuidSchema,
  documentId: uuidSchema,
  snapshotId: uuidSchema,
}).strict();
const generateSchema = z.object({ snapshotKind: z.enum(["draft", "official"]) }).strict();

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function storageIntegrityError() {
  return new AppError(
    503,
    "DOCUMENT_STORAGE_INTEGRITY_ERROR",
    "帳票PDFの完全性を確認できませんでした。管理者に連絡してください。",
  );
}

async function renderPdf(app, source, snapshotKind) {
  let decryptedCertificateNumber = null;
  try {
    const ciphertext = source.child.recipient_certificate_ciphertext;
    if (ciphertext?.byteLength) {
      if (!app.fieldEncryption) {
        throw new AppError(
          503,
          "SECURE_STORAGE_UNAVAILABLE",
          "受給者証番号を安全に復号できません。管理者に連絡してください。",
        );
      }
      try {
        decryptedCertificateNumber = await app.fieldEncryption.decrypt({
          tenantId: source.organization.id,
          fieldName: "recipient_certificate_number",
          ciphertext,
        });
      } catch (error) {
        throw new AppError(
          503,
          "SECURE_STORAGE_UNAVAILABLE",
          "受給者証番号を安全に復号できません。時間をおいて再度お試しください。",
          { cause: error },
        );
      }
      source.child.recipient_certificate_number = decryptedCertificateNumber;
    }
    // Ciphertext is an internal input to decryption, not template data.
    delete source.child.recipient_certificate_ciphertext;
    const rendered = renderDocumentTemplate(source, snapshotKind);
    return await app.pdfRenderer.render(rendered);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      503,
      "PDF_RENDER_FAILED",
      "帳票PDFを作成できませんでした。時間をおいて再度お試しください。",
      { cause: error },
    );
  } finally {
    delete source.child.recipient_certificate_number;
    delete source.child.recipient_certificate_ciphertext;
    decryptedCertificateNumber = null;
  }
}

async function generateSnapshotHandler(app, request, reply) {
  requirePermission(request.actor, PERMISSIONS.EXPORT_PDF);
  const { childId, documentId } = parseInput(documentParamsSchema, request.params);
  const { snapshotKind } = parseInput(generateSchema, request.body);
  const expectedVersion = parseIfMatch(request);
  const audit = auditContextFromRequest(request, app.config);

  // Completed idempotency replays never reserve a renderer or touch S3.
  const replay = await readIdempotentTenantResult(app.db, request.actor, request);
  if (replay) {
    const replayBody = applyIdempotencyReply(reply, replay);
    reply.header("Location", `/api/v1/children/${childId}/documents/${documentId}/snapshots/${replayBody.id}`);
    return replayBody;
  }

  const jobId = uuidv7();
  const leaseToken = uuidv7();
  const idempotency = describeIdempotentRequest(request);
  const reservation = await withTenantTransaction(app.db, request.actor, async (client) => {
    // The source row is locked only while its exact identity and render input
    // are captured. Chromium, KMS and S3 run after this transaction commits.
    const prepared = await prepareDocumentSnapshot(
      client,
      request.actor,
      childId,
      documentId,
      expectedVersion,
      snapshotKind,
    );
    if (prepared.existing) return { prepared, job: null, snapshot: prepared.existing, needsRender: false };
    const key = snapshotStorageKey(request.actor.tenantId, documentId, jobId);
    const claimed = await reserveDocumentSnapshotJob(client, request.actor, {
      id: jobId,
      childId,
      documentId,
      documentRowVersion: prepared.documentRowVersion,
      sourceStatus: prepared.sourceStatus,
      templateVersion: prepared.templateVersion,
      snapshotKind,
      consentRecordId: prepared.consentRecordId,
      storageKey: key,
      leaseToken,
      leaseSeconds: app.config.pdfJobLeaseSeconds || 120,
      idempotency,
    });
    return { prepared, ...claimed };
  });

  if (reservation.snapshot) {
    const result = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: reservation.prepared.facilityId,
        actorUserId: request.actor.userId,
        action: "document_snapshot.reused",
        resourceType: "document_snapshot",
        resourceId: reservation.snapshot.id,
        metadata: { documentId, snapshotKind, documentRowVersion: expectedVersion },
      });
      return { ...reservation.snapshot, reused: true };
    }, { statusCode: 201 });
    const body = applyIdempotencyReply(reply, result);
    reply.header("Location", `/api/v1/children/${childId}/documents/${documentId}/snapshots/${body.id}`);
    return body;
  }

  let uploadedJob = reservation.job;
  if (reservation.needsRender) {
    let pdfBody;
    try {
      pdfBody = await renderPdf(app, reservation.prepared.source, snapshotKind);
    } catch (error) {
      await withTenantTransaction(app.db, request.actor, (client) =>
        releaseDocumentSnapshotJob(client, request.actor, {
          jobId: reservation.job.id,
          leaseToken,
          errorCode: error?.code === "PDF_RENDER_CAPACITY_EXCEEDED" ? "RENDER_CAPACITY" : "RENDER_FAILED",
        })).catch(() => {});
      throw error;
    }
    const digest = sha256(pdfBody);
    let stored;
    try {
      stored = await app.documentStorage.putPdf({
        actor: request.actor,
        key: reservation.job.storageKey,
        body: pdfBody,
        sha256: digest,
        jobId: reservation.job.id,
        leaseToken,
      });
    } catch (error) {
      if (error?.code !== "DOCUMENT_OBJECT_EXISTS") {
        throw new AppError(
          503,
          "DOCUMENT_STORAGE_UNAVAILABLE",
          "PDF storage is temporarily unavailable. Please retry shortly.",
          { cause: error, details: { retryAfterSeconds: 5 } },
        );
      }
      stored = await app.documentStorage.inspectPdf({
        actor: request.actor,
        key: reservation.job.storageKey,
        expectedJobId: reservation.job.id,
      });
      if (!stored) throw storageIntegrityError();
    }
    uploadedJob = await withTenantTransaction(app.db, request.actor, (client) => {
      if (app.documentStorage.kind === "database") {
        return markDatabaseDocumentSnapshotUploaded(client, request.actor, {
          jobId: reservation.job.id,
          leaseToken,
        });
      }
      const uploadAttestation = signPdfUpload(app.config.pdfFinalizationSecret, {
        jobId: reservation.job.id,
        leaseToken,
        storageVersionId: stored.versionId,
        sha256: stored.sha256 || digest,
        byteSize: stored.byteSize || pdfBody.length,
      });
      return markDocumentSnapshotUploaded(client, request.actor, {
        jobId: reservation.job.id,
        leaseToken,
        sha256: stored.sha256 || digest,
        byteSize: stored.byteSize || pdfBody.length,
        storageVersionId: stored.versionId,
        uploadAttestation,
      });
    });
  }

  let result;
  try {
    result = await withIdempotentTenantTransaction(app.db, request.actor, request, async (client) => {
      const snapshot = await finalizeDocumentSnapshotJob(client, request.actor, uploadedJob.id);
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: reservation.prepared.facilityId,
        actorUserId: request.actor.userId,
        action: "document_snapshot.generated",
        resourceType: "document_snapshot",
        resourceId: snapshot.id,
        changedFields: [],
        metadata: {
          documentId,
          snapshotKind,
          sourceStatus: snapshot.sourceStatus,
          documentRowVersion: snapshot.documentRowVersion,
          byteSize: snapshot.byteSize,
        },
      });
      return { ...snapshot, reused: false };
    }, { statusCode: 201 });
  } catch (error) {
    const quarantined = await withTenantTransaction(app.db, request.actor, async (client) => {
      const response = await client.query(
        "select app_private.quarantine_stale_document_snapshot_job($1) as quarantined",
        [uploadedJob.id],
      );
      return response.rows[0]?.quarantined === true;
    }).catch(() => false);
    if (quarantined) {
      throw new AppError(
        409,
        "PDF_SOURCE_CHANGED",
        "The document changed while its PDF was being generated. Review the latest version and try again.",
      );
    }
    throw error;
  }

  const responseBody = applyIdempotencyReply(reply, result);
  reply.header("Location", `/api/v1/children/${childId}/documents/${documentId}/snapshots/${responseBody.id}`);
  return responseBody;
}

export async function documentSnapshotRoutes(app) {
  app.get("/children/:childId/documents/:documentId/snapshots", async (request) => {
    requirePermission(request.actor, PERMISSIONS.EXPORT_PDF);
    const { childId, documentId } = parseInput(documentParamsSchema, request.params);
    return withTenantTransaction(app.db, request.actor, (client) =>
      listDocumentSnapshots(client, request.actor.tenantId, childId, documentId),
    );
  });

  app.post("/children/:childId/documents/:documentId/snapshots", (request, reply) =>
    generateSnapshotHandler(app, request, reply));

  // Explicit action alias for clients that present a "PDFを作成" button.
  app.post("/children/:childId/documents/:documentId/pdf", (request, reply) =>
    generateSnapshotHandler(app, request, reply));

  app.get("/children/:childId/documents/:documentId/snapshots/:snapshotId", async (request) => {
    requirePermission(request.actor, PERMISSIONS.EXPORT_PDF);
    const { childId, documentId, snapshotId } = parseInput(snapshotParamsSchema, request.params);
    const row = await withTenantTransaction(app.db, request.actor, (client) =>
      getDocumentSnapshot(client, request.actor.tenantId, childId, documentId, snapshotId),
    );
    return serializeSnapshot(row);
  });

  app.get("/children/:childId/documents/:documentId/snapshots/:snapshotId/content", async (request, reply) => {
    requirePermission(request.actor, PERMISSIONS.EXPORT_PDF);
    const { childId, documentId, snapshotId } = parseInput(snapshotParamsSchema, request.params);
    const audit = auditContextFromRequest(request, app.config);
    // The snapshot is immutable, so do not hold a PostgreSQL transaction or
    // connection while S3 streams the object. Re-enter a tenant transaction
    // for the append-only audit event after integrity verification.
    const row = await withTenantTransaction(app.db, request.actor, (client) =>
      getDocumentSnapshot(
        client,
        request.actor.tenantId,
        childId,
        documentId,
        snapshotId,
      ),
    );
    let body;
    if (!row.storage_version_id) {
      // Pre-0016 rows did not persist S3 VersionId. On first access, read the
      // current immutable version, verify the already-stored hash and size,
      // then fill only the missing VersionId through a narrow DB function.
      const legacy = await app.documentStorage.inspectLegacyPdf({
        key: row.storage_key,
        expectedSha256: row.sha256,
        expectedByteSize: Number(row.byte_size),
      });
      if (!legacy) throw storageIntegrityError();
      await withTenantTransaction(app.db, request.actor, async (client) => {
        await client.query(
          "select app_private.backfill_document_snapshot_storage_version($1, $2, $3, $4)",
          [row.id, legacy.sha256, legacy.byteSize, legacy.versionId],
        );
        await writeAuditEvent(client, {
          ...audit,
          tenantId: request.actor.tenantId,
          facilityId: row.facility_id,
          actorUserId: request.actor.userId,
          action: "document_snapshot.version_backfilled",
          resourceType: "document_snapshot",
          resourceId: row.id,
          changedFields: ["storage_version_id"],
          metadata: { documentId, snapshotKind: row.snapshot_kind },
        });
      });
      row.storage_version_id = legacy.versionId;
      body = legacy.body;
    } else {
      body = await app.documentStorage.getPdf({
        actor: request.actor,
        key: row.storage_key,
        versionId: row.storage_version_id,
      });
    }
    if (
      body.length !== Number(row.byte_size)
      || sha256(body) !== row.sha256
      || !body.subarray(0, 5).equals(Buffer.from("%PDF-"))
    ) {
      throw storageIntegrityError();
    }
    await withTenantTransaction(app.db, request.actor, async (client) => {
      await writeAuditEvent(client, {
        ...audit,
        tenantId: request.actor.tenantId,
        facilityId: row.facility_id,
        actorUserId: request.actor.userId,
        action: "document_snapshot.downloaded",
        resourceType: "document_snapshot",
        resourceId: row.id,
        changedFields: [],
        metadata: { documentId, snapshotKind: row.snapshot_kind },
      });
    });

    const safeFilename = `document-${documentId}-v${Number(row.version_number)}-${row.snapshot_kind}.pdf`;
    reply
      .type("application/pdf")
      .header("Content-Length", String(body.length))
      .header("Content-Disposition", `inline; filename="${safeFilename}"`)
      .header("Cache-Control", "private, no-store");
    return reply.send(body);
  });
}
