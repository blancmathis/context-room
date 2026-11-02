import fs from "node:fs";
import http from "node:http";
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
  expect(cssBytes).toBeLessThan(45_000);
  // Brotli size of the whole script (244606 on 20c6254); the old 200 kB limit only ever saw 304 revalidations.
  expect(jsBytes).toBeLessThan(260_000);

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
