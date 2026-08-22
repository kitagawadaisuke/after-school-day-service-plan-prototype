import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const FLOW_VERSION = "v1";
const FLOW_MAX_AGE_MS = 10 * 60 * 1000;

function deriveKey(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function randomOpaqueToken(size = 32, randomBytesImpl = randomBytes) {
  return randomBytesImpl(size).toString("base64url");
}

export function hashOpaqueValue(secret, purpose, value) {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`, "utf8").digest();
}

export function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || right.length === 0) {
    return false;
  }
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sealLoginFlow(secret, flow, randomBytesImpl = randomBytes) {
  const iv = randomBytesImpl(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(Buffer.from(FLOW_VERSION, "ascii"));
  const plaintext = Buffer.from(JSON.stringify(flow), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FLOW_VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function openLoginFlow(secret, sealed, now = Date.now()) {
  try {
    const [version, ivText, ciphertextText, tagText, extra] = String(sealed || "").split(".");
    if (version !== FLOW_VERSION || !ivText || !ciphertextText || !tagText || extra) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(FLOW_VERSION, "ascii"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]);
    const flow = JSON.parse(plaintext.toString("utf8"));
    if (
      !flow
      || typeof flow.state !== "string"
      || typeof flow.nonce !== "string"
      || typeof flow.verifier !== "string"
      || typeof flow.returnTo !== "string"
      || !Number.isFinite(flow.createdAt)
      || flow.createdAt > now + 30_000
      || now - flow.createdAt > FLOW_MAX_AGE_MS
    ) {
      return null;
    }
    return flow;
  } catch {
    return null;
  }
}

export function safeReturnTo(value) {
  if (
    typeof value !== "string"
    || value.length > 2048
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
  ) {
    return "/";
  }
  try {
    const parsed = new URL(value, "https://local.invalid");
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath.startsWith("//") || decodedPath.includes("\\")) return "/";
    return parsed.origin === "https://local.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    return "/";
  }
}

export const LOGIN_FLOW_MAX_AGE_SECONDS = FLOW_MAX_AGE_MS / 1000;
