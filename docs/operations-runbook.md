# みちのーと SaaS 運用ランブック

最終更新: 2026-08-14

対象: staging / production、AWS `ap-northeast-3`

## 1. 運用目標と責任分界

本サービスは、障害児の基本情報、日誌、連絡帳、アセスメント、モニタリング、個別支援計画書、PDFを扱う。これらは要配慮個人情報を含み得るため、「動けばよい」ではなく、認証、法人分離、最小権限、監査、復旧可能性を運用で継続する。

| 項目 | 目標 |
| --- | --- |
| 可用性 | 月間 99.9%（計画停止を除く） |
| RPO | 15分以内 |
| RTO | 4時間以内 |
| DBバックアップ | RDS PITR 35日 + AWS Backup continuous/daily、月次7年 |
| アプリ・WAF・VPCログ | CloudWatch 365日（パラメータで変更可能） |
| 重大障害の一次応答 | 検知から15分以内 |
| 権限削除 | 退職・契約終了の確定から即時、遅くとも4時間以内 |

RPO/RTOは四半期ごとの復旧演習で計測する。テンプレートに設定があるだけでは達成済みとみなさない。

運用台帳には個人名ではなく、次の当番ロールと代行者を登録する。

- インシデント責任者: 優先順位、顧客連絡、復旧／切戻し判断
- アプリ当番: ECS、ALB、WAF、リリース、アプリログ
- DB当番: RDS、PITR、マイグレーション、整合性検証
- セキュリティ責任者: 漏えい可能性、証拠保全、認証停止、届出判断
- テナント運用責任者: 法人・施設・職員の登録、停止、データ受渡し

本番変更、テナント完全削除、バックアップ削除、KMS削除は、実施者と承認者を分けた二者承認とする。

## 2. 通常監視

### 毎日

1. SNSの未対応アラームがないことを確認する。
2. ALBの `HealthyHostCount` が2以上、5xxが平常範囲であることを確認する。
3. ECSの desired/running task数、CPU、メモリ、直近のdeploymentを確認する。
4. RDSのCPU、接続数、空き容量、待機、Multi-AZ状態、バックアップ最終時刻を確認する。
5. AWS Backupの直近ジョブが `COMPLETED` であることを確認する。
6. Cognitoの異常なサインイン失敗、WAFのBLOCK急増を確認する。

### 毎週

1. CloudWatchでアプリの5xx、p95応答時間、DBクエリ遅延、認証エラーを比較する。
2. 失敗ジョブ、期限切れ証明書、未確認SNS subscription、Cognito無効化漏れを確認する。
3. 管理者・施設管理者の在籍とMFA状態を差分確認する。
4. 監査ログの欠落、異常な大量閲覧・PDF出力・権限変更を確認する。

### 毎月

1. 利用量と上限（ECS、RDS storage、S3、Cognito、WAF、CloudWatch Logs）を確認する。
2. OS／Node.js／npm／コンテナベースイメージ／PostgreSQL minor versionの更新候補を評価する。
3. 全法人のactive membershipと請求・契約台帳を照合する。
4. バックアップ保持、S3 noncurrent version、CloudWatch retentionが契約・法令上の方針と一致するか確認する。
5. AWS IAM Access Analyzer、CloudTrail、GuardDuty等のアカウント監視結果を確認する。

## 3. アラーム対応

| アラーム | 最初の確認 | 初動 |
| --- | --- | --- |
| NoHealthyTarget / UnhealthyTarget | ECS event、task停止理由、`/health/ready`、DB到達性 | 直前deploymentなら切戻し。DB障害なら復旧手順へ |
| ALB Target 5xx | request ID、route、同時刻のアプリerror | 影響範囲を特定し、必要なら直前task definitionへ戻す |
| ECS CPU / memory | request数、遅いroute、DB待機、autoscaling | 上限に達していれば一時増強し、原因を記録 |
| RDS CPU / storage | Performance Insights、長時間query、connection、autovacuum | 書込み抑制、問題query停止、容量増強を変更申請 |
| ServerErrors | 同一request ID、error code、tenant匿名ID | 個人情報をコピーせず事象分類。再現と暫定対処 |
| Backup job failed | Backup event、vault、KMS grant、RDS状態 | 当日中に手動backupを再実行し、成功証跡を保存 |
| WAF block急増 | rule名、送信元、route、誤検知 | 攻撃なら遮断継続。誤検知のrule除外は期限付き変更 |

