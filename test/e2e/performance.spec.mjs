import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room performance fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] || 0;
}

async function waitForReady(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect(page.locator("#reviewQueueHeading")).toBeVisible();
}

// The browser's own transferSize is not stable: a reload revalidates (304, header bytes only) in Chromium and
// Firefox, but WebKit intermittently refetches the whole body. Measure the served asset from Node instead,
// the same for all four engines: its brotli size, and that an unchanged asset revalidates with a 304.
function fetchAsset(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { "accept-encoding": "br", ...headers } }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => { bytes += chunk.length; });
      response.on("end", () => resolve({ status: response.statusCode, bytes, etag: response.headers.etag }));
    }).on("error", reject);
  });
}

async function assetBudget(urls) {
  let bytes = 0;
  for (const url of urls) {
    const full = await fetchAsset(url);
    expect(full.status, url).toBe(200);
    const again = await fetchAsset(url, { "if-none-match": full.etag });
    expect(again.status, `${url} must revalidate when unchanged`).toBe(304);
    expect(again.bytes).toBe(0);
    bytes += full.bytes;
  }
  return bytes;
}

async function bootSample(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForReady(page);
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    const resources = performance.getEntriesByType("resource");
    const css = resources.filter((entry) => entry.name.includes("/assets/context-room.") && entry.name.endsWith(".css"));
    const js = resources.filter((entry) => entry.name.includes("/assets/context-room.") && entry.name.endsWith(".js"));
    return {
      bootMs: Number(document.body.dataset.bootMs || 0),
      domContentLoadedMs: navigation?.domContentLoadedEventEnd || 0,
      fcpMs: paint?.startTime || 0,
      htmlBytes: navigation?.transferSize || 0,
      cssUrls: css.map((entry) => entry.name),
      jsUrls: js.map((entry) => entry.name),
      longTasks: window.__contextRoomPerfLongTasks || [],
    };
  });
}

