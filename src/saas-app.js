const API_BASE = "/api/v1";

const ROLE_LABELS = Object.freeze({
  tenant_admin: "法人管理者",
  facility_admin: "事業所管理者",
  plan_approver: "計画承認者",
  support_staff: "支援員",
  viewer: "閲覧者",
  auditor: "監査担当",
});

const ROLE_PERMISSIONS = Object.freeze({
  tenant_admin: ["clients.edit", "journals.edit", "documents.edit", "documents.approve", "pdf.export", "staff.manage", "tenant.manage", "audit.view", "admin.view"],
  facility_admin: ["clients.edit", "journals.edit", "documents.edit", "documents.approve", "pdf.export", "staff.manage", "audit.view", "admin.view"],
  plan_approver: ["documents.edit", "documents.approve", "pdf.export"],
  support_staff: ["journals.edit", "documents.edit", "pdf.export"],
  viewer: [],
  auditor: ["pdf.export", "audit.view", "admin.view"],
});

const DOCUMENT_KIND_LABELS = Object.freeze({
  consultation_plan: "相談支援計画",
  basic_assessment: "アセスメント",
  individual_support_plan: "個別支援計画",
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
  draft: "下書き",
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
  const wrapper = element("div", { className: options.wide ? "wide" : "" });
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
      showConflict(error);
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
  $("#tenant-name").textContent = state.session.tenant?.name || "法人名未設定";
  $("#staff-name").textContent = state.session.user.displayName || "職員";
  $("#staff-role").textContent = ROLE_LABELS[state.session.user.role] || state.session.user.role;
}

function renderFacilities() {
  const select = $("#facility-select");
  select.replaceChildren();
  const activeFacilities = state.facilities.filter((facility) => facility.status !== "inactive");
  if (!activeFacilities.length) {
    select.append(element("option", { text: "利用できる事業所がありません", attributes: { value: "" } }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const facility of activeFacilities) {
    const option = element("option", { text: facility.name, attributes: { value: facility.id } });
    if (facility.id === state.facilityId) option.selected = true;
    select.append(option);
  }
}

function renderChildPicker() {
  const container = $("#child-picker-results");
  const query = $("#child-search-input").value.trim().toLocaleLowerCase("ja");
  const children = state.children.filter((child) => {
    const searchable = `${child.displayName} ${child.legalName} ${child.managementCode}`.toLocaleLowerCase("ja");
    return !query || searchable.includes(query);
  });
  container.replaceChildren();
  if (!children.length) {
    container.append(element("p", { className: "picker-empty", text: query ? "一致する利用児はいません。" : "この事業所には利用児が登録されていません。" }));
    return;
  }
  for (const child of children) {
    const listItem = element("div", { attributes: { role: "listitem" } });
    const button = element("button", { className: "picker-option", attributes: { type: "button" } });
    const avatar = element("span", { className: "picker-avatar", text: child.displayName.slice(0, 1), attributes: { "aria-hidden": "true" } });
    const copy = element("span");
    copy.append(
      element("strong", { text: child.displayName }),
      element("small", { text: `${child.managementCode} ／ ${child.grade || "学年未入力"}` }),
    );
    button.append(avatar, copy);
    button.addEventListener("click", () => runAsync(() => selectChild(child.id)));
    listItem.append(button);
    container.append(listItem);
  }
}

function updateSelectedChildChrome() {
  const child = state.selectedChild;
  $("#current-child-name").textContent = child?.displayName || "利用児を選択";
  $("#current-child-meta").textContent = child
    ? `${child.managementCode} ／ ${child.grade || "学年未入力"}`
    : "一覧から選んでください";
  renderChildDetail();
}

function renderChildDetail() {
  const container = $("#child-detail");
  const editButton = $("#edit-child-button");
  if (editButton) editButton.hidden = state.childPanel !== "basic" || !state.selectedChild || !can("clients.edit");
  container.replaceChildren();
  const child = state.selectedChild;
  if (!child) {
    container.className = "detail-sheet empty-state";
    container.append(element("strong", { text: "利用児が選択されていません" }), element("p", { text: "左側の「現在の利用児」から選択してください。" }));
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
  if (!state.selectedChild) return renderListEmpty(container, "利用児を選択してください");
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
    if (!guardian.isPrimary && can("clients.edit")) {
      const button = element("button", { className: "button button-ghost", text: "主連絡先にする", attributes: { type: "button" } });
      button.addEventListener("click", () => runAsync(() => makePrimaryGuardian(guardian, button)));
      card.append(button);
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
  if (!state.selectedChild) return announce("先に利用児を選択してください。");
  const form = $("#guardian-form");
  form.reset();
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
  for (const field of ["phone", "email"]) {
    const value = values.get(field)?.trim();
    if (value) body[field] = value;
  }
  try {
    await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/guardians`, body);
    closeDialog($("#guardian-dialog"));
    await loadGuardians();
    announce("保護者・連絡先を登録しました。");
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
  if (!state.selectedChild) return renderListEmpty(container, "利用児を選択してください");
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
      const finalize = element("button", { className: "button button-primary", text: "この版を確定", attributes: { type: "button" } });
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

function addScheduleItem(item = {}) {
  const fragment = $("#schedule-item-template").content.cloneNode(true);
  const row = $(".schedule-item-row", fragment);
  row.querySelector('[name="dayOfWeek"]').value = String(item.dayOfWeek ?? 1);
  row.querySelector('[name="startTime"]').value = formatClock(item.startMinute ?? 540);
  row.querySelector('[name="endDay"]').value = (item.endMinute ?? 1020) >= 1440 ? "next" : "same";
  row.querySelector('[name="endTime"]').value = formatClock(item.endMinute ?? 1020);
  row.querySelector('[name="activity"]').value = item.activity || "";
  row.querySelector('[name="location"]').value = item.location || "";
  row.querySelector(".remove-schedule-item").addEventListener("click", () => {
    row.remove();
    announce("予定を入力欄から削除しました。保存するまで確定しません。");
  });
  $("#schedule-item-rows").append(fragment);
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
  if (!state.selectedChild) return renderListEmpty(container, "利用児を選択してください");
  if (!state.journals.length) return renderListEmpty(container, "日誌はまだ登録されていません", "最初の記録を登録すると、ここに時系列で表示されます。");
  container.className = "record-list";
  for (const journal of state.journals) {
    const item = element("article", { className: "record-item" });
    const date = element("div", { className: "record-date", text: formatDate(journal.occurredAt, true) });
    date.append(element("strong", { text: journal.activity }));
    const body = element("div", { className: "record-body" });
    body.append(element("h2", { text: "支援の記録" }));
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
    item.append(date, body);
    container.append(item);
  }
}

function renderContactEntries() {
  const container = $("#contact-list");
  container.replaceChildren();
  if (!state.selectedChild) return renderListEmpty(container, "利用児を選択してください");
  if (!state.contactEntries.length) return renderListEmpty(container, "連絡はまだ登録されていません", "家庭・事業所からの連絡を登録すると、ここに表示されます。");
  container.className = "record-list";
  for (const entry of state.contactEntries) {
    const item = element("article", { className: "record-item" });
    const date = element("div", { className: "record-date", text: formatDate(entry.entryDate) });
    date.append(element("strong", { text: entry.reflectedInSupport ? "支援へ反映済み" : "連絡記録" }));
    const body = element("div", { className: "record-body" });
    body.append(element("h2", { text: entry.requestSummary || "家庭・事業所の連絡" }));
    const details = element("dl");
    details.append(
      element("dt", { text: "家庭から" }), element("dd", { text: entry.familyMessage || "記載なし" }),
      element("dt", { text: "事業所から" }), element("dd", { text: entry.facilityReply || "記載なし" }),
    );
    body.append(details);
    item.append(date, body);
    container.append(item);
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
  if (!can("pdf.export") || !state.selectedChild || !documents.length) return;
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(4, documents.length) }, async () => {
    while (cursor < documents.length) {
      const documentRecord = documents[cursor];
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
  if (failed) announce("一部のPDF一覧を読み込めませんでした。各書類の表示を確認してください。");
}

function renderPdfPanel(documentRecord) {
  const panel = element("section", { className: "pdf-panel", attributes: { "aria-label": `${DOCUMENT_KIND_LABELS[documentRecord.documentKind]} 第${documentRecord.versionNumber}版の帳票PDF` } });
  const panelId = `pdf-panel-${documentRecord.id}`;
  panel.id = panelId;
  const heading = element("div", { className: "pdf-panel-heading" });
  const title = element("h3", { text: "帳票PDF" });
  const noteId = `pdf-note-${documentRecord.id}`;
  const note = element("p", { text: "作成したPDFはその時点の内容を固定して保存し、後から上書きしません。", attributes: { id: noteId } });
  heading.append(title, note);
  panel.append(heading);

  const snapshotKind = pdfKindForStatus(documentRecord.status);
  if (snapshotKind) {
    const button = element("button", {
      className: `button ${snapshotKind === "official" ? "button-primary" : "button-secondary"} pdf-create-button`,
      text: snapshotKind === "official" ? "正式PDFを作成" : "下書きPDFを作成",
      attributes: { type: "button", "aria-describedby": noteId },
    });
    button.addEventListener("click", () => runAsync(() => createDocumentPdf(documentRecord, snapshotKind, button)));
    panel.append(button);
  }

  const error = state.pdfErrors.get(documentRecord.id);
  if (error) panel.append(element("p", { className: "pdf-error", text: error, attributes: { role: "alert" } }));

  const snapshots = state.documentSnapshots.get(documentRecord.id) || [];
  if (!snapshots.length) {
    panel.append(element("p", { className: "pdf-empty", text: "作成済みのPDFはありません。" }));
    return panel;
  }
  const list = element("ul", { className: "pdf-snapshot-list", attributes: { "aria-label": "作成済みPDF" } });
  for (const snapshot of snapshots) {
    const item = element("li");
    const copy = element("div");
    copy.append(
      element("strong", { text: snapshot.snapshotKind === "official" ? "正式版" : "下書き（透かし入り）" }),
      element("span", { text: `${formatDate(snapshot.generatedAt, true)} ／ ${formatBytes(snapshot.byteSize)}` }),
    );
    const href = `${API_BASE}/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}/snapshots/${encodeURIComponent(snapshot.id)}/content`;
    const link = element("a", { text: "PDFを開く", attributes: { href, target: "_blank", rel: "noopener noreferrer", "aria-label": `${snapshot.snapshotKind === "official" ? "正式版" : "下書き"}PDFを新しいタブで開く` } });
    link.append(element("span", { text: "↗", attributes: { "aria-hidden": "true" } }));
    item.append(copy, link);
    list.append(item);
  }
  panel.append(list);
  return panel;
}

async function createDocumentPdf(documentRecord, snapshotKind, button) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const originalLabel = button.textContent;
  button.textContent = "PDFを作成しています…";
  state.pdfErrors.delete(documentRecord.id);
  state.conflictReload = loadDocuments;
  try {
    await idempotentCreate(
      `/children/${encodeURIComponent(state.selectedChild.id)}/documents/${encodeURIComponent(documentRecord.id)}/pdf`,
      { snapshotKind },
      { etag: `"${documentRecord.rowVersion}"` },
    );
    state.conflictReload = null;
    await loadSnapshotsForDocument(documentRecord);
    renderDocuments();
    announce(`${snapshotKind === "official" ? "正式版" : "下書き"}PDFを作成しました。作成済みPDFから開けます。`);
  } catch (error) {
    if (error.status !== 409) {
      const message = errorMessage(error);
      state.pdfErrors.set(documentRecord.id, message);
      renderDocuments();
      announce(message);
    }
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
  renderDocumentLane("monitoring_record", $("#monitoring-document-list"));
  $$('[data-create-document]').forEach((button) => { button.disabled = !state.selectedChild; });
  const consultation = latestDocument("consultation_plan");
  const assessment = latestDocument("basic_assessment");
  const activePlan = latestDocument("individual_support_plan", (item) => item.status === "active");
  const finalizedCurrent = state.schedules.current?.status === "finalized" ? state.schedules.current : null;
  const assessmentButton = $('[data-generate-draft="basic_assessment"]');
  const individualButton = $('[data-generate-draft="individual_support_plan"]');
  const monitoringButton = $("#open-monitoring-generation");
  if (assessmentButton) assessmentButton.disabled = !state.selectedChild || !consultation || !finalizedCurrent;
  if (individualButton) individualButton.disabled = !state.selectedChild || !consultation || !assessment;
  if (monitoringButton) monitoringButton.disabled = !state.selectedChild || !activePlan;
  $("#assessment-readiness").textContent = !state.selectedChild
    ? "利用児を選択してください。"
    : !consultation ? "相談支援計画を先に登録してください。"
      : !finalizedCurrent ? "「現在の生活」を登録し、計画承認者が確定してください。"
        : "作成できます。面談で内容を確認してください。";
  $("#individual-readiness").textContent = !consultation
    ? "相談支援計画を先に登録してください。"
    : !assessment ? "アセスメントを作成し、面談結果を確認してください。"
      : "作成できます。目標と支援内容は人が決定します。";
  $("#monitoring-readiness").textContent = activePlan
    ? "作成できます。日誌・連絡帳を集計後、人が評価します。"
    : "運用中の個別支援計画が必要です。";
  $("#cycle-readiness").textContent = cycleReadinessText({ consultation, assessment, activePlan });
  $$('[data-cycle-step]').forEach((step) => step.classList.remove("is-complete", "is-current"));
  if (consultation) $('[data-cycle-step="consultation"]')?.classList.add("is-complete");
  if (assessment) $('[data-cycle-step="assessment"]')?.classList.add("is-complete");
  if (activePlan) $('[data-cycle-step="individual"]')?.classList.add("is-complete");
  const nextStep = !consultation ? "consultation" : !assessment ? "assessment" : !activePlan ? "individual" : "records";
  $(`[data-cycle-step="${nextStep}"]`)?.classList.add("is-current");
  const generatedDetail = [...state.documentDetails.values()].map((entry) => entry.data).find((detail) => detail.payload?.generation);
  renderGenerationEvidence(generatedDetail);
}

function renderDocumentLane(kind, container) {
  container.replaceChildren();
  const documents = state.documents.filter((documentRecord) => documentRecord.documentKind === kind);
  if (!state.selectedChild) return renderListEmpty(container, "利用児を選択してください");
  if (!documents.length) return renderListEmpty(container, "登録された計画はありません");
  container.className = "document-list";
  for (const documentRecord of documents) {
    const item = element("article", { className: "document-item" });
    item.append(
      element("strong", { text: `${DOCUMENT_KIND_LABELS[kind]} 第${documentRecord.versionNumber}版` }),
      element("span", { className: "status-chip", text: DOCUMENT_STATUS_LABELS[documentRecord.status] || documentRecord.status }),
      element("p", { text: `${formatDate(documentRecord.periodStart)} 〜 ${formatDate(documentRecord.periodEnd)} ／ 更新 ${formatDate(documentRecord.updatedAt, true)}` }),
    );
    const actions = element("div", { className: "document-actions" });
    const detail = state.documentDetails.get(documentRecord.id)?.data;
    if (detail?.payload?.generation) {
      const evidence = element("button", { className: "button button-ghost", text: "根拠を確認", attributes: { type: "button" } });
      evidence.addEventListener("click", () => {
        renderGenerationEvidence(detail);
        $("#generation-evidence").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      actions.append(evidence);
    }
    if (["consultation_plan", "individual_support_plan"].includes(kind) && (can("documents.edit") || can("documents.approve"))) {
      const workflow = element("button", { className: "button button-secondary", text: "工程を確認", attributes: { type: "button" } });
      workflow.addEventListener("click", () => runAsync(() => openWorkflow(documentRecord, workflow)));
      actions.append(workflow);
    }
    if (kind === "monitoring_record") {
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
    if (actions.childElementCount) item.append(actions);
    if (can("pdf.export")) item.append(renderPdfPanel(documentRecord));
    container.append(item);
  }
}

function latestDocument(kind, predicate = () => true) {
  return state.documents
    .filter((item) => item.documentKind === kind && item.status !== "void" && predicate(item))
    .sort((left, right) => right.versionNumber - left.versionNumber)[0] || null;
}

function cycleReadinessText({ consultation, assessment, activePlan }) {
  if (!state.selectedChild) return "利用児を選択すると、次にできる作業を確認できます。";
  if (!consultation) return "まず、相談支援事業者から受け取った相談支援計画を登録します。";
  if (!assessment) return "次は、現在の生活を確定し、アセスメントの下書きを作ります。";
  if (!activePlan) return "アセスメントを確認後、個別支援計画を作成して正式工程を進めます。";
  return "個別支援計画に沿って日誌・連絡帳を蓄積し、期間ごとにモニタリングします。";
}

function renderGenerationEvidence(detail) {
  const container = $("#generation-evidence");
  container.replaceChildren();
  const heading = element("div");
  heading.append(element("p", { className: "eyebrow", text: "自動作成の根拠" }), element("h2", { attributes: { id: "generation-evidence-title" }, text: detail ? `${DOCUMENT_KIND_LABELS[detail.documentKind]} 第${detail.versionNumber}版` : "人が確認するための下書きです" }));
  container.append(heading);
  const generation = detail?.payload?.generation;
  if (!generation) {
    container.append(element("p", { text: "自動作成した書類の「根拠を確認」を選ぶと、参照件数と確認事項を表示します。" }));
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

async function selectChild(childId) {
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
  closeDialog($("#child-picker-dialog"));
  updateSelectedChildChrome();
  await loadActiveResource();
  announce(`${data.displayName}さんを選択しました。`);
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
  const latestIds = [...new Set(["consultation_plan", "basic_assessment", "individual_support_plan", "monitoring_record"]
    .map((kind) => latestDocument(kind)?.id)
    .filter(Boolean))];
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
  if (!state.schedules.current && !state.schedules.planned) await loadSchedules();
  renderDocuments();
}

async function loadActiveResource() {
  if (!state.selectedChild) {
    renderJournals();
    renderContactEntries();
    renderDocuments();
    renderGuardians();
    renderSchedule("current");
    renderSchedule("planned");
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
  } else if (state.activeView === "child" && state.childPanel === "schedules") {
    await loadSchedules();
  } else if (state.activeView === "admin" && can("admin.view")) {
    await Promise.all([
      can("staff.manage") ? loadStaff() : Promise.resolve(),
      can("audit.view") ? loadAuditEvents() : Promise.resolve(),
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
  for (const field of ["managementCode", "displayName", "legalName", "birthDate", "grade", "gender", "municipalityName", "copaymentLimitYen", "disabilityCategory", "medicalSummary"]) {
    form.elements[field].value = child[field] ?? "";
  }
  form.elements.recipientCertificateNumber.value = "";
  clearFormError(form, $("#child-edit-error"));
  openDialog($("#child-edit-dialog"), trigger);
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

function openJournalDialog(trigger) {
  if (!state.selectedChild) return announce("先に利用児を選択してください。");
  const form = $("#journal-form");
  form.reset();
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  form.elements.occurredAt.value = now.toISOString().slice(0, 16);
  clearFormError(form, $("#journal-error"));
  openDialog($("#journal-dialog"), trigger);
}

async function submitJournal(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#journal-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const body = {
    occurredAt: new Date(values.get("occurredAt")).toISOString(),
    activity: values.get("activity").trim(),
    observation: values.get("observation").trim(),
    supportProvided: values.get("supportProvided").trim(),
    childResponse: values.get("childResponse").trim(),
    fiveDomains: values.getAll("fiveDomains"),
    relatedGoalIds: [],
  };
  const healthNote = values.get("healthNote").trim();
  if (healthNote) body.healthNote = healthNote;
  try {
    await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/daily-logs`, body);
    closeDialog($("#journal-dialog"));
    await loadActiveResource();
    announce("日誌を保存しました。");
  } catch (error) {
    if (error.status !== 409) showFormError(form, errorContainer, errorMessage(error), []);
  }
}

function openContactDialog(trigger) {
  if (!state.selectedChild) return announce("先に利用児を選択してください。");
  const form = $("#contact-form");
  form.reset();
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  form.elements.entryDate.value = today.toISOString().slice(0, 10);
  clearFormError(form, $("#contact-error"));
  openDialog($("#contact-dialog"), trigger);
}

function expandContactDraft() {
  const form = $("#contact-form");
  const familyMessage = form.elements.familyMessage.value.trim();
  const requestSummary = form.elements.requestSummary.value.trim();
  const existingReply = form.elements.facilityReply.value.trim();
  const reflectedInSupport = form.elements.reflectedInSupport.checked;
  if (![familyMessage, requestSummary, existingReply].some(Boolean)) {
    showFormError(form, $("#contact-error"), "家庭からの連絡・要望の要点・返信のいずれかを入力してから、文章を整えてください。", ["familyMessage", "requestSummary", "facilityReply"]);
    return;
  }
  const quotedFamilyMessage = familyMessage.replace(/[。．！？!?]+$/u, "");

  const draft = [
    familyMessage ? `ご連絡ありがとうございます。「${quotedFamilyMessage}」とのご連絡を確認しました。` : "",
    requestSummary ? `ご要望の要点は「${requestSummary}」と受け止めています。` : "",
    existingReply ? existingReply : "当日の様子を確認し、必要な配慮についてご連絡します。",
    reflectedInSupport ? "支援内容への反映についても確認します。" : "",
  ].filter(Boolean).join("\n\n");

  form.elements.facilityReply.value = draft;
  form.elements.facilityReply.dispatchEvent(new Event("input", { bubbles: true }));
  clearFormError(form, $("#contact-error"));
  announce("返信文の下書きを作成しました。保存前に内容を確認してください。");
}

async function submitContact(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorContainer = $("#contact-error");
  if (!validateForm(form, errorContainer)) return;
  const values = new FormData(form);
  const familyMessage = values.get("familyMessage").trim();
  const facilityReply = values.get("facilityReply").trim();
  if (!familyMessage && !facilityReply) {
    showFormError(form, errorContainer, "「家庭からの連絡」または「事業所からの返信」のどちらかを入力してください。", ["familyMessage", "facilityReply"]);
    return;
  }
  const body = {
    entryDate: values.get("entryDate"),
    reflectedInSupport: values.get("reflectedInSupport") === "on",
  };
  if (familyMessage) body.familyMessage = familyMessage;
  if (facilityReply) body.facilityReply = facilityReply;
  const requestSummary = values.get("requestSummary").trim();
  if (requestSummary) body.requestSummary = requestSummary;
  try {
    await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/contact-book`, body);
    closeDialog($("#contact-dialog"));
    await loadActiveResource();
    announce("連絡を保存しました。");
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
    await idempotentCreate(`/children/${encodeURIComponent(state.selectedChild.id)}/documents`, {
      documentKind: kind,
      templateVersion: "2026.1",
      payload: { creationMethod: "manual" },
    });
    await loadActiveResource();
    state.conflictReload = null;
    announce(`${DOCUMENT_KIND_LABELS[kind]}の下書きを作成しました。`);
  } catch (error) {
    if (error.status !== 409) announce(errorMessage(error));
  } finally {
    button.disabled = !state.selectedChild;
  }
}

async function generateDraft(button) {
  if (!state.selectedChild || button.disabled) return;
  const kind = button.dataset.generateDraft;
  const consultation = latestDocument("consultation_plan");
  const assessment = latestDocument("basic_assessment");
  const body = kind === "basic_assessment"
    ? {
        targetDocumentKind: "basic_assessment",
        consultationPlanId: consultation?.id,
        currentScheduleVersionId: state.schedules.current?.id,
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
    announce(`${DOCUMENT_KIND_LABELS[kind]}の下書きを作成しました。内容を確認してください。`);
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
    announce("モニタリングの下書きを作成しました。目標ごとの評価を確認してください。");
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
  "facility.created": "事業所を追加", "facility.updated": "事業所を更新", "staff.invited": "職員を招待", "staff.membership_updated": "職員権限を更新", "guardian.created": "保護者を登録", "guardian.updated": "保護者を更新", "schedule.created": "週間予定を作成", "schedule.updated": "週間予定を更新", "schedule.finalized": "週間予定を確定", "case_document.draft_generated": "書類下書きを生成",
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
  const roles = state.session?.user?.role === "tenant_admin"
    ? ["tenant_admin", "facility_admin", "plan_approver", "support_staff", "viewer", "auditor"]
    : ["plan_approver", "support_staff", "viewer"];
  return roles;
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
    const facilities = element("p", { text: staff.role === "tenant_admin" && !facilityNames.length ? "法人内の全事業所" : facilityNames.join("、") || "事業所未設定" });
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

function workflowActionsForStatus(status) {
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
  for (const action of workflowActionsForStatus(documentRecord.status)) {
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
    : isLastAdmin ? "最後の法人管理者は変更できません"
      : isStaffRegistered ? "この職員は登録済みです"
        : isDuplicate ? "同じ情報がすでに登録されています"
      : isInvalidTransition ? "文書の工程が変わりました"
        : isImmutable ? "確定済みの内容は上書きできません"
          : isPdfStatusChanged ? "PDFを作成できる工程が変わりました"
          : "別の職員が先に更新しました";
  $("#conflict-description").textContent = isExistingDraft
    ? "同じ種類の下書きを重複して作らないよう、作成を中止しました。既存の下書きを確認してください。"
    : isLastAdmin ? "法人には有効な法人管理者が1名以上必要です。別の職員を法人管理者にしてから変更してください。"
      : isStaffRegistered ? "同じメールアドレスの職員を重複登録しないよう、招待を中止しました。職員一覧を確認してください。"
        : isDuplicate ? "管理番号や事業所コードが重複しています。最新の一覧を確認し、別のコードを指定してください。"
      : isInvalidTransition ? "別の職員が工程を進めた可能性があります。最新の工程を読み込んでください。"
        : isImmutable ? "確定した記録を守るため保存を中止しました。必要な場合は新しい版を作成してください。"
          : isPdfStatusChanged ? "別の職員が文書の工程を進めた可能性があります。最新の状態を読み込み、表示された種類のPDFを作成してください。"
          : "上書きによる記録の消失を防ぐため、保存を中止しました。入力内容はこの画面に保持されています。";
  const detail = $("#conflict-detail");
  detail.replaceChildren();
  const values = [
    ["エラー", error.code],
    ["現在の版", error.details?.currentVersion || error.details?.versionNumber],
    ["更新日時", error.details?.updatedAt ? formatDate(error.details.updatedAt, true) : null],
  ].filter(([, value]) => value !== null && value !== undefined);
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
  $("#create-journal-button")?.addEventListener("click", (event) => openJournalDialog(event.currentTarget));
  $("#create-contact-button")?.addEventListener("click", (event) => openContactDialog(event.currentTarget));
  $("#expand-contact-draft")?.addEventListener("click", expandContactDraft);
  $("#create-guardian-button")?.addEventListener("click", (event) => openGuardianDialog(event.currentTarget));
  $("#add-schedule-item")?.addEventListener("click", () => addScheduleItem());
  $("#open-monitoring-generation")?.addEventListener("click", (event) => openMonitoringGeneration(event.currentTarget));
  $("#invite-staff-button")?.addEventListener("click", (event) => openStaffInvite(event.currentTarget));
  $("#create-facility-button")?.addEventListener("click", (event) => openFacilityCreate(event.currentTarget));
  $("#refresh-audit-button")?.addEventListener("click", () => runAsync(loadAuditEvents));
  $("#child-register-form")?.addEventListener("submit", submitChildRegistration);
  $("#child-edit-form")?.addEventListener("submit", submitChildEdit);
  $("#journal-form")?.addEventListener("submit", submitJournal);
  $("#contact-form")?.addEventListener("submit", submitContact);
  $("#guardian-form")?.addEventListener("submit", submitGuardian);
  $("#schedule-form")?.addEventListener("submit", submitSchedule);
  $("#monitoring-generation-form")?.addEventListener("submit", submitMonitoringGeneration);
  $("#monitoring-result-form")?.addEventListener("submit", submitMonitoringResult);
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
    state.facilityId = state.facilities.find((facility) => facility.status !== "inactive" && allowedFacilityIds.has(facility.id))?.id
      || state.facilities.find((facility) => facility.status !== "inactive")?.id
      || null;
    renderFacilities();
    await loadChildren();
    renderJournals();
    renderContactEntries();
    renderDocuments();
    renderGuardians();
    renderSchedule("current");
    renderSchedule("planned");
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
