import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const IDS = Object.freeze({
  tenant: "028f1db5-c170-7c35-a784-3cfc6f98c101",
  admin: "028f1db5-c170-7c35-a784-3cfc6f98c201",
  approver: "028f1db5-c170-7c35-a784-3cfc6f98c202",
  facility: "028f1db5-c170-7c35-a784-3cfc6f98c301",
  adminMembership: "028f1db5-c170-7c35-a784-3cfc6f98c401",
  approverMembership: "028f1db5-c170-7c35-a784-3cfc6f98c402",
  child: "028f1db5-c170-7c35-a784-3cfc6f98c501",
});

async function setup() {
  const db = new PGlite();
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  const names = (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
  await db.exec(await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"));
  await db.query(
    "select app_private.provision_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [IDS.tenant, "架空法人", IDS.admin, "admin-sub", "admin@example.invalid", "管理者", IDS.adminMembership, IDS.facility, "F-01", "架空事業所"],
  );
  await db.query(
    `insert into public.app_users (id, cognito_sub, email, display_name, status)
     values ($1, 'approver-sub', 'approver@example.invalid', '計画承認者', 'active')`,
    [IDS.approver],
  );
  await db.query(
    `insert into public.memberships (id, tenant_id, user_id, role, status, joined_at)
     values ($1, $2, $3, 'plan_approver', 'active', now())`,
    [IDS.approverMembership, IDS.tenant, IDS.approver],
  );
  await db.query(
    "insert into public.membership_facilities (tenant_id, membership_id, facility_id) values ($1,$2,$3)",
    [IDS.tenant, IDS.approverMembership, IDS.facility],
  );
  await db.query(
    `insert into public.children (
       id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
     ) values ($1,$2,$3,'C-001','架空児童','架空 利用児',$4,$4)`,
    [IDS.child, IDS.tenant, IDS.facility, IDS.admin],
  );
  await db.exec("set role michinote_runtime");
  return db;
}

async function asApprover(db, operation) {
  await db.exec("begin");
  await db.query(
    "select set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)",
    [IDS.tenant, IDS.approver],
  );
  try {
    return await operation();
  } finally {
    await db.exec("rollback");
  }
}

test("DBのRLSも計画承認者による利用児・日誌・連絡帳の変更を拒否する", async () => {
  const db = await setup();
  try {
    const hiddenUpdate = await asApprover(db, () => db.query(
      "update public.children set display_name = '変更', updated_by = $1 where id = $2",
      [IDS.approver, IDS.child],
    ));
    assert.equal(hiddenUpdate.affectedRows ?? hiddenUpdate.rowCount, 0);

    const operations = [
      () => db.query(
        `insert into public.guardians (id, tenant_id, child_id, legal_name, relationship)
         values ('028f1db5-c170-7c35-a784-3cfc6f98c601',$1,$2,'架空 保護者','母')`,
        [IDS.tenant, IDS.child],
      ),
      () => db.query(
        `insert into public.daily_logs (
           id, tenant_id, facility_id, child_id, occurred_at, activity, observation,
           support_provided, child_response, recorded_by, updated_by
         ) values ('028f1db5-c170-7c35-a784-3cfc6f98c701',$1,$2,$3,now(),'活動','観察','支援','反応',$4,$4)`,
        [IDS.tenant, IDS.facility, IDS.child, IDS.approver],
      ),
      () => db.query(
        `insert into public.contact_book_entries (
           id, tenant_id, facility_id, child_id, entry_date, family_message, recorded_by, updated_by
         ) values ('028f1db5-c170-7c35-a784-3cfc6f98c801',$1,$2,$3,current_date,'連絡',$4,$4)`,
        [IDS.tenant, IDS.facility, IDS.child, IDS.approver],
      ),
    ];
    for (const operation of operations) {
      await assert.rejects(
        () => asApprover(db, operation),
        (error) => error.code === "42501",
      );
    }
  } finally {
    await db.exec("reset role");
    await db.close();
  }
});
