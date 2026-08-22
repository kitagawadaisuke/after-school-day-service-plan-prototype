import { buildDocumentHtml, firstValue, renderMonitoringResults, renderSection } from "./common.js";

export const MONITORING_RECORD_ORIENTATION = "portrait";

export function renderMonitoringRecord(source, snapshotKind) {
  const payload = source.document.payload || {};
  const bodyHtml = [
    renderSection("モニタリング会議", [
      ["開催日・時間", firstValue(payload, ["meetingDateTime", "meetingDate"])],
      ["開催方法・場所", firstValue(payload, ["meetingMethod", "meetingLocation"])],
      ["出席者", firstValue(payload, ["participants", "attendees"])],
      ["本人・家族からの意見", firstValue(payload, ["childAndFamilyFeedback", "familyFeedback"])],
    ]),
    renderSection("総合評価", [
      ["支援期間の総括", firstValue(payload, ["overallEvaluation", "periodSummary"])],
      ["日誌・連絡帳から確認した根拠", firstValue(payload, ["evidenceSummary", "journalEvidence"])],
      ["環境・家庭・関係機関の変化", firstValue(payload, ["contextChanges", "environmentChanges"])],
      ["次期計画の方針", firstValue(payload, ["nextPlanPolicy", "nextSupportPolicy"])],
    ]),
    `<section class="document-section"><h2>目標別の進捗確認</h2>${renderMonitoringResults(source.monitoringResults)}</section>`,
  ].join("");
  return buildDocumentHtml({
    source,
    snapshotKind,
    title: "モニタリング記録",
    subtitle: "日々の記録と計画目標の評価",
    orientation: MONITORING_RECORD_ORIENTATION,
    bodyHtml,
  });
}
