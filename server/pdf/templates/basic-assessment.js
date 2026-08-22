import { buildDocumentHtml, firstValue, renderSchedules, renderSection } from "./common.js";

export const BASIC_ASSESSMENT_ORIENTATION = "portrait";

export function renderBasicAssessment(source, snapshotKind) {
  const payload = source.document.payload || {};
  const assessment = payload.assessment || {};
  const value = (keys, assessmentKey = null) => firstValue(payload, keys, assessmentKey ? assessment[assessmentKey] : null);
  const bodyHtml = [
    renderSection("本人・家族から伺ったこと", [
      ["本人の願い", value(["childWishes", "本人の意向", "childAndFamilyWishes"], "personWish")],
      ["家族の願い", value(["familyWishes", "家族の意向"], "familyWish")],
      ["困りごと・相談内容", value(["concerns", "困りごと", "consultationSummary"], "needs")],
      ["望む生活のイメージ", value(["desiredLife", "lifeVision", "oneYearVision"], "planningNotes")],
    ]),
    renderSection("現在の状況と強み・課題", [
      ["生活・健康", firstValue(payload, ["healthManagement", "dailyLiving", "healthStatus"])],
      ["運動・感覚", firstValue(payload, ["movementSensory", "motorSkills", "sensoryProfile"])],
      ["認知・行動", firstValue(payload, ["cognitionBehavior", "behavioralStatus"])],
      ["言語・コミュニケーション", firstValue(payload, ["languageCommunication", "communication"])],
      ["人間関係・社会性", firstValue(payload, ["relationshipsSocial", "socialParticipation"])],
      ["家族・生活環境", firstValue(payload, ["familySituation", "livingEnvironment"])],
      ["強み・好きなこと", value(["strengths", "interests"], "strengths")],
      ["優先して支援する課題", value(["priorityNeeds", "currentChallenges", "challenges"], "needs")],
    ]),
    renderSection("支援の見立て", [
      ["総合的なアセスメント", value(["overallAssessment", "currentSituation"], "planningNotes")],
      ["支援で大切にすること", value(["supportConsiderations", "supportDirection"], "supportDirection")],
      ["医療・安全上の留意事項", firstValue(payload, ["medicalSafetyNotes", "riskNotes"])],
      ["連携先と役割", firstValue(payload, ["supportNetwork", "informalSupport"])],
    ]),
    `<section class="document-section page-break-before"><h2>現在・予定の週間生活</h2>${renderSchedules(source.schedules)}</section>`,
  ].join("");
  return buildDocumentHtml({
    source,
    snapshotKind,
    title: "アセスメントシート",
    subtitle: "情報収集・状況整理",
    orientation: BASIC_ASSESSMENT_ORIENTATION,
    bodyHtml,
  });
}
