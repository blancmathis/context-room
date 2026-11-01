import fs from "node:fs";
import { test, expect } from "@playwright/test";
// Sweep-1 lane-B web UX fixes. The geometry fixture serves real Hub pages.
test.use({ serviceWorkers: "block" });

const fixture = () => JSON.parse(fs.readFileSync(process.env.CONTEXT_ROOM_E2E_FIXTURE, "utf8"));
async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}").phase || "").toBe("ready");
  await expect.poll(() => page.evaluate(() => Boolean(state.contextHub))).toBe(true);
  await page.waitForTimeout(400);
}
async function openAtlas(page, width, height = 900, extra = "&explorer=expanded") {
  const data = fixture();
  await page.setViewportSize({ width, height });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub${extra}`);
  await waitForBoot(page);
}

for (const [width, height] of [[390, 844], [800, 900]]) {
  test(`@layout at ${width}px choosing a file in the Explorer closes the drawer and focuses the document`, async ({ page }) => {
    await openAtlas(page, width, height);
    const docs = page.locator('[data-global-project-folder="docs"]').first();
    await expect(docs).toBeVisible();
    if (await docs.getAttribute("aria-expanded") !== "true") await docs.click();
    await page.locator('[data-global-project-file="docs/README.md"]').first().click();
    await expect(page).toHaveURL((url) => url.searchParams.get("file") === "docs/README.md");
    await expect(page.locator(".app")).toHaveClass(/sidebar-collapsed/);
    await expect(page.locator(".app")).not.toHaveClass(/explorer-expanded/);
    await expect(page.locator("#viewer")).toBeVisible();
    await expect(page.locator("main")).not.toHaveAttribute("inert", /.*/);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)).toBe("viewer");
  });
}

test("@layout the dock status stays inside the screen at 390px on the review flow", async ({ page }) => {
  await openAtlas(page, 390, 844, "");
  if (await page.locator(".app").evaluate((node) => !node.classList.contains("sidebar-collapsed"))) await page.locator("#sidebarToggle").click();
  await page.getByRole("button", { name: /Review one after another/ }).first().click();
  await expect(page.locator("#contextPanelToggle")).toBeVisible();
  const box = await page.evaluate(() => {
    const status = document.querySelector("#status").getBoundingClientRect();
    return { right: status.right, edge: document.querySelector(".workspace-dock").getBoundingClientRect().right, width: innerWidth };
  });
  expect(box.right).toBeLessThanOrEqual(Math.min(box.edge, box.width) + 0.5);
});

test("@layout touch targets reach 44px at 800px", async ({ page }) => {
  await openAtlas(page, 800, 900, "&explorer=collapsed");
  // Every selector must match at least one visible element, so an empty match cannot pass.
  const visibleSizes = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && node.getBoundingClientRect().width > 0).map((node) => { const r = node.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }), sel);
  const small = async (selector) => {
    await expect.poll(async () => (await visibleSizes(selector)).length, { message: `${selector} has a visible element` }).toBeGreaterThan(0);
    return (await visibleSizes(selector)).filter(([w, h]) => w < 44 || h < 44).map(([w, h]) => `${selector}:${w}x${h}`);
  };
  expect(await small("#explorerOpen")).toEqual([]);
  await page.locator("#explorerOpen").click();
  await expect(page.locator(".app")).not.toHaveClass(/sidebar-collapsed/);
  for (const selector of ["#sidebarToggle", ".global-explorer-mode", ".global-explorer-back", ".global-project-watch-filter"]) expect(await small(selector), selector).toEqual([]);
  await page.locator("#sidebarToggle").click();
  await expect(page.locator(".app")).toHaveClass(/sidebar-collapsed/);
  await page.locator("#settingsButton").click();
  await expect(page.locator("#settingsCard")).toBeVisible();
  // The selection bar is hidden in the Hub; the remove buttons of the settings editors are the visible .selection-action.
  // Nested editors render lazily: open every disclosure until a .selection-action is visible.
  for (let attempt = 0; attempt < 4 && !(await visibleSizes(".selection-action")).length; attempt += 1) {
    await page.evaluate(() => document.querySelectorAll("#settingsCard details").forEach((node) => { node.open = true; }));
    await page.waitForTimeout(500);
  }
  const tabs = page.locator("#settingsCard [role=tab]");
  for (let index = 0, count = await tabs.count(); index < count && !(await visibleSizes(".selection-action")).length; index += 1) {
    await tabs.nth(index).click();
    await page.evaluate(() => document.querySelectorAll("#settingsCard details").forEach((node) => { node.open = true; }));
    await page.waitForTimeout(500);
  }
  for (const selector of [".selection-action", ".project-priority-actions button", ".settings-concept-help-button"]) expect(await small(selector), selector).toEqual([]);
});

test("@layout the Keep Shared/Local buttons reach 44px and the Explorer button fits the dock at 800px", async ({ page }) => {
  await openAtlas(page, 800, 900, "&explorer=collapsed");
  const dock = await page.evaluate(() => ({ button: document.querySelector("#explorerOpen").getBoundingClientRect().toJSON(), dock: document.querySelector(".workspace-dock").getBoundingClientRect().toJSON() }));
  expect(dock.button.top).toBeGreaterThanOrEqual(dock.dock.top - 0.5);
  expect(dock.button.bottom).toBeLessThanOrEqual(dock.dock.bottom + 0.5);
  // Inject the real warning markup (the Hub fixture has no hybrid project) to measure the real CSS.
  await page.evaluate(() => { const warning = renderContextRoomModeWarning({ id: "x", title: "X", mode: "hybrid" }); const holder = document.createElement("div"); holder.id = "modePromptProbe"; holder.innerHTML = warning; document.body.append(holder); });
  const sizes = await page.evaluate(() => [...document.querySelectorAll("#modePromptProbe [data-context-room-mode-prompt]")].map((node) => { const r = node.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  expect(sizes.length).toBe(2);
  for (const [w, h] of sizes) { expect(w).toBeGreaterThanOrEqual(44); expect(h).toBeGreaterThanOrEqual(44); }
});

test("@layout at 1440px the Projects list shows four projects without clipping the last", async ({ page }) => {
  await openAtlas(page, 1440, 900, "&explorer=expanded");
  await page.evaluate(() => { const list = document.querySelector(".context-hub-home-projects"); const row = list.querySelector(".context-hub-home-project"); while (list.children.length < 4) list.append(row.cloneNode(true)); });
  const list = page.locator(".context-hub-home-projects");
  await expect(list).toBeVisible();
  const sizes = await list.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
});
