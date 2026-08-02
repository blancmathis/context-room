import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { attachLayoutFailureArtifacts, collectLayoutViolations, LAYOUT_CONTRACT } from "./layout-contract.mjs";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room layout fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}").phase || "").toBe("ready");
}

async function ensureExplorerOpen(page) {
  const app = page.locator(".app");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) await page.locator("#explorerOpen:visible, #sidebarToggle:visible").first().click();
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
}

async function closeExplorerDrawer(page) {
  if ((page.viewportSize()?.width || 0) > LAYOUT_CONTRACT.breakpoints.drawerMax) return;
  const app = page.locator(".app");
  if (!await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) await page.locator("#sidebarToggle").click();
  await expect(app).toHaveClass(/sidebar-collapsed/);
}

async function openSettings(page) {
  await page.locator("#settingsButton").click();
  await expect(page.locator("#settingsPage")).toBeVisible();
}

async function audit(page, testInfo, label) {
  const report = await collectLayoutViolations(page, { label });
  if (process.env.CONTEXT_ROOM_LAYOUT_REPORT === "1" || report.violations.length) await attachLayoutFailureArtifacts(page, testInfo, report);
  expect(report.violations, JSON.stringify(report, null, 2)).toEqual([]);
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "The contract test owns its exact viewport matrix in one Chromium run.");
});

test("@layout executable geometry contract stays continuous at every breakpoint", async ({ page }, testInfo) => {
  const data = fixture();
  const widths = process.env.CONTEXT_ROOM_LAYOUT_WIDTHS
    ? process.env.CONTEXT_ROOM_LAYOUT_WIDTHS.split(",").map(Number).filter(Number.isFinite)
    : [390, 639, 640, 768, 900, 980, 981, 1024, 1280, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 639 ? 844 : 900 });
    await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
    await waitForBoot(page);
    await ensureExplorerOpen(page);
    await audit(page, testInfo, `home-${width}`);
    await closeExplorerDrawer(page);

    await openSettings(page);
    const tabs = page.locator("[data-settings-section-target]");
    for (let index = 0; index < await tabs.count(); index += 1) {
      const tab = tabs.nth(index);
      await tab.click();
      await tab.evaluate((node) => node.scrollIntoView({ block: "nearest", inline: "nearest" }));
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await audit(page, testInfo, `settings-${await tab.getAttribute("data-settings-section-target")}-${width}`);
    }
  }
});

test("@layout themes, zoom, files, graph, proposals, and dialogs preserve geometry", async ({ page }, testInfo) => {
  const data = fixture();
  const widths = process.env.CONTEXT_ROOM_LAYOUT_WIDTHS
    ? process.env.CONTEXT_ROOM_LAYOUT_WIDTHS.split(",").map(Number).filter(Number.isFinite)
    : [390, 1024, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
    await waitForBoot(page);
    await closeExplorerDrawer(page);
    for (const theme of ["context-room", "vscode-dark", "github-dark", "dracula", "solarized-dark", "light-plus"]) {
      await page.evaluate((nextTheme) => { document.documentElement.dataset.fileTheme = nextTheme; }, theme);
      await audit(page, testInfo, `theme-${theme}-${width}`);
    }

    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    await audit(page, testInfo, `zoom-200-${width}`);
    await page.evaluate(() => { document.documentElement.style.zoom = ""; });

    await page.locator("#contextRoomReviewProjectFilter").click();
    await audit(page, testInfo, `project-picker-${width}`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.showConfirmDialog({ title: "Geometry", body: "Verify dialog alignment.", confirmVariant: "secondary" }));
    await audit(page, testInfo, `dialog-${width}`);
    await page.keyboard.press("Escape");

    await ensureExplorerOpen(page);
    const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
    if (await docsFolder.count() && await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
    await page.locator('[data-global-project-file="docs/README.md"]').first().click();
    await expect(page.locator("#viewer")).toBeVisible();
    await closeExplorerDrawer(page);
    await audit(page, testInfo, `document-${width}`);
    if (width <= LAYOUT_CONTRACT.breakpoints.mobileMax) {
      await ensureExplorerOpen(page);
      if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
      await page.locator('[data-global-project-file="docs/operations.md"]').first().click();
      await expect(page.locator(".external-review-block-controls").first()).toBeVisible();
      await closeExplorerDrawer(page);
      await audit(page, testInfo, `document-review-${width}`);
    }
    await page.locator("#contextPanelToggle").click();
    await audit(page, testInfo, `document-context-${width}`);
    await page.locator("#documentContextClose").click();
    await page.locator("#graphLocal").click();
    await expect(page.locator("#graphPage")).toBeVisible();
    await audit(page, testInfo, `graph-${width}`);

    await page.goto(`${data.origin}/?hub=1&view=hub`);
    await waitForBoot(page);
    await closeExplorerDrawer(page);
    const proposal = page.locator('[data-context-room-review-entry]:has([data-source="shared"])').first();
    await proposal.click();
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    await audit(page, testInfo, `proposal-${width}`);
  }
});

test("@layout layout contract and responsive tiers are internally coherent", async () => {
  expect(LAYOUT_CONTRACT.breakpoints).toEqual({ mobileMax: 639, drawerMax: 980, desktopMin: 981, wideInspectorMin: 1280 });
  expect(LAYOUT_CONTRACT.spacing.allowed).toEqual([4, 8, 12, 16, 20, 24]);
});
