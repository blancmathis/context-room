import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createMemoryServer, initializeContextRoomProject } from "../../src/context_room.mjs";
import { registerContextHubProject } from "../../src/context_hub.mjs";

// A clean review queue keeps the project and type filters in place, so the
// column does not jump. A setting hides them again.
test("@perf the review toolbar keeps its place on a clean queue unless the setting hides it", async ({ page }) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-review-toolbar-")));
  const previous = {};
  for (const key of ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"]) {
    previous[key] = process.env[key];
    process.env[key] = path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const root = path.join(base, "Clean");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  initializeContextRoomProject(root, { title: "Clean", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  registerContextHubProject(root, { title: "Clean" });
  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${room.server.address().port}/?hub=1&view=hub`);
    await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
    await expect(page.locator(".review-all-clear")).toBeVisible({ timeout: 45_000 });
    const toolbar = page.locator(".context-room-review-toolbar");
    await expect(toolbar).toBeVisible();
    const top = (await page.locator("#contextRoomReviewProjectFilter").boundingBox()).y;
    await page.waitForTimeout(1_000);
    expect((await page.locator("#contextRoomReviewProjectFilter").boundingBox()).y).toBe(top);

    await page.evaluate(() => {
      state.settings = { ...state.settings, appearance: { ...state.settings.appearance, hideEmptyReviewToolbar: true } };
      renderContextRoomGlobalReviewQueue();
    });
    await expect(toolbar).toBeHidden();
    await page.evaluate(() => {
      state.settings = { ...state.settings, appearance: { ...state.settings.appearance, hideEmptyReviewToolbar: false } };
      renderContextRoomGlobalReviewQueue();
    });
    await expect(toolbar).toBeVisible();
  } finally {
    room.server.closeAllConnections?.();
    room.server.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
