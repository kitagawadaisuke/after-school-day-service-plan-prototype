import { cloneDemoCases, cloneDemoData, DOMAIN_META, INDICATOR_META } from "./demo-data.js";
import {
  MAX_ANALYSIS_DAYS,
  analyzeJournals,
  calculateAgeLabel,
  formatDateJP,
  generatePlan,
  getJournalById,
  inferJournalTags,
  isPlanSourceFresh,
  validatePlan
} from "./plan-engine.js";
import { isValidIsoDate, toCsvCell, toLocalIsoDate } from "./utils.js";

const STORAGE_KEY = "michi-note-demo-v1";
const VIEW_TITLES = {
  childProfile: { title: "利用児情報", breadcrumb: "利用児 / 基本情報・利用情報" },
  consultation: { title: "サービス等利用計画案", breadcrumb: "相談支援 / サービス等利用計画案" },
  contactBook: { title: "連絡帳", breadcrumb: "日々の連携 / 保護者との連絡帳" },
  dashboard: { title: "支援サマリー", breadcrumb: "支援サマリー" },
  journals: { title: "日誌を確認", breadcrumb: "日誌 / 観察記録" },
  analysis: { title: "モニタリング", breadcrumb: "モニタリング / 日誌のふり返り" },
  assessment: { title: "アセスメント", breadcrumb: "アセスメント / 支援の見立て" },
  plan: { title: "個別支援計画書", breadcrumb: "計画作成 / 見直し原案" }
};

const PATTERN_SUPPORT_IDS = {
  expression: "support-expression",
  transition: "support-transition",
  peers: "support-peers",
  regulation: "support-regulation"
};

let toastTimer;
let saveTimer;
let loadWarning = "";

function localDateFromIso(value) {
  if (!isValidIsoDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function rangeDays(range) {
  const start = localDateFromIso(range?.start);
  const end = localDateFromIso(range?.end);
  if (!start || !end || end < start) return Number.NaN;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function getDefaultAnalysisRange(journals) {
  const dates = journals.map((journal) => journal.date).filter(isValidIsoDate).sort();
  if (!dates.length) return { start: "", end: "" };
  const end = dates.at(-1);
  const earliest = localDateFromIso(end);
  earliest.setDate(earliest.getDate() - (MAX_ANALYSIS_DAYS - 1));
  return { start: dates[0] > toLocalIsoDate(earliest) ? dates[0] : toLocalIsoDate(earliest), end };
}

function isUsableAnalysisRange(range) {
  const days = rangeDays(range);
  return Number.isFinite(days) && days >= 1 && days <= MAX_ANALYSIS_DAYS;
}

function journalsInRange(journals, range) {
  if (!isUsableAnalysisRange(range)) return [];
  return journals.filter((journal) => journal.date >= range.start && journal.date <= range.end);
}

function createInitialState() {
  const { profile, journals } = cloneDemoData();
  const workspace = createChildWorkspace(profile, journals);
  return {
    schemaVersion: 3,
    activeChildId: profile.id,
    childWorkspaces: createDefaultChildWorkspaces(),
    ...workspace
  };
}

function createChildWorkspace(profile, journals, { isDemo = true } = {}) {
  const analysisRange = getDefaultAnalysisRange(journals);
  const sourceJournals = journalsInRange(journals, analysisRange);
  const monitoringDraft = createMonitoringDraft(profile, sourceJournals);
  const consultationPlanDraft = createConsultationPlanDraft(profile);
  const contactBookEntries = isDemo ? createContactBookEntries(profile) : [];
  return {
    profile,
    journals,
    plan: {
      ...generatePlan(profile, sourceJournals),
      consultationPlanReference: {
        agencyName: consultationPlanDraft.agencyName,
        preparedDate: consultationPlanDraft.preparedDate,
        overallGoal: consultationPlanDraft.overallGoal
      }
    },
    consultationPlanDraft,
    contactBookEntries,
    monitoringDraft,
    assessmentDraft: createAssessmentDraft(profile, monitoringDraft, consultationPlanDraft),
    analysisRange,
    selectedJournalId: journals.at(-1)?.id ?? "",
    filters: { search: "", domain: "all", month: "all" },
    activeView: "dashboard",
    planMode: "edit",
    planStale: false,
    updatedAt: new Date().toISOString()
  };
}

function createDefaultChildWorkspaces() {
  return Object.fromEntries(
    cloneDemoCases().map(({ profile, journals }) => [profile.id, createChildWorkspace(profile, journals)])
  );
}

const WORKSPACE_KEYS = ["profile", "journals", "plan", "consultationPlanDraft", "contactBookEntries", "monitoringDraft", "assessmentDraft", "analysisRange", "selectedJournalId", "filters", "activeView", "planMode", "planStale", "updatedAt"];

function currentWorkspace() {
  return Object.fromEntries(WORKSPACE_KEYS.map((key) => [key, structuredClone(state[key])]));
}

function syncActiveWorkspace() {
  if (!state.activeChildId) return;
  state.childWorkspaces ??= {};
  state.childWorkspaces[state.activeChildId] = currentWorkspace();
}

function normalizeSavedJournal(journal) {
  if (!journal || typeof journal !== "object") return null;
  const requiredText = ["id", "date", "activity", "observation", "support", "response"];
  if (requiredText.some((key) => typeof journal[key] !== "string" || !journal[key].trim())) return null;
  if (!isValidIsoDate(journal.date)) return null;
  const domains = Array.isArray(journal.domains) ? [...new Set(journal.domains.filter((domain) => DOMAIN_META[domain]))] : [];
  if (!domains.length) return null;
  const indicators = Object.fromEntries(
    Object.keys(INDICATOR_META).map((key) => {
      const value = journal.indicators?.[key];
      const number = Number(value);
      return [key, value !== null && value !== "" && Number.isInteger(number) && number >= 1 && number <= 4 ? number : null];
    })
  );
  return {
    ...journal,
    id: journal.id.trim(),
    activity: journal.activity.trim().slice(0, 80),
    observation: journal.observation.trim().slice(0, 1000),
    support: journal.support.trim().slice(0, 1000),
    response: journal.response.trim().slice(0, 1000),
    physical: typeof journal.physical === "string" ? journal.physical.trim().slice(0, 120) : "未記入",
    familyNote: typeof journal.familyNote === "string" ? journal.familyNote.trim().slice(0, 1000) : "",
    mood: typeof journal.mood === "string" ? journal.mood : "未記入",
    time: typeof journal.time === "string" && /^\d{2}:\d{2}〜\d{2}:\d{2}$/.test(journal.time) ? journal.time : "15:30〜17:30",
    staff: typeof journal.staff === "string" && journal.staff.trim() ? journal.staff.trim().slice(0, 80) : "記録者未入力",
    domains,
    tags: Array.isArray(journal.tags) ? journal.tags.filter((tag) => typeof tag === "string") : [],
    indicators
  };
}

function isUsableSavedPlan(plan) {
  return Boolean(
    plan && typeof plan === "object" &&
    plan.child && typeof plan.child === "object" &&
    plan.service && typeof plan.service === "object" &&
    plan.workflow && typeof plan.workflow === "object" &&
    plan.workflow.assessmentInterview && plan.workflow.supportMeeting && plan.workflow.childExplanation &&
    plan.workflow.guardianConsent && plan.workflow.guardianDelivery && plan.workflow.consultationDelivery &&
    plan.familySupport && plan.transitionSupport && plan.communitySupport &&
    Array.isArray(plan.supportItems) && plan.supportItems.every(
      (item) => item && typeof item === "object" && Array.isArray(item.domains) && Array.isArray(item.evidenceIds)
    )
  );
}

function sanitizeSavedPlanValue(value, depth = 0) {
  if (depth > 10) return null;
  if (typeof value === "string") return value.slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeSavedPlanValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 150).map(([key, item]) => [key, sanitizeSavedPlanValue(item, depth + 1)])
    );
  }
  return null;
}

function sanitizeDraft(savedDraft, fallbackDraft) {
  if (!savedDraft || typeof savedDraft !== "object") return fallbackDraft;
  return Object.fromEntries(
    Object.entries(fallbackDraft).map(([key, fallbackValue]) => {
      const savedValue = savedDraft[key];
      return [key, typeof fallbackValue === "string" && typeof savedValue === "string" ? savedValue.slice(0, 2000) : fallbackValue];
    })
  );
}

function sanitizeContactBookEntries(entries, fallbackEntries) {
  if (!Array.isArray(entries)) return fallbackEntries;
  return entries.slice(0, 100).map((entry, index) => {
    const fallback = fallbackEntries[index] ?? fallbackEntries[0];
    return {
      id: typeof entry?.id === "string" ? entry.id.slice(0, 80) : `${fallback.id}-${index}`,
      date: isValidIsoDate(entry?.date) ? entry.date : fallback.date,
      familyMessage: typeof entry?.familyMessage === "string" ? entry.familyMessage.slice(0, 2000) : fallback.familyMessage,
      serviceReply: typeof entry?.serviceReply === "string" ? entry.serviceReply.slice(0, 2000) : fallback.serviceReply,
      request: typeof entry?.request === "string" ? entry.request.slice(0, 1000) : fallback.request,
      reflected: Boolean(entry?.reflected)
    };
  });
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const saved = JSON.parse(raw);
    if (![1, 2, 3].includes(saved?.schemaVersion) || !saved.profile || !Array.isArray(saved.journals)) {
      throw new Error("保存形式が現在のデモと一致しません");
    }
    const fallback = createInitialState();
    const profile = Object.fromEntries(Object.entries(fallback.profile).map(([key, fallbackValue]) => {
      const savedValue = saved.profile[key];
      if (typeof fallbackValue === "string" && typeof savedValue === "string") return [key, savedValue.slice(0, 2000)];
      if (Array.isArray(fallbackValue) && Array.isArray(savedValue)) {
        return [key, savedValue.filter((value) => typeof value === "string").slice(0, 50)];
      }
      return [key, fallbackValue];
    }));
    const journals = saved.journals.map(normalizeSavedJournal).filter(Boolean);
    const candidateRange = { start: saved.analysisRange?.start, end: saved.analysisRange?.end };
    const analysisRange = isUsableAnalysisRange(candidateRange) ? candidateRange : getDefaultAnalysisRange(journals);
    const sourceJournals = journalsInRange(journals, analysisRange);
    const generatedPlan = generatePlan(profile, sourceJournals);
    const generatedMonitoringDraft = createMonitoringDraft(profile, sourceJournals);
    const generatedConsultationPlanDraft = createConsultationPlanDraft(profile);
    const generatedContactBookEntries = createContactBookEntries(profile);
    const generatedAssessmentDraft = createAssessmentDraft(profile, generatedMonitoringDraft, generatedConsultationPlanDraft);
    const savedPlan = sanitizeSavedPlanValue(saved.plan);
    const filters = {
      search: typeof saved.filters?.search === "string" ? saved.filters.search.slice(0, 200) : "",
      domain: saved.filters?.domain === "all" || DOMAIN_META[saved.filters?.domain] ? saved.filters.domain : "all",
      month: saved.filters?.month === "all" || /^\d{4}-\d{2}$/.test(saved.filters?.month ?? "") ? saved.filters.month : "all"
    };
    const plan = isUsableSavedPlan(savedPlan)
      ? {
          ...generatedPlan,
          ...savedPlan,
          child: { ...generatedPlan.child, ...savedPlan.child },
          service: { ...generatedPlan.service, ...savedPlan.service },
          familySupport: { ...generatedPlan.familySupport, ...savedPlan.familySupport },
          transitionSupport: { ...generatedPlan.transitionSupport, ...savedPlan.transitionSupport },
          communitySupport: { ...generatedPlan.communitySupport, ...savedPlan.communitySupport },
          workflow: {
            ...generatedPlan.workflow,
            ...savedPlan.workflow,
            consultationDelivery: {
              ...generatedPlan.workflow.consultationDelivery,
              ...savedPlan.workflow.consultationDelivery
            }
          },
          supportItems: savedPlan.supportItems.map((item) => ({
            ...item,
            domains: [...new Set(item.domains.filter((domain) => DOMAIN_META[domain]))],
            evidenceIds: [...new Set(item.evidenceIds.filter((id) => journals.some((journal) => journal.id === id)))]
          }))
        }
      : generatedPlan;
    plan.consultationPlanReference ??= {
      agencyName: generatedConsultationPlanDraft.agencyName,
      preparedDate: generatedConsultationPlanDraft.preparedDate,
      overallGoal: generatedConsultationPlanDraft.overallGoal
    };
    plan.child.ageLabel = calculateAgeLabel(plan.child.birthDate, plan.planStart) || plan.child.ageLabel || "";
    const activeChildId = typeof saved.activeChildId === "string" && profile.id === saved.activeChildId ? saved.activeChildId : profile.id;
    const childWorkspaces = {
      ...createDefaultChildWorkspaces(),
      ...(saved.childWorkspaces && typeof saved.childWorkspaces === "object" ? saved.childWorkspaces : {})
    };
    const activeWorkspace = {
      profile,
      journals,
      filters,
      analysisRange,
      plan,
      consultationPlanDraft: sanitizeDraft(saved.consultationPlanDraft, generatedConsultationPlanDraft),
      contactBookEntries: sanitizeContactBookEntries(saved.contactBookEntries, generatedContactBookEntries),
      monitoringDraft: sanitizeDraft(saved.monitoringDraft, generatedMonitoringDraft),
      assessmentDraft: sanitizeDraft(saved.assessmentDraft, generatedAssessmentDraft),
      planStale: !isPlanSourceFresh(plan, sourceJournals),
      selectedJournalId: journals.some((journal) => journal.id === saved.selectedJournalId)
        ? saved.selectedJournalId
        : journals.at(-1)?.id || "",
      activeView: VIEW_TITLES[saved.activeView] ? saved.activeView : "dashboard",
      planMode: saved.planMode === "preview" ? "preview" : "edit",
      updatedAt: saved.updatedAt
    };
    childWorkspaces[activeChildId] = activeWorkspace;
    return {
      ...fallback,
      ...saved,
      schemaVersion: 3,
      activeChildId,
      childWorkspaces,
      ...activeWorkspace
    };
  } catch (error) {
    loadWarning = `保存データを読み込めなかったため、デモを初期状態で開きました（${error.message}）。`;
    return createInitialState();
  }
}

