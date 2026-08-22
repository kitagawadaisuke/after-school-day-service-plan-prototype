import { createHmac } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

function hashIdentifier(value, key) {
  if (!value) return null;
  return createHmac("sha256", key).update(String(value)).digest("hex").slice(0, 32);
}

function userAgentFamily(userAgent = "") {
  const candidates = ["Edg/", "Chrome/", "Firefox/", "Version/"];
  const match = candidates.find((candidate) => userAgent.includes(candidate));
  if (!match) return userAgent ? "other" : "unknown";
  const version = userAgent.split(match)[1]?.split(/[.\s]/)[0];
  const family = match === "Version/" && userAgent.includes("Safari/") ? "Safari" : match.slice(0, -1);
  return version ? `${family} ${version}` : family;
}

export function auditContextFromRequest(request, config) {
  return {
    requestId: request.id,
    ipHash: hashIdentifier(request.ip, config.auditHashKey),
    userAgentFamily: userAgentFamily(request.headers["user-agent"]),
  };
}

export async function writeAuditEvent(client, event) {
  await client.query(
    `select app_private.append_audit_event(
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10::text[], $11::jsonb
    )`,
    [
      uuidv7(),
      event.facilityId || null,
      event.action,
      event.resourceType,
      event.resourceId || null,
      event.requestId,
      event.ipHash || null,
      event.userAgentFamily || "unknown",
      event.outcome || "success",
      event.changedFields || [],
      JSON.stringify(event.metadata || {}),
    ],
  );
}
