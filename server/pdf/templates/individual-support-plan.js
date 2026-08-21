import { buildDocumentHtml, firstValue, renderGoals, renderSection } from "./common.js";

export const INDIVIDUAL_SUPPORT_PLAN_ORIENTATION = "landscape";

export function renderIndividualSupportPlan(source, snapshotKind) {
  const payload = source.document.payload || {};
  const bodyHtml = [
    renderSection("計画の基本方針", [
      ["本人・家族の意向", firstValue(payload, ["userAndFamilyWishes", "childAndFamilyWishes"])],
      ["総合的な支援の方針", firstValue(payload, ["overallSupportPolicy", "overallPolicy"])],
      ["相談支援計画とのつながり", firstValue(payload, ["consultationPlanBasis", "sourceConsultationSummary"])],
      ["支援期間の留意事項", firstValue(payload, ["supportConsiderations", "riskNotes"])],
    ]),
    `<section class="document-section"><h2>支援目標・具体的な支援内容</h2>${renderGoals(source.goals)}</section>`,
    renderSection("実施・確認の記録", [
      ["支援の標準的な提供方法", firstValue(payload, ["serviceDelivery", "standardSupportMethod"])],
      ["関係機関・家族との連携", firstValue(payload, ["coordination", "familyCollaboration"])],
      ["説明・同意時の確認事項", firstValue(payload, ["explanationNotes", "consentNotes"])],
      ["モニタリング時期・方法", firstValue(payload, ["monitoringPlan", "evaluationSchedule"])],
    ]),
  ].join("");
  return buildDocumentHtml({
    source,
    snapshotKind,
    title: "個別支援計画書",
    subtitle: "事業所で実施する支援計画",
    orientation: INDIVIDUAL_SUPPORT_PLAN_ORIENTATION,
    bodyHtml,
    plainHeading: true,
  });
}
