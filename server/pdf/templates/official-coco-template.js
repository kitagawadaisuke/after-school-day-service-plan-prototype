import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, formatDate } from "./common.js";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "coco-original");
const PAGE_WIDTH = 595.2;
const PAGE_HEIGHT = 841.68;

function pngData(name) {
  return `data:image/png;base64,${readFileSync(join(TEMPLATE_DIR, name)).toString("base64")}`;
}

function plain(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}

function pick(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== null && value !== undefined && plain(value).trim()) return plain(value);
  }
  return "";
}

function date(value) {
  return value ? formatDate(value) : "";
}

function childName(source) {
  return source.child?.legal_name || source.child?.display_name || "";
}

function htmlText(value) {
  return escapeHtml(plain(value)).replaceAll("\n", "<br>");
}

function textUnits(value) {
  return [...plain(value)].reduce((total, character) => {
    if (/\s/.test(character)) return total + 0.35;
    if (/^[\x00-\x7F]$/.test(character)) return total + 0.58;
    return total + 1;
  }, 0);
}

function fittedFontSize(value, width, height, preferredSize) {
  const units = textUnits(value);
  if (!units) return preferredSize;

  // 帳票の枠は固定なので、文字数に応じて行数と文字サイズを両方見積もる。
  // 余白を含めて少し小さめに算出し、改行後の末尾が枠外へ出ないようにする。
  const availableWidth = Math.max(1, width - 2);
  const availableHeight = Math.max(1, height - 1);
  const estimated = Math.sqrt((availableWidth * availableHeight) / (units * 1.48));
  const fitted = Math.min(preferredSize, estimated);
  return Math.max(2.8, Math.round(fitted * 10) / 10);
}

function field({ x, y, w, h, value, size = 7.4, align = "left" }) {
  const content = plain(value);
  if (!content.trim()) return "";
  const fittedSize = fittedFontSize(content, w, h, size);
  const compact = fittedSize < size;
  return `<div class="official-field${compact ? " official-field--compact" : ""}" data-font-size="${fittedSize}" style="left:${x}pt;top:${y}pt;width:${w}pt;height:${h}pt;font-size:${fittedSize}pt;text-align:${align}">${htmlText(content)}</div>`;
}

function page(image, fields) {
  return `<section class="official-page"><img alt="" src="${pngData(image)}">${fields.join("")}</section>`;
}

function allSupportRows(source, payload, limit) {
  const stored = (source.goals || []).filter((goal) => goal.goal_kind === "support");
  const rows = stored.length ? stored : Array.from({ length: limit }, (_, index) => {
    const number = index + 1;
    return {
      title: pick(payload, `supportGoal${number}`),
      support_details: pick(payload, `supportContent${number}`),
      target_date: pick(payload, `supportTargetDate${number}`),
      five_domains: pick(payload, `supportFiveDomains${number}`).split(/[、,/]/).filter(Boolean),
    };
  });
  return rows.slice(0, limit);
}

function planHeader(source, payload, { specialized = false } = {}) {
  const author = source.approval?.approved_by_name || "";
  return [
    field({ x: 388, y: 42, w: 155, h: 13, value: source.facility?.name, size: 7 }),
    field({ x: 122, y: 84, w: 215, h: 13, value: date(source.document?.updated_at || source.document?.period_start), size: 7 }),
    field({ x: specialized ? 382 : 370, y: 84, w: 160, h: 13, value: author, size: 7 }),
    field({ x: specialized ? 104 : 105, y: 123, w: 215, h: 13, value: childName(source), size: 8 }),
    field({ x: specialized ? 385 : 370, y: 123, w: 160, h: 13, value: date(source.child?.birth_date), size: 7 }),
  ];
}