アラームを「確認済み」にする前に、発生時刻、影響法人（不明なら不明）、操作、結果、次回確認時刻をインシデント記録へ残す。ログへ氏名、住所、診断名、受給者証番号、日誌本文、Cookie、tokenを転記しない。

## 4. リリースと切戻し

### リリース前

1. main branchのCIがunit、API、RLS/tenant isolation、権限表、E2E、infra contractで成功している。
2. イメージを脆弱性スキャンし、レビュー済みcommitから作成したdigestを確定する。
3. DB変更がexpand/contract方式で、旧taskと新taskの両方から安全に使えることを確認する。
4. CloudFormation change setでreplacement、IAM、security group、retention、deletion policyを二者レビューする。
5. 変更時間、責任者、切戻し条件、顧客連絡要否を記録する。

### リリース

1. stagingへ同じdigestを適用し、ログイン、利用児切替、日誌保存、競合409、帳票生成、監査記録を確認する。
2. 必要なDB migrationを`infra/migration-task.template.json`の一回限りtaskで実行する。終了コード0とruntime LOGIN設定イベントを確認後、migration stackを削除する。通常web taskへRDS master secretを渡さない。
3. productionのCloudFormation change setを実行する。
4. ECS deployment circuit breakerが完了し、healthy taskが2つあることを確認する。
5. 合成テストを実行し、15分間の5xx、p95、CPU、DB connectionを確認する。
6. 実施者、image digest、task definition、migration version、確認結果をrelease記録へ残す。

### 切戻し

- アプリ不具合: 直前の正常なimage digest/task definitionへ戻す。データを書き換える手作業はしない。
- migration不具合: 原則としてforward-fixする。縮退・列削除は、旧task停止とバックアップ確認後の別releaseで行う。
- インフラ不具合: change setのreplacement対象を再確認し、CloudFormation eventを保存して直前template/parameterへ戻す。

切戻し後も、障害中に受け付けた更新の欠落・重複・tenant誤帰属がないことを監査イベントとDB件数で確認する。

## 5. バックアップと復旧

### 保護の構成

- RDS automated backup: 35日、PITR、Multi-AZ、削除時snapshot
- AWS Backup: continuous/daily 35日、月次archive 7年、KMS暗号化vault
- S3: SSE-KMS、Versioning、noncurrent versionを90日後Glacier、7年後削除
- CloudFormation: DBは`Snapshot`、S3/Cognito/KMS/Secrets/Logs/Vaultは`Retain`

S3 Versioningはバックアップの代用ではない。四半期演習ではDBと関連PDFの両方を確認する。

### RDS緊急復旧（RTO 4時間）

1. **0–15分: 宣言と封じ込め** 重大度を判定し、書込みによる被害拡大が疑われる場合はサービスをmaintenanceへ切り替える。復旧目標時刻を決める。
2. **15–30分: 復旧点決定** CloudTrail、audit event、アプリログを用い、破損・誤操作の直前かつ15分以内の復旧点を選ぶ。証拠を変更しない。
3. **30–150分: 別DBへ復元** 元DBを上書きせず、同じprivate DB subnet/security group/KMS keyで新しいRDS instanceへPITRする。
4. **150–195分: 検証** schema migration version、全tenant件数、代表tenantのchild/document/log件数、RLS cross-tenant拒否、監査連続性、PDF keyとの参照を確認する。
5. **195–225分: 切替** ECS task definitionのDB endpointを新DBへ変更し、health/smoke test後にtrafficを戻す。
6. **225–240分: 監視と連絡** エラー率と更新成功を確認し、顧客へ影響・欠落可能時間・復旧時刻を通知する。

旧DBは証拠保全期間が終わるまで隔離し、削除しない。復旧点と最初の正常更新時刻との差が15分以内かをRPO実績として記録する。

### 四半期復旧演習

1. 本番と通信しないisolated restore環境へ、無作為に選んだ復旧点から復元する。
2. migrationを適用し、readiness、tenant RLS、件数、checksum、帳票生成を確認する。
3. S3のcurrent/noncurrent versionから代表PDFを復元し、DBのSHA-256と照合する。
4. 開始から利用可能判定までを計時する。RPO 15分/RTO 4時間を超えた場合は改善issueに期限と責任ロールを付ける。
5. 証跡を保存し、復元環境と一時credentialを二者確認で廃棄する。

## 6. 法人（テナント）オンボーディング

オンボーディングは、Cognitoユーザーを作るだけでは完了しない。DBの法人・施設・membershipを一つの業務単位として登録する。

