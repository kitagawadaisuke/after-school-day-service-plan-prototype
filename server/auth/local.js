import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
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

function decodeHash(encoded) {
  const [scheme, cost, blockSize, parallelization, salt, digest] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !digest) return null;
  const options = { N: Number(cost), r: Number(blockSize), p: Number(parallelization) };
  if (![options.N, options.r, options.p].every(Number.isSafeInteger)) return null;
  return { options, salt: Buffer.from(salt, "base64url"), digest: Buffer.from(digest, "base64url") };
}

export async function hashLocalPassword(password, salt = randomBytes(16)) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw badRequest("INVALID_PASSWORD", "パスワードは12文字以上256文字以下で設定してください。");
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
    return store.authenticate(request.cookies?.[SESSION_COOKIE_NAME], {
      method: request.method,
      csrfToken: request.headers["x-csrf-token"],
    });
  }

  async function logout(request) {
    await store.revoke(request.cookies?.[SESSION_COOKIE_NAME]);
  }

  return Object.freeze({ login, authenticateRequest, logout });
}

export const LOCAL_AUTH_COOKIE_NAMES = Object.freeze({ SESSION_COOKIE_NAME, CSRF_COOKIE_NAME });
