import { loadConfig } from "../server/config.js";
import { createPgPool } from "../server/db/pool.js";

if (!process.argv.includes("--inspect")) {
  throw new Error("--inspect を指定した開発環境でのみ実行できます。");
}

const config = loadConfig();
if (config.nodeEnv === "production") throw new Error("本番環境では実行できません。");

const pool = createPgPool(config);
if (!pool) throw new Error("データベース接続が設定されていません。");

try {
  const [membershipSummary, activeWithoutFacility] = await Promise.all([
    pool.query(
      `select role, status, count(*)::int as count
         from public.memberships
        group by role, status
        order by role, status`,
    ),
    pool.query(
      `select count(*)::int as count
         from public.memberships m
        where m.status = 'active'
          and not exists (
            select 1 from public.membership_facilities mf
             where mf.tenant_id = m.tenant_id and mf.membership_id = m.id
          )`,
    ),
  ]);
  console.log(JSON.stringify({ memberships: membershipSummary.rows, activeWithoutFacility: activeWithoutFacility.rows[0].count }));
} finally {
  await pool.end();
}
