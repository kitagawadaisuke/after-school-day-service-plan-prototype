const API_BASE = "/api/v1";
const MAX_CONTACT_PHOTOS = 4;

const ROLE_LABELS = Object.freeze({
  tenant_admin: "職員",
  facility_admin: "職員",
  plan_approver: "職員",
  support_staff: "職員",
  viewer: "職員",
  auditor: "職員",
});

// 共同運用: 記録・計画は全員で編集し、職員や事業所の管理機能は表示しない。
const COMMON_PERMISSIONS = Object.freeze(["clients.edit", "journals.edit", "documents.edit", "documents.approve", "pdf.export"]);

const ROLE_PERMISSIONS = Object.freeze({
  tenant_admin: COMMON_PERMISSIONS,
  facility_admin: COMMON_PERMISSIONS,
  plan_approver: COMMON_PERMISSIONS,
  support_staff: COMMON_PERMISSIONS,
  viewer: COMMON_PERMISSIONS,
  auditor: COMMON_PERMISSIONS,
});

const DOCUMENT_KIND_LABELS = Object.freeze({
  consultation_plan: "参考資料",
  basic_assessment: "アセスメント",
  individual_support_plan: "個別支援計画",
  specialized_support_plan: "専門的支援計画",
  monitoring_record: "モニタリング",
});

const PROGRESS_STATUS_LABELS = Object.freeze({
  not_evaluated: "未評価（根拠不足）",
  needs_review: "要確認",
  improving: "改善傾向",
  maintained: "維持",
  mixed: "一部進展・一部課題",
  achieved: "達成",
});

const NEXT_GOAL_ACTION_LABELS = Object.freeze({ continue: "継続", revise: "見直し", complete: "完了" });
const STAFF_STATUS_LABELS = Object.freeze({ active: "利用中", suspended: "一時停止", ended: "終了" });
const SCHEDULE_STATUS_LABELS = Object.freeze({ draft: "編集中", finalized: "確定済み" });
const DAY_LABELS = Object.freeze(["日", "月", "火", "水", "木", "金", "土"]);
const DRAFT_PDF_STATUSES = Object.freeze(["draft", "internal_review", "explanation_pending", "consented"]);
const OFFICIAL_PDF_STATUSES = Object.freeze(["approved", "distributed", "active", "superseded", "closed"]);
const EDITABLE_DOCUMENT_STATUSES = Object.freeze(["draft", "internal_review", "explanation_pending"]);
const INDIVIDUAL_PLAN_PAYLOAD_FIELDS = Object.freeze([
  ["userAndFamilyWishes", "本人・家族の意向"],
  ["supportIssues", "支援課題"],
  ["childWishes", "本人の希望"],
  ["familyWishes", "保護者の希望"],
  ["overallSupportPolicy", "総合的な支援の方針"],
  ["consultationPlanBasis", "相談支援計画とのつながり"],
  ["supportConsiderations", "支援上の留意事項"],
  ["serviceDelivery", "標準的な支援方法"],
  ["coordination", "家族・関係機関との連携"],
  ["monitoringPlan", "モニタリングの時期・方法"],
  ["explanationNotes", "説明・同意時の確認事項"],
  ["specializedGoal", "目指すべき達成目標"],
  ["specializedSupportTarget", "専門的支援の目標"],
  ["specializedSupportContent", "活動プログラム"],
  ["specializedTargetDate", "達成時期"],
  ["specializedFiveDomains", "5領域"],
]);
const INDIVIDUAL_PLAN_FIELD_LABELS = Object.freeze(Object.fromEntries(INDIVIDUAL_PLAN_PAYLOAD_FIELDS));
// 帳票上の固定欄。支援目標を未登録でも、指定帳票の各行を直接編集できるようにする。
const PLAN_TEMPLATE_FIELDS = Object.freeze([
  "longTermGoal", "shortTermGoal",
  "supportGoal1", "supportContent1", "supportTargetDate1", "supportFiveDomains1",
  "supportGoal2", "supportContent2", "supportTargetDate2", "supportFiveDomains2",
  "supportGoal3", "supportContent3", "supportTargetDate3", "supportFiveDomains3",
  "supportGoal4", "supportContent4", "supportTargetDate4", "supportFiveDomains4",
  "weeklyMonday", "weeklyTuesday", "weeklyWednesday", "weeklyThursday", "weeklyFriday", "weeklySaturday", "weeklySunday", "weeklySchoolHoliday", "weeklyNotes",
]);
const MONITORING_TEMPLATE_FIELDS = Object.freeze([
  "supportIssues", "childWishes", "familyWishes", "longTermGoal", "shortTermGoal", "overallEvaluation", "nextPlanDirection", "remarks",
  "monitoringSupportGoal1", "monitoringSupportContent1", "monitoringProgress1", "monitoringChange1", "monitoringNotes1",
  "monitoringSupportGoal2", "monitoringSupportContent2", "monitoringProgress2", "monitoringChange2", "monitoringNotes2",
  "monitoringSupportGoal3", "monitoringSupportContent3", "monitoringProgress3", "monitoringChange3", "monitoringNotes3",
  "monitoringSupportGoal4", "monitoringSupportContent4", "monitoringProgress4", "monitoringChange4", "monitoringNotes4",
]);
const ASSESSMENT_EDITOR_FIELDS = Object.freeze([
  ["childWishes", "personWish"],
  ["familyWishes", "familyWish"],
  ["concerns", null],
  ["desiredLife", null],
  ["healthManagement", null],
  ["movementSensory", null],
  ["cognitionBehavior", null],
  ["languageCommunication", null],
  ["relationshipsSocial", null],
  ["familySituation", null],
  ["strengths", "strengths"],
  ["priorityNeeds", "needs"],
  ["overallAssessment", null],
  ["supportConsiderations", "supportDirection"],
  ["medicalSafetyNotes", null],
  ["supportNetwork", null],
  ["planningNotes", "planningNotes"],
]);
const ASSESSMENT_FIELD_LABELS = Object.freeze({
  childWishes: "本人の願い", familyWishes: "家族の願い", concerns: "困りごと・相談内容", desiredLife: "望む生活のイメージ",
  healthManagement: "生活・健康", movementSensory: "運動・感覚", cognitionBehavior: "認知・行動", languageCommunication: "言語・コミュニケーション",
  relationshipsSocial: "人間関係・社会性", familySituation: "家族・生活環境", strengths: "強み・好きなこと", priorityNeeds: "優先して支援する課題",
  overallAssessment: "総合的なアセスメント", supportConsiderations: "支援で大切にすること", medicalSafetyNotes: "医療・安全上の留意事項",
  supportNetwork: "連携先と役割", planningNotes: "個別支援計画へ引き継ぐこと",
});
const ASSESSMENT_TEMPLATE_FIELDS = Object.freeze([
  "dailyMeal", "dailyDressing", "dailyToileting", "dailyBathing", "dailySleep", "scheduleManagement", "schoolClass", "learning",
  "socialUnderstanding", "environmentAdaptation", "friendRelationships", "publicBehavior", "speaksIndependently", "listensToOthers", "hobbies", "lessons",
  "familyCareerPath", "childCareerPath", "supportNotes", "favoriteFood", "dislikedFood", "favoriteSnack", "drinks", "favoritePlay", "difficultPlay",
  "favoriteCharacter", "difficultCharacter", "favoriteThings", "sleepPattern", "favoriteOutings", "difficultOutings", "outingNotes", "outsideNotes",
  "otherServices", "desiredServiceDays",
]);
const ASSESSMENT_CONTEXT_FIELDS = Object.freeze(ASSESSMENT_EDITOR_FIELDS.slice(0, 12).map(([fieldName]) => fieldName));
const ASSESSMENT_SYNTHESIS_FIELDS = Object.freeze(new Set([
  "overallAssessment", "supportConsiderations",
]));
const REFERENCE_PLAN_PAYLOAD_FIELDS = Object.freeze([
  "referenceMemo",
]);
const REFERENCE_PLAN_FIELD_LABELS = Object.freeze({
  referenceMemo: "メモ",
});

const WORKFLOW_ACTIONS = Object.freeze({
  submit: { label: "内部確認へ提出", description: "下書きを内部確認へ提出します。" },
  return: { label: "差し戻す", description: "理由を添えて、修正できる工程へ戻します。" },
  explain: { label: "説明へ進む", description: "本人・家族への説明待ちに進めます。" },
  consent: { label: "説明・同意を記録", description: "説明した日時と、同意者を正式に記録します。" },
  approve: { label: "承認する", description: "同意済みの内容を承認します。" },
  distribute: { label: "交付を記録", description: "本人・家族へ交付した事実を記録します。" },
  activate: { label: "運用を開始", description: "交付済みの計画を運用中にします。" },
  supersede: { label: "次版へ更新", description: "新しい版へ引き継ぐため、この版を更新済みにします。" },
  close: { label: "運用を終了", description: "理由を添えて、この計画の運用を終了します。" },
  void: { label: "無効にする", description: "誤登録などの理由を添えて無効にします。" },
});

const WORKFLOW_EVENT_LABELS = Object.freeze({
  submitted: "内部確認へ提出", returned: "差し戻し", explained: "説明工程へ移動", consented: "説明・同意を記録", approved: "承認", distributed: "交付を記録", activated: "運用開始", superseded: "次版へ更新", closed: "運用終了", voided: "無効化",
});

const DOCUMENT_STATUS_LABELS = Object.freeze({
  draft: "作成中",
  internal_review: "内部確認中",
  explanation_pending: "説明待ち",
  consented: "同意済み",
  approved: "承認済み",
  distributed: "交付済み",
  active: "運用中",
  superseded: "更新済み",
  closed: "終了",
  void: "無効",
});

const FIVE_DOMAIN_LABELS = Object.freeze({
  health_life: "健康・生活",
  motor_sensory: "運動・感覚",
  cognition_behavior: "認知・行動",
  language_communication: "言語・コミュニケーション",
  human_relations_sociality: "人間関係・社会性",
});

const state = {
  session: null,
  facilities: [],
  facilityId: null,
  children: [],
  selectedChild: null,
  selectedChildEtag: null,
  journals: [],
  contactEntries: [],
  documents: [],
  documentDetails: new Map(),
  documentSnapshots: new Map(),
  pdfErrors: new Map(),
  pdfMessages: new Map(),
  monitoringResults: [],
  guardians: [],
  schedules: { current: null, planned: null },
  childPanel: "basic",
  staff: [],
  auditEvents: [],
  workflow: null,
  workflowEtag: null,
  consentIntent: null,
  conflictReload: null,
  pendingCreationKeys: new Map(),
  activeView: "child",
  dialogTriggers: new Map(),
  conflictResumeDialog: null,
};

function selectedChildStorageKey() {
  const tenantId = state.session?.tenant?.id;
  const userId = state.session?.user?.id;
  return tenantId && userId ? `michinote:last-selected-child:${tenantId}:${userId}` : null;
}

function rememberedChildSelection() {
  const key = selectedChildStorageKey();
  if (!key) return null;
  try {
    const remembered = JSON.parse(window.sessionStorage.getItem(key) || "null");
    if (typeof remembered?.facilityId !== "string" || typeof remembered?.childId !== "string") return null;
    return remembered;
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

function rememberSelectedChild(childId) {
  const key = selectedChildStorageKey();
  if (!key || !state.facilityId || !childId) return;
  window.sessionStorage.setItem(key, JSON.stringify({ facilityId: state.facilityId, childId }));
}

function forgetSelectedChild() {
  const key = selectedChildStorageKey();
  if (key) window.sessionStorage.removeItem(key);
}

function recentChildrenStorageKey() {
  const tenantId = state.session?.tenant?.id;
  const userId = state.session?.user?.id;
  return tenantId && userId && state.facilityId ? `michinote:recent-children:${tenantId}:${userId}:${state.facilityId}` : null;
}

function rememberedRecentChildIds() {
  const key = recentChildrenStorageKey();
  if (!key) return [];
  try {
    const childIds = JSON.parse(window.sessionStorage.getItem(key) || "[]");
    return Array.isArray(childIds) ? childIds.filter((childId) => typeof childId === "string").slice(0, 5) : [];
  } catch {
    window.sessionStorage.removeItem(key);
    return [];
  }
}

function rememberRecentChild(childId) {
  const key = recentChildrenStorageKey();
  if (!key || !childId) return;
  const childIds = [childId, ...rememberedRecentChildIds().filter((id) => id !== childId)].slice(0, 5);
  window.sessionStorage.setItem(key, JSON.stringify(childIds));
}

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `通信に失敗しました（${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.error?.code || "REQUEST_FAILED";
    this.details = payload?.error?.details || null;
  }
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function element(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value !== null && value !== undefined) node.setAttribute(name, String(value));
  }
  return node;
}

function appendDefinition(list, label, value, options = {}) {
  const wrapper = element("div", { className: [options.wide ? "wide" : "", options.className || ""].filter(Boolean).join(" ") });
  const displayValue = value === undefined || value === null || value === "" ? "未入力" : value;
  const isEmpty = displayValue === "未入力";
  wrapper.append(
    element("dt", { text: label }),
    element("dd", { className: isEmpty ? "is-empty" : "", text: displayValue }),
  );
  list.append(wrapper);
}

function formatDate(value, includeTime = false) {
  if (!value) return "未入力";
  const source = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", includeTime
    ? { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function certificateExpiryStatus(validTo) {
  if (!validTo) return { text: "未入力", className: "certificate-expiry-missing" };
  const expiresOn = new Date(`${validTo}T00:00:00`);
  if (Number.isNaN(expiresOn.getTime())) return { text: validTo, className: "certificate-expiry-missing" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysRemaining = Math.round((expiresOn.getTime() - today.getTime()) / 86_400_000);
  if (daysRemaining < 0) return { text: `${formatDate(validTo)}（期限切れ）`, className: "certificate-expiry-expired" };
  if (daysRemaining <= 30) return { text: `${formatDate(validTo)}（期限まであと${daysRemaining}日）`, className: "certificate-expiry-soon" };
  return { text: `${formatDate(validTo)}（有効）`, className: "certificate-expiry-valid" };
}

function formatAddress(address = {}) {
  const postal = address.postalCode ? `〒${address.postalCode}` : "";
  return [postal, address.prefecture, address.city, address.line1, address.line2].filter(Boolean).join(" ") || "未入力";
}

function can(permission) {
  return ROLE_PERMISSIONS[state.session?.user?.role]?.includes(permission) === true;
}

function setSaveState(nextState, label) {
  const status = $("#network-save-status");
  if (!status) return;
  const labels = {
    saving: "保存中",
    saved: "保存済み",
    synced: "同期済み",
    error: "保存エラー",
    offline: "オフライン",
    conflict: "競合を検出",
  };
  status.dataset.state = nextState;
  $("b", status).textContent = label || labels[nextState] || nextState;
}

function announce(message) {
  const region = $("#app-announcer");
  region.textContent = "";
  window.setTimeout(() => { region.textContent = message; }, 20);
}

function runAsync(operation) {
  Promise.resolve()
    .then(operation)
    .catch((error) => {
      if (error?.status !== 401 && error?.status !== 409) announce(errorMessage(error));
    });
}

function redirectToLogin() {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

async function logoutFromHostedSession() {
  const button = $("#logout-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": state.session?.csrfToken || "",
      },
    });
    const payload = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : null;
    if (!response.ok || typeof payload?.logoutUrl !== "string") {
      throw new Error("ログアウトを完了できませんでした。通信状況を確認して、もう一度お試しください。");
    }
    const logoutUrl = new URL(payload.logoutUrl);
    if (logoutUrl.protocol !== "https:") throw new Error("安全なログアウト先を確認できませんでした。");
    window.location.assign(logoutUrl.toString());
  } catch (error) {
    announce(error?.message || "ログアウトを完了できませんでした。");
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = new Headers({ Accept: "application/json", ...(options.headers || {}) });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (isMutation && state.session?.csrfToken) headers.set("X-CSRF-Token", state.session.csrfToken);
  if (options.etag) headers.set("If-Match", options.etag);
  if (isMutation) setSaveState("saving");

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    setSaveState(navigator.onLine ? "error" : "offline");
    throw new ApiError(0, { error: { code: "NETWORK_ERROR", message: "サーバーに接続できません。通信状況を確認してください。" } });
  }

  if (response.status === 401) {
    redirectToLogin();
    throw new ApiError(401, { error: { code: "UNAUTHENTICATED", message: "ログインが必要です。" } });
  }

  const hasJson = response.headers.get("content-type")?.includes("application/json");
  const payload = response.status === 204 ? null : hasJson ? await response.json() : null;
  if (!response.ok) {
    const error = new ApiError(response.status, payload);
    if (response.status === 409) {
      setSaveState("conflict");
      if (!options.suppressConflictDialog) showConflict(error);
    } else if (isMutation) {
      setSaveState("error");
      state.conflictReload = null;
    }
    throw error;
  }

  if (isMutation) setSaveState("saved");
  return { data: payload, etag: response.headers.get("etag") };
}

function creationFingerprint(path, body, etag = "") {
  return `${path}\n${etag}\n${JSON.stringify(body)}`;
}

async function idempotentCreate(path, body, options = {}) {
  const fingerprint = creationFingerprint(path, body, options.etag);
  const key = state.pendingCreationKeys.get(fingerprint) || crypto.randomUUID();
  state.pendingCreationKeys.set(fingerprint, key);
  try {
    const result = await api(path, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      etag: options.etag,
      body,
      suppressConflictDialog: options.suppressConflictDialog,
    });
    state.pendingCreationKeys.delete(fingerprint);
    return result;
  } catch (error) {
    // Only a network failure has an unknown server outcome. Reuse the key when
    // the user retries the same payload so a completed create cannot duplicate.
    if (error.status !== 0 && error.code !== "STAFF_INVITATION_DELIVERY_FAILED") {
      state.pendingCreationKeys.delete(fingerprint);
    }
    throw error;
  }
}

function openDialog(dialog, trigger) {
  if (!dialog || dialog.open) return;
  if (trigger) state.dialogTriggers.set(dialog.id, trigger);
  dialog.showModal();
  const first = $("[data-dialog-initial-focus], input:not([type='hidden']), select, textarea, button", dialog);
  window.requestAnimationFrame(() => first?.focus());
}

function closeDialog(dialog) {
  if (!dialog?.open) return;
  dialog.close();
}

function restoreDialogFocus(dialog) {
  const trigger = state.dialogTriggers.get(dialog.id);
  state.dialogTriggers.delete(dialog.id);
  if (trigger?.isConnected) trigger.focus();
}

function configureDialogs() {
  $$('dialog').forEach((dialog) => {
    dialog.addEventListener("close", () => restoreDialogFocus(dialog));
  });
  $$('[data-close-dialog]').forEach((button) => {
    button.addEventListener("click", () => closeDialog(document.getElementById(button.dataset.closeDialog)));
  });
}

function applyPermissions() {
  const controls = [
    [".permission-edit-clients", "clients.edit"],
    [".permission-edit-journals", "journals.edit"],
    [".permission-edit-documents", "documents.edit"],
    [".permission-approve-documents", "documents.approve"],
    [".permission-manage-staff", "staff.manage"],
    [".permission-manage-tenant", "tenant.manage"],
    [".permission-view-audit", "audit.view"],
    [".permission-view-admin", "admin.view"],
  ];
  for (const [selector, permission] of controls) {
    $$(selector).forEach((control) => {
      if (can(permission)) {
        if (!control.matches("[data-page-view]")) control.hidden = false;
      }
      else control.remove();
    });
  }
}

function renderSession() {
  $("#staff-name").textContent = state.session.user.displayName || "職員";
  $("#staff-role").textContent = ROLE_LABELS[state.session.user.role] || state.session.user.role;
}

function renderFacilities() {
  const select = $("#facility-select");
  const sidebarFacilityName = $("#sidebar-facility-name");
  select.replaceChildren();
  const activeFacilities = state.facilities.filter((facility) => facility.status !== "inactive");
  if (!activeFacilities.length) {
    select.append(element("option", { text: "利用できる事業所がありません", attributes: { value: "" } }));
    select.disabled = true;
    if (sidebarFacilityName) sidebarFacilityName.textContent = "利用できる事業所がありません";
    return;
  }
  select.disabled = false;
  for (const facility of activeFacilities) {
    const option = element("option", { text: facility.name, attributes: { value: facility.id } });
    if (facility.id === state.facilityId) option.selected = true;
    select.append(option);
  }
  if (sidebarFacilityName) {
    sidebarFacilityName.textContent = activeFacilities.find((facility) => facility.id === state.facilityId)?.name
      || activeFacilities[0].name;
  }
}

function profilePhotoUrl(child) {
  if (!child?.profilePhotoUpdatedAt) return null;
  return `${API_BASE}/children/${encodeURIComponent(child.id)}/profile-photo?v=${encodeURIComponent(child.profilePhotoUpdatedAt)}`;
}

function renderProfilePhoto(container, child, className = "") {
  if (!container) return;
  container.replaceChildren();
  container.className = ["child-profile-photo", className].filter(Boolean).join(" ");
  const imageUrl = profilePhotoUrl(child);
  if (imageUrl) {
    const image = element("img", {
      attributes: {
        src: imageUrl,
        alt: `${child.displayName}さんの顔写真`,
      },
    });
    image.addEventListener("error", () => {
      container.replaceChildren(element("span", { text: child.displayName.slice(0, 1), attributes: { "aria-hidden": "true" } }));
    }, { once: true });
    container.append(image);
    return;
  }
  container.append(element("span", { text: child?.displayName?.slice(0, 1) || "児", attributes: { "aria-hidden": "true" } }));
}

function renderChildPicker() {
  const container = $("#child-picker-results");
  const recentContainer = $("#child-picker-recent");
  const recentSection = $("#child-picker-recent-section");
  const resultsTitle = $("#child-picker-results-title");
  const resultsCount = $("#child-picker-results-count");
  const query = $("#child-search-input").value.trim().toLocaleLowerCase("ja");
  const collator = new Intl.Collator("ja");
  const children = state.children.filter((child) => {
    const searchable = `${child.displayName} ${child.legalName} ${child.managementCode}`.toLocaleLowerCase("ja");
    return !query || searchable.includes(query);
  }).sort((left, right) => collator.compare(left.displayName, right.displayName));

  const renderOption = (child) => {
    const isCurrent = child.id === state.selectedChild?.id;
    const listItem = element("div", { attributes: { role: "listitem" } });
    const button = element("button", { className: `picker-option${isCurrent ? " is-current" : ""}`, attributes: { type: "button", "aria-current": isCurrent ? "true" : null } });
    const avatar = element("span", { className: "picker-avatar" });
    renderProfilePhoto(avatar, child, "picker-avatar");
    const copy = element("span", { className: "picker-option-copy" });
    const nameLine = element("span", { className: "picker-option-name" });
    nameLine.append(element("strong", { text: child.displayName }));
    if (isCurrent) nameLine.append(element("em", { className: "picker-current-badge", text: "選択中" }));
    copy.append(nameLine, element("small", { text: `${child.managementCode} ／ ${child.grade || "学年未入力"}` }));
    button.append(avatar, copy);
    button.addEventListener("click", () => runAsync(() => selectChild(child.id)));
    listItem.append(button);
    return listItem;
  };

  const recentChildren = rememberedRecentChildIds()
    .map((childId) => state.children.find((child) => child.id === childId))
    .filter(Boolean);
  recentContainer.replaceChildren(...recentChildren.map(renderOption));
  recentSection.hidden = Boolean(query) || !recentChildren.length;

  container.replaceChildren();
  resultsTitle.textContent = query ? "検索結果" : "すべての利用者";
  resultsCount.textContent = `${children.length}名`;
  if (!children.length) {
    container.append(element("p", { className: "picker-empty", text: query ? "一致する利用者はいません。" : "この事業所には利用者が登録されていません。" }));
    return;
  }
  container.append(...children.map(renderOption));
}

function updateSelectedChildChrome() {
  const child = state.selectedChild;
  $("#current-child-name").textContent = child?.displayName || "利用者を選択";
  $("#current-child-meta").textContent = child
    ? `${child.managementCode} ／ ${child.grade || "学年未入力"}`
    : "一覧から選んでください";
  renderChildDetail();
}

function renderChildProfilePhoto() {
  const child = state.selectedChild;
  renderProfilePhoto($("#child-profile-photo"), child);
  const canEdit = Boolean(child) && can("clients.edit");
  const changeButton = $("#change-child-photo-button");
  const removeButton = $("#remove-child-photo-button");
  if (changeButton) {
    changeButton.hidden = !canEdit;
    changeButton.textContent = child?.profilePhotoUpdatedAt ? "写真を変更" : "写真を登録";
  }
  if (removeButton) removeButton.hidden = !canEdit || !child?.profilePhotoUpdatedAt;
}

function renderChildDetail() {
  const container = $("#child-detail");
  const editButton = $("#edit-child-button");
  if (editButton) editButton.hidden = state.childPanel !== "basic" || !state.selectedChild || !can("clients.edit");
  renderChildProfilePhoto();
  container.replaceChildren();
  const child = state.selectedChild;
  if (!child) {
    container.className = "detail-sheet empty-state";
    container.append(element("strong", { text: "利用者が選択されていません" }), element("p", { text: "左側の「現在の利用者」から選択してください。" }));
    return;
  }
  container.className = "detail-sheet";
  const list = element("dl", { className: "detail-grid" });
  appendDefinition(list, "画面表示名", child.displayName);
  appendDefinition(list, "氏名", child.legalName);
  appendDefinition(list, "管理番号", child.managementCode);
  appendDefinition(list, "生年月日", formatDate(child.birthDate));
  appendDefinition(list, "学年", child.grade);
  appendDefinition(list, "性別", { male: "男性", female: "女性", other: "その他", not_stated: "回答しない" }[child.gender]);
  appendDefinition(list, "住所", formatAddress(child.address), { wide: true });
  appendDefinition(list, "電話番号", child.primaryPhone);
  appendDefinition(list, "障害・認定区分", child.disabilityCategory);
  appendDefinition(list, "受給者証番号", child.recipientCertificateMasked || "未入力");
  appendDefinition(list, "受給者証の有効開始日", formatDate(child.certificateValidFrom));
  const certificateExpiry = certificateExpiryStatus(child.certificateValidTo);
  appendDefinition(list, "受給者証の有効期限", certificateExpiry.text, { className: certificateExpiry.className });
  appendDefinition(list, "支給決定自治体", child.municipalityName);
  appendDefinition(list, "利用者負担上限月額", child.copaymentLimitYen === null || child.copaymentLimitYen === undefined ? "未入力" : `${new Intl.NumberFormat("ja-JP").format(child.copaymentLimitYen)}円`);
  appendDefinition(list, "医療・健康上の留意事項", child.medicalSummary, { wide: true });
  appendDefinition(list, "最終更新", formatDate(child.updatedAt, true), { wide: true });
  container.append(list);
}

function switchChildPanel(panel, trigger) {
  state.childPanel = panel;
  $$('[data-child-panel]').forEach((tab) => {
    const active = tab.dataset.childPanel === panel;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$('[data-child-tab-panel]').forEach((tabPanel) => {
    tabPanel.hidden = tabPanel.dataset.childTabPanel !== panel;
  });
  const editButton = $("#edit-child-button");
  if (editButton) editButton.hidden = panel !== "basic" || !state.selectedChild || !can("clients.edit");
  if (state.selectedChild && panel === "guardians") runAsync(loadGuardians);
  if (state.selectedChild && panel === "schedules") runAsync(loadSchedules);
  if (trigger) trigger.focus();
}

function renderGuardians() {
  const container = $("#guardian-list");
  container.replaceChildren();
  if (!state.selectedChild) return renderListEmpty(container, "利用者を選択してください");
  if (!state.guardians.length) return renderListEmpty(container, "保護者・連絡先はまだ登録されていません");
  container.className = "guardian-list";
  for (const guardian of state.guardians) {
    const card = element("article", { className: `guardian-card${guardian.isPrimary ? " is-primary" : ""}` });
    const heading = element("div", { className: "guardian-heading" });
    heading.append(element("h3", { text: guardian.legalName }), element("span", { text: guardian.relationship }));
    if (guardian.isPrimary) heading.append(element("strong", { className: "primary-contact-chip", text: "主連絡先" }));
    const details = element("dl");
    details.append(
      element("dt", { text: "電話" }), element("dd", { text: guardian.phone || "未入力" }),
      element("dt", { text: "メール" }), element("dd", { text: guardian.email || "未入力" }),
    );
    card.append(heading, details);
    if (can("clients.edit")) {
      const actions = element("div", { className: "guardian-actions" });
      const edit = element("button", { className: "button button-secondary", text: "編集", attributes: { type: "button" } });
      edit.addEventListener("click", () => openGuardianEdit(guardian, edit));
      actions.append(edit);
      if (!guardian.isPrimary) {
      const button = element("button", { className: "button button-ghost", text: "主連絡先にする", attributes: { type: "button" } });
      button.addEventListener("click", () => runAsync(() => makePrimaryGuardian(guardian, button)));
        actions.append(button);
      }
      card.append(actions);
    }
    container.append(card);
  }
}

async function loadGuardians() {
  if (!state.selectedChild) {
    state.guardians = [];
    renderGuardians();
    return;
  }
  const { data } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/guardians`);
  state.guardians = data.items || [];
  renderGuardians();
}

