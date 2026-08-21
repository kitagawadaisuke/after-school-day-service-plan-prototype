import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { badRequest, unauthorized } from "../errors.js";
import { createSessionStore, CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./session-store.js";

const scrypt = promisify(scryptCallback);
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;

function normalizeEmail(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function tokenHash(token) { return createHash("sha256").update(token).digest("hex"); }

function decodeHash(encoded) {
  const [scheme, cost, blockSize, parallelization, salt, digest] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !digest) return null;
  const options = { N: Number(cost), r: Number(blockSize), p: Number(parallelization) };
  if (![options.N, options.r, options.p].every(Number.isSafeInteger)) return null;
  return { options, salt: Buffer.from(salt, "base64url"), digest: Buffer.from(digest, "base64url") };
}

export async function hashLocalPassword(password, salt = randomBytes(16)) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw badRequest("INVALID_PASSWORD", "パスワードは8文字以上256文字以下で設定してください。");
  }
  const digest = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 128 * 1024 * 1024,
  });
  return ["scrypt", SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION, salt.toString("base64url"), Buffer.from(digest).toString("base64url")].join("$");
}

export async function verifyLocalPassword(password, encoded) {
  const parsed = decodeHash(encoded);
  if (!parsed || typeof password !== "string") return false;
  const actual = await scrypt(password, parsed.salt, parsed.digest.length, {
    ...parsed.options,
    maxmem: 128 * 1024 * 1024,
  });
  return Buffer.from(actual).length === parsed.digest.length
    && timingSafeEqual(Buffer.from(actual), parsed.digest);
}

export function createLocalAuth({ config, pool, now = () => new Date() } = {}) {
  if (config?.authMode !== "local" || !config?.cookieSecret || !pool) {
    throw new TypeError("local authentication requires a database pool and COOKIE_SECRET");
  }
  const store = createSessionStore({ pool, secret: config.cookieSecret, ttlSeconds: 12 * 60 * 60, now });

  async function login({ email, password, requestContext = {} }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || typeof password !== "string") throw unauthorized("ログインIDまたはパスワードが正しくありません。");
    const result = await pool.query("select * from app_private.resolve_local_login($1)", [normalizedEmail]);
    const identity = result.rows[0];
    if (!identity || identity.locked_until && new Date(identity.locked_until) > now()) {
      throw unauthorized("ログインIDまたはパスワードが正しくありません。");
    }
    const verified = await verifyLocalPassword(password, identity.password_hash);
    await pool.query("select app_private.record_local_login_attempt($1, $2)", [identity.user_id, verified]);
    if (!verified) throw unauthorized("ログインIDまたはパスワードが正しくありません。");
    const session = await store.createSession({
      userId: identity.user_id,
      tenantId: identity.tenant_id,
      role: identity.role,
      displayName: identity.display_name,
      tenantName: identity.tenant_name,
      facilityIds: identity.facility_ids || [],
    }, requestContext);
    return session;
  }

  async function authenticateRequest(request) {
    const method = String(request.method || "GET").toUpperCase();
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    return store.authenticate(request.cookies?.[SESSION_COOKIE_NAME], {
      method,
      // The session endpoint is a safe request. It must return the current
      // double-submit token so the SPA can include it in later mutations.
      // Mutations deliberately accept the header only; a cookie alone is not
      // sufficient for a state-changing request.
      csrfToken: isSafeMethod
        ? request.cookies?.[CSRF_COOKIE_NAME]
        : request.headers["x-csrf-token"],
    });
  }

  async function logout(request) {
    await store.revoke(request.cookies?.[SESSION_COOKIE_NAME]);
  }

  async function requestPasswordSetup(email) {
    const token = randomBytes(32).toString("base64url");
    const result = await pool.query("select * from app_private.request_local_password_setup($1, $2)", [normalizeEmail(email), tokenHash(token)]);
    return result.rows[0] ? { ...result.rows[0], token } : null;
  }

  async function resetPassword(token, password) {
    const passwordHash = await hashLocalPassword(password);
    const result = await pool.query("select * from app_private.consume_local_password_setup_result($1, $2)", [tokenHash(token), passwordHash]);
    return result.rows[0] || null;
  }

  async function requestSignup({ email, displayName }) {
    const normalizedEmail = normalizeEmail(email);
    const token = randomBytes(32).toString("base64url");
    const result = await pool.query(
      "select * from app_private.request_local_open_signup($1, $2, $3, $4)",
      [config.localSignupTenantId, normalizedEmail, String(displayName || "").trim(), tokenHash(token)],
    );
    return result.rows[0] ? { ...result.rows[0], token } : null;
  }

  return Object.freeze({ login, authenticateRequest, logout, requestPasswordSetup, resetPassword, requestSignup });
}

export const LOCAL_AUTH_COOKIE_NAMES = Object.freeze({ SESSION_COOKIE_NAME, CSRF_COOKIE_NAME });
