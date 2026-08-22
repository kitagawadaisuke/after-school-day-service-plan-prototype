const STATUS_LABELS = Object.freeze({
  draft: "作成中",
  internal_review: "内部確認中",
  explanation_pending: "説明待ち",
  consented: "同意済み",
  approved: "承認済み",
  distributed: "交付済み",
  active: "利用中",
  superseded: "改定済み",
  closed: "終了",
  void: "無効",
});

const GOAL_LABELS = Object.freeze({
  long_term: "長期目標",
  short_term: "短期目標",
  support: "支援目標",
});

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatDate(value) {
  if (!value) return "—";
  const text = typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : text;
}

export function formatValue(value) {
  if (value === null || value === undefined || value === "") return "未記入";
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  if (Array.isArray(value)) return value.length ? value.map(formatValue).join(" / ") : "未記入";
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, nested]) => nested !== null && nested !== undefined && nested !== "")
      .map(([key, nested]) => `${key}: ${formatValue(nested)}`)
      .join("\n") || "未記入";
  }
  return String(value);
}

export function firstValue(payload, keys, fallback = null) {
  for (const key of keys) {
    if (payload?.[key] !== null && payload?.[key] !== undefined && payload?.[key] !== "") return payload[key];
  }
  return fallback;
}

export function renderFieldRows(rows) {
  const cell = ([label, value]) => `
    <th scope="row">${escapeHtml(label)}</th>
    <td>${escapeHtml(formatValue(value)).replaceAll("\n", "<br>")}</td>`;
  const rendered = [];
  for (let index = 0; index < rows.length; index += 2) {
    const first = rows[index];
    const second = rows[index + 1];
    rendered.push(second
      ? `<tr>${cell(first)}${cell(second)}</tr>`
      : `<tr>${cell(first)}<td colspan="2"></td></tr>`);
  }
  return rendered.join("");
}

export function renderSection(title, rows, options = {}) {
  return `
    <section class="document-section ${options.breakBefore ? "page-break-before" : ""}">
      <table class="field-table">
        <thead><tr><th class="field-table-title" colspan="4"><h2>${escapeHtml(title)}</h2></th></tr></thead>
        <tbody>${renderFieldRows(rows)}</tbody>
      </table>
    </section>`;
}