function openGuardianDialog(trigger) {
  if (!state.selectedChild) return announce("先に利用者を選択してください。");
  const form = $("#guardian-form");
  form.reset();
  $("#guardian-form-title").textContent = "保護者・連絡先を登録";
  $("#guardian-form-description").textContent = "連絡先は支援の確認に必要な範囲だけを登録してください。";
  $("#guardian-save-button").textContent = "登録する";
  clearFormError(form, $("#guardian-error"));
  openDialog($("#guardian-dialog"), trigger);
}

function openGuardianEdit(guardian, trigger) {
  const form = $("#guardian-form");
  form.reset();
  form.elements.guardianId.value = guardian.id;
  form.elements.rowVersion.value = guardian.rowVersion;
  form.elements.legalName.value = guardian.legalName || "";
  form.elements.relationship.value = guardian.relationship || "";
  form.elements.phone.value = guardian.phone || "";
  form.elements.email.value = guardian.email || "";
  form.elements.isPrimary.checked = Boolean(guardian.isPrimary);
  $("#guardian-form-title").textContent = "保護者・連絡先を編集";
  $("#guardian-form-description").textContent = "変更内容を保存すると、利用者情報の連絡先に反映されます。";
  $("#guardian-save-button").textContent = "変更を保存";
  clearFormError(form, $("#guardian-error"));
  openDialog($("#guardian-dialog"), trigger);
}

