import { auditContextFromRequest, writeAuditEvent } from "./audit.js";
import { withTenantTransaction } from "./db/tenant-transaction.js";

const NON_SEARCH_QUERY_KEYS = new Set(["limit", "cursor"]);

function normalizedRoute(request) {
  return String(request.routeOptions?.url || request.url || "")
    .replace(/^\/api\/v1/, "")
    .split("?")[0];
}

export function piiReadDescriptor(request) {
  if (String(request.method).toUpperCase() !== "GET") return null;
  const route = normalizedRoute(request);
  if (!/^\/(children|staff|institutions)(?:\/|$)/.test(route)) return null;

  let resourceType = "child";
  if (route.includes("/guardians")) resourceType = "guardian";
  else if (route.includes("/family-members")) resourceType = "family_member";
  else if (route.includes("/institutions")) resourceType = "institution";
  else if (route.includes("/daily-logs")) resourceType = "daily_log";
  else if (route.includes("/contact-book")) resourceType = "contact_book_entry";
  else if (route.includes("/schedules")) resourceType = "schedule";
  else if (route.includes("/documents")) resourceType = "case_document";
  else if (route.startsWith("/staff")) resourceType = "staff_membership";

  const params = request.params || {};
  const resourceId = params.guardianId
    || params.familyMemberId
    || params.relationId
    || params.institutionId
    || params.dailyLogId
    || params.entryId
    || params.scheduleVersionId
    || params.documentId
    || params.membershipId
    || params.childId
    || null;
  const queryKeys = Object.keys(request.query || {})
    .filter((key) => !NON_SEARCH_QUERY_KEYS.has(key))
    .sort();
  const isSearch = queryKeys.length > 0;
  const isExport = route.endsWith("/content");
  // Only the child collection actually applies facilityId as a data filter.
  // Detail/staff routes ignore arbitrary query keys, so trusting them here
  // would let a multi-facility actor misattribute a real read to another site.
  const requestedFacilityId = route === "/children" ? request.query?.facilityId : null;
  const actorFacilityIds = request.actor?.facilityIds || [];
  const facilityId = typeof requestedFacilityId === "string" && actorFacilityIds.includes(requestedFacilityId)
    ? requestedFacilityId
    : actorFacilityIds.length === 1 ? actorFacilityIds[0] : null;

  return {
    action: isExport ? "pii.exported" : isSearch ? "pii.searched" : "pii.read",
    resourceType,
    resourceId,
    facilityId,
    metadata: {
      route: route.replace(/:[A-Za-z][A-Za-z0-9]*/g, ":id"),
      queryFilterNames: queryKeys,
    },
  };
}

export async function writePiiReadAudit({ db, request, config, descriptor }) {
  const context = auditContextFromRequest(request, config);
  await withTenantTransaction(db, request.actor, async (client) => {
    let facilityIds;
    if (descriptor.facilityId) {
      facilityIds = [descriptor.facilityId];
    } else if (request.params?.childId) {
      const child = await client.query(
        `select facility_id
         from public.children
         where tenant_id = $1 and id = $2`,
        [request.actor.tenantId, request.params.childId],
      );
      facilityIds = child.rows[0]?.facility_id ? [child.rows[0].facility_id] : [];
    } else if (request.actor.role === "tenant_admin") {
      facilityIds = [null];
    } else if (request.params?.membershipId) {
      const membershipFacilities = await client.query(
        `select facility_id
         from public.membership_facilities
         where tenant_id = $1 and membership_id = $2
         order by facility_id`,
        [request.actor.tenantId, request.params.membershipId],
      );
      facilityIds = membershipFacilities.rows.map((row) => row.facility_id);
    } else {
      facilityIds = [...new Set(request.actor.facilityIds || [])].sort();
    }

    // A successful PII response without an attributable tenant/facility scope
    // must fail closed. Otherwise the audit row would become tenant-global and
    // disclose cross-facility resource identifiers to local administrators.
    if (facilityIds.length === 0) {
      throw new Error("PII read audit facility scope could not be resolved");
    }
    for (const facilityId of facilityIds) {
      await writeAuditEvent(client, {
        ...context,
        ...descriptor,
        facilityId,
        outcome: "success",
      });
    }
  });
}

export function registerPiiReadAuditHook(app) {
  app.decorateRequest("piiReadAuditAttempted", false);
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.piiReadAuditAttempted || reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    const descriptor = request.actor ? piiReadDescriptor(request) : null;
    if (!descriptor) return payload;
    request.piiReadAuditAttempted = true;
    await writePiiReadAudit({ db: app.db, request, config: app.config, descriptor });
    return payload;
  });
}
