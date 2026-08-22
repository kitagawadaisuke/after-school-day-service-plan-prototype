import { loadConfig } from "../server/config.js";
import { createPgPool } from "../server/db/pool.js";

if (!process.argv.includes("--verify")) {
  throw new Error("--verify を指定した開発環境でのみ実行できます。");
}

const config = loadConfig();
if (config.nodeEnv === "production") throw new Error("本番環境では実行できません。");

const pool = createPgPool(config);
if (!pool) throw new Error("データベース接続が設定されていません。");

try {
  const members = await pool.query(
    `select m.tenant_id, m.user_id, m.role
       from public.memberships m
       join public.app_users u on u.id = m.user_id and u.status = 'active'
      where m.status = 'active'
      order by m.joined_at nulls last, m.id`,
  );
  const outcomes = [];
  for (const member of members.rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [member.tenant_id, member.user_id],
      );
      const result = await client.query(
        `select
           app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor']) as role_allowed,
           (select count(*)::int from public.children where tenant_id = $1 and deleted_at is null) as visible_children,
           (select count(*)::int from public.children where tenant_id = $1 and deleted_at is null and app_private.can_access_facility(facility_id)) as editable_children`,
        [member.tenant_id],
      );
      outcomes.push({ role: member.role, ...result.rows[0], ok: true });
      await client.query("rollback");
    } catch (error) {
      outcomes.push({ role: member.role, ok: false, pgCode: error?.code || null });
      try { await client.query("rollback"); } catch { /* no-op */ }
    } finally {
      client.release();
    }
  }
  const summary = outcomes.reduce((accumulator, outcome) => {
    const key = `${outcome.role}:${outcome.ok ? "ok" : "failed"}`;
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
  console.log(JSON.stringify({ membersChecked: outcomes.length, summary, outcomes }));
} finally {
  await pool.end();
}