async function submitGuardian(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#guardian-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = {
    legalName: values.get("legalName").trim(),
    relationship: values.get("relationship").trim(),
    isPrimary: values.get("isPrimary") === "on",
  };
  for (const field of ["phone", "email"]) body[field] = values.get(field)?.trim() || null;
  const guardianId = values.get("guardianId");
  try {
    if (guardianId) {
      state.conflictResumeDialog = $("#guardian-dialog");
      state.conflictReload = loadGuardians;
      await api(`/children/${encodeURIComponent(state.selectedChild.id)}/guardians/${encodeURIComponent(guardianId)}`, {
        method: "PATCH",
        etag: `"${values.get("rowVersion")}"`,
        body,
      });
    } else {
      const createBody = { ...body };
      for (const field of ["phone", "email"]) if (!createBody[field]) delete createBody[field];
      await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/guardians`, createBody);
    }
    closeDialog($("#guardian-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadGuardians();
    announce(guardianId ? "保護者・連絡先を変更しました。" : "保護者・連絡先を登録しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function makePrimaryGuardian(guardian, button) {
  button.disabled = true;
  state.conflictReload = loadGuardians;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/guardians/${encodeURIComponent(guardian.id)}`, {
      method: "PATCH",
      etag: `"${guardian.rowVersion}"`,
      body: { isPrimary: true },
    });
    await loadGuardians();
    state.conflictReload = null;
    announce(`${guardian.legalName}さんを主連絡先にしました。`);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function formatClock(minute) {
  const normalized = minute % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function renderSchedule(kind) {
  const container = $(`#${kind}-schedule`);
  const schedule = state.schedules[kind];
  container.replaceChildren();
  container.className = "schedule-content";
  if (!state.selectedChild) return renderListEmpty(container, "利用者を選択してください");
  if (!schedule) {
    container.classList.add("empty-state");
    container.append(element("strong", { text: "週間予定は未登録です" }), element("p", { text: kind === "current" ? "現在の生活を登録すると、アセスメントの根拠にできます。" : "計画後に目指す生活を分けて登録できます。" }));
  } else {
    const meta = element("div", { className: "schedule-meta" });
    meta.append(
      element("span", { className: `status-chip status-${schedule.status}`, text: SCHEDULE_STATUS_LABELS[schedule.status] || schedule.status }),
      element("strong", { text: `第${schedule.versionNumber}版` }),
      element("span", { text: schedule.validFrom || schedule.validTo ? `${formatDate(schedule.validFrom)} 〜 ${formatDate(schedule.validTo)}` : "期間指定なし" }),
    );
    container.append(meta);
    if (schedule.summary) container.append(element("p", { className: "schedule-summary", text: schedule.summary }));
    const list = element("ol", { className: "schedule-item-list", attributes: { "aria-label": `${kind === "current" ? "現在の生活" : "計画後の生活"}の予定` } });
    for (const item of schedule.items || []) {
      const crossesMidnight = item.endMinute >= 1440;
      const row = element("li");
      row.append(
        element("span", { className: "schedule-day", text: `${DAY_LABELS[item.dayOfWeek]}曜` }),
        element("time", { text: `${formatClock(item.startMinute)}〜${crossesMidnight ? "翌日 " : ""}${formatClock(item.endMinute)}` }),
        element("strong", { text: item.activity }),
        element("span", { text: item.location || "場所未入力" }),
      );
      list.append(row);
    }
    if (list.childElementCount) container.append(list);
    else container.append(element("p", { className: "muted-copy", text: "概要のみ登録されています。" }));
  }
  if (can("documents.edit")) {
    const actions = element("div", { className: "schedule-actions" });
    const edit = element("button", { className: "button button-secondary", text: schedule?.status === "draft" ? "下書きを編集" : schedule ? "新しい版を作成" : "週間予定を登録", attributes: { type: "button" } });
    edit.addEventListener("click", () => openScheduleDialog(kind, edit));
    actions.append(edit);
    if (schedule?.status === "draft" && can("documents.approve")) {
      const finalize = element("button", { className: "button button-primary", text: "この週間予定を確定", attributes: { type: "button" } });
      finalize.addEventListener("click", () => runAsync(() => finalizeSchedule(kind, finalize)));
      actions.append(finalize);
    }
    container.append(actions);
  }
}

async function loadSchedules() {
  if (!state.selectedChild) {
    state.schedules = { current: null, planned: null };
    renderSchedule("current");
    renderSchedule("planned");
    return;
  }
  const childId = encodeURIComponent(state.selectedChild.id);
  const [currentList, plannedList] = await Promise.all([
    api(`/children/${childId}/schedules?scheduleKind=current`),
    api(`/children/${childId}/schedules?scheduleKind=planned`),
  ]);
  for (const [kind, result] of [["current", currentList], ["planned", plannedList]]) {
    const latest = result.data.items?.[0];
    if (!latest) {
      state.schedules[kind] = null;
      continue;
    }
    const detail = await api(`/children/${childId}/schedules/${encodeURIComponent(latest.id)}`);
    state.schedules[kind] = { ...detail.data, etag: detail.etag || `"${detail.data.rowVersion}"` };
  }
  renderSchedule("current");
  renderSchedule("planned");
  if (state.activeView === "documents") renderDocuments();
}

function scheduleItemFromRow(row) {
  const endMinute = minutesFromTime(row.querySelector('[name="endTime"]').value);
  return {
    dayOfWeek: Number(row.querySelector('[name="dayOfWeek"]').value),
    startMinute: minutesFromTime(row.querySelector('[name="startTime"]').value),
    endMinute: endMinute + (row.querySelector('[name="endDay"]').value === "next" ? 1440 : 0),
    activity: row.querySelector('[name="activity"]').value,
    location: row.querySelector('[name="location"]').value,
  };
}

function addScheduleItem(item = {}, previousRow = null) {
  const fragment = $("#schedule-item-template").content.cloneNode(true);
  const row = $(".schedule-item-row", fragment);
  row.querySelector('[name="dayOfWeek"]').value = String(item.dayOfWeek ?? 1);
  row.querySelector('[name="startTime"]').value = formatClock(item.startMinute ?? 540);
  row.querySelector('[name="endDay"]').value = (item.endMinute ?? 1020) >= 1440 ? "next" : "same";
  row.querySelector('[name="endTime"]').value = formatClock(item.endMinute ?? 1020);
  row.querySelector('[name="activity"]').value = item.activity || "";
  row.querySelector('[name="location"]').value = item.location || "";
  row.querySelector(".duplicate-schedule-item").addEventListener("click", () => {
    addScheduleItem(scheduleItemFromRow(row), row);
    row.nextElementSibling?.querySelector('[name="dayOfWeek"]')?.focus();
    announce("予定を複製しました。必要な箇所だけ変更して保存してください。");
  });
  row.querySelector(".remove-schedule-item").addEventListener("click", () => {
    row.remove();
    announce("予定を入力欄から削除しました。保存するまで確定しません。");
  });
  if (previousRow?.parentElement === $("#schedule-item-rows")) {
    previousRow.after(fragment);
  } else {
    $("#schedule-item-rows").append(fragment);
  }
}

function openScheduleDialog(kind, trigger) {
  const form = $("#schedule-form");
  const schedule = state.schedules[kind];
  form.reset();
  form.elements.scheduleKind.value = kind;
  $("#schedule-form-title").textContent = `${kind === "current" ? "現在の生活" : "計画後の生活"}を編集`;
  $("#schedule-form-description").textContent = schedule?.status === "draft" ? "編集中の版を更新します。" : schedule ? "確定済みの版を元に、新しい版を作ります。" : "最初の版を作ります。";
  form.elements.validFrom.value = schedule?.validFrom || "";
  form.elements.validTo.value = schedule?.validTo || "";
  form.elements.summary.value = schedule?.summary || "";
  $("#schedule-item-rows").replaceChildren();
  for (const item of schedule?.items || []) addScheduleItem(item);
  if (!schedule?.items?.length) addScheduleItem();
  clearFormError(form, $("#schedule-error"));
  openDialog($("#schedule-dialog"), trigger);
}

function scheduleBodyFromForm(form) {
  const values = new FormData(form);
  const body = { scheduleKind: values.get("scheduleKind"), items: [] };
  for (const field of ["validFrom", "validTo", "summary"]) {
    const value = values.get(field)?.trim();
    if (value) body[field] = value;
  }
  $$(".schedule-item-row", form).forEach((row, index) => {
    const startMinute = minutesFromTime(row.querySelector('[name="startTime"]').value);
    let endMinute = minutesFromTime(row.querySelector('[name="endTime"]').value);
    if (row.querySelector('[name="endDay"]').value === "next") endMinute += 1440;
    body.items.push({
      dayOfWeek: Number(row.querySelector('[name="dayOfWeek"]').value),
      startMinute,
      endMinute,
      activity: row.querySelector('[name="activity"]').value.trim(),
      location: row.querySelector('[name="location"]').value.trim() || undefined,
      sortOrder: index,
    });
  });
  return body;
}

async function submitSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#schedule-error");
  if (!validateForm(form, errorContainer)) return;
  const body = scheduleBodyFromForm(form);
  if (body.validFrom && body.validTo && body.validTo < body.validFrom) return showFormError(form, errorContainer, "終了日は開始日以降にしてください。", ["validTo"]);
  const invalidIndex = body.items.findIndex((item) => item.endMinute <= item.startMinute);
  if (invalidIndex >= 0) return showFormError(form, errorContainer, `${invalidIndex + 1}件目の終了時刻は開始時刻より後にしてください。`, []);
  const existing = state.schedules[body.scheduleKind];
  state.conflictResumeDialog = $("#schedule-dialog");
  state.conflictReload = loadSchedules;
  try {
    if (existing?.status === "draft") {
      const { scheduleKind: _kind, ...changes } = body;
      await api(`/children/${encodeURIComponent(state.selectedChild.id)}/schedules/${encodeURIComponent(existing.id)}`, { method: "PATCH", etag: existing.etag, body: changes });
    } else {
      await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/schedules`, body);
    }
    closeDialog($("#schedule-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadSchedules();
    announce(`${body.scheduleKind === "current" ? "現在の生活" : "計画後の生活"}を保存しました。`);
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function finalizeSchedule(kind, button) {
  const schedule = state.schedules[kind];
  if (!schedule || schedule.status !== "draft") return;
  if (!window.confirm("この週間予定を確定しますか？\n確定後は内容を直接編集できません。変更が必要な場合は、新しい版を作成します。")) return;
  button.disabled = true;
  state.conflictReload = loadSchedules;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/schedules/${encodeURIComponent(schedule.id)}/finalize`, { method: "POST", etag: schedule.etag });
    await loadSchedules();
    state.conflictReload = null;
    announce(`${kind === "current" ? "現在の生活" : "計画後の生活"}を確定しました。`);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function renderJournals() {
  const container = $("#journal-list");
  container.replaceChildren();
  if (!state.selectedChild) return renderListEmpty(container, "利用者を選択してください");
  if (!state.journals.length) return renderListEmpty(container, "日誌はまだ登録されていません", "最初の記録を登録すると、ここに時系列で表示されます。");
  container.className = "record-list";
  for (const journal of state.journals) {
    const item = element("article", { className: "record-item" });
    const date = element("div", { className: "record-date", text: formatDate(journal.occurredAt, true) });
    date.append(element("strong", { text: journal.activity }));
    const body = element("div", { className: "record-body" });
    body.append(element("h2", { text: journal.status === "draft" ? "下書き" : "支援の記録" }));
    if (journal.status === "draft") {
      body.append(element("p", { className: "record-draft-note", text: "入力途中の下書きです。内容を確認してから記録を保存してください。" }));
    }
    const details = element("dl");
    for (const [label, value] of [["観察した事実", journal.observation], ["行った支援", journal.supportProvided], ["本人の反応", journal.childResponse], ["健康上の連絡", journal.healthNote || "なし"]]) {
      details.append(element("dt", { text: label }), element("dd", { text: value }));
    }
    body.append(details);
    if (journal.fiveDomains?.length) {
      const tags = element("ul", { className: "tag-list", attributes: { "aria-label": "関連する5領域" } });
      journal.fiveDomains.forEach((domain) => tags.append(element("li", { text: FIVE_DOMAIN_LABELS[domain] || domain })));
      body.append(tags);
    }
    if (can("journals.edit")) {
      const actions = element("div", { className: "record-actions" });
      const createContactButton = element("button", { className: "button button-quiet", text: "連絡帳を作成", attributes: { type: "button" } });
      createContactButton.addEventListener("click", () => runAsync(() => openContactDraftFromJournal(createContactButton, journal)));
      const editButton = element("button", { className: "button button-quiet", text: journal.status === "draft" ? "続きを入力" : "編集", attributes: { type: "button" } });
      editButton.addEventListener("click", () => openJournalDialog(editButton, journal));
      const deleteButton = element("button", { className: "button button-danger", text: "削除", attributes: { type: "button" } });
      deleteButton.addEventListener("click", () => runAsync(() => deleteJournal(deleteButton, journal)));
      actions.append(createContactButton, editButton, deleteButton);
      body.append(actions);
    }
    item.append(date, body);
    container.append(item);
  }
}

function renderContactEntries() {
  const container = $("#contact-list");
  container.replaceChildren();
  if (!state.selectedChild) return renderListEmpty(container, "利用者を選択してください");
  if (!state.contactEntries.length) return renderListEmpty(container, "連絡帳はまだ登録されていません", "日誌から連絡帳を作成すると、ここに表示されます。");
  container.className = "record-list";
  for (const entry of state.contactEntries) {
    const item = element("article", { className: "record-item" });
    const date = element("div", { className: "record-date", text: formatDate(entry.entryDate) });
    date.append(element("strong", { text: entry.reflectedInSupport ? "支援へ反映済み" : "連絡記録" }));
    const body = element("div", { className: "record-body" });
    body.append(element("h2", { text: entry.requestSummary || "事業所からの連絡" }));
    const details = element("dl");
    if (entry.familyMessage) details.append(element("dt", { text: "連絡内容" }), element("dd", { text: entry.familyMessage }));
    if (entry.facilityReply) details.append(element("dt", { text: "事業所から" }), element("dd", { text: entry.facilityReply }));
    body.append(details);
    if (entry.photos?.length) body.append(renderContactPhotoGallery(entry));
    if (can("journals.edit")) {
      const actions = element("div", { className: "record-actions" });
      const editButton = element("button", { className: "button button-quiet", text: "編集", attributes: { type: "button" } });
      editButton.addEventListener("click", () => openContactDialog(editButton, entry));
      const deleteButton = element("button", { className: "button button-danger", text: "削除", attributes: { type: "button" } });
      deleteButton.addEventListener("click", () => runAsync(() => deleteContactEntry(deleteButton, entry)));
      actions.append(editButton, deleteButton);
      body.append(actions);
    }
    item.append(date, body);
    container.append(item);
  }
}

function contactPhotoPath(entryId, photoId) {
  return `${API_BASE}/children/${encodeURIComponent(state.selectedChild.id)}/contact-book/${encodeURIComponent(entryId)}/photos/${encodeURIComponent(photoId)}`;
}

function renderContactPhotoGallery(entry) {
  const gallery = element("div", { className: "contact-photo-gallery", attributes: { "aria-label": `${formatDate(entry.entryDate)}の様子の写真` } });
  for (const [index, photo] of entry.photos.entries()) {
    const link = element("a", {
      className: "contact-photo-thumbnail",
      attributes: { href: contactPhotoPath(entry.id, photo.id), target: "_blank", rel: "noopener", "aria-label": `${formatDate(entry.entryDate)}の様子の写真 ${index + 1}枚目を開く` },
    });
    const image = document.createElement("img");
    image.src = contactPhotoPath(entry.id, photo.id);
    image.alt = `${formatDate(entry.entryDate)}の様子 ${index + 1}枚目`;
    image.loading = "lazy";
    link.append(image);
    gallery.append(link);
  }
  return gallery;
}

async function deleteJournal(button, journal) {
  if (!window.confirm("この日誌を削除しますか？\n一覧からは表示されなくなりますが、操作履歴は保存されます。")) return;
  button.disabled = true;
  state.conflictReload = loadActiveResource;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/daily-logs/${encodeURIComponent(journal.id)}`, {
      method: "DELETE",
      etag: `"${journal.rowVersion}"`,
    });
    await loadActiveResource();
    state.conflictReload = null;
    announce("日誌を削除しました。");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function deleteContactEntry(button, entry) {
  if (!window.confirm("この連絡帳を削除しますか？\n一覧からは表示されなくなりますが、操作履歴は保存されます。")) return;
  button.disabled = true;
  state.conflictReload = loadActiveResource;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/contact-book/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
      etag: `"${entry.rowVersion}"`,
    });
    await loadActiveResource();
    state.conflictReload = null;
    announce("連絡帳を削除しました。");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function pdfKindForStatus(status) {
  if (DRAFT_PDF_STATUSES.includes(status)) return "draft";
  if (OFFICIAL_PDF_STATUSES.includes(status)) return "official";
  return null;
}

function formatBytes(byteSize) {
  const bytes = Number(byteSize);
  if (!Number.isFinite(bytes) || bytes < 0) return "サイズ不明";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
}

async function loadSnapshotsForDocument(documentRecord) {
  const childId = encodeURIComponent(state.selectedChild.id);
  const documentId = encodeURIComponent(documentRecord.id);
  const { data } = await api(`/children/${childId}/documents/${documentId}/snapshots`);
  state.documentSnapshots.set(documentRecord.id, data.items || []);
  state.pdfErrors.delete(documentRecord.id);
}

async function loadDocumentSnapshots(documents = state.documents) {
  state.documentSnapshots.clear();
  state.pdfErrors.clear();
  state.pdfMessages.clear();
  // A PDF is a single output action, not a work area or a history list.
  // Load only documents that can be output, and only use a snapshot matching
  // the currently saved version.
  const printableDocuments = documents.filter((documentRecord) => (
    documentRecord.documentKind !== "consultation_plan"
    && Boolean(pdfKindForStatus(documentRecord.status))
  ));
  if (!can("pdf.export") || !state.selectedChild || !printableDocuments.length) return;
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(4, printableDocuments.length) }, async () => {
    while (cursor < printableDocuments.length) {
      const documentRecord = printableDocuments[cursor];
      cursor += 1;
      try {
        await loadSnapshotsForDocument(documentRecord);
      } catch (error) {
        failed = true;
        state.documentSnapshots.set(documentRecord.id, []);
        state.pdfErrors.set(documentRecord.id, "作成済みPDFの一覧を読み込めませんでした。時間をおいて再度お試しください。");
      }
    }
  });
  await Promise.all(workers);
  if (failed) announce("印刷用PDFの情報を読み込めませんでした。時間をおいて再度お試しください。");
}

// A saved PDF is deliberately immutable.  When only the printable layout is
// renewed, move the document to the current layout revision before outputting
// it, so staff do not have to open and re-save their own content just to get a
// corrected form.
const PDF_LAYOUT_TEMPLATE_VERSIONS = Object.freeze({
  basic_assessment: "coco-assessment-v1",
  individual_support_plan: "coco-individual-plan-v1",
  specialized_support_plan: "coco-specialized-plan-v1",
  monitoring_record: "coco-monitoring-v1",
});

function requiredPdfTemplateVersion(documentRecord) {
  return PDF_LAYOUT_TEMPLATE_VERSIONS[documentRecord.documentKind] || null;
}

function needsPdfLayoutRefresh(documentRecord) {
  const requiredVersion = requiredPdfTemplateVersion(documentRecord);
  return Boolean(requiredVersion && documentRecord.templateVersion !== requiredVersion);
}

function appendDocumentPdfAction(actions, documentRecord) {
  const snapshotKind = pdfKindForStatus(documentRecord.status);
  if (!snapshotKind) return;
  const snapshots = state.documentSnapshots.get(documentRecord.id) || [];
  const currentSnapshot = snapshots.find((snapshot) => (
    snapshot.snapshotKind === snapshotKind
    && Number(snapshot.documentRowVersion) === Number(documentRecord.rowVersion)
  ));
  if (currentSnapshot && !needsPdfLayoutRefresh(documentRecord)) {
    const href = `${API_BASE}/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}/snapshots/${encodeURIComponent(currentSnapshot.id)}/content`;
    const link = element("a", { className: "button button-secondary", text: "PDFを開く", attributes: { href, target: "_blank", rel: "noopener noreferrer", "aria-label": "保存済みの内容をPDFで新しいタブに開く" } });
    link.append(element("span", { text: "↗", attributes: { "aria-hidden": "true" } }));
    actions.append(link);
  } else {
    const button = element("button", {
      className: "button button-secondary pdf-create-button",
      text: "PDFを出力",
      attributes: { type: "button" },
    });
    button.addEventListener("click", () => runAsync(() => createDocumentPdf(documentRecord, snapshotKind, button)));
    actions.append(button);
  }

  const error = state.pdfErrors.get(documentRecord.id);
  if (error) actions.append(element("span", { className: "pdf-action-error", text: error, attributes: { role: "alert" } }));
}

async function createDocumentPdf(documentRecord, snapshotKind, button) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const originalLabel = button.textContent;
  button.textContent = needsPdfLayoutRefresh(documentRecord) ? "帳票を更新しています…" : "PDFを出力しています…";
  state.pdfErrors.delete(documentRecord.id);
  state.pdfMessages.delete(documentRecord.id);
  state.conflictReload = loadDocuments;
  try {
    let outputDocument = documentRecord;
    const requiredVersion = requiredPdfTemplateVersion(documentRecord);
    if (requiredVersion && documentRecord.templateVersion !== requiredVersion) {
      const updated = await api(
        `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}`,
        {
          method: "PATCH",
          etag: `"${documentRecord.rowVersion}"`,
          body: { templateVersion: requiredVersion },
        },
      );
      outputDocument = updated.data;
      button.textContent = "PDFを出力しています…";
    }
    const { data: snapshot } = await idempotentCreate(
      `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(outputDocument.id)}/pdf`,
      { snapshotKind },
      { etag: `"${outputDocument.rowVersion}"` },
    );
    state.conflictReload = null;
    await loadDocuments();
    announce(snapshot?.reused ? "この内容のPDFはすでにあります。" : "PDFを出力しました。PDFを開いて確認できます。");
  } catch (error) {
    const message = error.status === 409
      ? "内容が更新されています。最新の内容を読み込んでから、もう一度PDFを出力してください。"
      : errorMessage(error);
    state.pdfErrors.set(documentRecord.id, message);
    renderDocuments();
    announce(message);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = originalLabel;
    }
  }
}

function renderDocuments() {
  renderDocumentLane("consultation_plan", $("#consultation-document-list"));
  renderDocumentLane("basic_assessment", $("#assessment-document-list"));
  renderDocumentLane("individual_support_plan", $("#individual-document-list"));
  renderDocumentLane("specialized_support_plan", $("#specialized-document-list"));
  renderDocumentLane("monitoring_record", $("#monitoring-document-list"));
  $$('[data-create-document]').forEach((button) => { button.disabled = !state.selectedChild; });
  const assessment = latestDocument("basic_assessment");
  const activePlan = latestDocument("individual_support_plan", (item) => item.status === "active");
  const assessmentButton = $('[data-generate-draft="basic_assessment"]');
  const individualButton = $('[data-generate-draft="individual_support_plan"]');
  const monitoringButton = $("#open-monitoring-generation");
  const monitoring = latestDocument("monitoring_record");
  if (assessmentButton) {
    assessmentButton.hidden = !can("documents.edit") || Boolean(assessment);
    assessmentButton.disabled = !state.selectedChild;
  }
  $("#assessment-document-controls").hidden = Boolean(assessment);
  if (individualButton) {
    individualButton.hidden = !can("documents.edit") || Boolean(latestDocument("individual_support_plan"));
    individualButton.disabled = !state.selectedChild || !assessment;
  }
  $("#individual-document-controls").hidden = Boolean(latestDocument("individual_support_plan"));
  if (monitoringButton) {
    monitoringButton.hidden = !can("documents.edit") || Boolean(monitoring);
    monitoringButton.disabled = !state.selectedChild || !activePlan;
  }
  $("#monitoring-document-controls").hidden = Boolean(monitoring);
  $("#assessment-readiness").hidden = Boolean(assessment);
  $("#individual-readiness").hidden = Boolean(latestDocument("individual_support_plan"));
  $("#monitoring-readiness").hidden = Boolean(monitoring);
  $("#assessment-readiness").textContent = !state.selectedChild
    ? "利用者を選択してください。"
    : latestDocument("monitoring_record")
      ? "前回モニタリングをもとに作成できます。"
      : "現在の情報をもとに作成できます。";
  $("#individual-readiness").textContent = !assessment
    ? "アセスメントを作成すると、ここから作成できます。"
    : "アセスメントをもとに作成できます。";
  $("#monitoring-readiness").textContent = activePlan
    ? "日誌・連絡帳をもとに作成できます。"
    : "運用中の個別支援計画が必要です。";
}

function renderDocumentLane(kind, container) {
  container.replaceChildren();
  container.hidden = false;
  const documents = state.documents
    .filter((documentRecord) => documentRecord.documentKind === kind)
    .filter((documentRecord) => kind !== "consultation_plan" || hasReferenceMaterialContent(documentRecord));
  if (!state.selectedChild) return renderListEmpty(container, "利用者を選択してください");
  if (kind === "consultation_plan" && !documents.length) {
    container.className = "document-list";
    container.hidden = true;
    return;
  }
  if (kind === "monitoring_record" && !documents.length && state.selectedChild) {
    container.className = "document-list";
    container.hidden = true;
    return;
  }
  if (!documents.length) return renderListEmpty(container, "登録された計画はありません");
  container.className = "document-list";
  for (const documentRecord of documents) {
    const item = element("article", { className: `document-item${kind === "consultation_plan" ? "" : " document-item--compact"}` });
    const statusLabel = kind === "consultation_plan"
      ? "登録済み"
      : documentRecord.status === "draft"
        ? null
        : (DOCUMENT_STATUS_LABELS[documentRecord.status] || documentRecord.status);
    item.append(
      ...(kind === "consultation_plan" ? [element("strong", { text: "登録済みの参考資料" })] : []),
      ...(statusLabel ? [element("span", { className: "status-chip", text: statusLabel })] : []),
      element("div", { className: "document-date-meta" }, [
        element("span", { text: `対象期間：${formatDate(documentRecord.periodStart)} 〜 ${formatDate(documentRecord.periodEnd)}` }),
        element("span", { text: `最終更新：${formatDate(documentRecord.updatedAt, true)}` }),
      ]),
    );
    const actions = element("div", { className: "document-actions" });
    const detail = state.documentDetails.get(documentRecord.id)?.data;
    if (kind === "consultation_plan") {
      const canEditReference = can("documents.edit") && EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status);
      const referenceAction = element("button", {
        className: "button button-secondary",
        text: canEditReference ? "内容を確認・編集" : "内容を確認",
        attributes: { type: "button" },
      });
      referenceAction.addEventListener("click", () => runAsync(() => (
        canEditReference
          ? openReferencePlanEditor(documentRecord, referenceAction)
          : openReferenceMaterialViewer(documentRecord, referenceAction)
      )));
      actions.append(referenceAction);
      if (can("documents.edit") && !["superseded", "closed", "void"].includes(documentRecord.status)) {
        const removeReference = element("button", { className: "button button-danger", text: "参考資料を削除", attributes: { type: "button" } });
        removeReference.addEventListener("click", () => runAsync(() => removeReferenceMaterial(documentRecord, removeReference)));
        actions.append(removeReference);
      }
    }
    if (kind === "basic_assessment" && can("documents.edit") && EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) {
      const edit = element("button", { className: "button button-primary", text: "編集する", attributes: { type: "button" } });
      edit.addEventListener("click", () => runAsync(() => openAssessmentEditor(documentRecord, edit)));
      actions.append(edit);
    }
    if (["individual_support_plan", "specialized_support_plan"].includes(kind) && can("documents.edit") && EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) {
      const edit = element("button", { className: "button button-primary", text: "編集する", attributes: { type: "button" } });
      edit.addEventListener("click", () => runAsync(() => openPlanEditor(documentRecord, edit)));
      actions.append(edit);
    }
    if (kind === "monitoring_record") {
      if (can("documents.edit") && EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) {
        const edit = element("button", { className: "button button-primary", text: "帳票を編集", attributes: { type: "button" } });
        edit.addEventListener("click", () => runAsync(() => openMonitoringEditor(documentRecord, edit)));
        actions.append(edit);
      }
      const results = documentRecord.id === latestDocument("monitoring_record")?.id ? state.monitoringResults : [];
      if (results.length) {
        const activePlan = latestDocument("individual_support_plan", (candidate) => candidate.status === "active");
        const activePlanDetail = activePlan ? state.documentDetails.get(activePlan.id)?.data : null;
        const resultList = element("ul", { className: "monitoring-result-list", attributes: { "aria-label": "目標ごとの評価" } });
        for (const result of results) {
          const goal = detail?.goals?.find((candidate) => candidate.id === result.goalId)
            || activePlanDetail?.goals?.find((candidate) => candidate.id === result.goalId);
          const resultItem = element("li");
          resultItem.append(
            element("strong", { text: goal?.title || "支援目標" }),
            element("span", { className: `evaluation-chip status-${result.progressStatus}`, text: PROGRESS_STATUS_LABELS[result.progressStatus] || result.progressStatus }),
          );
          if (can("documents.edit")) {
            const edit = element("button", { className: "button button-ghost", text: "評価を入力", attributes: { type: "button" } });
            edit.addEventListener("click", () => openMonitoringResult(documentRecord, result, goal, edit));
            resultItem.append(edit);
          }
          resultList.append(resultItem);
        }
        item.append(resultList);
      }
    }
    if (kind !== "consultation_plan" && can("pdf.export")) appendDocumentPdfAction(actions, documentRecord);
    if (actions.childElementCount) item.append(actions);
    container.append(item);
  }
}

function latestDocument(kind, predicate = () => true) {
  return state.documents
    .filter((item) => item.documentKind === kind && item.status !== "void" && predicate(item))
    .sort((left, right) => right.versionNumber - left.versionNumber)[0] || null;
}

function hasReferenceMaterialContent(documentRecord) {
  const detail = state.documentDetails.get(documentRecord.id)?.data;
  // 「資料」として一覧に出すのは、実際に添付されたファイルだけです。
  // 削除済みの記録は操作履歴に残しても、通常の資料一覧には表示しません。
  return documentRecord.status !== "void" && Array.isArray(detail?.attachments) && detail.attachments.length > 0;
}

function referenceAttachmentDownloadPath(documentId, attachmentId) {
  return `${API_BASE}/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentId)}/reference-materials/${encodeURIComponent(attachmentId)}/download`;
}

function renderReferenceAttachments(container, documentRecord, attachments = [], editable = false) {
  container.replaceChildren();
  if (!attachments.length) {
    container.append(element("p", { className: "reference-attachment-empty", text: "資料ファイルはまだ登録されていません。" }));
    return;
  }
  for (const attachment of attachments) {
    const item = element("article", { className: "reference-attachment-item" });
    const copy = element("div");
    copy.append(
      element("strong", { text: attachment.fileName }),
      element("small", { text: `${formatBytes(attachment.byteSize)} ／ ${formatDate(attachment.createdAt, true)}` }),
    );
    const actions = element("div", { className: "reference-attachment-actions" });
    const download = element("a", {
      className: "button button-secondary",
      text: "開く",
      attributes: {
        href: referenceAttachmentDownloadPath(documentRecord.id, attachment.id),
        target: "_blank",
        rel: "noopener",
      },
    });
    actions.append(download);
    if (editable) {
      const remove = element("button", { className: "button button-danger", text: "削除", attributes: { type: "button" } });
      remove.addEventListener("click", () => runAsync(() => deleteReferenceAttachment(documentRecord, attachment, remove)));
      actions.append(remove);
    }
    item.append(copy, actions);
    container.append(item);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("資料ファイルを読み込めませんでした。")), { once: true });
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) return reject(new Error("資料ファイルを読み込めませんでした。"));
      return resolve(dataUrl.slice(comma + 1));
    }, { once: true });
    reader.readAsDataURL(file);
  });
}

async function uploadReferenceAttachment(documentId, file) {
  if (file.size > 15 * 1024 * 1024) throw new Error("資料ファイルは15MB以下にしてください。");
  const supportedTypes = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);
  const extension = file.name.split(".").pop()?.toLowerCase();
  const inferredTypes = { pdf: "application/pdf", doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  const contentType = supportedTypes.has(file.type) ? file.type : inferredTypes[extension];
  if (!contentType) throw new Error("PDF、Word、Excel、PowerPoint形式の資料を選択してください。");
  const dataBase64 = await readFileAsBase64(file);
  return idempotentCreate(
    `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentId)}/reference-materials`,
    { fileName: file.name, contentType, dataBase64 },
  );
}

async function deleteReferenceAttachment(documentRecord, attachment, button) {
  if (!window.confirm(`「${attachment.fileName}」を削除しますか？\nアセスメント作成時の参考資料から外れます。`)) return;
  button.disabled = true;
  state.conflictReload = loadDocuments;
  try {
    await api(
      `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}/reference-materials/${encodeURIComponent(attachment.id)}`,
      { method: "DELETE", etag: `"${attachment.rowVersion}"` },
    );
    await loadDocuments();
    state.conflictReload = null;
    const detail = state.documentDetails.get(documentRecord.id)?.data;
    renderReferenceAttachments($("#reference-plan-attachments"), documentRecord, detail?.attachments || [], true);
    announce("参考資料ファイルを削除しました。");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function latestReferenceMaterial() {
  return state.documents
    .filter((documentRecord) => documentRecord.documentKind === "consultation_plan" && documentRecord.status !== "void")
    .sort((left, right) => right.versionNumber - left.versionNumber)
    .find((documentRecord) => hasReferenceMaterialContent(documentRecord)) || null;
}

function renderGenerationEvidence(detail) {
  const container = $("#generation-evidence");
  const evidenceDetails = $("#generation-evidence-details");
  if (evidenceDetails) evidenceDetails.hidden = !detail?.payload?.generation;
  container.replaceChildren();
  const heading = element("div");
  heading.append(element("p", { className: "eyebrow", text: "自動作成の根拠" }), element("h2", { attributes: { id: "generation-evidence-title" }, text: detail ? `${DOCUMENT_KIND_LABELS[detail.documentKind]} 第${detail.versionNumber}版` : "人が確認するための下書きです" }));
  container.append(heading);
  const generation = detail?.payload?.generation;
  if (!generation) {
    container.append(element("p", { text: "書類の「根拠を確認」から、参照件数と確認事項を開けます。" }));
    return;
  }
  const warning = element("p", { className: "review-warning", text: generation.humanReviewRequired === false ? "根拠の自動集計結果です。正式決定前に内容を確認してください。" : "要確認：この内容は下書きです。面談・専門職の判断を反映してから正式工程へ進めてください。" });
  container.append(warning);
  const labels = {
    guardians: "保護者", scheduleItems: "週間予定", consultationGoals: "相談支援計画の目標", previousMonitoringResults: "前回モニタリング", generatedGoalCandidates: "目標候補", activePlanGoals: "運用中の目標", dailyLogs: "日誌", contactBookEntries: "連絡帳", goalsWithoutEnoughEvidence: "根拠不足の目標",
  };
  const counts = element("dl", { className: "evidence-counts" });
  for (const [key, value] of Object.entries(generation.evidenceCounts || {})) {
    counts.append(element("div"));
    const row = counts.lastElementChild;
    row.append(element("dt", { text: labels[key] || key }), element("dd", { text: `${value}件` }));
  }
  if (counts.childElementCount) container.append(counts);
  const sourceCount = generation.sourceDocuments?.length || 0;
  container.append(element("p", { className: "evidence-source", text: `参照した前工程の書類：${sourceCount}件。根拠が少ない目標は「未評価（根拠不足）」、判断が必要な目標は「要確認」と表示します。` }));
}

function renderListEmpty(container, title, copy = "") {
  const baseClass = container.id.includes("document") ? "document-list"
    : container.id.includes("guardian") ? "guardian-list"
      : container.id.includes("staff") ? "staff-list"
        : container.id.includes("schedule") ? "schedule-content"
          : "record-list";
  container.className = `${baseClass} empty-state`;
  container.append(element("strong", { text: title }));
  if (copy) container.append(element("p", { text: copy }));
}

async function loadChildren() {
  if (!state.facilityId) {
    state.children = [];
    renderChildPicker();
    return;
  }
  const { data } = await api(`/children?facilityId=${encodeURIComponent(state.facilityId)}&status=active&limit=100`);
  state.children = data.items || [];
  renderChildPicker();
}

async function selectChild(childId, { announceSelection = true } = {}) {
  const { data, etag } = await api(`/children/${encodeURIComponent(childId)}`);
  state.selectedChild = data;
  state.selectedChildEtag = etag || `"${data.rowVersion}"`;
  state.journals = [];
  state.contactEntries = [];
  state.documents = [];
  state.documentDetails.clear();
  state.documentSnapshots.clear();
  state.pdfErrors.clear();
  state.monitoringResults = [];
  state.guardians = [];
  state.schedules = { current: null, planned: null };
  rememberSelectedChild(data.id);
  rememberRecentChild(data.id);
  closeDialog($("#child-picker-dialog"));
  updateSelectedChildChrome();
  await loadActiveResource();
  if (announceSelection) announce(`${data.displayName}さんを選択しました。`);
}

async function loadDocuments() {
  if (!state.selectedChild) {
    state.documents = [];
    state.documentDetails.clear();
    state.documentSnapshots.clear();
    state.pdfErrors.clear();
    state.monitoringResults = [];
    renderDocuments();
    return;
  }
  const childId = encodeURIComponent(state.selectedChild.id);
  const { data } = await api(`/children/${childId}/documents?limit=100`);
  state.documents = data.items || [];
  state.documentDetails.clear();
  const latestIds = [...new Set(["consultation_plan", "basic_assessment", "individual_support_plan", "specialized_support_plan", "monitoring_record"]
    .map((kind) => latestDocument(kind)?.id)
    .filter(Boolean))];
  for (const reference of state.documents.filter((documentRecord) => documentRecord.documentKind === "consultation_plan")) {
    if (!latestIds.includes(reference.id)) latestIds.push(reference.id);
  }
  const activePlanId = latestDocument("individual_support_plan", (item) => item.status === "active")?.id;
  if (activePlanId && !latestIds.includes(activePlanId)) latestIds.push(activePlanId);
  await Promise.all(latestIds.map(async (documentId) => {
    const result = await api(`/children/${childId}/documents/${encodeURIComponent(documentId)}`);
    state.documentDetails.set(documentId, result);
  }));
  const monitoring = latestDocument("monitoring_record");
  if (monitoring) {
    const results = await api(`/children/${childId}/documents/${encodeURIComponent(monitoring.id)}/monitoring-results`);
    state.monitoringResults = results.data.items || [];
  } else {
    state.monitoringResults = [];
  }
  await loadDocumentSnapshots(state.documents);
  renderDocuments();
}

async function loadActiveResource() {
  if (state.activeView === "audit" && can("audit.view")) {
    await loadAuditEvents();
    return;
  }
  if (!state.selectedChild) {
    renderJournals();
    renderContactEntries();
    renderDocuments();
    renderGuardians();
    return;
  }
  const childId = encodeURIComponent(state.selectedChild.id);
  if (state.activeView === "journals") {
    const { data } = await api(`/children/${childId}/daily-logs?limit=50`);
    state.journals = data.items || [];
    renderJournals();
  } else if (state.activeView === "contact") {
    const { data } = await api(`/children/${childId}/contact-book?limit=50`);
    state.contactEntries = data.items || [];
    renderContactEntries();
  } else if (state.activeView === "documents") {
    await loadDocuments();
  } else if (state.activeView === "child" && state.childPanel === "guardians") {
    await loadGuardians();
  } else if (state.activeView === "admin" && can("admin.view")) {
    await Promise.all([
      can("staff.manage") ? loadStaff() : Promise.resolve(),
    ]);
    renderFacilityAdmin();
  }
}

async function switchView(view, trigger) {
  state.activeView = view;
  $$('[data-page-view]').forEach((section) => {
    const active = section.dataset.pageView === view;
    section.hidden = !active;
    section.classList.toggle("is-active", active);
  });
  $$('.primary-nav [data-view], .admin-nav[data-view]').forEach((button) => {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  await loadActiveResource();
  $("#main-content").focus({ preventScroll: true });
  if (trigger) window.scrollTo({ top: 0, behavior: "smooth" });
}

function openChildRegistration(trigger) {
  closeDialog($("#child-picker-dialog"));
  const form = $("#child-register-form");
  form.reset();
  clearFormError(form, $("#child-register-error"));
  openDialog($("#child-register-dialog"), $("#open-child-picker"));
}

function openChildEdit(trigger) {
  const child = state.selectedChild;
  if (!child) return;
  const form = $("#child-edit-form");
  form.reset();
  for (const field of ["managementCode", "displayName", "legalName", "birthDate", "grade", "gender", "certificateValidFrom", "certificateValidTo", "municipalityName", "copaymentLimitYen", "disabilityCategory", "medicalSummary"]) {
    form.elements[field].value = child[field] ?? "";
  }
  form.elements.recipientCertificateNumber.value = "";
  clearFormError(form, $("#child-edit-error"));
  openDialog($("#child-edit-dialog"), trigger);
}

function openChildDeleteDialog(trigger) {
  const child = state.selectedChild;
  if (!child) return;
  const form = $("#child-delete-form");
  form.reset();
  form.dataset.childId = child.id;
  form.dataset.childRowVersion = child.rowVersion;
  form.dataset.childName = child.displayName;
  $("#child-delete-name").textContent = child.displayName;
  clearFormError(form, $("#child-delete-error"));
  closeDialog($("#child-edit-dialog"));
  openDialog($("#child-delete-dialog"), trigger);
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("写真を読み込めませんでした。")));
    reader.readAsDataURL(blob);
  });
}

async function optimizeChildProfilePhoto(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("JPEG、PNG、WebP形式の写真を選択してください。");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("写真は10MB以下のファイルを選択してください。");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const source = new Image();
      source.addEventListener("load", () => resolve(source), { once: true });
      source.addEventListener("error", () => reject(new Error("写真を読み込めませんでした。")), { once: true });
      source.src = objectUrl;
    });
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, 640 / longestSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (!blob || blob.size > 700 * 1024) throw new Error("写真を小さくできませんでした。別の写真を選択してください。");
    return readBlobAsDataUrl(blob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function replaceSelectedChild(updated, etag) {
  state.selectedChild = updated;
  state.selectedChildEtag = etag || `"${updated.rowVersion}"`;
  state.children = state.children.map((child) => child.id === updated.id ? updated : child);
  renderChildPicker();
  updateSelectedChildChrome();
}

async function submitChildProfilePhoto(file) {
  if (!state.selectedChild || !file) return;
  const input = $("#child-photo-input");
  const button = $("#change-child-photo-button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const dataUrl = await optimizeChildProfilePhoto(file);
    const { data, etag } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/profile-photo`, {
      method: "PUT",
      etag: state.selectedChildEtag,
      body: { dataUrl },
    });
    replaceSelectedChild(data, etag);
    announce("顔写真を登録しました。");
  } catch (error) {
    if (error.status !== 409) announce(errorMessage(error));
  } finally {
    input.value = "";
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function deleteChildProfilePhoto() {
  if (!state.selectedChild?.profilePhotoUpdatedAt) return;
  const button = $("#remove-child-photo-button");
  if (!window.confirm("登録済みの顔写真を削除しますか？")) return;
  button.disabled = true;
  try {
    const { data, etag } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/profile-photo`, {
      method: "DELETE",
      etag: state.selectedChildEtag,
    });
    replaceSelectedChild(data, etag);
    announce("顔写真を削除しました。");
  } catch (error) {
    if (error.status !== 409) announce(errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

function childBodyFromForm(form, includeFacility = false) {
  const values = new FormData(form);
  const body = {
    managementCode: values.get("managementCode").trim(),
    displayName: values.get("displayName").trim(),
    legalName: values.get("legalName").trim(),
  };
  if (includeFacility) body.facilityId = state.facilityId;
  for (const field of ["birthDate", "grade", "gender", "disabilityCategory", "medicalSummary"]) {
    const value = values.get(field)?.trim();
    if (value) body[field] = value;
    else if (!includeFacility && ["birthDate", "gender"].includes(field)) body[field] = null;
    else if (!includeFacility) body[field] = "";
  }
  const certificateNumber = values.get("recipientCertificateNumber")?.trim();
  if (certificateNumber) body.recipientCertificateNumber = certificateNumber.replace(/[ -]/g, "");
  for (const field of ["certificateValidFrom", "certificateValidTo"]) {
    const value = values.get(field)?.trim();
    if (value) body[field] = value;
    else if (!includeFacility) body[field] = null;
  }
  const municipalityName = values.get("municipalityName")?.trim();
  const copaymentLimitYen = values.get("copaymentLimitYen")?.trim();
  if (includeFacility) {
    if (municipalityName) body.municipalityName = municipalityName;
    if (copaymentLimitYen !== "") body.copaymentLimitYen = Number(copaymentLimitYen);
  } else {
    body.municipalityName = municipalityName || null;
    body.copaymentLimitYen = copaymentLimitYen === "" ? null : Number(copaymentLimitYen);
  }
  return body;
}

function validateCertificatePeriod(form, errorContainer) {
  const validFrom = form.elements.certificateValidFrom.value;
  const validTo = form.elements.certificateValidTo.value;
  if (!validFrom || !validTo || validTo >= validFrom) return true;
  showFormError(form, errorContainer, "受給者証の有効期限は、有効開始日以降の日付を入力してください。", ["certificateValidTo"]);
  return false;
}

function showFormError(form, container, message, fields = []) {
  container.textContent = message;
  container.hidden = false;
  for (const fieldName of fields) {
    const field = form.elements[fieldName];
    if (!field) continue;
    field.setAttribute("aria-invalid", "true");
    const ids = new Set((field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(container.id);
    field.setAttribute("aria-describedby", [...ids].join(" "));
  }
  (form.elements[fields[0]] || form.querySelector("input, select, textarea"))?.focus();
}

function clearFormError(form, container) {
  container.hidden = true;
  container.textContent = "";
  $$('[aria-invalid="true"]', form).forEach((field) => {
    field.removeAttribute("aria-invalid");
    const ids = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== container.id);
    if (ids.length) field.setAttribute("aria-describedby", ids.join(" "));
    else field.removeAttribute("aria-describedby");
  });
}

function validateForm(form, errorContainer) {
  clearFormError(form, errorContainer);
  if (form.checkValidity()) return true;
  const invalid = form.querySelector(":invalid");
  showFormError(form, errorContainer, "必須項目または入力形式を確認してください。", invalid?.name ? [invalid.name] : []);
  form.reportValidity();
  return false;
}

function errorMessage(error) {
  if (error.code === "VALIDATION_ERROR") return "入力内容を確認してください。文字数や日付の形式が正しくない可能性があります。";
  if (error.code === "DUPLICATE") return "同じ管理番号など、すでに登録されている情報があります。";
  if (error.code === "CSRF_INVALID") return "安全確認が更新されました。画面を再読み込みしてから、もう一度お試しください。";
  if (error.code === "FORBIDDEN") return "この操作を行う権限がありません。管理者に確認してください。";
  if (error.code === "CURRENT_SCHEDULE_REQUIRED") return "確定した「現在の生活」を先に登録してください。";
  if (error.code === "ACTIVE_PLAN_REQUIRED") return "運用中の個別支援計画が必要です。正式工程を進めてください。";
  if (error.code === "INVALID_SOURCE_DOCUMENT") return "参照する前工程の書類を確認してください。無効または対象外の可能性があります。";
  if (error.code === "STAFF_ALREADY_REGISTERED") return "このメールアドレスの職員はすでに登録されています。";
  if (error.code === "STAFF_ACCOUNT_UNAVAILABLE") return "この職員アカウントは現在変更できません。";
  if (error.code === "STAFF_INVITATION_DELIVERY_FAILED") return "招待メールを送信できませんでした。職員一覧から再送できます。";
  if (error.code === "STAFF_INVITATION_DELIVERY_IN_PROGRESS") return "同じ職員への招待メールを送信中です。少し待ってから職員一覧を更新してください。";
  if (error.code === "STAFF_INVITATION_RECONCILIATION_REQUIRED") return "前回の招待メール送信結果を確認できません。重複送信を防ぐため、運用担当者へ確認を依頼してください。";
  if (error.code === "INVALID_TRANSITION") return "現在の工程からこの操作へは進めません。最新の状態を確認してください。";
  if (error.code === "IMMUTABLE_SCHEDULE") return "確定済みの週間予定は変更できません。新しい版を作成してください。";
  if (error.code === "PDF_RENDER_FAILED") return "PDFを作成できませんでした。時間をおいて再度お試しください。";
  if (error.code === "SECURE_STORAGE_UNAVAILABLE") return "受給者証番号を安全に処理できないため、PDFを作成できません。管理者に確認してください。";
  if (error.code === "DOCUMENT_STORAGE_UNAVAILABLE") return "PDFの保存先を利用できません。管理者に確認してください。";
  if (error.code === "DOCUMENT_STORAGE_INTEGRITY_ERROR") return "PDFの完全性を確認できません。管理者に連絡してください。";
  return error.message || "保存できませんでした。もう一度お試しください。";
}

async function submitChildRegistration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#child-register-error");
  if (!validateForm(form, errorContainer)) return;
  if (!validateCertificatePeriod(form, errorContainer)) return;
  if (!state.facilityId) return showFormError(form, errorContainer, "登録先の事業所を選択してください。", []);
  state.conflictReload = loadChildren;
  try {
    const { data, etag } = await idempotentCreate("/children", childBodyFromForm(form, true));
    state.selectedChild = data;
    state.selectedChildEtag = etag || `"${data.rowVersion}"`;
    await loadChildren();
    state.conflictReload = null;
    updateSelectedChildChrome();
    closeDialog($("#child-register-dialog"));
    announce(`${data.displayName}さんを登録しました。`);
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function submitChildEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#child-edit-error");
  if (!validateForm(form, errorContainer)) return;
  if (!validateCertificatePeriod(form, errorContainer)) return;
  state.conflictResumeDialog = $("#child-edit-dialog");
  try {
    const { data, etag } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}`, {
      method: "PATCH",
      etag: state.selectedChildEtag,
      body: childBodyFromForm(form, false),
    });
    state.selectedChild = data;
    state.selectedChildEtag = etag || `"${data.rowVersion}"`;
    await loadChildren();
    updateSelectedChildChrome();
    closeDialog($("#child-edit-dialog"));
    state.conflictResumeDialog = null;
    announce("基本情報を保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function submitChildDelete(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#child-delete-error");
  const childName = form.dataset.childName || "";
  if (form.elements.confirmation.value.trim() !== childName) {
    showFormError(form, errorContainer, "確認のため、利用者名を正確に入力してください。", ["confirmation"]);
    return;
  }

  state.conflictReload = loadActiveResource;
  try {
    await api(`/children/${encodeURIComponent(form.dataset.childId)}`, {
      method: "DELETE",
      etag: `"${form.dataset.childRowVersion}"`,
    });
    const deletedName = childName;
    closeDialog($("#child-delete-dialog"));
    forgetSelectedChild();
    state.selectedChild = null;
    state.selectedChildEtag = null;
    state.guardians = [];
    state.schedules = { current: null, planned: null };
    state.documents = [];
    state.documentDetails.clear();
    state.documentSnapshots.clear();
    state.pdfErrors.clear();
    state.monitoringResults = [];
    await loadChildren();
    updateSelectedChildChrome();
    await loadActiveResource();
    state.conflictReload = null;
    announce(`${deletedName}さんを一覧から削除しました。過去記録は保存されています。`);
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function journalDateTimeInputValue(value = new Date()) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function openJournalDialog(trigger, journal = null) {
  if (!state.selectedChild) return announce("先に利用者を選択してください。");
  const form = $("#journal-form");
  form.reset();
  $$('[data-journal-length]', form).forEach(syncCustomTargetLength);
  form.dataset.journalId = journal?.id || "";
  form.dataset.journalRowVersion = journal?.rowVersion ? String(journal.rowVersion) : "";
  form.dataset.journalGoalIds = JSON.stringify(journal?.relatedGoalIds || []);
  form.dataset.journalStatus = journal?.status || "draft";
  const isDraft = journal?.status === "draft";
  $("#journal-form-title").textContent = journal ? (isDraft ? "日誌の下書きを編集" : "日誌を編集") : "日誌を登録";
  const draftButton = $("#save-journal-draft");
  const finalButton = $("#save-journal-final");
  draftButton.hidden = Boolean(journal && !isDraft);
  draftButton.textContent = journal ? "下書きを保存" : "下書き保存";
  finalButton.textContent = journal ? (isDraft ? "記録を保存" : "変更を保存") : "記録を保存";
  if (journal) {
    form.elements.occurredAt.value = journalDateTimeInputValue(journal.occurredAt);
    form.elements.activity.value = journal.activity || "";
    form.elements.observation.value = journal.observation || "";
    form.elements.supportProvided.value = journal.supportProvided || "";
    form.elements.childResponse.value = journal.childResponse || "";
    form.elements.healthNote.value = journal.healthNote || "";
    journal.fiveDomains?.forEach((domain) => {
      const checkbox = form.querySelector(`[name="fiveDomains"][value="${domain}"]`);
      if (checkbox) checkbox.checked = true;
    });
  } else {
    form.elements.occurredAt.value = journalDateTimeInputValue();
  }
  updateAllJournalCharacterCounts(form);
  clearFormError(form, $("#journal-error"));
  openDialog($("#journal-dialog"), trigger);
}

const JOURNAL_FIELD_LABELS = Object.freeze({
  observation: "観察した事実",
  supportProvided: "行った支援",
  childResponse: "本人の反応",
  healthNote: "健康上の連絡",
});

function journalBulletLines(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*・●▪︎]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean);
}

function completeJapaneseSentence(value) {
  const normalized = value.replace(/\s+/g, " ").replace(/[。．！？!?]+$/u, "").trim();
  return normalized ? `${normalized}。` : "";
}

function journalTextLength(value) {
  return [...String(value || "").trim()].length;
}

const WRITING_TARGET_MIN = 80;
const WRITING_TARGET_MAX = 800;

function writingTargetLength(select) {
  if (!select) return null;
  if (select.value !== "custom") return Number(select.value) || null;
  const customInput = $(".writing-custom-target-length", select.parentElement);
  const target = Number(customInput?.value);
  return Number.isInteger(target) && target >= WRITING_TARGET_MIN && target <= WRITING_TARGET_MAX ? target : null;
}

function writingTargetMessage(length, target) {
  return target ? `現在 ${length}字 ／ 目標 ${target}字` : `現在 ${length}字 ／ 目標文字数を入力`;
}

function syncCustomTargetLength(select) {
  const customInput = $(".writing-custom-target-length", select?.parentElement);
  if (!customInput) return;
  const isCustom = select.value === "custom";
  customInput.hidden = !isCustom;
  customInput.required = isCustom;
}

function installCustomTargetLength(select, fieldLabel, className = "") {
  const root = select?.parentElement;
  if (!root || $(".writing-custom-target-length", root)) return;
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "任意";
  select.append(customOption);

  const customInput = document.createElement("input");
  customInput.className = ["writing-custom-target-length", className].filter(Boolean).join(" ");
  customInput.type = "number";
  customInput.min = String(WRITING_TARGET_MIN);
  customInput.max = String(WRITING_TARGET_MAX);
  customInput.step = "1";
  customInput.inputMode = "numeric";
  customInput.placeholder = "80〜800";
  customInput.hidden = true;
  customInput.setAttribute("aria-label", `${fieldLabel}の任意の目標文字数`);
  customInput.setAttribute("title", "80〜800字で入力できます");
  select.after(customInput);
  select.addEventListener("change", () => {
    syncCustomTargetLength(select);
    if (select.value === "custom") customInput.focus();
  });
}

function focusCustomTarget(select) {
  const root = select?.parentElement;
  if (root) $(".writing-custom-target-length", root)?.focus();
}

function createWritingDisclosure(fieldName, fieldLabel, tools, dataAttribute) {
  const disclosure = document.createElement("details");
  disclosure.className = "writing-disclosure";
  disclosure.dataset[dataAttribute] = fieldName;
  const summary = document.createElement("summary");
  summary.textContent = `「${fieldLabel}」の文章を調整・コピー`;
  disclosure.append(summary, tools);
  return disclosure;
}

async function copyFieldText(field, button, label) {
  const text = String(field?.value || "").trim();
  if (!text) {
    announce(`${label}にコピーする内容がありません。`);
    field?.focus();
    return;
  }
  const originalLabel = button.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      field.focus();
      field.select();
      if (!document.execCommand("copy")) throw new Error("COPY_FAILED");
      field.setSelectionRange(text.length, text.length);
    }
    button.textContent = "コピーしました";
    announce(`${label}をコピーしました。`);
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = originalLabel;
    }, 1600);
  } catch {
    announce("コピーできませんでした。内容を選択してコピーしてください。");
  }
}

