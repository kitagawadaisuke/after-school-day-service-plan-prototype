import test from "node:test";
import assert from "node:assert/strict";

import { DEMO_JOURNALS, DEMO_PROFILE, DOMAIN_META } from "../src/demo-data.js";
import {
  MAX_ANALYSIS_DAYS,
  analyzeJournals,
  calculateAgeLabel,
  formatDateJP,
  generatePlan,
  getPeriodLabel,
  inferJournalTags,
  isPlanSourceFresh,
  selectRepresentativeEvidence,
  validatePlan
} from "../src/plan-engine.js";
import { toCsvCell, toLocalIsoDate } from "../src/utils.js";

test("Aさんの日誌は2か月・24件で、全件に観察→支援→反応がある", () => {
  assert.equal(DEMO_JOURNALS.length, 24);
  assert.equal(getPeriodLabel(DEMO_JOURNALS), "2026年4月〜5月");
  assert.ok(DEMO_JOURNALS.every((journal) => journal.observation.trim()));
  assert.ok(DEMO_JOURNALS.every((journal) => journal.support.trim()));
  assert.ok(DEMO_JOURNALS.every((journal) => journal.response.trim()));
  assert.ok(DEMO_JOURNALS.every((journal) => journal.domains.length >= 1));
  assert.ok(DEMO_JOURNALS.every((journal) => Object.values(journal.indicators).every((value) => value >= 1 && value <= 4)));
});

test("分析は5領域を網羅し、前半・後半を安全に比較できる", () => {
  const analysis = analyzeJournals(DEMO_JOURNALS);
  assert.equal(analysis.count, 24);
  assert.equal(analysis.coverage.covered, 5);
  assert.equal(analysis.coverage.percent, 100);
  assert.deepEqual(Object.keys(analysis.domainCounts).sort(), Object.keys(DOMAIN_META).sort());
  assert.ok(Object.values(analysis.domainCounts).every((count) => count > 0));
  assert.equal(analysis.split.firstCount, 12);
  assert.equal(analysis.split.secondCount, 12);
  assert.ok(Object.values(analysis.indicators).every((indicator) => Number.isFinite(indicator.delta)));
  assert.ok(Object.values(analysis.indicators).some((indicator) => indicator.delta > 0));
});

test("生成した計画案は5領域、評価方法、担当、期限、根拠日誌を持つ", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  const coveredDomains = new Set(plan.supportItems.flatMap((item) => item.domains));
  const journalIds = new Set(DEMO_JOURNALS.map((journal) => journal.id));

  assert.equal(plan.status, "draft");
  assert.equal(plan.supportItems.length, 4);
  assert.deepEqual([...coveredDomains].sort(), Object.keys(DOMAIN_META).sort());
  assert.ok(plan.supportItems.every((item) => item.goal && item.support && item.evaluation));
  assert.ok(plan.supportItems.every((item) => item.targetDate && item.responsible));
  assert.ok(plan.supportItems.every((item) => item.evidenceIds.length >= 3));
  assert.ok(plan.supportItems.flatMap((item) => item.evidenceIds).every((id) => journalIds.has(id)));
  assert.ok(plan.familySupport.support);
  assert.ok(plan.transitionSupport.support.includes("同意"));
  assert.ok(plan.communitySupport.support);
});

test("初期計画案は内容エラーなし、面接・会議・同意・交付を警告する", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  const audit = validatePlan(plan, DEMO_JOURNALS);

  assert.equal(audit.hasErrors, false);
  assert.equal(audit.hasWarnings, true);
  assert.equal(audit.score, 75);
  assert.deepEqual(
    audit.checks.filter((check) => check.status === "warning").map((check) => check.id),
    ["manager", "assessment", "meeting", "consent", "delivery"]
  );
});

test("空データや不正な日付でも例外を出さず、不足を明示する", () => {
  const analysis = analyzeJournals([{ id: "bad", date: "not-a-date" }]);
  assert.equal(analysis.count, 0);
  assert.equal(analysis.period, "対象期間なし");
  assert.equal(analysis.coverage.covered, 0);

  const plan = generatePlan({ ...DEMO_PROFILE, planStart: "", planEnd: "", reviewDate: "" }, []);
  const audit = validatePlan(plan, []);
  assert.equal(audit.hasErrors, true);
  assert.equal(audit.checks.find((check) => check.id === "source").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "evidence").status, "error");
});

test("代表根拠は重複せず、期間の前後を含めて上限件数に収まる", () => {
  const ids = selectRepresentativeEvidence(DEMO_JOURNALS, ["peer_interaction"], 4);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, ids.length);
  const matching = DEMO_JOURNALS.filter((journal) => journal.tags.includes("peer_interaction"));
  assert.equal(ids[0], matching[0].id);
  assert.equal(ids.at(-1), matching.at(-1).id);
});