function renderAssessment(source) {
  const payload = source.document?.payload || {};
  const p1 = [
    field({ x: 401, y: 68, w: 145, h: 14, value: date(source.document?.updated_at), size: 7 }),
    field({ x: 105, y: 111, w: 190, h: 17, value: childName(source), size: 8 }),
    field({ x: 345, y: 111, w: 180, h: 17, value: date(source.child?.birth_date), size: 7 }),
    field({ x: 105, y: 138, w: 190, h: 17, value: [source.child?.address?.prefecture, source.child?.address?.city, source.child?.address?.line1, source.child?.address?.line2].filter(Boolean).join(" "), size: 6.5 }),
    field({ x: 345, y: 138, w: 180, h: 17, value: source.child?.primary_phone, size: 7 }),
    ...[["dailyMeal", 204], ["dailyDressing", 232], ["dailyToileting", 260], ["dailyBathing", 288], ["dailySleep", 316]].map(([key, y]) => field({ x: 323, y, w: 205, h: 22, value: pick(payload, key), size: 6.5 })),
    field({ x: 160, y: 344, w: 365, h: 20, value: pick(payload, "scheduleManagement"), size: 6.5 }),
    field({ x: 154, y: 403, w: 235, h: 14, value: pick(payload, "schoolClass"), size: 6.5 }),
    field({ x: 154, y: 425, w: 235, h: 24, value: pick(payload, "learning"), size: 6.5 }),
    ...[["socialUnderstanding", 485], ["environmentAdaptation", 512], ["friendRelationships", 539], ["publicBehavior", 566]].map(([key, y]) => field({ x: 160, y, w: 365, h: 21, value: pick(payload, key), size: 6.5 })),
    field({ x: 160, y: 626, w: 365, h: 21, value: pick(payload, "speaksIndependently"), size: 6.5 }),
    field({ x: 160, y: 652, w: 365, h: 21, value: pick(payload, "listensToOthers"), size: 6.5 }),
    field({ x: 160, y: 717, w: 365, h: 30, value: pick(payload, "hobbies", "strengths"), size: 6.5 }),
    field({ x: 160, y: 748, w: 365, h: 25, value: pick(payload, "lessons"), size: 6.5 }),
  ];
  const p2 = [
    field({ x: 160, y: 122, w: 170, h: 18, value: pick(payload, "familyCareerPath"), size: 6.5 }),
    field({ x: 160, y: 150, w: 170, h: 18, value: pick(payload, "childCareerPath"), size: 6.5 }),
    field({ x: 66, y: 207, w: 460, h: 65, value: pick(payload, "supportNotes", "medicalSafetyNotes", "planningNotes"), size: 7 }),
    ...[
      ["favoriteFood", 163, 350], ["dislikedFood", 403, 350], ["favoriteSnack", 163, 378], ["drinks", 403, 378],
      ["favoritePlay", 163, 406], ["difficultPlay", 403, 406], ["favoriteCharacter", 163, 433], ["difficultCharacter", 403, 433],
      ["favoriteThings", 163, 460], ["sleepPattern", 163, 488],
    ].map(([key, x, y]) => field({ x, y, w: 105, h: 20, value: pick(payload, key), size: 6.3 })),
    field({ x: 160, y: 538, w: 130, h: 18, value: pick(payload, "favoriteOutings"), size: 6.3 }),
    field({ x: 403, y: 538, w: 130, h: 18, value: pick(payload, "difficultOutings"), size: 6.3 }),
    field({ x: 160, y: 566, w: 360, h: 18, value: pick(payload, "outingNotes", "outsideNotes"), size: 6.3 }),
    field({ x: 110, y: 647, w: 375, h: 44, value: pick(payload, "otherServices"), size: 6.3 }),
    field({ x: 110, y: 716, w: 375, h: 44, value: pick(payload, "desiredServiceDays"), size: 6.3 }),
    field({ x: 250, y: 784, w: 130, h: 16, value: date(source.document?.period_start), size: 7 }),
  ];
  return `${page("assessment-1.png", p1)}${page("assessment-2.png", p2)}`;
}

function renderIndividual(source) {
  const payload = source.document?.payload || {};
  const goals = allSupportRows(source, payload, 4);
  const supportYs = [443, 493, 545, 572];
  const fields = [
    ...planHeader(source, payload),
    field({ x: 91, y: 165, w: 440, h: 25, value: pick(payload, "supportIssues", "overallSupportPolicy"), size: 6.7 }),
    field({ x: 104, y: 229, w: 430, h: 43, value: pick(payload, "childWishes", "userAndFamilyWishes"), size: 6.7 }),
    field({ x: 104, y: 290, w: 430, h: 48, value: pick(payload, "familyWishes", "userAndFamilyWishes"), size: 6.7 }),
    field({ x: 100, y: 368, w: 350, h: 17, value: pick(payload, "longTermGoal"), size: 6.7 }),
    field({ x: 100, y: 389, w: 350, h: 17, value: pick(payload, "shortTermGoal"), size: 6.7 }),
    ...goals.flatMap((goal, index) => [
      field({ x: 49, y: supportYs[index], w: 153, h: index < 2 ? 47 : 22, value: goal.title, size: 6.2 }),
      field({ x: 206, y: supportYs[index], w: 172, h: index < 2 ? 47 : 22, value: goal.support_details, size: 6.2 }),
      field({ x: 381, y: supportYs[index], w: 70, h: index < 2 ? 47 : 22, value: date(goal.target_date), size: 5.8 }),
      field({ x: 454, y: supportYs[index], w: 91, h: index < 2 ? 47 : 22, value: Array.isArray(goal.five_domains) ? goal.five_domains.join("、") : goal.five_domains, size: 5.8 }),
    ]),
    ...[["weeklyMonday", 102], ["weeklyTuesday", 156], ["weeklyWednesday", 210], ["weeklyThursday", 264], ["weeklyFriday", 318], ["weeklySaturday", 372], ["weeklySunday", 426], ["weeklySchoolHoliday", 480]].map(([key, x]) => field({ x, y: 636, w: 50, h: 18, value: pick(payload, key), size: 5.4, align: "center" })),
    field({ x: 100, y: 658, w: 420, h: 14, value: pick(payload, "weeklyNotes"), size: 6 }),
    field({ x: 91, y: 699, w: 440, h: 23, value: pick(payload, "supportConsiderations", "explanationNotes"), size: 6.2 }),
  ];
  return page("individual-plan-1.png", fields);
}

