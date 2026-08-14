import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

const PDF_MIME_TYPE = "application/pdf";
const MAX_STORED_PDF_BYTES = 20 * 1024 * 1024;
const STORAGE_KEY_PATTERN = /^tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;

function boundedBuffer(value) {
  const buffer = Buffer.from(value);
  if (buffer.length < 1 || buffer.length > MAX_STORED_PDF_BYTES) {
    throw new RangeError("stored PDF is outside the download size limit");
  }
  return buffer;
}

async function streamToBuffer(body) {
  if (!body) throw new Error("document storage returned an empty body");
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return boundedBuffer(body);
  if (typeof body.transformToByteArray === "function") return boundedBuffer(await body.transformToByteArray());
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_STORED_PDF_BYTES) throw new RangeError("stored PDF exceeds the download limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function assertStorageKey(key) {
  if (!STORAGE_KEY_PATTERN.test(key || "")) throw new TypeError("invalid document storage key");
}

function assertVersionId(versionId) {
  if (typeof versionId !== "string" || versionId.length < 1 || versionId.length > 1024 || /\s/.test(versionId)) {
    throw new TypeError("a valid immutable S3 version id is required");
  }
}

function objectExistsError(error) {
  return error?.$metadata?.httpStatusCode === 412 || error?.name === "PreconditionFailed";
}

function missingObjectError(error) {
  return error?.$metadata?.httpStatusCode === 404 || ["NotFound", "NoSuchKey", "NoSuchVersion"].includes(error?.name);
}

function integrityError(message) {
  const error = new Error(message);
  error.code = "DOCUMENT_STORAGE_INTEGRITY_ERROR";
  return error;
}

export function createS3DocumentStorage(options) {
  const { bucket, kmsKeyArn, region } = options || {};
  if (!bucket || !kmsKeyArn || !region) throw new TypeError("S3 document storage requires bucket, KMS key and region");
  const client = options.client || new S3Client({ region });
  const timeoutMs = options.timeoutMs || 20_000;

  return Object.freeze({
    async putPdf({ key, body, sha256, jobId }) {
      assertStorageKey(key);
      if (!Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_STORED_PDF_BYTES) {
        throw new RangeError("PDF body is outside the storage size limit");
      }
      if (!/^[0-9a-f]{64}$/.test(sha256 || "")) throw new TypeError("PDF SHA-256 is invalid");
      if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) throw new TypeError("PDF job id is invalid");
      let result;
      try {
        result = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: PDF_MIME_TYPE,
          ContentLength: body.length,
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: kmsKeyArn,
          BucketKeyEnabled: true,
          IfNoneMatch: "*",
          Metadata: { sha256, jobid: jobId },
        }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (objectExistsError(error)) {
          const conflict = new Error("document object key already exists");
          conflict.code = "DOCUMENT_OBJECT_EXISTS";
          throw conflict;
        }
        throw error;
      }
      assertVersionId(result?.VersionId);
      return { versionId: result.VersionId, sha256, byteSize: body.length };
    },

    async getPdf({ key, versionId }) {
      assertStorageKey(key);
      assertVersionId(versionId);
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId, ChecksumMode: "ENABLED" }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
      if (result.ContentType && result.ContentType !== PDF_MIME_TYPE) {
        throw new Error("stored document has an unexpected content type");
      }
      return streamToBuffer(result.Body);
    },

    async inspectPdf({ key, expectedJobId }) {
      assertStorageKey(key);
      if (typeof expectedJobId !== "string" || !/^[0-9a-f-]{36}$/i.test(expectedJobId)) {
        throw new TypeError("PDF job id is invalid");
      }
      let head;
      try {
        head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
          { abortSignal: AbortSignal.timeout(timeoutMs) },
        );
      } catch (error) {
        if (missingObjectError(error)) return null;
        throw error;
      }
      assertVersionId(head.VersionId);
      if (head.ContentType !== PDF_MIME_TYPE || head.Metadata?.jobid !== expectedJobId) {
        throw integrityError("stored PDF metadata does not match its snapshot job");
      }
      const body = await this.getPdf({ key, versionId: head.VersionId });
      const digest = createHash("sha256").update(body).digest("hex");
      if (head.Metadata?.sha256 !== digest || Number(head.ContentLength) !== body.length) {
        throw integrityError("stored PDF failed integrity verification");
      }
      return { versionId: head.VersionId, sha256: digest, byteSize: body.length };
    },

    async inspectLegacyPdf({ key, expectedSha256, expectedByteSize }) {
      assertStorageKey(key);
      if (!/^[0-9a-f]{64}$/.test(expectedSha256 || "") || !Number.isSafeInteger(expectedByteSize) || expectedByteSize < 1) {
        throw new TypeError("legacy PDF integrity metadata is invalid");
      }
      let head;
      try {
        head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
          { abortSignal: AbortSignal.timeout(timeoutMs) },
        );
      } catch (error) {
        if (missingObjectError(error)) return null;
        throw error;
      }
      assertVersionId(head.VersionId);
      if (head.ContentType !== PDF_MIME_TYPE || Number(head.ContentLength) !== expectedByteSize) {
        throw integrityError("legacy PDF metadata does not match its database snapshot");
      }
      const body = await this.getPdf({ key, versionId: head.VersionId });
      const digest = createHash("sha256").update(body).digest("hex");
      if (digest !== expectedSha256 || !body.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw integrityError("legacy PDF bytes do not match their database snapshot");
      }
      return { versionId: head.VersionId, sha256: digest, byteSize: body.length, body };
    },
  });
}

export function createUnavailableDocumentStorage() {
  const unavailable = () => {
    throw new AppError(503, "DOCUMENT_STORAGE_UNAVAILABLE", "帳票保存先を利用できません。管理者に連絡してください。");
  };
  return Object.freeze({
    putPdf: unavailable,
    getPdf: unavailable,
    inspectPdf: unavailable,
    inspectLegacyPdf: unavailable,
  });
}

export { PDF_MIME_TYPE, STORAGE_KEY_PATTERN };
