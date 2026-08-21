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

const COMMON_OPERATION_PERMISSIONS = [
  P.VIEW_CLIENTS,
  P.EDIT_CLIENTS,
  P.EDIT_CASE_CONTEXT,
  P.VIEW_JOURNALS,
  P.EDIT_JOURNALS,
  P.VIEW_DOCUMENTS,
  P.EDIT_DOCUMENTS,
  P.APPROVE_DOCUMENTS,
  P.EXPORT_PDF,
];

const EXPECTED_GRANTS = Object.fromEntries(
  Object.values(ROLES).map((role) => [role, COMMON_OPERATION_PERMISSIONS]),
);

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

test("共同運用ではアカウント・事業所・操作履歴の管理権限を誰にも付与しない", () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(hasPermission(role, P.MANAGE_TENANT), false, role);
    assert.equal(hasPermission(role, P.MANAGE_STAFF), false, role);
    assert.equal(hasPermission(role, P.VIEW_AUDIT_LOG), false, role);
  }
});

test("すべての職員ロールは利用者・日誌・連絡帳・計画書を編集できる", () => {
  for (const role of Object.values(ROLES)) {
    for (const permission of COMMON_OPERATION_PERMISSIONS) {
      assert.equal(hasPermission(role, permission), true, `${role} / ${permission}`);
    }
  }
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