test("@perf the unchanged workbench meets its hot runtime budgets", async ({ page }, testInfo) => {
  const data = fixture();
  const apiRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push({ path: url.pathname, at: Date.now() });
  });
  await page.addInitScript(() => {
    window.__contextRoomPerfLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__contextRoomPerfLongTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  await page.goto(`${data.origin}/?hub=1&view=hub`, { waitUntil: "domcontentloaded" });
  await waitForReady(page);
  await bootSample(page);
  await bootSample(page);
  const samples = [];
  for (let index = 0; index < 5; index += 1) samples.push(await bootSample(page));

  const cssBytes = await assetBudget(samples[0].cssUrls);
  const jsBytes = await assetBudget(samples[0].jsUrls);
  expect(samples[0].jsUrls.length, "the context-room script must be measured").toBeGreaterThan(0);

  const fcpP90 = percentile(samples.map((sample) => sample.fcpMs), 0.9);
  const longestTask = Math.max(0, ...samples.flatMap((sample) => sample.longTasks));
  // A loaded shared runner adds isolated slow boots (observed 490-1086 ms against a ~150 ms median),
  // so one outlier must not fail the budget. A real regression moves the median; a stall still trips the hard cap.
  const hotBootMedian = percentile(samples.map((sample) => sample.bootMs), 0.5);
  const hotBootMax = Math.max(...samples.map((sample) => sample.bootMs));
  expect(hotBootMedian, `hot boot median (ms) of ${JSON.stringify(samples.map((sample) => Math.round(sample.bootMs)))}`).toBeLessThan(400);
  expect(hotBootMax, "hot boot max (ms)").toBeLessThan(2_000);
  expect(fcpP90).toBeLessThan(800);
  expect(longestTask).toBeLessThan(80);
  expect(Math.max(...samples.map((sample) => sample.htmlBytes))).toBeLessThan(50_000);
  // 45 000 since 0.3.0; main reached 44 862 (brotli) on 2026-11-06. +1 000 for the T-050 UX lots (home layout,
  // add-project dialog, Go to palette), each measured; keep this budget tight and raise it only with a reason.
  expect(cssBytes).toBeLessThan(46_000);
  // Brotli size of the whole script (244606 on 20c6254; 262 883 on 1e18c35, 259 601 after R7 moved the editor core out); the old 200 kB limit only ever saw 304 revalidations.
  // Raised 260 000 -> 263 000 on 2026-11-11 for the review-scope notice (S5a, PR #149): main was 259 335, this branch measures 261 009 after trimming the notice.
  expect(jsBytes).toBeLessThan(263_000);
  // Hub doc links (PR #158) load on demand, out of the main budget. Served without compression: measure its brotli
  // size here. 1 591 on 2026-11-11; 1 713 after the fix for a doc opened during a read (tour 3); limit +10 %.
  const hubLinks = await new Promise((resolve, reject) => http.get(new URL("/assets/hub-doc-links.mjs", samples[0].jsUrls[0]), (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  }).on("error", reject));
  expect(hubLinks.status).toBe(200);
  expect(zlib.brotliCompressSync(hubLinks.body).length).toBeLessThan(1_900);
  // The project page (R3a: head, tiles, « What agents load ») loads on demand too, with its own limit: 4 563 on 2026-11-12, limit +10 %.
  // Raised 5 000 -> 5 600 on 2026-11-12: review fixes (chained saves, path checks before a shortcut opens) bring it to 5 211.
  const projectPage = await new Promise((resolve, reject) => http.get(new URL("/assets/project-page.mjs", samples[0].jsUrls[0]), (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  }).on("error", reject));
  expect(projectPage.status).toBe(200);
  // Raised 5 600 -> 7 900 on 2026-11-13 for R3b (agent files per level, Recent docs, review groups, 820 px drawer): 7 167, limit +10 %.
  // 7 900 -> 8 400 after the PR #165 review (band from the real queue, groups in project order with true counts): 7 597, limit +10 %.
  expect(zlib.brotliCompressSync(projectPage.body).length).toBeLessThan(8_400);
  // The Markdown editor core (undo, pointer selection, caret, find) moved out of the main script in R7 and loads with
  // the first Markdown doc: 4 333 on 2026-11-13 (the main script lost 3 282), limit +10 %.
  // R2 (tap to edit, autosave) adds the tap-to-caret mapping: ~4 830, limit raised to 5 400.
  const docEditor = await new Promise((resolve, reject) => http.get(new URL("/assets/ui/doc-editor.mjs", samples[0].jsUrls[0]), (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  }).on("error", reject));
  expect(docEditor.status).toBe(200);
  expect(zlib.brotliCompressSync(docEditor.body).length).toBeLessThan(5_400);
  // R5: Accept / Reject from the review banner loads on the first choice: 761 on 2026-11-13, limit +10 %.
  // The main script gained ~280 for the banner line (the Auto-open Git diff setting left to pay for it).
  const reviewBanner = await new Promise((resolve, reject) => http.get(new URL("/assets/ui/review-banner.mjs", samples[0].jsUrls[0]), (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  }).on("error", reject));
  expect(reviewBanner.status).toBe(200);
  expect(zlib.brotliCompressSync(reviewBanner.body).length).toBeLessThan(850);
  // « Skills & MCP » (decision 11) loads on the first press from the project page: 3 290 on 2026-11-13, limit +10 %.
  // The project page gained ~270 for its button and the load (7 913, inside its 8 400).
  const skillsMcp = await new Promise((resolve, reject) => http.get(new URL("/assets/ui/skills-mcp.mjs", samples[0].jsUrls[0]), (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  }).on("error", reject));
  expect(skillsMcp.status).toBe(200);
  expect(zlib.brotliCompressSync(skillsMcp.body).length).toBeLessThan(3_600);

  await page.waitForTimeout(2_000);
  const idleStartedAt = Date.now();
  await page.waitForTimeout(4_000);
  const periodicRequests = apiRequests.filter((request) => request.at >= idleStartedAt && request.path !== "/api/runtime-events");
  expect(periodicRequests, JSON.stringify(periodicRequests)).toEqual([]);

  await testInfo.attach("performance-samples", {
    body: JSON.stringify({ cssBytes, jsBytes, hotBootMedian, hotBootMax, fcpP90, longestTask, samples, periodicRequests }, null, 2),
    contentType: "application/json",
  });
});
