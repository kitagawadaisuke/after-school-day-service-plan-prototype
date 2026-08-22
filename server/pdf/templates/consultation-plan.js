import { buildDocumentHtml, firstValue, renderGoals, renderSchedules, renderSection } from "./common.js";

export const CONSULTATION_PLAN_ORIENTATION = "landscape";

export function renderConsultationPlan(source, snapshotKind) {
  const payload = source.document.payload || {};
  const bodyHtml = [
    renderSection("サービス等利用計画の全体像", [
      ["本人・家族の生活に対する意向", firstValue(payload, ["childAndFamilyWishes", "userAndFamilyWishes", "desiredLife"])],
      ["総合的な援助の方針", firstValue(payload, ["overallPolicy", "overallSupportPolicy"])],
      ["長期的な生活目標", firstValue(payload, ["longTermGoal", "oneYearGoal"])],
      ["短期的な生活目標", firstValue(payload, ["shortTermGoal", "nearTermGoal"])],
    ]),
    `<section class="document-section"><h2>目標と役割分担</h2>${renderGoals(source.goals)}</section>`,
    renderSection("支援体制と調整事項", [
      ["介護・福祉サービス", firstValue(payload, ["formalServices", "servicePlan"])],
      ["セルフケアと本人の役割", firstValue(payload, ["selfCare", "childRole"])],
      ["家族・地域の協力", firstValue(payload, ["familyAndCommunitySupport", "informalSupport"])],
      ["関係機関の役割", firstValue(payload, ["professionalRoles", "coordinationNotes"])],
    ]),
    `<section class="document-section page-break-before"><h2>現在と計画後の週間生活</h2>${renderSchedules(source.schedules)}</section>`,
  ].join("");
  return buildDocumentHtml({
    source,
    snapshotKind,
    title: "サービス等利用計画",
    subtitle: "相談支援事業所からの全体計画",
    orientation: CONSULTATION_PLAN_ORIENTATION,
    bodyHtml,
  });
}
