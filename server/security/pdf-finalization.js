import { createHash } from "node:crypto";

export function assertPdfFinalizationSecret(secret) {
  if (!/^[A-Za-z0-9]{64}$/.test(secret || "")) {
    throw new TypeError("PDF finalization secret must be an independent 64-character key");
  }
  return secret;
}

export function signPdfUpload(secret, input) {
  assertPdfFinalizationSecret(secret);
  const fields = [
    input.jobId,
    input.leaseToken,
    input.storageVersionId,
    input.sha256,
    String(input.byteSize),
  ];
  if (fields.some((value) => typeof value !== "string" || value.length < 1 || /[\r\n]/.test(value))) {
    throw new TypeError("PDF upload attestation input is invalid");
  }
  const payload = fields.join("\n");
  // PostgreSQL verifies the same secret-prefix/suffix SHA-256 construction.
  // The secret is not SELECT/EXECUTE-visible to the web runtime role.
  return createHash("sha256")
    .update(secret, "utf8")
    .update("\n", "utf8")
    .update(payload, "utf8")
    .update("\n", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}
