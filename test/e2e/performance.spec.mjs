import fs from "node:fs";
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
      cssBytes: css.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      jsBytes: js.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
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

  const hotBootP90 = percentile(samples.map((sample) => sample.bootMs), 0.9);
  const fcpP90 = percentile(samples.map((sample) => sample.fcpMs), 0.9);
  const longestTask = Math.max(0, ...samples.flatMap((sample) => sample.longTasks));
  expect(hotBootP90).toBeLessThan(400);
  expect(fcpP90).toBeLessThan(800);
  expect(longestTask).toBeLessThan(80);
  expect(Math.max(...samples.map((sample) => sample.htmlBytes))).toBeLessThan(50_000);
  expect(Math.max(...samples.map((sample) => sample.cssBytes))).toBeLessThan(45_000);
  expect(Math.max(...samples.map((sample) => sample.jsBytes))).toBeLessThan(200_000);

  await page.waitForTimeout(2_000);
  const idleStartedAt = Date.now();
  await page.waitForTimeout(4_000);
  const periodicRequests = apiRequests.filter((request) => request.at >= idleStartedAt && request.path !== "/api/runtime-events");
  expect(periodicRequests, JSON.stringify(periodicRequests)).toEqual([]);

  await testInfo.attach("performance-samples", {
    body: JSON.stringify({ hotBootP90, fcpP90, longestTask, samples, periodicRequests }, null, 2),
    contentType: "application/json",
  });
});
