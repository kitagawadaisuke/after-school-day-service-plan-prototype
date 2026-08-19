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

test("SaaSシェルはセッション・所属・利用児を起点にした業務ランドマークを備える", () => {
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<a class="skip-link" href="#main-content">/);
  assert.match(html, /<aside class="sidebar" aria-label="主な機能">/);
  assert.match(html, /<nav class="primary-nav" aria-label="業務メニュー">/);
  assert.match(html, /<main id="main-content" tabindex="-1">/);
  assert.match(html, /id="facility-select" aria-label="表示する事業所"/);
  assert.match(html, /id="staff-name"/);
  assert.match(html, /id="staff-role"/);
  assert.match(html, /id="logout-button"[^>]+type="button">ログアウト/);
  assert.match(html, /職員・事業所設定/);
  assert.doesNotMatch(html, /<button class="admin-nav permission-view-admin"/);
  assert.doesNotMatch(html, /この事業所の記録/);
  assert.doesNotMatch(html, /記録は法人ごとに分離/);
  assert.match(html, /id="child-search-input" type="search"/);
});

test("外部計画は任意の参考資料とし、事業所の計画だけを正式工程で扱う", () => {
  assert.match(html, /data-create-document="consultation_plan"/);
  assert.match(html, /data-generate-draft="basic_assessment"/);
  assert.match(html, /data-generate-draft="individual_support_plan"/);
  assert.match(html, /id="open-monitoring-generation"/);
  assert.match(html, /外部計画・参考資料/);
  assert.match(html, /参考資料を登録/);
  assert.match(html, /必要な場合だけ、計画づくりの参考として登録します。/);
  assert.match(html, /id="reference-plan-editor-dialog"/);
  assert.match(script, /kind === "individual_support_plan" && \(can\("documents\.edit"\)/);
  assert.match(html, /目標と支援内容を決め、日々の支援の基準にします。/);
  assert.match(script, /documentKind: kind/);
  assert.match(script, /targetDocumentKind: "basic_assessment"/);
  assert.match(script, /targetDocumentKind: "individual_support_plan"/);
  assert.match(script, /targetDocumentKind: "monitoring_record"/);
  assert.match(script, /assessmentButton\.disabled = !state\.selectedChild \|\| !finalizedCurrent/);
  assert.match(script, /individualButton\.disabled = !state\.selectedChild \|\| !assessment/);
  assert.match(html, /id="open-current-schedule-from-assessment"/);
  assert.match(script, /function openCurrentScheduleFromAssessment\(/);
  assert.match(script, /「現在の生活」を登録後、「この週間予定を確定」を選んでください。/);
  assert.match(script, /function openReferencePlanEditor\(/);
  assert.match(script, /次に作るアセスメントの候補に反映されます。/);
  assert.match(script, /PROGRESS_STATUS_LABELS/);
  assert.match(script, /未評価（根拠不足）/);
  assert.match(script, /要確認/);
  assert.match(script, /\/children\/\$\{encodeURIComponent\(state\.selectedChild\.id\)\}\/documents/);
});

test("保護者・受給者証・現在と計画後の週間予定を利用児台帳で扱う", () => {
  assert.match(html, /role="tablist" aria-label="利用児情報の種類"/);
  assert.match(html, /id="guardian-form" novalidate/);
  assert.match(html, /name="guardianId" type="hidden"/);
  assert.match(html, /id="guardian-save-button"/);
  assert.match(html, /name="recipientCertificateNumber"/);
  assert.match(html, /保存後は末尾4桁だけを表示/);
  assert.match(html, /name="municipalityName"/);
  assert.match(html, /name="copaymentLimitYen"/);
  assert.match(html, /id="current-schedule"/);
  assert.match(html, /id="planned-schedule"/);
  assert.doesNotMatch(html, /日をまたぐ予定/);
  assert.match(html, /duplicate-schedule-item/);
  assert.match(html, /data-journal-character-count="observation"/);
  assert.match(html, /id="save-journal-draft"[^>]+>下書き保存/);
  assert.match(html, /id="save-journal-final"[^>]+>記録を保存/);
  assert.match(html, /data-contact-reply-length/);
  assert.match(html, /返信文を整える/);
  assert.match(html, /支援時の引継ぎ/);
  assert.doesNotMatch(html, /data-request-summary-length|expand-request-summary/);
  assert.match(html, /目標文字数/);
  assert.match(script, /日誌を編集/);
  assert.match(script, /連絡帳を編集/);
  assert.match(script, /contact-book\/\$\{encodeURIComponent\(entryId\)\}/);
  assert.match(script, /連絡帳を変更しました/);
  assert.match(script, /daily-logs\/\$\{encodeURIComponent\(journalId\)\}/);
  assert.match(script, /日誌を変更しました/);
  assert.match(html, /活動・場面 <em>必須<\/em>/);
  assert.match(script, /\/guardians/);
  assert.match(script, /function openGuardianEdit\(/);
  assert.match(script, /保護者・連絡先を変更しました。/);
  assert.match(script, /scheduleKind=current/);
  assert.match(script, /scheduleKind=planned/);
  assert.match(script, /endMinute \+= 1440/);
  assert.match(script, /予定を複製しました/);
  assert.match(script, /updateJournalCharacterCount/);
  assert.match(script, /function saveJournalDraft/);
  assert.match(script, /journal\.status === "draft"/);
  assert.match(script, /updateContactReplyCharacterCount/);
  assert.doesNotMatch(script, /updateRequestSummaryCharacterCount|generateRequestSummary|contact_request_summary/);
  assert.match(script, /writing-assist/);
  assert.match(script, /整えています/);
});

test("ブラウザ内を正本にせず認証済みAPIとCSRF・ETagで保存する", () => {
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/);
  assert.match(script, /api\("\/session"\)/);
  assert.match(script, /api\("\/facilities"\)/);
  assert.match(script, /X-CSRF-Token/);
  assert.match(script, /If-Match/);
  assert.match(script, /Idempotency-Key/);
  assert.match(script, /crypto\.randomUUID\(\)/);
  assert.match(script, /pendingCreationKeys/);
  assert.match(script, /response\.status === 401/);
  assert.match(script, /response\.status === 409/);
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

test("権限と工程に応じて改変不能な帳票PDFを作成・参照する", () => {
  assert.match(script, /DRAFT_PDF_STATUSES = Object\.freeze\(\["draft", "internal_review", "explanation_pending", "consented"\]\)/);
  assert.match(script, /OFFICIAL_PDF_STATUSES = Object\.freeze\(\["approved", "distributed", "active", "superseded", "closed"\]\)/);
  assert.match(script, /viewer: \[\]/);
  assert.match(script, /if \(can\("pdf\.export"\)\) item\.append\(renderPdfPanel\(documentRecord\)\)/);
  assert.match(script, /\/documents\/\$\{encodeURIComponent\(documentRecord\.id\)\}\/pdf/);
  assert.match(script, /\/documents\/\$\{documentId\}\/snapshots/);
  assert.match(script, /\{ snapshotKind \}/);
  assert.match(script, /\{ etag: `"\$\{documentRecord\.rowVersion\}"` \}/);
  assert.match(script, /target: "_blank", rel: "noopener noreferrer"/);
  assert.match(script, /className: "pdf-error"[^\n]+role: "alert"/);
  assert.match(script, /PDF_RENDER_FAILED/);
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
  assert.match(script, /計画書を保存しました。必要に応じて確認用PDFを作成してください。/);
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
  assert.match(html, /id="schedule-error" class="form-error" role="alert"/);
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