### 受付情報

- 契約法人名、施設名、サービス種別、運用開始日
- 法人管理者の氏名・業務用メール・本人確認済み連絡先
- データ保持、帳票、監査ログ、解約時受渡しの合意
- 初期role、担当facility、二要素認証の案内

### 実施手順

1. 作業ticketへ二者承認済み契約IDを記録し、operation、tenant、admin user、membership、facilityの5個のUUIDを一度だけ払い出す。氏名・メールはticket本文へ貼らない。
2. migration taskでschema適用と`michinote_provisioner`のSCRAM LOGIN設定が完了していることを確認する。通常web taskへprovisioner secretを注入しない。
3. 次のキーを持つJSONを、DataKeyで暗号化した短命のSecrets Manager secretとして登録する。値をCloudFormation parameter、ECS task override、shell historyへ直接書かない。

   ```json
   {
     "operationId": "承認済みUUID",
     "organizationId": "承認済みUUID",
     "organizationName": "契約法人名",
     "administratorUserId": "承認済みUUID",
     "administratorEmail": "本人確認済み業務用メール",
     "administratorDisplayName": "法人管理者表示名",
     "administratorMembershipId": "承認済みUUID",
     "firstFacilityId": "承認済みUUID",
     "firstFacilityCode": "英数字・ハイフン・アンダースコア",
     "firstFacilityName": "最初の施設名",
     "resendInvitation": "false",
     "resendEventId": "未使用のUUID"
   }
   ```

4. [`infra/onboarding-task.template.json`](../infra/onboarding-task.template.json)を短命stackとして作成する。main stackの`VpcId`、`VpcCidr`、`DatabaseSecurityGroupId`、DB endpoint/name、`DatabaseProvisionerSecretArn`、`DataKeyArn`、Cognito User Pool ID/ARN、log groupを渡す。個人情報をparameterへ渡さない。
5. main stack出力のECS clusterとprivate application subnets、onboarding stack出力のsecurity group/task definitionを固定して`RunTask`を1回実行する。task roleは対象User Poolの`AdminCreateUser` / `AdminGetUser`だけ、DB roleは`reconcile_initial_tenant`と監査付き招待再送のclaim/result関数だけを実行できる。
6. taskはCognitoを作成または照合し、確認済みメールと`sub`が完全一致した後、DBのorganization、facility、tenant admin、facility scope、事前認証audit event、immutable receiptを一transactionで確定する。
7. taskがCognito作成後に失敗しても、UUIDやsecret内容を変えず同じtaskを再実行する。既存Cognitoユーザーを照合してDBから再開するため招待は再送されない。operation UUIDを別内容へ再利用するとDBが拒否する。Cognitoを手作業で削除して合わせない。
8. task exit code 0、`initial_tenant_onboarding_complete`ログ、`tenant.initial_provisioning_completed` audit event、receiptのoperation/tenant/facility IDを照合する。ログとaudit metadataに氏名・メール・Cognito subがないことも確認する。
9. onboarding request secretを削除予定にし、短命onboarding stackを削除してIAM role、task definition、DB ingressを失効する。DBのprovisioner secretは保持するが、通常taskから読めないことを確認する。
10. tenant adminが初回ログインでtemporary password変更とTOTP MFA登録を完了し、法人名、施設名、対象児0件、職員権限を確認する。別tenant IDがAPIで404になる自動テスト後に開始承認を記録する。

現行初期版は、1つのログインに同時に開いている法人membershipを1件に制限する。複数法人切替を提供するまでは、既存メールを別法人の初期管理者へ流用しない。APIはクライアント送信の`tenant_id`を信頼しない。

### 初回管理者の招待再送

Cognitoのtemporary passwordは3日で失効する。最初の法人管理者が未ログインのままメールを紛失・失効し、管理UIから再招待できる職員がまだいない場合だけ、同じ短命taskを明示的な復旧モードで使う。