function journalTargetLength(fieldName, form = $("#journal-form")) {
  return writingTargetLength($(`[data-journal-length="${fieldName}"]`, form));
}

function updateJournalCharacterCount(fieldName, form = $("#journal-form")) {
  const field = form.elements[fieldName];
  const output = $(`[data-journal-character-count="${fieldName}"]`, form);
  if (!field || !output) return;
  const length = journalTextLength(field.value);
  const target = journalTargetLength(fieldName, form);
  output.textContent = writingTargetMessage(length, target);
  output.dataset.state = target && length >= target ? "met" : "short";
}

function updateAllJournalCharacterCounts(form = $("#journal-form")) {
  Object.keys(JOURNAL_FIELD_LABELS).forEach((fieldName) => updateJournalCharacterCount(fieldName, form));
}

async function generateJournalField(fieldName, button) {
  const form = $("#journal-form");
  const field = form.elements[fieldName];
  const sourceText = field.value.trim();
  if (!sourceText) {
    showFormError(form, $("#journal-error"), `「${JOURNAL_FIELD_LABELS[fieldName]}」に事実を入力してから、文章を整えてください。`, [fieldName]);
    return;
  }
  const target = journalTargetLength(fieldName, form);
  if (!target) {
    showFormError(form, $("#journal-error"), `任意の目標文字数は${WRITING_TARGET_MIN}〜${WRITING_TARGET_MAX}字で入力してください。`, []);
    focusCustomTarget($(`[data-journal-length="${fieldName}"]`, form));
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "整えています…";
  try {
    const { data } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/writing-assist`, {
      method: "POST",
      body: {
        kind: "daily_log",
        field: fieldName,
        sourceText,
        activity: form.elements.activity.value.trim() || undefined,
        targetCharacters: target,
      },
    });
    field.value = data.text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    clearFormError(form, $("#journal-error"));
    announce(`${JOURNAL_FIELD_LABELS[fieldName]}の文章を整えました。現在${data.characterCount}字です。`);
  } catch (error) {
    showFormError(form, $("#journal-error"), errorMessage(error), []);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function assessmentTargetLength(fieldName, form = $("#assessment-editor-form")) {
  return writingTargetLength($(`[data-assessment-length="${fieldName}"]`, form));
}

function updateAssessmentCharacterCount(fieldName, form = $("#assessment-editor-form")) {
  const field = form.elements[fieldName];
  const output = $(`[data-assessment-character-count="${fieldName}"]`, form);
  if (!field || !output) return;
  const length = journalTextLength(field.value);
  const target = assessmentTargetLength(fieldName, form);
  output.textContent = writingTargetMessage(length, target);
  output.dataset.state = target && length >= target ? "met" : "short";
}

function installAssessmentWritingTools(form = $("#assessment-editor-form")) {
  for (const [fieldName] of ASSESSMENT_EDITOR_FIELDS) {
    const field = form.elements[fieldName];
    if (!field || $(`[data-assessment-writing-tools="${fieldName}"]`, form)) continue;

    const tools = document.createElement("div");
    tools.className = "journal-writing-tools assessment-writing-tools";
    tools.dataset.assessmentWritingTools = fieldName;

    const lengthLabel = document.createElement("label");
    lengthLabel.textContent = "目標文字数";
    const select = document.createElement("select");
    select.dataset.assessmentLength = fieldName;
    select.setAttribute("aria-label", `${ASSESSMENT_FIELD_LABELS[fieldName]}の目標文字数`);
    for (const target of [100, 200, 300, 500]) {
      const option = document.createElement("option");
      option.value = String(target);
      option.textContent = `${target}字`;
      if (target === 200) option.selected = true;
      select.append(option);
    }
    lengthLabel.append(" ", select);
    installCustomTargetLength(select, ASSESSMENT_FIELD_LABELS[fieldName], "assessment-custom-target-length");

    const output = document.createElement("output");
    output.className = "journal-character-count";
    output.dataset.assessmentCharacterCount = fieldName;
    output.id = `assessment-${fieldName}-count`;
    output.setAttribute("aria-live", "polite");

    const button = document.createElement("button");
    button.className = "button button-quiet";
    button.type = "button";
    const isSynthesisField = ASSESSMENT_SYNTHESIS_FIELDS.has(fieldName);
    button.textContent = isSynthesisField ? "入力内容から下書きを作る" : "文章を整える";
    button.title = isSynthesisField
      ? "本人・家族から伺ったことと、現在の状況・強み・課題をもとに、目標文字数を目安に下書きを作ります"
      : "入力内容をもとに、目標文字数を目安に文章を整えます";
    button.addEventListener("click", () => runAsync(() => generateAssessmentField(fieldName, button)));
    select.addEventListener("change", () => updateAssessmentCharacterCount(fieldName, form));
    field.addEventListener("input", () => updateAssessmentCharacterCount(fieldName, form));
    field.setAttribute("aria-describedby", output.id);

    const copyButton = document.createElement("button");
    copyButton.className = "button button-quiet";
    copyButton.type = "button";
    copyButton.textContent = "コピー";
    copyButton.addEventListener("click", () => runAsync(() => copyFieldText(field, copyButton, ASSESSMENT_FIELD_LABELS[fieldName])));

    tools.append(lengthLabel, output, button, copyButton);
    if (isSynthesisField) {
      const contextNote = document.createElement("p");
      contextNote.className = "assessment-writing-note";
      contextNote.textContent = "上の「本人・家族から伺ったこと」と「現在の状況・強み・課題」をもとに下書きを作ります。";
      tools.append(contextNote);
    }
    field.after(createWritingDisclosure(fieldName, ASSESSMENT_FIELD_LABELS[fieldName], tools, "assessmentWritingDisclosure"));
  }
}

function updateAllAssessmentCharacterCounts(form = $("#assessment-editor-form")) {
  for (const [fieldName] of ASSESSMENT_EDITOR_FIELDS) updateAssessmentCharacterCount(fieldName, form);
}

async function generateAssessmentField(fieldName, button) {
  const form = $("#assessment-editor-form");
  const field = form.elements[fieldName];
  const sourceText = assessmentWritingSourceText(fieldName, form);
  if (!sourceText) {
    const message = ASSESSMENT_SYNTHESIS_FIELDS.has(fieldName)
      ? "先に「本人・家族から伺ったこと」または「現在の状況・強み・課題」を入力してください。"
      : `「${ASSESSMENT_FIELD_LABELS[fieldName]}」を入力してから、文章を整えてください。`;
    showFormError(form, $("#assessment-editor-error"), message, ASSESSMENT_SYNTHESIS_FIELDS.has(fieldName) ? ASSESSMENT_CONTEXT_FIELDS : [fieldName]);
    return;
  }
  const target = assessmentTargetLength(fieldName, form);
  if (!target) {
    showFormError(form, $("#assessment-editor-error"), `任意の目標文字数は${WRITING_TARGET_MIN}〜${WRITING_TARGET_MAX}字で入力してください。`, []);
    focusCustomTarget($(`[data-assessment-length="${fieldName}"]`, form));
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "整えています…";
  try {
    const { data } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/writing-assist`, {
      method: "POST",
      body: { kind: "basic_assessment", field: fieldName, sourceText, targetCharacters: target },
    });
    field.value = data.text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    clearFormError(form, $("#assessment-editor-error"));
    announce(`${ASSESSMENT_FIELD_LABELS[fieldName]}の下書きを作成しました。現在${data.characterCount}字です。保存前に内容を確認してください。`);
  } catch (error) {
    showFormError(form, $("#assessment-editor-error"), errorMessage(error), []);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function planTargetLength(fieldName, form = $("#plan-editor-form")) {
  return writingTargetLength($(`[data-plan-length="${fieldName}"]`, form));
}

function updatePlanCharacterCount(fieldName, form = $("#plan-editor-form")) {
  const field = form.elements[fieldName];
  const output = $(`[data-plan-character-count="${fieldName}"]`, form);
  if (!field || !output) return;
  const length = journalTextLength(field.value);
  const target = planTargetLength(fieldName, form);
  output.textContent = writingTargetMessage(length, target);
  output.dataset.state = target && length >= target ? "met" : "short";
}

function updateAllPlanCharacterCounts(form = $("#plan-editor-form")) {
  for (const [fieldName] of INDIVIDUAL_PLAN_PAYLOAD_FIELDS) updatePlanCharacterCount(fieldName, form);
}

function installPlanWritingTools(form = $("#plan-editor-form")) {
  for (const [fieldName, fieldLabel] of INDIVIDUAL_PLAN_PAYLOAD_FIELDS) {
    const field = form.elements[fieldName];
    if (!field || $(`[data-plan-writing-tools="${fieldName}"]`, form)) continue;

    const tools = document.createElement("div");
    tools.className = "journal-writing-tools plan-writing-tools";
    tools.dataset.planWritingTools = fieldName;

    const lengthLabel = document.createElement("label");
    lengthLabel.textContent = "目標文字数";
    const select = document.createElement("select");
    select.dataset.planLength = fieldName;
    select.setAttribute("aria-label", `${fieldLabel}の目標文字数`);
    for (const target of [100, 200, 300, 500]) {
      const option = document.createElement("option");
      option.value = String(target);
      option.textContent = `${target}字`;
      if (target === 300) option.selected = true;
      select.append(option);
    }
    lengthLabel.append(" ", select);
    installCustomTargetLength(select, fieldLabel, "plan-custom-target-length");

    const output = document.createElement("output");
    output.className = "journal-character-count";
    output.dataset.planCharacterCount = fieldName;
    output.id = `plan-${fieldName}-count`;
    output.setAttribute("aria-live", "polite");

    const button = document.createElement("button");
    button.className = "button button-quiet";
    button.type = "button";
    button.textContent = "文章を整える";
    button.title = "入力内容をもとに、目標文字数を目安に文章を整えます";
    button.addEventListener("click", () => runAsync(() => generatePlanField(fieldName, button)));
    select.addEventListener("change", () => updatePlanCharacterCount(fieldName, form));
    field.addEventListener("input", () => updatePlanCharacterCount(fieldName, form));
    field.setAttribute("aria-describedby", output.id);

    const copyButton = document.createElement("button");
    copyButton.className = "button button-quiet";
    copyButton.type = "button";
    copyButton.textContent = "コピー";
    copyButton.addEventListener("click", () => runAsync(() => copyFieldText(field, copyButton, fieldLabel)));

    tools.append(lengthLabel, output, button, copyButton);
    field.after(createWritingDisclosure(fieldName, fieldLabel, tools, "planWritingDisclosure"));
  }
}

async function generatePlanField(fieldName, button) {
  const form = $("#plan-editor-form");
  const field = form.elements[fieldName];
  const sourceText = field.value.trim();
  if (!sourceText) {
    showFormError(form, $("#plan-editor-error"), `「${INDIVIDUAL_PLAN_FIELD_LABELS[fieldName]}」を入力してから、文章を整えてください。`, [fieldName]);
    return;
  }
  const target = planTargetLength(fieldName, form);
  if (!target) {
    showFormError(form, $("#plan-editor-error"), `任意の目標文字数は${WRITING_TARGET_MIN}〜${WRITING_TARGET_MAX}字で入力してください。`, []);
    focusCustomTarget($(`[data-plan-length="${fieldName}"]`, form));
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "整えています…";
  try {
    const { data } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/writing-assist`, {
      method: "POST",
      body: { kind: "individual_support_plan", field: fieldName, sourceText, targetCharacters: target },
    });
    field.value = data.text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    clearFormError(form, $("#plan-editor-error"));
    announce(`${INDIVIDUAL_PLAN_FIELD_LABELS[fieldName]}の文章を整えました。現在${data.characterCount}字です。保存前に内容を確認してください。`);
  } catch (error) {
    showFormError(form, $("#plan-editor-error"), errorMessage(error), []);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function assessmentWritingSourceText(fieldName, form = $("#assessment-editor-form")) {
  if (!ASSESSMENT_SYNTHESIS_FIELDS.has(fieldName)) return form.elements[fieldName].value.trim();
  const context = ASSESSMENT_CONTEXT_FIELDS
    .map((sourceField) => {
      const value = form.elements[sourceField]?.value.trim();
      if (!value) return "";
      return `${ASSESSMENT_FIELD_LABELS[sourceField]}: ${[...value].slice(0, 500).join("")}`;
    })
    .filter(Boolean);
  const currentDraft = form.elements[fieldName].value.trim();
  if (currentDraft) context.push(`${ASSESSMENT_FIELD_LABELS[fieldName]}（現在の下書き）: ${[...currentDraft].slice(0, 500).join("")}`);
  return context.join("\n");
}

async function submitJournal(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#journal-error");
  if (!validateForm(form, errorContainer)) return;
  const body = journalFormBody(form, "final");
  try {
    const journalId = form.dataset.journalId;
    let savedJournal;
    state.conflictReload = loadActiveResource;
    state.conflictResumeDialog = $("#journal-dialog");
    if (journalId) {
      const result = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/daily-logs/${encodeURIComponent(journalId)}`, {
        method: "PATCH",
        etag: `"${form.dataset.journalRowVersion}"`,
        body,
      });
      savedJournal = result.data;
    } else {
      const result = await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/daily-logs`, body);
      savedJournal = result.data;
    }
    closeDialog($("#journal-dialog"));
    await loadActiveResource();
    state.conflictReload = null;
    state.conflictResumeDialog = null;
    if (journalId) {
      announce("日誌を変更しました。");
      return;
    }
    if (kind === "specialized_support_plan") {
      const created = state.documents.find((documentRecord) => documentRecord.id === result.data.id) || result.data;
      await openPlanEditor(created, button);
      announce("専門的支援の目標と活動プログラムを入力してください。");
      return;
    }
    announce("日誌を保存しました。連絡帳の下書きを作成しています。");
    await openContactDraftFromJournal($("#main-content"), savedJournal || body);
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function journalFormBody(form, status) {
  const values = new FormData(form);
  return {
    status,
    occurredAt: new Date(values.get("occurredAt")).toISOString(),
    activity: values.get("activity").trim(),
    observation: values.get("observation").trim(),
    supportProvided: values.get("supportProvided").trim(),
    childResponse: values.get("childResponse").trim(),
    healthNote: values.get("healthNote").trim(),
    fiveDomains: values.getAll("fiveDomains"),
    relatedGoalIds: JSON.parse(form.dataset.journalGoalIds || "[]"),
  };
}

function journalDraftHasContent(body) {
  return Boolean(
    body.activity || body.observation || body.supportProvided || body.childResponse || body.healthNote
    || body.fiveDomains.length || body.relatedGoalIds.length,
  );
}

async function saveJournalDraft() {
  const form = $("#journal-form");
  const errorContainer = $("#journal-error");
  const body = journalFormBody(form, "draft");
  if (!journalDraftHasContent(body)) {
    showFormError(form, errorContainer, "下書きとして保存する内容を入力してください。", []);
    return;
  }
  try {
    const journalId = form.dataset.journalId;
    state.conflictReload = loadActiveResource;
    state.conflictResumeDialog = $("#journal-dialog");
    if (journalId) {
      await api(`/children/${encodeURIComponent(state.selectedChild.id)}/daily-logs/${encodeURIComponent(journalId)}`, {
        method: "PATCH",
        etag: `"${form.dataset.journalRowVersion}"`,
        body,
      });
    } else {
      await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/daily-logs`, body);
    }
    closeDialog($("#journal-dialog"));
    await loadActiveResource();
    state.conflictReload = null;
    state.conflictResumeDialog = null;
    announce("日誌の下書きを保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function journalContactSourceText(journal) {
  const sentences = [
    journal.activity ? `本日は${journal.activity}を行いました` : "",
    journal.observation,
    journal.supportProvided,
    journal.childResponse,
    journal.healthNote ? `健康面では${journal.healthNote}` : "",
  ]
    .map((value) => completeJapaneseSentence(String(value || "").trim()))
    .filter(Boolean);
  return sentences.join("\n");
}

async function openContactDraftFromJournal(trigger, journal) {
  openContactDialog(trigger, null, journal);
  const button = $("#expand-contact-draft");
  if (button && $("#contact-form").elements.facilityReply.value.trim()) await generateContactDraft(button);
}

function openContactDialog(trigger, entry = null, sourceJournal = null) {
  if (!state.selectedChild) return announce("先に利用者を選択してください。");
  const form = $("#contact-form");
  const journalBased = sourceJournal !== null;
  form.reset();
  syncCustomTargetLength($("[data-contact-reply-length]", form));
  form.dataset.contactEntryId = entry?.id || "";
  form.dataset.contactRowVersion = entry?.rowVersion || "";
  form.dataset.contactSource = journalBased ? "journal" : "";
  form.dataset.existingPhotoCount = String(entry?.photos?.length || 0);
  form.dataset.existingPhotos = JSON.stringify(entry?.photos || []);
  if (entry) {
    form.elements.entryDate.value = entry.entryDate || "";
    form.elements.facilityReply.value = entry.facilityReply || "";
    form.elements.requestSummary.value = entry.requestSummary || "";
    form.elements.reflectedInSupport.checked = Boolean(entry.reflectedInSupport);
  } else if (journalBased) {
    form.elements.entryDate.value = String(sourceJournal.occurredAt || "").slice(0, 10);
    form.elements.facilityReply.value = journalContactSourceText(sourceJournal);
  } else {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    form.elements.entryDate.value = today.toISOString().slice(0, 10);
  }
  $("#contact-form-title").textContent = entry ? "連絡帳を編集" : "日誌から連絡帳を作成";
  $("#contact-form-description").textContent = journalBased
    ? "同じ日の日誌をもとに、事業所からの連絡を作成しました。内容と写真を確認してから登録してください。"
    : "事業所からの連絡、写真、引継ぎ事項を確認・編集できます。";
  $("#save-contact-button").textContent = entry ? "変更を保存" : "連絡帳を登録";
  renderContactPhotoPreview(form, entry?.photos || []);
  updateContactReplyCharacterCount(form);
  clearFormError(form, $("#contact-error"));
  openDialog($("#contact-dialog"), trigger);
}

function selectedContactPhotoFiles(form) {
  return [...(form.elements.contactPhotos?.files || [])];
}

function renderContactPhotoPreview(form, existingPhotos = null) {
  const preview = $("#contact-photo-preview", form);
  const count = $("#contact-photo-count", form);
  if (!preview || !count) return;
  if (existingPhotos === null) {
    try { existingPhotos = JSON.parse(form.dataset.existingPhotos || "[]"); } catch { existingPhotos = []; }
  }
  preview.replaceChildren();
  const files = selectedContactPhotoFiles(form);
  const total = existingPhotos.length + files.length;
  count.textContent = `${total} / ${MAX_CONTACT_PHOTOS}枚`;
  if (!total) {
    preview.append(element("p", { text: "写真はまだ選択されていません。" }));
    return;
  }
  for (const [index, photo] of existingPhotos.entries()) {
    const item = element("div", { className: "contact-photo-preview-item" });
    const image = document.createElement("img");
    image.src = contactPhotoPath(form.dataset.contactEntryId, photo.id);
    image.alt = `登録済みの写真 ${index + 1}枚目`;
    item.append(image, element("span", { text: "登録済み" }));
    if (can("journals.edit")) {
      const deleteButton = element("button", {
        className: "contact-photo-remove",
        text: "削除",
        attributes: { type: "button", "aria-label": `登録済みの写真 ${index + 1}枚目を削除` },
      });
      deleteButton.addEventListener("click", () => runAsync(() => deleteContactPhoto(deleteButton, form, photo)));
      item.append(deleteButton);
    }
    preview.append(item);
  }
  for (const [index, file] of files.entries()) {
    const item = element("div", { className: "contact-photo-preview-item" });
    const image = document.createElement("img");
    const objectUrl = URL.createObjectURL(file);
    image.src = objectUrl;
    image.alt = `追加する写真 ${index + 1}枚目`;
    image.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
    item.append(image, element("span", { text: file.name }));
    preview.append(item);
  }
}

async function deleteContactPhoto(button, form, photo) {
  const entryId = form.dataset.contactEntryId;
  if (!entryId || !photo?.id || !Number.isInteger(Number(photo.rowVersion))) return;
  if (!window.confirm("この写真を削除しますか？\n連絡帳には表示されなくなりますが、操作履歴は保存されます。")) return;
  button.disabled = true;
  state.conflictReload = loadActiveResource;
  state.conflictResumeDialog = $("#contact-dialog");
  try {
    await api(
      `/children/${encodeURIComponent(state.selectedChild.id)}/contact-book/${encodeURIComponent(entryId)}/photos/${encodeURIComponent(photo.id)}`,
      { method: "DELETE", etag: `"${photo.rowVersion}"` },
    );
    let existingPhotos;
    try { existingPhotos = JSON.parse(form.dataset.existingPhotos || "[]"); } catch { existingPhotos = []; }
    const remainingPhotos = existingPhotos.filter((item) => item.id !== photo.id);
    form.dataset.existingPhotos = JSON.stringify(remainingPhotos);
    form.dataset.existingPhotoCount = String(remainingPhotos.length);
    const entry = state.contactEntries.find((item) => item.id === entryId);
    if (entry) entry.photos = remainingPhotos;
    if (state.activeView === "contact") renderContactEntries();
    renderContactPhotoPreview(form, remainingPhotos);
    state.conflictReload = null;
    state.conflictResumeDialog = null;
    announce("写真を削除しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, $("#contact-error"), errorMessage(error), []);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function validateContactPhotos(form, errorContainer) {
  const files = selectedContactPhotoFiles(form);
  const existingCount = Number(form.dataset.existingPhotoCount || 0);
  if (existingCount + files.length > MAX_CONTACT_PHOTOS) {
    showFormError(form, errorContainer, `写真は最大${MAX_CONTACT_PHOTOS}枚までです。`, ["contactPhotos"]);
    return false;
  }
  for (const file of files) {
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) {
      showFormError(form, errorContainer, "JPEG、PNG、WebP形式の写真を選択してください。", ["contactPhotos"]);
      return false;
    }
    if (file.size > 5 * 1024 * 1024) {
      showFormError(form, errorContainer, "写真は1枚5MB以下にしてください。", ["contactPhotos"]);
      return false;
    }
  }
  return true;
}

async function readContactPhotoAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("写真を読み込めませんでした。")), { once: true });
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) return reject(new Error("写真を読み込めませんでした。"));
      return resolve(dataUrl.slice(comma + 1));
    }, { once: true });
    reader.readAsDataURL(file);
  });
}

