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
}

test("@smoke a lost Hub connection is shown after a short grace period and clears on reconnect", async ({ page }) => {
  await openHub(page);
  const status = page.locator("#status");
  // A dropped event stream that comes back within the grace period stays silent.
  await page.evaluate(() => state.runtimeEventSource.onerror());
  await page.evaluate(() => state.runtimeEventSource.dispatchEvent(new MessageEvent("ready", { data: "{}" })));
  await page.waitForTimeout(3_300);
  await expect(page.locator("body")).not.toHaveClass(/hub-connection-lost/);
  await expect(status).not.toHaveText(/unreachable/i);
  // A stream that stays down is reported, with the brand dot as a second cue.
  // Failed retries repeat the error and must not push the report back.
  await page.evaluate(() => state.runtimeEventSource.onerror());
  await page.waitForTimeout(1_500);
  await page.evaluate(() => state.runtimeEventSource.onerror());
  await expect(status).toHaveText("Hub unreachable · reconnecting…", { timeout: 2_700 });
  await expect(page.locator("body")).toHaveClass(/hub-connection-lost/);
  await page.evaluate(() => state.runtimeEventSource.dispatchEvent(new MessageEvent("ready", { data: "{}" })));
  await expect(status).toHaveText("Hub reconnected");
  await expect(page.locator("body")).not.toHaveClass(/hub-connection-lost/);
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

test("@smoke Documents on a project row reveals that project's documentation map", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHub(page);
  await page.locator("#contextHubHomeProjectList").getByRole("button", { name: "Documents · Beacon", exact: true }).click();
  const map = page.locator("#documentsMapPanel");
  await expect(map).toBeVisible();
  await expect(map).toBeInViewport();
});