let state = loadState();

function getAnalysisJournals() {
  return journalsInRange(state.journals, state.analysisRange);
}

function createConsultationPlanDraft(profile) {
  return {
    agencyName: "相談支援事業所 ひなた（デモ）",
    preparedDate: "2026-05-20",
    period: `${formatDateJP(profile.planStart)}〜${formatDateJP(profile.planEnd)}`,
    serviceCategory: `障害児通所支援 / ${profile.serviceType}`,
    personWish: profile.personWish,
    guardianWish: profile.familyWish,
    overallGoal: "安心して放課後の時間を過ごし、好きな活動や友だちとの関わりを通して、自分でできることを少しずつ増やす。",
    oneYearVision: "見通しが持てる場面では、自分で選んだ活動に取り組み、困ったときには自分に合う方法で助けを求められる。家庭・学校・事業所で安心して過ごす時間を増やす。",
    currentSituation: `${profile.strengths[0]}。一方で、活動の切り替えや集団参加の場面では、見通しや伝え方の工夫が必要なことがあります。運動・移動・健康面・社会参加の状態は、日々の様子と本人・家族の実感を合わせて確認します。`,
    serviceNeed: "見通しを持てる環境と、本人が選んで伝えられる機会を整えながら、集団の中で安心して参加できる経験を重ねる。",
    dayServiceRole: "放課後等デイサービスでは、視覚的な見通し・選択肢・必要な休憩を用意し、本人の成功体験を日々の記録で確かめる。",
    selfCareRole: "本人が選べる場面をつくり、カード・言葉・身振りなど本人に合う方法で希望や困りごとを伝える。",
    familyRole: "家庭での様子や本人の変化を共有し、本人が安心して取り組めた関わり方を事業所・学校と一緒に確認する。",
    communityRole: "学校、相談支援事業所、必要に応じた地域資源と情報を共有し、本人にとって一貫した支援となるよう調整する。",
    assessmentProcess: "本人・家族から希望や困りごとを聴き取り、学校・事業所での様子と日誌の記録を確認する。",
    draftProcess: "相談支援専門員と事業所の支援者が、生活目標と必要なサービス・役割分担を調整して原案を作成する。",
    consentProcess: "本人・家族へ内容を説明し、意向を確認したうえで同意・交付の記録を残して支援を開始する。",
    considerations: "本人・家族の意向を優先し、学校や相談支援事業所と必要な情報を共有する。内容は関係者で確認して決定する。"
  };
}

function createContactBookEntries(profile) {
  return [
    {
      id: "CB-20260414",
      date: "2026-04-14",
      familyMessage: "家庭でも予定が分かると安心して準備できています。事業所でも次の活動を前もって伝えてもらえると助かります。",
      serviceReply: "活動の前に予定カードで流れを確認し、切り替え前には個別に声をかけます。日誌で本人の反応も確認します。",
      request: "見通しの伝え方を家庭・事業所でそろえたい。",
      reflected: false
    },
    {
      id: "CB-20260508",
      date: "2026-05-08",
      familyMessage: `${profile.displayName}が家で学校の出来事を話す場面が少し増えました。事業所で楽しかったことも、伝えるきっかけがあるとよさそうです。`,
      serviceReply: "帰りの会で『今日よかったこと』をカードとことばで選ぶ機会をつくり、家庭への共有につなげます。",
      request: "本人が一日の出来事を伝える機会を増やしたい。",
      reflected: false
    },
    {
      id: "CB-20260527",
      date: "2026-05-27",
      familyMessage: "疲れている日は、無理をしないで少し休めるようにしてほしいです。",
      serviceReply: "来所時の様子を確認し、必要に応じて静かな場所での休憩や活動量の調整を行います。",
      request: "体調や疲れに合わせて活動量を調整したい。",
      reflected: false
    }
  ];
}

function createMonitoringDraft(profile, journals) {
  const analysis = analyzeJournals(journals);
  const confirmedPatterns = analysis.patterns.filter((pattern) => pattern.isConfirmed);
  const patternNames = confirmedPatterns.map((pattern) => pattern.title);
  const sourcePeriod = journals.length ? `${formatDateJP(analysis.startDate)}〜${formatDateJP(analysis.endDate)}の${journals.length}件の日誌` : "対象となる日誌";
  const indicatorChanges = Object.values(analysis.indicators)
    .filter((item) => Number.isFinite(item.delta) && Math.abs(item.delta) >= 0.05)
    .map((item) => `${item.name}は後半${item.delta > 0 ? "で高く" : "で低く"}記録されています`);
  return {
    sourcePeriod,
    summary: `${sourcePeriod}をふり返り、日誌に繰り返し見られた場面と、支援後の本人の反応を整理した下書きです。`,
    progress: indicatorChanges.length ? `${indicatorChanges.join("。 ")}。数値だけで結論づけず、元の日誌と本人・家族の実感を確認します。` : "指標の比較だけでは判断せず、元の日誌と本人・家族の実感を確認します。",
    effectiveSupport: patternNames.length ? `繰り返し確認できた場面は「${patternNames.join("」「")}」です。これらの場面で行った支援と本人の反応を読み返し、続けたい工夫を確認します。` : "繰り返し確認できた場面はまだ十分ではありません。日誌を追加しながら、本人に合う関わり方を確認します。",
    reviewPoints: `次回は、${patternNames.length ? patternNames.join("、") : "日々の活動"}について、本人の感じ方、家庭での様子、場面による違いを確認します。`,
    nextStep: "本人・家族との面談内容や支援者の観察を加え、アセスメントの下書きとして支援の方向を整理します。"
  };
}

function createAssessmentDraft(profile, monitoringDraft, consultationPlanDraft = createConsultationPlanDraft(profile)) {
  return {
    sourcePeriod: monitoringDraft.sourcePeriod,
    consultationAgency: consultationPlanDraft.agencyName,
    consultationGoal: consultationPlanDraft.overallGoal,
    personWish: consultationPlanDraft.personWish || profile.personWish,
    familyWish: consultationPlanDraft.guardianWish || profile.familyWish,
    strengths: profile.strengths.join("。 "),
    needs: `${monitoringDraft.reviewPoints} 日誌で確認できた内容と、面談で把握した本人・家族の意向を合わせて、生活上の課題を整理します。`,
    supportDirection: `${consultationPlanDraft.dayServiceRole}\n\n${monitoringDraft.effectiveSupport} 本人が選びやすい方法や安心して参加できる環境を一緒に確かめ、支援内容は本人・家族と確認して決めます。`,
    planningNote: `相談支援事業所のサービス等利用計画案の目標「${consultationPlanDraft.overallGoal}」を踏まえ、個別支援会議等で目標・支援方法・担当・評価方法を具体化し、個別支援計画の原案へ反映します。`
  };
}

const WRITING_TARGET_MIN = 80;
const WRITING_TARGET_MAX = 800;

function writingToolsMarkup() {
  return `<span class="writing-tools" data-writing-tools>
    <span class="writing-target-label">目標文字数
      <select data-writing-target aria-label="目標文字数"><option value="100">100字</option><option value="200" selected>200字</option><option value="300">300字</option><option value="500">500字</option><option value="custom">任意</option></select>
      <input data-writing-custom-target type="number" min="${WRITING_TARGET_MIN}" max="${WRITING_TARGET_MAX}" step="1" inputmode="numeric" placeholder="80〜800" aria-label="任意の目標文字数" hidden />
    </span>
    <output class="writing-character-count" aria-live="polite"></output>
    <button class="mini-button" type="button" data-writing-format>文章を整える</button>
    <button class="mini-button" type="button" data-writing-copy>コピー</button>
    <output class="writing-action-feedback" data-writing-feedback aria-live="polite"></output>
    <small>事実を追加せず、改行や文末を読みやすく整えます。</small>
  </span>`;
}

function writingFieldTarget(field) {
  const select = $("[data-writing-target]", field);
  if (!select) return null;
  if (select.value !== "custom") return Number(select.value) || null;
  const customTarget = Number($("[data-writing-custom-target]", field)?.value);
  return Number.isInteger(customTarget) && customTarget >= WRITING_TARGET_MIN && customTarget <= WRITING_TARGET_MAX
    ? customTarget
    : null;
}

function updateWritingTools(field) {
  const textarea = $("textarea", field);
  const output = $(".writing-character-count", field);
  if (!textarea || !output) return;
  const target = writingFieldTarget(field);
  const count = [...textarea.value.trim()].length;
  output.textContent = target ? `現在 ${count}字 ／ 目標 ${target}字` : `現在 ${count}字 ／ 目標文字数を入力`;
  output.dataset.state = target && count >= target ? "met" : "short";
}

function refreshWritingTools(root = document) {
  $$(".writing-field", root).forEach(updateWritingTools);
}

function formatWritingText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => /[。！？!?]$/u.test(line) ? line : `${line}。`)
    .join("\n");
}

function showWritingFeedback(field, message, state = "done") {
  const feedback = $("[data-writing-feedback]", field);
  if (!feedback) return;
  feedback.textContent = message;
  feedback.dataset.state = state;
}

function markWritingButtonComplete(button) {
  const originalLabel = button.textContent;
  button.textContent = "整えました";
  button.classList.add("is-complete");
  window.setTimeout(() => {
    if (!button.isConnected) return;
    button.textContent = originalLabel;
    button.classList.remove("is-complete");
  }, 1800);
}

function formatWritingField(button) {
  const field = button.closest(".writing-field");
  const textarea = $("textarea", field);
  if (!textarea?.value.trim()) {
    showToast("文章を整える内容を入力してください。");
    textarea?.focus();
    return;
  }
  const target = writingFieldTarget(field);
  if (!target) {
    showToast(`任意の目標文字数は${WRITING_TARGET_MIN}〜${WRITING_TARGET_MAX}字で入力してください。`);
    $("[data-writing-custom-target]", field)?.focus();
    return;
  }
  const sourceText = textarea.value;
  const formattedText = formatWritingText(sourceText);
  const changed = formattedText !== sourceText;
  textarea.value = formattedText;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  updateWritingTools(field);
  markWritingButtonComplete(button);
  showWritingFeedback(
    field,
    changed
      ? "整えました。空白・改行・文末を読みやすく調整しています。"
      : "すでに読みやすい状態です（変更なし）。",
    changed ? "changed" : "unchanged"
  );
  showToast(changed ? "文章を整えました。事実の追加・推測はしていません。" : "すでに読みやすい文章です（変更なし）。");
}

async function copyWritingField(button) {
  const field = button.closest(".writing-field");
  const textarea = $("textarea", field);
  const text = textarea?.value.trim();
  if (!text) {
    showToast("コピーする内容を入力してください。");
    textarea?.focus();
    return;
  }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      textarea.focus();
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("COPY_FAILED");
      textarea.setSelectionRange(text.length, text.length);
    }
    const originalLabel = button.textContent;
    button.textContent = "コピーしました";
    window.setTimeout(() => { if (button.isConnected) button.textContent = originalLabel; }, 1600);
    showToast("文章をコピーしました。");
  } catch {
    showToast("コピーできませんでした。文章を選択してコピーしてください。");
  }
}

function draftTextarea(root, path, label, value, rows = 3, hint = "") {
  return `<label class="draft-field writing-field"><span>${escapeHtml(label)}</span>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}<textarea data-draft-root="${escapeAttribute(root)}" data-draft-path="${escapeAttribute(path)}" rows="${rows}" maxlength="2000">${escapeHtml(value ?? "")}</textarea>${writingToolsMarkup()}</label>`;
}

function renderMonitoringDraft() {
  const draft = state.monitoringDraft;
  $("#monitoring-source-status").textContent = draft.sourcePeriod;
  $("#monitoring-draft-fields").innerHTML = [
    draftTextarea("monitoringDraft", "summary", "モニタリングの概要", draft.summary, 3),
    draftTextarea("monitoringDraft", "progress", "本人の変化・できたこと", draft.progress, 3, "日誌で確認した事実をもとに、本人・家族と確かめます。"),
    draftTextarea("monitoringDraft", "effectiveSupport", "続けたい支援・役立った工夫", draft.effectiveSupport, 4),
    draftTextarea("monitoringDraft", "reviewPoints", "見直したいこと・追加で確認したいこと", draft.reviewPoints, 3),
    draftTextarea("monitoringDraft", "nextStep", "次のアセスメントへの申し送り", draft.nextStep, 2)
  ].join("");
  refreshWritingTools($("#monitoring-draft-fields"));
}