async function uploadContactPhotos(entryId, files) {
  for (const file of files) {
    const dataBase64 = await readContactPhotoAsBase64(file);
    await idempotentCreate(
      `/children/${encodeURIComponent(state.selectedChild.id)}/contact-book/${encodeURIComponent(entryId)}/photos`,
      { fileName: file.name, contentType: file.type, dataBase64 },
    );
  }
}

function contactReplyTargetLength(form = $("#contact-form")) {
  return writingTargetLength($("[data-contact-reply-length]", form));
}

function updateContactReplyCharacterCount(form = $("#contact-form")) {
  const output = $("#contact-reply-count", form);
  if (!output) return;
  const length = journalTextLength(form.elements.facilityReply.value);
  const target = contactReplyTargetLength(form);
  output.textContent = writingTargetMessage(length, target);
  output.dataset.state = target && length >= target ? "met" : "short";
}

async function generateContactDraft(button) {
  const form = $("#contact-form");
  const requestSummary = form.elements.requestSummary.value.trim();
  const facilityReply = form.elements.facilityReply.value.trim();
  const reflectedInSupport = form.elements.reflectedInSupport.checked;
  if (![requestSummary, facilityReply].some(Boolean)) {
    showFormError(form, $("#contact-error"), "引継ぎ事項または事業所からの連絡を入力してから、文章を整えてください。", ["requestSummary", "facilityReply"]);
    return;
  }
  const target = contactReplyTargetLength(form);
  if (!target) {
    showFormError(form, $("#contact-error"), `任意の目標文字数は${WRITING_TARGET_MIN}〜${WRITING_TARGET_MAX}字で入力してください。`, []);
    focusCustomTarget($("[data-contact-reply-length]", form));
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "整えています…";
  try {
    const { data } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/writing-assist`, {
      method: "POST",
      body: { kind: "contact_reply", familyMessage: "", requestSummary, facilityReply, reflectedInSupport, targetCharacters: target },
    });
    form.elements.facilityReply.value = data.text;
    form.elements.facilityReply.dispatchEvent(new Event("input", { bubbles: true }));
    clearFormError(form, $("#contact-error"));
    announce(`文章を整えました。現在${data.characterCount}字です。`);
  } catch (error) {
    showFormError(form, $("#contact-error"), errorMessage(error), []);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function submitContact(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#contact-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const facilityReply = values.get("facilityReply").trim();
  if (!facilityReply) {
    showFormError(form, errorContainer, "日誌をもとにした事業所からの連絡を入力してください。", ["facilityReply"]);
    return;
  }
  if (!validateContactPhotos(form, errorContainer)) return;
  const body = {
    entryDate: values.get("entryDate"),
    facilityReply,
    requestSummary: values.get("requestSummary").trim(),
    reflectedInSupport: values.get("reflectedInSupport") === "on",
  };
  try {
    const entryId = form.dataset.contactEntryId;
    state.conflictReload = loadActiveResource;
    state.conflictResumeDialog = $("#contact-dialog");
    let savedEntry;
    if (entryId) {
      const result = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/contact-book/${encodeURIComponent(entryId)}`, {
        method: "PATCH",
        etag: `"${form.dataset.contactRowVersion}"`,
        body,
      });
      savedEntry = result.data;
    } else {
      const result = await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/contact-book`, body);
      savedEntry = result.data;
    }
    await uploadContactPhotos(savedEntry.id, selectedContactPhotoFiles(form));
    closeDialog($("#contact-dialog"));
    await loadActiveResource();
    state.conflictReload = null;
    state.conflictResumeDialog = null;
    announce(entryId ? "連絡帳を変更しました。" : "連絡を保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function createDocumentDraft(button) {
  if (!state.selectedChild || button.disabled) return;
  const kind = button.dataset.createDocument;
  button.disabled = true;
  state.conflictReload = loadDocuments;
  try {
    const result = await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/documents`, {
      documentKind: kind,
      templateVersion: "2026.1",
      payload: { creationMethod: "manual" },
    }, { suppressConflictDialog: true });
    await loadDocuments();
    state.conflictReload = null;
    if (kind === "consultation_plan") {
      const created = state.documents.find((documentRecord) => documentRecord.id === result.data.id) || result.data;
      await openReferencePlanEditor(created, button);
      announce("資料ファイルを選び、必要なら要点を入力して保存してください。");
      return;
    }
    announce(`${DOCUMENT_KIND_LABELS[kind]}を作成しました。内容を編集して確認してください。`);
  } catch (error) {
    if (error.code === "DRAFT_EXISTS" && kind === "consultation_plan") {
      await loadDocuments();
      state.conflictReload = null;
      const existing = state.documents.find((documentRecord) => documentRecord.id === error.details?.documentId)
        || latestDocument(kind, (documentRecord) => EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status));
      if (existing) {
        await openReferencePlanEditor(existing, button);
        setSaveState("saved");
        announce("入力途中の参考資料を開きました。続きから入力してください。");
        return;
      }
      announce("入力途中の参考資料を読み込めませんでした。画面を再読み込みしてから、もう一度お試しください。");
      return;
    }
    if (error.status !== 409) announce(errorMessage(error));
  } finally {
    button.disabled = !state.selectedChild;
  }
}

