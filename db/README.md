# Database setup

本番DBはAWS RDS for PostgreSQL 16以降を想定します。アプリの通常実行ロールとは別の移行ロールを用意してください。

## 推奨手順

移行所有者の接続情報を `MIGRATION_DATABASE_*`、CloudFormationの
`DatabaseRuntimeSecret`から取得した通常接続情報を `RUNTIME_DATABASE_*` に設定して実行します。
通常Webアプリ用の `DATABASE_*` とは分離し、これら6項目を通常Web taskへ渡さないでください。
`MIGRATION_DATABASE_SSL=require`では`MIGRATION_DATABASE_CA_FILE`も必須です。本番image内の
`/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem`を使用し、証明書チェーンとRDS endpoint名を検証します。

```powershell
npm run migrate
```

移行ランナーは次を行います。

1. `db/migrations/*.sql` をファイル名順に列挙
2. PostgreSQL advisory lockで同時移行を防止
3. 未適用ファイルをトランザクション内で実行
4. ファイル名とSHA-256を履歴へ記録し、適用済みファイルの改変を拒否
5. `db/runtime-grants.sql` を再適用
6. `RUNTIME_DATABASE_PASSWORD`からランダムsalt付きSCRAM-SHA-256 verifierをメモリ内で生成
7. owner専用関数へverifierだけをbind parameterで渡し、`michinote_runtime`を`LOGIN`へ設定

平文passwordをSQL文字列、migration履歴、成功ログ、失敗ログへ出しません。`RUNTIME_DATABASE_USER`は
`michinote_runtime`固定、passwordは32〜1024文字です。AWS生成値は48文字です。

現在の移行は次の順です。

1. `0001_saas_foundation.sql`
2. `0002_cognito_bff.sql`
3. `0003_document_workflow.sql`
4. `0004_document_pdf_snapshots.sql`
5. `0005_idempotency_rls.sql`
6. `0006_child_certificate_fields.sql`
7. `0010_tenant_administration.sql`
8. `0011_immutable_consent_sources.sql`
9. `0012_document_state_integrity.sql`
10. `0013_staff_scope_and_data_retention.sql`
11. `0014_rbac_policy_parity.sql`
12. `0015_initial_tenant_onboarding.sql`
13. `0016_durable_document_snapshot_jobs.sql`
14. `0017_security_audit_retention.sql`
15. `0018_audit_facility_scope.sql`
16. `0019_staff_invitation_delivery_claims.sql`

## 実行ロールと初期化境界

`db/runtime-grants.sql`は`michinote_runtime`と`michinote_provisioner`を最初に
`NOLOGIN NOINHERIT NOBYPASSRLS`で作成します。そのSQLに平文credentialは含めません。
移行ランナーが全migrationとgrantを成功させた後だけ、Secrets Managerの各role用passwordを
SCRAM verifierへ変換して`LOGIN`へ昇格します。

`app_private.configure_runtime_login(text)`と`app_private.configure_provisioner_login(text)`は
SECURITY DEFINERですが、function ownerと同じsession userからしか実行できず、`public`、runtime、
provisionerにはEXECUTEを与えません。通常APIからpasswordを変更できません。

- 通常ロールをテーブル所有者にしない
- `BYPASSRLS`、migration schemaの変更権限、RDS master secretを付与しない
- 通常Web taskへ`MIGRATION_DATABASE_*`または`RUNTIME_DATABASE_*`を付与しない
- 法人の初回作成は通常APIではなく、`app_private.reconcile_initial_tenant(...)`と監査付き招待再送のclaim/result関数だけを実行できる短命taskで行う
- 旧`app_private.provision_tenant(...)`はfixture用であり、provisionerへEXECUTEを与えない

AWSでは[`infra/migration-task.template.json`](../infra/migration-task.template.json)の一回限りtaskだけが
RDS master secret、runtime secret、provisioner secretを読めます。成功確認後にmigration stackを削除してIAM roleとtask definitionを
失効させます。通常Web taskは`DatabaseRuntimeSecret`だけを`DATABASE_USER` / `DATABASE_PASSWORD`として受け取ります。

初回法人登録は[`infra/onboarding-task.template.json`](../infra/onboarding-task.template.json)を使います。
入力は短命のSecrets Manager JSON secretから注入し、CloudFormation parameterやtask overrideへ氏名・メールを
記載しません。taskはCognitoの`AdminCreateUser` / `AdminGetUser`と専用DB関数だけを使用します。
同じoperation UUIDと同じ入力は成功として再開でき、差分のある再利用は拒否されます。

各APIトランザクションは、業務テーブルへ触る前にテナントと操作者をトランザクションローカルで設定します。

```sql
begin;
select set_config('app.tenant_id', :tenant_id, true);
select set_config('app.user_id', :user_id, true);
-- tenant-scoped queries
commit;
```

DBのエンドポイントや資格情報をブラウザへ公開しません。RLSはAPI権限検証に加える第二の防御層です。

`resolve_cognito_identity(...)` はテナント決定前に使用できる唯一のID検索関数です。SECURITY DEFINERの所有者は移行ロールのままにし、通常アプリロールを `organizations`、`app_users`、`memberships` の所有者にしないでください。