function renderSpecialized(source) {
  const payload = source.document?.payload || {};
  const goals = allSupportRows(source, payload, 2);
  const fields = [
    field({ x: 430, y: 70, w: 120, h: 13, value: source.facility?.name, size: 7 }),
    field({ x: 82, y: 112, w: 245, h: 13, value: date(source.document?.updated_at || source.document?.period_start), size: 7 }),
    field({ x: 371, y: 112, w: 160, h: 13, value: source.approval?.approved_by_name, size: 7 }),
    field({ x: 80, y: 159, w: 250, h: 14, value: childName(source), size: 8 }),
    field({ x: 375, y: 159, w: 160, h: 14, value: date(source.child?.birth_date), size: 7 }),
    field({ x: 44, y: 218, w: 500, h: 32, value: pick(payload, "supportIssues", "overallSupportPolicy"), size: 6.7 }),
    field({ x: 100, y: 300, w: 420, h: 48, value: pick(payload, "childWishes", "userAndFamilyWishes"), size: 6.7 }),
    field({ x: 100, y: 373, w: 420, h: 50, value: pick(payload, "familyWishes", "userAndFamilyWishes"), size: 6.7 }),
    field({ x: 44, y: 454, w: 500, h: 26, value: pick(payload, "specializedGoal", "overallSupportPolicy"), size: 6.7 }),
    field({ x: 100, y: 520, w: 340, h: 18, value: pick(payload, "longTermGoal"), size: 6.7 }),
    field({ x: 100, y: 547, w: 340, h: 18, value: pick(payload, "shortTermGoal"), size: 6.7 }),
    ...goals.flatMap((goal, index) => {
      const y = index === 0 ? 607 : 654;
      return [field({ x: 46, y, w: 155, h: 53, value: goal.title, size: 6.2 }), field({ x: 205, y, w: 175, h: 53, value: goal.support_details, size: 6.2 }), field({ x: 383, y, w: 55, h: 53, value: date(goal.target_date), size: 5.8 }), field({ x: 441, y, w: 105, h: 53, value: Array.isArray(goal.five_domains) ? goal.five_domains.join("、") : goal.five_domains, size: 5.8 })];
    }),
  ];
  return page("specialized-plan-1.png", fields);
}

function monitoringValues(payload, index) {
  return {
    goal: pick(payload, `monitoringSupportGoal${index}`), content: pick(payload, `monitoringSupportContent${index}`), progress: pick(payload, `monitoringProgress${index}`), change: pick(payload, `monitoringChange${index}`), notes: pick(payload, `monitoringNotes${index}`),
  };
}

function monitoringBlockFields(values, y, compact = false) {
  const offsets = compact ? { content: 14, progress: 36, change: 50, notes: 71, notesHeight: 31 } : { content: 21, progress: 46, change: 60, notes: 96, notesHeight: 36 };
  return [
    field({ x: 136, y, w: 300, h: 20, value: values.goal, size: 6.2 }),
    field({ x: 106, y: y + offsets.content, w: 430, h: 20, value: values.content, size: 6.2 }),
    field({ x: 106, y: y + offsets.progress, w: 430, h: 14, value: values.progress, size: 6.2 }),
    field({ x: 106, y: y + offsets.change, w: 430, h: 14, value: values.change, size: 6.2 }),
    field({ x: 106, y: y + offsets.notes, w: 430, h: offsets.notesHeight, value: values.notes, size: 6.2 }),
  ];
}