async function generateDraft(button) {
  if (!state.selectedChild || button.disabled) return;
  const kind = button.dataset.generateDraft;
  const consultation = latestReferenceMaterial();
  const assessment = latestDocument("basic_assessment");
  const body = kind === "basic_assessment"
    ? {
        targetDocumentKind: "basic_assessment",
        consultationPlanId: consultation?.id,
        currentScheduleVersionId: state.schedules.current?.id,
        previousMonitoringDocumentId: latestDocument("monitoring_record")?.id || undefined,
      }
    : {
        targetDocumentKind: "individual_support_plan",
        consultationPlanId: consultation?.id,
        assessmentDocumentId: assessment?.id,
        previousMonitoringDocumentId: latestDocument("monitoring_record")?.id || undefined,
      };
  button.disabled = true;
  state.conflictReload = loadDocuments;
  try {
    await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/draft-generations`, body);
    await loadDocuments();
    state.conflictReload = null;
    announce(`${DOCUMENT_KIND_LABELS[kind]}を作成しました。内容を編集して確認してください。`);
  } catch (error) {
    if (error.status !== 409) announce(errorMessage(error));
  } finally {
    renderDocuments();
  }
}

function openMonitoringGeneration(trigger) {
  if (!state.selectedChild || !latestDocument("individual_support_plan", (item) => item.status === "active")) {
    return announce("運用中の個別支援計画が必要です。");
  }
  const form = $("#monitoring-generation-form");
  form.reset();
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 6);
  for (const [field, date] of [["periodStart", start], ["periodEnd", end]]) {
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    form.elements[field].value = date.toISOString().slice(0, 10);
  }
  clearFormError(form, $("#monitoring-generation-error"));
  openDialog($("#monitoring-generation-dialog"), trigger);
}

async function submitMonitoringGeneration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#monitoring-generation-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const activePlan = latestDocument("individual_support_plan", (item) => item.status === "active");
  const body = {
    targetDocumentKind: "monitoring_record",
    individualSupportPlanId: activePlan?.id,
    periodStart: values.get("periodStart"),
    periodEnd: values.get("periodEnd"),
  };
  if (body.periodEnd < body.periodStart) return showFormError(form, errorContainer, "終了日は開始日以降にしてください。", ["periodEnd"]);
  const evidenceDays = (Date.parse(`${body.periodEnd}T00:00:00Z`) - Date.parse(`${body.periodStart}T00:00:00Z`)) / 86_400_000;
  if (evidenceDays > 366) return showFormError(form, errorContainer, "根拠期間は366日以内にしてください。", ["periodEnd"]);
  try {
    await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/draft-generations`, body);
    closeDialog($("#monitoring-generation-dialog"));
    await loadDocuments();
    announce("モニタリングを作成しました。目標ごとの評価を入力してください。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function openMonitoringResult(documentRecord, result, goal, trigger) {
  const form = $("#monitoring-result-form");
  form.reset();
  form.elements.documentId.value = documentRecord.id;
  form.elements.resultId.value = result.id;
  form.elements.rowVersion.value = result.rowVersion;
  form.elements.progressStatus.value = result.progressStatus;
  form.elements.nextGoalAction.value = result.nextGoalAction || "";
  for (const field of ["progressSummary", "currentChallenge", "nextSupportPolicy"]) form.elements[field].value = result[field] || "";
  $("#monitoring-result-goal").textContent = goal?.title ? `対象目標：${goal.title}` : "対象目標の根拠を確認して評価してください。";
  clearFormError(form, $("#monitoring-result-error"));
  openDialog($("#monitoring-result-dialog"), trigger);
}

async function openMonitoringEditor(documentRecord, trigger) {
  if (!state.selectedChild || documentRecord.documentKind !== "monitoring_record" || !EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) return;
  const childId = encodeURIComponent(state.selectedChild.id);
  let detailResult = state.documentDetails.get(documentRecord.id);
  if (!detailResult) {
    detailResult = await api(`/children/${childId}/documents/${encodeURIComponent(documentRecord.id)}`);
    state.documentDetails.set(documentRecord.id, detailResult);
  }
  const detail = detailResult.data;
  const form = $("#monitoring-editor-form");
  form.reset();
  form.elements.documentId.value = detail.id;
  form.dataset.documentEtag = detailResult.etag || `"${detail.rowVersion}"`;
  form.elements.periodStart.value = detail.periodStart || "";
  form.elements.periodEnd.value = detail.periodEnd || "";
  for (const field of MONITORING_TEMPLATE_FIELDS) form.elements[field].value = detail.payload?.[field] || "";
  clearFormError(form, $("#monitoring-editor-error"));
  openDialog($("#monitoring-editor-dialog"), trigger);
}

async function submitMonitoringEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#monitoring-editor-error");
  if (!validateForm(form, errorContainer)) return;
  const documentId = form.elements.documentId.value;
  const currentDetail = state.documentDetails.get(documentId)?.data;
  const payload = { ...(currentDetail?.payload || {}) };
  for (const field of MONITORING_TEMPLATE_FIELDS) payload[field] = optionalEditorValue(form.elements[field].value);
  const periodStart = form.elements.periodStart.value || null;
  const periodEnd = form.elements.periodEnd.value || null;
  if (periodStart && periodEnd && periodEnd < periodStart) return showFormError(form, errorContainer, "終了日は開始日以降にしてください。", ["periodEnd"]);
  state.conflictResumeDialog = $("#monitoring-editor-dialog");
  state.conflictReload = loadDocuments;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      etag: form.dataset.documentEtag,
      body: { payload, periodStart, periodEnd },
    });
    closeDialog($("#monitoring-editor-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadDocuments();
    announce("モニタリング帳票を保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function submitMonitoringResult(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#monitoring-result-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = { progressStatus: values.get("progressStatus") };
  for (const field of ["progressSummary", "currentChallenge", "nextSupportPolicy", "nextGoalAction"]) {
    const value = values.get(field)?.trim();
    body[field] = value || null;
  }
  state.conflictResumeDialog = $("#monitoring-result-dialog");
  state.conflictReload = loadDocuments;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(values.get("documentId"))}/monitoring-results/${encodeURIComponent(values.get("resultId"))}`, {
      method: "PATCH",
      etag: `"${values.get("rowVersion")}"`,
      body,
    });
    closeDialog($("#monitoring-result-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadDocuments();
    announce("モニタリング評価を保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function planEditorField(name, label, value, { rows = 3, type = "textarea", required = false } = {}) {
  const field = element("label", { className: "field field-wide" });
  const fieldLabel = element("span", { text: required ? `${label} 必須` : label });
  const control = element(type === "textarea" ? "textarea" : "input", {
    attributes: type === "textarea"
      ? { name, maxlength: "8000", rows: String(rows) }
      : { name, type, maxlength: "1000" },
  });
  control.value = value || "";
  if (required) control.required = true;
  field.append(fieldLabel, control);
  return field;
}

function renderPlanEditorGoals(goals = []) {
  const container = $("#plan-editor-goals");
  container.replaceChildren();
  if (!goals.length) {
    container.append(element("p", { text: "支援目標はまだ登録されていません。" }));
    return;
  }
  for (const [index, goal] of goals.entries()) {
    const card = element("article", { attributes: { "data-goal-id": goal.id, "data-goal-etag": `\"${goal.rowVersion}\"` } });
    card.append(element("h4", { text: `${goal.goalKind === "long_term" ? "長期" : "短期"}目標 ${index + 1}` }));
    const grid = element("div", { className: "field-grid" });
    grid.append(
      planEditorField("title", "目標", goal.title, { rows: 2, required: true }),
      planEditorField("desiredOutcome", "目指す状態", goal.desiredOutcome),
      planEditorField("supportDetails", "支援内容", goal.supportDetails, { rows: 4 }),
      planEditorField("evaluationMethod", "評価方法", goal.evaluationMethod),
      planEditorField("responsibleParty", "担当", goal.responsibleParty, { type: "text" }),
      planEditorField("targetDate", "目標時期", goal.targetDate, { type: "date" }),
    );
    card.append(grid);
    container.append(card);
  }
}

async function openPlanEditor(documentRecord, trigger) {
  if (!state.selectedChild || !["individual_support_plan", "specialized_support_plan"].includes(documentRecord.documentKind)) return;
  if (!EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) {
    announce("確定後の計画書は編集できません。新しい版を作成してください。");
    return;
  }
  const childId = encodeURIComponent(state.selectedChild.id);
  let detailResult = state.documentDetails.get(documentRecord.id);
  if (!detailResult) {
    detailResult = await api(`/children/${childId}/documents/${encodeURIComponent(documentRecord.id)}`);
    state.documentDetails.set(documentRecord.id, detailResult);
  }
  const detail = detailResult.data;
  const form = $("#plan-editor-form");
  form.reset();
  form.elements.documentId.value = detail.id;
  form.dataset.documentKind = detail.documentKind;
  form.dataset.documentEtag = detailResult.etag || `\"${detail.rowVersion}\"`;
  form.elements.periodStart.value = detail.periodStart || "";
  form.elements.periodEnd.value = detail.periodEnd || "";
  const planIsEmpty = INDIVIDUAL_PLAN_PAYLOAD_FIELDS.every(([field]) => !detail.payload?.[field]);
  const assessmentRecord = latestDocument("basic_assessment");
  let assessmentDetail = assessmentRecord ? state.documentDetails.get(assessmentRecord.id)?.data : null;
  if (planIsEmpty && assessmentRecord && !assessmentDetail) {
    const assessmentResult = await api(`/children/${childId}/documents/${encodeURIComponent(assessmentRecord.id)}`);
    assessmentDetail = assessmentResult.data;
    state.documentDetails.set(assessmentRecord.id, assessmentResult);
  }
  const suggestedValues = planIsEmpty ? planDraftValuesFromAssessment(assessmentDetail) : {};
  for (const [field] of INDIVIDUAL_PLAN_PAYLOAD_FIELDS) form.elements[field].value = detail.payload?.[field] || suggestedValues[field] || "";
  for (const field of PLAN_TEMPLATE_FIELDS) form.elements[field].value = detail.payload?.[field] || "";
  installPlanWritingTools(form);
  $$('[data-plan-length]', form).forEach(syncCustomTargetLength);
  updateAllPlanCharacterCounts(form);
  renderPlanEditorGoals(detail.goals || []);
  clearFormError(form, $("#plan-editor-error"));
  openDialog($("#plan-editor-dialog"), trigger);
}

