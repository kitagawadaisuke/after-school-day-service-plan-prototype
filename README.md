# みちのーと — 放課後等デイサービス支援記録SaaS

日誌・連絡帳・相談支援計画・アセスメント・個別支援計画・モニタリングを、一つの支援サイクルとして管理するWebアプリです。記録から作る内容はあくまで根拠付きの下書きで、面談、会議、説明、同意、承認、交付を経て正式文書にします。

このリポジトリには次の二つを分離して収録しています。

- `saas.html` と `server/`: PostgreSQL・Cognito・S3を利用する本番SaaS
- `index.html`: 架空のA〜Dさんだけを使う従来のローカルデモ

共有された参考画像の実名、住所、証書番号、健康情報、署名、印影は転載していません。帳票の項目と構造だけを実装仕様へ反映しています。

## 実装済みの範囲

- 法人（テナント）・事業所・職員・所属・6ロールの権限管理
- Cognito Authorization Code + PKCE、MFA前提、サーバーセッション、CSRF対策
- 利用児、保護者、受給者証情報、家族、関係機関、現在／計画後の週間予定
- 相談支援計画、アセスメント、個別支援計画、モニタリングの分離と版管理
- 日誌、連絡帳、計画目標との根拠リンク
- 日誌等からの決定論的な下書き作成。根拠不足は「評価できない」とし、自動決定しない
- 説明、同意、承認、交付、実施、改定、終了の正式ワークフロー
- ETag / `If-Match` による楽観ロックと、`Idempotency-Key` による二重登録防止
- PostgreSQL Row Level Securityによる法人・事業所・利用児の分離
- 操作者由来の監査ログ。本文や個人情報を監査ログへ重複保存しない
- 受給者証番号のKMS暗号化と画面上のマスキング
- Chromiumによる日本語A4帳票、下書き透かし、正式PDF、S3/KMS不変スナップショット
- Windows Chrome/Edge、狭幅画面、キーボード操作を考慮した本番UI
- AWS CloudFormation（ECS Fargate、ALB/WAF、RDS PostgreSQL、Cognito、S3/KMS、Backup）

詳細は[本番化要求仕様](docs/saas-product-requirements.md)、[AWS構成](docs/aws-architecture.md)、[運用手順](docs/operations-runbook.md)、[PDF仕様](docs/pdf-snapshots.md)を参照してください。

## ローカル起動

前提はNode.js 22以降とPostgreSQL 16以降です。

```powershell
npm ci
Copy-Item .env.example .env
```

`.env` にローカルDB接続と開発用の架空テナント／職員IDを設定し、スキーマを適用します。

```powershell
npm run migrate
npm start
```

開発認証でSaaS画面を確認する場合は <http://127.0.0.1:8015/saas.html> を開きます。`NODE_ENV=production` または `AUTH_MODE=cognito` では <http://127.0.0.1:8015/> が本番SaaS画面になります。開発時の `/` は互換確認のため従来デモを返します。本番値や秘密情報を `.env`、Git、ブラウザへ置かないでください。

従来デモだけを確認する場合:

```powershell
npm run serve:legacy-demo
```

## データベース移行

`npm run migrate` は `db/migrations/*.sql` をファイル名順に適用し、チェックサムと履歴を保存した後、`db/runtime-grants.sql` を再適用します。さらにruntime/provisioner用passwordからSCRAM verifierをメモリ内生成し、owner専用関数で`michinote_runtime`と`michinote_provisioner`だけを`LOGIN`に設定します。平文passwordはSQL・履歴・ログに出しません。本番は一回限りの[`infra/migration-task.template.json`](infra/migration-task.template.json)で実行し、成功後そのstackを削除します。通常Web taskにはruntime資格情報と独立した`PDF_FINALIZATION_SECRET`だけを渡し、RDS master/provisioner secretは渡しません。

クリーン環境の最初の法人・事業所・法人管理者は、短命の[`infra/onboarding-task.template.json`](infra/onboarding-task.template.json)と`npm run provision:tenant`で登録します。Cognito作成後にDB処理が中断しても同じoperation UUIDで再開でき、差分のある再利用は拒否されます。氏名・メール等は短命Secrets Manager secretからのみ注入し、ログ・CloudFormation parameterへ出しません。

