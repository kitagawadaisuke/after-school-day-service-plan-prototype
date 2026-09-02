import { buildCocoForm, cell, section, signedDate, text, value } from "./coco-form.js";

export const MONITORING_RECORD_ORIENTATION = "portrait";

function monitoringBlock(result = {}) {
  return `<section class="coco-section"><h2>具体的な支援内容</h2><div class="coco-grid one">${cell("支援目標", result.goal_title, "tall")}${cell("具体的な支援内容（活動プログラム）", result.support_details, "tall")}${cell("達成状況", result.progress_summary, "tall")}${cell("変更の必要性", result.next_support_policy, "tall")}${cell("特記事項", result.current_challenge, "tall")}</div></section>`;
}

export function renderMonitoringRecord(source, snapshotKind) {
  const payload = source.document.payload || {};
  const monitoring = payload.monitoring || payload;
  const results = [...(source.monitoringResults || [])];
  while (results.length < 4) results.push({});
  const initial = [
    section("支援課題", `<div class="coco-grid one">${cell("支援課題", value(payload, ["supportIssues", "overallEvaluation"]), "tall")}</div>`),
    section("療育の希望", `<div class="coco-grid">${cell("本人の希望", value(monitoring, ["personFeedback", "childWishes"]), "tall")}${cell("保護者の希望", value(monitoring, ["familyFeedback", "familyWishes"]), "tall")}</div>`),
    section("支援計画", `<div class="coco-grid">${cell("長期目標", value(payload, ["longTermGoal"]), "tall")}${cell("短期目標", value(payload, ["shortTermGoal"]), "tall")}${cell("達成状況", value(monitoring, ["overallEvaluation"]), "tall")}${cell("変更の必要性", value(monitoring, ["nextPlanDirection"]), "tall")}</div>`),
    monitoringBlock(results[0]), monitoringBlock(results[1]),
  ].join("");
  const final = `${monitoringBlock(results[2])}${monitoringBlock(results[3])}${section("備考", `<div class="coco-grid one">${cell("備考", value(payload, ["remarks", "nextPlanDirection"]), "tall")}</div>`)}<div class="signature"><div class="label">日付</div><div>${text(signedDate(source.document.updated_at))}</div><div class="label">保護者名</div><div>${text(source.guardian?.legal_name)}</div><div>印</div></div><div class="signature"><div class="label">確認者</div><div>${text(source.approval?.approved_by_name)}</div><div class="label">児童名</div><div>${text(source.child?.legal_name || source.child?.display_name)}</div><div>印</div></div>`;
  return buildCocoForm({ source, snapshotKind, title: "モニタリング", bodyHtml: `${initial}<div class="page-break">${final}</div>`, pageClass: "monitoring-record" });
}
