import fs from "node:fs";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room e2e fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function openHub(page) {
  await page.goto(`${fixture().origin}/?hub=1&view=hub`);
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(() => page.evaluate(() => state.runtimeEventsConnected), { timeout: 30_000 }).toBe(true);
  // Boot requests (queue, sections, register, history, reports) must settle: they share the host's 6 connections.
  await expect.poll(async () => JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}").phase || "", { timeout: 30_000 }).toBe("ready");
  await expect.poll(() => page.evaluate(() => Boolean(state.contextHub)
    && state.contextHub?.freshness?.refreshing !== true
    && !state.runtimeContextHubRefreshPromise
    && !state.runtimeContextHubRefreshTimer
    && !state.runtimeContextHubRefreshPending
    && !state.runtimeContextHubRefreshGeneration), { timeout: 30_000 }).toBe(true);
}

test("@smoke a lost Hub connection is shown after a short grace period and clears on reconnect", async ({ page }) => {
  await openHub(page);
  const status = page.locator("#status");
  // A dropped event stream that comes back within the grace period stays silent
  // (the browser's own reconnect delay is 3 to 5 s).
  await page.evaluate(() => state.runtimeEventSource.onerror());
  await page.waitForTimeout(5_000);
  await expect(page.locator("body")).not.toHaveClass(/hub-connection-lost/);
  await page.evaluate(() => state.runtimeEventSource.dispatchEvent(new MessageEvent("ready", { data: "{}" })));
  await expect(page.locator("body")).not.toHaveClass(/hub-connection-lost/);
  await expect(status).not.toHaveText(/unreachable/i);
  // A stream that stays down is reported after 8 s, with the brand dot as a second cue.
  // Failed retries repeat the error and must not push the report back.
  await page.evaluate(() => state.runtimeEventSource.onerror());
  await page.waitForTimeout(4_000);
  await page.evaluate(() => state.runtimeEventSource.onerror());
  await expect(status).toHaveText("Hub unreachable · reconnecting…", { timeout: 5_000 });
  await expect(page.locator("body")).toHaveClass(/hub-connection-lost/);
  const weight = () => status.evaluate((node) => getComputedStyle(node).fontWeight);
  expect(await weight()).toBe("600");
  // Unrelated messages replace the outage text and lose the red style.
  await page.evaluate(() => setStatus("Saved"));
  await expect(status).toHaveText("Saved");
  expect(await weight()).not.toBe("600");
  await page.evaluate(() => state.runtimeEventSource.dispatchEvent(new MessageEvent("ready", { data: "{}" })));
  await expect(status).toHaveText("Hub reconnected");
  await expect(page.locator("body")).not.toHaveClass(/hub-connection-lost/);
});

test("@smoke a closed event stream is reopened with a growing wait, one source at a time", async ({ page }) => {
  await openHub(page);
  let refused = 0;
  await page.route("**/api/runtime-events**", async (route) => {
    if (refused < 1) { refused += 1; await route.fulfill({ status: 404, body: "{}" }); return; }
    await route.continue();
  });
  const first = await page.evaluate(() => { window.__firstSource = state.runtimeEventSource; return true; });
  expect(first).toBe(true);
  // The browser closes a stream after an HTTP error and does not retry by itself.
  await page.evaluate(() => { state.runtimeEventSource.close(); state.runtimeEventSource.onerror(); });
  await expect.poll(() => page.evaluate(() => state.runtimeEventSource !== window.__firstSource), { timeout: 5_000 }).toBe(true);
  // The first reopen gets a 404; the next one (after a longer wait) succeeds and resets the backoff.
  await expect.poll(() => page.evaluate(() => state.runtimeEventsConnected), { timeout: 15_000 }).toBe(true);
  expect(refused).toBe(1);
  await expect.poll(() => page.evaluate(() => state.runtimeEventsReopenAttempts), { timeout: 5_000 }).toBe(0);
  expect(await page.evaluate(() => state.runtimeEventsReopenTimer)).toBeNull();
});

test("@smoke review cleanup shows that it is opening and never stacks two dialogs", async ({ page }) => {
  await openHub(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/review-cleanup", async (route) => {
    await held;
    await route.continue();
  });
  const trigger = page.locator("#reviewQueuePanel [data-review-cleanup]");
  await trigger.click();
  await expect(trigger).toHaveText("Opening review cleanup…");
  await expect(trigger).toHaveAttribute("aria-busy", "true");
  await trigger.click({ force: true });
  release();
  await expect(page.locator('dialog[open][aria-label="Review cleanup"]')).toHaveCount(1);
  await expect(trigger).toHaveText("Clean up older changes");
  await page.waitForTimeout(500);
  await expect(page.locator('dialog[aria-label="Review cleanup"]')).toHaveCount(1);
});

test("@smoke two cleanup triggers share one load", async ({ page }) => {
  await openHub(page);
  let release;
  let requests = 0;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/review-cleanup", async (route) => {
    requests += 1;
    await held;
    await route.continue();
  });
  // Settings has its own [data-review-cleanup] button; add a second trigger the same way.
  await page.evaluate(() => {
    const other = document.createElement("button");
    other.id = "otherCleanupTrigger";
    other.dataset.reviewCleanup = "";
    other.textContent = "Manage review cleanup";
    document.body.append(other);
  });
  await page.locator("#reviewQueuePanel [data-review-cleanup]").click();
  await page.locator("#otherCleanupTrigger").click();
  release();
  await expect(page.locator('dialog[open][aria-label="Review cleanup"]')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
  await expect(page.locator('dialog[aria-label="Review cleanup"]')).toHaveCount(1);
});

test("@smoke Documents on a project row reveals that project's documentation map", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHub(page);
  // The home project rows show only while the Explorer is collapsed.
  await page.evaluate(() => setExplorerCollapsedFromUser(true));
  await page.locator("#contextHubHomeProjectList").getByRole("button", { name: "Documents · Beacon", exact: true }).click();
  const map = page.locator("#documentsMapPanel");
  await expect(map).toBeVisible();
  await expect(map).toBeInViewport();
});