test("日本語日付は不正値を未設定として扱う", () => {
  assert.equal(formatDateJP("2026-05-29"), "2026年5月29日");
  assert.equal(formatDateJP("2026-05-29", { withYear: false, withWeekday: true }), "5月29日（金）");
  assert.equal(formatDateJP("invalid"), "未設定");
  assert.equal(formatDateJP("2026-02-30"), "未設定");
});

test("年齢は計画開始日時点の誕生日到来前後を含めて算出する", () => {
  assert.equal(calculateAgeLabel("2016-08-18", "2026-06-01"), "9歳");
  assert.equal(calculateAgeLabel("2016-08-18", "2026-08-18"), "10歳");
  assert.equal(calculateAgeLabel("invalid", "2026-06-01"), "");
  assert.equal(generatePlan(DEMO_PROFILE, DEMO_JOURNALS).child.ageLabel, "9歳");
});

test("根拠が3件未満の傾向は未確認とし、固定の支援目標を生成しない", () => {
  const unrelated = {
    ...DEMO_JOURNALS[0],
    id: "unrelated-1",
    domains: ["health"],
    tags: [],
    indicators: { selfExpression: null, transition: null, groupParticipation: null, regulation: null }
  };
  const analysis = analyzeJournals([unrelated]);
  const plan = generatePlan(DEMO_PROFILE, [unrelated]);

  assert.ok(analysis.patterns.every((pattern) => pattern.isConfirmed === false));
  assert.equal(analysis.isDraftReady, false);
  assert.equal(plan.supportItems.length, 0);
  assert.equal(plan.comprehensivePolicy, "");
  assert.match(plan.generationNote, /根拠が不足/);
});

test("関連しない表出タグの件数だけで援助要求を推定しない", () => {
  const dates = ["2026-04-01", "2026-04-10", "2026-04-21"];
  const journals = dates.map((date, index) => ({
    ...DEMO_JOURNALS[0],
    id: `self-only-${index}`,
    date,
    activity: index % 2 ? "お絵かき" : "色選び",
    observation: `好きな色は${["赤", "青", "緑"][index]}と言った。`,
    support: "色の選択肢を示した。",
    response: "好きな色を選んだ。",
    tags: ["self_expression"],
    indicators: { selfExpression: null, transition: null, groupParticipation: null, regulation: null }
  }));
  const analysis = analyzeJournals(journals);
  const plan = generatePlan(DEMO_PROFILE, journals);

  assert.ok(analysis.patterns.every((pattern) => pattern.isConfirmed === false));
  assert.equal(plan.supportItems.length, 0);
  assert.doesNotMatch(analysis.patterns.find((pattern) => pattern.id === "expression").summary, /疲れ|休憩|自発/);
});

test("同梱デモ以外では件数だけから詳細な数値目標や有効支援を断定しない", () => {
  const journals = DEMO_JOURNALS.filter((journal) => journal.tags.includes("help_request")).slice(0, 3);
  const plan = generatePlan(DEMO_PROFILE, journals);

  assert.equal(plan.supportItems.length, 1);
  assert.doesNotMatch(plan.supportItems[0].goal, /5回中4回/);
  assert.match(plan.supportItems[0].responsible, /要確認/);
  assert.match(plan.generationNote, /内容、変化、有効支援は.*未確認/);
});

test("同梱デモの体調・時間・記録者等が1つでも変更されたら詳細テンプレートを使わない", () => {
  const journals = DEMO_JOURNALS.map((journal, index) => index === 0
    ? { ...journal, physical: "高熱と嘔吐あり", staff: "別の記録者" }
    : journal);
  const plan = generatePlan(DEMO_PROFILE, journals);
  const audit = validatePlan(plan, journals);

  assert.ok(plan.supportItems.length > 0);
  assert.ok(plan.supportItems.every((item) => !/5回中4回|4回中3回/.test(item.goal)));
  assert.equal(plan.familySupport.goal, "");
  assert.equal(plan.transitionSupport.support, "");
  assert.equal(plan.communitySupport.evaluation, "");
  assert.equal(plan.monitoringPlan, "");
  assert.equal(audit.checks.find((check) => check.id === "otherSupport").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "monitoring").status, "error");
});

test("生成後の日誌内容・件数・期間の変更を根拠不一致として監査する", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  assert.equal(isPlanSourceFresh(plan, DEMO_JOURNALS), true);

  const changed = DEMO_JOURNALS.map((journal, index) => index === 0
    ? { ...journal, response: `${journal.response}追記` }
    : journal);
  assert.equal(isPlanSourceFresh(plan, changed), false);
  assert.equal(validatePlan(plan, changed).checks.find((check) => check.id === "freshness").status, "error");

  const added = [...DEMO_JOURNALS, { ...DEMO_JOURNALS.at(-1), id: "J-added", date: "2026-05-30" }];
  assert.equal(isPlanSourceFresh(plan, added), false);
  assert.equal(validatePlan(plan, added).checks.find((check) => check.id === "freshness").status, "error");
});

