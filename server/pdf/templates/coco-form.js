import { escapeHtml, firstValue, formatDate } from "./common.js";

const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日", "学校休業"];
const DOMAIN_LABELS = {
  health_life: "健康・生活",
  motor_sensory: "運動・感覚",
  cognition_behavior: "認知・行動",
  language_communication: "言語・コミュニケーション",
  human_relations_sociality: "人間関係・社会性",
};

export const COCO_FORM_ORIENTATION = "portrait";

export function value(payload, keys, fallback = "") {
  const found = firstValue(payload, keys, fallback);
  if (found === null || found === undefined) return "";
  if (Array.isArray(found)) return found.join(" / ");
  return String(found);
}

function printableDate(value) {
  return value ? formatDate(value) : "";
}

function childAddress(child) {
  const address = child.address || {};
  return [address.postalCode ? `〒${address.postalCode}` : "", address.prefecture, address.city, address.line1, address.line2]
    .filter(Boolean)
    .join(" ");
}

export function text(value) {
  return escapeHtml(value || "").replaceAll("\n", "<br>");
}

export function cell(label, content, className = "") {
  return `<div class="coco-field ${className}"><b>${escapeHtml(label)}</b><div>${text(content)}</div></div>`;
}

export function section(title, content, className = "") {
  return `<section class="coco-section ${className}"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

export function signedDate(value) {
  if (!value) return "令和　　　年　　　月　　　日";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return printableDate(value);
  return `令和${date.getFullYear() - 2018}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function planRows(goals = [], { maxRows = 4 } = {}) {
  const rows = goals.filter((goal) => goal.goal_kind === "support").slice(0, maxRows);
  while (rows.length < maxRows) rows.push({});
  return rows.map((goal) => `<tr><td>${text(goal.title)}</td><td>${text(goal.support_details)}</td><td>${text(printableDate(goal.target_date))}</td><td>${text((goal.five_domains || []).map((domain) => DOMAIN_LABELS[domain] || domain).join("\n"))}</td></tr>`).join("");
}

export function payloadPlanRows(payload = {}, { maxRows = 4 } = {}) {
  const rows = [];
  for (let index = 1; index <= maxRows; index += 1) {
    const title = value(payload, [`supportGoal${index}`]);
    const supportDetails = value(payload, [`supportContent${index}`]);
    const targetDate = value(payload, [`supportTargetDate${index}`]);
    const fiveDomains = value(payload, [`supportFiveDomains${index}`]).split(/[、,/]/).map((item) => item.trim()).filter(Boolean);
    if (title || supportDetails || targetDate || fiveDomains.length) rows.push({ goal_kind: "support", title, support_details: supportDetails, target_date: targetDate, five_domains: fiveDomains });
  }
  return rows;
}

export function scheduleCells(schedules = []) {
  const planned = schedules.find((schedule) => schedule.schedule_kind === "planned") || schedules.find((schedule) => schedule.schedule_kind === "current");
  const items = planned?.items || [];
  return DAY_LABELS.map((_, index) => {
    const day = index === 7 ? null : (index + 1) % 7;
    return `<td>${text(day === null ? "" : items.filter((item) => Number(item.day_of_week) === day).map((item) => item.activity).join("\n"))}</td>`;
  }).join("");
}

export function payloadScheduleCells(payload = {}, schedules = []) {
  const keys = ["weeklyMonday", "weeklyTuesday", "weeklyWednesday", "weeklyThursday", "weeklyFriday", "weeklySaturday", "weeklySunday", "weeklySchoolHoliday"];
  const hasTemplateValues = keys.some((key) => value(payload, [key]));
  if (!hasTemplateValues) return scheduleCells(schedules);
  return keys.map((key) => `<td>${text(value(payload, [key]))}</td>`).join("");
}

export function buildCocoForm({ source, snapshotKind, title, bodyHtml, pageClass = "" }) {
  const child = source.child || {};
  const facility = source.facility || {};
  const document = source.document || {};
  const draft = snapshotKind === "draft";
  return `<!doctype html><html lang="ja" data-document-kind="${escapeHtml(document.document_kind)}" data-orientation="portrait"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    @page { size: A4 portrait; margin: 8mm 9mm; } * { box-sizing: border-box; } html { font-family: "IPAGothic", "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif; color: #111; } body { margin: 0; font-size: 8.6pt; line-height: 1.32; -webkit-print-color-adjust: exact; print-color-adjust: exact; } main { position: relative; } .coco-title { margin: 0 0 3mm; text-align: center; font-size: 17pt; line-height: 1.2; letter-spacing: .08em; } .coco-facility { position: absolute; top: 0; right: 0; max-width: 64mm; font-size: 8.5pt; } .coco-meta { display: grid; grid-template-columns: 1fr 1fr; margin: 0 0 2mm; border: .25mm solid #111; } .coco-meta > div { min-height: 8mm; padding: 1.3mm 2mm; border-right: .2mm solid #111; border-bottom: .2mm solid #111; } .coco-meta > div:nth-child(even) { border-right: 0; } .coco-meta > div:nth-last-child(-n+2) { border-bottom: 0; } .coco-meta b, .coco-field b { display: block; margin-bottom: .6mm; font-size: 7.4pt; font-weight: 700; } .coco-section { margin: 1.8mm 0 2.2mm; } .coco-section h2 { margin: 0; padding: 1.3mm 2mm; border: .25mm solid #111; border-bottom: 0; font-size: 9.6pt; background: #f2f2f2; } .coco-grid { display: grid; grid-template-columns: repeat(2, 1fr); border-left: .25mm solid #111; border-top: .25mm solid #111; } .coco-grid.one { grid-template-columns: 1fr; } .coco-field { min-height: 12mm; padding: 1.4mm 2mm; border-right: .25mm solid #111; border-bottom: .25mm solid #111; overflow-wrap: anywhere; } .coco-field.tall { min-height: 19mm; } .coco-field.xl { min-height: 28mm; } .coco-table { width: 100%; border-collapse: collapse; table-layout: fixed; } .coco-table th, .coco-table td { border: .25mm solid #111; padding: 1.2mm 1.5mm; vertical-align: top; overflow-wrap: anywhere; } .coco-table th { font-size: 7.4pt; background: #f2f2f2; } .coco-table td { height: 13mm; } .goal-table th:nth-child(1) { width: 24%; } .goal-table th:nth-child(2) { width: 49%; } .goal-table th:nth-child(3) { width: 13%; } .goal-table th:nth-child(4) { width: 14%; } .daily-table td { height: 11mm; } .daily-table th { width: 12.5%; } .signature { display: grid; grid-template-columns: 21mm 1fr 24mm 42mm 13mm; margin-top: 2mm; border: .25mm solid #111; } .signature div { min-height: 9mm; padding: 1.5mm; border-right: .25mm solid #111; } .signature div:last-child { border-right: 0; } .signature .label { background: #f2f2f2; font-size: 7.5pt; font-weight: 700; } .draft-mark { position: fixed; z-index: -1; top: 100mm; left: 20mm; color: rgb(160 0 0 / 10%); font-size: 52pt; font-weight: 700; transform: rotate(-25deg); } .page-break { break-before: page; } .${pageClass} .coco-title { font-size: 16pt; } .small { font-size: 7.3pt; }
    .basic-assessment .coco-section { margin: 1.1mm 0 1.3mm; } .basic-assessment .coco-field.tall { min-height: 13mm; } .basic-assessment .coco-field.xl { min-height: 19mm; } .basic-assessment .coco-table td { height: 10mm; }
    .individual-support-plan { font-size: 7.7pt; } .individual-support-plan .coco-section { margin: .8mm 0 1mm; } .individual-support-plan .coco-field.tall { min-height: 12mm; } .individual-support-plan .coco-table td { height: 8mm; } .individual-support-plan .daily-table td { height: 8mm; } .individual-support-plan .signature { margin-top: 1mm; } .individual-support-plan .signature div { min-height: 6.5mm; padding: 1mm; }
    .monitoring-record { font-size: 7.4pt; } .monitoring-record .coco-section { margin: .8mm 0 1mm; } .monitoring-record .coco-field.tall { min-height: 8.5mm; } .monitoring-record .coco-meta > div { min-height: 6.5mm; padding: .8mm 1.5mm; } .monitoring-record .coco-title { margin-bottom: 1.5mm; }
  </style></head><body><main class="${escapeHtml(pageClass)}">${draft ? '<div class="draft-mark">下書き</div>' : ''}<div class="coco-facility">事業所名：${text(facility.name || "放課後デイサービス COCO")}</div><h1 class="coco-title">${escapeHtml(title)}</h1><div class="coco-meta"><div><b>児童名</b>${text(child.legal_name || child.display_name)}</div><div><b>生年月日</b>${text(printableDate(child.birth_date))}</div><div><b>住所</b>${text(childAddress(child))}</div><div><b>電話</b>${text(child.primary_phone)}</div><div><b>作成日・記録日</b>${text(printableDate(document.updated_at || document.period_start))}</div><div><b>対象期間</b>${text([printableDate(document.period_start), printableDate(document.period_end)].filter(Boolean).join(" ～ "))}</div></div>${bodyHtml}</main></body></html>`;
}
