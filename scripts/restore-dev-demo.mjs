import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.js";
import { createPgPool } from "../server/db/pool.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const demoFacility = Object.freeze({
  id: "018f1db5-c170-7c35-a784-3cfc6f98c301",
  code: "demo-dev",
  name: "放課後等デイサービス「デモ」",
});
const demoUsers = Object.freeze([
  ["DEMO-20260821-001", "テストさくら", "テストさくら（デモ）", "2016-04-01", "小学4年生"],
  ["DEMO-20260821-002", "テストゆうと", "テストゆうと（デモ）", "2017-07-15", "小学3年生"],
  ["DEMO-20260821-003", "テストあおい", "テストあおい（デモ）", "2015-11-08", "小学5年生"],
  ["DEMO-20260821-004", "テストはる", "テストはる（デモ）", "2018-02-20", "小学2年生"],
]);

if (!process.argv.includes("--apply")) {
  throw new Error("--apply を指定した開発環境でのみ実行できます。");
}

const config = loadConfig();
if (config.nodeEnv === "production") throw new Error("本番環境では実行できません。");
if (!config.localSignupTenantId) throw new Error("LOCAL_SIGNUP_TENANT_ID is required");

const pool = createPgPool(config);
if (!pool) throw new Error("データベース接続が設定されていません。");

try {
  const accessMigration = await readFile(resolve(projectRoot, "db/migrations/0030_local_signup_common_access.sql"), "utf8");
  await pool.query(accessMigration);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const tenant = await client.query(
      "select id from public.organizations where id = $1 and status = 'active'",
      [config.localSignupTenantId],
    );
    if (tenant.rowCount !== 1) throw new Error("有効な事業者が見つかりません。");

    const actor = await client.query(
      "select user_id from public.memberships where tenant_id = $1 and status = 'active' order by joined_at nulls last, id limit 1",
      [config.localSignupTenantId],
    );
    if (actor.rowCount !== 1) throw new Error("デモデータの登録に必要な職員アカウントがありません。");
    await client.query(
      "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [config.localSignupTenantId, actor.rows[0].user_id],
    );

    await client.query(
      `insert into public.facilities (id, tenant_id, code, name, service_type, status)
       values ($1, $2, $3, $4, '放課後等デイサービス', 'active')
       on conflict (tenant_id, id) do update
         set code = excluded.code,
             name = excluded.name,
             service_type = excluded.service_type,
             status = 'active',
             updated_at = now()`,
      [demoFacility.id, config.localSignupTenantId, demoFacility.code, demoFacility.name],
    );
    await client.query(
      "update public.memberships set role = 'tenant_admin', updated_at = now() where tenant_id = $1 and status = 'active'",
      [config.localSignupTenantId],
    );
    await client.query(
      `insert into public.membership_facilities (tenant_id, membership_id, facility_id)
       select $1, id, $2 from public.memberships
        where tenant_id = $1 and status = 'active'
       on conflict do nothing`,
      [config.localSignupTenantId, demoFacility.id],
    );

    for (const [managementCode, displayName, legalName, birthDate, grade] of demoUsers) {
      await client.query(
        `insert into public.children (
          id, tenant_id, facility_id, management_code, display_name, legal_name,
          birth_date, grade, status, created_by, updated_by
        ) values (pg_catalog.gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'active', $8, $8)
        on conflict (tenant_id, facility_id, management_code) do nothing`,
        [config.localSignupTenantId, demoFacility.id, managementCode, displayName, legalName, birthDate, grade, actor.rows[0].user_id],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ restoredFacility: demoFacility.name, restoredUsers: demoUsers.length }));
} finally {
  await pool.end();
}