test("数年分の日誌をひとつの傾向や計画案にまとめない", () => {
  const dates = ["2024-01-01", "2025-01-01", "2026-01-01"];
  const journals = DEMO_JOURNALS.filter((journal) => journal.tags.includes("help_request")).slice(0, 3).map((journal, index) => ({
    ...journal,
    id: `wide-${index}`,
    date: dates[index]
  }));
  const analysis = analyzeJournals(journals);
  const plan = generatePlan({ ...DEMO_PROFILE, createdDate: "2026-01-02" }, journals);
  const audit = validatePlan(plan, journals);

  assert.ok(analysis.range.days > MAX_ANALYSIS_DAYS);
  assert.equal(analysis.range.withinLimit, false);
  assert.ok(analysis.patterns.every((pattern) => pattern.isConfirmed === false));
  assert.equal(plan.supportItems.length, 0);
  assert.equal(audit.checks.find((check) => check.id === "sourceRange").status, "error");
});

test("自動タグは職員の支援文ではなく観察事実と本人の反応から付与する", () => {
  const supportOnly = inferJournalTags({
    observation: "本人は積み木を続けた。",
    response: "穏やかに過ごした。",
    support: "職員が援助カードと休憩を提案した。",
    domains: ["cognition"]
  });
  assert.equal(supportOnly.includes("help_request"), false);
  assert.equal(supportOnly.includes("regulation"), false);

  const listening = inferJournalTags({
    observation: "本人は友達の話を最後まで聞いた。",
    response: "うなずいてから自分の考えを話した。",
    domains: ["social"]
  });
  assert.equal(listening.includes("help_request"), false);

  const observed = inferJournalTags({
    observation: "本人が「手伝ってください」と言った。",
    response: "休憩を選んだ。",
    domains: ["language"]
  });
  assert.equal(observed.includes("help_request"), true);
  assert.equal(observed.includes("regulation"), true);
});

test("未評価・対象外の観察指標は平均から除外し、有効件数を保持する", () => {
  const journals = DEMO_JOURNALS.slice(0, 4).map((journal) => ({
    ...journal,
    indicators: { ...journal.indicators, groupParticipation: null }
  }));
  const indicator = analyzeJournals(journals).indicators.groupParticipation;
  assert.equal(indicator.first, null);
  assert.equal(indicator.second, null);
  assert.equal(indicator.delta, null);
  assert.equal(indicator.firstCount + indicator.secondCount, 0);
});

test("計画日付と全支援の達成時期が6か月範囲外ならエラーにする", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.supportItems[0].targetDate = "2035-01-01";
  let audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "items").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "targetDates").status, "error");

  plan.supportItems[0].targetDate = "2026-09-01";
  plan.planEnd = "2026-05-31";
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "review").status, "error");
});

test("6か月期限は184日固定ではなく開始日から6暦月で判定する", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.planStart = "2026-02-01";
  plan.planEnd = "2026-08-04";
  plan.reviewDate = "2026-08-04";
  plan.supportItems.forEach((item) => { item.targetDate = "2026-08-04"; });
  plan.familySupport.targetDate = "2026-08-04";
  plan.transitionSupport.targetDate = "2026-08-04";
  plan.communitySupport.targetDate = "2026-08-04";

  let audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "review").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "targetDates").status, "error");

  plan.planEnd = "2026-08-01";
  plan.reviewDate = "2026-08-01";
  plan.supportItems.forEach((item) => { item.targetDate = "2026-08-01"; });
  plan.familySupport.targetDate = "2026-08-01";
  plan.transitionSupport.targetDate = "2026-08-01";
  plan.communitySupport.targetDate = "2026-08-01";
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "review").status, "pass");
  assert.equal(audit.checks.find((check) => check.id === "targetDates").status, "pass");
});