function planDraftValuesFromAssessment(assessment) {
  const payload = assessment?.payload || {};
  const sections = payload.assessment || {};
  const text = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
  const childWish = text(payload.childWishes, sections.personWish);
  const familyWish = text(payload.familyWishes, sections.familyWish);
  return {
    userAndFamilyWishes: [childWish ? `本人: ${childWish}` : "", familyWish ? `家族: ${familyWish}` : ""].filter(Boolean).join("\n"),
    overallSupportPolicy: text(payload.overallAssessment, sections.overallAssessment, sections.supportDirection),
    supportConsiderations: text(payload.supportConsiderations, sections.supportDirection),
    serviceDelivery: text(payload.planningNotes, sections.planningNotes),
    coordination: text(payload.supportNetwork),
  };
}

async function openAssessmentEditor(documentRecord, trigger) {
  if (!state.selectedChild || documentRecord.documentKind !== "basic_assessment") return;
  if (!EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) {
    announce("確定後のアセスメントは編集できません。新しい版を作成してください。");
    return;
  }
  const childId = encodeURIComponent(state.selectedChild.id);
  let detailResult = state.documentDetails.get(documentRecord.id);
  if (!detailResult) {
    detailResult = await api(`/children/${childId}/documents/${encodeURIComponent(documentRecord.id)}`);
    state.documentDetails.set(documentRecord.id, detailResult);
  }
  const detail = detailResult.data;
  const form = $("#assessment-editor-form");
  form.reset();
  form.elements.documentId.value = detail.id;
  form.dataset.documentEtag = detailResult.etag || `"${detail.rowVersion}"`;
  for (const [field, assessmentField] of ASSESSMENT_EDITOR_FIELDS) {
    form.elements[field].value = detail.payload?.[field] || (assessmentField ? detail.payload?.assessment?.[assessmentField] : "") || "";
  }
  for (const field of ASSESSMENT_TEMPLATE_FIELDS) form.elements[field].value = detail.payload?.[field] || "";
  installAssessmentWritingTools(form);
  $$('[data-assessment-length]', form).forEach(syncCustomTargetLength);
  updateAllAssessmentCharacterCounts(form);
  clearFormError(form, $("#assessment-editor-error"));
  openDialog($("#assessment-editor-dialog"), trigger);
}

async function openReferencePlanEditor(documentRecord, trigger) {
  if (!state.selectedChild || documentRecord.documentKind !== "consultation_plan") return;
  if (!EDITABLE_DOCUMENT_STATUSES.includes(documentRecord.status)) {
    announce("確定後の参考資料は編集できません。必要な場合は新しい版を登録してください。");
    return;
  }
  const childId = encodeURIComponent(state.selectedChild.id);
  let detailResult = state.documentDetails.get(documentRecord.id);
  if (!detailResult) {
    detailResult = await api(`/children/${childId}/documents/${encodeURIComponent(documentRecord.id)}`);
    state.documentDetails.set(documentRecord.id, detailResult);
  }
  const detail = detailResult.data;
  const form = $("#reference-plan-editor-form");
  form.reset();
  form.elements.documentId.value = detail.id;
  form.dataset.documentEtag = detailResult.etag || `"${detail.rowVersion}"`;
  for (const field of REFERENCE_PLAN_PAYLOAD_FIELDS) form.elements[field].value = detail.payload?.[field] || "";
  renderReferenceAttachments($("#reference-plan-attachments"), detail, detail.attachments || [], true);
  clearFormError(form, $("#reference-plan-editor-error"));
  openDialog($("#reference-plan-editor-dialog"), trigger);
}

async function openReferenceMaterialViewer(documentRecord, trigger) {
  if (!state.selectedChild || documentRecord.documentKind !== "consultation_plan") return;
  const childId = encodeURIComponent(state.selectedChild.id);
  let detailResult = state.documentDetails.get(documentRecord.id);
  if (!detailResult) {
    detailResult = await api(`/children/${childId}/documents/${encodeURIComponent(documentRecord.id)}`);
    state.documentDetails.set(documentRecord.id, detailResult);
  }
  const content = $("#reference-material-view-content");
  content.replaceChildren();
  for (const field of REFERENCE_PLAN_PAYLOAD_FIELDS) {
    const value = detailResult.data.payload?.[field]?.trim();
    content.append(element("section", { className: "reference-material-field" }, [
      element("strong", { text: REFERENCE_PLAN_FIELD_LABELS[field] }),
      element("p", { className: value ? "" : "is-empty", text: value || "未入力" }),
    ]));
  }
  renderReferenceAttachments($("#reference-material-view-attachments"), detailResult.data, detailResult.data.attachments || []);
  const dialog = $("#reference-material-view-dialog");
  const removeButton = $("#delete-reference-material-button");
  // 確認画面では削除場所を常に明示します。実行時の権限確認はAPIが必ず行います。
  const canRemove = !["superseded", "closed", "void"].includes(documentRecord.status);
  removeButton.hidden = !canRemove;
  removeButton.onclick = canRemove ? () => runAsync(async () => {
    const removed = await removeReferenceMaterial(documentRecord, removeButton);
    if (removed) closeDialog(dialog);
  }) : null;
  openDialog(dialog, trigger);
}

async function removeReferenceMaterial(documentRecord, trigger) {
  if (!state.selectedChild || documentRecord.documentKind !== "consultation_plan") return false;
  const confirmed = window.confirm("この参考資料を削除しますか？\n一覧には表示されなくなりますが、操作履歴は保存されます。");
  if (!confirmed) return false;
  trigger.disabled = true;
  try {
    await api(
      `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}/reference-material`,
      {
        method: "DELETE",
        etag: `"${documentRecord.rowVersion}"`,
      },
    );
    await loadDocuments();
    announce("参考資料を削除しました。");
    return true;
  } finally {
    if (trigger.isConnected) trigger.disabled = false;
  }
}

function optionalEditorValue(value) {
  const text = value?.trim();
  return text || null;
}

