import { DEMO_JOURNALS, DEMO_PROFILE, DOMAIN_META, INDICATOR_META } from "./demo-data.js";
import { isValidIsoDate } from "./utils.js";

export const MAX_ANALYSIS_DAYS = 92;

const PATTERN_DEFINITIONS = [
  {
    id: "transition",
    minimumEvidence: 3,
    marker: "見",
    title: "見通し・切り替えに関する場面",
    tags: ["transition"]
  },
  {
    id: "expression",
    minimumEvidence: 3,
    marker: "伝",
    title: "援助要求に関する場面",
    tags: ["help_request"]
  },
  {
    id: "peers",
    minimumEvidence: 3,
    marker: "輪",
    title: "仲間とのやり取りに関する場面",
    tags: ["peer_interaction"]
  },
  {
    id: "regulation",
    minimumEvidence: 3,
    marker: "整",
    title: "自己調整に関する場面",
    tags: ["regulation"]
  }
];

function dateFromIso(value) {
  if (!isValidIsoDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function average(values) {
  const valid = values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 4);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function formatDateJP(value, options = {}) {
  const date = dateFromIso(value);
  if (!date) return "未設定";
  const { withYear = true, withWeekday = false } = options;
  const parts = [];
  if (withYear) parts.push(`${date.getFullYear()}年`);
  parts.push(`${date.getMonth() + 1}月${date.getDate()}日`);
  if (withWeekday) {
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    parts.push(`（${weekdays[date.getDay()]}）`);
  }
  return parts.join("");
}

export function calculateAgeLabel(birthDateValue, referenceDateValue) {
  const birthDate = dateFromIso(birthDateValue);
  const referenceDate = dateFromIso(referenceDateValue);
  if (!birthDate || !referenceDate || referenceDate < birthDate) return "";
  let age = referenceDate.getFullYear() - birthDate.getFullYear();
  const birthdayHasPassed =
    referenceDate.getMonth() > birthDate.getMonth() ||
    (referenceDate.getMonth() === birthDate.getMonth() && referenceDate.getDate() >= birthDate.getDate());
  if (!birthdayHasPassed) age -= 1;
  return `${age}歳`;
}

export function getPeriodLabel(journals) {
  const dates = journals
    .map((journal) => journal.date)
    .filter(isValidIsoDate)
    .sort();
  if (!dates.length) return "対象期間なし";
  const start = dateFromIso(dates[0]);
  const end = dateFromIso(dates.at(-1));
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}年${start.getMonth() + 1}月〜${end.getMonth() + 1}月`;
  }
  return `${start.getFullYear()}年${start.getMonth() + 1}月〜${end.getFullYear()}年${end.getMonth() + 1}月`;
}

function sanitizeJournals(journals) {
  if (!Array.isArray(journals)) return [];
  return journals
    .filter((journal) => journal && isValidIsoDate(journal.date))
    .map((journal) => ({
      ...journal,
      domains: Array.isArray(journal.domains) ? journal.domains.filter((domain) => DOMAIN_META[domain]) : [],
      tags: Array.isArray(journal.tags) ? journal.tags : [],
      indicators: journal.indicators ?? {}
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function canonicalJournal(journal) {
  return {
    id: journal.id ?? "",
    date: journal.date,
    attendance: journal.attendance ?? "",
    time: journal.time ?? "",
    activity: journal.activity ?? "",
    mood: journal.mood ?? "",
    physical: journal.physical ?? "",
    observation: journal.observation ?? "",
    support: journal.support ?? "",
    response: journal.response ?? "",
    familyNote: journal.familyNote ?? "",
    staff: journal.staff ?? "",
    domains: [...journal.domains].sort(),
    tags: [...journal.tags].sort(),
    indicators: Object.fromEntries(Object.keys(INDICATOR_META).sort().map((key) => [key, journal.indicators[key] ?? null]))
  };
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getJournalSourceSnapshot(journals) {
  const sorted = sanitizeJournals(journals);
  return {
    count: sorted.length,
    startDate: sorted[0]?.date ?? "",
    endDate: sorted.at(-1)?.date ?? "",
    journalIds: sorted.map((journal) => journal.id),
    fingerprint: `fnv1a-${fnv1a(JSON.stringify(sorted.map(canonicalJournal)))}`
  };
}

export function isPlanSourceFresh(plan, journals) {
  const snapshot = getJournalSourceSnapshot(journals);
  return Number(plan?.sourceCount) === snapshot.count &&
    plan?.sourceStartDate === snapshot.startDate &&
    plan?.sourceEndDate === snapshot.endDate &&
    plan?.sourceFingerprint === snapshot.fingerprint &&
    JSON.stringify(plan?.sourceJournalIds ?? []) === JSON.stringify(snapshot.journalIds);
}

export function inferJournalTags({ observation = "", response = "", domains = [] } = {}) {
  const text = `${observation} ${response}`;
  const tags = [];
  const rules = [
    ["help_request", /(手伝って|手伝いを求|助けて|助けを求|教えて|援助要求|質問した|尋ねた|聞きに行|聞いてください|聞いてもら|ください|お願い)/],
    ["visual_schedule", /(予定|手順|カード|見通し|タイマー|予告)/],
    ["transition", /(切り替|次の|終了|終わり|片付|変更)/],
    ["peer_interaction", /(友達|相手|順番|一緒|相談|集団)/],
    ["sensory", /(音|耳|におい|感覚|騒|防音)/],
    ["fatigue", /(疲れ|眠|睡眠|体調)/],
    ["regulation", /(休憩|落ち着|整え|静かな)/],
    ["daily_living", /(身支度|手洗|水分|鞄|着替|調理)/],
    ["choice", /(選|選択)/],
    ["self_expression", /(伝え|言った|話した|希望)/]
  ];
  for (const [tag, pattern] of rules) if (pattern.test(text)) tags.push(tag);
  if (domains.includes("motor")) tags.push("motor");
  return [...new Set(tags)];
}

export function selectRepresentativeEvidence(journals, tags, limit = 4) {
  const sorted = sanitizeJournals(journals);
  const matches = sorted.filter((journal) => tags.some((tag) => journal.tags.includes(tag)));
  if (matches.length <= limit) return matches.map((journal) => journal.id);

  const selectedIndexes = new Set([0, matches.length - 1]);
  if (limit >= 3) selectedIndexes.add(Math.floor((matches.length - 1) / 2));
  if (limit >= 4) selectedIndexes.add(Math.floor(((matches.length - 1) * 3) / 4));
  if (limit >= 5) selectedIndexes.add(Math.floor((matches.length - 1) / 4));

  for (let index = 0; selectedIndexes.size < limit && index < matches.length; index += 1) {
    selectedIndexes.add(index);
  }

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map((index) => matches[index].id);
}

export function analyzeJournals(journals) {
  const sorted = sanitizeJournals(journals);
  const rangeDays = sorted.length ? differenceInDays(sorted[0].date, sorted.at(-1).date) + 1 : 0;
  const rangeWithinLimit = rangeDays > 0 && rangeDays <= MAX_ANALYSIS_DAYS;
  const midpoint = Math.ceil(sorted.length / 2);
  const firstHalf = sorted.slice(0, midpoint);
  const secondHalf = sorted.slice(midpoint);
  const domainCounts = Object.fromEntries(Object.keys(DOMAIN_META).map((domain) => [domain, 0]));
  const moodCounts = {};

  for (const journal of sorted) {
    for (const domain of new Set(journal.domains)) {
      domainCounts[domain] += 1;
    }
    const mood = journal.mood || "未記入";
    moodCounts[mood] = (moodCounts[mood] ?? 0) + 1;
  }

  const indicators = Object.fromEntries(
    Object.entries(INDICATOR_META).map(([key, meta]) => {
      const firstValues = firstHalf.map((journal) => journal.indicators[key]);
      const secondValues = secondHalf.map((journal) => journal.indicators[key]);
      const first = average(firstValues);
      const second = average(secondValues);
      return [
        key,
        {
          ...meta,
          first: round(first),
          second: round(second),
          delta: Number.isFinite(first) && Number.isFinite(second) ? round(second - first) : null,
          firstCount: firstValues.filter((value) => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 4).length,
          secondCount: secondValues.filter((value) => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 4).length
        }
      ];
    })
  );

  const patterns = PATTERN_DEFINITIONS.map((pattern) => {
    const matches = sorted.filter((journal) => pattern.tags.some((tag) => journal.tags.includes(tag)));
    const count = matches.length;
    const contextCount = new Set(matches.map((journal) => journal.activity).filter(Boolean)).size;
    const spanDays = matches.length >= 2 ? differenceInDays(matches[0].date, matches.at(-1).date) : 0;
    const isConfirmed = rangeWithinLimit && count >= pattern.minimumEvidence && contextCount >= 2 && spanDays >= 14;
    return {
      ...pattern,
      count,
      contextCount,
      spanDays,
      isConfirmed,
      summary: !rangeWithinLimit && sorted.length
        ? `分析対象が${rangeDays}日間に及ぶため、傾向は確定しません。92日以内の対象期間を選択してください。`
        : isConfirmed
          ? `中核タグに関連する記録が${count}件・${contextCount}場面・${spanDays}日間にあります。これは傾向の候補であり、支援が有効だった条件や変化の方向は原記録と面接で確認します。`
          : `該当記録は${count}件・${contextCount}場面・${spanDays}日間です。現時点では傾向として扱わず、3件以上・2場面以上・14日間以上の追加観察で確認します。`,
      evidenceIds: selectRepresentativeEvidence(sorted, pattern.tags, 4)
    };
  });

  const domains = Object.entries(DOMAIN_META).map(([id, meta]) => ({
    ...meta,
    count: domainCounts[id],
    percent: sorted.length ? Math.round((domainCounts[id] / sorted.length) * 100) : 0,
    summary: `関連付けられた記録は${domainCounts[id]}件です。${meta.description}について、観察・支援・本人の反応の原文を比較し、共通する条件と例外を確認します。`
  }));

  const coveredDomains = Object.values(domainCounts).filter((count) => count > 0).length;
  const latest = sorted.at(-1) ?? null;

  return {
    count: sorted.length,
    period: getPeriodLabel(sorted),
    startDate: sorted[0]?.date ?? "",
    endDate: latest?.date ?? "",
    latest,
    domainCounts,
    domains,
    moodCounts,
    indicators,
    patterns,
    confirmedPatternCount: patterns.filter((pattern) => pattern.isConfirmed).length,
    isDraftReady: rangeWithinLimit && sorted.length >= 3 && patterns.some((pattern) => pattern.isConfirmed),
    range: {
      days: rangeDays,
      withinLimit: rangeWithinLimit,
      maximumDays: MAX_ANALYSIS_DAYS
    },
    coverage: {
      covered: coveredDomains,
      total: Object.keys(DOMAIN_META).length,
      percent: Math.round((coveredDomains / Object.keys(DOMAIN_META).length) * 100)
    },
    split: {
      firstCount: firstHalf.length,
      secondCount: secondHalf.length,
      firstStart: firstHalf[0]?.date ?? "",
      firstEnd: firstHalf.at(-1)?.date ?? "",
      secondStart: secondHalf[0]?.date ?? "",
      secondEnd: secondHalf.at(-1)?.date ?? ""
    }
  };
}

function addMonths(isoDate, months) {
  const date = dateFromIso(isoDate);
  if (!date) return "";
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function makeSupportItem({ id, priority, title, goal, support, evaluation, domains, targetDate, responsible, notes, evidenceIds }) {
  return {
    id,
    category: "本人支援",
    priority,
    title,
    goal,
    support,
    evaluation,
    domains,
    targetDate,
    responsible,
    notes,
    evidenceIds
  };
}

function isExactBundledDemo(profile, journals) {
  const profileMatches = Object.keys(DEMO_PROFILE).length === Object.keys(profile ?? {}).length &&
    Object.entries(DEMO_PROFILE).every(([key, value]) => JSON.stringify(profile?.[key]) === JSON.stringify(value));
  return profileMatches &&
    getJournalSourceSnapshot(journals).fingerprint === getJournalSourceSnapshot(DEMO_JOURNALS).fingerprint;
}

export function generatePlan(profile, journals) {
  const analysis = analyzeJournals(journals);
  const sourceSnapshot = getJournalSourceSnapshot(journals);
  const usesBundledDemoTemplate = isExactBundledDemo(profile, journals);
  const planStart = profile?.planStart || addMonths(analysis.endDate, 0) || "";
  const planEnd = profile?.planEnd || addMonths(planStart, 6);
  const threeMonthTarget = addMonths(planStart, 3);
  const sixMonthTarget = planEnd;

  const plan = {
    id: `PLAN-${profile?.id ?? "draft"}-${planStart || "undated"}`,
    version: 1,
    status: "draft",
    title: "個別支援計画書（見直し原案）",
    sourcePeriod: analysis.period,
    sourceCount: sourceSnapshot.count,
    sourceStartDate: sourceSnapshot.startDate,
    sourceEndDate: sourceSnapshot.endDate,
    sourceJournalIds: sourceSnapshot.journalIds,
    sourceFingerprint: sourceSnapshot.fingerprint,
    createdDate:
      isValidIsoDate(profile?.createdDate) && (!analysis.endDate || profile.createdDate >= analysis.endDate)
        ? profile.createdDate
        : analysis.endDate || "",
    planStart,
    planEnd,
    reviewDate: profile?.reviewDate || planEnd,
    child: {
      id: profile?.id ?? "",
      name: profile?.legalName ?? profile?.displayName ?? "",
      birthDate: profile?.birthDate ?? "",
      ageLabel: calculateAgeLabel(profile?.birthDate, planStart) || profile?.ageLabel || "",
      grade: profile?.grade ?? "",
      recipientNumber: profile?.recipientNumber ?? "",
      guardianName: profile?.guardianName ?? ""
    },
    service: {
      name: profile?.serviceName ?? "",
      type: profile?.serviceType ?? "放課後等デイサービス",
      managerName: profile?.managerName ?? "",
      usePattern: profile?.usePattern ?? "",
      standardSchedule: profile?.standardSchedule ?? ""
    },
    personWish: profile?.personWish ?? "",
    familyWish: profile?.familyWish ?? "",
    qualityOfLifeNeeds: "活動の見通しを自分で確認すること、困り事や体調を本人に合う方法で早めに伝えること、友達とのやり取りを安心して続けることを支える。",
    comprehensivePolicy: "Aさんの興味を活動の入口とし、予定や手順を見える形で確認できる環境を整える。困った時、疲れた時、音が気になる時に、言葉・カード・身振りから本人が使いやすい方法を選び、その意思が尊重される経験を積み重ねる。小集団では共通の目的や役割を設定し、友達との相談や意見の違いへの対応を支援する。支援量は体調や場面に合わせ、安定した部分から段階的に減らす。",
    longTermGoal: "Aさんが、活動の見通しを確認し、困り事や体調に応じて助け・休憩・活動方法を選んで伝えながら、生活動作、遊び、友達や地域との活動に自分のペースで参加できる。",
    shortTermGoal: "必要な場面で希望や援助を伝えること、予定や終了予告を確認して次の行動を始めること、小集団で相談や順番を含むやり取りを続けることを、場面ごとの記録で評価する。",
    supportItems: [
      makeSupportItem({
        id: "support-expression",
        priority: 1,
        title: "希望・援助要求を伝える",
        goal: "必要な場面の5回中4回を目安に、「手伝って」「休憩」「静かな場所」「もう一度」等を言葉・カード・身振りから選んで伝え、その後の進め方を選ぶ。",
        support: "本人と使用方法を決めたカードを常時使える場所へ置く。職員は待つ時間を取り、必要時のみ短い表現例を1回示す。伝達後は、再開・変更・終了から本人が選んだ内容を尊重する。",
        evaluation: "4週間ごとに、該当機会数、本人が選んだ伝達方法、必要だった促しの段階、伝達後の選択を記録して確認する。",
        domains: ["health", "cognition", "language"],
        targetDate: threeMonthTarget,
        responsible: "児童指導員・児童発達支援管理責任者",
        notes: "状況による支援量の差を前提とし、1回の成功だけで習得済みと判断しない。",
        evidenceIds: selectRepresentativeEvidence(journals, ["help_request"], 5)
      }),
      makeSupportItem({
        id: "support-transition",
        priority: 2,
        title: "見通しを持って切り替える",
        goal: "切り替え機会の5回中4回を目安に、視覚的な予定や終了予告を確認し、環境的な手掛かりまたは言葉掛け1回以内で、5分以内に次の行動を始める。",
        support: "写真・文字の予定、変更マーク、5分・2分前予告、終わりの1回を場面に応じて使う。本人が自分で確認する時間を確保し、促しは記録を見ながら段階的に減らす。",
        evaluation: "切り替えの機会、開始までの時間、使った手掛かり、促しの回数、疲労や予定変更などの条件を記録する。",
        domains: ["health", "cognition"],
        targetDate: sixMonthTarget,
        responsible: "児童指導員",
        notes: "疲労時や急な変更時は、課題量や選択肢を調整し、同じ基準を一律に求めない。",
        evidenceIds: selectRepresentativeEvidence(journals, ["transition"], 5)
      }),
      makeSupportItem({
        id: "support-peers",
        priority: 3,
        title: "仲間と相談して活動する",
        goal: "小集団活動の4回中3回を目安に、依頼・順番・相談・断られた後の応答のいずれかを含む2往復以上のやり取りを行う。意見の違いでは、言葉または休憩で調整する。",
        support: "本人の興味を共有しやすい活動、2〜3人の小集団、役割・順番カードを用意する。必要時に短い表現例を示し、本人同士で続いたら職員は距離を取る。参加しない選択も保障する。",
        evaluation: "活動人数、役割、やり取りの種類と往復数、意見の違いがあった時の調整方法を記録する。",
        domains: ["cognition", "language", "social"],
        targetDate: sixMonthTarget,
        responsible: "児童指導員",
        notes: "会話量だけで評価せず、本人が安心して参加方法を選べたかも確認する。",
        evidenceIds: selectRepresentativeEvidence(journals, ["peer_interaction"], 5)
      }),
      makeSupportItem({
        id: "support-regulation",
        priority: 4,
        title: "体調や感覚に合う参加方法を選ぶ",
        goal: "騒音、疲労、運動等の場面の4回中3回を目安に、自分の状態を伝え、休憩・音量調整・少人数・活動変更等から参加方法を選ぶ。",
        support: "活動前の短い体調確認、静かな場所、防音具、人数・距離・運動強度の選択肢を用意する。食事や感覚活動への参加を強制せず、本人が選んだ休憩・再開・終了を支える。",
        evaluation: "本人からの状態表現、選んだ調整方法、休憩時間、再開の有無と本人の反応を記録する。",
        domains: ["health", "motor", "cognition"],
        targetDate: threeMonthTarget,
        responsible: "児童指導員・専門職（配置時）",
        notes: "安全確保を優先し、体調不良が疑われる場合は家族と連携して対応する。",
        evidenceIds: selectRepresentativeEvidence(journals, ["regulation"], 5)
      })
    ],
    familySupport: {
      goal: "家族と事業所が、本人に役立った方法と家庭での様子を無理のない範囲で共有できる。",
      support: "月2回を目安に、観察事実・有効だった支援・本人の言葉を簡潔に共有する。家庭で同じ方法を使うかは家族と相談して決め、家庭での実施を義務にしない。",
      evaluation: "共有回数ではなく、家族の意向と本人への適合を面談時に確認する。",
      targetDate: sixMonthTarget,
      responsible: "児童発達支援管理責任者",
      notes: "家族意向は次回面談で確認・更新する。"
    },
    transitionSupport: {
      goal: "本人・家族が希望する場合、学校等でも共通して使える支援方法を2つ確認する。",
      support: "事前に本人・家族の同意を得て、予定変更の伝え方と援助・休憩方法を1枚に整理し、学校等と共有する。3か月時点で本人への適合を再確認する。",
      evaluation: "共有先、共有内容、本人・家族の意向、学校等から得た事実を記録し、方法を見直す。",
      targetDate: sixMonthTarget,
      responsible: "児童発達支援管理責任者・在籍校担当者",
      notes: "インクルージョンの観点から、本人が所属場面で参加しやすくなる具体策を検討する。"
    },
    communitySupport: {
      notApplicable: false,
      reason: "",
      goal: "関係機関が本人・家族を中心に、役割と必要最小限の情報を共有できる。",
      support: "相談支援事業所等の利用状況を確認し、必要時に1回以上の連携と役割確認を行う。連携先が未確認のまま自動共有しない。",
      evaluation: "連携の必要性、本人・家族の同意、共有先・内容・結果を記録する。",
      targetDate: sixMonthTarget,
      responsible: "児童発達支援管理責任者",
      notes: "法定交付先以外との共有は、目的と同意を個別に確認する。"
    },
    workflow: {
      assessmentInterview: { date: "", participants: "", note: "本人・保護者への面接と、日誌以外のアセスメントを記録してください。" },
      supportMeeting: { date: "", participants: "", note: "支援担当者等から意見を求め、修正内容を記録してください。" },
      childExplanation: { date: "", method: "", note: "本人に合う方法で説明し、意見・反応・理解状況を別記録に残してください。" },
      guardianConsent: { date: "", method: "書面", version: 1, note: "保護者へ説明し、対象版への文書同意を得てください。" },
      guardianDelivery: { date: "", method: "", note: "保護者への交付日と方法を記録してください。" },
      consultationDelivery: { date: "", method: "", notApplicable: false, reason: "", note: "指定障害児相談支援事業者への交付、または該当なしの理由を確認してください。" }
    },
    monitoringPlan: "支援日誌を各目標へ紐づけ、月1回のチーム確認と、3か月時点の中間確認を行う。遅くとも6か月後までに本人・保護者との面接を含むモニタリングを実施する。",
    generationNote: "日誌から生成した見直し原案。本人・家族との面接、個別支援会議、説明・文書同意・交付を経て確定する。"
  };

  const patternBySupportId = {
    "support-expression": "expression",
    "support-transition": "transition",
    "support-peers": "peers",
    "support-regulation": "regulation"
  };
  const confirmedPatterns = new Set(analysis.patterns.filter((pattern) => pattern.isConfirmed).map((pattern) => pattern.id));
  plan.supportItems = plan.supportItems
    .filter((item) => confirmedPatterns.has(patternBySupportId[item.id]))
    .map((item, index) => ({ ...item, priority: index + 1 }));

  if (!usesBundledDemoTemplate) {
    const patternsById = Object.fromEntries(analysis.patterns.map((pattern) => [pattern.id, pattern]));
    plan.supportItems = plan.supportItems.map((item, index) => {
      const pattern = patternsById[patternBySupportId[item.id]];
      return {
        ...item,
        priority: index + 1,
        title: pattern?.title ?? item.title,
        goal: `本人・家族との面接と原記録の確認を経て、「${pattern?.title ?? item.title}」の到達目標と本人に合う伝達・参加方法を共同で設定する。`,
        support: `中核タグに関連する${pattern?.count ?? 0}件の原記録を確認し、場面ごとの観察事実、行った支援、本人の反応と例外を整理する。支援方法と支援量は本人の意向を確認してから決める。`,
        evaluation: "該当機会、観察した行動、実施した支援、本人の反応を継続記録し、変化の方向と有効だった条件を面接・チーム会議で評価する。",
        responsible: "児童発達支援管理責任者・支援チーム（要確認）",
        notes: "日誌のタグ出現だけでは状態・因果・有効支援を確定できないため、数値基準と具体策は自動確定しない。"
      };
    });

    const focus = plan.supportItems.map((item) => `「${item.title}」`).join("、");
    plan.qualityOfLifeNeeds = focus
      ? `中核タグが複数日・複数場面で記録された${focus}について、本人の生活上の困り事や希望に該当するか、本人に合う方法と支援量を面接・アセスメントで確認する。`
      : "";
    plan.comprehensivePolicy = focus
      ? `${analysis.period}の日誌で中核タグの出現条件を満たした${focus}を原案の候補とする。原記録と例外場面を確認し、本人・家族の意向、日誌以外のアセスメント、個別支援会議を踏まえて方針を確定する。`
      : "";
    plan.longTermGoal = focus
      ? `本人が、${focus}に関する参加方法を自分で選び、必要な支援を受けながら安心して生活できる。`
      : "";
    plan.shortTermGoal = focus
      ? `${focus}の各場面で、本人の行動、支援量、有効だった条件を継続記録し、面接で到達目標を調整する。`
      : "";
    plan.generationNote = analysis.isDraftReady
      ? "中核タグの件数・場面数・期間だけで抽出した確認用原案。内容、変化、有効支援は原記録と面接で未確認。"
      : "複数日・複数場面の根拠が不足しているため、支援目標は生成していません。追加観察と面接が必要です。";
    for (const key of ["familySupport", "transitionSupport", "communitySupport"]) {
      plan[key] = {
        ...plan[key],
        goal: "",
        support: "",
        evaluation: "",
        responsible: "",
        notes: ""
      };
    }
    plan.monitoringPlan = "";
  }

  return plan;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function differenceInDays(startValue, endValue) {
  const start = dateFromIso(startValue);
  const end = dateFromIso(endValue);
  if (!start || !end) return Number.NaN;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function isCompleteSupportSection(section) {
  return hasText(section?.goal) &&
    hasText(section?.support) &&
    hasText(section?.evaluation) &&
    isValidIsoDate(section?.targetDate) &&
    hasText(section?.responsible);
}

function isOnOrBefore(firstDate, secondDate) {
  const days = differenceInDays(firstDate, secondDate);
  return Number.isFinite(days) && days >= 0;
}

export function validatePlan(plan, journals) {
  const validJournals = sanitizeJournals(journals);
  const currentSnapshot = getJournalSourceSnapshot(validJournals);
  const journalIds = new Set(validJournals.map((journal) => journal.id));
  const sourceDateCount = new Set(validJournals.map((journal) => journal.date)).size;
  const sourceContextCount = new Set(validJournals.map((journal) => journal.activity).filter(hasText)).size;
  const supportItems = Array.isArray(plan?.supportItems) ? plan.supportItems : [];
  const coveredDomains = new Set(supportItems.flatMap((item) => item.domains ?? []));
  const evidenceIds = supportItems.flatMap((item) => item.evidenceIds ?? []);
  const evidenceValid = supportItems.length > 0 && supportItems.every(
    (item) => Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0 && item.evidenceIds.every((id) => journalIds.has(id))
  );
  const planPeriodDays = differenceInDays(plan?.planStart, plan?.planEnd);
  const reviewDays = differenceInDays(plan?.planStart, plan?.reviewDate);
  const sixMonthLimit = addMonths(plan?.planStart, 6);
  const planPeriodWithinSixMonths =
    isValidIsoDate(plan?.planStart) && isValidIsoDate(plan?.planEnd) && isValidIsoDate(sixMonthLimit) &&
    isOnOrBefore(plan.planStart, plan.planEnd) && isOnOrBefore(plan.planEnd, sixMonthLimit);
  const sourceRangeDays = validJournals.length
    ? differenceInDays(currentSnapshot.startDate, currentSnapshot.endDate) + 1
    : 0;
  const sourceRangeValid = sourceRangeDays > 0 && sourceRangeDays <= MAX_ANALYSIS_DAYS &&
    isValidIsoDate(plan?.createdDate) && isOnOrBefore(currentSnapshot.endDate, plan.createdDate);
  const sourceFresh = isPlanSourceFresh(plan, validJournals);
  const communityNotApplicable = Boolean(plan?.communitySupport?.notApplicable) && hasText(plan?.communitySupport?.reason);
  const targetSections = [
    ...supportItems,
    plan?.familySupport,
    plan?.transitionSupport,
    ...(communityNotApplicable ? [] : [plan?.communitySupport])
  ].filter(Boolean);
  const targetDatesValid = targetSections.length > 0 && targetSections.every((item) => {
    return isValidIsoDate(item?.targetDate) && planPeriodWithinSixMonths &&
      isOnOrBefore(plan.planStart, item.targetDate) &&
      isOnOrBefore(item.targetDate, plan.planEnd) &&
      isOnOrBefore(item.targetDate, sixMonthLimit);
  });
  const completeSupportItems = supportItems.length > 0 && supportItems.every((item) => {
    return hasText(item.goal) &&
      hasText(item.support) &&
      hasText(item.evaluation) &&
      isValidIsoDate(item.targetDate) &&
      hasText(item.responsible) &&
      (item.domains?.length ?? 0) > 0 &&
      planPeriodWithinSixMonths &&
      isOnOrBefore(plan.planStart, item.targetDate) &&
      isOnOrBefore(item.targetDate, plan.planEnd) &&
      isOnOrBefore(item.targetDate, sixMonthLimit);
  });
  const familyComplete = isCompleteSupportSection(plan?.familySupport);
  const transitionComplete = isCompleteSupportSection(plan?.transitionSupport);
  const communityComplete = isCompleteSupportSection(plan?.communitySupport);
  const otherSupportComplete = familyComplete && transitionComplete && (communityComplete || communityNotApplicable);

  const managerName = plan?.service?.managerName;
  const managerIsNamed = hasText(managerName) && !/(確認前|未確認|未入力|未定|要確認)/.test(managerName);
  const planVersion = Number(plan?.version);
  const planVersionValid = Number.isInteger(planVersion) && planVersion > 0;
  const createdDateValid = isValidIsoDate(plan?.createdDate);
  const basicDocumentInfoComplete =
    hasText(plan?.service?.name) && hasText(plan?.service?.type) && managerIsNamed && createdDateValid &&
    planVersionValid && isValidIsoDate(plan?.planStart) && isOnOrBefore(plan.createdDate, plan.planStart);

  const workflow = plan?.workflow ?? {};
  const assessment = workflow.assessmentInterview ?? {};
  const meeting = workflow.supportMeeting ?? {};
  const childExplanation = workflow.childExplanation ?? {};
  const guardianConsent = workflow.guardianConsent ?? {};
  const guardianDelivery = workflow.guardianDelivery ?? {};
  const consultationDelivery = workflow.consultationDelivery ?? {};

  const assessmentComplete = isValidIsoDate(assessment.date) && hasText(assessment.participants);
  const assessmentOrderValid = assessmentComplete && createdDateValid && isOnOrBefore(assessment.date, plan.createdDate);
  const meetingComplete = isValidIsoDate(meeting.date) && hasText(meeting.participants);
  const meetingOrderValid = meetingComplete && assessmentOrderValid &&
    isOnOrBefore(assessment.date, meeting.date) && isOnOrBefore(meeting.date, plan.createdDate);
  const consentComplete =
    isValidIsoDate(childExplanation.date) && hasText(childExplanation.method) &&
    isValidIsoDate(guardianConsent.date) && hasText(guardianConsent.method);
  const consentVersion = Number(guardianConsent.version);
  const consentVersionMatches = planVersionValid && Number.isInteger(consentVersion) && consentVersion > 0 && consentVersion === planVersion;
  const consentOrderValid = consentComplete && meetingOrderValid && consentVersionMatches &&
    isOnOrBefore(plan.createdDate, childExplanation.date) && isOnOrBefore(plan.createdDate, guardianConsent.date) &&
    isOnOrBefore(meeting.date, childExplanation.date) && isOnOrBefore(meeting.date, guardianConsent.date) &&
    isOnOrBefore(childExplanation.date, plan.planStart) && isOnOrBefore(guardianConsent.date, plan.planStart);
  const consultationNotApplicable = Boolean(consultationDelivery.notApplicable) && hasText(consultationDelivery.reason);
  const guardianDeliveryComplete = isValidIsoDate(guardianDelivery.date) && hasText(guardianDelivery.method);
  const consultationDeliveryComplete = consultationNotApplicable ||
    (isValidIsoDate(consultationDelivery.date) && hasText(consultationDelivery.method));
  const deliveryComplete = guardianDeliveryComplete && consultationDeliveryComplete;
  const deliveryOrderValid = deliveryComplete && consentOrderValid &&
    isOnOrBefore(guardianConsent.date, guardianDelivery.date) && isOnOrBefore(guardianDelivery.date, plan.planStart) &&
    (consultationNotApplicable || (
      isOnOrBefore(guardianConsent.date, consultationDelivery.date) && isOnOrBefore(consultationDelivery.date, plan.planStart)
    ));

  const checks = [
    {
      id: "source",
      status: sourceDateCount >= 3 && sourceContextCount >= 2 ? "pass" : "error",
      label: "複数日の根拠記録",
      detail: sourceDateCount >= 3 && sourceContextCount >= 2
        ? `${journalIds.size}件・${sourceDateCount}日・${sourceContextCount}場面の日誌を使用`
        : "3日以上・2場面以上の記録が必要"
    },
    {
      id: "freshness",
      status: sourceFresh ? "pass" : "error",
      label: "根拠日誌のスナップショット",
      detail: sourceFresh
        ? `${currentSnapshot.count}件のID・内容・期間が生成時と一致`
        : "対象期間または日誌が生成後に変更されています。計画案を再作成してください"
    },
    {
      id: "sourceRange",
      status: sourceRangeValid ? "pass" : "error",
      label: "分析対象期間",
      detail: sourceRangeValid
        ? `${sourceRangeDays}日間（${formatDateJP(currentSnapshot.startDate)}〜${formatDateJP(currentSnapshot.endDate)}）・作成日以前`
        : `作成日以前の連続する${MAX_ANALYSIS_DAYS}日以内を選択`
    },
    {
      id: "wishes",
      status: hasText(plan?.personWish) && hasText(plan?.familyWish) ? "pass" : "error",
      label: "本人・家族の意向",
      detail: hasText(plan?.personWish) && hasText(plan?.familyWish) ? "両方を記載" : "面接で確認し、両方を記載"
    },
    {
      id: "childInfo",
      status:
        hasText(plan?.child?.name) && isValidIsoDate(plan?.child?.birthDate) &&
        hasText(plan?.child?.guardianName) && hasText(plan?.child?.grade)
          ? "pass"
          : "error",
      label: "利用児・保護者の基本情報",
      detail:
        hasText(plan?.child?.name) && isValidIsoDate(plan?.child?.birthDate) &&
        hasText(plan?.child?.guardianName) && hasText(plan?.child?.grade)
          ? "利用児氏名、生年月日、学年、保護者氏名を記載"
          : "利用児氏名、生年月日、学年、保護者氏名を補完"
    },
    {
      id: "needs",
      status: hasText(plan?.qualityOfLifeNeeds) ? "pass" : "error",
      label: "生活全般の解決すべき課題",
      detail: hasText(plan?.qualityOfLifeNeeds) ? "生活全体から支援ニーズを記載" : "面接・アセスメントを踏まえた生活課題を記載"
    },
    {
      id: "policy",
      status: hasText(plan?.comprehensivePolicy) && hasText(plan?.longTermGoal) && hasText(plan?.shortTermGoal) ? "pass" : "error",
      label: "方針・長期・短期目標",
      detail: hasText(plan?.comprehensivePolicy) && hasText(plan?.longTermGoal) && hasText(plan?.shortTermGoal)
        ? "支援方針と達成イメージを記載"
        : "支援方針、長期目標、短期目標を補完"
    },
    {
      id: "items",
      status: completeSupportItems ? "pass" : "error",
      label: "本人支援の具体性",
      detail: completeSupportItems ? `${supportItems.length}件に評価方法・担当・期限あり` : "目標、方法、評価、担当、期限を補完"
    },
    {
      id: "domains",
      status: coveredDomains.size === Object.keys(DOMAIN_META).length ? "pass" : "error",
      label: "本人支援の5領域",
      detail: coveredDomains.size === Object.keys(DOMAIN_META).length ? "本人支援全体で5領域を網羅" : `${coveredDomains.size}/5領域。5領域全体との関連を確認`
    },
    {
      id: "otherSupport",
      status: otherSupportComplete ? "pass" : "error",
      label: "家族・移行・地域支援",
      detail: otherSupportComplete
        ? `家族・移行支援を記載、地域支援は${communityNotApplicable ? "該当なし理由を記載" : "必要事項を記載"}`
        : "各区分の目標、支援内容、評価方法、期限、担当を記載（地域支援は該当なし理由でも可）"
    },
    {
      id: "review",
      status:
        planPeriodWithinSixMonths && Number.isFinite(reviewDays) && reviewDays >= 0 &&
        isValidIsoDate(plan?.reviewDate) && isOnOrBefore(plan.reviewDate, plan.planEnd) &&
        isOnOrBefore(plan.reviewDate, sixMonthLimit)
          ? "pass"
          : "error",
      label: "計画期間と6か月以内の見直し",
      detail:
        Number.isFinite(planPeriodDays) && Number.isFinite(reviewDays)
          ? `計画${planPeriodDays}日間・${reviewDays}日後に見直し予定`
          : "開始日・終了日・見直し日を設定"
    },
    {
      id: "targetDates",
      status: targetDatesValid ? "pass" : "error",
      label: "各支援目標の達成時期",
      detail: targetDatesValid
        ? "本人・家族・移行・地域支援の期限が計画期間内"
        : "全目標の期限を開始後6か月以内かつ計画終了日までに設定"
    },
    {
      id: "evidence",
      status: evidenceValid ? "pass" : "error",
      label: "根拠日誌との紐づけ",
      detail: evidenceIds.length > 0 ? `${new Set(evidenceIds).size}件の原記録へ遡れます` : "各支援目標へ根拠を追加"
    },
    {
      id: "schedule",
      status: hasText(plan?.service?.usePattern) && hasText(plan?.service?.standardSchedule) ? "pass" : "error",
      label: "利用頻度・標準的な支援提供時間",
      detail: hasText(plan?.service?.usePattern) && hasText(plan?.service?.standardSchedule)
        ? "利用頻度と標準的な時間帯を記載"
        : "利用頻度と標準的な支援提供時間を補完"
    },
    {
      id: "monitoring",
      status: hasText(plan?.monitoringPlan) ? "pass" : "error",
      label: "モニタリング方法",
      detail: hasText(plan?.monitoringPlan)
        ? "実施方法と見直し時期を記載"
        : "モニタリングの方法・頻度・時期を記載"
    },
    {
      id: "manager",
      status: basicDocumentInfoComplete ? "pass" : "warning",
      label: "作成情報・児童発達支援管理責任者",
      detail: basicDocumentInfoComplete
        ? `${plan.service.name}・${managerName}・版${plan.version}として作成`
        : "事業所名、サービス種別、正の版番号、実名の作成責任者、作成日（計画開始日以前）を確認"
    },
    {
      id: "assessment",
      status: assessmentOrderValid ? "pass" : "warning",
      label: "面接・アセスメント",
      detail: assessmentOrderValid
        ? `${formatDateJP(assessment.date)}の面接・参加者を記録`
        : "本人・保護者面接の日付・参加者を記録し、作成日以前であることを確認"
    },
    {
      id: "meeting",
      status: meetingOrderValid ? "pass" : "warning",
      label: "個別支援会議",
      detail: meetingOrderValid
        ? `${formatDateJP(meeting.date)}の会議・参加者を記録（面接後、作成日以前）`
        : "会議日・参加者を記録し、面接後かつ作成日以前であることを確認"
    },
    {
      id: "consent",
      status: consentOrderValid ? "pass" : "warning",
      label: "本人への説明・保護者の文書同意",
      detail: consentOrderValid
        ? `会議・作成後に本人説明と保護者の文書同意を記録（対象版 ${plan.version}）`
        : "会議・作成後から計画開始日までに本人説明と対象版への保護者文書同意を記録"
    },
    {
      id: "delivery",
      status: deliveryOrderValid ? "pass" : "warning",
      label: "計画書の交付",
      detail: deliveryOrderValid
        ? `文書同意後に保護者へ交付、相談支援事業者は${consultationNotApplicable ? "該当なし理由を記録" : "交付を記録"}`
        : "文書同意後から計画開始日までに保護者へ交付し、相談支援事業者への交付または該当なし理由を記録"
    }
  ];

  const evidenceCheck = checks.find((check) => check.id === "evidence");
  evidenceCheck.detail = evidenceValid
    ? `${new Set(evidenceIds).size}件の原記録を確認できます`
    : "各支援目標へ有効な根拠日誌を1件以上追加";

  const passCount = checks.filter((check) => check.status === "pass").length;
  return {
    score: Math.round((passCount / checks.length) * 100),
    passCount,
    total: checks.length,
    hasErrors: checks.some((check) => check.status === "error"),
    hasWarnings: checks.some((check) => check.status === "warning"),
    checks
  };
}

export function getJournalById(journals, id) {
  return sanitizeJournals(journals).find((journal) => journal.id === id) ?? null;
}