function renderConsultationDraft() {
  const draft = state.consultationPlanDraft;
  $("#consultation-source-status").textContent = `${draft.agencyName} / ${formatDateJP(draft.preparedDate)}作成`;
  $("#consultation-period").textContent = draft.period;
  $("#consultation-profile-strip").innerHTML = `
    <article><span>利用児</span><strong>${escapeHtml(state.profile.displayName)}</strong><small>${escapeHtml(state.profile.grade)}</small></article>
    <article><span>支給決定・利用サービス</span><strong>${escapeHtml(draft.serviceCategory)}</strong><small>受給者証番号 ${escapeHtml(state.profile.recipientNumber)}</small></article>
    <article><span>作成日</span><strong>${escapeHtml(formatDateJP(draft.preparedDate))}</strong><small>${escapeHtml(draft.agencyName)}</small></article>`;
  const section = (number, title, description, fields) => `
    <section class="consultation-section">
      <div class="consultation-section-heading"><span>${number}</span><div><h4>${title}</h4><p>${description}</p></div></div>
      <div class="draft-fields consultation-fields">${fields.join("")}</div>
    </section>`;
  $("#consultation-draft-fields").innerHTML = [
    section("01", "生活目標", "本人や家族が希望する毎日と、1年後に目指す生活のイメージです。", [
      draftTextarea("consultationPlanDraft", "personWish", "本人が希望する1日", draft.personWish, 3),
      draftTextarea("consultationPlanDraft", "guardianWish", "家族が希望する暮らし", draft.guardianWish, 3),
      draftTextarea("consultationPlanDraft", "overallGoal", "総合的な目標", draft.overallGoal, 4),
      draftTextarea("consultationPlanDraft", "oneYearVision", "1年後の生活イメージ", draft.oneYearVision, 4)
    ]),
    section("02", "現在の状況と課題", "運動・移動・健康管理・社会参加などを、本人の強みも含めて確認します。", [
      draftTextarea("consultationPlanDraft", "currentSituation", "現在の状況・課題", draft.currentSituation, 5),
      draftTextarea("consultationPlanDraft", "serviceNeed", "必要な支援の方向", draft.serviceNeed, 4)
    ]),
    section("03", "具体的な支援と役割分担", "フォーマルサービスだけでなく、本人・家族・地域の役割も一緒に整理します。", [
      draftTextarea("consultationPlanDraft", "dayServiceRole", "放課後等デイサービスの役割", draft.dayServiceRole, 4),
      draftTextarea("consultationPlanDraft", "selfCareRole", "本人・セルフケアの役割", draft.selfCareRole, 3),
      draftTextarea("consultationPlanDraft", "familyRole", "家族の協力", draft.familyRole, 3),
      draftTextarea("consultationPlanDraft", "communityRole", "学校・地域・相談支援との連携", draft.communityRole, 3),
      draftTextarea("consultationPlanDraft", "considerations", "配慮・連携事項", draft.considerations, 3)
    ]),
    section("04", "作成から同意・交付まで", "自動作成できない、本人・家族と支援者が確認して進める工程です。", [
      draftTextarea("consultationPlanDraft", "assessmentProcess", "情報収集（アセスメント）", draft.assessmentProcess, 3),
      draftTextarea("consultationPlanDraft", "draftProcess", "原案の作成", draft.draftProcess, 3),
      draftTextarea("consultationPlanDraft", "consentProcess", "同意と交付", draft.consentProcess, 3)
    ])
  ].join("");
  refreshWritingTools($("#consultation-draft-fields"));
}

function renderContactBook() {
  const entries = [...state.contactBookEntries].sort((a, b) => b.date.localeCompare(a.date));
  $("#nav-contact-count").textContent = String(entries.length);
  $("#contact-book-status").textContent = `${entries.filter((entry) => entry.reflected).length}件を支援の検討へ反映`;
  $("#contact-book-list").innerHTML = entries.length
    ? entries.map((entry) => `
      <article class="contact-book-entry ${entry.reflected ? "is-reflected" : ""}">
        <div class="contact-book-date"><strong>${escapeHtml(formatDateJP(entry.date, { withYear: false }))}</strong><span>${entry.reflected ? "反映済み" : "要確認"}</span></div>
        <div class="contact-book-message"><span>保護者から</span><p>${escapeHtml(entry.familyMessage)}</p></div>
        <div class="contact-book-reply"><span>事業所の対応</span><p>${escapeHtml(entry.serviceReply)}</p></div>
        <div class="contact-book-request"><strong>支援へ組み込む要望</strong><p>${escapeHtml(entry.request)}</p><button class="inline-link" type="button" data-apply-contact-entry="${escapeAttribute(entry.id)}" ${entry.reflected ? "disabled" : ""}>${entry.reflected ? "アセスメントへ反映済み" : "アセスメントの検討事項へ反映 →"}</button></div>
      </article>`).join("")
    : `<div class="empty-state"><div><strong>連絡帳の記録はまだありません</strong><p>保護者とのやりとりを追加すると、次の支援を考える際の確認事項として残せます。</p></div></div>`;
}

function renderAssessmentDraft() {
  const draft = state.assessmentDraft;
  $("#assessment-source-status").textContent = `${draft.sourcePeriod}の日誌・モニタリング + 相談支援案`;
  $("#assessment-profile-strip").innerHTML = `
    <article><span>本人</span><strong>${escapeHtml(state.profile.displayName)}さん</strong><small>${escapeHtml(state.profile.grade)}・${escapeHtml(state.profile.serviceType)}</small></article>
    <article><span>日誌の根拠</span><strong>${escapeHtml(draft.sourcePeriod)}</strong><small>日誌だけで結論は出しません</small></article>
    <article><span>次の工程</span><strong>個別支援計画の原案</strong><small>本人・家族・支援者で確認して決定</small></article>`;
  $("#assessment-consultation-link").innerHTML = `<strong>相談支援案から引き継ぐ目標</strong><span>${escapeHtml(draft.consultationGoal || "相談支援事業所の案を確認してください。")} </span><button class="inline-link" type="button" data-view-target="consultation">相談支援案を確認する →</button>`;
 $("#assessment-draft-fields").innerHTML = [
    draftTextarea("assessmentDraft", "personWish", "本人の意向", draft.personWish, 3),
    draftTextarea("assessmentDraft", "familyWish", "家族の意向", draft.familyWish, 3),
    draftTextarea("assessmentDraft", "strengths", "本人の強み・活かせること", draft.strengths, 3),
    draftTextarea("assessmentDraft", "needs", "生活上の課題・支援の必要性", draft.needs, 4),
    draftTextarea("assessmentDraft", "supportDirection", "支援の方向性", draft.supportDirection, 4),
   draftTextarea("assessmentDraft", "planningNote", "計画書へ引き継ぐこと", draft.planningNote, 3)
 ].join("");
  refreshWritingTools(document.getElementById("assessment-draft-fields"));
}

function refreshPlanStale() {
  state.planStale = !isPlanSourceFresh(state.plan, getAnalysisJournals());
  return state.planStale;
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function toMonthDay(value) {
  const date = localDateFromIso(value);
  if (!date) return { month: "--", day: "--", weekday: "" };
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return { month: String(date.getMonth() + 1), day: String(date.getDate()), weekday: weekdays[date.getDay()] };
}

function setByPath(target, path, value) {
  const keys = path.split(".");
  let current = target;
  keys.slice(0, -1).forEach((key) => {
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  });
  current[keys.at(-1)] = value;
}

function saveState({ quiet = false } = {}) {
  state.updatedAt = new Date().toISOString();
  syncActiveWorkspace();
  const status = $("#save-status");
  if (!quiet && status) {
    status.classList.add("is-saving");
    status.lastChild.textContent = "保存中…";
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (status) {
        status.classList.remove("is-saving");
        status.lastChild.textContent = "自動保存済み";
      }
    } catch (error) {
      if (status) {
        status.classList.remove("is-saving");
        status.lastChild.textContent = "保存できません";
      }
      showToast(`ブラウザ内へ保存できませんでした：${error.message}`);
    }
  }, quiet ? 0 : 180);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function announce(message) {
  $("#live-region").textContent = message;
}

function renderDomainChips(domains) {
  return (domains ?? [])
    .filter((domain) => DOMAIN_META[domain])
    .map((domain) => {
      const meta = DOMAIN_META[domain];
      return `<span class="domain-chip" style="--chip-color:${meta.color}">${escapeHtml(meta.name)}</span>`;
    })
    .join("");
}

function renderDomainToggles(name, selected = [], dataAttributes = "") {
  return Object.values(DOMAIN_META)
    .map(
      (meta) => `
        <label class="domain-toggle" style="--toggle-color:${meta.color}">
          <input type="checkbox" name="${escapeAttribute(name)}" value="${meta.id}" ${selected.includes(meta.id) ? "checked" : ""} ${dataAttributes} />
          <span>${escapeHtml(meta.name)}</span>
        </label>`
    )
    .join("");
}

function navigate(view, { preserveScroll = false, focusHeading = true } = {}) {
  if (!VIEW_TITLES[view]) return;
  state.activeView = view;
  $$(".view").forEach((section) => {
    const active = section.dataset.view === view;
    section.hidden = !active;
    section.classList.toggle("is-active", active);
  });
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.viewTarget === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#page-title").textContent = VIEW_TITLES[view].title;
  $("#breadcrumb-current").textContent = VIEW_TITLES[view].breadcrumb;

  if (view === "journals") renderJournals();
  if (view === "childProfile") renderChildProfile();
  if (view === "consultation") renderConsultationDraft();
  if (view === "contactBook") renderContactBook();
  if (view === "analysis") renderAnalysis();
  if (view === "assessment") renderAssessmentDraft();
  if (view === "plan") renderPlan();
  if (!preserveScroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (focusHeading) {
    const heading = $(`#view-${view} h2`);
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      announce(`${VIEW_TITLES[view].title}画面を表示しました。`);
    }
  }
  saveState({ quiet: true });
}

function renderSidebar() {
  $("#sidebar-child-name").innerHTML = `${escapeHtml(state.profile.displayName)} <small>（仮名）</small>`;
  $("#sidebar-child-meta").textContent = `${state.profile.grade}・利用週3回`;
  $("#sidebar-child-avatar").textContent = state.profile.displayName.slice(0, 1);
  $("#nav-journal-count").textContent = String(state.journals.length);
  $("#nav-contact-count").textContent = String(state.contactBookEntries?.length ?? 0);
  const children = Object.values(state.childWorkspaces)
    .map((workspace) => workspace.profile)
    .filter((profile) => profile?.id && profile?.displayName)
    .sort((a, b) => a.id.localeCompare(b.id));
  $("#child-switcher-options").innerHTML = children
    .map((profile) => `
      <button class="child-switch-option ${profile.id === state.activeChildId ? "is-active" : ""}" type="button" data-child-id="${escapeAttribute(profile.id)}" aria-pressed="${profile.id === state.activeChildId}">
        <span>${escapeHtml(profile.displayName.slice(0, 1))}</span><strong>${escapeHtml(profile.displayName)}</strong><small>${escapeHtml(profile.grade)}</small>
      </button>`)
    .join("");
}

function profileInput(path, label, value, type = "text", extra = "") {
  const lengthLimit = type === "text" ? 'maxlength="200"' : "";
  return `<label><span>${escapeHtml(label)}</span><input type="${type}" data-profile-path="${escapeAttribute(path)}" value="${escapeAttribute(value ?? "")}" ${lengthLimit} ${extra} /></label>`;
}

function profileTextarea(path, label, value, rows = 3) {
  return `<label class="full-width"><span>${escapeHtml(label)}</span><textarea data-profile-path="${escapeAttribute(path)}" rows="${rows}" maxlength="2000">${escapeHtml(value ?? "")}</textarea></label>`;
}

function renderChildProfileSummary() {
  const profile = state.profile;
  $("#child-profile-summary").innerHTML = `
    <div class="profile-identity"><span class="profile-avatar">${escapeHtml(profile.displayName.slice(0, 1) || "？")}</span><div><p class="eyebrow">現在選択中の利用児</p><h3>${escapeHtml(profile.displayName || "未登録")}</h3><p>${escapeHtml(profile.legalName || "帳票用氏名は未入力")} ・ ${escapeHtml(profile.grade || "学年未入力")}</p></div></div>
    <dl class="profile-overview-list">
      <div><dt>生年月日</dt><dd>${escapeHtml(profile.birthDate ? formatDateJP(profile.birthDate) : "未入力")}</dd></div>
      <div><dt>保護者氏名</dt><dd>${escapeHtml(profile.guardianName || "未入力")}</dd></div>
      <div><dt>受給者証番号</dt><dd>${escapeHtml(profile.recipientNumber || "未入力")}</dd></div>
      <div><dt>利用サービス</dt><dd>${escapeHtml(profile.serviceType || "未入力")}</dd></div>
      <div><dt>利用予定</dt><dd>${escapeHtml(profile.usePattern || "未入力")}</dd></div>
      <div><dt>日誌の件数</dt><dd>${state.journals.length}件</dd></div>
    </dl>`;
}

function renderChildProfile() {
  const profile = state.profile;
  renderChildProfileSummary();
  $("#child-profile-fields").innerHTML = [
    profileInput("displayName", "表示名（画面上の呼び名）", profile.displayName),
    profileInput("legalName", "利用児氏名（帳票用）", profile.legalName),
    profileInput("birthDate", "生年月日", profile.birthDate, "date"),
    profileInput("grade", "学年", profile.grade),
    profileInput("guardianName", "保護者氏名", profile.guardianName),
    profileInput("recipientNumber", "受給者証番号", profile.recipientNumber),
    profileInput("serviceType", "利用サービス", profile.serviceType),
    profileInput("serviceName", "事業所名", profile.serviceName),
    profileInput("usePattern", "利用予定", profile.usePattern),
    profileInput("standardSchedule", "標準的な利用時間", profile.standardSchedule),
    profileInput("managerName", "児童発達支援管理責任者", profile.managerName),
    profileTextarea("personWish", "本人の希望・大切にしたいこと", profile.personWish, 3),
    profileTextarea("familyWish", "家族の希望・心配ごと", profile.familyWish, 3),
    profileTextarea("currentPlanContext", "現在の支援状況・引き継ぎ事項", profile.currentPlanContext, 3)
  ].join("");
}

function syncProfileToPlan() {
  const profile = state.profile;
  if (!state.plan) return;
  state.plan.child.name = profile.legalName || profile.displayName;
  state.plan.child.guardianName = profile.guardianName;
  state.plan.child.birthDate = profile.birthDate;
  state.plan.child.grade = profile.grade;
  state.plan.child.recipientNumber = profile.recipientNumber;
  state.plan.child.ageLabel = calculateAgeLabel(profile.birthDate, state.plan.planStart) || profile.ageLabel || "";
  state.plan.service.name = profile.serviceName;
  state.plan.service.type = profile.serviceType;
  state.plan.service.managerName = profile.managerName;
  state.plan.service.usePattern = profile.usePattern;
  state.plan.service.standardSchedule = profile.standardSchedule;
}

function updateProfileAfterInput(input) {
  const path = input.dataset.profilePath;
  if (!path) return;
  setByPath(state.profile, path, input.value);
  syncProfileToPlan();
  saveState({ quiet: true });
  renderSidebar();
  renderChildProfileSummary();
}

