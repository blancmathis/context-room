import fs from "node:fs";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room settings fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}").phase || "").toBe("ready");
  await expect.poll(() => page.evaluate(() => state.runtimeEventsConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(state.contextHub)
    && state.contextHub?.freshness?.refreshing !== true
    && !state.runtimeContextHubRefreshPromise
    && !state.runtimeContextHubRefreshTimer
    && !state.runtimeContextHubRefreshPending
    && !state.runtimeContextHubRefreshGeneration)).toBe(true);
}

function delayedResponseRoute(page, pattern) {
  let markStarted;
  let releaseResponse;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { releaseResponse = resolve; });
  const handler = async (route) => {
    const response = await route.fetch();
    markStarted();
    await released;
    await route.fulfill({ response });
  };
  return {
    started,
    release: () => releaseResponse(),
    install: () => page.route(pattern, handler),
    remove: () => page.unroute(pattern, handler),
  };
}

test("@layout Settings tabs stay connected across delayed project settings refreshes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "firefox-desktop", "The lost pointer click regression was Firefox-specific.");
  const data = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=collapsed`);
  await waitForBoot(page);

  const pattern = "**/api/context-hub/project-settings?*";
  const firstRequest = delayedResponseRoute(page, pattern);
  await firstRequest.install();
  await page.evaluate(() => {
    state.globalProjectSettings.clear();
    state.globalProjectSettingsValidated.clear();
    state.globalProjectSettingsErrors.clear();
  });
  await page.locator("#settingsButton").click();
  await expect(page.locator("#settingsPage")).toBeVisible();
  await firstRequest.started;

  const agentTab = page.locator('[data-settings-section-target="agent-environment"]');
  await agentTab.scrollIntoViewIfNeeded();
  await agentTab.focus();
  const originalAgentTab = await agentTab.elementHandle();
  const box = await agentTab.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  firstRequest.release();
  await expect.poll(() => page.evaluate(() => state.globalProjectSettingsLoading.size)).toBe(0);

  expect(await originalAgentTab.evaluate((node) => node.isConnected)).toBe(true);
  expect(await originalAgentTab.evaluate((node) => document.activeElement === node)).toBe(true);
  await page.mouse.up();
  await expect(agentTab).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => state.settingsSection)).toBe("agent-environment");
  await firstRequest.remove();

  await page.locator('[data-settings-section-target="preferences"]').click();
  await page.locator("#settings-group-appearance-explorer").evaluate((details) => { details.open = true; });
  const computerRoot = page.locator("#computerExplorerRoot");
  const draft = "/tmp/context-room-settings-draft";
  await computerRoot.fill(draft);
  const originalDraftInput = await computerRoot.elementHandle();

  const secondRequest = delayedResponseRoute(page, pattern);
  await secondRequest.install();
  await page.evaluate(() => { void loadGlobalProjectSettings(selectedGlobalSettingsProject(), { force: true }); });
  await secondRequest.started;
  secondRequest.release();
  await expect.poll(() => page.evaluate(() => state.globalProjectSettingsLoading.size)).toBe(0);

  expect(await originalDraftInput.evaluate((node) => node.isConnected)).toBe(true);
  await expect(computerRoot).toHaveValue(draft);
  await expect.poll(() => page.evaluate(() => state.settingsDirtyGroups.has("appearance-explorer"))).toBe(true);
  await secondRequest.remove();

  await page.evaluate(() => renderAfterBackgroundReportPayload());
  expect(await originalDraftInput.evaluate((node) => node.isConnected)).toBe(true);
  await expect(computerRoot).toHaveValue(draft);

  await page.evaluate(async () => {
    const ticket = beginContextHubSnapshotRequest();
    await applyInitialContextHubWhenReady(Promise.resolve({
      contextHub: structuredClone(state.contextHub),
      ticket,
    }));
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  });
  expect(await originalDraftInput.evaluate((node) => node.isConnected)).toBe(true);
  await expect(computerRoot).toHaveValue(draft);
  await expect.poll(() => page.evaluate(() => state.settingsDirtyGroups.has("appearance-explorer"))).toBe(true);
});
