# 帳票PDFと不変スナップショット

> 2026-08 / migration 0016以降: PDF生成は「短いDB予約→DB接続を手放して
> Chromium/KMS/S3→短いDB確定」のジョブ方式です。

## 0016以降の永続化境界

- `document_snapshot_jobs` の一意制約とleaseにより、複数ECSから同じ文書版を
  要求してもPDFは1件だけ生成します。一般actorはjob/snapshot表を直接更新できず、
  検証付き `SECURITY DEFINER` 関数だけが状態を進めます。
- S3保存成功後にDB確定が失敗しても、次の認証済み再試行がjob id・実データのSHA-256・
  バイト数・S3 VersionIdを再検証して再接続します。不一致は削除せず
  `quarantined` として保全します。ログに利用児情報、S3 key、hashは出しません。
- 復旧は通常web DBロールで他tenantを走査するバックグラウンド処理ではありません。
  リクエストのtenant・施設・PDF権限をDBで再確認するrequest-driven reconcilerです。
- DBにはS3 `VersionId` を必須保存し、取得は必ず `GetObject(versionId=...)` で行います。
  「現在の同名key」への読み替えはありません。
- 1 GiB Fargate taskを基準に、Chromiumは1プロセスあたり同時1件、待機1件が
  初期値です。それ以上は `503 PDF_RENDER_CAPACITY_EXCEEDED` と `Retry-After`
  を返し、メモリ枯渇を避けます。

## DB直操作からPDF確定を分離する境界

S3へ保存できたPDFだけをDBへ確定するため、Webアプリはjob id・lease token・S3 VersionId・SHA-256・byte数を、独立した`PDF_FINALIZATION_SECRET`で署名します。DBはownerだけが設定でき、通常runtimeからSELECTできない検証キーで同じ署名を再計算します。したがって、通常runtime DB資格情報やSQL injectionだけでは偽のVersionId/hashを`uploaded`へ進められず、`finalize`も未検証jobを正式snapshotにできません。このキーはruntime DB passwordから導出せず、別のSecrets Manager secretとしてWeb taskと一回限りのmigration taskへ注入します。値・署名・S3 keyはログへ出しません。

キーrotationは、先にmigration taskでDB側検証キーを更新し、直後にWeb taskをrolling deploymentします。切替中に旧キーで開始した生成は確定に失敗してもjob/S3実体を失わず、再試行で照合できます。コンテナ自体の任意コード実行まで許した侵害はこの境界の対象外なので、ECS task role・image digest・Secrets Managerアクセスも別途監視します。

## S3 Object Lockの判断

新規本番bucketはObject Lockを有効化し、デフォルトで
`COMPLIANCE / 2555日（7年）` 保持します。正式帳票だけでなく同じ非公開bucketの
下書きも保全する保守的な選択で、ランサムウェアや運用者誤操作でも保持期間中は
変更・削除できません。通常task roleには削除権限がありません。

`COMPLIANCE` は保持期間の短縮や削除が原則できない不可逆の設定です。本番作成前に、
契約・自治体・施設の保存/廃棄規程と7年が一致するかを責任者が確認してください。
Object Lockは既存bucketへの安易な後付けではなく、CloudFormationで新規作成するbucketを
前提とします。

## 下書きと正式版

- `draft` PDFは計画書が `draft` / `internal_review` / `explanation_pending` / `consented` の間だけ作成でき、各ページに「下書き・正式帳票ではありません」と表示します。
- `official` PDFは同意と承認を経た `approved` / `distributed` / `active` / `superseded` / `closed` の計画書だけが対象です。
- 同じ計画書の同じ `row_version` と種別に対するPDFは1件だけです。短い予約トランザクションでjobとleaseを確保し、複数ECSタスクからの競合を直列化します。
- `Idempotency-Key` 付きの再送は初回の応答を再生し、ChromiumレンダリングとS3保存を繰り返しません。`If-Match` も再送指紋に含めます。

## 保存と完全性

PDFは次のキーで非公開S3バケットに保存します。

```text
tenants/{tenantId}/documents/{documentId}/{snapshotId}.pdf
```

`PutObject` はSSE-KMS、バケットキー、SHA-256 checksum、`If-None-Match: *` を必須とします。DBにはキー、SHA-256、バイト数、元の計画書版、ステータスを保存し、更新・削除トリガーで改ざんを禁止します。ダウンロード時はDBの値と再計算したSHA-256・サイズを照合します。

S3キーと利用児氏名はAPIのメタデータ応答やエラー、監査ログに出しません。PDF本文は権限確認後にアプリケーション経由で返します。

