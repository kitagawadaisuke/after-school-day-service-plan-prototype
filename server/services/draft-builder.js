const GENERATOR_VERSION = "rules-2026-08-14";
const MIN_LINKED_LOGS_FOR_REVIEW = 2;
const MAX_GOAL_EVIDENCE_EXCERPTS = 12;
const MAX_EVIDENCE_FIELD_CHARS = 240;
const MAX_ASSESSMENT_RECORD_EXCERPTS = 12;
const MAX_ASSESSMENT_FIELD_SENTENCES = 2;

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function firstText(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function documentReference(document) {
  if (!document) return null;
  return {
    id: document.id,
    documentKind: document.documentKind,
    versionNumber: Number(document.versionNumber),
    status: document.status,
    rowVersion: Number(document.rowVersion),
  };
}

function baseGeneration({ targetDocumentKind, generatedAt, sourceDocuments, period, counts }) {
  return {
    generated: true,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: dateTime(generatedAt),
    targetDocumentKind,
    humanReviewRequired: true,
    sourceDocuments: sourceDocuments.filter(Boolean).map(documentReference),
    evidencePeriod: period || null,
    evidenceCounts: counts,
    safeguards: {
      personAndFamilyIntentAutomaticallyDecided: false,
      professionalAssessmentAutomaticallyFinalized: false,
      approvalOrConsentAutomaticallyRecorded: false,
    },
  };
}

function consultationCandidates(document) {
  const payload = document?.payload || {};
  return {
    personWish: firstText(payload, ["personWish", "childWish", "childAndFamilyWishes"]),
    familyWish: firstText(payload, ["familyWish", "guardianWish", "childAndFamilyWishes"]),
    overallGoal: firstText(payload, ["overallGoal", "overallPolicy", "comprehensivePolicy"]),
    oneYearVision: firstText(payload, ["oneYearVision", "longTermVision"]),
    currentSituation: firstText(payload, ["currentSituation", "currentStatus"]),
    serviceNeed: firstText(payload, ["serviceNeed", "supportNeed", "needs"]),
    dayServiceRole: firstText(payload, ["dayServiceRole", "facilityRole"]),
    considerations: firstText(payload, ["considerations", "coordinationNotes"]),
  };
}

function monitoringCandidates(document, goalResults) {
  if (!document) return null;
  const payload = document.payload || {};
  const monitoring = payload.monitoring || payload;
  return {
    overallEvaluation: monitoring.overallEvaluation ?? null,
    personFeedback: monitoring.personFeedback ?? null,
    familyFeedback: monitoring.familyFeedback ?? null,
    nextPlanDirection: monitoring.nextPlanDirection ?? null,
    goalResults: goalResults.map((result) => ({
      monitoringResultId: result.id,
      goalId: result.goal?.id ?? null,
      goalTitle: result.goal?.title ?? null,
      progressStatus: result.progressStatus,
      progressSummary: result.progressSummary,
      currentChallenge: result.currentChallenge,
      nextSupportPolicy: result.nextSupportPolicy,
      nextGoalAction: result.nextGoalAction,
    })),
  };
}

function assessmentPlanDraftValues(assessment) {
  const payload = assessment?.payload || {};
  const sections = payload.assessment || {};
  const childWish = firstText(payload, ["childWishes"]) || firstText(sections, ["personWish"]);
  const familyWish = firstText(payload, ["familyWishes"]) || firstText(sections, ["familyWish"]);
  const wishes = [
    childWish ? `本人: ${childWish}` : "",
    familyWish ? `家族: ${familyWish}` : "",
  ].filter(Boolean).join("\n") || null;
  const overallAssessment = firstText(payload, ["overallAssessment"])
    || firstText(sections, ["overallAssessment", "supportDirection"]);
  const supportConsiderations = firstText(payload, ["supportConsiderations"])
    || firstText(sections, ["supportDirection"]);
  return {
    userAndFamilyWishes: wishes,
    overallSupportPolicy: overallAssessment,
    consultationPlanBasis: null,
    supportConsiderations,
    serviceDelivery: firstText(payload, ["planningNotes"]) || firstText(sections, ["planningNotes"]),
    coordination: firstText(payload, ["supportNetwork"]),
    monitoringPlan: null,
    explanationNotes: null,
  };
}

function monitoringResultText(results, fieldName) {
  return results
    .map((result) => {
      const value = result?.[fieldName];
      if (typeof value !== "string" || !value.trim()) return "";
      const title = typeof result.goal?.title === "string" && result.goal.title.trim()
        ? `${result.goal.title.trim()}: `
        : "";
      return `${title}${value.trim()}`;
    })
    .filter(Boolean)
    .join("\n") || null;
}

function monitoringAssessmentDraftValues(previousMonitoring, previousMonitoringGoalResults) {
  const monitoring = monitoringCandidates(previousMonitoring, previousMonitoringGoalResults);
  if (!monitoring) return {
    childWishes: null,
    familyWishes: null,
    concerns: null,
    overallAssessment: null,
    supportConsiderations: null,
    planningNotes: null,
  };
  return {
    childWishes: monitoring.personFeedback,
    familyWishes: monitoring.familyFeedback,
    concerns: monitoringResultText(previousMonitoringGoalResults, "currentChallenge"),
    overallAssessment: monitoring.overallEvaluation || monitoringResultText(previousMonitoringGoalResults, "progressSummary"),
    supportConsiderations: monitoringResultText(previousMonitoringGoalResults, "nextSupportPolicy"),
    planningNotes: monitoring.nextPlanDirection,
  };
}

const ASSESSMENT_RECORD_FIELD_RULES = Object.freeze([
  { field: "healthManagement", label: "生活・健康", terms: ["体調", "発熱", "疲", "眠", "食", "服薬", "通院", "けが", "痛", "水分", "休憩"] },
  { field: "movementSensory", label: "運動・感覚", terms: ["運動", "散歩", "公園", "ボール", "体操", "ダンス", "感覚", "音", "触", "工作", "制作", "はさみ"] },
  { field: "cognitionBehavior", label: "認知・行動", terms: ["予定", "見通し", "順番", "ルール", "切り替", "集中", "理解", "選択", "課題", "学習", "宿題", "パズル", "工作", "制作"] },
  { field: "languageCommunication", label: "言語・コミュニケーション", terms: ["話", "伝", "会話", "発言", "聞", "説明", "ことば", "言葉", "やりとり", "質問"] },
  { field: "relationshipsSocial", label: "人間関係・社会性", terms: ["友", "集団", "一緒", "協力", "順番", "他児", "相手", "関わ", "参加"] },
  { field: "familySituation", label: "家族・生活環境", terms: ["家庭", "家族", "保護者", "自宅", "学校", "送迎"] },
  { field: "medicalSafetyNotes", label: "医療・安全上の留意事項", terms: ["体調", "服薬", "通院", "アレルギー", "けが", "危険", "安全", "発熱"] },
  { field: "supportNetwork", label: "連携先と役割", terms: ["学校", "担任", "保護者", "家族", "相談", "連携", "送迎"] },
  { field: "dailyMeal", label: "食事", terms: ["食事", "昼食", "おやつ", "食べ", "飲み"] },
  { field: "dailyDressing", label: "衣類の着脱", terms: ["着替", "服", "衣類", "靴"] },
  { field: "dailyToileting", label: "排泄", terms: ["排泄", "トイレ"] },
  { field: "dailyBathing", label: "入浴", terms: ["入浴", "お風呂", "洗髪"] },
  { field: "dailySleep", label: "睡眠", terms: ["睡眠", "就寝", "眠", "起床"] },
  { field: "scheduleManagement", label: "スケジュール管理", terms: ["予定", "見通し", "スケジュール", "切り替", "時間"] },
  { field: "schoolClass", label: "在籍学級", terms: ["学校", "学級", "授業", "担任"] },
  { field: "learning", label: "学習面", terms: ["学習", "宿題", "読", "書", "計算", "プリント", "課題"] },
  { field: "socialUnderstanding", label: "状況理解", terms: ["状況", "ルール", "順番", "理解", "見通し"] },
  { field: "environmentAdaptation", label: "環境適応", terms: ["環境", "場所", "音", "慣", "不安", "切り替"] },
  { field: "friendRelationships", label: "友達との関わり", terms: ["友", "他児", "一緒", "関わ", "集団", "協力"] },
  { field: "publicBehavior", label: "公共の場での行動", terms: ["外出", "公共", "買い物", "公園", "地域", "交通"] },
  { field: "speaksIndependently", label: "自分から話す", terms: ["自分から", "話", "伝", "発言", "質問"] },
  { field: "listensToOthers", label: "相手の話を聞く", terms: ["聞", "相手", "説明", "話を"] },
  { field: "hobbies", label: "余暇", terms: ["遊び", "工作", "制作", "読書", "絵", "ゲーム", "音楽", "外出"] },
  { field: "lessons", label: "習い事", terms: ["習い事", "教室", "レッスン", "塾"] },
  { field: "favoriteFood", label: "好きな食べ物", terms: ["好きな食べ物", "好物"] },
  { field: "dislikedFood", label: "苦手な食べ物", terms: ["苦手な食べ物", "嫌いな食べ物"] },
  { field: "favoriteSnack", label: "好きなおやつ", terms: ["好きなおやつ", "おやつ"] },
  { field: "drinks", label: "飲み物", terms: ["飲み物", "水分", "飲ん"] },
  { field: "favoritePlay", label: "好きな遊び", terms: ["好きな遊び", "好んで", "楽し", "遊び"] },
  { field: "difficultPlay", label: "苦手な遊び", terms: ["苦手な遊び", "苦手", "嫌", "困"] },
  { field: "favoriteCharacter", label: "好きなキャラクター", terms: ["好きなキャラクター", "キャラクター"] },
  { field: "difficultCharacter", label: "苦手なキャラクター", terms: ["苦手なキャラクター"] },
  { field: "favoriteThings", label: "好きなこと", terms: ["好き", "楽し", "興味", "関心"] },
  { field: "sleepPattern", label: "睡眠の様子", terms: ["睡眠", "就寝", "眠", "起床"] },
  { field: "favoriteOutings", label: "好きな外出先", terms: ["好きな外出", "外出", "公園", "買い物"] },
  { field: "difficultOutings", label: "苦手な外出先", terms: ["苦手な外出"] },
  { field: "outingNotes", label: "外出時の留意事項", terms: ["外出", "交通", "公共", "買い物", "安全"] },
  { field: "outsideNotes", label: "その他の外出時の様子", terms: ["外出", "地域", "公園", "移動"] },
  { field: "otherServices", label: "他のサービス利用", terms: ["他サービス", "療育", "放課後等デイ", "相談支援"] },
  { field: "desiredServiceDays", label: "利用希望日", terms: ["利用日", "利用希望", "曜日", "送迎"] },
]);

function recordSearchText(record) {
  return [record.activity, record.observation, record.supportProvided, record.childResponse]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
}

function cleanAssessmentSourceText(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[【\[]\s*サンプル\s*[】\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function assessmentSentences(value) {
  const text = cleanAssessmentSourceText(value);
  if (!text) return [];
  return text.match(/[^。！？]+[。！？]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function matchingAssessmentSentences(record, rule) {
  const sources = [record.observation, record.childResponse, record.supportProvided, record.activity];
  return sources.flatMap(assessmentSentences)
    .filter((sentence) => rule.terms.some((term) => sentence.includes(term)));
}

function recordCandidateForField(records, rule) {
  const matches = records.filter((record) => {
    const text = recordSearchText(record);
    return rule.terms.some((term) => text.includes(term));
  });
  const sentences = [...new Set(matches.flatMap((record) => matchingAssessmentSentences(record, rule)))]
    .slice(-MAX_ASSESSMENT_FIELD_SENTENCES);
  if (!sentences.length) return null;
  return sentences.join(" ");
}

function assessmentRecordFieldCandidates(records) {
  return Object.fromEntries(
    ASSESSMENT_RECORD_FIELD_RULES.map((rule) => [rule.field, recordCandidateForField(records, rule)]),
  );
}

function assessmentSupportRecordDraftValues(supportRecords) {
  if (!supportRecords.length) {
    return {
      strengths: null,
      concerns: null,
      overallAssessment: null,
      supportConsiderations: null,
      planningNotes: null,
      priorityNeeds: null,
    };
  }
  const fieldCandidates = assessmentRecordFieldCandidates(supportRecords);
  const activities = [...new Set(supportRecords
    .map((record) => boundedEvidenceText(record.activity))
    .filter(Boolean))]
    .slice(0, 6);
  const observations = supportRecords
    .map((record) => boundedEvidenceText(record.observation || record.childResponse))
    .filter(Boolean)
    .slice(-3);
  const activityText = activities.length ? activities.join("、") : "日々の活動";
  const observationText = observations.join("／");
  return {
    ...fieldCandidates,
    strengths: `指定期間の支援記録では、${activityText}への参加の様子を確認しました。`,
    concerns: observationText || null,
    priorityNeeds: observationText
      ? `支援の記録にある「${observationText}」について、本人の負担や環境との関係を確認しながら優先して支援します。`
      : null,
    overallAssessment: `指定期間の支援記録${supportRecords.length}件を確認し、${activityText}での様子をアセスメントの候補として整理しました。`,
    supportConsiderations: observationText
      ? `記録にある「${observationText}」を踏まえ、本人の反応を確認しながら支援方法を調整します。`
      : "支援記録の内容をもとに、本人の反応を確認しながら支援方法を調整します。",
    planningNotes: "記録で確認した活動の様子を、本人・家族への聞き取りとあわせて支援計画に反映します。",
  };
}

function preferEnteredValue(currentValue, generatedValue) {
  if (typeof currentValue === "string" && currentValue.trim()) return currentValue;
  return currentValue ?? generatedValue;
}

function mergeAssessmentDraftValues(monitoringDraft, supportRecordDraft) {
  return {
    ...supportRecordDraft,
    childWishes: monitoringDraft.childWishes,
    familyWishes: monitoringDraft.familyWishes,
    strengths: supportRecordDraft.strengths,
    concerns: preferEnteredValue(monitoringDraft.concerns, supportRecordDraft.concerns),
    overallAssessment: preferEnteredValue(monitoringDraft.overallAssessment, supportRecordDraft.overallAssessment),
    supportConsiderations: preferEnteredValue(monitoringDraft.supportConsiderations, supportRecordDraft.supportConsiderations),
    planningNotes: preferEnteredValue(monitoringDraft.planningNotes, supportRecordDraft.planningNotes),
  };
}

export function buildBasicAssessmentDraft({
  child,
  guardians,
  consultationPlan,
  currentSchedule,
  previousMonitoring = null,
  previousMonitoringGoalResults = [],
  supportRecords = [],
  supportRecordPeriod = null,
  generatedAt = new Date(),
}) {
  const candidates = consultationCandidates(consultationPlan);
  const monitoringDraft = monitoringAssessmentDraftValues(previousMonitoring, previousMonitoringGoalResults);
  const supportRecordDraft = assessmentSupportRecordDraftValues(supportRecords);
  const assessmentDraft = mergeAssessmentDraftValues(monitoringDraft, supportRecordDraft);
  const evidencePeriod = supportRecordPeriod || {
    start: consultationPlan?.periodStart || currentSchedule?.validFrom || null,
    end: consultationPlan?.periodEnd || currentSchedule?.validTo || null,
  };
  return {
    templateVersion: "basic-assessment-v2",
    periodStart: evidencePeriod.start,
    periodEnd: evidencePeriod.end,
    payload: {
      generation: baseGeneration({
        targetDocumentKind: "basic_assessment",
        generatedAt,
        sourceDocuments: [consultationPlan, previousMonitoring],
        period: evidencePeriod,
        counts: {
          guardians: guardians.length,
          scheduleItems: currentSchedule?.items.length || 0,
          previousMonitoringResults: previousMonitoringGoalResults.length,
          supportRecords: supportRecords.length,
        },
      }),
      provenance: {
        child: { id: child.id, rowVersion: Number(child.rowVersion) },
        guardians: guardians.map((guardian) => ({
          id: guardian.id,
          rowVersion: Number(guardian.rowVersion),
          isPrimary: Boolean(guardian.isPrimary),
        })),
        currentSchedule: currentSchedule ? {
          id: currentSchedule.id,
          versionNumber: Number(currentSchedule.versionNumber),
          rowVersion: Number(currentSchedule.rowVersion),
          status: currentSchedule.status,
        } : null,
        previousMonitoring: documentReference(previousMonitoring),
        previousMonitoringResultIds: previousMonitoringGoalResults.map((result) => result.id),
        supportRecordIds: supportRecords.map((record) => record.id),
      },
      basicInformation: {
        managementCode: child.managementCode,
        displayName: child.displayName,
        legalName: child.legalName,
        birthDate: child.birthDate,
        grade: child.grade,
        gender: child.gender,
        disabilityCategory: child.disabilityCategory,
        guardianCandidates: guardians.map((guardian) => ({
          guardianId: guardian.id,
          legalName: guardian.legalName,
          relationship: guardian.relationship,
          isPrimary: Boolean(guardian.isPrimary),
        })),
      },
      consultationPlanCandidates: candidates,
      previousMonitoringCandidates: monitoringCandidates(
        previousMonitoring,
        previousMonitoringGoalResults,
      ),
      ...assessmentDraft,
      supportRecordEvidence: supportRecordPeriod ? {
        period: supportRecordPeriod,
        count: supportRecords.length,
        excerpts: supportRecords.slice(-MAX_ASSESSMENT_RECORD_EXCERPTS).map(evidenceExcerpt),
      } : null,
      currentScheduleFacts: currentSchedule ? {
        scheduleVersionId: currentSchedule.id,
        summary: currentSchedule.summary,
        validFrom: currentSchedule.validFrom,
        validTo: currentSchedule.validTo,
        items: currentSchedule.items.map((item) => ({
          id: item.id,
          dayOfWeek: Number(item.dayOfWeek),
          startMinute: Number(item.startMinute),
          endMinute: Number(item.endMinute),
          activity: item.activity,
          location: item.location,
          serviceKind: item.serviceKind,
        })),
      } : null,
      assessment: {
        personWish: assessmentDraft.childWishes,
        familyWish: assessmentDraft.familyWishes,
        strengths: assessmentDraft.strengths,
        needs: assessmentDraft.priorityNeeds || assessmentDraft.concerns,
        supportDirection: assessmentDraft.supportConsiderations,
        planningNotes: assessmentDraft.planningNotes,
      },
      confirmationRequired: [
        "本人の意向は、本人への聞き取りまたは意思決定支援を行って確認してください。",
        "家族の意向は、保護者への聞き取りを行って確認してください。",
        "現状・強み・課題・支援の方向性は、専門職がアセスメントして決定してください。",
      ],
    },
  };
}

function boundedEvidenceText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const characters = [...normalized];
  if (characters.length <= MAX_EVIDENCE_FIELD_CHARS) return normalized;
  return `${characters.slice(0, MAX_EVIDENCE_FIELD_CHARS - 1).join("")}…`;
}

function evidenceExcerpt(entry) {
  return {
    dailyLogId: entry.id,
    date: entry.occurredAt ? String(entry.occurredAt).slice(0, 10) : null,
    activity: boundedEvidenceText(entry.activity),
    observation: boundedEvidenceText(entry.observation),
    supportProvided: boundedEvidenceText(entry.supportProvided),
    childResponse: boundedEvidenceText(entry.childResponse),
  };
}

function goalCandidate(goal, sourceDocument, monitoringResult = null) {
  return {
    predecessorGoalId: goal.id,
    goalKind: goal.goalKind,
    title: goal.title,
    desiredOutcome: goal.desiredOutcome,
    supportDetails: goal.supportDetails,
    evaluationMethod: goal.evaluationMethod,
    responsibleParty: goal.responsibleParty,
    targetDate: goal.targetDate,
    fiveDomains: goal.fiveDomains,
    sortOrder: goal.sortOrder,
    provenance: {
      sourceDocumentId: sourceDocument.id,
      sourceGoalId: goal.id,
      monitoringResultId: monitoringResult?.id || null,
      previousAction: monitoringResult?.nextGoalAction || null,
    },
  };
}

export function buildIndividualSupportPlanDraft({
  consultationPlan,
  assessment,
  consultationGoals = [],
  previousMonitoring = null,
  previousMonitoringGoalResults = [],
  generatedAt = new Date(),
}) {
  const goals = [];
  const seenSourceGoals = new Set();

  for (const goal of consultationGoals || []) {
    goals.push(goalCandidate(goal, consultationPlan));
    seenSourceGoals.add(goal.id);
  }
  for (const result of previousMonitoringGoalResults) {
    if (!result.goal || result.nextGoalAction === "complete" || seenSourceGoals.has(result.goal.id)) continue;
    goals.push(goalCandidate(result.goal, previousMonitoring, result));
    seenSourceGoals.add(result.goal.id);
  }

  const assessmentPayload = assessment.payload || {};
  const assessmentSections = assessmentPayload.assessment || assessmentPayload;
  const planDraft = assessmentPlanDraftValues(assessment);
  return {
    templateVersion: "individual-support-plan-v1",
    periodStart: assessment.periodStart || consultationPlan?.periodStart || null,
    periodEnd: assessment.periodEnd || consultationPlan?.periodEnd || null,
    payload: {
      generation: baseGeneration({
        targetDocumentKind: "individual_support_plan",
        generatedAt,
        sourceDocuments: [consultationPlan, assessment, previousMonitoring],
        period: {
          start: assessment.periodStart || consultationPlan?.periodStart || null,
          end: assessment.periodEnd || consultationPlan?.periodEnd || null,
        },
        counts: {
          consultationGoals: consultationGoals.length,
          previousMonitoringResults: previousMonitoringGoalResults.length,
          generatedGoalCandidates: goals.length,
        },
      }),
      provenance: {
        goalSources: goals.map((goal) => goal.provenance),
      },
      consultationPlanCandidates: consultationCandidates(consultationPlan),
      assessmentCandidates: {
        personWish: assessmentSections.personWish ?? null,
        familyWish: assessmentSections.familyWish ?? null,
        strengths: assessmentSections.strengths ?? null,
        needs: assessmentSections.needs ?? null,
        supportDirection: assessmentSections.supportDirection ?? null,
        planningNotes: assessmentSections.planningNotes ?? null,
      },
      previousMonitoringCandidates: monitoringCandidates(
        previousMonitoring,
        previousMonitoringGoalResults,
      ),
      ...planDraft,
      plan: {
        personWish: planDraft.userAndFamilyWishes,
        familyWish: firstText(assessmentPayload, ["familyWishes"]) || assessmentSections.familyWish || null,
        comprehensiveSupportPolicy: planDraft.overallSupportPolicy,
        longTermGoalSummary: null,
        shortTermGoalSummary: null,
        monitoringMethod: planDraft.monitoringPlan,
      },
      confirmationRequired: [
        "本人・家族の意向と、具体的な目標・支援方法・担当者・評価方法を会議で確認してください。",
        "候補目標は元文書からの引継ぎ案です。採用・修正・削除は支援者が判断してください。",
        "説明、同意、承認、交付は別の正式工程で記録してください。",
      ],
    },
    goals,
  };
}

export function buildMonitoringRecordDraft({
  activePlan,
  goalsWithEvidence,
  dailyLogs,
  contactEntries,
  periodStart,
  periodEnd,
  generatedAt = new Date(),
}) {
  const dailyLogIds = dailyLogs.map((entry) => entry.id);
  const dailyLogById = new Map(dailyLogs.map((entry) => [entry.id, entry]));
  const results = goalsWithEvidence.map(({ goal, dailyLogIds: linkedIds }) => {
    const enoughEvidence = linkedIds.length >= MIN_LINKED_LOGS_FOR_REVIEW;
    const linkedLogs = linkedIds
      .map((id) => dailyLogById.get(id))
      .filter(Boolean);
    const excerpts = linkedLogs
      .slice(-MAX_GOAL_EVIDENCE_EXCERPTS)
      .map(evidenceExcerpt);
    const firstEvidenceDate = linkedLogs[0]?.occurredAt
      ? String(linkedLogs[0].occurredAt).slice(0, 10)
      : null;
    const lastEvidenceDate = linkedLogs.at(-1)?.occurredAt
      ? String(linkedLogs.at(-1).occurredAt).slice(0, 10)
      : null;
    const dateRange = firstEvidenceDate && lastEvidenceDate
      ? (firstEvidenceDate === lastEvidenceDate
          ? firstEvidenceDate
          : `${firstEvidenceDate}〜${lastEvidenceDate}`)
      : null;
    return {
      goalId: goal.id,
      progressStatus: enoughEvidence ? "needs_review" : "not_evaluated",
      progressSummary: enoughEvidence
        ? `この目標に紐づく日誌${linkedIds.length}件${dateRange ? `（${dateRange}）` : ""}から根拠記録を抽出しました。記録内容と本人・家族への聞き取りを確認し、専門職が進捗を評価してください。`
        : `この目標に紐づく日誌は${linkedIds.length}件です。根拠が十分でないため進捗は未評価です。本人・家族への聞き取りと追加記録を確認してください。`,
      currentChallenge: null,
      nextSupportPolicy: null,
      nextGoalAction: null,
      evidence: {
        dailyLogIds: excerpts.map((excerpt) => excerpt.dailyLogId),
        dailyLogCount: linkedIds.length,
        evidenceSufficientForHumanReview: enoughEvidence,
        excerpts,
        excerptsTruncated: linkedIds.length > excerpts.length,
        excerptSelection: "most_recent_chronological",
      },
    };
  });

  return {
    templateVersion: "monitoring-record-v2",
    periodStart,
    periodEnd,
    payload: {
      generation: baseGeneration({
        targetDocumentKind: "monitoring_record",
        generatedAt,
        sourceDocuments: [activePlan],
        period: { start: periodStart, end: periodEnd },
        counts: {
          activePlanGoals: goalsWithEvidence.length,
          dailyLogs: dailyLogIds.length,
          contactBookEntries: contactEntries.length,
          goalsWithoutEnoughEvidence: results.filter((result) => result.progressStatus === "not_evaluated").length,
        },
      }),
      provenance: {
        activeIndividualSupportPlan: documentReference(activePlan),
        dailyLogIds,
        contactBookEntryIds: contactEntries.map((entry) => entry.id),
        goalEvidence: Object.fromEntries(results.map((result) => [result.goalId, result.evidence])),
      },
      familyRequestCandidates: contactEntries
        .filter((entry) => entry.requestSummary)
        .map((entry) => ({
          contactBookEntryId: entry.id,
          entryDate: entry.entryDate,
          requestSummary: entry.requestSummary,
          reflectedInSupport: Boolean(entry.reflectedInSupport),
        })),
      monitoring: {
        overallEvaluation: null,
        personFeedback: null,
        familyFeedback: null,
        nextPlanDirection: null,
      },
      confirmationRequired: [
        "日誌件数は進捗そのものではありません。記録内容、本人・家族との面談、専門職の評価を合わせて判断してください。",
        "連絡帳の要望候補は、本人・家族の正式な意向として自動確定しません。",
        "次期目標の継続・修正・完了は、モニタリング会議で決定してください。",
      ],
    },
    results,
  };
}

export const DRAFT_BUILDER_LIMITS = Object.freeze({
  minimumLinkedLogsForReview: MIN_LINKED_LOGS_FOR_REVIEW,
  maximumGoalEvidenceExcerpts: MAX_GOAL_EVIDENCE_EXCERPTS,
  maximumEvidenceFieldCharacters: MAX_EVIDENCE_FIELD_CHARS,
  generatorVersion: GENERATOR_VERSION,
});
