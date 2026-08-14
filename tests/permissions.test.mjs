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

const EXPECTED_GRANTS = {
  tenant_admin: Object.values(P),
  facility_admin: [
    P.MANAGE_STAFF,
    P.VIEW_CLIENTS,
    P.EDIT_CLIENTS,
    P.EDIT_CASE_CONTEXT,
    P.VIEW_JOURNALS,
    P.EDIT_JOURNALS,
    P.VIEW_DOCUMENTS,
    P.EDIT_DOCUMENTS,
    P.APPROVE_DOCUMENTS,
    P.EXPORT_PDF,
    P.VIEW_AUDIT_LOG
  ],
  plan_approver: [
    P.VIEW_CLIENTS,
    P.EDIT_CASE_CONTEXT,
    P.VIEW_JOURNALS,
    P.VIEW_DOCUMENTS,
    P.EDIT_DOCUMENTS,
    P.APPROVE_DOCUMENTS,
    P.EXPORT_PDF
  ],
  support_staff: [
    P.VIEW_CLIENTS,
    P.VIEW_JOURNALS,
    P.EDIT_JOURNALS,
    P.VIEW_DOCUMENTS,
    P.EDIT_DOCUMENTS,
    P.EXPORT_PDF
  ],
  viewer: [P.VIEW_CLIENTS, P.VIEW_JOURNALS, P.VIEW_DOCUMENTS],
  auditor: [
    P.VIEW_CLIENTS,
    P.VIEW_JOURNALS,
    P.VIEW_DOCUMENTS,
    P.EXPORT_PDF,
    P.VIEW_AUDIT_LOG
  ]
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

test("法人管理は法人管理者だけに許可する", () => {
  assert.equal(hasPermission(ROLES.TENANT_ADMIN, P.MANAGE_TENANT), true);
  for (const role of Object.values(ROLES).filter((role) => role !== ROLES.TENANT_ADMIN)) {
    assert.equal(hasPermission(role, P.MANAGE_TENANT), false, role);
  }
});

test("承認者は文書を編集・承認できるが、日誌や利用児は変更できない", () => {
  assert.equal(hasPermission(ROLES.PLAN_APPROVER, P.EDIT_DOCUMENTS), true);
  assert.equal(hasPermission(ROLES.PLAN_APPROVER, P.APPROVE_DOCUMENTS), true);
  assert.equal(hasPermission(ROLES.PLAN_APPROVER, P.EDIT_JOURNALS), false);
  assert.equal(hasPermission(ROLES.PLAN_APPROVER, P.EDIT_CLIENTS), false);
  assert.equal(hasPermission(ROLES.PLAN_APPROVER, P.EDIT_CASE_CONTEXT), true);
});

test("支援員は日誌と文書の下書きを編集できるが承認できない", () => {
  assert.equal(hasPermission(ROLES.SUPPORT_STAFF, P.EDIT_JOURNALS), true);
  assert.equal(hasPermission(ROLES.SUPPORT_STAFF, P.EDIT_DOCUMENTS), true);
  assert.equal(hasPermission(ROLES.SUPPORT_STAFF, P.EDIT_CASE_CONTEXT), false);
  assert.equal(hasPermission(ROLES.SUPPORT_STAFF, P.APPROVE_DOCUMENTS), false);
  assert.equal(hasPermission(ROLES.SUPPORT_STAFF, P.MANAGE_STAFF), false);
});

test("閲覧者と監査担当者は記録を変更できない", () => {
  for (const role of [ROLES.VIEWER, ROLES.AUDITOR]) {
    assert.equal(hasPermission(role, P.EDIT_CLIENTS), false);
    assert.equal(hasPermission(role, P.EDIT_CASE_CONTEXT), false);
    assert.equal(hasPermission(role, P.EDIT_JOURNALS), false);
    assert.equal(hasPermission(role, P.EDIT_DOCUMENTS), false);
    assert.equal(hasPermission(role, P.APPROVE_DOCUMENTS), false);
  }
  assert.equal(hasPermission(ROLES.VIEWER, P.VIEW_AUDIT_LOG), false);
  assert.equal(hasPermission(ROLES.AUDITOR, P.VIEW_AUDIT_LOG), true);
});

test("不明なロール・操作・未認証ユーザーは既定で拒否する", () => {
  assert.equal(hasPermission("unknown", P.VIEW_CLIENTS), false);
  assert.equal(hasPermission(ROLES.TENANT_ADMIN, "unknown.action"), false);
  assert.equal(hasPermission(null, P.VIEW_CLIENTS), false);
  assert.equal(hasPermission({}, P.VIEW_CLIENTS), false);
});

test("requirePermission はロール文字列と利用者オブジェクトを受け取れる", () => {
  assert.equal(requirePermission(ROLES.TENANT_ADMIN, P.MANAGE_TENANT), ROLES.TENANT_ADMIN);

  const actor = { id: "staff-1", role: ROLES.SUPPORT_STAFF };
  assert.equal(requirePermission(actor, P.EDIT_JOURNALS), actor);
});

test("requirePermission は拒否時にHTTP 403へ変換可能なエラーを投げる", () => {
  assert.throws(
    () => requirePermission({ id: "staff-1", role: ROLES.SUPPORT_STAFF }, P.APPROVE_DOCUMENTS),
    (error) => {
      assert.ok(error instanceof PermissionError);
      assert.equal(error.name, "PermissionError");
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.statusCode, 403);
      assert.equal(error.role, ROLES.SUPPORT_STAFF);
      assert.equal(error.permission, P.APPROVE_DOCUMENTS);
      return true;
    }
  );
});