function switchChild(childId) {
  if (!state.childWorkspaces?.[childId] || childId === state.activeChildId) return;
  syncActiveWorkspace();
  const nextWorkspace = structuredClone(state.childWorkspaces[childId]);
  state = {
    ...state,
    ...nextWorkspace,
    activeChildId: childId,
    childWorkspaces: state.childWorkspaces
  };
  state.consultationPlanDraft ??= createConsultationPlanDraft(state.profile);
  state.contactBookEntries ??= createContactBookEntries(state.profile);
  state.assessmentDraft ??= createAssessmentDraft(state.profile, state.monitoringDraft, state.consultationPlanDraft);
  renderAll();
  navigate(state.activeView, { preserveScroll: true, focusHeading: false });
  saveState();
  showToast(`${state.profile.displayName}のデモに切り替えました。日誌から各下書きまで、児童ごとの内容を確認できます。`);
}

function renderDashboard() {
  const analysis = analyzeJournals(state.journals);
  const indicatorDeltas = Object.values(analysis.indicators).map((item) => item.delta).filter(Number.isFinite);
  const meanDelta = indicatorDeltas.length ? indicatorDeltas.reduce((sum, value) => sum + value, 0) / indicatorDeltas.length : null;
  $("#hero-entry-count").textContent = String(analysis.count);
  $("#journey-period").textContent = analysis.period;

  const metrics = [
    { label: "対象日誌", value: analysis.count, unit: "件", caption: analysis.period, color: "#4e7d89" },
    { label: "5領域の網羅", value: analysis.coverage.covered, unit: "/ 5領域", caption: "本人支援全体で確認", color: "#769072" },
    { label: "記録期間", value: analysis.count ? Math.max(1, Math.round((new Date(`${analysis.endDate}T00:00:00`) - new Date(`${analysis.startDate}T00:00:00`)) / 86_400_000) + 1) : 0, unit: "日間", caption: "揺らぎを含めて観察", color: "#b57e4c" },
    {
      label: "後半の指標変化",
      value: meanDelta === null ? "未評価" : `${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(1)}`,
      unit: meanDelta === null ? "" : " / 4.0",
      caption: meanDelta === null ? "有効な前半・後半の比較値がありません" : "前半平均との差・判定ではありません",
      color: "#a15f6e"
    }
  ];

  $("#dashboard-metrics").innerHTML = metrics
    .map(
      (metric) => `
        <article class="metric-card">
          <div class="metric-label"><i style="background:${metric.color}"></i>${escapeHtml(metric.label)}</div>
          <div class="metric-value">${escapeHtml(metric.value)}<small>${escapeHtml(metric.unit)}</small></div>
          <p class="metric-caption">${escapeHtml(metric.caption)}</p>
        </article>`
    )
    .join("");

  const latest = [...state.journals].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  $("#latest-journals").innerHTML = latest.length
    ? latest
        .map((journal) => {
          const date = toMonthDay(journal.date);
          return `
            <button class="latest-item" type="button" data-journal-id="${escapeAttribute(journal.id)}">
              <span class="latest-date"><small>${date.month}月</small><strong>${date.day}</strong></span>
              <span><strong>${escapeHtml(journal.activity)}</strong><p>${escapeHtml(journal.response)}</p></span>
              <span class="latest-arrow" aria-hidden="true">›</span>
            </button>`;
        })
        .join("")
    : `<div class="empty-state"><div><strong>日誌がありません</strong><p>日誌を追加すると、ここに最新記録が表示されます。</p></div></div>`;

  const maxCount = Math.max(1, ...analysis.domains.map((domain) => domain.count));
  $("#dashboard-domains").innerHTML = analysis.domains
    .map(
      (domain) => `
        <article class="domain-mini" style="--domain-color:${domain.soft};--domain-accent:${domain.color}">
          <div class="domain-mini-number"><strong>${domain.count}</strong><small>記録</small></div>
          <div class="domain-mini-name">${escapeHtml(domain.name)}</div>
          <div class="domain-mini-bar"><span style="width:${Math.round((domain.count / maxCount) * 100)}%"></span></div>
        </article>`
    )
    .join("");
}

function populateMonthFilter() {
  const select = $("#journal-month-filter");
  const months = [...new Set(state.journals.map((journal) => journal.date.slice(0, 7)).filter((month) => /^\d{4}-\d{2}$/.test(month)))].sort();
  const current = state.filters.month;
  select.innerHTML = `<option value="all">すべての月</option>${months
    .map((month) => {
      const [year, number] = month.split("-");
      return `<option value="${month}">${year}年${Number(number)}月</option>`;
    })
    .join("")}`;
  select.value = months.includes(current) ? current : "all";
  if (select.value !== current) state.filters.month = select.value;
}

function getFilteredJournals() {
  const search = state.filters.search.trim().toLocaleLowerCase("ja");
  return [...state.journals]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((journal) => {
      if (state.filters.domain !== "all" && !journal.domains.includes(state.filters.domain)) return false;
      if (state.filters.month !== "all" && !journal.date.startsWith(state.filters.month)) return false;
      if (!search) return true;
      const haystack = [journal.activity, journal.observation, journal.support, journal.response, journal.familyNote, journal.mood]
        .join(" ")
        .toLocaleLowerCase("ja");
      return haystack.includes(search);
    });
}

function renderJournalList() {
  const journals = getFilteredJournals();
  $("#journal-result-count").textContent = `${journals.length}件`;
  if (journals.length && !journals.some((journal) => journal.id === state.selectedJournalId)) {
    state.selectedJournalId = journals[0].id;
  }

  $("#journal-list").innerHTML = journals.length
    ? journals
        .map((journal) => {
          const date = toMonthDay(journal.date);
          return `
            <button class="journal-card ${journal.id === state.selectedJournalId ? "is-selected" : ""}" type="button" data-journal-id="${escapeAttribute(journal.id)}" aria-pressed="${journal.id === state.selectedJournalId}">
              <span class="journal-card-date"><small>${date.month}月・${date.weekday}</small><strong>${date.day}</strong></span>
              <span>
                <span class="journal-card-top"><strong>${escapeHtml(journal.activity)}</strong><span class="mood-chip">${escapeHtml(journal.mood || "未記入")}</span></span>
                <p>${escapeHtml(journal.observation)}</p>
                <span class="domain-chips">${renderDomainChips(journal.domains)}</span>
              </span>
            </button>`;
        })
        .join("")
    : `<div class="empty-state"><div><strong>条件に一致する日誌がありません</strong><p>絞り込みを変更するか、新しい日誌を追加してください。</p><button class="mini-button" type="button" data-clear-filters>絞り込みを解除</button></div></div>`;

  renderJournalDetail();
}

function renderJournalDetail() {
  const journal = getJournalById(state.journals, state.selectedJournalId);
  const detail = $("#journal-detail");
  if (!journal) {
    detail.innerHTML = `<div class="journal-detail-empty"><div><p class="eyebrow">NO RECORD SELECTED</p><strong>左から日誌を選択してください</strong></div></div>`;
    return;
  }
  const date = toMonthDay(journal.date);
  const steps = [
    { label: "観察した事実", value: journal.observation },
    { label: "行った支援", value: journal.support },
    { label: "本人の反応・変化", value: journal.response },
    { label: "家庭との共有", value: journal.familyNote || "共有事項なし" }
  ];
  detail.innerHTML = `
    <div class="detail-heading">
      <div>
        <p class="eyebrow">${escapeHtml(formatDateJP(journal.date, { withWeekday: true }))}</p>
        <h3>${escapeHtml(journal.activity)}</h3>
        <p>${escapeHtml(journal.time || "利用時間未記入")}・記録者 ${escapeHtml(journal.staff || "未記入")}</p>
      </div>
      <div class="detail-actions">
        <button class="mini-button" type="button" data-edit-journal="${escapeAttribute(journal.id)}">編集</button>
        <button class="mini-button danger" type="button" data-delete-journal="${escapeAttribute(journal.id)}">削除</button>
      </div>
    </div>
    <div class="detail-meta-strip">
      <div><span>来所時</span><strong>${escapeHtml(journal.mood || "未記入")}</strong></div>
      <div><span>健康・体調</span><strong>${escapeHtml(journal.physical || "未記入")}</strong></div>
      <div><span>関連領域</span><strong>${journal.domains.length}領域</strong></div>
    </div>
    <div class="domain-chips" style="margin-bottom:20px">${renderDomainChips(journal.domains)}</div>
    <div class="detail-flow">
      ${steps
        .map(
          (step, index) => `
            <div class="detail-step">
              <span class="detail-step-number">0${index + 1}</span>
              <strong>${escapeHtml(step.label)}</strong>
              <p>${escapeHtml(step.value)}</p>
            </div>`
        )
        .join("")}
    </div>
    <div class="detail-indicators">
      ${Object.entries(INDICATOR_META)
        .map(([key, meta]) => {
          const value = Number(journal.indicators?.[key] ?? 0);
          return `
            <div class="mini-indicator">
              <span>${escapeHtml(meta.name)}</span><strong>${value || "–"} / 4</strong>
              <div class="mini-indicator-bar"><i style="width:${(value / 4) * 100}%"></i></div>
            </div>`;
        })
        .join("")}
    </div>`;
}

function renderJournals() {
  $("#journal-search").value = state.filters.search;
  $("#journal-domain-filter").value = state.filters.domain;
  populateMonthFilter();
  renderJournalList();
}

function renderAnalysis() {
  const sourceJournals = getAnalysisJournals();
  const analysis = analyzeJournals(sourceJournals);
  const splitPeriod = (start, end, count) =>
    start && end ? `${formatDateJP(start, { withYear: false })}〜${formatDateJP(end, { withYear: false })}（${count}件）` : "記録なし";
  $("#analysis-range-start").value = state.analysisRange.start;
  $("#analysis-range-end").value = state.analysisRange.end;
  const days = rangeDays(state.analysisRange);
  $("#analysis-range-status").textContent = Number.isFinite(days)
    ? `${formatDateJP(state.analysisRange.start)}〜${formatDateJP(state.analysisRange.end)}の${sourceJournals.length}件を、前半と後半に分けて見比べます（${days}日間）。期間を変えると、計画案は再作成が必要です。`
    : `開始日から終了日まで${MAX_ANALYSIS_DAYS}日以内で選んでください。`;
  $("#indicator-comparison-key").innerHTML = `
    <span><i></i><strong>前半</strong><small>${escapeHtml(splitPeriod(analysis.split.firstStart, analysis.split.firstEnd, analysis.split.firstCount))}</small></span>
    <span><i></i><strong>後半</strong><small>${escapeHtml(splitPeriod(analysis.split.secondStart, analysis.split.secondEnd, analysis.split.secondCount))}</small></span>`;
  $("#indicator-chart").innerHTML = Object.values(analysis.indicators)
    .map((indicator) => {
      const first = Number.isFinite(indicator.first) ? indicator.first : null;
      const second = Number.isFinite(indicator.second) ? indicator.second : null;
      const delta = Number.isFinite(indicator.delta) ? indicator.delta : null;
      const deltaLabel = delta === null
        ? "比べられません"
        : Math.abs(delta) < 0.05
          ? "ほぼ同じです"
          : `後半は${Math.abs(delta).toFixed(1)}点${delta > 0 ? "高い" : "低い"}`;
      return `
      <div class="indicator-row ${delta === null ? "is-unrated" : ""}">
        <div class="indicator-row-label"><strong>${escapeHtml(indicator.name)}</strong><small>${escapeHtml(indicator.description)}</small><em>比較に使った記録：${indicator.firstCount + indicator.secondCount}件</em></div>
        <div class="dual-bars">
          <div class="bar-track" title="前半 ${first ?? "未評価"}"><span style="width:${first === null ? 0 : (first / 4) * 100}%"></span></div>
          <div class="bar-track" title="後半 ${second ?? "未評価"}"><span style="width:${second === null ? 0 : (second / 4) * 100}%"></span></div>
        </div>
        <span class="indicator-delta ${delta === null || Math.abs(delta) < 0.05 ? "is-flat" : ""}"><small>平均点の差</small><strong>${deltaLabel}</strong></span>
      </div>`;
    })
    .join("");

  $("#pattern-list").innerHTML = analysis.patterns
    .map((pattern) => `
      <article class="pattern-item ${pattern.isConfirmed ? "" : "is-unconfirmed"}">
        <span class="pattern-icon">${escapeHtml(pattern.isConfirmed ? pattern.marker : "?")}</span>
        <div class="pattern-item-body"><strong>${escapeHtml(pattern.isConfirmed ? pattern.title : `確認途中｜${pattern.title}`)}</strong><p>${escapeHtml(pattern.summary)}（${pattern.isConfirmed ? "関連" : "該当"}記録 ${pattern.count}件）</p>${pattern.isConfirmed ? `<button class="pattern-plan-link" type="button" data-edit-pattern-plan="${escapeAttribute(pattern.id)}">このヒントを編集して計画書へ <span aria-hidden="true">→</span></button>` : ""}</div>
      </article>`)
    .join("");

  const evidence = [];
  for (const pattern of analysis.patterns.filter((item) => item.isConfirmed)) {
    const id = pattern.evidenceIds.at(-1) || pattern.evidenceIds[0];
    if (id && !evidence.some((journal) => journal.id === id)) {
      const journal = getJournalById(state.journals, id);
      if (journal) evidence.push(journal);
    }
  }
  $("#analysis-evidence").innerHTML = evidence.length
    ? evidence
        .slice(0, 4)
        .map((journal) => `
          <button class="evidence-card" type="button" data-evidence-journal-id="${escapeAttribute(journal.id)}">
            <span class="evidence-card-date">${escapeHtml(formatDateJP(journal.date, { withYear: false, withWeekday: true }))}</span>
            <strong>${escapeHtml(journal.activity)}</strong>
            <p>${escapeHtml(journal.response)}</p>
            <small>元の日誌を見る →</small>
          </button>`)
        .join("")
    : `<div class="empty-state" style="grid-column:1/-1"><div><strong>分析できる日誌がありません</strong><p>複数日の記録を追加してください。</p></div></div>`;

  $("#domain-analysis-list").innerHTML = analysis.domains
    .map((domain) => `
      <div class="domain-analysis-row">
        <div class="domain-analysis-name" style="--row-color:${domain.color}"><i></i>${escapeHtml(domain.name)}</div>
        <div class="domain-analysis-count">${domain.count}件・${domain.percent}%</div>
        <p class="domain-analysis-summary">${escapeHtml(domain.count ? domain.summary : "この期間の日誌には、関連付けられた記録がありません。追加アセスメントで確認してください。")}</p>
      </div>`)
    .join("");
  renderMonitoringDraft();
}

