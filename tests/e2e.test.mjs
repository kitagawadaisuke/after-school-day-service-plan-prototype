import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:4173";
const STORAGE_KEY = "michi-note-demo-v1";

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  const requestedModule = process.env.PLAYWRIGHT_MODULE;
  if (requestedModule && existsSync(requestedModule)) return localRequire(requestedModule);
  try {
    return localRequire("playwright");
  } catch {
    const bundledModule =
      "/Users/maple617/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
    if (!existsSync(bundledModule)) {
      throw new Error(
        "Playwright が見つかりません。開発環境の Playwright を利用するか、ローカルに用意してください。"
      );
    }
    return localRequire(bundledModule);
  }
}

async function assertVisible(locator, message) {
  await locator.waitFor({ state: "visible" });
  assert.equal(await locator.isVisible(), true, message);
}

const { chromium } = loadPlaywright();
const bundledChromium =
  "/Users/maple617/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  chromium.executablePath(),
  bundledChromium
].find((candidate) => candidate && existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath });
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
  await page.screenshot({ path: "/tmp/michi-dashboard.png", fullPage: true });

  await page.locator('.main-nav [data-view-target="plan"]').click();
  await assertVisible(page.locator("#plan-editor"), "初期デモの計画編集画面が表示されません");
  assert.equal(await page.locator("#print-plan").isDisabled(), false, "初期デモ計画を印刷できません");
  assert.equal((await page.evaluate(() => window.michiNote.getState().plan?.sourceCount)), 24);
  await page.locator('[data-plan-mode="preview"]').click();
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /5回中4回/, "初期デモの詳細な到達目標がありません");
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /根拠：J-\d+/, "初期デモPDFに根拠日誌IDがありません");
  await page.emulateMedia({ media: "print" });
  const demoPdfPath = "/tmp/michi-plan-demo.pdf";
  await page.pdf({
    path: demoPdfPath,
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    tagged: true
  });
  assert.ok(readFileSync(demoPdfPath).byteLength > 10_000, "初期デモPDFが空、または必要な内容を持っていません");
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
  await page.screenshot({ path: "/tmp/michi-analysis.png", fullPage: true });

  await page.locator('.main-nav [data-view-target="plan"]').click();
  await assertVisible(page.locator("#plan-editor"), "計画編集画面が表示されません");
  assert.equal(await page.locator("#print-plan").isDisabled(), true, "日誌更新後の古い計画案を印刷できてしまいます");
  assert.match((await page.locator("#plan-checklist").textContent()) ?? "", /生成後に変更/);
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /根拠更新前・印刷不可/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#regenerate-plan").click();
  await page.waitForFunction(() => window.michiNote.getState().plan?.sourceCount === 25 && window.michiNote.getState().planStale === false);
  assert.equal(await page.locator("#print-plan").isDisabled(), false, "再作成後も印刷が有効になりません");
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
  await page.waitForFunction(
    ({ storageKey, expected }) => JSON.parse(localStorage.getItem(storageKey) ?? "{}").plan?.shortTermGoal === expected,
    { storageKey: STORAGE_KEY, expected: editedGoal }
  );
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-plan-path="shortTermGoal"]').inputValue(), editedGoal, "計画編集が再読込後に復元されません");
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
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /個別支援計画書/);
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /原案/);
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /地域支援・地域連携[\s\S]*該当なし/);
  assert.match((await page.locator("#plan-preview").textContent()) ?? "", /根拠：J-\d+/, "PDF帳票に目標別の根拠日誌IDがありません");
  await page.emulateMedia({ media: "print" });
  assert.equal(
    await page.locator("#plan-preview").evaluate((element) => getComputedStyle(element).display),
    "block",
    "印刷メディアで帳票が表示されません"
  );
  const pdfPath = "/tmp/michi-plan.pdf";
  await page.pdf({
    path: pdfPath,
    format: "A4",
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    tagged: true
  });
  assert.ok(readFileSync(pdfPath).byteLength > 10_000, "印刷PDFが空、または必要な内容を持っていません");
  await page.emulateMedia({ media: "screen" });
  await page.screenshot({ path: "/tmp/michi-plan.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.main-nav [data-view-target="dashboard"]').click();
  await assertVisible(page.locator("#view-dashboard .hero-panel"), "モバイルでダッシュボードが表示されません");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    true,
    "モバイル表示で横スクロールが発生しています"
  );
  await page.screenshot({ path: "/tmp/michi-mobile.png", fullPage: true });
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
  await corruptPage.reload({ waitUntil: "networkidle" });
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
  await xssPage.reload({ waitUntil: "networkidle" });
  assert.equal(await xssPage.locator("#plan-editor img, #plan-preview img").count(), 0, "保存値からHTML要素が生成されています");
  assert.equal(await xssPage.evaluate(() => window.__storedXss), undefined, "保存値からスクリプトが実行されています");
  assert.match((await xssPage.locator("#plan-preview").textContent()) ?? "", /<img src=x/, "危険な保存値が安全な文字列として表示されません");
  await xssContext.close();

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
          "ページ例外・コンソールエラーなし"
        ],
        screenshots: [
          "/tmp/michi-dashboard.png",
          "/tmp/michi-analysis.png",
          "/tmp/michi-plan.png",
          "/tmp/michi-mobile.png",
          "/tmp/michi-plan-demo.pdf",
          "/tmp/michi-plan.pdf"
        ]
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
