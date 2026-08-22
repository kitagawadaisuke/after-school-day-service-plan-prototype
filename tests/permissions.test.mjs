import test from "node:test";
import assert from "node:assert/strict";

import {
  PERMISSIONS,
  PERMISSION_MATRIX,
  PermissionError,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  requirePermission
} from "../server/auth/permissions.js";

const P = PERMISSIONS;

const VIEW_RECORDS = [P.VIEW_CLIENTS, P.VIEW_JOURNALS, P.VIEW_DOCUMENTS];
const SUPPORT_RECORDS = [
  ...VIEW_RECORDS,
  P.EDIT_CLIENTS,
  P.EDIT_CASE_CONTEXT,
  P.EDIT_JOURNALS,
  P.EDIT_DOCUMENTS,
];
const EXPECTED_GRANTS = {
  [ROLES.TENANT_ADMIN]: [
    ...SUPPORT_RECORDS, P.MANAGE_TENANT, P.MANAGE_STAFF,
    P.APPROVE_DOCUMENTS, P.EXPORT_PDF, P.VIEW_AUDIT_LOG,
  ],
  [ROLES.FACILITY_ADMIN]: [
    ...SUPPORT_RECORDS, P.MANAGE_STAFF,
    P.APPROVE_DOCUMENTS, P.EXPORT_PDF, P.VIEW_AUDIT_LOG,
  ],
  [ROLES.PLAN_APPROVER]: [...SUPPORT_RECORDS, P.APPROVE_DOCUMENTS, P.EXPORT_PDF],
  [ROLES.SUPPORT_STAFF]: SUPPORT_RECORDS,
  [ROLES.VIEWER]: VIEW_RECORDS,
  [ROLES.AUDITOR]: [...VIEW_RECORDS, P.EXPORT_PDF, P.VIEW_AUDIT_LOG],
};

test("権限マトリクスは全ロール・全操作を明示する", () => {
  assert.deepEqual(Object.keys(PERMISSION_MATRIX).sort(), Object.values(ROLES).sort());

  for (const role of Object.values(ROLES)) {
    assert.deepEqual(Object.keys(PERMISSION_MATRIX[role]).sort(), Object.values(P).sort());
    assert.deepEqual(ROLE_PERMISSIONS[role], EXPECTED_GRANTS[role]);

    for (const permission of Object.values(P)) {
      assert.equal(
        PERMISSION_MATRIX[role][permission],
        EXPECTED_GRANTS[role].includes(permission),
        `${role} / ${permission}`
      );
    }
  }
});

test("ロールごとに最小権限を適用し、支援職員は正式工程を進められない", () => {
  assert.equal(hasPermission(ROLES.TENANT_ADMIN, P.MANAGE_TENANT), true);
  assert.equal(hasPermission(ROLES.FACILITY_ADMIN, P.MANAGE_TENANT), false);
  assert.equal(hasPermission(ROLES.SUPPORT_STAFF, P.APPROVE_DOCUMENTS), false);
  assert.equal(hasPermission(ROLES.VIEWER, P.EDIT_DOCUMENTS), false);
  assert.equal(hasPermission(ROLES.AUDITOR, P.EDIT_JOURNALS), false);
});

test("不明なロール・操作・未認証ユーザーは既定で拒否する", () => {
  assert.equal(hasPermission("unknown", P.VIEW_CLIENTS), false);
  assert.equal(hasPermission(ROLES.TENANT_ADMIN, "unknown.action"), false);
  assert.equal(hasPermission(null, P.VIEW_CLIENTS), false);
  assert.equal(hasPermission({}, P.VIEW_CLIENTS), false);
});

test("requirePermission はロール文字列と利用者オブジェクトを受け取れる", () => {
  assert.equal(requirePermission(ROLES.TENANT_ADMIN, P.EDIT_JOURNALS), ROLES.TENANT_ADMIN);

  const actor = { id: "staff-1", role: ROLES.SUPPORT_STAFF };
  assert.equal(requirePermission(actor, P.EDIT_JOURNALS), actor);
});

test("requirePermission は拒否時にHTTP 403へ変換可能なエラーを投げる", () => {
  assert.throws(
    () => requirePermission({ id: "staff-1", role: ROLES.SUPPORT_STAFF }, P.MANAGE_STAFF),
    (error) => {
      assert.ok(error instanceof PermissionError);
      assert.equal(error.name, "PermissionError");
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.statusCode, 403);
      assert.equal(error.role, ROLES.SUPPORT_STAFF);
      assert.equal(error.permission, P.MANAGE_STAFF);
      return true;
    }
  );
});