function planInput(path, label, value, type = "text", extra = "") {
  const lengthLimit = type === "text" ? 'maxlength="200"' : "";
  return `<label><span>${escapeHtml(label)}</span><input type="${type}" data-plan-path="${escapeAttribute(path)}" value="${escapeAttribute(value ?? "")}" ${lengthLimit} ${extra} /></label>`;
}

function planTextarea(path, label, value, rows = 3) {
  return `<label class="writing-field"><span>${escapeHtml(label)}</span><textarea data-plan-path="${escapeAttribute(path)}" rows="${rows}" maxlength="2000">${escapeHtml(value ?? "")}</textarea>${writingToolsMarkup()}</label>`;
}

function supportSectionEditor(key, heading, section, { allowNotApplicable = false } = {}) {
  return `
    <div class="support-goal-card">
      <div class="support-goal-heading"><div class="support-goal-title"><span class="priority-badge">${escapeHtml(heading.slice(0, 1))}</span><div><strong>${escapeHtml(heading)}</strong><small>本人支援以外の支援区分</small></div></div></div>
      ${allowNotApplicable ? `
        <label class="domain-toggle support-na-toggle" style="--toggle-color:#4f8588">
          <input type="checkbox" data-plan-boolean="${escapeAttribute(key)}.notApplicable" ${section.notApplicable ? "checked" : ""} />
          <span>この計画では該当なし（理由の記録が必要）</span>
        </label>` : ""}
      <div class="goal-fields">
        ${allowNotApplicable ? `<div class="full-width">${planInput(`${key}.reason`, "該当なしの理由", section.reason)}</div>` : ""}
        <div class="full-width">${planTextarea(`${key}.goal`, "到達目標", section.goal, 2)}</div>
        <div class="full-width">${planTextarea(`${key}.support`, "具体的な支援内容", section.support, 3)}</div>
        <div class="full-width">${planTextarea(`${key}.evaluation`, "評価方法", section.evaluation, 2)}</div>
        ${planInput(`${key}.targetDate`, "達成時期", section.targetDate, "date")}
        ${planInput(`${key}.responsible`, "担当者・提供機関", section.responsible)}
        <div class="full-width">${planTextarea(`${key}.notes`, "留意事項", section.notes, 2)}</div>
      </div>
    </div>`;
}

function renderPlanEditor() {
  const plan = state.plan;
  const editor = $("#plan-editor");
  editor.innerHTML = `
    <section class="editor-section">
      <div class="editor-section-heading"><h3>基本情報と計画期間</h3><span class="editor-section-index">01 / 06</span></div>
      <div class="form-grid">
        ${planInput("child.name", "利用児氏名", plan.child.name)}
        ${planInput("child.guardianName", "保護者氏名", plan.child.guardianName)}
        ${planInput("child.birthDate", "生年月日", plan.child.birthDate, "date")}
        ${planInput("child.grade", "学年", plan.child.grade)}
        ${planInput("child.recipientNumber", "受給者証番号", plan.child.recipientNumber)}
        ${planInput("service.name", "事業所名", plan.service.name)}
        ${planInput("service.type", "サービス種別", plan.service.type)}
        ${planInput("service.managerName", "児童発達支援管理責任者", plan.service.managerName)}
        ${planInput("planStart", "計画開始日", plan.planStart, "date")}
        ${planInput("planEnd", "計画終了日", plan.planEnd, "date")}
        ${planInput("reviewDate", "次回見直し期限", plan.reviewDate, "date")}
        ${planInput("createdDate", "原案作成日", plan.createdDate, "date")}
        ${planInput("version", "計画版番号", plan.version, "number", 'min="1" step="1"')}
        ${planInput("service.usePattern", "利用頻度", plan.service.usePattern)}
        ${planInput("service.standardSchedule", "標準的な提供時間", plan.service.standardSchedule)}
      </div>
    </section>

    <section class="editor-section">
      <div class="editor-section-heading"><div><h3>本人・家族の意向</h3><span class="editor-section-note">デモ値です。実運用では面接内容へ置き換えてください。</span></div><span class="editor-section-index">02 / 06</span></div>
      <div class="form-stack">
        ${planTextarea("personWish", "本人の生活に対する意向", plan.personWish, 3)}
        ${planTextarea("familyWish", "家族の生活に対する意向", plan.familyWish, 3)}
        ${planTextarea("qualityOfLifeNeeds", "生活全般の質を向上させるための課題", plan.qualityOfLifeNeeds, 3)}
      </div>
    </section>

    <section class="editor-section">
      <div class="editor-section-heading"><h3>総合方針と目標</h3><span class="editor-section-index">03 / 06</span></div>
      <div class="form-stack">
        ${planTextarea("comprehensivePolicy", "総合的な支援の方針", plan.comprehensivePolicy, 5)}
        ${planTextarea("longTermGoal", "長期目標（概ね1年）", plan.longTermGoal, 3)}
        ${planTextarea("shortTermGoal", "短期目標（概ね6か月）", plan.shortTermGoal, 3)}
      </div>
    </section>

    <section class="editor-section">
      <div class="editor-section-heading"><div><h3>本人支援</h3><span class="editor-section-note">5領域は1対1に分けず、本人支援全体で網羅します。</span></div><span class="editor-section-index">04 / 06</span></div>
      <div id="support-goal-list">
        ${plan.supportItems
          .map((item, index) => `
            <article class="support-goal-card" data-support-card="${index}">
              <div class="support-goal-heading">
                <div class="support-goal-title"><span class="priority-badge">${escapeHtml(item.priority)}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.category)}・優先${escapeHtml(item.priority)} ${String(item.id).startsWith("support-custom-") ? "" : '<span class="journal-candidate-badge">日誌から候補</span>'}</small></div></div>
                <button class="mini-button danger" type="button" data-remove-support="${index}">この目標を削除</button>
              </div>
              <div class="goal-fields">
                <div class="full-width">${planInput(`supportItems.${index}.title`, "項目名", item.title)}</div>
                <div class="full-width">${planTextarea(`supportItems.${index}.goal`, "具体的な到達目標", item.goal, 3)}</div>
                <div class="full-width">${planTextarea(`supportItems.${index}.support`, "支援内容・工夫・配慮", item.support, 4)}</div>
                <div class="full-width">${planTextarea(`supportItems.${index}.evaluation`, "評価方法", item.evaluation, 2)}</div>
                ${planInput(`supportItems.${index}.targetDate`, "達成時期", item.targetDate, "date")}
                ${planInput(`supportItems.${index}.responsible`, "担当者・提供機関", item.responsible)}
                <div class="full-width">
                  <fieldset class="support-domain-fieldset"><legend>関連する5領域</legend><div class="domain-toggle-list">
                    ${Object.values(DOMAIN_META)
                      .map((meta) => `
                        <label class="domain-toggle" style="--toggle-color:${meta.color}">
                          <input type="checkbox" value="${meta.id}" data-support-domain="${index}" ${item.domains.includes(meta.id) ? "checked" : ""} />
                          <span>${escapeHtml(meta.name)}</span>
                        </label>`)
                      .join("")}
                  </div></fieldset>
                </div>
                <div class="full-width">${planTextarea(`supportItems.${index}.notes`, "留意事項", item.notes, 2)}</div>
              </div>
              <div class="evidence-links"><span>日誌から自動でつないだ根拠</span>
                ${(item.evidenceIds ?? []).length
                  ? item.evidenceIds
                      .map((id) => {
                        const journal = getJournalById(state.journals, id);
                        return journal ? `<button class="evidence-link" type="button" data-evidence-journal-id="${escapeAttribute(id)}">${escapeHtml(formatDateJP(journal.date, { withYear: false }))}</button>` : "";
                      })
                      .join("")
                  : `<small>根拠日誌がありません</small>`}
              </div>
              <details class="evidence-picker">
                <summary>根拠日誌を選択 <span>${item.evidenceIds?.length ?? 0}件</span></summary>
                <div class="evidence-option-list">
                  ${[...getAnalysisJournals()]
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((journal) => `
                      <label class="evidence-option">
                        <input type="checkbox" value="${escapeAttribute(journal.id)}" data-support-evidence="${index}" ${item.evidenceIds?.includes(journal.id) ? "checked" : ""} />
                        <span><strong>${escapeHtml(formatDateJP(journal.date, { withYear: false }))}・${escapeHtml(journal.activity)}</strong><small>${escapeHtml(journal.response)}</small></span>
                      </label>`)
                    .join("") || `<p>選択できる日誌がありません。</p>`}
                </div>
              </details>
            </article>`)
          .join("")}
      </div>
      <button class="add-goal-button" id="add-support-goal" type="button">＋ 本人支援の目標を追加</button>
    </section>

    <section class="editor-section">
      <div class="editor-section-heading"><div><h3>家族・移行・地域連携</h3><span class="editor-section-note">移行支援にはインクルージョンの具体策を含めます。</span></div><span class="editor-section-index">05 / 06</span></div>
      ${supportSectionEditor("familySupport", "家族支援", plan.familySupport)}
      ${supportSectionEditor("transitionSupport", "移行支援", plan.transitionSupport)}
      ${supportSectionEditor("communitySupport", "地域支援・地域連携", plan.communitySupport, { allowNotApplicable: true })}
      <div class="form-stack">${planTextarea("monitoringPlan", "モニタリング方法", plan.monitoringPlan, 3)}</div>
    </section>

    <section class="editor-section" id="workflow-section">
      <div class="editor-section-heading"><div><h3>確認・説明・交付の記録</h3><span class="editor-section-note">日誌から自動作成できない、正式決定に必要な工程です。</span></div><span class="editor-section-index">06 / 06</span></div>
      <div class="form-grid">
        ${planInput("workflow.assessmentInterview.date", "本人・保護者面接日", plan.workflow.assessmentInterview.date, "date")}
        ${planInput("workflow.assessmentInterview.participants", "面接参加者", plan.workflow.assessmentInterview.participants, "text", 'placeholder="本人、保護者、児発管など"')}
        ${planInput("workflow.supportMeeting.date", "個別支援会議日", plan.workflow.supportMeeting.date, "date")}
        ${planInput("workflow.supportMeeting.participants", "会議参加者", plan.workflow.supportMeeting.participants)}
        ${planInput("workflow.childExplanation.date", "本人への説明日", plan.workflow.childExplanation.date, "date")}
        ${planInput("workflow.childExplanation.method", "本人への説明方法・配慮", plan.workflow.childExplanation.method)}
        ${planInput("workflow.guardianConsent.date", "保護者の文書同意日", plan.workflow.guardianConsent.date, "date")}
        ${planInput("workflow.guardianConsent.method", "同意方法", plan.workflow.guardianConsent.method)}
        ${planInput("workflow.guardianConsent.version", "文書同意の対象版番号", plan.workflow.guardianConsent.version, "number", 'min="1" step="1"')}
        ${planInput("workflow.guardianDelivery.date", "保護者への交付日", plan.workflow.guardianDelivery.date, "date")}
        ${planInput("workflow.guardianDelivery.method", "保護者への交付方法", plan.workflow.guardianDelivery.method)}
        ${planInput("workflow.consultationDelivery.date", "相談支援事業者への交付日", plan.workflow.consultationDelivery.date, "date", plan.workflow.consultationDelivery.notApplicable ? "disabled" : "")}
        ${planInput("workflow.consultationDelivery.method", "相談支援事業者への交付方法", plan.workflow.consultationDelivery.method, "text", plan.workflow.consultationDelivery.notApplicable ? "disabled" : "")}
        ${planInput("workflow.consultationDelivery.reason", "該当なしの理由（該当なしの場合は必須）", plan.workflow.consultationDelivery.reason)}
      </div>
      <label class="domain-toggle" style="--toggle-color:#4f8588;margin-top:12px;display:inline-block">
        <input type="checkbox" data-plan-boolean="workflow.consultationDelivery.notApplicable" ${plan.workflow.consultationDelivery.notApplicable ? "checked" : ""} />
        <span>指定障害児相談支援事業者への交付は該当なし（理由は別記録）</span>
     </label>
   </section>`;
  refreshWritingTools(editor);
}

function renderAudit() {
  const audit = validatePlan(state.plan, getAnalysisJournals());
  $("#audit-score").textContent = String(audit.score);
  $("#audit-ring").style.setProperty("--score", `${audit.score * 3.6}deg`);
  $("#plan-checklist").innerHTML = audit.checks
    .map((check) => `
      <div class="check-item is-${check.status}">
        <span class="check-icon">${check.status === "pass" ? "✓" : check.status === "warning" ? "!" : "×"}</span>
        <div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div>
      </div>`)
    .join("");
}

function documentRow(label, value, colspan = 1) {
  return `<tr><th>${escapeHtml(label)}</th><td colspan="${colspan}">${escapeHtml(value || "未記入")}</td></tr>`;
}