受給者証番号は通常の画面・APIで下4桁以外を常時マスクします。PDF生成の権限確認と元版ロックの後だけ、KMS暗号化コンテキスト `tenant_id` + `field_name=recipient_certificate_number` でメモリ復号します。平文はテンプレートとChromiumにのみ渡し、応答JSON、監査メタデータ、エラーには含めません。復号失敗時はDBトランザクションをロールバックし、PDFをS3へ保存しません。帳票にはあわせて支給決定自治体、利用者負担上限月額、受給者証有効期間を転記します。

## 実行環境

- `playwright` は本番dependencyです。ECSイメージは `mcr.microsoft.com/playwright:v1.62.1-noble` を使用し、日本語字形用に `fonts-noto-cjk` を入れます。
- コンテナは非rootの `pwuser` で実行します。`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` を使用し、必要な環境だけ `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を設定します。
- 本番では `DOCUMENT_BUCKET` / `DOCUMENT_KMS_KEY_ARN` / `AWS_REGION` が必須です。
- レンダラーとストレージは `buildApp` へ注入でき、テストでAWSやChromiumを呼び出さずに競合・改ざん・権限を検証できます。

## API

```text
POST /api/v1/children/:childId/documents/:documentId/snapshots
POST /api/v1/children/:childId/documents/:documentId/pdf
POST /api/v1/children/:childId/documents/:documentId/consent-intents
GET  /api/v1/children/:childId/documents/:documentId/snapshots
GET  /api/v1/children/:childId/documents/:documentId/snapshots/:snapshotId
GET  /api/v1/children/:childId/documents/:documentId/snapshots/:snapshotId/content
```

POSTには `If-Match` と `{ "snapshotKind": "draft" | "official" }` が必要です。すべて `pdf.export` 権限で保護し、生成・再利用・取得を監査イベントとして記録します。

## トランザクションと運用上のトレードオフ

予約時だけ対象文書をロックし、元の`row_version`、ソースダイジェスト、決定的な保存キー、jobとleaseをcommitします。その後はDB接続を保持せずにChromium生成・KMS復号・S3 Putを行い、実際のVersionId・SHA-256・バイト数を検証して短い確定トランザクションへ進みます。文書が途中で変わった場合は正式スナップショットへ接続せず、`SOURCE_CHANGED`として保全します。

S3 Put成功後・DB確定前にプロセスが停止した場合も、オブジェクトを削除しません。次の認証済みリクエストがleaseを引き継ぎ、同じjob idの実オブジェクトをVersionId・SHA-256・サイズで照合できた場合だけDBへ再接続します。照合できないものは`quarantined`へ移し、通常webロールが全tenantを走査したり、孤立オブジェクトを削除したりしません。

この方式はDB接続とメモリ枯渇を抑えますが、API応答内でPDF生成を完了する同期UXは維持しています。1 GiB taskでは同時生成1件・待機1件に制限し、超過時は`Retry-After`付き503を返します。将来処理量が増えた場合は、同じjob契約を使って専用ワーカーへ分離できます。

## 同意時ソースの固定

- 同意記録と同じトランザクションで、DBの限定的な `SECURITY DEFINER` 関数が利用児・保護者・事業所・計画本文・目標・モニタリング・確定済み予定表を権威ある行から1つのJSONへ集約し、`document_consent_sources` に追記専用で保存します。呼出元はJSONやハッシュを指定できず、自己署名した偽の帳票ソースを差し込めません。未確定の予定表は正式ソースへ含めません。
- 受給者証番号の平文と暗号文はJSONへ含めません。暗号文は専用の `bytea` 列へ分離し、JSONと暗号文それぞれのSHA-256を保存・再計算してから帳票を生成します。
- `consented` 状態の下書きと正式版は、現在のマスターデータではなく同意時ソースだけを使用します。承認者名も変更可能な職員マスターではなく、追記専用の承認イベントに記録した氏名を使用します。
- 旧データなどで同意時ソースが無い場合は409、ハッシュ不一致など完全性を確認できない場合は503で安全に拒否し、PDFを生成・保存しません。
- 目標の追加・変更・削除は親計画書を先にロックし、親の `row_version` を必ず更新します。同意処理も同じ親行をロックし、`REPEATABLE READ` で集約するため、目標変更と同意が競合して未同意内容が混入することを防ぎます。
- PDF生成時のロックは、編集権限を持たない監査者でも安全に利用できる限定的な `SECURITY DEFINER` 関数で取得します。RLSによるテナント・施設・帳票のアクセス制御は維持されます。
- 同意ダイアログを開くと `POST .../consent-intents` が、個人情報本文を返さずに集約内容のHMAC-SHA-256、対象版、`row_version`、5分間有効な署名トークンを発行します。同意POSTはこれらを必須とし、同じ `REPEATABLE READ` トランザクションで集約を再計算します。別端末で利用児・保護者・確定予定表などが変わっていれば409で拒否し、最新内容の再確認を求めます。HMAC鍵は監査鍵から用途別に導出し、集約ハッシュから氏名などを推測できないようにします。
