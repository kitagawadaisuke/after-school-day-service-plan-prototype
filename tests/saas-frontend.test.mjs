import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../server/app.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, script, css] = await Promise.all([
  readFile(join(ROOT, "saas.html"), "utf8"),
  readFile(join(ROOT, "src", "saas-app.js"), "utf8"),
  readFile(join(ROOT, "styles", "saas.css"), "utf8"),
]);

function appConfig(overrides = {}) {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8015,
    appBaseUrl: "http://127.0.0.1:8015",
    databaseUrl: undefined,
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "development",
    cookieSecret: undefined,
    auditHashKey: "test-audit-hash-key",
    cognito: null,
    devActor: {
      userId: "018f1db5-c170-7c35-a784-3cfc6f98c201",
      tenantId: "018f1db5-c170-7c35-a784-3cfc6f98c101",
      facilityIds: ["018f1db5-c170-7c35-a784-3cfc6f98c301"],
      role: "tenant_admin",
      displayName: "テスト職員",
    },
    ...overrides,
  };
}

test("SaaSシェルはセッション・所属・利用者を起点にした業務ランドマークを備える", () => {
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<a class="skip-link" href="#main-content">/);
  assert.match(html, /<aside class="sidebar" aria-label="主な機能">/);
  assert.match(html, /id="sidebar-facility-name">事業所を読み込んでいます/);
  assert.match(html, /<nav class="primary-nav" aria-label="業務メニュー">/);
  assert.match(html, /<main id="main-content" tabindex="-1">/);
  assert.match(html, /id="facility-select" aria-label="表示する事業所"/);
  assert.match(html, /id="staff-name"/);
  assert.match(html, /id="staff-role"/);
  assert.match(html, /id="logout-button"[^>]+type="button">ログアウト/);
  assert.match(html, /data-view="audit"/);
  assert.match(html, /<span aria-hidden="true">04<\/span>操作履歴/);
  assert.match(html, /<span aria-hidden="true">02<\/span>支援の記録/);
  assert.doesNotMatch(html, /data-view="journals"/);
  assert.doesNotMatch(html, /id="view-journals"/);
  assert.match(html, /<h1 id="contact-title">支援の記録<\/h1>/);
  assert.doesNotMatch(html, /保護者へのお知らせ/);
  assert.doesNotMatch(html, /id="contact-list"/);
  assert.match(html, /id="view-audit"/);
  assert.match(html, /登録・編集・削除などの操作を確認できます。/);
  assert.match(html, /職員・事業所設定/);
  assert.doesNotMatch(html, /<button class="admin-nav permission-view-admin"/);
  assert.doesNotMatch(html, /この事業所の記録/);
  assert.doesNotMatch(html, /記録は法人ごとに分離/);
  assert.match(html, /id="child-search-input" type="search"/);
  assert.match(html, /id="child-picker-recent"/);
  assert.match(html, /最近開いた利用者/);
  assert.match(html, /id="child-picker-results-count"/);
  assert.match(html, /id="open-child-delete-dialog"[^>]*>利用者を削除/);
  assert.match(html, /id="child-delete-dialog"[^>]*aria-describedby="child-delete-description"/);
  assert.match(html, /id="child-delete-confirmation" name="confirmation"[^>]*required/);
  assert.match(script, /function rememberRecentChild\(/);
  assert.match(script, /michinote:recent-children:/);
  assert.match(script, /picker-current-badge/);
  assert.match(script, /async function submitChildDelete\(/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /sidebarFacilityName\.textContent/);
  assert.match(css, /\.facility-identity/);
});

test("最後に開いた利用者は同じ職員・事業所のブラウザタブ内で復元する", () => {
  assert.match(script, /function selectedChildStorageKey\(/);
  assert.match(script, /window\.sessionStorage\.setItem/);
  assert.match(script, /await selectChild\(rememberedChild\.id, \{ announceSelection: false \}\)/);
  assert.match(script, /forgetSelectedChild\(\)/);
});

test("外部計画は任意の参考資料とし、事業所の計画と専門的支援計画を正式工程で扱う", () => {
  assert.match(html, /data-create-document="consultation_plan"/);
  assert.match(html, /id="open-assessment-generation"/);
  assert.match(html, /id="open-individual-plan-generation"/);
  assert.doesNotMatch(html, /1　整理する|2　計画にする|3　振り返る/);
  assert.doesNotMatch(html, /計画をつくる/);
  assert.match(html, /class="document-lane-index" aria-hidden="true">01/);
  assert.match(html, /class="document-lane specialized"/);
  assert.match(html, /class="document-lane-step">現状を整理/);
  assert.match(html, /class="document-lane-step">方針を決める/);
  assert.match(html, /class="document-lane-step">支援を振り返る/);
  assert.match(html, /id="open-monitoring-generation"/);
  assert.match(html, /<strong>共通の参考資料<\/strong>/);
  assert.match(html, /class="document-reference-panel document-reference-shared"/);
  assert.match(html, /すべての帳票の作成・編集時に確認します。/);
  assert.match(html, /id="assessment-document-controls"/);
  assert.match(html, /id="assessment-generation-dialog"/);
  assert.match(script, /function openAssessmentGeneration\(/);
  assert.match(css, /\.readiness-copy, \.document-workflow-copy, \.document-item \.document-workflow-copy[^}]+font-size: 13px/);
  assert.match(script, /assessment-document-controls"\)\.hidden = !can\("documents\.edit"\)/);
  assert.match(script, /if \(view === "journals"\) view = "contact"/);
  assert.match(script, /kind === "monitoring_record" && !documents\.length && state\.selectedChild/);
  assert.match(html, /参考資料を登録/);
  assert.match(html, /id="reference-material-view-dialog"/);
  assert.match(html, /id="delete-reference-material-button"/);
  assert.match(script, /text: "参考資料を削除"/);
  assert.match(script, /アセスメントを編集/);
  assert.match(script, /計画書を編集/);
  assert.match(html, /利用者ごとの計画書・面談資料・連絡事項を保管し、すべての帳票で参照します。/);
  assert.match(css, /\.document-reference-shared \.document-reference-content \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(html, /id="reference-plan-editor-dialog"/);
  assert.match(html, /name="referenceMemo"/);
  assert.doesNotMatch(html, /name="childWish"/);
  assert.match(script, /\["individual_support_plan", "specialized_support_plan"\]\.includes\(kind\)/);
  assert.match(html, /<h2 id="individual-title">個別支援計画<\/h2>/);
  assert.match(html, /data-create-document="specialized_support_plan"/);
  assert.match(html, /<h2 id="specialized-title">専門的支援計画<\/h2>/);
  assert.match(script, /documentKind: kind/);
  assert.match(script, /targetDocumentKind: "basic_assessment"/);
  assert.match(script, /assessmentDocumentId: assessment\?\.id/);
  assert.match(script, /targetDocumentKind: "individual_support_plan"/);
  assert.match(script, /individualSupportPlanDocumentId: planCanRefresh \? individualPlan\?\.id : undefined/);
  assert.match(script, /targetDocumentKind: "monitoring_record"/);
  assert.match(script, /assessmentButton\.disabled = !state\.selectedChild/);
  assert.match(script, /individualButton\.disabled = !state\.selectedChild \|\| !assessment/);
  assert.doesNotMatch(html, /open-current-schedule-from-assessment|現在の生活を登録する/);
  assert.match(script, /function openReferencePlanEditor\(/);
  assert.match(script, /suppressConflictDialog: true/);
  assert.match(script, /入力途中の参考資料を開きました。続きから入力してください。/);
  assert.match(script, /error\.code === "DRAFT_EXISTS" && kind === "consultation_plan"/);
  assert.match(script, /function openReferenceMaterialViewer\(/);
  assert.match(script, /function removeReferenceMaterial\(/);
  assert.match(script, /確認画面では削除場所を常に明示します/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /\/reference-material`/);
  assert.match(script, /function hasReferenceMaterialContent\(/);
  assert.match(script, /documentRecord\.status !== "void" && Array\.isArray\(detail\?\.attachments\) && detail\.attachments\.length > 0/);
  assert.match(script, /function latestReferenceMaterial\(/);
  assert.match(script, /container\.hidden = true/);
  assert.match(script, /参考資料と入力内容を保存しました。/);
  assert.match(script, /PROGRESS_STATUS_LABELS/);
  assert.match(script, /未評価（根拠不足）/);
  assert.match(script, /要確認/);
  assert.match(script, /\/children\/\$\{encodeURIComponent\(state\.selectedChild\.id\)\}\/documents/);
});

test("保護者・受給者証を利用者台帳で扱い、週間予定画面を表示しない", () => {
  assert.match(html, /role="tablist" aria-label="利用者情報の種類"/);
  assert.match(html, /id="guardian-form" novalidate/);
  assert.match(html, /name="guardianId" type="hidden"/);
  assert.match(html, /id="guardian-save-button"/);
  assert.match(html, /name="recipientCertificateNumber"/);
  assert.match(html, /name="certificateValidFrom" type="date"/);
  assert.match(html, /name="certificateValidTo" type="date"/);
  assert.match(script, /function certificateExpiryStatus\(/);
  assert.match(script, /期限まであと\$\{daysRemaining\}日/);
  assert.match(script, /function validateCertificatePeriod\(/);
  assert.match(html, /保存後は末尾4桁だけを表示/);
  assert.match(html, /name="municipalityName"/);
  assert.match(html, /name="copaymentLimitYen"/);
  assert.match(html, /アセスメントシートに記載する確認項目/);
  assert.match(html, /name="dailyMeal"/);
  assert.match(html, /name="favoriteCharacter"/);
  assert.match(script, /const ASSESSMENT_TEMPLATE_FIELDS/);
  assert.match(html, /個別支援計画に記載する確認項目/);
  assert.match(html, /name="supportGoal1"/);
  assert.match(html, /name="weeklySchoolHoliday"/);
  assert.match(script, /const PLAN_TEMPLATE_FIELDS/);
  assert.match(html, /id="monitoring-editor-form"/);
  assert.match(html, /name="monitoringSupportGoal1"/);
  assert.match(script, /const MONITORING_TEMPLATE_FIELDS/);
  assert.doesNotMatch(html, /child-tab-schedules|child-panel-schedules|schedule-dialog|現在の生活|計画後の生活|週間予定/);
  assert.doesNotMatch(script, /renderGuardians\(\);\s*renderSchedule\("current"\);/);
  assert.match(html, /data-journal-character-count="observation"/);
  assert.match(html, /id="save-journal-draft"[^>]+>下書き保存/);
  assert.match(html, /id="save-journal-final"[^>]+>記録を保存/);
  assert.match(html, /id="daily-summary-dialog"/);
  assert.match(html, /id="daily-summary-card"/);
  assert.match(html, /id="print-daily-summary"[^>]+>印刷 \/ PDF保存/);
  assert.match(script, /function openDailySummary\(/);
  assert.match(script, /function printDailySummary\(/);
  assert.match(script, /text: "当日のサマリー"/);
  assert.match(css, /\.daily-summary-timeline \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /body\.daily-summary-printing #app-shell/);
  assert.match(html, /data-contact-reply-length/);
  assert.match(html, /文章を整える/);
  assert.match(html, /data-copy-journal-field="observation"[^>]*>コピー/);
  assert.match(html, /id="copy-contact-reply"[^>]*>コピー/);
  assert.match(html, /data-journal-writing-disclosure="observation"/);
  assert.match(html, /data-contact-writing-disclosure="facilityReply"/);
  assert.match(script, /async function copyFieldText\(/);
  assert.match(script, /navigator\.clipboard\?\.writeText/);
  assert.match(html, /引継ぎ事項/);
  assert.doesNotMatch(html, /data-request-summary-length|expand-request-summary/);
  assert.match(html, /目標文字数/);
  assert.match(script, /日誌を編集/);
  assert.doesNotMatch(script, /text: "工程を確認"/);
  assert.match(script, /連絡帳を編集/);
  assert.match(script, /contact-book\/\$\{encodeURIComponent\(entryId\)\}/);
  assert.match(script, /連絡帳を変更しました/);
  assert.match(html, /id="contact-form-description"/);
  assert.doesNotMatch(html, /id="contact-family-message-field"/);
  assert.match(html, /id="contact-photo-input" name="contactPhotos" type="file"/);
  assert.match(html, /id="contact-photo-count" aria-live="polite"/);
  assert.match(html, /JPEG・PNG・WebPを最大4枚まで/);
  assert.match(script, /function openContactDraftFromJournal\(/);
  assert.match(script, /const MAX_CONTACT_PHOTOS = 4/);
  assert.match(script, /function renderContactPhotoGallery\(/);
  assert.match(script, /function validateContactPhotos\(/);
  assert.match(script, /contact-book\/\$\{encodeURIComponent\(entryId\)\}\/photos/);
  assert.match(script, /async function deleteContactPhoto\(/);
  assert.match(script, /登録済みの写真 \$\{index \+ 1\}枚目を削除/);
  assert.match(script, /method: "DELETE", etag: `"\$\{photo\.rowVersion\}"`/);
  assert.match(css, /\.contact-photo-remove/);
  assert.match(script, /const journalBased = sourceJournal !== null/);
  assert.match(html, /事業所からの連絡 <em>必須<\/em>/);
  assert.match(script, /familyMessage: "", requestSummary, facilityReply/);
  assert.doesNotMatch(script, /form\.elements\.familyMessage/);
  assert.match(script, /function journalContactSourceText\(/);
  assert.match(script, /支援記録を保存しました。/);
  assert.doesNotMatch(script, /text: "連絡帳を作成"/);
  assert.doesNotMatch(script, /openContactDraftFromJournal\(createContactButton, journal\)/);
  assert.match(script, /function deleteJournal\(/);
  assert.match(script, /function deleteContactEntry\(/);
  assert.match(script, /text: "削除"/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /操作履歴は保存されます。/);
  assert.match(script, /"daily_log\.deleted": "日誌を削除"/);
  assert.match(script, /"contact_book\.deleted": "連絡帳を削除"/);
  assert.match(script, /daily-logs\/\$\{encodeURIComponent\(journalId\)\}/);
  assert.match(script, /支援記録を変更しました。/);
  assert.match(html, /活動・場面 <em>必須<\/em>/);
  assert.match(script, /\/guardians/);
  assert.match(script, /function openGuardianEdit\(/);
  assert.match(script, /保護者・連絡先を変更しました。/);
  assert.match(script, /updateJournalCharacterCount/);
  assert.match(script, /function saveJournalDraft/);
  assert.match(script, /journal\.status === "draft"/);
  assert.match(script, /updateContactReplyCharacterCount/);
  assert.doesNotMatch(script, /updateRequestSummaryCharacterCount|generateRequestSummary|contact_request_summary/);
  assert.match(script, /writing-assist/);
  assert.match(script, /整えています/);
  assert.match(script, /const WRITING_TARGET_MIN = 80/);
  assert.match(script, /const WRITING_TARGET_MAX = 800/);
  assert.match(script, /function installCustomTargetLength\(/);
  assert.match(script, /function createWritingDisclosure\(/);
  assert.match(script, /任意の目標文字数は\$\{WRITING_TARGET_MIN\}〜\$\{WRITING_TARGET_MAX\}字で入力してください。/);
  assert.match(css, /\.writing-disclosure \{/);
  assert.match(css, /\.journal-disclosure-tools/);
  assert.match(css, /\.journal-writing-tools \.writing-custom-target-length/);
});

test("ブラウザ内を正本にせず認証済みAPIとCSRF・ETagで保存する", () => {
  assert.doesNotMatch(script, /localStorage|indexedDB/);
  assert.match(script, /window\.sessionStorage/);
  assert.match(script, /api\("\/session"\)/);
  assert.match(script, /api\("\/facilities"\)/);
  assert.match(script, /X-CSRF-Token/);
  assert.match(script, /If-Match/);
  assert.match(script, /Idempotency-Key/);
  assert.match(script, /crypto\.randomUUID\(\)/);
  assert.match(script, /pendingCreationKeys/);
  assert.match(script, /response\.status === 401/);
  assert.match(script, /response\.status === 409/);
  assert.match(script, /if \(!options\.suppressConflictDialog\) showConflict\(error\);/);
  assert.match(script, /setSaveState\("saving"\)/);
  assert.match(script, /setSaveState\("saved"\)/);
  assert.match(script, /setSaveState\("offline"\)/);
  assert.match(script, /fetch\("\/auth\/logout"/);
  assert.match(script, /"X-CSRF-Token": state\.session\?\.csrfToken/);
  assert.match(script, /window\.location\.assign\(logoutUrl\.toString\(\)\)/);
});

test("編集権限がない操作は非活性化ではなくDOMから除外する", () => {
  assert.match(script, /else control\.remove\(\)/);
  assert.match(script, /ROLE_PERMISSIONS/);
  assert.match(html, /permission-edit-clients/);
  assert.match(html, /permission-edit-journals/);
  assert.match(html, /permission-edit-documents/);
  assert.match(html, /permission-manage-staff/);
  assert.match(html, /permission-manage-tenant/);
  assert.match(html, /permission-view-audit/);
});

test("職員・事業所・監査管理と文書の正式工程を実APIへ接続する", () => {
  assert.match(html, /id="staff-invite-form"/);
  assert.match(html, /id="facility-create-form"/);
  assert.match(html, /id="audit-list"/);
  assert.match(html, /id="workflow-dialog"/);
  assert.match(html, /id="transition-consent-fields"/);
  assert.match(html, /id="transition-distribution-fields"/);
  assert.match(script, /api\("\/staff"\)/);
  assert.match(script, /\/invitation-resends/);
  assert.match(script, /招待メールを再送/);
  assert.match(script, /idempotentCreate\("\/facilities"/);
  assert.match(script, /api\("\/audit-events\?limit=30"\)/);
  assert.match(script, /\/transitions/);
  assert.match(script, /\/consent-intents/);
  assert.match(script, /expectedSourceHash: state\.consentIntent\.sourceHash/);
  assert.match(script, /documentRowVersion: state\.consentIntent\.documentRowVersion/);
  assert.match(script, /LAST_TENANT_ADMIN/);
});

test("保存済みの書類ではPDFを一つだけ出力・参照する", () => {
  assert.match(script, /DRAFT_PDF_STATUSES = Object\.freeze\(\["draft", "internal_review", "explanation_pending", "consented"\]\)/);
  assert.match(script, /OFFICIAL_PDF_STATUSES = Object\.freeze\(\["approved", "distributed", "active", "superseded", "closed"\]\)/);
  assert.match(script, /viewer: COMMON_PERMISSIONS/);
  assert.match(script, /function appendDocumentPdfAction\(/);
  assert.match(script, /document-item--compact/);
  assert.match(script, /kind === "consultation_plan" \|\| kind === "basic_assessment" \? \[\] : \[element\("p", \{ className: "document-workflow-copy"/);
  assert.doesNotMatch(script, /支援の記録を下書きの候補として反映しています。/);
  assert.doesNotMatch(script, /kind === "consultation_plan" \? "登録済みの参考資料" : `第\$\{documentRecord\.versionNumber\}版`/);
  assert.match(script, /PDF_LAYOUT_TEMPLATE_VERSIONS/);
  assert.match(script, /coco-assessment-v2/);
  assert.match(script, /basic_assessment: "coco-assessment-v2"/);
  assert.match(script, /individual_support_plan: "coco-individual-plan-v2"/);
  assert.match(script, /specialized_support_plan: "coco-specialized-plan-v2"/);
  assert.match(script, /body: \{ templateVersion: requiredVersion \}/);
  assert.match(script, /documentRecord\.documentKind !== "consultation_plan"/);
  assert.match(script, /snapshot\.snapshotKind === snapshotKind/);
  assert.match(script, /snapshot\.documentRowVersion/);
  assert.match(script, /\/documents\/\$\{encodeURIComponent\(outputDocument\.id\)\}\/pdf/);
  assert.match(script, /\/documents\/\$\{documentId\}\/snapshots/);
  assert.match(script, /\{ snapshotKind \}/);
  assert.match(script, /\{ etag: `"\$\{outputDocument\.rowVersion\}"` \}/);
  assert.match(script, /target: "_blank", rel: "noopener noreferrer"/);
  assert.match(script, /className: "pdf-action-error"[^\n]+role: "alert"/);
  assert.match(script, /PDF_RENDER_FAILED/);
  assert.match(script, /この内容のPDFはすでにあります/);
  assert.match(script, /内容が更新されています。最新の内容を読み込んでから/);
  assert.match(script, /DOCUMENT_STORAGE_UNAVAILABLE/);
  assert.doesNotMatch(script, /storageKey|sha256|generatedBy/);
});

test("個別支援計画は下書きの元データを編集してからPDFを作り直せる", () => {
  assert.match(html, /id="plan-editor-dialog"/);
  assert.match(html, /name="overallSupportPolicy"/);
  assert.match(html, /id="plan-editor-goals"/);
  assert.match(script, /EDITABLE_DOCUMENT_STATUSES = Object\.freeze\(\["draft", "internal_review", "explanation_pending"\]\)/);
  assert.match(script, /function openPlanEditor\(/);
  assert.match(script, /function submitPlanEditor\(/);
  assert.match(script, /function planDraftValuesFromAssessment\(/);
  assert.match(script, /function installPlanWritingTools\(/);
  assert.match(script, /kind: "individual_support_plan"/);
  assert.match(script, /dataset\.planLength/);
  assert.match(script, /const planIsEmpty = INDIVIDUAL_PLAN_PAYLOAD_FIELDS\.every/);
  assert.match(script, /計画書を保存しました。必要に応じてPDFを作成してください。/);
  assert.match(script, /\/documents\/\$\{encodeURIComponent\(documentId\)\}\/goals\/\$\{encodeURIComponent\(goalCard\.dataset\.goalId\)\}/);
});

test("アセスメントは下書きの面談内容を編集してから個別支援計画へ進める", () => {
  assert.match(html, /id="assessment-editor-dialog"/);
  assert.match(html, /name="childWishes"/);
  assert.match(html, /name="healthManagement"/);
  assert.match(html, /name="supportConsiderations"/);
  assert.match(script, /kind === "basic_assessment" && can\("documents\.edit"\)/);
  assert.match(script, /function openAssessmentEditor\(/);
  assert.match(script, /function submitAssessmentEditor\(/);
  assert.match(script, /ASSESSMENT_EDITOR_FIELDS/);
  assert.match(script, /function installAssessmentWritingTools\(/);
  assert.match(script, /kind: "basic_assessment"/);
  assert.match(script, /dataset\.assessmentLength/);
  assert.match(script, /ASSESSMENT_SYNTHESIS_FIELDS/);
  assert.match(script, /入力内容から下書きを作る/);
  assert.match(script, /function assessmentWritingSourceText\(/);
  assert.match(script, /"overallAssessment", "supportConsiderations"/);
  assert.match(script, /payload\.assessment = assessment/);
  assert.match(script, /アセスメントを保存しました。内容を確認してから、個別支援計画を作成してください。/);
});

test("フォーム・保存状態・競合ダイアログに主要なアクセシビリティ契約がある", () => {
  assert.match(html, /id="network-save-status" class="save-status" role="status" aria-live="polite"/);
  assert.match(html, /<dialog id="conflict-dialog"[^>]+aria-labelledby="conflict-title"[^>]+aria-describedby="conflict-description"/);
  assert.match(html, /id="child-register-form" novalidate/);
  assert.match(html, /id="journal-error" class="form-error" role="alert"/);
  assert.match(html, /id="contact-error" class="form-error" role="alert"/);
  assert.match(html, /id="guardian-error" class="form-error" role="alert"/);
  assert.doesNotMatch(html, /id="schedule-error" class="form-error" role="alert"/);
  assert.match(script, /field\.setAttribute\("aria-invalid", "true"\)/);
  assert.match(script, /field\.setAttribute\("aria-describedby"/);
  assert.match(script, /restoreDialogFocus/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 370px\)/);
  assert.match(css, /min-width: 320px/);
  assert.match(css, /prefers-reduced-motion/);
});

test("本番またはCognitoではルートにSaaS画面を返し、開発ではデモを保持する", async () => {
  const developmentApp = await buildApp({ config: appConfig(), pool: null, logger: false });
  const developmentRoot = await developmentApp.inject({ method: "GET", url: "/" });
  const explicitSaas = await developmentApp.inject({ method: "GET", url: "/saas.html" });
  assert.match(developmentRoot.body, /個別支援計画ワークベンチ/);
  assert.match(explicitSaas.body, /id="app-shell"/);
  await developmentApp.close();

  const cognitoApp = await buildApp({
    config: appConfig({
      authMode: "cognito",
      cookieSecret: "test-cookie-secret-that-is-long-enough",
      cognito: { sessionTtlSeconds: 43_200 },
    }),
    cognitoAuth: {
      beginLogin() { throw new Error("not called"); },
      async completeLogin() { throw new Error("not called"); },
      async logout() {},
    },
    authenticateRequest: async () => appConfig().devActor,
    pool: null,
    logger: false,
  });
  const cognitoRoot = await cognitoApp.inject({ method: "GET", url: "/" });
  const cognitoDemo = await cognitoApp.inject({ method: "GET", url: "/index.html" });
  assert.match(cognitoRoot.body, /id="app-shell"/);
  assert.equal(cognitoDemo.statusCode, 404);
  await cognitoApp.close();
});
