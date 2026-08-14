import { buildDocumentHtml, firstValue, renderSchedules, renderSection } from "./common.js";

export const BASIC_ASSESSMENT_ORIENTATION = "portrait";

export function renderBasicAssessment(source, snapshotKind) {
  const payload = source.document.payload || {};
  const bodyHtml = [
    renderSection("本人・家族から伺ったこと", [
      ["本人の願い", firstValue(payload, ["childWishes", "本人の意向", "childAndFamilyWishes"])],
      ["家族の願い", firstValue(payload, ["familyWishes", "家族の意向"])],
      ["困りごと・相談内容", firstValue(payload, ["concerns", "困りごと", "consultationSummary"])],
      ["望む生活のイメージ", firstValue(payload, ["desiredLife", "lifeVision", "oneYearVision"])],
    ]),
    renderSection("現在の状況と強み・課題", [
      ["生活・健康", firstValue(payload, ["healthManagement", "dailyLiving", "healthStatus"])],
      ["運動・感覚", firstValue(payload, ["movementSensory", "motorSkills", "sensoryProfile"])],
      ["認知・行動", firstValue(payload, ["cognitionBehavior", "behavioralStatus"])],
      ["言語・コミュニケーション", firstValue(payload, ["languageCommunication", "communication"])],
      ["人間関係・社会性", firstValue(payload, ["relationshipsSocial", "socialParticipation"])],
      ["家族・生活環境", firstValue(payload, ["familySituation", "livingEnvironment"])],
      ["強み・好きなこと", firstValue(payload, ["strengths", "interests"])],
      ["優先して支援する課題", firstValue(payload, ["priorityNeeds", "currentChallenges", "challenges"])],
    ]),
    renderSection("支援の見立て", [
      ["総合的なアセスメント", firstValue(payload, ["overallAssessment", "currentSituation"])],
      ["支援で大切にすること", firstValue(payload, ["supportConsiderations", "supportDirection"])],
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
