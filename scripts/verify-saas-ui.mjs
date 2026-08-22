import assert from "node:assert/strict";
import { chromium } from "playwright";
import { buildApp } from "../server/app.js";

const ids = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98c101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98c201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98c301",
  child: "018f1db5-c170-7c35-a784-3cfc6f98c401",
  document: "018f1db5-c170-7c35-a784-3cfc6f98c501",
  snapshot: "018f1db5-c170-7c35-a784-3cfc6f98c601",
  generatedSnapshot: "018f1db5-c170-7c35-a784-3cfc6f98c602",
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
  let mockedRole = "tenant_admin";
  let pdfPostAttempts = 0;
  let snapshotListRequests = 0;
  const pdfRequestHeaders = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const child = {
      id: ids.child, facilityId: ids.facility, managementCode: "C-001", displayName: "Aさん", legalName: "青葉 一郎",
      birthDate: "2016-05-12", grade: "小学4年生", gender: "male", address: {}, disabilityCategory: "通所受給者証あり",
      medicalSummary: "服薬なし。体調変化がある場合は保護者へ連絡。", status: "active", updatedAt: "2026-08-14T03:00:00.000Z", rowVersion: 3,
    };
    const documentRecord = {
      id: ids.document, childId: ids.child, documentKind: "individual_support_plan", status: "approved", versionNumber: 2,
      periodStart: "2026-08-01", periodEnd: "2027-01-31", updatedAt: "2026-08-14T03:15:00.000Z", rowVersion: 5,
    };
    const existingSnapshot = {
      id: ids.snapshot, documentId: ids.document, documentRowVersion: 4, sourceStatus: "approved", templateVersion: "1",
      snapshotKind: "official", generatedAt: "2026-08-13T06:30:00.000Z", byteSize: 124_880, mimeType: "application/pdf",
    };
    const generatedSnapshot = {
      ...existingSnapshot, id: ids.generatedSnapshot, documentRowVersion: 5, generatedAt: "2026-08-14T06:45:00.000Z", byteSize: 128_512,
    };
    let body;
    let status = request.method() === "POST" ? 201 : 200;
    const headers = { "content-type": "application/json" };
    if (url.pathname.endsWith("/session")) body = { user: { id: ids.user, displayName: mockedRole === "viewer" ? "閲覧 担当" : "山田 管理者", role: mockedRole }, tenant: { id: ids.tenant, name: "社会福祉法人みらい" }, facilityIds: [ids.facility], csrfToken: "csrf-test" };
    else if (url.pathname.endsWith("/facilities")) body = { items: [{ id: ids.facility, name: "みらいステップ中央", code: "MS-01", serviceType: "放課後等デイサービス", status: "active", rowVersion: 1 }] };
    else if (url.pathname === `/api/v1/children/${ids.child}`) { body = child; headers.etag = '"3"'; }
    else if (url.pathname.endsWith("/children")) body = request.method() === "GET" ? { items: [child] } : child;
    else if (url.pathname.endsWith("/daily-logs")) body = { items: [] };
    else if (url.pathname.endsWith("/contact-book")) body = { items: [] };
    else if (url.pathname === `/api/v1/children/${ids.child}/documents/${ids.document}/pdf` && request.method() === "POST") {
      pdfPostAttempts += 1;
      pdfRequestHeaders.push({ headers: request.headers(), body: request.postDataJSON() });
      if (pdfPostAttempts === 1) {
        status = 503;
        body = { error: { code: "PDF_RENDER_FAILED", message: "render failed" } };
      } else if (pdfPostAttempts === 2) {
        await route.abort("connectionfailed");
        return;
      } else if (pdfPostAttempts === 4) {
        status = 409;
        body = { error: { code: "OFFICIAL_PDF_NOT_AVAILABLE", message: "status changed", details: { currentVersion: 6 } } };
      } else {
        body = generatedSnapshot;
      }
    }
    else if (url.pathname === `/api/v1/children/${ids.child}/documents/${ids.document}/snapshots` && request.method() === "GET") {
      snapshotListRequests += 1;
      body = { items: pdfPostAttempts >= 3 ? [generatedSnapshot, existingSnapshot] : [existingSnapshot] };
    }
    else if (url.pathname === `/api/v1/children/${ids.child}/documents/${ids.document}`) {
      body = { ...documentRecord, payload: {}, goals: [] };
      headers.etag = '"5"';
    }
    else if (url.pathname.endsWith("/documents")) body = request.method() === "GET" ? { items: [documentRecord] } : { id: ids.document, documentKind: "individual_support_plan" };
    else body = { items: [] };
    await route.fulfill({ status, headers, body: JSON.stringify(body) });
  });

  await page.goto(`${origin}/saas.html`, { waitUntil: "networkidle" });
  await page.locator("#app-shell").waitFor({ state: "visible" });
  assert.equal((await page.locator("#tenant-name").textContent()).trim(), "社会福祉法人みらい");
  await page.locator("#open-child-picker").click();
  await page.locator(".picker-option").click();
  await page.locator('[data-view="child"]').click();
  await page.locator("#child-detail").getByText("青葉 一郎").waitFor();
  await page.locator("#child-tab-guardians").click();
  await page.locator("#guardian-list").waitFor();
  await page.locator("#child-tab-schedules").click();
  await page.locator("#current-schedule").waitFor();
  await page.locator('.primary-nav [data-view="documents"]').click();
  await page.locator("#support-cycle-title").waitFor();
  await page.locator(".pdf-snapshot-list").waitFor();
  assert.equal((await page.locator(".pdf-create-button").textContent()).trim(), "正式PDFを作成");
  const existingPdfLink = page.locator(".pdf-snapshot-list a").first();
  assert.equal(await existingPdfLink.getAttribute("target"), "_blank");
  assert.equal(await existingPdfLink.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await existingPdfLink.getAttribute("href"), `/api/v1/children/${ids.child}/documents/${ids.document}/snapshots/${ids.snapshot}/content`);
  await page.locator(".pdf-create-button").click();
  await page.locator(".pdf-error").waitFor();
  assert.match((await page.locator(".pdf-error").textContent()).trim(), /PDFを作成できませんでした/);
  assert.equal(await page.locator(".pdf-error").getAttribute("role"), "alert");
  assert.equal(await page.locator("#network-save-status").getAttribute("data-state"), "error");
  await page.locator(".pdf-create-button").click();
  await page.locator(".pdf-error").getByText(/サーバーに接続できません/).waitFor();
  await page.locator(".pdf-create-button").click();
  await page.locator(".pdf-snapshot-list li").nth(1).waitFor();
  assert.equal(await page.locator(".pdf-snapshot-list li").count(), 2);
  assert.equal(await page.locator("#network-save-status").getAttribute("data-state"), "saved");
  assert.equal(pdfRequestHeaders[0].headers["if-match"], '"5"');
  assert.equal(pdfRequestHeaders[0].headers["x-csrf-token"], "csrf-test");
  assert.equal(pdfRequestHeaders[0].body.snapshotKind, "official");
  assert.ok(pdfRequestHeaders[0].headers["idempotency-key"]);
  assert.equal(pdfRequestHeaders[1].headers["idempotency-key"], pdfRequestHeaders[2].headers["idempotency-key"]);
  assert.equal(pdfRequestHeaders[2].headers["if-match"], '"5"');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/saas-production-pdf.png", fullPage: true });
  await page.locator(".pdf-create-button").click();
  await page.locator("#conflict-dialog").waitFor({ state: "visible" });
  assert.equal((await page.locator("#conflict-title").textContent()).trim(), "PDFを作成できる工程が変わりました");
  assert.equal(await page.locator("#network-save-status").getAttribute("data-state"), "conflict");
  await page.locator("#return-to-edit").click();
  await page.locator(".admin-nav").click();
  await page.locator("#staff-list").waitFor();
  await page.locator("#audit-list").waitFor();
  await page.locator("#invite-staff-button").click();
  await page.locator("#staff-invite-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator('#staff-invite-form select[name="role"] option').count(), 6);
  await page.locator('[data-close-dialog="staff-invite-dialog"]').click();
  await page.locator("#create-facility-button").click();
  await page.locator("#facility-create-dialog").waitFor({ state: "visible" });
  await page.locator('[data-close-dialog="facility-create-dialog"]').click();
  const snapshotRequestsBeforeNoPdfRole = snapshotListRequests;
  mockedRole = "viewer";
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#app-shell").waitFor({ state: "visible" });
  assert.equal(await page.locator("#child-register-dialog").count(), 0);
  assert.equal(await page.locator("#journal-dialog").count(), 0);
  assert.equal(await page.locator("#transition-dialog").count(), 0);
  assert.equal(await page.locator(".admin-nav").count(), 0);
  await page.locator("#open-child-picker").click();
  await page.locator(".picker-option").click();
  await page.locator('.primary-nav [data-view="documents"]').click();
  await page.locator("#support-cycle-title").waitFor();
  assert.equal(await page.locator(".pdf-panel").count(), 0);
  assert.equal(await page.locator(".pdf-create-button").count(), 0);
  assert.equal(await page.locator(".pdf-snapshot-list").count(), 0);
  assert.equal(snapshotListRequests, snapshotRequestsBeforeNoPdfRole);
  const mobileLayout = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    mediaMatches: window.matchMedia("(max-width: 860px)").matches,
    sidebarPosition: getComputedStyle(document.querySelector(".sidebar")).position,
    workspaceMargin: getComputedStyle(document.querySelector(".workspace")).marginLeft,
    workspaceInlineStyle: document.querySelector(".workspace").getAttribute("style"),
    appShellSidebarWidth: getComputedStyle(document.querySelector(".app-shell")).getPropertyValue("--sidebar-width"),
    workspaceSidebarWidth: getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--sidebar-width"),
    stylesheets: [...document.styleSheets].map((sheet) => sheet.href),
    workspaceRules: [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .flatMap((rule) => rule.cssRules ? [...rule.cssRules].map((nested) => `${rule.conditionText}: ${nested.cssText}`) : [rule.cssText])
      .filter((text) => text.includes(".workspace {")),
    offenders: [...document.querySelectorAll("body *")]
      .map((node) => ({ node: `${node.tagName.toLowerCase()}#${node.id}.${node.className}`, rect: node.getBoundingClientRect().toJSON() }))
      .filter(({ rect }) => rect.right > window.innerWidth + 1 && rect.width > 1)
      .slice(0, 20),
  }));
  if (!mobileLayout.fits) console.log(JSON.stringify(mobileLayout, null, 2));
  assert.equal(mobileLayout.fits, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await app.close();
}