test("本人説明・文書同意・交付は必須情報と工程順がそろった時だけ合格する", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.service.managerName = "山田花子（児童発達支援管理責任者）";
  plan.workflow.assessmentInterview = { date: "2026-05-28", participants: "本人、保護者、児発管" };
  plan.workflow.supportMeeting = { date: "2026-05-29", participants: "児発管、児童指導員" };
  plan.workflow.guardianConsent.date = "2026-05-31";
  let audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "consent").status, "warning");

  plan.workflow.childExplanation = { date: "2026-05-31", method: "絵とやさしい言葉" };
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "consent").status, "pass");
  assert.doesNotMatch(audit.checks.find((check) => check.id === "assessment").detail, /未確認|未実施/);
  assert.doesNotMatch(audit.checks.find((check) => check.id === "meeting").detail, /未確認|未実施/);
  assert.equal(audit.checks.find((check) => check.id === "manager").status, "pass");

  plan.workflow.guardianConsent.version = 99;
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "consent").status, "warning");
  plan.workflow.guardianConsent.version = plan.version;

  plan.workflow.guardianDelivery = { date: "2026-06-01", method: "手渡し" };
  plan.workflow.consultationDelivery.notApplicable = true;
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "delivery").status, "warning");

  plan.workflow.consultationDelivery.reason = "指定障害児相談支援事業者の利用なしを保護者に確認";
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "delivery").status, "pass");
});

test("工程日付の逆転や対象計画版の不一致を合格にしない", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.service.managerName = "山田花子（児発管）";
  plan.workflow.assessmentInterview = { date: "2026-12-01", participants: "本人、保護者" };
  plan.workflow.supportMeeting = { date: "2025-01-01", participants: "支援チーム" };
  plan.workflow.childExplanation = { date: "2024-01-01", method: "絵カード" };
  plan.workflow.guardianConsent = { date: "2023-01-01", method: "書面", version: 99 };
  plan.workflow.guardianDelivery = { date: "2022-01-01", method: "手渡し" };
  plan.workflow.consultationDelivery = { date: "2021-01-01", method: "郵送", notApplicable: false, reason: "" };
  const audit = validatePlan(plan, DEMO_JOURNALS);

  assert.ok(audit.score < 100);
  assert.equal(audit.hasWarnings, true);
  assert.notEqual(audit.checks.find((check) => check.id === "assessment").status, "pass");
  assert.notEqual(audit.checks.find((check) => check.id === "meeting").status, "pass");
  assert.notEqual(audit.checks.find((check) => check.id === "consent").status, "pass");
  assert.notEqual(audit.checks.find((check) => check.id === "delivery").status, "pass");
});

test("生活課題と家族・移行・地域支援の必須項目を監査する", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.qualityOfLifeNeeds = "   ";
  plan.familySupport.goal = "";
  plan.transitionSupport.evaluation = "";
  plan.communitySupport.responsible = "";
  let audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "needs").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "otherSupport").status, "error");

  plan.qualityOfLifeNeeds = "生活全般の課題";
  plan.familySupport.goal = "家族と共有する";
  plan.transitionSupport.evaluation = "面談で確認する";
  plan.communitySupport.notApplicable = true;
  plan.communitySupport.reason = "関係機関の利用なしを本人・保護者に確認";
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "needs").status, "pass");
  assert.equal(audit.checks.find((check) => check.id === "otherSupport").status, "pass");
  assert.equal(audit.checks.find((check) => check.id === "targetDates").status, "pass");
});

test("利用児・保護者・利用時間・モニタリング・正の版番号を必須監査する", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.child.name = "";
  plan.child.birthDate = "";
  plan.child.guardianName = "";
  plan.child.grade = "";
  plan.service.usePattern = "";
  plan.service.standardSchedule = "";
  plan.monitoringPlan = "";
  plan.version = "";
  plan.workflow.guardianConsent.version = "";
  const audit = validatePlan(plan, DEMO_JOURNALS);

  assert.equal(audit.checks.find((check) => check.id === "childInfo").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "schedule").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "monitoring").status, "error");
  assert.equal(audit.checks.find((check) => check.id === "manager").status, "warning");
  assert.equal(audit.checks.find((check) => check.id === "consent").status, "warning");
  assert.ok(audit.score < 100);
  assert.equal(audit.hasErrors, true);
});

test("すべての本人支援目標に有効な根拠日誌が必要", () => {
  const plan = generatePlan(DEMO_PROFILE, DEMO_JOURNALS);
  plan.supportItems[0].evidenceIds = [];
  let audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "evidence").status, "error");

  plan.supportItems[0].evidenceIds = ["unknown"];
  audit = validatePlan(plan, DEMO_JOURNALS);
  assert.equal(audit.checks.find((check) => check.id === "evidence").status, "error");
});

test("CSVの数式インジェクションを防ぎ、ダブルクォートをエスケープする", () => {
  assert.equal(toCsvCell("=CMD()"), '"\'=CMD()"');
  assert.equal(toCsvCell("+1+1"), '"\'+1+1"');
  assert.equal(toCsvCell('本人が"休憩"と言った'), '"本人が""休憩""と言った"');
});

test("日付はUTCではなくローカル年月日を使う", () => {
  assert.equal(toLocalIsoDate(new Date(2026, 0, 2, 0, 30)), "2026-01-02");
  assert.equal(toLocalIsoDate(new Date("invalid")), "");
});
