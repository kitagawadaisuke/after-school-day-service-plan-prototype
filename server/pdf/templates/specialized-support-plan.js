import { buildCocoForm, cell, planRows, section, signedDate, text, value } from "./coco-form.js";

export const SPECIALIZED_SUPPORT_PLAN_ORIENTATION = "portrait";

export function renderSpecializedSupportPlan(source, snapshotKind) {
  const payload = source.document.payload || {};
  const supportGoals = source.goals?.length ? source.goals : [{
    goal_kind: "support",
    title: value(payload, ["specializedSupportTarget"]),
    support_details: value(payload, ["specializedSupportContent"]),
    target_date: value(payload, ["specializedTargetDate"]),
    five_domains: value(payload, ["specializedFiveDomains"]).split(/[、,/]/).filter(Boolean),
  }];
  const longTerm = source.goals?.find((goal) => goal.goal_kind === "long_term");
  const shortTerm = source.goals?.find((goal) => goal.goal_kind === "short_term");
  const bodyHtml = [
    section("支援課題（アセスメント結果）", `<div class="coco-grid one">${cell("支援課題", value(payload, ["supportIssues", "overallSupportPolicy"]), "tall")}</div>`),
    section("療育の希望", `<div class="coco-grid">${cell("本人の希望", value(payload, ["childWishes", "userAndFamilyWishes"]), "tall")}${cell("保護者の希望", value(payload, ["familyWishes", "userAndFamilyWishes"]), "tall")}</div>`),
    section("目指すべき達成目標", `<div class="coco-grid one">${cell("達成目標", value(payload, ["specializedGoal", "desiredOutcome", "overallSupportPolicy"]), "tall")}</div>`),
    section("支援計画", `<div class="coco-grid one">${cell("長期目標", longTerm?.title || value(payload, ["longTermGoal"]), "tall")}${cell("短期目標", shortTerm?.title || value(payload, ["shortTermGoal"]), "tall")}</div>`),
    section("具体的な支援内容", `<table class="coco-table goal-table"><thead><tr><th>支援目標</th><th>具体的な支援内容（活動プログラム）</th><th>達成時期</th><th>5領域</th></tr></thead><tbody>${planRows(supportGoals, { maxRows: 3 })}</tbody></table>`),
    `<p class="small">上記の計画について説明を受け、内容に同意し、交付を受けました。</p><div class="signature"><div class="label">説明日</div><div>${text(signedDate(source.consent?.explained_at))}</div><div class="label">説明者</div><div>${text(source.approval?.approved_by_name)}</div><div>印</div></div><div class="signature"><div class="label">同意日</div><div>${text(signedDate(source.consent?.consented_at))}</div><div class="label">専門職員</div><div>${text(source.approval?.approved_by_name)}</div><div>印</div></div><div class="signature"><div class="label">次回更新日</div><div>${text(signedDate(source.document.period_end))}</div><div class="label">保護者名</div><div>${text(source.consent?.signer_name || source.guardian?.legal_name)}</div><div>印</div></div>`,
  ].join("");
  return buildCocoForm({ source, snapshotKind, title: "専門的支援実施計画書", bodyHtml, pageClass: "specialized-support-plan" });
}