1. 元のonboarding operation UUIDと法人・施設・管理者入力を一字も変えずに新しい短命request secretを作る。`resendInvitation`を文字列`"true"`にし、今回の再送だけに使う新しい`resendEventId` UUIDを二者承認で払い出す。
2. taskはまず既存Cognitoの確認済みメールと`sub`、DB receipt、canonical organization/user/membership/facilityを照合する。差分があればAWSへ再送する前に拒否する。
3. DBへappend-onlyな再送要求audit eventを記録してclaimできた場合だけ、`FORCE_CHANGE_PASSWORD`状態へCognito `AdminCreateUser`の`RESEND`を1回実行する。`CONFIRMED`は成功扱いのno-opで、メールを送らない。`RESET_REQUIRED`等は招待再送の対象外として拒否する。
4. 同じ`resendEventId`を再実行してもAWSへ再送しない。claim後にtaskが異常終了した場合はCloudTrailとaudit eventを確認し、送信されていないことを確認できた場合に限り、別の`resendEventId`を二者承認して再実行する。自動反復でメールを多重送信しない。
5. `tenant.initial_admin_invitation_resend_requested`と`tenant.initial_admin_invitation_resend_completed`、task exit codeを照合し、氏名・メール・Cognito subがログ/audit metadataに含まれないことを確認後、request secretと短命stackを廃棄する。

## 7. 職員追加・異動・削除

- 追加: tenant adminが招待し、必要最小のrole/facilityだけを設定する。法人管理者とfacility管理者の付与は二者確認する。
- 異動: 旧facility scopeを削除してから新scopeを追加し、既存sessionを失効する。
- 退職・委託終了: Cognito user無効化、全membership停止、全server session失効を即時実施する。監査イベントを残す。
- 復職: 既存権限をそのまま戻さず、現在の業務で再申請する。
- 定期棚卸し: tenant adminが毎月、SaaS運用者が四半期に例外・休眠・特権roleを確認する。

SaaS運用者には通常の利用児本文閲覧権限を与えない。調査で必要な場合は、ticket、期限、対象tenant、理由を記録したbreak-glass権限を使い、操作後に失効する。

### 職員招待の送信結果が不明な場合

招待メールの送信中にプロセスが停止した場合や、timeout・通信断・Cognito 5xxが起きた場合は、Cognitoが受理した後か前かをアプリだけでは判定できない。この場合、対象招待は`STAFF_INVITATION_RECONCILIATION_REQUIRED`となり、初回招待・明示再送のどちらも自動では再送しない。AdminCreateUser/RESENDはidempotency tokenを持たないため、通常招待と初回管理者onboardingのAWS SDKは`maxAttempts: 1`に固定し、SDK内部でも再送させない。

1. 409応答の`membershipId`、request ID、発生時刻をインシデントticketへ記録し、画面から再送を繰り返さない。
2. CloudTrailの`AdminCreateUser`、Cognitoの対象内部username・状態、アプリの`staff.invited`監査イベントを照合する。メールアドレスや氏名をticket本文・チャット・SQLログへ転記しない。
3. 送信済み／未送信を二者で確定できない場合はclaimを解除せず、セキュリティ責任者へエスカレーションする。
4. 結果を確定できた場合だけ、private subnet内のmigration owner接続から、bind parameterを使ってowner-only関数`app_private.reconcile_staff_invitation_delivery_claim`を実行する。通常webの`michinote_runtime`と`michinote_provisioner`にはこの関数の`EXECUTE`を付与しない。
5. 送信済みならCognitoの内部usernameと成功を記録する。未送信なら安全なエラーコードと失敗を記録し、その後に限って管理画面から新しいIdempotency-Keyで1回再送する。
6. 対象facilityごとの`staff.invitation_delivery_reconciled`監査イベント、招待状態、ticket番号を照合し、break-glass接続を直ちに失効する。

claimのlease切れを理由に自動再送してはならない。送信後・DB確定前の障害では、同じキーでも別キーでもメールが重複する可能性がある。

## 8. 法人オフボーディング

1. 解約日、データ受渡し、保持期限、法的保全、未処理帳票を法人責任者と確定する。
2. organizationを`suspended`にし、新規更新を停止する。tenant adminを含むmembershipとsessionを失効し、Cognito accessを無効化する。
3. 契約に従い、暗号化されたexportとmanifest（件数、期間、ファイルhash、作成時刻）を作成する。別tenantデータがないことを二者確認する。
4. DB、S3 prefix、backup recovery point、audit eventの削除予定日をretention台帳へ登録する。
5. 保持期間中は復元可能だが通常画面から見えない状態を維持する。
6. 保持満了後、legal holdがないことを再確認し、専用purge jobでtenant IDを固定して削除する。ワイルドカードや手入力のS3 prefixで削除しない。
7. DB row数、S3 object/version数、検索index/cache、Cognito association、export一時物が0であることを確認する。
8. backup世代の自然満了日を記録し、削除証跡を契約台帳へ添付する。