詳細は[db/README.md](db/README.md)を参照してください。

## テスト

```powershell
npm test
npm run test:saas-ui
```

`npm test` はWindowsで子プロセス生成制限がある環境でも動く逐次ランナーで、RLS、権限、認証、競合、文書ワークフロー、下書き生成、PDF、インフラ契約を検証します。`test:saas-ui` はChromiumで本番画面を操作し、デスクトップと狭幅表示を確認します。

## コンテナ

本番イメージはPlaywright公式の固定版を基に、日本語フォントを入れ、非rootの `pwuser` で実行します。

```powershell
docker build -t michinote-saas:local .
```

起動時はSecrets Manager等から環境変数を注入します。最低限、PostgreSQL接続、HTTPSの `APP_BASE_URL`、Cognito、`COOKIE_SECRET`、`AUDIT_HASH_KEY`、`PDF_FINALIZATION_SECRET`、`DOCUMENT_BUCKET`、`DOCUMENT_KMS_KEY_ARN` が必要です。PDF確定キーはDB passwordから導出せず、別のSecrets Manager secretとして管理します。
本番PostgreSQL接続は`DATABASE_SSL=require`と`DATABASE_CA_FILE`が必須です。production imageはAWS公式Osaka RDS CA bundleをSHA-256検証して同梱し、Node PostgreSQL clientの`ssl.ca`と`rejectUnauthorized=true`でRDS endpointを検証します。

## AWSへのリリース境界

`infra/main.template.json` は大阪リージョンの本番構成を定義しますが、このリポジトリのテストや起動コマンドはAWS資源を作成・更新しません。リリース時は次を別工程で行います。

1. イメージをECRへ発行し、ダイジェストを固定する
2. CloudFormationの検証とChange Setレビューを行う
3. 一回限りの移行タスクでDBを更新する
4. ECSを段階更新し、ヘルスチェック、認証、帳票生成、監査を確認する
5. バックアップ復元訓練と導入施設端末での受入試験を行う

手順は[infra/README.md](infra/README.md)と[運用手順](docs/operations-runbook.md)にあります。

## 重要な運用前提

- 相談支援事業者が作るサービス等利用計画と、事業所が作る個別支援計画は別文書です。
- 自動生成は診断・達成判定・正式決定を行いません。担当職員が原記録と面談を確認して編集します。
- 確定済み文書は上書きせず、新版を作成します。正式PDFも上書き・削除しません。
- 本番稼働前に、導入施設の自治体・指定権者の現行様式、保存年限、同意・交付運用を確認してください。
- AWSへまだデプロイしていない状態では、公開URLの従来デモには本番SaaS機能は反映されません。

## 参照した公的一次資料

- [児童福祉法に基づく指定通所支援の事業等の人員、設備及び運営に関する基準](https://www.mhlw.go.jp/web/t_doc?dataId=82ab2618&dataType=0&pageNo=1)
- [令和6年度報酬改定に伴う個別支援計画の取扱いの変更](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/253aba4f-3ce0-4aa1-a777-3d42440f1ca2/fdbd76b5/20240412_policies_shougaijishien_shisaku_hoshukaitei_66.pdf)
- [個別支援計画の記載のポイント](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/253aba4f-3ce0-4aa1-a777-3d42440f1ca2/fc728b4a/20240520_policies_shougaijishien_shisaku_hoshukaitei_100.pdf)
- [個別支援計画 参考様式](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/253aba4f-3ce0-4aa1-a777-3d42440f1ca2/66a56ae7/20240520_policies_shougaijishien_shisaku_hoshukaitei_101.pdf)
- [放課後等デイサービスガイドライン（令和6年7月）](https://www.cfa.go.jp/assets/contents/node/basic_page/field_ref_resources/32675809-3f98-486b-9c03-efc695ede0bb/7d644e16/20240710_policies_shougaijishien_shisaku_11.pdf)
