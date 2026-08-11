import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:4173";
const STORAGE_KEY = "michi-note-demo-v1";
const ARTIFACTS_DIR = "test-results";
mkdirSync(ARTIFACTS_DIR, { recursive: true });

function artifactPath(filename) {
  return join(ARTIFACTS_DIR, filename);
}

function pdfPageCount(pdfPath) {
  const source = readFileSync(pdfPath).toString("latin1");
  const pages = source.match(/\/Type\s*\/Page\b/g) ?? [];
  assert.ok(pages.length > 0, "PDF内のページオブジェクトを確認できません");
  return pages.length;
}

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire("playwright");
  } catch {
    throw new Error(
      "Playwright が見つかりません。`npm install` の後に `npx playwright install chromium` を実行してください。"
    );
  }
}

async function assertVisible(locator, message) {
  await locator.waitFor({ state: "visible" });
  assert.equal(await locator.isVisible(), true, message);
}

async function assertMinimumVisibleTextSize(page, selector, minimumPx = 12) {
  const tooSmall = await page.locator(selector).evaluateAll((roots, minimum) => roots.flatMap((root) =>
    [...root.querySelectorAll("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const hasDirectText = [...element.childNodes]
          .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        return hasDirectText
          && style.display !== "none"
          && style.visibility !== "hidden"
          && element.getClientRects().length > 0
          && Number.parseFloat(style.fontSize) < minimum;
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className || "-"}:${getComputedStyle(element).fontSize}:${element.textContent.trim().slice(0, 40)}`)
  ), minimumPx);
  assert.deepEqual(tooSmall, [], `${selector} に${minimumPx}px未満の可読テキストがあります: ${tooSmall.join(" / ")}`);
}

const { chromium } = loadPlaywright();
const requestedExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (requestedExecutable && !existsSync(requestedExecutable)) {
  throw new Error(`指定された Chromium 実行ファイルが見つかりません: ${requestedExecutable}`);
}
const browser = await chromium.launch({
  headless: true,
  ...(requestedExecutable ? { executablePath: requestedExecutable } : {})
});
const consoleErrors = [];
const pageErrors = [];

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "ja-JP",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(APP_URL, { waitUntil: "networkidle" });
  const privateSampleResponse = await page.request.get(`${APP_URL}/80530519-AF79-4FD5-9522-ACE4374768C1.jpg`);
  assert.equal(privateSampleResponse.status(), 404, "参考JPGがデモサーバーから取得できてしまいます");
  assert.match(await page.title(), /みちのーと/);
  assert.equal((await page.locator("#hero-entry-count").textContent())?.trim(), "24");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    true,
    "デスクトップ表示で横スクロールが発生しています"
  );

  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains("skip-link")),
    true,
    "スキップリンクが最初のキーボード操作対象ではありません"
  );
  await page.keyboard.press("Tab");
  await page.screenshot({ path: artifactPath("michi-dashboard.png"), fullPage: true });

  await page.locator('.main-nav [data-view-target="plan"]').click();
  await assertVisible(page.locator("#plan-editor"), "初期デモの計画編集画面が表示されません");
  assert.equal(await page.locator("#print-plan").isDisabled(), false, "初期デモ計画を印刷できません");
  assert.equal((await page.evaluate(() => window.michiNote.getState().plan?.sourceCount)), 24);
  await page.locator('[data-plan-mode="preview"]').click();
  await assertVisible(page.locator("#plan-preview-notice"), "帳票プレビューの案内が表示されません");
  assert.equal(await page.locator("#plan-editor").isVisible(), false, "帳票プレビューで編集画面が閉じません");
  assert.equal(await page.locator(".plan-audit").isVisible(), false, "帳票プレビューで記載チェックが残っています");
  assert.equal(await page.locator(".plan-layout").evaluate((element) => element.classList.contains("is-preview")), true, "帳票プレビュー用のレイアウトになりません");
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /個別支援計画書　概要/, "初期デモの1ページ概要がありません");
  assert.match((await page.locator("#plan-detail-preview").textContent()) ?? "", /根拠：J-\d+/, "初期デモ詳細版に根拠日誌IDがありません");
  await page.emulateMedia({ media: "print" });
  const demoPdfPath = artifactPath("michi-plan-demo.pdf");
  await page.pdf({
    path: demoPdfPath,
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    tagged: true
  });
  assert.ok(readFileSync(demoPdfPath).byteLength > 10_000, "初期デモPDFが空、または必要な内容を持っていません");
  assert.equal(pdfPageCount(demoPdfPath), 1, "1ページ概要PDFが1枚に収まっていません");
  await page.emulateMedia({ media: "screen" });

  await page.locator('.main-nav [data-view-target="journals"]').click();
  await assertVisible(page.locator('#view-journals'), "日誌画面が表示されません");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "journals-heading", "画面遷移後に見出しへフォーカスされません");
  assert.equal((await page.locator("#journal-result-count").textContent())?.trim(), "24件");

  await page.locator("#add-journal").click();
  await assertVisible(page.locator("#journal-dialog"), "日誌追加ダイアログが開きません");
  assert.equal(await page.locator('select[name="groupParticipation"]').inputValue(), "", "新規日誌の指標が勝手に評価済みになっています");
  await page.locator("#journal-activity").fill("   ");
  await page.locator("#journal-observation").fill("一時入力");
  await page.locator("#journal-support").fill("一時入力");
  await page.locator("#journal-response").fill("一時入力");
  await page.locator("#journal-form button[type='submit']").click();
  await assertVisible(page.locator("#journal-dialog"), "空白だけの必須項が保存されてしまいました");
  assert.equal((await page.locator("#journal-result-count").textContent())?.trim(), "24件");
  await page.locator("#journal-date").fill("2026-05-28");
  await page.locator("#journal-activity").fill("ブラウザ試験活動");
  await page.locator("#journal-physical").fill("体調良好");
  await page.locator("#journal-observation").fill("予定表を見て、始まる時刻を職員に尋ねた。");
  await page.locator("#journal-support").fill("開始までの手順を二つの絵カードで示した。");
  await page.locator("#journal-response").fill("「わかった」と言い、自分で準備を始めた。");
  await page.locator("#journal-family").fill("帰宅時に保護者へ共有した。");
  await page.locator('#journal-domain-options input[value="health"]').check();
  await page.locator('#journal-domain-options input[value="cognition"]').check();
  await page.locator('#journal-domain-options input[value="language"]').check();
  await page.locator('select[name="selfExpression"]').selectOption("3");
  await page.locator('select[name="transition"]').selectOption("3");
  await page.locator('select[name="groupParticipation"]').selectOption("2");
  await page.locator('select[name="regulation"]').selectOption("3");
  await page.locator("#journal-form button[type='submit']").click();

  await page.waitForFunction(() => document.querySelector("#journal-result-count")?.textContent?.trim() === "25件");
  assert.equal((await page.locator("#nav-journal-count").textContent())?.trim(), "25");
  assert.equal(await page.locator("#journal-detail").getByText("ブラウザ試験活動").count(), 1);
  await page.waitForFunction(
    ({ storageKey }) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").journals?.length === 25,
    { storageKey: STORAGE_KEY }
  );

  await page.reload({ waitUntil: "networkidle" });
  assert.equal((await page.locator("#journal-result-count").textContent())?.trim(), "25件", "追加日誌が再読込後に復元されません");
  const reloadedState = await page.evaluate(() => window.michiNote.getState());
  const reloadedAddedJournal = reloadedState.journals.find((journal) => journal.activity === "ブラウザ試験活動");
  assert.equal(reloadedState.journals.length, 25);
  assert.equal(reloadedAddedJournal.time, "15:30〜17:30");
  assert.equal(reloadedAddedJournal.staff, "デモ入力");

  await page.locator('.main-nav [data-view-target="analysis"]').click();
  await assertVisible(page.locator("#view-analysis"), "分析画面が表示されません");
  assert.equal(await page.locator("#analysis-range-start").inputValue(), "2026-04-06");
  assert.equal(await page.locator("#analysis-range-end").inputValue(), "2026-05-29");
  assert.match((await page.locator("#analysis-range-status").textContent()) ?? "", /25件/);
  await page.locator("#analysis-range-start").fill("2025-01-01");
  await page.locator("#apply-analysis-range").click();
  await assertVisible(page.locator("#toast"), "92日を超える分析期間のエラーが表示されません");
  assert.equal((await page.evaluate(() => window.michiNote.getState().analysisRange.start)), "2026-04-06");
  await page.locator("#analysis-range-start").fill("2026-04-06");
  assert.equal(await page.locator(".domain-analysis-row").count(), 5, "5領域すべてが表示されていません");
  assert.equal(await page.locator(".indicator-row").count(), 4, "4つの観察指標が表示されていません");
  assert.equal(await page.locator("[data-edit-pattern-plan]").count(), 4, "確認できたヒントを計画書へ反映する導線が表示されていません");
  await page.screenshot({ path: artifactPath("michi-analysis.png"), fullPage: true });
  await page.locator('[data-edit-pattern-plan="expression"]').click();
  await assertVisible(page.locator("#plan-editor"), "日誌更新後は計画書の再作成を促す画面が表示されません");
  assert.equal(await page.locator("#print-plan").isDisabled(), true, "日誌更新後の古い計画案を印刷できてしまいます");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#regenerate-plan").click();
  await page.waitForFunction(() => window.michiNote.getState().plan?.sourceCount === 25 && window.michiNote.getState().planStale === false);
  await page.locator('.main-nav [data-view-target="analysis"]').click();
  await page.locator('[data-edit-pattern-plan="expression"]').click();
  await assertVisible(page.locator("#pattern-plan-dialog"), "ヒントを編集するダイアログが表示されません");
  await page.screenshot({ path: artifactPath("michi-hint-editor.png"), fullPage: true });
  const reflectedTitle = "日誌のヒントを反映した本人支援";
  const reflectedSupport = "予定を本人と確認し、必要な時はカードで次の行動を選べるようにする。";
  await page.locator("#pattern-plan-title").fill(reflectedTitle);
  await page.locator("#pattern-plan-support").fill(reflectedSupport);
  await page.locator("#pattern-plan-form button[type='submit']").click();
  await assertVisible(page.locator("#plan-editor"), "反映後に計画書編集画面が表示されません");
  assert.equal(await page.locator('[data-plan-path="supportItems.0.title"]').inputValue(), reflectedTitle, "編集した項目名が計画書に反映されません");
  assert.equal(await page.locator('[data-plan-path="supportItems.0.support"]').inputValue(), reflectedSupport, "編集した支援内容が計画書に反映されません");

  await page.locator('.main-nav [data-view-target="plan"]').click();
  await assertVisible(page.locator("#plan-editor"), "計画編集画面が表示されません");
  assert.equal(await page.locator("#print-plan").isDisabled(), false, "再作成して反映した計画案を印刷できません");
  assert.equal(await page.locator("#support-goal-list fieldset.support-domain-fieldset").count(), 4);
  assert.equal(await page.locator("#support-goal-list label label").count(), 0, "labelが入れ子になっています");
  const accessibilityIssues = await page.evaluate(() => {
    const unlabeledFields = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter((element) => !element.labels?.length && !element.getAttribute("aria-label") && !element.getAttribute("aria-labelledby"))
      .map((element) => element.outerHTML.slice(0, 120));
    const unnamedButtons = [...document.querySelectorAll("button")]
      .filter((button) => !button.textContent.trim() && !button.getAttribute("aria-label") && !button.getAttribute("aria-labelledby"))
      .map((button) => button.outerHTML.slice(0, 120));
    const tooSmallText = [...document.querySelectorAll("body *")]
      .filter((element) => element.children.length === 0 && element.textContent.trim() && element.getClientRects().length)
      .filter((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 12)
      .map((element) => `${element.tagName}.${element.className}:${getComputedStyle(element).fontSize}`)
      .slice(0, 10);
    return { unlabeledFields, unnamedButtons, tooSmallText };
  });
  assert.deepEqual(accessibilityIssues, { unlabeledFields: [], unnamedButtons: [], tooSmallText: [] });
  const firstEvidencePicker = page.locator(".evidence-picker").first();
  await firstEvidencePicker.locator("summary").click();
  const uncheckedEvidence = firstEvidencePicker.locator('input[data-support-evidence]:not(:checked)').first();
  const addedEvidenceId = await uncheckedEvidence.getAttribute("value");
  assert.ok(addedEvidenceId, "追加できる根拠日誌が見つかりません");
  await uncheckedEvidence.check();
  await page.waitForFunction(
    ({ storageKey, evidenceId }) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").plan?.supportItems?.[0]?.evidenceIds?.includes(evidenceId),
    { storageKey: STORAGE_KEY, evidenceId: addedEvidenceId }
  );
  const editedGoal = "見通しを確認し、必要な時に自分から援助を求める（ブラウザ試験）。";
  await page.locator('[data-plan-path="shortTermGoal"]').fill(editedGoal);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-plan-path="shortTermGoal"]').inputValue(), editedGoal, "保存待機中の計画編集が再読込時に確定されません");
  await page.locator('[data-plan-boolean="communitySupport.notApplicable"]').check();
  await page.locator('[data-plan-path="communitySupport.reason"]').fill("関係機関の利用なしを本人・保護者に確認");
  await page.waitForFunction(
    ({ storageKey }) => {
      const community = JSON.parse(localStorage.getItem(storageKey) ?? "{}").plan?.communitySupport;
      return community?.notApplicable === true && community?.reason?.includes("利用なし");
    },
    { storageKey: STORAGE_KEY }
  );

  await page.locator('[data-plan-mode="preview"]').click();
  assert.equal(await page.locator('[data-plan-mode="preview"]').getAttribute("aria-pressed"), "true");
  await assertVisible(page.locator("#plan-preview"), "帳票プレビューが表示されません");
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /個別支援計画書　概要/);
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /地域連携[\s\S]*該当なし/);
  assert.match((await page.locator("#plan-detail-preview").textContent()) ?? "", /根拠：J-\d+/, "詳細版PDFに目標別の根拠日誌IDがありません");
  await page.emulateMedia({ media: "print" });
  assert.equal(
    await page.locator("#plan-preview").evaluate((element) => getComputedStyle(element).display),
    "block",
    "印刷メディアで帳票が表示されません"
  );
  const pdfPath = artifactPath("michi-plan.pdf");
  await page.pdf({
    path: pdfPath,
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    tagged: true
  });
  assert.ok(readFileSync(pdfPath).byteLength > 10_000, "印刷PDFが空、または必要な内容を持っていません");
  assert.equal(pdfPageCount(pdfPath), 1, "1ページ概要PDFが1枚に収まっていません");
  await page.evaluate(() => document.body.classList.add("print-detail-plan"));
  const detailPdfPath = artifactPath("michi-plan-detail.pdf");
  await page.pdf({
    path: detailPdfPath,
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    tagged: true
  });
  assert.ok(readFileSync(detailPdfPath).byteLength > 10_000, "詳細版PDFが空、または必要な内容を持っていません");
  assert.ok(pdfPageCount(detailPdfPath) > 1, "詳細版PDFが複数ページで出力されません");
  await page.evaluate(() => document.body.classList.remove("print-detail-plan"));
  await page.emulateMedia({ media: "screen" });
  await page.screenshot({ path: artifactPath("michi-plan.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.main-nav [data-view-target="dashboard"]').click();
  await assertVisible(page.locator("#view-dashboard .hero-panel"), "モバイルでダッシュボードが表示されません");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    true,
    "モバイル表示で横スクロールが発生しています"
  );
  await page.screenshot({ path: artifactPath("michi-mobile.png"), fullPage: true });
  await context.close();

  const emptyContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", reducedMotion: "reduce" });
  const emptyPage = await emptyContext.newPage();
  await emptyPage.goto(APP_URL, { waitUntil: "networkidle" });
  await emptyPage.evaluate((storageKey) => {
    const state = window.michiNote.getState();
    state.journals = state.journals.map((journal) => ({
      ...journal,
      indicators: { selfExpression: null, transition: null, groupParticipation: null, regulation: null }
    }));
    state.activeView = "dashboard";
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, STORAGE_KEY);
  await emptyPage.reload({ waitUntil: "networkidle" });
  const unratedMetric = (await emptyPage.locator("#dashboard-metrics .metric-card").nth(3).textContent()) ?? "";
  assert.match(unratedMetric, /未評価/, "全指標未評価が+0.0と表示されます");
  assert.doesNotMatch(unratedMetric, /\+0\.0/);
  await emptyPage.evaluate((storageKey) => {
    const state = window.michiNote.getState();
    state.journals = [];
    state.selectedJournalId = "";
    state.activeView = "journals";
    state.filters = { search: "", domain: "all", month: "all" };
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, STORAGE_KEY);
  await emptyPage.reload({ waitUntil: "networkidle" });
  assert.equal((await emptyPage.locator("#journal-result-count").textContent())?.trim(), "0件");
  await assertVisible(emptyPage.getByText("条件に一致する日誌がありません"), "日誌0件の空状態が表示されません");
  await emptyPage.locator('.main-nav [data-view-target="analysis"]').click();
  await assertVisible(emptyPage.getByText("分析できる日誌がありません"), "分析0件の空状態が表示されません");
  await emptyContext.close();

  const corruptContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", reducedMotion: "reduce" });
  const corruptPage = await corruptContext.newPage();
  const corruptErrors = [];
  corruptPage.on("pageerror", (error) => corruptErrors.push(error.message));
  await corruptPage.goto(APP_URL, { waitUntil: "networkidle" });
  await corruptPage.evaluate((storageKey) => {
    const state = window.michiNote.getState();
    state.profile.displayName = { invalid: true };
    state.filters.search = { invalid: true };
    state.journals[0].date = "2026-02-30";
    state.journals[0].indicators.groupParticipation = 999;
    state.plan = { broken: true };
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, STORAGE_KEY);
  await corruptPage.reload({ waitUntil: "domcontentloaded" });
  await corruptPage.waitForFunction(() => Boolean(window.michiNote));
  const repairedState = await corruptPage.evaluate(() => window.michiNote.getState());
  assert.equal(repairedState.profile.displayName, "Aさん");
  assert.equal(repairedState.filters.search, "");
  assert.equal(repairedState.journals.some((journal) => journal.date === "2026-02-30"), false);
  assert.equal(repairedState.journals.length, 23);
  assert.equal(repairedState.plan.supportItems.length, 4);
  assert.deepEqual(corruptErrors, [], `破損保存データ復旧時のページ例外: ${corruptErrors.join(" / ")}`);
  await corruptContext.close();

  const xssContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", reducedMotion: "reduce" });
  const xssPage = await xssContext.newPage();
  await xssPage.goto(APP_URL, { waitUntil: "networkidle" });
  const storedPayload = '<img src=x onerror="window.__storedXss=1">';
  await xssPage.evaluate(({ storageKey, payload }) => {
    const state = window.michiNote.getState();
    state.plan.version = payload;
    state.plan.supportItems[0].priority = payload;
    state.activeView = "plan";
    state.planMode = "preview";
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, { storageKey: STORAGE_KEY, payload: storedPayload });
  await xssPage.reload({ waitUntil: "domcontentloaded" });
  await xssPage.waitForFunction(() => Boolean(window.michiNote));
  await xssPage.locator("#plan-preview").waitFor({ state: "visible" });
  assert.equal(await xssPage.locator("#plan-editor img, #plan-preview img").count(), 0, "保存値からHTML要素が生成されています");
  assert.equal(await xssPage.evaluate(() => window.__storedXss), undefined, "保存値からスクリプトが実行されています");
  assert.match((await xssPage.locator("#plan-preview").textContent()) ?? "", /<img src=x/, "危険な保存値が安全な文字列として表示されません");
  await xssContext.close();

  const legacyContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", reducedMotion: "reduce" });
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(APP_URL, { waitUntil: "networkidle" });
  await legacyPage.evaluate((storageKey) => {
    const state = window.michiNote.getState();
    delete state.workflowVersion;
    state.journals = state.journals.map((journal) => {
      const legacyJournal = { ...journal };
      delete legacyJournal.recordStatus;
      delete legacyJournal.familyShareStatus;
      delete legacyJournal.staffDraft;
      delete legacyJournal.familyDraft;
      return legacyJournal;
    });
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, STORAGE_KEY);
  await legacyPage.reload({ waitUntil: "networkidle" });
  const migratedBundledState = await legacyPage.evaluate(() => window.michiNote.getState());
  const migratedMay29 = migratedBundledState.journals.find((journal) => journal.date === "2026-05-29");
  const migratedMay27 = migratedBundledState.journals.find((journal) => journal.date === "2026-05-27");
  assert.equal(migratedBundledState.workflowVersion, 1, "旧デモデータにワークフロー版が付与されません");
  assert.deepEqual(
    { recordStatus: migratedMay29?.recordStatus, familyShareStatus: migratedMay29?.familyShareStatus },
    { recordStatus: "review", familyShareStatus: "private" },
    "旧デモの5月29日が確認待ちとして移行されません"
  );
  assert.deepEqual(
    { recordStatus: migratedMay27?.recordStatus, familyShareStatus: migratedMay27?.familyShareStatus },
    { recordStatus: "confirmed", familyShareStatus: "ready" },
    "旧デモの5月27日が共有準備済みとして移行されません"
  );

  await legacyPage.evaluate((storageKey) => {
    const state = window.michiNote.getState();
    delete state.workflowVersion;
    state.journals = state.journals.map((journal, index) => {
      const legacyJournal = { ...journal };
      delete legacyJournal.recordStatus;
      delete legacyJournal.familyShareStatus;
      delete legacyJournal.staffDraft;
      delete legacyJournal.familyDraft;
      if (index === 0) legacyJournal.observation = `${legacyJournal.observation}旧環境で追記。`;
      return legacyJournal;
    });
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, STORAGE_KEY);
  await legacyPage.reload({ waitUntil: "networkidle" });
  const migratedCustomState = await legacyPage.evaluate(() => window.michiNote.getState());
  assert.equal(migratedCustomState.journals[0].observation.endsWith("旧環境で追記。"), true, "旧環境で編集した日誌内容が保持されません");
  assert.equal(migratedCustomState.journals.every((journal) => journal.recordStatus === "confirmed"), true, "編集済み旧データが安全な職員確認済み状態へ移行されません");
  assert.equal(migratedCustomState.journals.every((journal) => journal.familyShareStatus === "private"), true, "編集済み旧データが勝手に共有可能な状態へ移行されています");
  await legacyContext.close();

  const workflowContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    reducedMotion: "reduce"
  });
  const workflowPage = await workflowContext.newPage();
  const workflowConsoleErrors = [];
  const workflowPageErrors = [];
  workflowPage.on("console", (message) => {
    if (message.type() === "error") workflowConsoleErrors.push(message.text());
  });
  workflowPage.on("pageerror", (error) => workflowPageErrors.push(error.message));

  await workflowPage.goto(APP_URL, { waitUntil: "networkidle" });
  const workflowModuleResponse = await workflowPage.request.get(`${APP_URL}/src/record-workflow.js`);
  assert.equal(workflowModuleResponse.status(), 200, "記録ワークフローのモジュールを取得できません");

  const initialWorkflowState = await workflowPage.evaluate(() => window.michiNote.getState());
  const initialMay29 = initialWorkflowState.journals.find((journal) => journal.date === "2026-05-29");
  const initialMay27 = initialWorkflowState.journals.find((journal) => journal.date === "2026-05-27");
  assert.equal(initialWorkflowState.journals.length, 24, "ワークフローテストの初期日誌数が24件ではありません");
  assert.deepEqual(
    { recordStatus: initialMay29?.recordStatus, familyShareStatus: initialMay29?.familyShareStatus },
    { recordStatus: "review", familyShareStatus: "private" },
    "5月29日の初期確認・共有状態が想定と異なります"
  );
  assert.deepEqual(
    { recordStatus: initialMay27?.recordStatus, familyShareStatus: initialMay27?.familyShareStatus },
    { recordStatus: "confirmed", familyShareStatus: "ready" },
    "5月27日の初期共有準備状態が想定と異なります"
  );
  assert.equal((await workflowPage.locator("#nav-journal-count").textContent())?.trim(), "24");

  for (const [view, headingId] of [
    ["compose", "compose-heading"],
    ["family", "family-heading"],
    ["dashboard", "dashboard-heading"]
  ]) {
    await workflowPage.locator(`.main-nav [data-view-target="${view}"]`).click();
    await assertVisible(workflowPage.locator(`#view-${view}`), `${view}画面が表示されません`);
    assert.equal(
      await workflowPage.evaluate(() => document.activeElement?.id),
      headingId,
      `${view}画面への遷移後に見出しへフォーカスされません`
    );
    await assertMinimumVisibleTextSize(
      workflowPage,
      view === "dashboard" ? "#view-dashboard .today-board" : `#view-${view}`
    );
  }

  await workflowPage.locator('.main-nav [data-view-target="family"]').click();
  assert.equal(
    await workflowPage.locator("#family-share-list [data-family-select]").count(),
    23,
    "共有準備・デモ共有済みの履歴をすべて選択できません"
  );

  await workflowPage.locator('.main-nav [data-view-target="compose"]').click();
  await workflowPage.locator("#compose-journal-select").selectOption("");
  await workflowPage.waitForFunction(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").composeJournalId === "",
    STORAGE_KEY
  );

  await workflowPage.locator("#compose-activity").fill("破棄確認用の一時入力");
  let discardDialogMessage = "";
  workflowPage.once("dialog", async (dialog) => {
    discardDialogMessage = dialog.message();
    await dialog.dismiss();
  });
  await workflowPage.locator('.main-nav [data-view-target="family"]').click();
  assert.match(discardDialogMessage, /未保存/, "画面移動前に未保存確認が表示されません");
  await assertVisible(workflowPage.locator("#view-compose"), "未保存確認をキャンセルしても入力画面に留まりません");
  assert.equal(await workflowPage.locator("#compose-activity").inputValue(), "破棄確認用の一時入力", "未保存確認のキャンセルで入力が失われました");

  const internalSupport = "内部限定メモ：机の位置を調整し、職員が手順を個別提示した。";
  await workflowPage.locator("#compose-date").fill("2026-05-28");
  await workflowPage.locator("#compose-activity").fill("E2E共有フロー活動");
  await workflowPage.locator("#compose-staff").fill("田中（E2E）");
  await workflowPage.locator("#compose-observation").fill("絵カードを見て、「先に宿題」と自分で選んだ。");
  await workflowPage.locator("#compose-support").fill(internalSupport);
  await workflowPage.locator("#compose-response").fill("宿題を終えた後、友達をボードゲームに誘った。");
  await workflowPage.locator('#compose-domain-options input[value="cognition"]').check();
  await workflowPage.locator("#save-record-draft").click();
  assert.equal(
    await workflowPage.evaluate(() => window.michiNote.getState().journals.length),
    24,
    "必須の利用時刻がない記録を保存できてしまいます"
  );
  assert.equal(await workflowPage.evaluate(() => document.activeElement?.id), "compose-start-time", "未入力の利用開始へフォーカスされません");
  await workflowPage.locator("#compose-start-time").fill("15:30");
  await workflowPage.locator("#compose-end-time").fill("17:30");

  const stateBeforeDraftGeneration = await workflowPage.evaluate(() => window.michiNote.getState());
  const storageBeforeDraftGeneration = await workflowPage.evaluate((storageKey) => localStorage.getItem(storageKey), STORAGE_KEY);
  await workflowPage.locator("#generate-record-drafts").click();
  const stateAfterDraftGeneration = await workflowPage.evaluate(() => window.michiNote.getState());
  const storageAfterDraftGeneration = await workflowPage.evaluate((storageKey) => localStorage.getItem(storageKey), STORAGE_KEY);
  assert.equal(stateAfterDraftGeneration.journals.length, stateBeforeDraftGeneration.journals.length, "下書き生成だけで日誌件数が変わっています");
  assert.equal(stateAfterDraftGeneration.planStale, stateBeforeDraftGeneration.planStale, "下書き生成だけで計画の鮮度が変わっています");
  assert.equal(storageAfterDraftGeneration, storageBeforeDraftGeneration, "下書き生成だけでlocalStorageが更新されています");
  assert.match(await workflowPage.locator("#compose-staff-draft").inputValue(), /内部限定メモ/, "職員記録に明記済みの支援内容が含まれません");
  assert.doesNotMatch(
    await workflowPage.locator("#compose-family-draft").inputValue(),
    /内部限定メモ|interna?l/i,
    "保護者向け下書きに内部の支援メモが混入しています"
  );

  const familyXssPayload = '<img src=x onerror="window.__familyWorkflowXss=1">今日は自分で活動を選びました。';
  await workflowPage.locator("#compose-family-draft").fill(familyXssPayload);
  await workflowPage.locator("#save-record-draft").click();
  await workflowPage.reload({ waitUntil: "networkidle" });
  const savedWorkflowJournal = await workflowPage.evaluate(() =>
    window.michiNote.getState().journals.find((journal) => journal.activity === "E2E共有フロー活動")
  );
  assert.ok(savedWorkflowJournal, "保存直後の再読込で新規記録が失われました");
  const workflowJournalId = savedWorkflowJournal.id;
  assert.equal((await workflowPage.evaluate(() => window.michiNote.getState().journals.length)), 25, "記録保存後の日誌数が25件ではありません");
  assert.deepEqual(
    { recordStatus: savedWorkflowJournal.recordStatus, familyShareStatus: savedWorkflowJournal.familyShareStatus },
    { recordStatus: "review", familyShareStatus: "private" },
    "新規保存した記録が「職員確認待ち・非共有」になりません"
  );
  assert.equal(
    await workflowPage.locator(`#family-share-list [data-family-select="${workflowJournalId}"]`).count(),
    0,
    "非共有の記録が保護者画面の共有候補に表示されています"
  );

  assert.equal(await workflowPage.locator("#compose-journal-id").inputValue(), workflowJournalId, "職員確認の対象日誌が保持されていません");
  assert.equal(await workflowPage.locator("#confirm-staff-record").isDisabled(), false, "職員確認ボタンが有効になりません");
  await workflowPage.locator("#confirm-staff-record").click();
  const confirmResult = await workflowPage.evaluate((id) => ({
    journal: window.michiNote.getState().journals.find((journal) => journal.id === id),
    activeElementId: document.activeElement?.id,
    toast: document.querySelector("#toast")?.textContent,
    note: document.querySelector("#compose-action-note")?.textContent
  }), workflowJournalId);
  const confirmedWorkflowJournal = confirmResult.journal;
  assert.equal(
    confirmedWorkflowJournal.recordStatus,
    "confirmed",
    `職員確認操作後も確認済みになりません: ${JSON.stringify(confirmResult)}`
  );
  assert.equal(confirmedWorkflowJournal.familyShareStatus, "private", "職員確認だけで保護者共有状態が変わっています");
  await workflowPage.reload({ waitUntil: "networkidle" });
  const reloadedConfirmedJournal = await workflowPage.evaluate((id) =>
    window.michiNote.getState().journals.find((journal) => journal.id === id), workflowJournalId
  );
  assert.deepEqual(
    { recordStatus: reloadedConfirmedJournal.recordStatus, familyShareStatus: reloadedConfirmedJournal.familyShareStatus },
    { recordStatus: "confirmed", familyShareStatus: "private" },
    "再読込後に職員確認状態が復元されません"
  );

  await workflowPage.locator("#prepare-family-share").click();
  await workflowPage.waitForFunction(
    (id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.familyShareStatus === "ready",
    workflowJournalId
  );
  await workflowPage.reload({ waitUntil: "networkidle" });
  assert.equal(
    await workflowPage.evaluate((id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.familyShareStatus, workflowJournalId),
    "ready",
    "再読込後に共有準備状態が復元されません"
  );
  await workflowPage.locator('.main-nav [data-view-target="family"]').click();
  await assertVisible(
    workflowPage.locator(`#family-share-list [data-family-select="${workflowJournalId}"]`),
    "共有準備済みの記録が共有候補に表示されません"
  );
  assert.match((await workflowPage.locator("#family-preview").textContent()) ?? "", /職員用・共有前プレビュー/, "共有前の明示がプレビューにありません");
  assert.equal(await workflowPage.locator("#family-preview img").count(), 0, "保護者向け文からHTML要素が生成されています");
  assert.equal(await workflowPage.evaluate(() => window.__familyWorkflowXss), undefined, "保護者向け文からスクリプトが実行されました");
  assert.match((await workflowPage.locator("#family-preview").textContent()) ?? "", /<img src=x/, "危険な入力値が安全な文字列として表示されません");
  const familyPreviewText = (await workflowPage.locator("#family-preview").textContent()) ?? "";
  assert.equal(familyPreviewText.includes(savedWorkflowJournal.observation), false, "保護者画面に内部の観察原文が表示されています");
  assert.equal(familyPreviewText.includes(internalSupport), false, "保護者画面に内部の支援原文が表示されています");
  assert.equal(familyPreviewText.includes(savedWorkflowJournal.staffDraft), false, "保護者画面に職員記録の全文が表示されています");

  await workflowPage.locator(`#family-share-actions [data-family-share="${workflowJournalId}"]`).click();
  await workflowPage.waitForFunction(
    (id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.familyShareStatus === "shared-demo",
    workflowJournalId
  );
  await workflowPage.reload({ waitUntil: "networkidle" });
  assert.equal(
    await workflowPage.evaluate((id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.familyShareStatus, workflowJournalId),
    "shared-demo",
    "再読込後にデモ共有済み状態が復元されません"
  );
  assert.match((await workflowPage.locator("#family-preview").textContent()) ?? "", /デモ共有済み/, "明示的な共有操作後もデモ共有済みと表示されません");
  assert.equal(await workflowPage.locator("#family-preview img").count(), 0, "再読込後の保護者向け文からHTML要素が生成されています");
  assert.equal(await workflowPage.evaluate(() => window.__familyWorkflowXss), undefined, "再読込後の保護者向け文からスクリプトが実行されました");

  await workflowPage.locator(`#family-share-actions [data-family-revoke="${workflowJournalId}"]`).click();
  await workflowPage.waitForFunction(
    (id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.familyShareStatus === "private",
    workflowJournalId
  );
  await workflowPage.reload({ waitUntil: "networkidle" });
  assert.equal(
    await workflowPage.evaluate((id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.familyShareStatus, workflowJournalId),
    "private",
    "再読込後に共有取消状態が復元されません"
  );
  assert.equal(
    await workflowPage.locator(`#family-share-list [data-family-select="${workflowJournalId}"]`).count(),
    0,
    "共有取消後も記録が保護者画面の候補に残っています"
  );

  await workflowPage.setViewportSize({ width: 390, height: 844 });
  for (const view of ["compose", "family"]) {
    await workflowPage.locator(`.main-nav [data-view-target="${view}"]`).click();
    await assertVisible(workflowPage.locator(`#view-${view}`), `390px表示で${view}画面が表示されません`);
    assert.equal(
      await workflowPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      `390pxの${view}画面で横スクロールが発生しています`
    );
  }
  assert.deepEqual(workflowPageErrors, [], `記録・共有ワークフローのページ例外: ${workflowPageErrors.join(" / ")}`);
  assert.deepEqual(workflowConsoleErrors, [], `記録・共有ワークフローのコンソールエラー: ${workflowConsoleErrors.join(" / ")}`);
  await workflowContext.close();

  const draftSyncContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", reducedMotion: "reduce" });
  const draftSyncPage = await draftSyncContext.newPage();
  await draftSyncPage.goto(APP_URL, { waitUntil: "networkidle" });
  const draftSyncJournal = await draftSyncPage.evaluate(() =>
    window.michiNote.getState().journals.find((journal) => journal.date === "2026-05-27")
  );
  await draftSyncPage.locator('.main-nav [data-view-target="compose"]').click();
  await draftSyncPage.locator("#compose-journal-select").selectOption(draftSyncJournal.id);
  const previousStaffDraft = await draftSyncPage.locator("#compose-staff-draft").inputValue();
  const previousFamilyDraft = await draftSyncPage.locator("#compose-family-draft").inputValue();
  await draftSyncPage.locator("#compose-activity").fill("新しい共同ゲーム");
  await draftSyncPage.locator("#compose-response").fill("新しいルールを確認し、最後まで参加した。");
  await draftSyncPage.locator("#save-record-draft").click();
  const synchronizedJournal = await draftSyncPage.evaluate((id) =>
    window.michiNote.getState().journals.find((journal) => journal.id === id), draftSyncJournal.id
  );
  assert.deepEqual(
    { recordStatus: synchronizedJournal.recordStatus, familyShareStatus: synchronizedJournal.familyShareStatus },
    { recordStatus: "review", familyShareStatus: "private" },
    "元記録の編集後に職員確認・共有状態が安全側へ戻りません"
  );
  assert.notEqual(synchronizedJournal.staffDraft, previousStaffDraft, "元記録を変えても古い職員下書きが残っています");
  assert.notEqual(synchronizedJournal.familyDraft, previousFamilyDraft, "元記録を変えても古い保護者向け下書きが残っています");
  assert.match(synchronizedJournal.staffDraft, /新しいルール/, "職員下書きが新しい本人反応へ同期されません");
  assert.match(synchronizedJournal.familyDraft, /新しい共同ゲーム[\s\S]*新しいルール/, "保護者向け下書きが新しい活動・反応へ同期されません");

  const manualStaffDraft = "職員が確認して手動編集した記録。";
  await draftSyncPage.evaluate(({ storageKey, id, manualDraft }) => {
    const state = window.michiNote.getState();
    state.journals.find((journal) => journal.id === id).staffDraft = manualDraft;
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, { storageKey: STORAGE_KEY, id: draftSyncJournal.id, manualDraft: manualStaffDraft });
  await draftSyncPage.reload({ waitUntil: "networkidle" });
  await draftSyncPage.locator('.main-nav [data-view-target="journals"]').click();
  await draftSyncPage.locator(`#journal-list [data-journal-id="${draftSyncJournal.id}"]`).click();
  await draftSyncPage.locator(`[data-edit-journal="${draftSyncJournal.id}"]`).click();
  await draftSyncPage.locator("#journal-physical").fill("体調欄のみ更新");
  await draftSyncPage.locator("#journal-form button[type='submit']").click();
  assert.equal(
    await draftSyncPage.evaluate((id) => window.michiNote.getState().journals.find((journal) => journal.id === id)?.staffDraft, draftSyncJournal.id),
    manualStaffDraft,
    "体調・指標だけの編集で手動の職員下書きが上書きされました"
  );
  await draftSyncContext.close();

  const storageErrorContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", reducedMotion: "reduce" });
  const storageErrorPage = await storageErrorContext.newPage();
  await storageErrorPage.goto(APP_URL, { waitUntil: "networkidle" });
  await storageErrorPage.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException("テスト用の容量不足", "QuotaExceededError"); };
  });
  await storageErrorPage.locator('.main-nav [data-view-target="compose"]').click();
  await storageErrorPage.locator("#compose-journal-select").selectOption("");
  await storageErrorPage.locator("#compose-date").fill("2026-05-28");
  await storageErrorPage.locator("#compose-activity").fill("保存エラー試験");
  await storageErrorPage.locator("#compose-staff").fill("試験担当");
  await storageErrorPage.locator("#compose-start-time").fill("15:30");
  await storageErrorPage.locator("#compose-end-time").fill("17:30");
  await storageErrorPage.locator("#compose-observation").fill("保存エラー時の観察。");
  await storageErrorPage.locator("#compose-support").fill("保存エラー時の支援。");
  await storageErrorPage.locator("#compose-response").fill("保存エラー時の反応。");
  await storageErrorPage.locator('#compose-domain-options input[value="health"]').check();
  await storageErrorPage.locator("#save-record-draft").click();
  const storageErrorToast = (await storageErrorPage.locator("#toast").textContent()) ?? "";
  assert.match(storageErrorToast, /保存できませんでした[\s\S]*再読み込みで失われます/, "保存領域エラー時にデータが未永続であることを表示しません");
  assert.doesNotMatch(storageErrorToast, /記録を保存しました/, "保存失敗後に成功メッセージを表示しています");
  assert.match((await storageErrorPage.locator("#compose-action-note").textContent()) ?? "", /保存できていません/, "保存失敗後の再試行案内がありません");
  await storageErrorContext.close();

  assert.deepEqual(pageErrors, [], `ページ例外: ${pageErrors.join(" / ")}`);
  assert.deepEqual(consoleErrors, [], `コンソールエラー: ${consoleErrors.join(" / ")}`);

  console.log(
    JSON.stringify(
      {
        result: "pass",
        verified: [
          "24件の初期表示",
          "参考JPGの非配信",
          "キーボード導線",
          "24件の初期デモPDF",
          "日誌の追加と永続化",
          "5領域と4指標の分析",
          "92日以内の分析対象期間",
          "全指標未評価の表示",
          "日誌更新後の印刷停止と計画再作成",
          "計画編集と永続化",
          "地域支援の該当なし記録",
          "帳票プレビューと印刷CSS",
          "PDF内の目標別根拠日誌ID",
          "実PDFの生成",
          "モバイル表示",
          "日誌0件の空状態",
          "破損保存データと不正暦日の正規化・復旧",
          "保存値のHTMLエスケープ",
          "旧デモ・編集済み旧データの安全なワークフロー移行",
          "記録・職員確認・共有準備・デモ共有・取消の分離と永続化",
          "元記録変更時の用途別下書き同期と手動文面の保持",
          "保存直後の永続化・保存領域エラー表示",
          "保護者向け文のHTMLエスケープと390px表示",
          "ページ例外・コンソールエラーなし"
        ],
        screenshots: [
          artifactPath("michi-dashboard.png"),
          artifactPath("michi-analysis.png"),
          artifactPath("michi-hint-editor.png"),
          artifactPath("michi-plan.png"),
          artifactPath("michi-mobile.png"),
          artifactPath("michi-plan-demo.pdf"),
          artifactPath("michi-plan.pdf")
        ]
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
