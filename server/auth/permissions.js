/**
 * Application-wide RBAC policy.
 *
 * Keep permission checks expressed in business operations rather than routes so
 * the same policy can be shared by HTTP handlers, jobs and document exporters.
 */

export const ROLES = Object.freeze({
  TENANT_ADMIN: "tenant_admin",
  FACILITY_ADMIN: "facility_admin",
  PLAN_APPROVER: "plan_approver",
  SUPPORT_STAFF: "support_staff",
  VIEWER: "viewer",
  AUDITOR: "auditor"
});

export const PERMISSIONS = Object.freeze({
  MANAGE_TENANT: "tenant.manage",
  MANAGE_STAFF: "staff.manage",
  VIEW_CLIENTS: "clients.view",
  EDIT_CLIENTS: "clients.edit",
  EDIT_CASE_CONTEXT: "case_context.edit",
  VIEW_JOURNALS: "journals.view",
  EDIT_JOURNALS: "journals.edit",
  VIEW_DOCUMENTS: "documents.view",
  EDIT_DOCUMENTS: "documents.edit",
  APPROVE_DOCUMENTS: "documents.approve",
  EXPORT_PDF: "pdf.export",
  VIEW_AUDIT_LOG: "audit.view"
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

const grants = Object.freeze({
  [ROLES.TENANT_ADMIN]: ALL_PERMISSIONS,
  [ROLES.FACILITY_ADMIN]: Object.freeze([
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.VIEW_CLIENTS,
    PERMISSIONS.EDIT_CLIENTS,
    PERMISSIONS.EDIT_CASE_CONTEXT,
    PERMISSIONS.VIEW_JOURNALS,
    PERMISSIONS.EDIT_JOURNALS,
    PERMISSIONS.VIEW_DOCUMENTS,
    PERMISSIONS.EDIT_DOCUMENTS,
    PERMISSIONS.APPROVE_DOCUMENTS,
    PERMISSIONS.EXPORT_PDF,
    PERMISSIONS.VIEW_AUDIT_LOG
  ]),
  [ROLES.PLAN_APPROVER]: Object.freeze([
    PERMISSIONS.VIEW_CLIENTS,
    PERMISSIONS.EDIT_CASE_CONTEXT,
    PERMISSIONS.VIEW_JOURNALS,
    PERMISSIONS.VIEW_DOCUMENTS,
    PERMISSIONS.EDIT_DOCUMENTS,
    PERMISSIONS.APPROVE_DOCUMENTS,
    PERMISSIONS.EXPORT_PDF
  ]),
  [ROLES.SUPPORT_STAFF]: Object.freeze([
    PERMISSIONS.VIEW_CLIENTS,
    PERMISSIONS.VIEW_JOURNALS,
    PERMISSIONS.EDIT_JOURNALS,
    PERMISSIONS.VIEW_DOCUMENTS,
    PERMISSIONS.EDIT_DOCUMENTS,
    PERMISSIONS.EXPORT_PDF
  ]),
  [ROLES.VIEWER]: Object.freeze([
    PERMISSIONS.VIEW_CLIENTS,
    PERMISSIONS.VIEW_JOURNALS,
    PERMISSIONS.VIEW_DOCUMENTS
  ]),
  [ROLES.AUDITOR]: Object.freeze([
    PERMISSIONS.VIEW_CLIENTS,
    PERMISSIONS.VIEW_JOURNALS,
    PERMISSIONS.VIEW_DOCUMENTS,
    PERMISSIONS.EXPORT_PDF,
    PERMISSIONS.VIEW_AUDIT_LOG
  ])
});

/**
 * Boolean role/operation matrix. It is intentionally complete: new operations
 * default to no access until every role has been considered explicitly.
 */
export const PERMISSION_MATRIX = Object.freeze(
  Object.fromEntries(
    Object.values(ROLES).map((role) => {
      const permitted = new Set(grants[role]);
      return [
        role,
        Object.freeze(
          Object.fromEntries(
            ALL_PERMISSIONS.map((permission) => [permission, permitted.has(permission)])
          )
        )
      ];
    })
  )
);

export const ROLE_PERMISSIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(grants).map(([role, permissions]) => [role, Object.freeze([...permissions])])
  )
);

export class PermissionError extends Error {
  constructor({ role, permission } = {}) {
    super("この操作を行う権限がありません。");
    this.name = "PermissionError";
    this.code = "FORBIDDEN";
    this.statusCode = 403;
    this.role = role ?? null;
    this.permission = permission ?? null;
  }
}

function resolveRole(subject) {
  if (typeof subject === "string") return subject;
  if (subject && typeof subject === "object") return subject.role;
  return undefined;
}

/**
 * Returns false for missing/unknown roles and permissions (deny by default).
 */
export function hasPermission(subject, permission) {
  const role = resolveRole(subject);
  return PERMISSION_MATRIX[role]?.[permission] === true;
}

/**
 * Guard a business operation and return the original subject when authorized.
 * Accepting either a role string or an actor object keeps route usage concise:
 * `requirePermission(request.user, PERMISSIONS.EDIT_JOURNALS)`.
 */
export function requirePermission(subject, permission) {
  if (!hasPermission(subject, permission)) {
    throw new PermissionError({ role: resolveRole(subject), permission });
  }
  return subject;
}