CloudFormation stack削除をtenant削除に使わない。共有User Pool、DB、bucketを削除すると全法人へ影響する。

## 9. セキュリティインシデント

### 重大度

- SEV1: cross-tenant閲覧、credential漏えい、広範囲停止、データ破壊の疑い
- SEV2: 単一tenantの重要機能停止、限定的な不正アクセス疑い、復旧余裕が小さい
- SEV3: 回避策のある不具合、性能劣化、監視の欠落

### 初動

1. SEV1は15分以内に責任者を立て、変更作業を凍結する。
2. 疑わしいsession/user/access keyを無効化する。証拠となるDBやログを先に削除しない。
3. CloudTrail、Cognito、WAF、ALB、CloudWatch、app audit eventを時刻同期して保全する。
4. tenant・facility・user・resourceの影響範囲をIDで特定する。通常のチャットへ本文や氏名を貼らない。
5. セキュリティ責任者が、顧客連絡、法令・契約上の報告、監督機関への相談要否を判断する。
6. containment、eradication、recovery後、5営業日以内に原因、検知不足、恒久対策をレビューする。

credential漏えい時は、当該secretをSecrets Managerで新versionへ更新し、DB role／session／Cognito tokenを失効してECSを再deploymentする。KMS keyは漏えいしたデータ鍵と同一視せず、影響分析なしに削除・無効化しない。

## 10. 秘密情報・証明書・鍵

- secret valueをCloudFormation output、Git、ticket、ログ、スクリーンショットへ出さない。DBのhost/user/passwordは分離してECSへ注入し、passwordを接続URLへ連結しない。
- web taskはruntime DB secretとsession secretのみ読む。RDS master secretはmigration/復旧の一時roleだけが読み、migration task終了後は短命stackごとroleを削除する。
- DB初期構築では`DatabaseBootstrapMode=enabled`でweb task数を0に保ち、migration成功後だけ`disabled`へ更新する。runtime passwordは移行ランナーがSCRAM verifierへ変換し、平文をSQL・履歴・ログへ出さない。
- RDSは`rds-ca-rsa2048-g1`へ固定し、webは`DATABASE_CA_FILE`、migrationは`MIGRATION_DATABASE_CA_FILE`で検証済みOsaka bundleを読む。CA bundle checksumまたはRDS CA identifierの変更は、通常の依存更新ではなく証明書ローテーションとして二者レビューする。
- DB password rotationは、DB roleのpassword更新とSecrets Managerの新versionを合わせ、staging検証後にECSをrolling restartする。`PDF_FINALIZATION_SECRET`はDB passwordから独立しているため、DB password rotation時に変更しない。
- `PDF_FINALIZATION_SECRET`をrotationする場合は、同じ新versionをmigration taskとWeb taskへ用意し、migration taskでDB検証値を更新した直後にWeb taskをrolling deploymentする。値をparameter、CLI引数、ログへ出さない。
- session secret rotation時はgrace period中に現行・直前keyを検証できる実装を用い、既存sessionを失効する場合は利用者へ告知する。
- ACM certificateの更新失敗を毎週確認する。DNS validation recordを削除しない。
- KMS key deletion windowは30日だが、削除申請そのものを二者承認・データ保持確認なしで行わない。

## 11. 定期テストと本番開始判定

本番開始前に、少なくとも次の証跡を揃える。

- CloudFormation service validationとreview済みchange set
- MFA必須、admin招待、session失効、CSRF/Origin、rate limitの結果
- role×操作の許可／拒否表、facility scope、cross-tenant API/RLSテスト
- 同時編集409と再読込・マージ、offline/error表示、idempotencyの結果
- 日誌→モニタリング→アセスメント→個別支援計画→PDFのE2E
- backup成功通知、PITR復旧、S3 version復旧、RPO/RTO計測結果
- 個人情報を含めない構造化ログとaudit eventの検索結果
- tenant onboarding/offboarding dry-runと二者承認記録
- 主要画面のキーボード操作、focus、エラー説明、200%拡大のアクセシビリティ結果

いずれかが未完の場合、本番データを投入せず、stagingまたは限定pilotとして扱う。

## 12. 公式リファレンス

- [Amazon RDS automated backups and point-in-time recovery](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html)
- [Restoring an Amazon RDS DB instance with AWS Backup](https://docs.aws.amazon.com/aws-backup/latest/devguide/restoring-rds.html)
- [Amazon ECS deployment circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html)
- [Amazon Cognito MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-mfa.html)
- [Amazon S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)
