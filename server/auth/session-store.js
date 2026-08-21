import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { csrfInvalid, serviceUnavailable, unauthorized } from "../errors.js";
import { hashOpaqueValue, randomOpaqueToken } from "./crypto.js";

export const SESSION_COOKIE_NAME = "__Host-michinote_session";
export const LOGIN_FLOW_COOKIE_NAME = "__Host-michinote_oauth";
export const CSRF_COOKIE_NAME = "__Host-michinote_csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  return Buffer.alloc(0);
}

function equalBytes(left, right) {
  const a = normalizeBytes(left);
  const b = normalizeBytes(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function userAgentFamily(userAgent = "") {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

function privacyHash(secret, value) {
  if (!value) return null;
  return createHmac("sha256", secret).update(String(value), "utf8").digest("hex");
}

async function withClient(pool, operation) {
  if (!pool) throw serviceUnavailable("認証データベースへ接続できません。");
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export function createSessionStore({
  pool,
  secret,
  ttlSeconds,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  idFactory = randomUUID,
}) {
  if (!secret || secret.length < 32) throw new TypeError("session store requires a secret of at least 32 characters");

  const tokenHash = (token) => hashOpaqueValue(secret, "session", token);
  const csrfHash = (token) => hashOpaqueValue(secret, "csrf", token);

  async function resolveCognitoIdentity(subject, claims = {}) {
    return withClient(pool, async (client) => {
      const result = await client.query(
        `select user_id, tenant_id, role, display_name, facility_ids
         from app_private.resolve_cognito_identity($1, $2, $3)`,
        [subject, claims.email || null, claims.emailVerified === true],
      );
      if (result.rows.length !== 1) {
        throw unauthorized("このアカウントは利用可能な事業者に登録されていません。管理者へお問い合わせください。");
      }
      const row = result.rows[0];
      return {
        userId: row.user_id,
        tenantId: row.tenant_id,
        role: row.role,
        displayName: row.display_name,
        facilityIds: row.facility_ids || [],
      };
    });
  }

  async function createSession(identity, requestContext = {}) {
    const sessionToken = randomOpaqueToken(32, randomBytesImpl);
    const csrfToken = randomOpaqueToken(32, randomBytesImpl);
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
    await withClient(pool, (client) => client.query(
      `insert into app_private.sessions (
         id, token_hash, user_id, active_tenant_id, csrf_token_hash,
         created_at, last_seen_at, expires_at, ip_hash, user_agent_family
       ) values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
      [
        idFactory(),
        tokenHash(sessionToken),
        identity.userId,
        identity.tenantId,
        csrfHash(csrfToken),
        createdAt,
        expiresAt,
        privacyHash(secret, requestContext.ip),
        userAgentFamily(requestContext.userAgent),
      ],
    ));
    return { sessionToken, csrfToken, expiresAt };
  }

  async function authenticate(sessionToken, { method = "GET", csrfToken } = {}) {
    if (!sessionToken) throw unauthorized();
    return withClient(pool, async (client) => {
      await client.query("begin");
      try {
        const sessionResult = await client.query(
          `select id, user_id, active_tenant_id, csrf_token_hash
           from app_private.sessions
           where token_hash = $1 and revoked_at is null and expires_at > now()`,
          [tokenHash(sessionToken)],
        );
        if (sessionResult.rows.length !== 1) throw unauthorized("セッションの有効期限が切れています。再度ログインしてください。");
        const session = sessionResult.rows[0];

        if (!SAFE_METHODS.has(String(method).toUpperCase()) || csrfToken) {
          if (!csrfToken || !equalBytes(csrfHash(csrfToken), session.csrf_token_hash)) {
            throw csrfInvalid();
          }
        }

        await client.query(
          "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
          [session.active_tenant_id, session.user_id],
        );
        const actorResult = await client.query(
          `select u.id as user_id, m.tenant_id, o.name as tenant_name, m.role, u.display_name,
                  coalesce(array_agg(f.id order by f.id)
                    filter (where f.id is not null), '{}') as facility_ids
           from public.app_users u
           join public.memberships m on m.user_id = u.id and m.tenant_id = $1
           join public.organizations o on o.id = m.tenant_id and o.status = 'active'
           left join public.facilities f
             on f.tenant_id = m.tenant_id
            and f.status = 'active'
            and (
              m.role = 'tenant_admin'
              or exists (
                select 1 from public.membership_facilities mf
                where mf.tenant_id = m.tenant_id
                  and mf.membership_id = m.id
                  and mf.facility_id = f.id
              )
            )
           where u.id = $2 and u.status = 'active' and m.status = 'active'
           group by u.id, m.tenant_id, o.name, m.role, u.display_name`,
          [session.active_tenant_id, session.user_id],
        );
        if (actorResult.rows.length !== 1) throw unauthorized("このアカウントは現在利用できません。管理者へお問い合わせください。");

        await client.query(
          `update app_private.sessions
           set last_seen_at = now()
           where id = $1 and last_seen_at < now() - interval '5 minutes'`,
          [session.id],
        );
        await client.query("commit");
        const actor = actorResult.rows[0];
        return {
          userId: actor.user_id,
          tenantId: actor.tenant_id,
          tenantName: actor.tenant_name,
          role: actor.role,
          displayName: actor.display_name,
          facilityIds: actor.facility_ids || [],
          csrfToken,
        };
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // Keep the authentication error; a broken client is discarded by pg.
        }
        throw error;
      }
    });
  }

  async function revoke(sessionToken) {
    if (!sessionToken || !pool) return;
    await withClient(pool, (client) => client.query(
      `update app_private.sessions
       set revoked_at = coalesce(revoked_at, now())
       where token_hash = $1`,
      [tokenHash(sessionToken)],
    ));
  }

  return Object.freeze({
    authenticate,
    createSession,
    resolveCognitoIdentity,
    revoke,
    tokenHash,
    csrfHash,
  });
}