async function submitPlanEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#plan-editor-error");
  if (!validateForm(form, errorContainer)) return;
  const documentId = form.elements.documentId.value;
  const currentDetail = state.documentDetails.get(documentId)?.data;
  const payload = { ...(currentDetail?.payload || {}) };
  for (const [field] of INDIVIDUAL_PLAN_PAYLOAD_FIELDS) payload[field] = optionalEditorValue(form.elements[field].value);
  for (const field of PLAN_TEMPLATE_FIELDS) payload[field] = optionalEditorValue(form.elements[field].value);
  const body = {
    periodStart: form.elements.periodStart.value || null,
    periodEnd: form.elements.periodEnd.value || null,
    payload,
  };
  if (body.periodStart && body.periodEnd && body.periodEnd < body.periodStart) {
    return showFormError(form, errorContainer, "終了日は開始日以降にしてください。", ["periodEnd"]);
  }
  state.conflictResumeDialog = $("#plan-editor-dialog");
  state.conflictReload = loadDocuments;
  try {
    const childId = encodeURIComponent(state.selectedChild.id);
    await api(`/children/${childId}/documents/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      etag: form.dataset.documentEtag,
      body,
    });
    for (const goalCard of $$("[data-goal-id]", $("#plan-editor-goals"))) {
      const goalBody = {
        title: optionalEditorValue($("[name=title]", goalCard)?.value),
        desiredOutcome: optionalEditorValue($("[name=desiredOutcome]", goalCard)?.value),
        supportDetails: optionalEditorValue($("[name=supportDetails]", goalCard)?.value),
        evaluationMethod: optionalEditorValue($("[name=evaluationMethod]", goalCard)?.value),
        responsibleParty: optionalEditorValue($("[name=responsibleParty]", goalCard)?.value),
        targetDate: $("[name=targetDate]", goalCard)?.value || null,
      };
      await api(`/children/${childId}/documents/${encodeURIComponent(documentId)}/goals/${encodeURIComponent(goalCard.dataset.goalId)}`, {
        method: "PATCH",
        etag: goalCard.dataset.goalEtag,
        body: goalBody,
      });
    }
    closeDialog($("#plan-editor-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadDocuments();
    announce("計画書を保存しました。必要に応じてPDFを作成してください。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function submitAssessmentEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#assessment-editor-error");
  const documentId = form.elements.documentId.value;
  const currentDetail = state.documentDetails.get(documentId)?.data;
  const payload = { ...(currentDetail?.payload || {}) };
  const assessment = { ...(payload.assessment || {}) };
  for (const [field, assessmentField] of ASSESSMENT_EDITOR_FIELDS) {
    const value = optionalEditorValue(form.elements[field].value);
    payload[field] = value;
    if (assessmentField) assessment[assessmentField] = value;
  }
  for (const field of ASSESSMENT_TEMPLATE_FIELDS) payload[field] = optionalEditorValue(form.elements[field].value);
  payload.assessment = assessment;
  state.conflictResumeDialog = $("#assessment-editor-dialog");
  state.conflictReload = loadDocuments;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      etag: form.dataset.documentEtag,
      body: { payload },
    });
    closeDialog($("#assessment-editor-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadDocuments();
    announce("アセスメントを保存しました。内容を確認してから、個別支援計画を作成してください。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

async function submitReferencePlanEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#reference-plan-editor-error");
  const documentId = form.elements.documentId.value;
  const currentDetail = state.documentDetails.get(documentId)?.data;
  const payload = { ...(currentDetail?.payload || {}) };
  for (const field of REFERENCE_PLAN_PAYLOAD_FIELDS) payload[field] = optionalEditorValue(form.elements[field].value);
  const file = form.elements.referenceFile?.files?.[0] || null;
  state.conflictResumeDialog = $("#reference-plan-editor-dialog");
  state.conflictReload = loadDocuments;
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      etag: form.dataset.documentEtag,
      body: { payload },
    });
    if (file) await uploadReferenceAttachment(documentId, file);
    closeDialog($("#reference-plan-editor-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadDocuments();
    announce(file ? "参考資料と入力内容を保存しました。" : "参考資料の入力内容を保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function renderFacilityAdmin() {
  const container = $("#facility-admin-list");
  if (!container || !can("tenant.manage")) return;
  container.replaceChildren();
  for (const facility of state.facilities) {
    const card = element("article", { className: "facility-admin-card" });
    const copy = element("div");
    copy.append(element("h3", { text: facility.name }), element("p", { text: `${facility.code} ／ ${facility.serviceType || "放課後等デイサービス"}` }));
    const status = element("span", { className: `status-chip status-${facility.status}`, text: facility.status === "inactive" ? "利用停止" : "利用中" });
    const edit = element("button", { className: "button button-secondary", text: "事業所を編集", attributes: { type: "button" } });
    edit.addEventListener("click", () => openFacilityEdit(facility, edit));
    card.append(copy, status, edit);
    container.append(card);
  }
}

async function refreshFacilities({ resetSelection = false } = {}) {
  const { data } = await api("/facilities");
  state.facilities = data.items || [];
  const current = state.facilities.find((facility) => facility.id === state.facilityId && facility.status !== "inactive");
  if (resetSelection || !current) state.facilityId = state.facilities.find((facility) => facility.status !== "inactive")?.id || null;
  renderFacilities();
  renderFacilityAdmin();
}

function openFacilityCreate(trigger) {
  const form = $("#facility-create-form");
  form.reset();
  form.elements.serviceType.value = "放課後等デイサービス";
  form.elements.timezone.value = "Asia/Tokyo";
  clearFormError(form, $("#facility-create-error"));
  openDialog($("#facility-create-dialog"), trigger);
}

async function submitFacilityCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#facility-create-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = { code: values.get("code").trim(), name: values.get("name").trim(), serviceType: values.get("serviceType").trim(), timezone: "Asia/Tokyo" };
  state.conflictReload = () => refreshFacilities();
  try {
    await idempotentCreate("/facilities", body);
    closeDialog($("#facility-create-dialog"));
    await refreshFacilities();
    state.conflictReload = null;
    announce(`${body.name}を追加しました。`);
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function openFacilityEdit(facility, trigger) {
  const form = $("#facility-edit-form");
  form.reset();
  form.elements.facilityId.value = facility.id;
  form.elements.rowVersion.value = facility.rowVersion;
  for (const field of ["code", "name", "serviceType", "status"]) form.elements[field].value = facility[field] || (field === "status" ? "active" : "");
  clearFormError(form, $("#facility-edit-error"));
  openDialog($("#facility-edit-dialog"), trigger);
}

async function submitFacilityEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#facility-edit-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = { code: values.get("code").trim(), name: values.get("name").trim(), serviceType: values.get("serviceType").trim(), status: values.get("status"), timezone: "Asia/Tokyo" };
  state.conflictResumeDialog = $("#facility-edit-dialog");
  state.conflictReload = async () => refreshFacilities();
  try {
    await api(`/facilities/${encodeURIComponent(values.get("facilityId"))}`, { method: "PATCH", etag: `"${values.get("rowVersion")}"`, body });
    closeDialog($("#facility-edit-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    const changedCurrent = values.get("facilityId") === state.facilityId && body.status === "inactive";
    await refreshFacilities({ resetSelection: changedCurrent });
    if (changedCurrent) {
      state.selectedChild = null;
      state.selectedChildEtag = null;
      updateSelectedChildChrome();
      await loadChildren();
      await loadActiveResource();
    }
    announce("事業所情報を更新しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

const AUDIT_ACTION_LABELS = Object.freeze({
  "facility.created": "事業所を追加", "facility.updated": "事業所を更新", "staff.invited": "職員を招待", "staff.membership_updated": "職員権限を更新", "guardian.created": "保護者を登録", "guardian.updated": "保護者を更新", "schedule.created": "週間予定を作成", "schedule.updated": "週間予定を更新", "schedule.finalized": "週間予定を確定", "daily_log.created": "日誌を登録", "daily_log.updated": "日誌を編集", "daily_log.deleted": "日誌を削除", "contact_book.created": "連絡帳を登録", "contact_book.updated": "連絡帳を編集", "contact_book.deleted": "連絡帳を削除", "case_document.draft_generated": "書類下書きを生成",
});

function renderAuditEvents() {
  const container = $("#audit-list");
  if (!container || !can("audit.view")) return;
  container.replaceChildren();
  if (!state.auditEvents.length) return renderListEmpty(container, "監査履歴はまだありません");
  container.className = "audit-list";
  const table = element("table");
  table.append(element("caption", { className: "visually-hidden", text: "直近の監査履歴" }));
  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["日時", "職員ID", "操作", "対象", "結果"]) headRow.append(element("th", { text: label, attributes: { scope: "col" } }));
  head.append(headRow);
  const body = element("tbody");
  for (const event of state.auditEvents) {
    const row = element("tr");
    row.append(
      element("td", { text: formatDate(event.occurredAt, true) }),
      element("td", { text: event.actorUserId || "システム" }),
      element("td", { text: AUDIT_ACTION_LABELS[event.action] || event.action }),
      element("td", { text: `${event.resourceType}${event.resourceId ? ` / ${event.resourceId}` : ""}` }),
      element("td", { text: event.outcome === "failed" ? "失敗" : "成功" }),
    );
    body.append(row);
  }
  table.append(head, body);
  container.append(table);
}

async function loadAuditEvents() {
  if (!can("audit.view")) return;
  const { data } = await api("/audit-events?limit=30");
  state.auditEvents = data.items || [];
  renderAuditEvents();
}

function availableStaffRoles() {
  return ["support_staff"];
}

function populateRoleSelect(select, selected = "support_staff") {
  select.replaceChildren();
  for (const role of availableStaffRoles()) {
    const option = element("option", { text: ROLE_LABELS[role] || role, attributes: { value: role } });
    option.selected = role === selected;
    select.append(option);
  }
}

function populateFacilityChecks(container, selectedIds = []) {
  container.replaceChildren();
  for (const facility of state.facilities.filter((item) => item.status !== "inactive" || selectedIds.includes(item.id))) {
    const label = element("label");
    const input = element("input", { attributes: { type: "checkbox", name: "facilityIds", value: facility.id } });
    input.checked = selectedIds.includes(facility.id);
    label.append(input, element("span", { text: facility.name }));
    container.append(label);
  }
}

function renderStaff() {
  const container = $("#staff-list");
  container.replaceChildren();
  if (!state.staff.length) return renderListEmpty(container, "表示できる職員はいません");
  container.className = "staff-list";
  for (const staff of state.staff) {
    const card = element("article", { className: "staff-card" });
    const identity = element("div", { className: "staff-identity" });
    identity.append(element("h2", { text: staff.displayName }), element("a", { text: staff.email, attributes: { href: `mailto:${staff.email}` } }));
    const role = element("div", { className: "staff-role" });
    role.append(element("strong", { text: ROLE_LABELS[staff.role] || staff.role }), element("span", { className: `status-chip status-${staff.status}`, text: STAFF_STATUS_LABELS[staff.status] || staff.status }));
    const facilityNames = staff.facilityIds?.map((id) => state.facilities.find((facility) => facility.id === id)?.name || "担当外の事業所") || [];
    const facilities = element("p", { text: staff.role === "tenant_admin" && !facilityNames.length ? "すべての事業所" : facilityNames.join("、") || "事業所未設定" });
    const actions = element("div", { className: "staff-actions" });
    let invitationWarning = null;
    if (["failed", "sent"].includes(staff.invitation?.status)) {
      const resend = element("button", { className: "button button-primary", text: "招待メールを再送", attributes: { type: "button" } });
      resend.addEventListener("click", () => runAsync(() => resendStaffInvitation(staff, resend)));
      actions.append(resend);
      invitationWarning = element("p", {
        className: "invitation-warning",
        text: staff.invitation.status === "failed"
          ? "招待メールを送信できていません。再送してください。"
          : "初回ログイン前にメールを紛失・期限切れにした場合は再送できます。",
        attributes: { role: "status" },
      });
    }
    const edit = element("button", { className: "button button-secondary", text: "役割・所属を編集", attributes: { type: "button" } });
    edit.addEventListener("click", () => openStaffEdit(staff, edit));
    actions.append(edit);
    card.append(identity, role, facilities, actions);
    if (invitationWarning) card.append(invitationWarning);
    container.append(card);
  }
}

async function loadStaff() {
  if (!can("staff.manage")) return;
  const { data } = await api("/staff");
  state.staff = data.items || [];
  renderStaff();
}

async function resendStaffInvitation(staff, button) {
  button.disabled = true;
  try {
    await idempotentCreate(`/staff/${encodeURIComponent(staff.membershipId)}/invitation-resends`, {});
    await loadStaff();
    announce(`${staff.displayName}さんへ招待メールを再送しました。`);
  } catch (error) {
    announce(errorMessage(error));
    button.disabled = false;
    throw error;
  }
}

function openStaffInvite(trigger) {
  const form = $("#staff-invite-form");
  form.reset();
  populateRoleSelect(form.elements.role);
  populateFacilityChecks($("#invite-facility-options"));
  clearFormError(form, $("#staff-invite-error"));
  openDialog($("#staff-invite-dialog"), trigger);
}

function selectedFacilityIds(form) {
  return new FormData(form).getAll("facilityIds");
}

async function submitStaffInvite(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#staff-invite-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = {
    displayName: values.get("displayName").trim(),
    email: values.get("email").trim(),
    role: values.get("role"),
    facilityIds: selectedFacilityIds(form),
  };
  if (body.role !== "tenant_admin" && !body.facilityIds.length) return showFormError(form, errorContainer, "担当事業所を1件以上選択してください。", []);
  state.conflictReload = loadStaff;
  try {
    await idempotentCreate("/staff/invitations", body);
    closeDialog($("#staff-invite-dialog"));
    await loadStaff();
    state.conflictReload = null;
    announce(`${body.displayName}さんを招待しました。`);
  } catch (error) {
    if (error.code === "STAFF_INVITATION_DELIVERY_FAILED") {
      closeDialog($("#staff-invite-dialog"));
      await loadStaff();
      state.conflictReload = null;
      announce("職員情報は登録されました。職員一覧から招待メールを再送してください。");
    } else if (error.status !== 409) {
      showFormError(form, errorContainer, errorMessage(error), []);
    }
  }
}

function openStaffEdit(staff, trigger) {
  const form = $("#staff-edit-form");
  form.reset();
  form.elements.membershipId.value = staff.membershipId;
  form.elements.rowVersion.value = staff.rowVersion;
  populateRoleSelect(form.elements.role, staff.role);
  form.elements.status.value = staff.status;
  populateFacilityChecks($("#edit-facility-options"), staff.facilityIds || []);
  $("#staff-edit-name").textContent = `${staff.displayName}（${staff.email}）`;
  clearFormError(form, $("#staff-edit-error"));
  openDialog($("#staff-edit-dialog"), trigger);
}

async function submitStaffEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#staff-edit-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = { role: values.get("role"), status: values.get("status"), facilityIds: selectedFacilityIds(form) };
  if (body.role !== "tenant_admin" && !body.facilityIds.length) return showFormError(form, errorContainer, "担当事業所を1件以上選択してください。", []);
  state.conflictResumeDialog = $("#staff-edit-dialog");
  state.conflictReload = loadStaff;
  try {
    await api(`/staff/${encodeURIComponent(values.get("membershipId"))}`, { method: "PATCH", etag: `"${values.get("rowVersion")}"`, body });
    closeDialog($("#staff-edit-dialog"));
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadStaff();
    announce("職員の役割と所属を更新しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function workflowActionsForStatus(status, documentKind) {
  if (!["individual_support_plan", "specialized_support_plan"].includes(documentKind)) return [];
  const transitions = {
    draft: ["submit", "void"],
    internal_review: ["return", "explain", "void"],
    explanation_pending: ["return", "consent", "void"],
    consented: ["return", "approve", "void"],
    approved: ["distribute", "void"],
    distributed: ["activate", "void"],
    active: ["supersede", "close", "void"],
  };
  return (transitions[status] || []).filter((action) => action === "submit" ? can("documents.edit") : can("documents.approve"));
}

async function openWorkflow(documentRecord, trigger) {
  if (!["individual_support_plan", "specialized_support_plan"].includes(documentRecord.documentKind)) return;
  const result = await api(`/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}/workflow`);
  state.workflow = result.data;
  state.workflowEtag = result.etag || `"${result.data.document.rowVersion}"`;
  renderWorkflow();
  openDialog($("#workflow-dialog"), trigger);
}

function renderWorkflow() {
  const workflow = state.workflow;
  if (!workflow) return;
  const documentRecord = workflow.document;
  $("#workflow-document-summary").textContent = `${DOCUMENT_KIND_LABELS[documentRecord.documentKind]} 第${documentRecord.versionNumber}版 ／ ${DOCUMENT_STATUS_LABELS[documentRecord.status] || documentRecord.status}`;
  const actions = $("#workflow-actions");
  actions.replaceChildren();
  for (const action of workflowActionsForStatus(documentRecord.status, documentRecord.documentKind)) {
    const config = WORKFLOW_ACTIONS[action];
    const button = element("button", { className: action === "void" ? "button button-danger" : "button button-primary", text: config.label, attributes: { type: "button" } });
    button.addEventListener("click", () => runAsync(() => openTransition(action, button)));
    actions.append(button);
  }
  if (!actions.childElementCount) actions.append(element("p", { text: "現在の役割で実行できる操作はありません。" }));
  const events = $("#workflow-events");
  events.replaceChildren();
  for (const event of workflow.events || []) {
    const item = element("li");
    item.append(element("strong", { text: WORKFLOW_EVENT_LABELS[event.eventType] || event.eventType }), element("time", { text: formatDate(event.eventAt, true), attributes: { datetime: event.eventAt } }), element("span", { text: `${event.actorNameSnapshot || "職員"}（${ROLE_LABELS[event.actorRoleSnapshot] || event.actorRoleSnapshot || "役割不明"}）` }));
    if (event.reason) item.append(element("p", { text: `理由：${event.reason}` }));
    events.append(item);
  }
  if (!events.childElementCount) events.append(element("li", { text: "まだ工程履歴はありません。" }));
}

function localDateTimeValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

async function openTransition(action, trigger) {
  const form = $("#transition-form");
  const submitButton = $("#submit-transition");
  form.reset();
  state.consentIntent = null;
  form.elements.action.value = action;
  $("#transition-dialog-title").textContent = WORKFLOW_ACTIONS[action].label;
  $("#transition-dialog-description").textContent = WORKFLOW_ACTIONS[action].description;
  const reasonRequired = ["return", "supersede", "close", "void"].includes(action);
  $("#transition-reason-fields").hidden = !reasonRequired;
  $("#transition-consent-fields").hidden = action !== "consent";
  $("#transition-distribution-fields").hidden = action !== "distribute";
  form.elements.reason.required = reasonRequired;
  for (const field of ["signerName", "signerRelationship", "explainedAt", "consentedAt"]) form.elements[field].required = action === "consent";
  for (const field of ["recipientName", "distributedAt"]) form.elements[field].required = action === "distribute";
  if (action === "consent") form.elements.explainedAt.value = form.elements.consentedAt.value = localDateTimeValue();
  if (action === "distribute") form.elements.distributedAt.value = localDateTimeValue();
  submitButton.disabled = action === "consent";
  clearFormError(form, $("#transition-error"));
  closeDialog($("#workflow-dialog"));
  openDialog($("#transition-dialog"), trigger);
  if (action !== "consent") return;

  $("#transition-dialog-description").textContent = "同意対象が最新の計画内容と一致しているか確認しています。";
  state.conflictResumeDialog = $("#transition-dialog");
  state.conflictReload = async () => {
    const documentRecord = state.workflow?.document;
    if (documentRecord) await openWorkflow(documentRecord, $("#main-content"));
  };
  try {
    const { data } = await api(
      `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(state.workflow.document.id)}/consent-intents`,
      { method: "POST", etag: state.workflowEtag },
    );
    state.consentIntent = data;
    $("#transition-dialog-description").textContent = "現在の計画内容を同意対象として確認しました。5分以内に説明・同意を記録してください。";
    submitButton.disabled = false;
  } catch (error) {
    state.consentIntent = null;
    if (error.status !== 409) showFormError(form, $("#transition-error"), errorMessage(error), []);
  }
}

async function submitTransition(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#transition-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const action = values.get("action");
  const body = { action };
  if (["return", "supersede", "close", "void"].includes(action)) body.reason = values.get("reason").trim();
  if (action === "consent" && Date.parse(values.get("consentedAt")) < Date.parse(values.get("explainedAt"))) {
    return showFormError(form, errorContainer, "同意日時は説明日時以降にしてください。", ["consentedAt"]);
  }
  if (action === "consent") {
    if (!state.consentIntent) {
      return showFormError(form, errorContainer, "同意対象の確認が完了していません。画面を開き直してください。", []);
    }
    body.consent = {
      signerName: values.get("signerName").trim(),
      signerRelationship: values.get("signerRelationship").trim(),
      explanationMethod: values.get("explanationMethod"),
      explainedAt: new Date(values.get("explainedAt")).toISOString(),
      consentedAt: new Date(values.get("consentedAt")).toISOString(),
      sourceReview: {
        token: state.consentIntent.token,
        expectedSourceHash: state.consentIntent.sourceHash,
        targetVersionNumber: state.consentIntent.targetVersionNumber,
        documentRowVersion: state.consentIntent.documentRowVersion,
      },
    };
  }
  if (action === "distribute") body.distribution = { recipientName: values.get("recipientName").trim(), deliveryMethod: values.get("deliveryMethod"), distributedAt: new Date(values.get("distributedAt")).toISOString() };
  state.conflictResumeDialog = $("#transition-dialog");
  state.conflictReload = async () => {
    const documentRecord = state.workflow?.document;
    if (documentRecord) await openWorkflow(documentRecord, $("#main-content"));
  };
  try {
    await api(`/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(state.workflow.document.id)}/transitions`, { method: "POST", etag: state.workflowEtag, body });
    closeDialog($("#transition-dialog"));
    state.consentIntent = null;
    state.conflictResumeDialog = null;
    state.conflictReload = null;
    await loadDocuments();
    const updated = latestDocument(state.workflow.document.documentKind);
    if (updated) await openWorkflow(updated, $("#main-content"));
    announce(`${WORKFLOW_ACTIONS[action].label}を記録しました。`);
  } catch (error) {
    if (action === "consent") {
      state.consentIntent = null;
      $("#submit-transition").disabled = true;
      $("#transition-dialog-description").textContent = "計画内容が更新された可能性があります。最新内容を読み込み、同意画面を開き直してください。";
    }
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function showConflict(error) {
  const dialog = $("#conflict-dialog");
  const isExistingDraft = error.code === "DRAFT_EXISTS";
  const isLastAdmin = error.code === "LAST_TENANT_ADMIN";
  const isStaffRegistered = error.code === "STAFF_ALREADY_REGISTERED";
  const isDuplicate = error.code === "DUPLICATE";
  const isInvalidTransition = error.code === "INVALID_TRANSITION";
  const isImmutable = ["IMMUTABLE_SCHEDULE", "IMMUTABLE_DOCUMENT"].includes(error.code);
  const isPdfStatusChanged = ["DRAFT_PDF_NOT_AVAILABLE", "OFFICIAL_PDF_NOT_AVAILABLE"].includes(error.code);
  $("#conflict-title").textContent = isExistingDraft
    ? "編集中の下書きがすでにあります"
    : isLastAdmin ? "最後の管理者は変更できません"
      : isStaffRegistered ? "この職員は登録済みです"
        : isDuplicate ? "同じ情報がすでに登録されています"
      : isInvalidTransition ? "文書の工程が変わりました"
        : isImmutable ? "確定済みの内容は上書きできません"
          : isPdfStatusChanged ? "PDFを作成できる工程が変わりました"
          : "別の職員が先に更新しました";
  $("#conflict-description").textContent = isExistingDraft
    ? "同じ種類の下書きを重複して作らないよう、作成を中止しました。既存の下書きを確認してください。"
    : isLastAdmin ? "有効な管理者を1名以上残す必要があります。別の職員を管理者にしてから変更してください。"
      : isStaffRegistered ? "同じメールアドレスの職員を重複登録しないよう、招待を中止しました。職員一覧を確認してください。"
        : isDuplicate ? "管理番号や事業所コードが重複しています。最新の一覧を確認し、別のコードを指定してください。"
      : isInvalidTransition ? "別の職員が工程を進めた可能性があります。最新の工程を読み込んでください。"
        : isImmutable ? "確定した記録を守るため保存を中止しました。必要な場合は新しい版を作成してください。"
          : isPdfStatusChanged ? "別の職員が文書の工程を進めた可能性があります。最新の状態を読み込み、表示された種類のPDFを作成してください。"
          : "上書きによる記録の消失を防ぐため、保存を中止しました。入力内容はこの画面に保持されています。";
  const detail = $("#conflict-detail");
  detail.replaceChildren();
  const values = [
    ["最終更新", error.details?.updatedAt ? formatDate(error.details.updatedAt, true) : null],
  ].filter(([, value]) => value !== null && value !== undefined);
  detail.hidden = values.length === 0;
  for (const [label, value] of values) detail.append(element("dt", { text: label }), element("dd", { text: value }));
  if (!state.conflictResumeDialog) {
    state.conflictResumeDialog = $$('dialog[open]').find((openDialogElement) => openDialogElement !== dialog) || null;
  }
  if (state.conflictResumeDialog?.open) closeDialog(state.conflictResumeDialog);
  openDialog(dialog, document.activeElement);
}

async function reloadAfterConflict() {
  closeDialog($("#conflict-dialog"));
  if (state.conflictReload) {
    const reload = state.conflictReload;
    state.conflictReload = null;
    await reload();
  } else if (state.selectedChild) {
    const { data, etag } = await api(`/children/${encodeURIComponent(state.selectedChild.id)}`);
    state.selectedChild = data;
    state.selectedChildEtag = etag || `"${data.rowVersion}"`;
    updateSelectedChildChrome();
    await loadActiveResource();
  }
  state.conflictResumeDialog = null;
  setSaveState("synced");
  announce("最新の内容を読み込みました。");
}

function returnToEdit() {
  const resumeDialog = state.conflictResumeDialog;
  closeDialog($("#conflict-dialog"));
  setSaveState(navigator.onLine ? "synced" : "offline");
  if (resumeDialog) window.setTimeout(() => openDialog(resumeDialog, document.activeElement), 0);
}

function setupEvents() {
  $$('[data-journal-length]').forEach((select) => installCustomTargetLength(select, JOURNAL_FIELD_LABELS[select.dataset.journalLength] || "日誌", "journal-custom-target-length"));
  const contactTargetSelect = $("[data-contact-reply-length]");
  installCustomTargetLength(contactTargetSelect, "事業所からの連絡", "contact-custom-target-length");
  $("#open-child-picker").addEventListener("click", (event) => {
    $("#child-search-input").value = "";
    renderChildPicker();
    openDialog($("#child-picker-dialog"), event.currentTarget);
  });
  $$('[data-open-child-picker]').forEach((button) => button.addEventListener("click", (event) => {
    $("#child-search-input").value = "";
    renderChildPicker();
    openDialog($("#child-picker-dialog"), event.currentTarget);
  }));
  $("#child-search-input").addEventListener("input", renderChildPicker);
  $("#open-child-register")?.addEventListener("click", (event) => openChildRegistration(event.currentTarget));
  $("#edit-child-button")?.addEventListener("click", (event) => openChildEdit(event.currentTarget));
  $("#change-child-photo-button")?.addEventListener("click", () => $("#child-photo-input")?.click());
  $("#child-photo-input")?.addEventListener("change", (event) => {
    // `currentTarget` is cleared after this listener returns. Capture the file
    // before handing the asynchronous upload to the shared error handler.
    const file = event.currentTarget?.files?.[0];
    runAsync(() => submitChildProfilePhoto(file));
  });
  $("#remove-child-photo-button")?.addEventListener("click", () => runAsync(deleteChildProfilePhoto));
  $("#open-child-delete-dialog")?.addEventListener("click", (event) => openChildDeleteDialog(event.currentTarget));
  $("#create-journal-button")?.addEventListener("click", (event) => openJournalDialog(event.currentTarget));
  $("#save-journal-draft")?.addEventListener("click", () => runAsync(saveJournalDraft));
  $$('[data-expand-journal-field]').forEach((button) => button.addEventListener("click", () => runAsync(() => generateJournalField(button.dataset.expandJournalField, button))));
  $$('[data-copy-journal-field]').forEach((button) => button.addEventListener("click", () => runAsync(() => copyFieldText($("#journal-form").elements[button.dataset.copyJournalField], button, JOURNAL_FIELD_LABELS[button.dataset.copyJournalField]))));
  $$("#journal-form textarea[name]").forEach((field) => field.addEventListener("input", () => updateJournalCharacterCount(field.name)));
  $$('[data-journal-length]').forEach((select) => {
    select.addEventListener("change", () => updateJournalCharacterCount(select.dataset.journalLength));
    $(".writing-custom-target-length", select.parentElement)?.addEventListener("input", () => updateJournalCharacterCount(select.dataset.journalLength));
  });
  $("#contact-form textarea[name=facilityReply]")?.addEventListener("input", () => updateContactReplyCharacterCount());
  contactTargetSelect?.addEventListener("change", () => updateContactReplyCharacterCount());
  if (contactTargetSelect?.parentElement) {
    $(".writing-custom-target-length", contactTargetSelect.parentElement)?.addEventListener("input", () => updateContactReplyCharacterCount());
  }
  $("#expand-contact-draft")?.addEventListener("click", () => runAsync(() => generateContactDraft($("#expand-contact-draft"))));
  $("#copy-contact-reply")?.addEventListener("click", () => runAsync(() => copyFieldText($("#contact-form").elements.facilityReply, $("#copy-contact-reply"), "事業所からの返信")));
  $("#contact-photo-input")?.addEventListener("change", () => renderContactPhotoPreview($("#contact-form")));
  $("#create-guardian-button")?.addEventListener("click", (event) => openGuardianDialog(event.currentTarget));
  $("#open-monitoring-generation")?.addEventListener("click", (event) => openMonitoringGeneration(event.currentTarget));
  $("#invite-staff-button")?.addEventListener("click", (event) => openStaffInvite(event.currentTarget));
  $("#create-facility-button")?.addEventListener("click", (event) => openFacilityCreate(event.currentTarget));
  $("#refresh-audit-button")?.addEventListener("click", () => runAsync(loadAuditEvents));
  $("#child-register-form")?.addEventListener("submit", submitChildRegistration);
  $("#child-edit-form")?.addEventListener("submit", submitChildEdit);
  $("#child-delete-form")?.addEventListener("submit", (event) => runAsync(() => submitChildDelete(event)));
  $("#journal-form")?.addEventListener("submit", submitJournal);
  $("#contact-form")?.addEventListener("submit", submitContact);
  $("#guardian-form")?.addEventListener("submit", submitGuardian);
  $("#monitoring-generation-form")?.addEventListener("submit", submitMonitoringGeneration);
  $("#monitoring-result-form")?.addEventListener("submit", submitMonitoringResult);
  $("#monitoring-editor-form")?.addEventListener("submit", submitMonitoringEditor);
  $("#plan-editor-form")?.addEventListener("submit", submitPlanEditor);
  $("#assessment-editor-form")?.addEventListener("submit", submitAssessmentEditor);
  $("#reference-plan-editor-form")?.addEventListener("submit", submitReferencePlanEditor);
  $("#staff-invite-form")?.addEventListener("submit", submitStaffInvite);
  $("#staff-edit-form")?.addEventListener("submit", submitStaffEdit);
  $("#facility-create-form")?.addEventListener("submit", submitFacilityCreate);
  $("#facility-edit-form")?.addEventListener("submit", submitFacilityEdit);
  $("#transition-form")?.addEventListener("submit", submitTransition);
  $("#logout-button")?.addEventListener("click", logoutFromHostedSession);
  $$('[data-create-document]').forEach((button) => button.addEventListener("click", () => createDocumentDraft(button)));
  $$('[data-generate-draft]').forEach((button) => button.addEventListener("click", () => runAsync(() => generateDraft(button))));
  $$('[data-view]').forEach((button) => button.addEventListener("click", () => runAsync(() => switchView(button.dataset.view, button))));
  $$('[data-child-panel]').forEach((tab) => {
    tab.addEventListener("click", () => switchChildPanel(tab.dataset.childPanel, tab));
    tab.addEventListener("keydown", (event) => {
      const tabs = $$('[data-child-panel]');
      const index = tabs.indexOf(tab);
      const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (nextIndex === null) return;
      event.preventDefault();
      switchChildPanel(tabs[nextIndex].dataset.childPanel, tabs[nextIndex]);
    });
  });
  $("#facility-select").addEventListener("change", (event) => runAsync(async () => {
    state.facilityId = event.currentTarget.value || null;
    renderFacilities();
    forgetSelectedChild();
    state.selectedChild = null;
    state.selectedChildEtag = null;
    state.guardians = [];
    state.schedules = { current: null, planned: null };
    state.documents = [];
    state.documentDetails.clear();
    state.documentSnapshots.clear();
    state.pdfErrors.clear();
    state.monitoringResults = [];
    updateSelectedChildChrome();
    await loadChildren();
    await loadActiveResource();
    announce("表示する事業所を切り替えました。");
  }));
  $("#reload-latest").addEventListener("click", () => runAsync(reloadAfterConflict));
  $("#return-to-edit").addEventListener("click", returnToEdit);
  window.addEventListener("offline", () => setSaveState("offline"));
  window.addEventListener("online", () => setSaveState("synced"));
  $$('form[novalidate] input, form[novalidate] select, form[novalidate] textarea').forEach((field) => {
    field.addEventListener("input", () => field.removeAttribute("aria-invalid"));
  });
}

async function initialize() {
  configureDialogs();
  try {
    const sessionResult = await api("/session");
    state.session = sessionResult.data;
    renderSession();
    applyPermissions();
    setupEvents();
    const facilitiesResult = await api("/facilities");
    state.facilities = facilitiesResult.data.items || [];
    const allowedFacilityIds = new Set(state.session.facilityIds || []);
    const remembered = rememberedChildSelection();
    const rememberedFacility = state.facilities.find((facility) => facility.id === remembered?.facilityId && facility.status !== "inactive" && allowedFacilityIds.has(facility.id));
    state.facilityId = rememberedFacility?.id
      || state.facilities.find((facility) => facility.status !== "inactive" && allowedFacilityIds.has(facility.id))?.id
      || state.facilities.find((facility) => facility.status !== "inactive")?.id
      || null;
    renderFacilities();
    await loadChildren();
    const rememberedChild = remembered?.facilityId === state.facilityId
      ? state.children.find((child) => child.id === remembered.childId)
      : null;
    if (rememberedChild) await selectChild(rememberedChild.id, { announceSelection: false });
    else if (remembered) forgetSelectedChild();
    renderJournals();
    renderContactEntries();
    renderDocuments();
    renderGuardians();
    $("#session-gate").hidden = true;
    $("#app-shell").hidden = false;
    setSaveState(navigator.onLine ? "synced" : "offline");
  } catch (error) {
    if (error.status === 401) return;
    $("#session-gate").hidden = true;
    $("#auth-error-message").textContent = errorMessage(error);
    $("#auth-error").hidden = false;
  }
}

initialize();
