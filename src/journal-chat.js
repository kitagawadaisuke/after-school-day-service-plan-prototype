const TOPICS = [
  {
    id: "peers",
    matches: ["友達", "友だち", "ともだち", "仲間", "人間関係", "社会性", "集団", "やりとり"],
    tags: ["peer_interaction", "turn_taking"],
    domains: ["social"],
    title: "友だちとの関わり"
  },
  {
    id: "transition",
    matches: ["切り替え", "切替", "見通し", "予定", "準備", "次の活動"],
    tags: ["transition", "visual_schedule"],
    domains: ["cognition"],
    title: "見通しと活動の切り替え"
  },
  {
    id: "expression",
    matches: ["伝え", "援助", "助け", "困", "気持ち", "表現", "話"],
    tags: ["help_request", "self_expression"],
    domains: ["language"],
    title: "気持ち・希望の伝え方"
  },
  {
    id: "regulation",
    matches: ["落ち着", "休憩", "音", "疲れ", "感覚", "気持ちを整"],
    tags: ["regulation", "sensory", "fatigue"],
    domains: ["health", "motor"],
    title: "気持ちと環境の整え方"
  }
];

function cleanText(value, limit = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function pickTopic(question) {
  const normalized = cleanText(question).toLowerCase();
  return TOPICS.find((topic) => topic.matches.some((word) => normalized.includes(word.toLowerCase()))) ?? null;
}

function matchingJournals(journals, topic) {
  const sorted = [...journals].filter((journal) => journal?.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!topic) return sorted.slice(-3).reverse();
  const direct = sorted.filter((journal) =>
    (journal.tags ?? []).some((tag) => topic.tags.includes(tag)) ||
    (journal.domains ?? []).some((domain) => topic.domains.includes(domain))
  );
  return direct.slice(-4).reverse();
}

function periodLabel(journals) {
  const dates = journals.map((journal) => journal.date).filter(Boolean).sort();
  if (!dates.length) return "対象期間の日誌";
  const toLabel = (date) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  return dates.length === 1 ? toLabel(dates[0]) : `${toLabel(dates[0])}〜${toLabel(dates.at(-1))}`;
}

function buildAnswer(topic, evidence) {
  if (!evidence.length) {
    return "この質問に直接結びつく日誌は見つかりませんでした。言葉を変えるか、日誌を追加してから確認してください。";
  }
  if (!topic) {
    return `直近${evidence.length}件（${periodLabel(evidence)}）を確認しました。下の根拠日誌を開き、観察・支援・本人の反応を順に確かめてください。`;
  }
  const latest = evidence[0];
  return `「${topic.title}」に関する記録を${evidence.length}件確認しました。直近の${latest.date.slice(5).replace("-", "月")}日では、「${cleanText(latest.response, 72)}」という反応が残っています。傾向の判断は、下の元の日誌を確認したうえで職員が行ってください。`;
}

export function createJournalChatReply(question, journals) {
  const safeQuestion = cleanText(question, 240);
  if (!safeQuestion) return null;
  const topic = pickTopic(safeQuestion);
  const evidence = matchingJournals(Array.isArray(journals) ? journals : [], topic);
  return {
    question: safeQuestion,
    answer: buildAnswer(topic, evidence),
    topic: topic?.title ?? "直近の記録",
    evidence: evidence.map((journal) => ({
      id: journal.id,
      date: journal.date,
      activity: cleanText(journal.activity, 80),
      observation: cleanText(journal.observation, 140),
      support: cleanText(journal.support, 140),
      response: cleanText(journal.response, 160)
    }))
  };
}

export const JOURNAL_CHAT_SUGGESTIONS = [
  "友だちとの関わりはどう変化した？",
  "活動の切り替えで役立った支援は？",
  "困った時に気持ちを伝えられた場面は？",
  "疲れや音が気になる時の様子を教えて"
];
