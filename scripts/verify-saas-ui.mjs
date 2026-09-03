import assert from "node:assert/strict";
import { chromium } from "playwright";
import { buildApp } from "../server/app.js";

const ids = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98c101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98c201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98c301",
  child: "018f1db5-c170-7c35-a784-3cfc6f98c401",
};

const config = {
  nodeEnv: "test", host: "127.0.0.1", port: 8015, appBaseUrl: "http://127.0.0.1",
  databaseUrl: undefined, databaseSsl: false, dbPoolMax: 2, authMode: "development",
  cookieSecret: undefined, auditHashKey: "test-audit-key", cognito: null,
  devActor: { userId: ids.user, tenantId: ids.tenant, facilityIds: [ids.facility], role: "tenant_admin", displayName: "山田 管理者" },
};

const app = await buildApp({ config, pool: null, logger: false });
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "ja-JP", reducedMotion: "reduce" });
  const errors = [];
  const writingRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const child = {
      id: ids.child, facilityId: ids.facility, managementCode: "C-001", displayName: "Aさん", legalName: "青葉 一郎",
      birthDate: "2016-05-12", grade: "小学4年生", gender: "male", address: {}, disabilityCategory: "通所受給者証あり",
      medicalSummary: "服薬なし。体調変化がある場合は保護者へ連絡。", status: "active", updatedAt: "2026-08-14T03:00:00.000Z", rowVersion: 3,
    };
    let body;
    if (url.pathname.endsWith("/session")) body = { user: { id: ids.user, displayName: "山田 管理者", role: "tenant_admin" }, tenant: { id: ids.tenant, name: "社会福祉法人みらい" }, facilityIds: [ids.facility], csrfToken: "csrf-test" };
    else if (url.pathname.endsWith("/facilities")) body = { items: [{ id: ids.facility, name: "みらいステップ中央", code: "MS-01", serviceType: "放課後等デイサービス", status: "active", rowVersion: 1 }] };
    else if (url.pathname === `/api/v1/children/${ids.child}`) body = child;
    else if (url.pathname.endsWith("/children")) body = { items: [child] };
    else if (url.pathname.endsWith("/daily-logs")) body = {
      items: [{
        id: "018f1db5-c170-7c35-a784-3cfc6f98c501", occurredAt: "2026-09-03T06:00:00.000Z",
        activity: "集団での工作", observation: "友だちへ自分から声をかけ、順番を守って参加した。",
        supportProvided: "予定を短く伝え、必要な場面で選択肢を示した。", childResponse: "安心して最後まで制作に取り組めた。",
        healthNote: "体調の変化なし", fiveDomains: ["cognition_behavior", "human_relations_sociality"], status: "final", rowVersion: 1,
      }],
    };
    else if (url.pathname.endsWith("/writing-assist") && request.method() === "POST") {
      const input = request.postDataJSON();
      writingRequests.push(input);
      const source = input.sourceText || input.facilityReply || input.requestSummary || "";
      const text = `整形済み：${source}`;
      body = { text, characterCount: [...text].length };
    } else body = { items: [] };
    await route.fulfill({ status: request.method() === "POST" ? 201 : 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.goto(`${origin}/saas.html`, { waitUntil: "networkidle" });
  await page.locator("#app-shell").waitFor({ state: "visible" });
  assert.equal((await page.locator("#sidebar-facility-name").textContent()).trim(), "みらいステップ中央");
  await page.locator("#open-child-picker").click();
  await page.locator(".picker-option").click();
  await page.locator('.primary-nav [data-view="journals"]').click();
  await page.locator("#create-journal-button").click();
  await page.locator("#journal-dialog").waitFor({ state: "visible" });

  const observation = page.locator("#journal-observation");
  const targetSelect = page.locator('[data-journal-length="observation"]');
  const customTarget = page.locator(".journal-custom-target-length").first();
  await observation.fill("活動中に友だちへ自分から声をかけ、順番を守って遊びに参加できた。");
  await targetSelect.selectOption("custom");
  await customTarget.fill("240");
  await page.locator("#journal-observation-count").getByText(/目標 240字/).waitFor();
  await page.locator('[data-expand-journal-field="observation"]').click();
  await page.waitForFunction(() => document.querySelector("#journal-observation")?.value.startsWith("整形済み："));
  assert.equal(writingRequests.length, 1);
  assert.equal(writingRequests[0].targetCharacters, 240);
  assert.equal(writingRequests[0].kind, "daily_log");
  await page.locator('[data-copy-journal-field="observation"]').click();
  await page.locator('[data-copy-journal-field="observation"]').getByText("コピーしました").waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^整形済み：/);
  await page.locator('[data-close-dialog="journal-dialog"]').click();
  await page.locator("#create-journal-button").click();
  await page.locator("#journal-dialog").waitFor({ state: "visible" });
  assert.equal(await targetSelect.inputValue(), "200");
  assert.equal(await customTarget.isHidden(), true);
  await page.locator('[data-close-dialog="journal-dialog"]').click();
  await page.getByRole("button", { name: "当日のサマリー" }).click();
  await page.locator("#daily-summary-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#daily-summary-card").textContent(), /やってみたこと[\s\S]*今日のようす[\s\S]*できたこと/);
  assert.match(await page.locator("#daily-summary-card").textContent(), /今日の活動/);
  await page.locator('[data-close-dialog="daily-summary-dialog"]').click();

  await page.locator('.primary-nav [data-view="documents"]').click();
  await page.locator("#assessment-title").waitFor();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(250);
  const mobileLayout = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    viewport: { innerWidth: window.innerWidth, mediaMatches: window.matchMedia("(max-width: 860px)").matches },
    sidebarPosition: getComputedStyle(document.querySelector(".sidebar")).position,
    offenders: [...document.querySelectorAll("body *")]
      .map((node) => ({ node: `${node.tagName.toLowerCase()}#${node.id}.${node.className}`, rect: node.getBoundingClientRect().toJSON() }))
      .filter(({ rect }) => rect.right > window.innerWidth + 1 && rect.width > 1)
      .slice(0, 8),
  }));
  if (!mobileLayout.fits) console.error(JSON.stringify(mobileLayout, null, 2));
  assert.equal(mobileLayout.fits, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await app.close();
}