export function renderGoals(goals = []) {
  if (!goals.length) return '<p class="empty">目標はまだ登録されていません。</p>';
  return `
    <table class="record-table goal-table">
      <thead><tr><th>区分</th><th>目標・到達像</th><th>支援内容</th><th>評価方法・担当</th><th>期限</th></tr></thead>
      <tbody>${goals.map((goal) => `
        <tr>
          <td>${escapeHtml(GOAL_LABELS[goal.goal_kind] || goal.goal_kind)}</td>
          <td><strong>${escapeHtml(goal.title)}</strong><br>${escapeHtml(formatValue(goal.desired_outcome))}</td>
          <td>${escapeHtml(formatValue(goal.support_details))}<br><span class="subtle">5領域: ${escapeHtml(formatValue(goal.five_domains))}</span></td>
          <td>${escapeHtml(formatValue(goal.evaluation_method))}<br>${escapeHtml(formatValue(goal.responsible_party))}</td>
          <td>${escapeHtml(formatDate(goal.target_date))}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

export function renderMonitoringResults(results = []) {
  if (!results.length) return '<p class="empty">目標別のモニタリング結果はまだ登録されていません。</p>';
  return `
    <table class="record-table">
      <thead><tr><th>対象目標</th><th>進捗</th><th>経過と根拠</th><th>課題</th><th>次期の方針</th></tr></thead>
      <tbody>${results.map((result) => `
        <tr>
          <td>${escapeHtml(result.goal_title || result.goal_id)}</td>
          <td>${escapeHtml(formatValue(result.progress_status))}</td>
          <td>${escapeHtml(formatValue(result.progress_summary))}</td>
          <td>${escapeHtml(formatValue(result.current_challenge))}</td>
          <td>${escapeHtml(formatValue(result.next_support_policy))}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

function minuteLabel(value) {
  const minutes = Number(value);
  const dayOffset = Math.floor(minutes / 1440);
  const withinDay = minutes % 1440;
  const label = `${String(Math.floor(withinDay / 60)).padStart(2, "0")}:${String(withinDay % 60).padStart(2, "0")}`;
  return dayOffset ? `翌日 ${label}` : label;
}

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export function renderSchedules(schedules = []) {
  if (!schedules.length) return '<p class="empty">週間予定はまだ登録されていません。</p>';
  return schedules.map((schedule) => `
    <div class="schedule-block">
      <h3>${schedule.schedule_kind === "planned" ? "予定する生活" : "現在の生活"}（第${Number(schedule.version_number)}版）</h3>
      <p>${escapeHtml(formatValue(schedule.summary))}</p>
      <table class="record-table compact-table">
        <thead><tr><th>曜日</th><th>時間</th><th>活動</th><th>場所・サービス</th></tr></thead>
        <tbody>${(schedule.items || []).map((item) => `
          <tr><td>${DAY_LABELS[item.day_of_week]}</td><td>${minuteLabel(item.start_minute)}〜${minuteLabel(item.end_minute)}</td><td>${escapeHtml(item.activity)}</td><td>${escapeHtml(formatValue([item.location, item.service_kind].filter(Boolean)))}</td></tr>`).join("")}</tbody>
      </table>
    </div>`).join("");
}

function commonCss(orientation) {
  return `
    @page { size: A4 ${orientation}; margin: 15mm 13mm 14mm; }
    * { box-sizing: border-box; }
    html { color: #172c31; background: #fff; font-family: "IPAGothic", "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif; }
    body { margin: 0; font-size: 10.5pt; line-height: 1.65; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .running-header { position: fixed; top: -12mm; left: 0; right: 0; display: flex; justify-content: space-between; border-bottom: .35mm solid #173d42; padding-bottom: 1.5mm; font-size: 7.5pt; color: #4b6265; }
    .running-footer { position: fixed; bottom: -10mm; left: 0; right: 0; display: flex; justify-content: space-between; border-top: .2mm solid #9eaaa8; padding-top: 1.5mm; font-size: 7pt; color: #667779; }
    .page-number::after { content: counter(page); }
    .document-heading { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 8mm; border-bottom: .8mm solid #173d42; padding: 1mm 0 3.5mm; margin-bottom: 4mm; }
    .eyebrow { color: #a85d3b; font-size: 8.5pt; font-weight: 700; letter-spacing: .1em; }
    h1 { font-size: 22pt; line-height: 1.2; margin: 1mm 0 0; font-family: "Noto Serif CJK JP", "Yu Mincho", serif; }
    .document-heading--plain { display: block; padding-top: 1.5mm; }
    .document-heading--plain h1 { margin: 0; font-family: "IPAGothic", "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif; font-size: 19pt; font-weight: 700; letter-spacing: .025em; }
    .document-heading-status { margin: 1.2mm 0 0; color: #52686b; font-size: 8.5pt; font-weight: 700; }
    h2 { margin: 0; padding: 2mm 3mm; background: #e7eeea; border-left: 1.2mm solid #a85d3b; font-size: 12pt; }
    h3 { margin: 2.5mm 0 1.5mm; font-size: 10.5pt; }
    .status-box { min-width: 42mm; border: .35mm solid #173d42; padding: 2mm 3mm; text-align: right; }
    .status-box strong { display: block; font-size: 11.5pt; }
    .identity-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: .3mm solid #697b7d; margin-bottom: 3mm; }
    .identity-grid div { min-height: 15mm; padding: 2mm 2.5mm; border-right: .2mm solid #aeb9b7; border-bottom: .2mm solid #aeb9b7; }
    .identity-grid div:nth-child(even) { border-right: 0; }
    .identity-grid div:nth-last-child(-n + 2) { border-bottom: 0; }
    .identity-grid span { display: block; font-size: 8pt; color: #52686b; font-weight: 700; }
    .identity-grid strong { display: block; margin-top: .8mm; font-size: 10.5pt; overflow-wrap: anywhere; }
    .certificate-grid { margin-top: -1mm; }
    .document-section { margin: 0 0 4mm; }
    .document-section h2 { position: relative; z-index: 1; display: block; line-height: 1.35; break-after: avoid-page; }
    .field-table { width: 100%; border: .3mm solid #aab5b3; border-collapse: collapse; table-layout: fixed; }
    .field-table tr { break-inside: avoid; }
    .field-table th, .field-table td { border: .2mm solid #c5cecc; padding: 2.2mm; vertical-align: top; overflow-wrap: anywhere; }
    .field-table .field-table-title { padding: 0; border: 0; background: #e7eeea; }
    .field-table .field-table-title h2 { margin: 0; padding: 2mm 3mm; border-left: 1.2mm solid #a85d3b; text-align: left; }
    .field-table th { width: 12%; background: #f2f4f0; font-size: 9pt; font-weight: 700; text-align: left; }
    .field-table td { width: 38%; }
    .record-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .record-table th, .record-table td { border: .25mm solid #7f8c8a; padding: 1.5mm; vertical-align: top; overflow-wrap: anywhere; }
    .record-table th { background: #e7eeea; font-size: 8pt; }
    .goal-table th:nth-child(1) { width: 14mm; } .goal-table th:nth-child(5) { width: 22mm; }
    .compact-table { font-size: 8pt; }
    .subtle, .empty { color: #647476; font-size: 8pt; }
    .schedule-block { margin: 0 2mm 3mm; break-inside: avoid; }
    .page-break-before { break-before: page; }
    .official-mark { color: #315e4c; }
  `;
}

export function buildDocumentHtml({ source, snapshotKind, title, subtitle, orientation, bodyHtml, plainHeading = false }) {
  const document = source.document;
  const child = source.child;
  const guardian = source.guardian;
  const isDraft = snapshotKind === "draft";
  const usePlainHeading = plainHeading || document.document_kind === "basic_assessment";
  const variantLabel = snapshotKind === "corrected" ? "訂正版" : "正式版";
  const plainStatus = !isDraft && document.document_kind !== "basic_assessment"
    ? `<p class="document-heading-status">${escapeHtml(variantLabel)} / ${escapeHtml(STATUS_LABELS[document.status] || document.status)}</p>`
    : "";
  const headingLabel = usePlainHeading ? title : `${title} / 第${Number(document.version_number)}版`;
  const childIdentifier = child.management_code || child.id;
  const certificateNumber = child.recipient_certificate_number
    || (child.recipient_certificate_last4 ? `••••${child.recipient_certificate_last4}` : null);
  const copaymentLimit = child.copayment_limit_yen === null || child.copayment_limit_yen === undefined
    ? "未記入"
    : `${Number(child.copayment_limit_yen).toLocaleString("ja-JP")}円`;
  const consent = source.consent || {};
  const distribution = source.distribution || {};
  // 画面から確認する編集用PDFには、まだ実施していない正式工程の欄を混在させない。
  // 正式交付の帳票だけは、将来の交付記録として必要な場合に残せる。
  const formalizationHtml = !isDraft && document.document_kind !== "basic_assessment" ? renderSection("承認・説明・同意・交付の記録", [
    ["承認者 / 承認日", `${formatValue(source.approval?.approved_by_name)} / ${formatDate(source.approval?.approved_at)}`],
    ["説明方法 / 説明日", `${formatValue(consent.explanation_method)} / ${formatDate(consent.explained_at)}`],
    ["同意者（続柄） / 同意日", `${formatValue(consent.signer_name)}（${formatValue(consent.signer_relationship)}） / ${formatDate(consent.consented_at)}`],
    ["交付先 / 方法 / 交付日", `${formatValue(distribution.recipient_name)} / ${formatValue(distribution.delivery_method)} / ${formatDate(distribution.distributed_at)}`],
  ]) : "";
  return `<!doctype html>
  <html lang="ja" data-document-kind="${escapeHtml(document.document_kind)}" data-orientation="${orientation}">
  <head><meta charset="utf-8"><title>${escapeHtml(headingLabel)}</title><style>${commonCss(orientation)}</style></head>
  <body>
    ${usePlainHeading ? "" : `<div class="running-header"><span>${escapeHtml(headingLabel)}</span><span>${escapeHtml(source.organization?.name || "")} / ${escapeHtml(source.facility?.name || "")}</span></div>
    <div class="running-footer"><span>機密情報・取扱注意</span><span>ページ <span class="page-number"></span></span></div>`}
    <main>
      <header class="document-heading${usePlainHeading ? " document-heading--plain" : ""}">
        ${usePlainHeading
          ? `<h1>${escapeHtml(title)}</h1>${plainStatus}`
          : `<div><div class="eyebrow">MICHI-NOTE / ${escapeHtml(subtitle)}</div><h1>${escapeHtml(title)}</h1></div>
        <div class="status-box">${isDraft
          ? `<strong>第${Number(document.version_number)}版</strong>`
          : `<span>${escapeHtml(variantLabel)}</span><strong class="official-mark">${escapeHtml(STATUS_LABELS[document.status] || document.status)}</strong><span>第${Number(document.version_number)}版</span>`
        }</div>`
        }
      </header>
      <section class="identity-grid" aria-label="利用児と計画の基本情報">
        <div><span>利用児氏名（識別コード）</span><strong>${escapeHtml(child.legal_name || child.display_name)}（${escapeHtml(childIdentifier)}）</strong></div>
        <div><span>生年月日 / 学年</span><strong>${escapeHtml(formatDate(child.birth_date))} / ${escapeHtml(formatValue(child.grade))}</strong></div>
        <div><span>保護者</span><strong>${escapeHtml(formatValue(guardian?.legal_name))}（${escapeHtml(formatValue(guardian?.relationship))}）</strong></div>
        <div><span>対象期間</span><strong>${escapeHtml(formatDate(document.period_start))}〜${escapeHtml(formatDate(document.period_end))}</strong></div>
      </section>
      <section class="identity-grid certificate-grid" aria-label="受給者証と支給決定の情報">
        <div><span>支給決定自治体</span><strong>${escapeHtml(formatValue(child.municipality_name))}</strong></div>
        <div><span>受給者証番号</span><strong>${escapeHtml(formatValue(certificateNumber))}</strong></div>
        <div><span>利用者負担上限月額</span><strong>${escapeHtml(copaymentLimit)}</strong></div>
        <div><span>受給者証有効期間</span><strong>${escapeHtml(formatDate(child.certificate_valid_from))}〜${escapeHtml(formatDate(child.certificate_valid_to))}</strong></div>
      </section>
      ${bodyHtml}
      ${formalizationHtml}
    </main>
  </body></html>`;
}