function compactPlanText(value, limit = 76) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "未記入";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function renderPlanSummary() {
  const plan = state.plan;
  const sourceJournals = getAnalysisJournals();
  const sourceFresh = isPlanSourceFresh(plan, sourceJournals);
  const audit = validatePlan(plan, sourceJournals);
  const visibleItems = plan.supportItems.slice(0, 5);
  const hiddenItemCount = Math.max(0, plan.supportItems.length - visibleItems.length);
  const supportRows = visibleItems
    .map((item) => {
      const domains = item.domains
        .map((domain) => DOMAIN_META[domain]?.short ?? domain)
        .filter(Boolean)
        .join("・");
      return `
        <tr>
          <td class="summary-priority">${escapeHtml(item.priority)}</td>
          <td><strong>${escapeHtml(compactPlanText(item.title, 42))}</strong><small>${escapeHtml(domains || "領域未設定")}</small></td>
          <td>${escapeHtml(compactPlanText(item.goal, 105))}</td>
          <td>${escapeHtml(compactPlanText(item.support, 112))}</td>
          <td>${escapeHtml(`${item.evidenceIds?.length ?? 0}件`)}</td>
        </tr>`;
    })
    .join("");
  const summaryCards = [
    ["家族支援", plan.familySupport.goal],
    ["移行支援", plan.transitionSupport.goal],
    ["地域連携", plan.communitySupport.notApplicable ? `該当なし（${plan.communitySupport.reason || "理由未記入"}）` : plan.communitySupport.goal]
  ]
    .map(([label, value]) => `<article><span>${escapeHtml(label)}</span><p>${escapeHtml(compactPlanText(value, 92))}</p></article>`)
    .join("");

  $("#plan-preview").innerHTML = `
    ${sourceFresh ? "" : `<div class="document-stale-banner" role="alert">根拠更新前・印刷不可｜対象期間または日誌が変更されています。日誌から計画案を再作成してください。</div>`}
    <header class="summary-document-header">
      <div>
        <p class="summary-kicker">INDIVIDUAL SUPPORT PLAN · ONE-PAGE OVERVIEW</p>
        <h2>個別支援計画書　概要</h2>
        <p>${escapeHtml(plan.service.type)}・${escapeHtml(plan.service.name)}｜日誌をもとにした見直し原案</p>
      </div>
      <div class="summary-document-meta">
        <span>対象児童</span><strong>${escapeHtml(plan.child.name)}</strong>
        <span>計画期間</span><strong>${escapeHtml(formatDateJP(plan.planStart))}〜${escapeHtml(formatDateJP(plan.planEnd))}</strong>
        <span>作成日・版</span><strong>${escapeHtml(formatDateJP(plan.createdDate))}｜第${escapeHtml(plan.version)}版</strong>
      </div>
    </header>

    <section class="summary-intentions">
      <article><span>本人が大切にしたいこと</span><p>${escapeHtml(compactPlanText(plan.personWish, 156))}</p></article>
      <article><span>ご家族の意向</span><p>${escapeHtml(compactPlanText(plan.familyWish, 156))}</p></article>
      <article class="summary-policy"><span>この期間の支援方針</span><p>${escapeHtml(compactPlanText(plan.comprehensivePolicy, 260))}</p></article>
    </section>

    <section class="summary-support-section">
      <div class="summary-section-heading">
        <div><p class="summary-kicker">SUPPORT PRIORITIES</p><h3>この期間に大切にする支援</h3></div>
        <p>${escapeHtml(plan.sourcePeriod)}の日誌 ${escapeHtml(plan.sourceCount)}件を確認</p>
      </div>
      <table class="summary-support-table">
        <thead><tr><th>優先</th><th>支援のテーマ</th><th>目指す姿</th><th>主な支援の工夫</th><th>根拠日誌</th></tr></thead>
        <tbody>${supportRows}</tbody>
      </table>
      ${hiddenItemCount ? `<p class="summary-more-items">このほかに本人支援 ${hiddenItemCount}件。詳細版に全項目を掲載しています。</p>` : ""}
    </section>

    <section class="summary-linked-support">
      <div><p class="summary-kicker">AROUND THE CHILD</p><h3>本人支援を支える連携</h3></div>
      <div class="summary-linked-cards">${summaryCards}</div>
    </section>

    <footer class="summary-document-footer">
      <p><strong>準備状況 ${escapeHtml(audit.score)}%</strong>　この1ページ版は説明用の概要です。本人・家族の意向、アセスメント、会議、説明・同意を踏まえ、詳細版で内容を確認・決定します。</p>
      <span>根拠となる日誌：${escapeHtml(plan.sourceCount)}件　｜　詳細版は複数ページ</span>
    </footer>`;
}

function renderPlanDetailPreview() {
  const plan = state.plan;
  const sourceJournals = getAnalysisJournals();
  const sourceFresh = isPlanSourceFresh(plan, sourceJournals);
  const audit = validatePlan(plan, sourceJournals);
  const supportRows = plan.supportItems
    .map((item) => {
      const visibleEvidence = (item.evidenceIds ?? [])
        .slice(0, 3)
        .map((id) => {
          const journal = sourceJournals.find((entry) => entry.id === id);
          return journal ? `${id}（${formatDateJP(journal.date, { withYear: false })}）` : "";
        })
        .filter(Boolean);
      const remaining = Math.max(0, (item.evidenceIds?.length ?? 0) - visibleEvidence.length);
      const evidenceLabel = visibleEvidence.length
        ? `${visibleEvidence.join("、")}${remaining ? `、ほか${remaining}件` : ""}`
        : "根拠未選択";
      return `
        <tr>
          <td>${escapeHtml(item.category)}</td>
          <td>${escapeHtml(item.goal)}</td>
          <td>${escapeHtml(item.support)}<br><strong>評価：</strong>${escapeHtml(item.evaluation)}<small class="document-evidence"><strong>根拠：</strong>${escapeHtml(evidenceLabel)}</small></td>
          <td><div class="document-domain-list">${item.domains.map((domain) => `<span>${escapeHtml(DOMAIN_META[domain]?.short ?? domain)}</span>`).join("")}</div></td>
          <td>${escapeHtml(formatDateJP(item.targetDate, { withYear: false }))}</td>
          <td>${escapeHtml(item.responsible)}</td>
          <td>${escapeHtml(item.notes)}</td>
          <td style="text-align:center">${escapeHtml(item.priority)}</td>
        </tr>`;
    })
    .join("");

  const otherRows = [
    ["家族支援", plan.familySupport],
    ["移行支援", plan.transitionSupport],
    ["地域支援・地域連携", plan.communitySupport]
  ]
    .map(([label, section]) => {
      const notApplicable = label === "地域支援・地域連携" && section.notApplicable;
      return `
        <tr>
          <td>${label}</td>
          <td>${escapeHtml(notApplicable ? `該当なし（${section.reason || "理由未記入"}）` : section.goal)}</td>
          <td colspan="2">${escapeHtml(notApplicable ? "この計画では地域支援・地域連携を設定しない。" : section.support)}${notApplicable ? "" : `<br><strong>評価：</strong>${escapeHtml(section.evaluation)}`}</td>
          <td>${escapeHtml(notApplicable ? "—" : formatDateJP(section.targetDate, { withYear: false }))}</td>
          <td>${escapeHtml(notApplicable ? "—" : section.responsible)}</td>
          <td colspan="2">${escapeHtml(notApplicable ? "該当なし理由を次回見直し時に再確認する。" : section.notes)}</td>
        </tr>`;
    })
    .join("");

  $("#plan-detail-preview").innerHTML = `
    ${sourceFresh ? "" : `<div class="document-stale-banner" role="alert">根拠更新前・印刷不可｜対象期間または日誌が変更されています。日誌から計画案を再作成してください。</div>`}
    <header class="document-header">
      <div><h2>個別支援計画書</h2><p>${escapeHtml(plan.service.type)}・${escapeHtml(plan.service.name)}・次期計画見直し原案</p></div>
      <span class="draft-stamp">原案</span>
      <div class="document-meta"><span>作成日</span><strong>${escapeHtml(formatDateJP(plan.createdDate))}</strong><span>版 ${escapeHtml(plan.version)}</span></div>
    </header>
    <div class="print-page-identity" aria-hidden="true">
      <span>個別支援計画書（見直し原案）｜${escapeHtml(plan.service.name)}</span>
      <span>${escapeHtml(plan.child.name)}｜版 ${escapeHtml(plan.version)}｜<i class="print-page-number"></i></span>
    </div>

    <table class="document-table">
      <tr><th>利用児氏名</th><td>${escapeHtml(plan.child.name)}</td><th>生年月日・年齢</th><td>${escapeHtml(formatDateJP(plan.child.birthDate))}・${escapeHtml(plan.child.ageLabel)}・${escapeHtml(plan.child.grade)}</td><th>受給者証番号</th><td>${escapeHtml(plan.child.recipientNumber)}</td></tr>
      <tr><th>保護者氏名</th><td>${escapeHtml(plan.child.guardianName)}</td><th>計画期間</th><td>${escapeHtml(formatDateJP(plan.planStart))}〜${escapeHtml(formatDateJP(plan.planEnd))}</td><th>次回見直し</th><td>${escapeHtml(formatDateJP(plan.reviewDate))}</td></tr>
      <tr><th>標準提供時間</th><td colspan="3">${escapeHtml(plan.service.standardSchedule)}（${escapeHtml(plan.service.usePattern)}）</td><th>作成責任者</th><td>${escapeHtml(plan.service.managerName)}</td></tr>
    </table>

    <table class="document-table">
      ${documentRow("本人の意向", plan.personWish)}
      ${documentRow("家族の意向", plan.familyWish)}
      ${documentRow("生活全般の課題", plan.qualityOfLifeNeeds)}
      ${documentRow("総合的な支援方針", plan.comprehensivePolicy)}
      ${documentRow("長期目標", plan.longTermGoal)}
      ${documentRow("短期目標", plan.shortTermGoal)}
    </table>

    <p class="document-section-label">支援目標及び具体的な支援内容</p>
    <table class="document-table support-table">
      <colgroup><col style="width:7%"><col style="width:17%"><col style="width:27%"><col style="width:10%"><col style="width:8%"><col style="width:12%"><col style="width:15%"><col style="width:4%"></colgroup>
      <thead>
        <tr class="document-continuation-identity"><th colspan="8"><span>個別支援計画書（見直し原案）</span><span>${escapeHtml(plan.child.name)}・版 ${escapeHtml(plan.version)}・${escapeHtml(plan.service.name)}</span></th></tr>
        <tr><th>項目</th><th>具体的な到達目標</th><th>支援内容・評価方法</th><th>5領域</th><th>達成時期</th><th>担当者・提供機関</th><th>留意事項</th><th>優先</th></tr>
      </thead>
      <tbody>${supportRows}${otherRows}</tbody>
    </table>

    <table class="document-table">
      ${documentRow("モニタリング", plan.monitoringPlan)}
      ${documentRow("根拠となる記録", `${plan.sourcePeriod}の日誌 ${plan.sourceCount}件。各支援目標から原記録へ遡れる形で作成。`)}
    </table>

    <div class="document-signatures">
      <div><span>本人への説明日・方法</span>${escapeHtml(plan.workflow.childExplanation.date ? formatDateJP(plan.workflow.childExplanation.date) : "未実施")} ${escapeHtml(plan.workflow.childExplanation.method)}</div>
      <div><span>保護者への説明・文書同意（原本別管理）</span>${escapeHtml(plan.workflow.guardianConsent.date ? formatDateJP(plan.workflow.guardianConsent.date) : "未実施")}</div>
      <div><span>保護者への交付</span>${escapeHtml(plan.workflow.guardianDelivery.date ? formatDateJP(plan.workflow.guardianDelivery.date) : "未実施")} ${escapeHtml(plan.workflow.guardianDelivery.method)}</div>
      <div><span>児童発達支援管理責任者</span>${escapeHtml(plan.service.managerName)}</div>
    </div>
    <p class="document-footer-note">準備状況 ${audit.score}%　｜　本書は日誌から作成した見直し原案です。面接・アセスメント、個別支援会議、本人・保護者への説明、文書同意、必要な交付を経て確定してください。署名済み同意書と交付記録の原本は別途管理します。参考様式は全国一律の必須様式ではなく、指定権者・事業所の運用確認が必要です。</p>`;
}

