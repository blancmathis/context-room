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

test("@layout below 640px choosing a file in the Explorer closes the drawer", async ({ page }) => {
  await openAtlas(page, 390, 844);
  const docs = page.locator('[data-global-project-folder="docs"]').first();
  await expect(docs).toBeVisible();
  if (await docs.getAttribute("aria-expanded") !== "true") await docs.click();
  await page.locator('[data-global-project-file="docs/README.md"]').first().click();
  await expect(page).toHaveURL((url) => url.searchParams.get("file") === "docs/README.md");
  await expect(page.locator(".app")).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator(".app")).not.toHaveClass(/explorer-expanded/);
  await expect(page.locator("#viewer")).toBeVisible();
});

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
  const small = async (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((node) => node.getClientRects().length && !node.closest("[hidden]")).map((node) => { const r = node.getBoundingClientRect(); return `${sel}:${Math.round(r.width)}x${Math.round(r.height)}`; }).filter((entry) => { const [w, h] = entry.split(":")[1].split("x").map(Number); return w < 44 || h < 44; }), selector);
  expect(await small("#explorerOpen")).toEqual([]);
  await page.locator("#explorerOpen").click();
  await expect(page.locator(".app")).not.toHaveClass(/sidebar-collapsed/);
  for (const selector of ["#sidebarToggle", ".global-explorer-mode", ".global-explorer-back", ".watch-filter", ".global-project-watch-filter"]) expect(await small(selector), selector).toEqual([]);
  await page.locator("#sidebarToggle").click();
  await expect(page.locator(".app")).toHaveClass(/sidebar-collapsed/);
  await page.locator("#settingsButton").click();
  await expect(page.locator("#settingsCard")).toBeVisible();
  for (const selector of [".project-priority-actions button", ".settings-concept-help-button"]) expect(await small(selector), selector).toEqual([]);
});

test("@layout at 1440px the Projects list shows four projects without clipping the last", async ({ page }) => {
  await openAtlas(page, 1440, 900, "&explorer=expanded");
  await page.evaluate(() => { const list = document.querySelector(".context-hub-home-projects"); const row = list.querySelector(".context-hub-home-project"); while (list.children.length < 4) list.append(row.cloneNode(true)); });
  const list = page.locator(".context-hub-home-projects");
  await expect(list).toBeVisible();
  const sizes = await list.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
});
