import { AppError } from "../errors.js";

const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 20 * 1024 * 1024;

export function createPlaywrightPdfRenderer(options = {}) {
  const maxHtmlBytes = options.maxHtmlBytes || DEFAULT_MAX_HTML_BYTES;
  const maxPdfBytes = options.maxPdfBytes || DEFAULT_MAX_PDF_BYTES;
  const timeoutMs = options.timeoutMs || 30_000;
  let browserPromise = null;

  async function chromium() {
    if (options.chromium) return options.chromium;
    const playwright = await import("playwright");
    return playwright.chromium;
  }

  async function browser() {
    if (!browserPromise) {
      browserPromise = chromium().then((engine) => engine.launch({
        headless: true,
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        args: ["--disable-dev-shm-usage"],
      }));
      browserPromise.then((instance) => {
        instance.on("disconnected", () => {
          browserPromise = null;
        });
      }).catch(() => {
        browserPromise = null;
      });
    }
    return browserPromise;
  }

  return Object.freeze({
    async render({ html, orientation }) {
      if (typeof html !== "string" || !html.startsWith("<!doctype html>")) {
        throw new TypeError("PDF renderer requires a complete HTML document");
      }
      if (!['portrait', 'landscape'].includes(orientation)) {
        throw new TypeError("PDF orientation must be portrait or landscape");
      }
      if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) {
        throw new RangeError("PDF source HTML is too large");
      }

      const instance = await browser();
      const page = await instance.newPage({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
      try {
        page.setDefaultTimeout(timeoutMs);
        await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
        await page.emulateMedia({ media: "print" });
        const pdf = Buffer.from(await page.pdf({
          timeout: timeoutMs,
          format: "A4",
          landscape: orientation === "landscape",
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
          tagged: true,
          outline: true,
        }));
        if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
          throw new Error("renderer did not return a PDF document");
        }
        if (pdf.length === 0 || pdf.length > maxPdfBytes) {
          throw new RangeError("rendered PDF size is outside the allowed range");
        }
        return pdf;
      } finally {
        await page.close();
      }
    },

    async close() {
      if (!browserPromise) return;
      const instance = await browserPromise.catch(() => null);
      browserPromise = null;
      if (instance?.isConnected()) await instance.close();
    },
  });
}

/** Bound Chromium memory use on the 1 GiB Fargate task. */
export function createBoundedPdfRenderer(renderer, options = {}) {
  if (!renderer?.render) throw new TypeError("a PDF renderer is required");
  const maxConcurrent = options.maxConcurrent ?? 1;
  const maxQueue = options.maxQueue ?? 1;
  const retryAfterSeconds = options.retryAfterSeconds ?? 5;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) {
    throw new RangeError("PDF render concurrency must be between 1 and 2");
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0 || maxQueue > 4) {
    throw new RangeError("PDF render queue limit must be between 0 and 4");
  }
  let active = 0;
  let closed = false;
  const queue = [];
  const capacityError = () => new AppError(
    503,
    "PDF_RENDER_CAPACITY_EXCEEDED",
    "PDF generation capacity is temporarily full. Please retry shortly.",
    { details: { retryAfterSeconds } },
  );

  async function acquire() {
    if (closed) throw capacityError();
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    if (queue.length >= maxQueue) throw capacityError();
    await new Promise((resolve, reject) => queue.push({ resolve, reject }));
  }
  function release() {
    const next = queue.shift();
    if (next) next.resolve();
    else active -= 1;
  }

  return Object.freeze({
    async render(input) {
      await acquire();
      try {
        return await renderer.render(input);
      } finally {
        release();
      }
    },
    stats: () => Object.freeze({ active, queued: queue.length, maxConcurrent, maxQueue }),
    async close() {
      closed = true;
      const error = capacityError();
      for (const waiter of queue.splice(0)) waiter.reject(error);
      if (typeof renderer.close === "function") await renderer.close();
    },
  });
}