function applyPlanMode({ scrollToPreview = false } = {}) {
  const preview = state.planMode === "preview";
  $("#plan-editor").hidden = preview;
  $("#plan-preview").hidden = !preview;
  $("#plan-preview-notice").hidden = !preview;
  $(".plan-layout").classList.toggle("is-preview", preview);
  $(".plan-audit").hidden = preview;
  $$("[data-plan-mode]").forEach((button) => {
    const active = button.dataset.planMode === state.planMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (preview && scrollToPreview) {
    window.setTimeout(() => $("#plan-preview-notice").scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
}

function renderPlan() {
  refreshPlanStale();
  const sourceJournals = getAnalysisJournals();
  const sourceSummary = sourceJournals.length
    ? `${formatDateJP(state.plan.sourceStartDate)}〜${formatDateJP(state.plan.sourceEndDate)}の${state.plan.sourceCount}件の日誌から、本人支援の候補と根拠日誌を表示しています。`
    : "対象となる日誌がないため、本人支援の候補は作成していません。";
 $("#plan-source-summary").textContent = sourceSummary;
  const consultationReference = state.plan.consultationPlanReference ?? state.consultationPlanDraft;
  $("#plan-origin-note").innerHTML = consultationReference
    ? `<strong>相談支援案を起点にしています</strong><span>${escapeHtml(consultationReference.agencyName)}の目標「${escapeHtml(consultationReference.overallGoal)}」を、事業所のアセスメントで確認し、日誌の根拠と合わせて計画書へ反映します。</span><button class="inline-link" type="button" data-view-target="consultation">相談支援案を見る →</button>`
    : "";
  renderPlanEditor();
  renderAudit();
  renderPlanSummary();
  renderPlanDetailPreview();
  applyPlanMode();
  const regenerate = $("#regenerate-plan");
  regenerate.textContent = state.planStale ? "● 日誌から再作成" : "日誌から再作成";
  regenerate.title = state.planStale ? "対象期間または日誌が変更されています。再作成するまで印刷できません。" : "現在の分析対象から計画案を作り直します";
  const printButton = $("#print-plan");
  printButton.disabled = state.planStale;
  printButton.title = state.planStale ? "根拠日誌の更新を反映するため、計画案を再作成してください" : "A4横1ページの概要を印刷またはPDF保存";
  const detailPrintButton = $("#print-plan-detail");
  detailPrintButton.disabled = state.planStale;
  detailPrintButton.title = state.planStale ? "根拠日誌の更新を反映するため、計画案を再作成してください" : "全項目を掲載した詳細版を印刷またはPDF保存";
}

function printPlan(mode) {
  if (refreshPlanStale()) {
    renderPlan();
    showToast("日誌または分析期間が変更されています。計画案を再作成するまで印刷できません。");
    return;
  }
  renderPlanSummary();
  renderPlanDetailPreview();
  document.body.classList.toggle("print-detail-plan", mode === "detail");
  window.print();
  document.body.classList.remove("print-detail-plan");
}

function createUniqueJournalId(date, currentId = "") {
  const base = `J-${date.replaceAll("-", "")}`;
  if (currentId) return currentId;
  const ids = new Set(state.journals.map((journal) => journal.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function openJournalDialog(journal = null) {
  const dialog = $("#journal-dialog");
  const form = $("#journal-form");
  form.reset();
  $("#journal-dialog-title").textContent = journal ? "日誌を編集" : "日誌を追加";
  $("#journal-id").value = journal?.id ?? "";
  $("#journal-date").value = journal?.date ?? toLocalIsoDate();
  $("#journal-activity").value = journal?.activity ?? "";
  $("#journal-mood").value = journal?.mood ?? "おだやか";
  $("#journal-physical").value = journal?.physical ?? "";
  $("#journal-observation").value = journal?.observation ?? "";
  $("#journal-support").value = journal?.support ?? "";
  $("#journal-response").value = journal?.response ?? "";
  $("#journal-family").value = journal?.familyNote ?? "";
  const [startTime = "15:30", endTime = "17:30"] = (journal?.time ?? "15:30〜17:30").split("〜");
  $("#journal-start-time").value = startTime;
  $("#journal-end-time").value = endTime;
  $("#journal-staff").value = journal?.staff ?? "デモ入力";
  $$("input[name='journalDomains']", form).forEach((input) => {
    input.checked = journal?.domains?.includes(input.value) ?? false;
  });
 Object.keys(INDICATOR_META).forEach((key) => {
   const input = form.elements[key];
   input.value = String(journal?.indicators?.[key] ?? "");
 });
  refreshWritingTools(form);
 dialog.showModal();
  window.setTimeout(() => $("#journal-date").focus(), 20);
}

function installJournalWritingTools() {
  [
    "#journal-observation",
    "#journal-support",
    "#journal-response",
    "#journal-family"
  ].forEach((selector) => {
    const textarea = $(selector);
    const field = textarea?.closest("label");
    if (!field || $("[data-writing-tools]", field)) return;
    field.classList.add("writing-field");
    textarea.insertAdjacentHTML("afterend", writingToolsMarkup());
  });
}

function handleJournalSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const requiredFields = ["activity", "observation", "support", "response", "staff"];
  const blankField = requiredFields.find((name) => !String(data.get(name) ?? "").trim());
  if (blankField) {
    showToast("必須項目に空白だけは保存できません。");
    form.elements[blankField]?.focus();
    return;
  }
  const startTime = String(data.get("startTime") ?? "");
  const endTime = String(data.get("endTime") ?? "");
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) {
    showToast("利用終了時刻は、利用開始時刻より後に設定してください。");
    $("#journal-end-time").focus();
    return;
  }
  const domains = $$("input[name='journalDomains']:checked", form).map((input) => input.value);
  if (!domains.length) {
    showToast("関連する5領域を1つ以上選んでください。");
    $("#journal-domain-options input").focus();
    return;
  }
  const currentId = String(data.get("id") || "");
  const indicators = Object.fromEntries(Object.keys(INDICATOR_META).map((key) => {
    const raw = String(data.get(key) ?? "");
    const value = Number(raw);
    return [key, raw === "" ? null : Number.isInteger(value) && value >= 1 && value <= 4 ? value : null];
  }));
  const journal = {
    id: createUniqueJournalId(String(data.get("date")), currentId),
    date: String(data.get("date")),
    attendance: "出席",
    time: `${startTime}〜${endTime}`,
    activity: String(data.get("activity")).trim(),
    mood: String(data.get("mood")),
    physical: String(data.get("physical") || "未記入").trim(),
    observation: String(data.get("observation")).trim(),
    support: String(data.get("support")).trim(),
    response: String(data.get("response")).trim(),
    familyNote: String(data.get("familyNote") || "").trim(),
    staff: String(data.get("staff")).trim(),
    domains,
    tags: inferJournalTags({
      observation: String(data.get("observation")),
      response: String(data.get("response")),
      domains
    }),
    indicators
  };
  const existingIndex = state.journals.findIndex((item) => item.id === currentId);
  if (existingIndex >= 0) state.journals.splice(existingIndex, 1, journal);
  else state.journals.push(journal);
  state.journals.sort((a, b) => a.date.localeCompare(b.date));
  state.selectedJournalId = journal.id;
  refreshPlanStale();
  $("#journal-dialog").close();
  saveState();
  renderSidebar();
  renderDashboard();
  renderJournals();
  showToast(existingIndex >= 0 ? "日誌を更新しました。計画案は必要に応じて再作成してください。" : "日誌を追加しました。計画案は必要に応じて再作成してください。");
}

function deleteJournal(id) {
  const journal = getJournalById(state.journals, id);
  if (!journal) return;
  if (!window.confirm(`${formatDateJP(journal.date)}「${journal.activity}」を削除しますか？\nこのブラウザ内の記録から削除され、元に戻せません。`)) return;
  state.journals = state.journals.filter((item) => item.id !== id);
  state.selectedJournalId = [...state.journals].sort((a, b) => b.date.localeCompare(a.date))[0]?.id ?? "";
  refreshPlanStale();
  saveState();
  renderSidebar();
  renderDashboard();
  renderJournals();
  showToast("日誌を削除しました。計画案の根拠を再確認してください。");
}

function exportJournalsCsv() {
  const headers = ["日付", "利用時間", "活動", "来所時", "健康・体調", "観察した事実", "行った支援", "本人の反応", "家庭との共有", "5領域", "記録者"];
  const rows = [...state.journals]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((journal) => [
      journal.date,
      journal.time,
      journal.activity,
      journal.mood,
      journal.physical,
      journal.observation,
      journal.support,
      journal.response,
      journal.familyNote,
      journal.domains.map((domain) => DOMAIN_META[domain]?.name ?? domain).join("／"),
      journal.staff
    ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(toCsvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `Aさん_日誌_${toLocalIsoDate()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${state.journals.length}件の日誌をCSV出力しました。`);
}

function updatePlanAfterInput(input) {
  if (input.matches("[data-plan-path]")) {
    setByPath(state.plan, input.dataset.planPath, input.value);
    if (["child.birthDate", "planStart"].includes(input.dataset.planPath)) {
      state.plan.child.ageLabel = calculateAgeLabel(state.plan.child.birthDate, state.plan.planStart);
    }
  } else if (input.matches("[data-support-domain]")) {
    const index = Number(input.dataset.supportDomain);
    const item = state.plan.supportItems[index];
    if (item) {
      const domains = new Set(item.domains);
      if (input.checked) domains.add(input.value);
      else domains.delete(input.value);
      item.domains = [...domains];
    }
  } else if (input.matches("[data-support-evidence]")) {
    const index = Number(input.dataset.supportEvidence);
    const item = state.plan.supportItems[index];
    if (item) {
      const evidenceIds = new Set(item.evidenceIds ?? []);
      if (input.checked) evidenceIds.add(input.value);
      else evidenceIds.delete(input.value);
      const validIds = new Set(state.journals.map((journal) => journal.id));
      item.evidenceIds = [...evidenceIds].filter((id) => validIds.has(id));
      const count = input.closest(".evidence-picker")?.querySelector("summary span");
      if (count) count.textContent = `${item.evidenceIds.length}件`;
    }
  } else if (input.matches("[data-plan-boolean]")) {
    setByPath(state.plan, input.dataset.planBoolean, input.checked);
    if (["workflow.consultationDelivery.notApplicable", "communitySupport.notApplicable"].includes(input.dataset.planBoolean)) {
      renderPlanEditor();
    }
  }
  state.plan.status = "draft";
  saveState();
  renderAudit();
  renderPlanSummary();
  renderPlanDetailPreview();
}

function getPatternById(patternId) {
  return analyzeJournals(getAnalysisJournals()).patterns.find((pattern) => pattern.id === patternId && pattern.isConfirmed) ?? null;
}

function getPatternDomains(pattern) {
  const evidenceIds = new Set(pattern.evidenceIds ?? []);
  return [...new Set(getAnalysisJournals()
    .filter((journal) => evidenceIds.has(journal.id))
    .flatMap((journal) => journal.domains ?? [])
    .filter((domain) => DOMAIN_META[domain]))];
}

function getPlanItemForPattern(pattern) {
  const supportId = PATTERN_SUPPORT_IDS[pattern.id] ?? `support-${pattern.id}`;
  return state.plan.supportItems.find((item) => item.id === supportId) ?? null;
}

function openPatternPlanDialog(patternId) {
  if (refreshPlanStale()) {
    state.planMode = "edit";
    navigate("plan");
    showToast("日誌または期間が変わっています。先に「日誌から再作成」をしてからヒントを反映してください。");
    return;
  }
  const pattern = getPatternById(patternId);
  if (!pattern) {
    showToast("このヒントは、もう一度日誌を確認してから計画書へ反映してください。");
    return;
  }
  const item = getPlanItemForPattern(pattern);
  const evidenceCount = pattern.evidenceIds?.length ?? 0;
  $("#pattern-plan-id").value = pattern.id;
  $("#pattern-source-summary-heading").textContent = pattern.title;
  $("#pattern-source-summary").textContent = pattern.summary;
  $("#pattern-source-evidence").textContent = `${evidenceCount}件の日誌を根拠として、計画書の「本人支援」にひも付けます。`;
  $("#pattern-plan-title").value = item?.title ?? pattern.title;
  $("#pattern-plan-goal").value = item?.goal ?? "";
  $("#pattern-plan-support").value = item?.support ?? "";
  $("#pattern-plan-dialog").showModal();
  window.setTimeout(() => $("#pattern-plan-title").focus(), 0);
}

function applyPatternPlan(event) {
  event.preventDefault();
  const pattern = getPatternById($("#pattern-plan-id").value);
  if (!pattern) {
    $("#pattern-plan-dialog").close();
    showToast("日誌の内容が変わったため、反映を中止しました。もう一度確認してください。");
    return;
  }
  const title = $("#pattern-plan-title").value.trim();
  if (!title) {
    $("#pattern-plan-title").focus();
    return;
  }
  const supportId = PATTERN_SUPPORT_IDS[pattern.id] ?? `support-${pattern.id}`;
  const evidenceIds = [...new Set(pattern.evidenceIds ?? [])];
  const currentItem = getPlanItemForPattern(pattern);
  let itemIndex = state.plan.supportItems.indexOf(currentItem);
  if (itemIndex < 0) {
    itemIndex = state.plan.supportItems.length;
    state.plan.supportItems.push({
      id: supportId,
      category: "本人支援",
      priority: itemIndex + 1,
      title,
      goal: "",
      support: "",
      evaluation: "",
      domains: getPatternDomains(pattern),
      targetDate: state.plan.planEnd,
      responsible: "児童発達支援管理責任者・支援チーム（要確認）",
      notes: "日誌の根拠を本人・家族の意向とあわせて確認する。",
      evidenceIds
    });
  }
  const item = state.plan.supportItems[itemIndex];
  item.title = title;
  item.goal = $("#pattern-plan-goal").value.trim();
  item.support = $("#pattern-plan-support").value.trim();
  item.domains = [...new Set([...(item.domains ?? []), ...getPatternDomains(pattern)])];
  item.evidenceIds = [...new Set([...(item.evidenceIds ?? []), ...evidenceIds])];
  state.plan.supportItems.forEach((support, index) => { support.priority = index + 1; });
  state.plan.status = "draft";
  state.planMode = "edit";
  saveState();
  $("#pattern-plan-dialog").close();
  navigate("plan");
  showToast(`「${title}」を計画書の本人支援に反映しました。根拠日誌と内容を続けて確認してください。`);
  window.setTimeout(() => $(`[data-support-card="${itemIndex}"] [data-plan-path$=".title"]`)?.focus(), 80);
}

function addSupportGoal() {
  const index = state.plan.supportItems.length;
  state.plan.supportItems.push({
    id: `support-custom-${Date.now()}`,
    category: "本人支援",
    priority: index + 1,
    title: "新しい支援目標",
    goal: "",
    support: "",
    evaluation: "",
    domains: [],
    targetDate: state.plan.planEnd,
    responsible: "児童指導員",
    notes: "",
    evidenceIds: []
  });
  saveState();
  renderPlanEditor();
  renderAudit();
  showToast("本人支援の目標を追加しました。根拠と評価方法を入力してください。");
  window.setTimeout(() => $(`[data-support-card="${index}"] input`)?.focus(), 20);
}

function removeSupportGoal(index) {
  const item = state.plan.supportItems[index];
  if (!item) return;
  if (!window.confirm(`「${item.title}」を計画案から削除しますか？`)) return;
  state.plan.supportItems.splice(index, 1);
  state.plan.supportItems.forEach((support, position) => { support.priority = position + 1; });
  saveState();
  renderPlan();
  showToast("支援目標を削除しました。5領域の網羅を再確認してください。");
}

function applyAnalysisRange() {
  const nextRange = {
    start: $("#analysis-range-start").value,
    end: $("#analysis-range-end").value
  };
  const days = rangeDays(nextRange);
  if (!Number.isFinite(days) || days < 1 || days > MAX_ANALYSIS_DAYS) {
    showToast(`分析期間は開始日から終了日まで${MAX_ANALYSIS_DAYS}日以内で設定してください。`);
    $("#analysis-range-start").focus();
    return;
  }
  state.analysisRange = nextRange;
  refreshPlanStale();
  state.monitoringDraft = createMonitoringDraft(state.profile, getAnalysisJournals());
  state.assessmentDraft = createAssessmentDraft(state.profile, state.monitoringDraft, state.consultationPlanDraft);
  saveState();
  renderAnalysis();
  renderAssessmentDraft();
  renderPlan();
  showToast(`${days}日間・${getAnalysisJournals().length}件の日誌からモニタリングとアセスメントの下書きを更新しました。計画案は再作成してください。`);
}

function regeneratePlan() {
  const message = state.planStale
    ? "現在の日誌から計画案を再作成します。これまでの計画案への手編集は上書きされます。続けますか？"
    : "計画案を現在の日誌から作り直します。手編集した内容は上書きされます。続けますか？";
  if (!window.confirm(message)) return;
  const sourceJournals = getAnalysisJournals();
  state.plan = {
    ...generatePlan(state.profile, sourceJournals),
    consultationPlanReference: {
      agencyName: state.consultationPlanDraft.agencyName,
      preparedDate: state.consultationPlanDraft.preparedDate,
      overallGoal: state.consultationPlanDraft.overallGoal
    }
  };
  state.planStale = false;
  saveState();
  renderPlan();
  showToast(`${formatDateJP(state.analysisRange.start)}〜${formatDateJP(state.analysisRange.end)}の${sourceJournals.length}件から計画案を再作成しました。`);
}

function refreshMonitoringDraft() {
  if (!window.confirm("日誌からモニタリング下書きを作り直します。手編集したモニタリングとアセスメントの内容は上書きされます。続けますか？")) return;
  const sourceJournals = getAnalysisJournals();
  state.monitoringDraft = createMonitoringDraft(state.profile, sourceJournals);
  state.assessmentDraft = createAssessmentDraft(state.profile, state.monitoringDraft, state.consultationPlanDraft);
  saveState();
  renderAnalysis();
  renderAssessmentDraft();
  showToast(`${sourceJournals.length}件の日誌からモニタリングとアセスメントの下書きを作り直しました。`);
}

function refreshAssessmentDraft() {
  if (!window.confirm("現在のモニタリング下書きからアセスメントを作り直します。手編集したアセスメントの内容は上書きされます。続けますか？")) return;
  state.assessmentDraft = createAssessmentDraft(state.profile, state.monitoringDraft, state.consultationPlanDraft);
  saveState();
  renderAssessmentDraft();
  showToast("モニタリング下書きからアセスメントを作り直しました。");
}

function updateDraftAfterInput(input) {
  const root = input.dataset.draftRoot;
  const path = input.dataset.draftPath;
  if (!root || !path || !state[root]) return;
  setByPath(state[root], path, input.value);
  saveState({ quiet: true });
}

function applyAssessmentToPlan() {
  const draft = state.assessmentDraft;
  state.plan.personWish = draft.personWish;
  state.plan.familyWish = draft.familyWish;
  state.plan.qualityOfLifeNeeds = draft.needs;
  state.plan.comprehensivePolicy = draft.supportDirection;
  state.plan.status = "draft";
  saveState();
  renderPlan();
  navigate("plan");
  showToast("アセスメントの下書きを計画書の基本項目へ反映しました。目標・支援内容・担当は続けて確認してください。");
}

function applyConsultationToAssessment() {
  const consultation = state.consultationPlanDraft;
  state.assessmentDraft = createAssessmentDraft(state.profile, state.monitoringDraft, consultation);
  state.plan.consultationPlanReference = {
    agencyName: consultation.agencyName,
    preparedDate: consultation.preparedDate,
    overallGoal: consultation.overallGoal
  };
  saveState();
  renderAssessmentDraft();
  renderPlan();
  navigate("assessment");
  showToast("サービス等利用計画案の内容を、事業所のアセスメント下書きへ反映しました。");
}

function applyContactBookEntry(entryId) {
  const entry = state.contactBookEntries.find((item) => item.id === entryId);
  if (!entry || entry.reflected) return;
  const prefix = state.assessmentDraft.needs.trim() ? "\n\n" : "";
  state.assessmentDraft.needs += `${prefix}【連絡帳からの要望】${entry.request}\n家庭での様子：${entry.familyMessage}\n事業所の対応案：${entry.serviceReply}`;
  state.assessmentDraft.planningNote += `\n\n連絡帳（${formatDateJP(entry.date)}）の要望を、次の個別支援計画の検討事項として確認する。`;
  entry.reflected = true;
  saveState();
  renderContactBook();
  renderAssessmentDraft();
  showToast("連絡帳の要望をアセスメントの検討事項へ反映しました。本人・家族と確認して計画へ進めてください。");
}

function openChildDialog() {
  const form = $("#child-form");
  form.reset();
  form.elements.serviceType.value = "放課後等デイサービス";
  $("#child-dialog").showModal();
  window.setTimeout(() => form.elements.displayName.focus(), 20);
}

function createRegisteredChildProfile(data) {
  const today = new Date();
  const planStart = toLocalIsoDate(today);
  const planEndDate = new Date(today.getFullYear(), today.getMonth() + 6, today.getDate() - 1);
  const displayName = String(data.get("displayName") ?? "").trim();
  const legalName = String(data.get("legalName") ?? "").trim() || displayName;
  return {
    id: `child-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    displayName,
    legalName,
    grade: String(data.get("grade") ?? "").trim(),
    ageLabel: "",
    birthDate: String(data.get("birthDate") ?? ""),
    recipientNumber: String(data.get("recipientNumber") ?? "").trim(),
    guardianName: String(data.get("guardianName") ?? "").trim(),
    serviceName: "みらいステップ（登録事業所）",
    serviceType: String(data.get("serviceType") ?? "").trim() || "放課後等デイサービス",
    managerName: "未入力",
    usePattern: String(data.get("usePattern") ?? "").trim(),
    standardSchedule: "未入力",
    planStart,
    planEnd: toLocalIsoDate(planEndDate),
    reviewDate: toLocalIsoDate(planEndDate),
    createdDate: planStart,
    assessmentDate: planStart,
    currentPlanContext: "新規登録後、本人・家族・相談支援事業所からの情報を確認して支援の方向性を整理します。",
    interests: [],
    strengths: [],
    personWish: String(data.get("personWish") ?? "").trim(),
    familyWish: String(data.get("familyWish") ?? "").trim(),
    caveat: "登録内容は下書きです。本人・家族・関係者との確認後に、必要な情報を整えてください。"
  };
}

function handleChildSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const profile = createRegisteredChildProfile(new FormData(form));
  const workspace = createChildWorkspace(profile, [], { isDemo: false });
  state.childWorkspaces[profile.id] = workspace;
  state = {
    ...state,
    ...workspace,
    activeChildId: profile.id,
    childWorkspaces: state.childWorkspaces
  };
  $("#child-dialog").close();
  saveState();
  renderAll();
  navigate("childProfile");
  showToast(`${profile.displayName}さんを登録しました。利用児情報から内容を続けて確認・編集できます。`);
}

function resetDemo() {
  if (!window.confirm("追加・編集した内容をすべて破棄し、4人分のデモを初期状態へ戻しますか？")) return;
  state = createInitialState();
  localStorage.removeItem(STORAGE_KEY);
  saveState({ quiet: true });
  renderAll();
  navigate("dashboard");
  showToast("デモを初期状態へ戻しました。");
}

function renderAll() {
  renderSidebar();
  renderDashboard();
  renderChildProfile();
  renderJournals();
  renderConsultationDraft();
  renderContactBook();
  renderAnalysis();
  renderAssessmentDraft();
  renderPlan();
}

function initializeStaticControls() {
 $("#journal-domain-options").innerHTML = renderDomainToggles("journalDomains");
  installJournalWritingTools();
  refreshWritingTools($("#journal-form"));

  $("#open-child-dialog").addEventListener("click", openChildDialog);
  $("#open-child-dialog-from-profile").addEventListener("click", openChildDialog);
  $("#child-form").addEventListener("submit", handleChildSubmit);
  $$('[data-close-child-dialog]').forEach((button) => button.addEventListener("click", () => $("#child-dialog").close()));
  $("#child-profile-fields").addEventListener("input", (event) => {
    if (event.target.matches("[data-profile-path]")) updateProfileAfterInput(event.target);
  });

  document.addEventListener("click", (event) => {
    const childButton = event.target.closest("[data-child-id]");
    if (childButton) {
      switchChild(childButton.dataset.childId);
      return;
    }

    const contactEntryButton = event.target.closest("[data-apply-contact-entry]");
    if (contactEntryButton) {
      applyContactBookEntry(contactEntryButton.dataset.applyContactEntry);
      return;
    }

    const viewButton = event.target.closest("[data-view-target]");
    if (viewButton) {
      navigate(viewButton.dataset.viewTarget);
      return;
    }

    const journalButton = event.target.closest("[data-journal-id]");
    if (journalButton) {
      const viewChanged = state.activeView !== "journals";
      state.selectedJournalId = journalButton.dataset.journalId;
      navigate("journals", { preserveScroll: true, focusHeading: viewChanged });
      renderJournalList();
      saveState({ quiet: true });
      if (!journalButton.classList.contains("journal-card")) $("#journal-detail").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const evidenceButton = event.target.closest("[data-evidence-journal-id]");
    if (evidenceButton) {
      state.selectedJournalId = evidenceButton.dataset.evidenceJournalId;
      state.filters = { search: "", domain: "all", month: "all" };
      navigate("journals");
      return;
    }

    const editButton = event.target.closest("[data-edit-journal]");
    if (editButton) {
      openJournalDialog(getJournalById(state.journals, editButton.dataset.editJournal));
      return;
    }

    const deleteButton = event.target.closest("[data-delete-journal]");
    if (deleteButton) {
      deleteJournal(deleteButton.dataset.deleteJournal);
      return;
    }

    if (event.target.closest("[data-clear-filters]")) {
      state.filters = { search: "", domain: "all", month: "all" };
      renderJournals();
      return;
    }

    const removeButton = event.target.closest("[data-remove-support]");
    if (removeButton) {
      removeSupportGoal(Number(removeButton.dataset.removeSupport));
      return;
    }

    const patternPlanButton = event.target.closest("[data-edit-pattern-plan]");
    if (patternPlanButton) {
      openPatternPlanDialog(patternPlanButton.dataset.editPatternPlan);
    }
 });

  document.addEventListener("click", (event) => {
    const formatButton = event.target.closest("[data-writing-format]");
    if (formatButton) formatWritingField(formatButton);
    const copyButton = event.target.closest("[data-writing-copy]");
    if (copyButton) void copyWritingField(copyButton);
  });
  document.addEventListener("change", (event) => {
    if (!event.target.matches("[data-writing-target]")) return;
    const field = event.target.closest(".writing-field");
    const customTarget = $("[data-writing-custom-target]", field);
    const isCustom = event.target.value === "custom";
    customTarget.hidden = !isCustom;
    customTarget.required = isCustom;
    updateWritingTools(field);
    if (isCustom) customTarget.focus();
  });
  document.addEventListener("input", (event) => {
    if (!event.target.matches("textarea, [data-writing-custom-target]")) return;
    const field = event.target.closest(".writing-field");
    if (field) updateWritingTools(field);
  });

 $("#journal-search").addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    renderJournalList();
  });
  $("#journal-domain-filter").addEventListener("change", (event) => {
    state.filters.domain = event.target.value;
    renderJournalList();
    saveState({ quiet: true });
  });
  $("#journal-month-filter").addEventListener("change", (event) => {
    state.filters.month = event.target.value;
    renderJournalList();
    saveState({ quiet: true });
  });
  $("#apply-analysis-range").addEventListener("click", applyAnalysisRange);
  $("#monitoring-draft-fields").addEventListener("input", (event) => {
    if (event.target.matches("[data-draft-root='monitoringDraft']")) updateDraftAfterInput(event.target);
  });
  $("#assessment-draft-fields").addEventListener("input", (event) => {
    if (event.target.matches("[data-draft-root='assessmentDraft']")) updateDraftAfterInput(event.target);
  });
  $("#consultation-draft-fields").addEventListener("input", (event) => {
    if (event.target.matches("[data-draft-root='consultationPlanDraft']")) updateDraftAfterInput(event.target);
  });
  $("#refresh-monitoring-draft").addEventListener("click", refreshMonitoringDraft);
  $("#refresh-assessment-draft").addEventListener("click", refreshAssessmentDraft);
  $("#apply-consultation-to-assessment").addEventListener("click", applyConsultationToAssessment);
  $("#apply-consultation-to-assessment-bottom").addEventListener("click", applyConsultationToAssessment);
  $("#apply-assessment-to-plan").addEventListener("click", applyAssessmentToPlan);
  $("#apply-assessment-to-plan-bottom").addEventListener("click", applyAssessmentToPlan);

  $("#add-journal").addEventListener("click", () => openJournalDialog());
  $("#export-journals").addEventListener("click", exportJournalsCsv);
  $("#journal-form").addEventListener("submit", handleJournalSubmit);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $("#journal-dialog").close()));
  $("#pattern-plan-form").addEventListener("submit", applyPatternPlan);
  $$('[data-close-pattern-plan]').forEach((button) => button.addEventListener("click", () => $("#pattern-plan-dialog").close()));

  $("#plan-editor").addEventListener("input", (event) => {
    if (event.target.matches("[data-plan-path]")) updatePlanAfterInput(event.target);
  });
  $("#plan-editor").addEventListener("change", (event) => {
    if (event.target.matches("[data-support-domain], [data-support-evidence], [data-plan-boolean]")) updatePlanAfterInput(event.target);
  });
  $("#plan-editor").addEventListener("click", (event) => {
    if (event.target.closest("#add-support-goal")) addSupportGoal();
  });

  $$("[data-plan-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.planMode = button.dataset.planMode;
      applyPlanMode({ scrollToPreview: state.planMode === "preview" });
      saveState({ quiet: true });
    });
  });
  $("#regenerate-plan").addEventListener("click", regeneratePlan);
  $("#print-plan").addEventListener("click", () => printPlan("summary"));
  $("#print-plan-detail").addEventListener("click", () => printPlan("detail"));
  $("#reset-demo").addEventListener("click", resetDemo);

  $("#open-guide").addEventListener("click", () => $("#guide-dialog").showModal());
  $$('[data-close-guide]').forEach((button) => button.addEventListener("click", () => $("#guide-dialog").close()));
}

initializeStaticControls();
renderAll();
navigate(state.activeView, { preserveScroll: true, focusHeading: false });
saveState({ quiet: true });

if (loadWarning) window.setTimeout(() => showToast(loadWarning), 250);

window.michiNote = {
  getState: () => structuredClone(state),
  reset: () => {
    state = createInitialState();
    renderAll();
    navigate("dashboard");
  }
};