function renderMonitoring(source) {
  const payload = source.document?.payload || {};
  const fields1 = [
    field({ x: 340, y: 50, w: 180, h: 12, value: source.facility?.name, size: 7 }),
    field({ x: 95, y: 90, w: 200, h: 16, value: childName(source), size: 8 }), field({ x: 390, y: 90, w: 140, h: 16, value: date(source.child?.birth_date), size: 7 }),
    field({ x: 95, y: 126, w: 440, h: 17, value: [date(source.document?.period_start), date(source.document?.period_end)].filter(Boolean).join(" ～ "), size: 7 }),
    field({ x: 95, y: 155, w: 200, h: 17, value: date(source.document?.updated_at), size: 7 }),
    field({ x: 390, y: 155, w: 140, h: 17, value: source.approval?.approved_by_name, size: 7 }),
    field({ x: 45, y: 191, w: 490, h: 25, value: pick(payload, "supportIssues"), size: 6.5 }),
    field({ x: 100, y: 255, w: 420, h: 25, value: pick(payload, "childWishes"), size: 6.5 }), field({ x: 100, y: 305, w: 420, h: 52, value: pick(payload, "familyWishes"), size: 6.5 }),
    field({ x: 115, y: 355, w: 330, h: 18, value: pick(payload, "longTermGoal"), size: 6.3 }), field({ x: 115, y: 375, w: 420, h: 14, value: pick(payload, "overallEvaluation"), size: 6.3 }), field({ x: 115, y: 390, w: 420, h: 14, value: pick(payload, "nextPlanDirection"), size: 6.3 }), field({ x: 115, y: 415, w: 420, h: 25, value: pick(payload, "remarks"), size: 6.3 }),
    field({ x: 115, y: 447, w: 330, h: 18, value: pick(payload, "shortTermGoal"), size: 6.3 }), field({ x: 115, y: 467, w: 420, h: 14, value: pick(payload, "overallEvaluation"), size: 6.3 }), field({ x: 115, y: 482, w: 420, h: 14, value: pick(payload, "nextPlanDirection"), size: 6.3 }), field({ x: 115, y: 504, w: 420, h: 24, value: pick(payload, "remarks"), size: 6.3 }),
    ...monitoringBlockFields(monitoringValues(payload, 1), 555), ...monitoringBlockFields(monitoringValues(payload, 2), 707),
  ];
  const fields2 = [
    ...monitoringBlockFields(monitoringValues(payload, 3), 53, true), ...monitoringBlockFields(monitoringValues(payload, 4), 161, true),
    field({ x: 105, y: 368, w: 420, h: 20, value: pick(payload, "remarks", "nextPlanDirection"), size: 6.3 }),
    field({ x: 111, y: 521, w: 210, h: 18, value: date(source.document?.updated_at), size: 7 }), field({ x: 111, y: 550, w: 210, h: 18, value: source.guardian?.legal_name, size: 7 }), field({ x: 111, y: 580, w: 210, h: 18, value: childName(source), size: 7 }),
  ];
  return `${page("monitoring-1.png", fields1)}${page("monitoring-2.png", fields2)}`;
}

export function renderOfficialCocoTemplate(source) {
  const kind = source.document?.document_kind;
  const title = kind === "basic_assessment" ? "アセスメントシート"
    : kind === "individual_support_plan" ? "個別支援計画"
      : kind === "specialized_support_plan" ? "専門的支援実施計画書"
        : kind === "monitoring_record" ? "モニタリング" : "";
  const body = kind === "basic_assessment" ? renderAssessment(source)
    : kind === "individual_support_plan" ? renderIndividual(source)
      : kind === "specialized_support_plan" ? renderSpecialized(source)
        : kind === "monitoring_record" ? renderMonitoring(source)
          : null;
  if (!body) return null;
  return `<!doctype html><html lang="ja" data-document-kind="${escapeHtml(kind)}" data-orientation="portrait"><head><meta charset="utf-8"><title>${title}</title><style>@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}.template-contract{display:none}.official-page{position:relative;width:${PAGE_WIDTH}pt;height:${PAGE_HEIGHT}pt;break-after:page;overflow:hidden}.official-page:last-child{break-after:auto}.official-page>img{position:absolute;inset:0;width:100%;height:100%;display:block}.official-field{position:absolute;z-index:1;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;line-height:1.24;color:#111;font-family: "IPAGothic","Noto Sans CJK JP","Yu Gothic","Meiryo",sans-serif}.official-field--compact{line-height:1.18;letter-spacing:-.01em}</style></head><body><div class="template-contract"><h1 class="coco-title">${title}</h1><span>具体的な支援内容（活動プログラム）</span></div>${body}</body></html>`;
}
