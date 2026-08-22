import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CONSENT_INTENT_TTL_MS = 5 * 60 * 1000;
const CONSENT_INTENT_CLOCK_SKEW_MS = 30 * 1000;

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new TypeError("binary values are not permitted in consent source JSON");
  }
  if (Array.isArray(value)) return value.map(canonicalize);

  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = canonicalize(value[key]);
  }
  return normalized;
}

export function canonicalDocumentSource(source) {
  return JSON.stringify(canonicalize(source));
}

export function hashCiphertext(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return null;
  return createHash("sha256").update(Buffer.from(ciphertext)).digest("hex");
}

function validDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function digestMatches(expected, actual) {
  if (!validDigest(expected) || !validDigest(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export function verifyCiphertext(ciphertext, expectedDigest) {
  if (ciphertext === null || ciphertext === undefined) return expectedDigest === null;
  return digestMatches(expectedDigest, hashCiphertext(ciphertext));
}

function derivedConsentKey(masterKey, purpose) {
  if (typeof masterKey !== "string" || masterKey.length < 32) {
    throw new TypeError("consent intent signing requires a strong application key");
  }
  return createHmac("sha256", masterKey)
    .update(`michinote:${purpose}:v1`, "utf8")
    .digest();
}

export function hashConsentReviewSource(source, masterKey) {
  return createHmac("sha256", derivedConsentKey(masterKey, "consent-review-source"))
    .update(canonicalDocumentSource(source), "utf8")
    .digest("hex");
}

function consentIntentSigningText(context, expiresAtMs, nonce) {
  return canonicalDocumentSource({
    tenantId: context.tenantId,
    userId: context.userId,
    childId: context.childId,
    documentId: context.documentId,
    documentRowVersion: Number(context.documentRowVersion),
    targetVersionNumber: Number(context.targetVersionNumber),
    expectedSourceHash: context.expectedSourceHash,
    expiresAtMs,
    nonce,
  });
}

function consentIntentSignature(context, expiresAtMs, nonce, masterKey) {
  return createHmac("sha256", derivedConsentKey(masterKey, "consent-intent-token"))
    .update(consentIntentSigningText(context, expiresAtMs, nonce), "utf8")
    .digest("hex");
}

export function createConsentIntentToken(context, masterKey, nowMs = Date.now()) {
  const expiresAtMs = nowMs + CONSENT_INTENT_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  const signature = consentIntentSignature(context, expiresAtMs, nonce, masterKey);
  return {
    token: `v1.${expiresAtMs}.${nonce}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function verifyConsentIntentToken(token, context, masterKey, nowMs = Date.now()) {
  if (typeof token !== "string") return false;
  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{22})\.([0-9a-f]{64})$/.exec(token);
  if (!match || !validDigest(context.expectedSourceHash)) return false;
  const expiresAtMs = Number(match[1]);
  if (
    !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs < nowMs
    || expiresAtMs > nowMs + CONSENT_INTENT_TTL_MS + CONSENT_INTENT_CLOCK_SKEW_MS
  ) return false;
  const expectedSignature = consentIntentSignature(context, expiresAtMs, match[2], masterKey);
  return digestMatches(match[3], expectedSignature);
}

export { CONSENT_INTENT_TTL_MS };
