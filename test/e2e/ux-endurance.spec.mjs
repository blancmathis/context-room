import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room UX fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function workspaceId(url) {
  return new URL(url).searchParams.get("workspace") || "";
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting/);
  await expect(page.locator("body")).not.toHaveClass(/app-recovery/);
  await expect.poll(async () => {
    const diagnostics = await page.locator("body").getAttribute("data-workspace-diagnostics");
    return JSON.parse(diagnostics || "{}").phase || "";
  }, { message: "Workspace boot reaches ready" }).toBe("ready");
  const diagnostics = JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}");
  expect(diagnostics.bootCount).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const settled = JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}");
  expect(settled.bootCount).toBe(diagnostics.bootCount);
  expect(settled.clientInstanceId).toBe(diagnostics.clientInstanceId);
}

async function waitForReady(page) {
  await waitForBoot(page);
  await expect(page.locator("#reviewQueueHeading")).toBeVisible();
}

function explorerOpenControl(page) {
  return page.locator("#explorerOpen:visible, #sidebarToggle:visible").first();
}

async function ensureExplorerOpen(page) {
  const app = page.locator(".app");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) {
    await explorerOpenControl(page).click();
  }
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
}

async function closeExplorerDrawer(page) {
  if ((page.viewportSize()?.width || 0) > 980) return;
  const app = page.locator(".app");
  if (!await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) {
    await page.locator("#sidebarToggle").click();
  }
  await expect(app).toHaveClass(/sidebar-collapsed/);
}

async function openProject(page, projectTitle) {
  const startedAt = performance.now();
  await ensureExplorerOpen(page);
  const projectsButton = page.locator('[data-global-explorer-mode="projects"]');
  await projectsButton.click();
  const currentScope = page.locator("#globalExplorerScope strong");
  if (await currentScope.isVisible().catch(() => false)) {
    if ((await currentScope.textContent())?.trim() === projectTitle) return performance.now() - startedAt;
    const back = page.locator("[data-global-explorer-back]");
    if (await back.isVisible().catch(() => false)) await back.click();
  }
  const row = page.locator("a.global-project-row", { hasText: projectTitle }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#globalExplorerScope strong")).toHaveText(projectTitle);
  return performance.now() - startedAt;
}

async function openProjectFile(page, filePath) {
  const startedAt = performance.now();
  const segments = filePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const folderPath = segments.slice(0, index).join("/");
    const folderSelector = `[data-global-project-folder="${folderPath}"]`;
    await expect.poll(async () => {
      const folder = page.locator(folderSelector).first();
      if (!await folder.count()) return "missing";
      if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
      return await page.locator(folderSelector).first().getAttribute("aria-expanded");
    }, { message: `Expand ${folderPath} in Explorer` }).toBe("true");
  }
  const row = page.locator(`[data-global-project-file="${filePath}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#workspaceTitle")).toContainText(filePath.split("/").pop());
  await expect(page.locator("#viewer")).toBeVisible();
  return performance.now() - startedAt;
}

async function openSettings(page, section = "") {
  await page.locator("#settingsButton").click();
  await expect(page).toHaveURL(/(?:\?|&)view=settings(?:&|$)/);
  await waitForBoot(page);
  await expect(page.locator("#settingsPage")).toBeVisible();
  if (!section) return;
  const target = page.locator(`[data-settings-section-target="${section}"]`);
  await expect(target).toBeVisible();
  await target.click();
  await expect(target).toHaveAttribute("aria-selected", "true");
}

async function openHome(page) {
  await page.locator("#brandHome").click();
  await expect(page).toHaveURL(/(?:\?|&)view=hub(?:&|$)/);
  await waitForReady(page);
}

async function selectWorktree(page, index) {
  const select = page.getByLabel("Choose worktree");
  if (!await select.isVisible().catch(() => false)) return;
  const values = await select.locator("option").evaluateAll((options) => options.map((option) => option.value));
  if (values.length < 2) return;
  const value = values[index % values.length];
  if (await select.inputValue() === value) return;
  await select.selectOption(value);
  await expect(page).toHaveURL((url) => url.searchParams.get("project") === value);
  await waitForBoot(page);
  await expect(page.getByLabel("Choose worktree")).toHaveValue(value);
}

async function toggleSettingsDisclosure(page) {
  const summary = page.locator("#settings-content details summary").first();
  if (!await summary.isVisible().catch(() => false)) return;
  await summary.click();
  await summary.click();
}

async function collectMetrics(page, requestCount) {
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  await client.send("HeapProfiler.collectGarbage");
  const result = await client.send("Performance.getMetrics");
  await client.detach();
  const metrics = Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  const workspaceCount = await page.evaluate(async () => (await (await fetch("/api/workspaces")).json()).workspaces.length);
  return {
    heap: metrics.JSHeapUsedSize || 0,
    documents: metrics.Documents || 0,
    nodes: metrics.Nodes || 0,
    domNodes: await page.locator("*").count(),
    requests: requestCount(),
    workspaceCount,
  };
}

function assertStableMetrics(baseline, final) {
  expect(final.heap).toBeLessThan(baseline.heap * 1.6 + 12_000_000);
  expect(final.nodes).toBeLessThan(baseline.nodes * 1.35 + 1_000);
  expect(final.domNodes).toBeLessThan(baseline.domNodes * 1.35 + 1_000);
  expect(final.documents).toBeLessThanOrEqual(baseline.documents + 2);
  expect(final.workspaceCount).toBeLessThanOrEqual(baseline.workspaceCount + 1);
}

function assertNoSustainedGrowth(samples, key, toleratedGrowth) {
  if (samples.length < 4) return;
  let streak = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index][key] > samples[index - 1][key] + toleratedGrowth) streak += 1;
    else streak = 0;
    expect(streak, `${key} grew across four consecutive checkpoints`).toBeLessThan(4);
  }
}

function attachFailureGuards(page) {
  const failures = [];
  let requests = 0;
  page.on("request", () => { requests += 1; });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) failures.push(`http ${response.status()}: ${response.url()}`);
  });
  return { failures, requestCount: () => requests };
}

async function exerciseResponsiveExplorer(page) {
  for (const width of [390, 640, 768, 980, 981, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: width <= 640 ? 844 : 900 });
    await ensureExplorerOpen(page);
    await page.locator("#sidebarToggle").click();
    const openControl = explorerOpenControl(page);
    await expect(openControl).toBeVisible();
    await expect(openControl).toHaveAttribute("aria-label", "Open explorer");
    await expect(page.locator("#brandHome")).toBeVisible();
    const overlap = await openControl.evaluate((toggle) => {
      const brand = document.querySelector("#brandHome")?.getBoundingClientRect();
      const control = toggle.getBoundingClientRect();
      if (!brand) return false;
      return !(brand.right <= control.left || brand.left >= control.right || brand.bottom <= control.top || brand.top >= control.bottom);
    });
    expect(overlap).toBe(false);
    const hiddenExplorerIsFocusable = await page.evaluate(() => {
      const sidebar = document.querySelector(".app > aside");
      const target = sidebar?.querySelector("button, a, input, select, textarea, [tabindex]");
      if (!sidebar || (!sidebar.inert && !sidebar.hidden) || !target) return false;
      target.focus();
      return sidebar.contains(document.activeElement);
    });
    expect(hiddenExplorerIsFocusable).toBe(false);
    await openControl.click();
    if (width <= 980) {
      await expect(page.locator("#sidebarToggle")).toBeFocused();
      await expect(page.locator(".app > main")).toHaveAttribute("inert", "");
      await expect(page.locator(".app > main")).toHaveAttribute("aria-hidden", "true");
      await page.keyboard.press("Escape");
      await expect(page.locator(".app")).toHaveClass(/sidebar-collapsed/);
      await expect(page.locator(".app > main")).not.toHaveAttribute("inert", "");
      await expect(openControl).toBeFocused();
      await openControl.click();
    }
    await expect(page.locator('[data-global-explorer-mode="projects"]')).toHaveAttribute("aria-pressed", /true|false/);
    if (width === 390) {
      const compactControls = page.locator("#sidebarToggle, #brandHome, [data-global-explorer-mode=projects]");
      for (let index = 0; index < await compactControls.count(); index += 1) {
        const box = await compactControls.nth(index).boundingBox();
        expect(box?.height || 0).toBeGreaterThanOrEqual(40);
      }
      await expect(page.locator("#status")).not.toHaveCSS("display", "none");
    }
  }
}

async function assertMobileWorkbenchLayout(page, { fileUrl, settingsUrl }) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(settingsUrl);
  await waitForBoot(page);
  await expect(page.locator("#settingsPage")).toBeVisible();
  const footer = page.locator(".settings-footer");
  await expect(footer).toBeVisible();
  const footerBox = await footer.boundingBox();
  expect(footerBox?.y || 0).toBeGreaterThanOrEqual(0);
  expect((footerBox?.y || 0) + (footerBox?.height || 0)).toBeLessThanOrEqual(844);

  await page.goto(fileUrl);
  await waitForBoot(page);
  await expect(page.locator("#viewer")).toBeVisible();
  const layout = await page.evaluate(() => {
    const brand = document.querySelector("#brandHome")?.getBoundingClientRect();
    const brandLabel = document.querySelector("#brandHome strong")?.getBoundingClientRect();
    const header = document.querySelector(".file-panel > header")?.getBoundingClientRect();
    const content = document.querySelector(".file-panel .doc-content, .file-panel .doc-editor")?.getBoundingClientRect();
    return {
      brandFits: Boolean(brand && brandLabel && brandLabel.right <= brand.right + 1),
      fileHeaderFits: Boolean(header && header.right <= window.innerWidth + 1),
      fileContentStartsAfterHeader: Boolean(header && content && content.top >= header.bottom - 1),
    };
  });
  expect(layout).toEqual({ brandFits: true, fileHeaderFits: true, fileContentStartsAfterHeader: true });
}

async function expectHorizontalPadding(page, selector, expected, { first = false } = {}) {
  const locator = first ? page.locator(`${selector}:visible`).first() : page.locator(selector);
  await expect(locator).toBeVisible();
  const expectedPadding = typeof expected === "number" ? { left: expected, right: expected } : expected;
  await expect(locator).toHaveCSS("padding-left", `${expectedPadding.left}px`);
  await expect(locator).toHaveCSS("padding-right", `${expectedPadding.right}px`);
  const insideViewport = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
  });
  expect(insideViewport).toBe(true);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}

async function expectChildrenInsideContentBox(page, selector) {
  const overflow = await page.locator(selector).evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const left = rect.left + Number.parseFloat(style.paddingLeft);
    const right = rect.right - Number.parseFloat(style.paddingRight);
    return [...node.children]
      .filter((child) => child.getClientRects().length > 0)
      .filter((child) => !["absolute", "fixed"].includes(getComputedStyle(child).position))
      .map((child) => {
        const childRect = child.getBoundingClientRect();
        return { left: childRect.left - left, right: childRect.right - right };
      })
      .filter(({ left: leftDelta, right: rightDelta }) => leftDelta < -1 || rightDelta > 1);
  });
  expect(overflow, `${selector} keeps every direct child inside its content box`).toEqual([]);
}

async function assertWorkbenchGutters(page, data, width) {
  const compact = width <= 639;
  const gutter = compact ? 12 : 20;
  await page.setViewportSize({ width, height: compact ? 844 : 900 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForReady(page);
  await ensureExplorerOpen(page);
  await expectHorizontalPadding(page, ".app > aside", 8);
  await expectChildrenInsideContentBox(page, ".app > aside");
  await closeExplorerDrawer(page);

  await expectHorizontalPadding(page, ".workspace-dock", width <= 980 ? { left: 48, right: 12 } : 12);
  await expectHorizontalPadding(page, "#reviewQueuePanel > header", gutter);
  await expectHorizontalPadding(page, ".context-room-review-toolbar", gutter);
  await expectHorizontalPadding(page, "#reviewQueue :is(.context-room-proposal-row, .context-hub-review-item, .review-item)", gutter, { first: true });
  const hubFolders = page.locator("#hubFolders");
  if (await hubFolders.evaluate((node) => node.childElementCount > 0)) {
    await expectHorizontalPadding(page, "#hubFolders", gutter);
  } else {
    await expect(hubFolders).toBeHidden();
  }
  const projectInspection = page.locator(".global-project-inspection");
  if (await projectInspection.isVisible().catch(() => false)) {
    const inspectorGutter = compact ? 12 : 16;
    await expectHorizontalPadding(page, "#contextHealthPanel > header", inspectorGutter);
    await expectHorizontalPadding(page, ".global-project-inspection", inspectorGutter);
    await expectChildrenInsideContentBox(page, ".global-project-inspection");
  }
  await expectNoHorizontalOverflow(page);

  await openSettings(page);
  await expectHorizontalPadding(page, "#settingsCard > .settings-page-header", gutter);
  const settingsSearch = page.locator("#settingsSearch");
  const settingsSearchGeometry = await settingsSearch.evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const icon = document.querySelector(".settings-search-icon");
    const iconRect = icon?.getBoundingClientRect();
    return {
      rightPadding: Number.parseFloat(style.paddingRight),
      insideViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      iconRight: iconRect ? Math.round(rect.right - iconRect.right) : -1,
      iconCenterDelta: iconRect ? Math.abs((rect.top + rect.height / 2) - (iconRect.top + iconRect.height / 2)) : Infinity,
    };
  });
  expect(settingsSearchGeometry.rightPadding).toBeGreaterThanOrEqual(38);
  expect(settingsSearchGeometry.iconRight).toBe(12);
  expect(settingsSearchGeometry.iconCenterDelta).toBeLessThanOrEqual(0.5);
  expect(settingsSearchGeometry.insideViewport).toBe(true);
  await expectHorizontalPadding(page, ".settings-section-head", gutter, { first: true });
  await expectHorizontalPadding(page, ".settings-section-body", gutter, { first: true });
  await expectNoHorizontalOverflow(page);

  const settingsTabs = page.locator("[data-settings-section-target]");
  for (let index = 0; index < await settingsTabs.count(); index += 1) {
    const tab = settingsTabs.nth(index);
    const section = await tab.getAttribute("data-settings-section-target");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const sectionGeometry = await page.evaluate((expectedGutter) => {
      const visible = (element) => element.getClientRects().length > 0;
      const horizontalPadding = (element) => {
        const style = getComputedStyle(element);
        return [Number.parseFloat(style.paddingLeft), Number.parseFloat(style.paddingRight)];
      };
      const surfacePadding = [...document.querySelectorAll(".settings-section-head, .settings-section-body, .settings-footer")]
        .filter(visible)
        .map(horizontalPadding);
      const clippedControls = [...document.querySelectorAll("#settings-content input, #settings-content select, #settings-content textarea, #settings-content button")]
        .filter(visible)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > window.innerWidth + 1;
        }).length;
      return {
        aligned: surfacePadding.every(([left, right]) => left === expectedGutter && right === expectedGutter),
        clippedControls,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, gutter);
    expect(sectionGeometry.aligned, `Settings ${section} uses the shared gutter`).toBe(true);
    expect(sectionGeometry.clippedControls, `Settings ${section} keeps controls in view`).toBe(0);
    expect(sectionGeometry.overflow, `Settings ${section} has no page overflow`).toBeLessThanOrEqual(1);
  }

  await ensureExplorerOpen(page);
  await openProjectFile(page, "docs/README.md");
  await closeExplorerDrawer(page);
  await expectHorizontalPadding(page, ".file-panel > header", gutter);
  await expectNoHorizontalOverflow(page);

  await page.locator("#contextPanelToggle").click();
  const inspectorGutter = compact ? 12 : 16;
  await expectHorizontalPadding(page, ".document-context-head", inspectorGutter);
  await expectHorizontalPadding(page, ".document-context-body", inspectorGutter);
  await expectNoHorizontalOverflow(page);
  await page.locator("#documentContextClose").click();

  await page.locator("#graphLocal").click();
  await expect(page.locator("#graphPage")).toBeVisible();
  await expectHorizontalPadding(page, ".graph-toolbar", gutter);
  await expectHorizontalPadding(page, ".graph-filterbar", gutter);
  const filterbar = await page.locator(".graph-filterbar").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { height: rect.height, singleRow: node.scrollHeight <= node.clientHeight + 1 };
  });
  expect(filterbar.height).toBeLessThanOrEqual(54);
  expect(filterbar.singleRow).toBe(true);
  await expectNoHorizontalOverflow(page);

  const themeGeometry = await page.evaluate((expectedGutter) => {
    const root = document.documentElement;
    const initialTheme = root.dataset.fileTheme;
    const initialMode = root.dataset.colorMode;
    const themes = ["context-room", "vscode-dark", "github-dark", "dracula", "solarized-dark", "light-plus"];
    const results = [];
    for (const theme of themes) {
      root.dataset.fileTheme = theme;
      root.dataset.colorMode = theme === "context-room" ? "dark" : initialMode;
      const toolbar = getComputedStyle(document.querySelector(".graph-toolbar"));
      results.push({ theme, left: Number.parseFloat(toolbar.paddingLeft), right: Number.parseFloat(toolbar.paddingRight) });
    }
    root.dataset.fileTheme = initialTheme;
    root.dataset.colorMode = initialMode;
    return results.map((entry) => ({ ...entry, aligned: entry.left === expectedGutter && entry.right === expectedGutter }));
  }, gutter);
  expect(themeGeometry.every(({ aligned }) => aligned), JSON.stringify(themeGeometry)).toBe(true);

  if (width === 1440 || width === 390) {
    await page.goto(`${data.origin}/?hub=1&view=hub`);
    await waitForReady(page);
    await closeExplorerDrawer(page);

    await page.locator("#contextRoomReviewProjectFilter").click();
    const picker = "#contextHubProjectPicker:not([hidden])";
    await expectHorizontalPadding(page, `${picker} .context-hub-project-picker-head`, compact ? 12 : 20);
    await expectHorizontalPadding(page, `${picker} .context-hub-project-picker-search-wrap`, compact ? 12 : 20);
    await expectHorizontalPadding(page, `${picker} .context-hub-project-picker-footer`, compact ? 12 : 20);
    await expectChildrenInsideContentBox(page, `${picker} .context-hub-project-picker-dialog`);
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.showConfirmDialog({
      title: "Spacing check",
      body: "Keep dialog content aligned at every viewport.",
      confirmVariant: "secondary",
    }));
    await expectHorizontalPadding(page, ".confirm-backdrop", compact ? 12 : 20);
    await expectHorizontalPadding(page, ".confirm-dialog", compact ? 12 : 20);
    await expectChildrenInsideContentBox(page, ".confirm-dialog");
    await page.keyboard.press("Escape");

    const proposal = page.locator('[data-context-room-review-entry]:has([data-source="shared"])').first();
    await proposal.click();
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    await expectHorizontalPadding(page, ".proposal-review-head", gutter);
    await expectHorizontalPadding(page, ".proposal-review-meta", gutter);
    await expectHorizontalPadding(page, ".proposal-review-file", gutter, { first: true });
    await expectNoHorizontalOverflow(page);
  }
}

test("@smoke Context Room keeps its critical workspace state stable", async ({ page, context }, testInfo) => {
  const data = fixture();
  const guard = attachFailureGuards(page);
  await page.clock.setFixedTime(new Date());
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  await waitForReady(page);

  const proposal = page.locator('[data-context-room-review-entry]:has([data-source="shared"])').first();
  await expect(proposal).toBeVisible();
  await proposal.click();
  await expect(page).toHaveURL((url) => url.port !== new URL(data.origin).port
    && url.searchParams.get("view") === "proposal"
    && Boolean(url.searchParams.get("returnTo")));
  await expect(page.locator("#proposalReviewPage")).toBeVisible();
  await expect(page.locator("#proposalDockReject")).toBeVisible();
  await openHome(page);

  await openProject(page, "Atlas");
  const atlasWorkspace = workspaceId(page.url());
  expect(atlasWorkspace).toBeTruthy();
  const atlasProject = new URL(page.url()).searchParams.get("project");

  await page.locator('[data-global-explorer-mode="computer"]').click();
  await expect(page.locator('[data-global-explorer-mode="computer"]')).toHaveClass(/active/);
  await page.locator('[data-global-explorer-mode="projects"]').click();
  await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");
  expect(new URL(page.url()).searchParams.get("project")).toBe(atlasProject);

  await openProjectFile(page, "docs/README.md");
  await ensureExplorerOpen(page);
  const related = page.locator('[data-explorer-document-view="related"]');
  await related.click();
  await expect(related).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-explorer-document-view="location"]').click();
  await closeExplorerDrawer(page);
  const fileUrl = page.url();
  await openHome(page);
  await openSettings(page);
  const settingsUrl = page.url();
  await page.goto(fileUrl);
  await expect(page.locator("body")).not.toHaveClass(/app-booting/);
  await page.goto(settingsUrl);
  await expect(page.locator("#settingsPage")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#workspaceTitle")).toContainText("README.md");

  const duplicate = await context.newPage();
  const duplicateGuard = attachFailureGuards(duplicate);
  await duplicate.goto(page.url());
  await expect(duplicate.locator("body")).not.toHaveClass(/app-booting/);
  await expect.poll(() => workspaceId(duplicate.url())).not.toBe(atlasWorkspace);
  await duplicate.close();

  await exerciseResponsiveExplorer(page);
  await assertMobileWorkbenchLayout(page, { fileUrl, settingsUrl });
  await page.reload();
  await waitForBoot(page);
  await expect(page.locator("#workspaceTitle")).toContainText("README.md");
  expect(workspaceId(page.url())).toBe(atlasWorkspace);

  expect(guard.failures, guard.failures.join("\n")).toEqual([]);
  expect(duplicateGuard.failures, duplicateGuard.failures.join("\n")).toEqual([]);
  await testInfo.attach("workspace-diagnostics", {
    body: await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}",
    contentType: "application/json",
  });
});

test("@smoke an exact agent command changes only the targeted Workspace", async ({ page, context }) => {
  const data = fixture();
  const companion = await context.newPage();
  await Promise.all([
    page.goto(`${data.origin}/?hub=1&view=hub&label=primary`),
    companion.goto(`${data.origin}/?hub=1&view=hub&label=companion`),
  ]);
  await Promise.all([waitForReady(page), waitForReady(companion)]);

  const primaryWorkspace = workspaceId(page.url());
  const companionWorkspace = workspaceId(companion.url());
  expect(primaryWorkspace).toBeTruthy();
  expect(companionWorkspace).toBeTruthy();
  expect(companionWorkspace).not.toBe(primaryWorkspace);

  const response = await page.request.post(`${data.origin}/api/workspaces/${companionWorkspace}/command`, {
    data: {
      id: "e2e-exact-workspace-command",
      action: "navigate",
      view: "settings",
      settingsSection: "preferences",
    },
  });
  expect(response.ok()).toBe(true);

  await expect(companion).toHaveURL(/(?:\?|&)view=settings(?:&|$)/);
  await expect(companion.locator("#settingsPage")).toBeVisible();
  await expect(page).toHaveURL(/(?:\?|&)view=hub(?:&|$)/);
  await expect(page.locator("#home")).toBeVisible();
  expect(workspaceId(page.url())).toBe(primaryWorkspace);
  expect(workspaceId(companion.url())).toBe(companionWorkspace);
});

test("@smoke an agent command opens the requested proposal file", async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&view=hub&label=proposal-target`);
  await waitForReady(page);
  const targetWorkspace = workspaceId(page.url());
  const roomPort = new URL(data.origin).port;

  const response = await page.request.post(`${data.origin}/api/workspaces/${targetWorkspace}/command`, {
    data: {
      id: "e2e-proposal-file-command",
      action: "navigate",
      view: "proposal",
      projectId: "atlas",
      proposal: data.shared.proposal,
      path: "projects/atlas/docs/README.md",
    },
  });
  expect(response.ok()).toBe(true);

  await expect(page).toHaveURL((url) => url.port !== roomPort && url.searchParams.get("file") === "projects/atlas/docs/README.md");
  await waitForBoot(page);
  await expect(page.locator("#viewer")).toBeVisible();
});

test("@smoke workbench gutters stay aligned on desktop and mobile", async ({ page }) => {
  const data = fixture();
  for (const width of [390, 640, 980, 981, 1024, 1440]) await assertWorkbenchGutters(page, data, width);
});

test("@soak repeated multi-day navigation does not accumulate workspace or browser state", async ({ page }, testInfo) => {
  test.setTimeout(Number(process.env.CONTEXT_ROOM_UX_SOAK_TIMEOUT_MS || 30 * 60_000));
  const data = fixture();
  const guard = attachFailureGuards(page);
  const companion = await page.context().newPage();
  const companionGuard = attachFailureGuards(companion);
  const realStartedAt = Date.now();
  const simulatedStart = Date.now();
  await page.clock.install({ time: new Date(simulatedStart) });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForReady(page);
  await ensureExplorerOpen(page);
  await openProjectFile(page, "docs/README.md");
  await companion.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.beacon.id)}&view=hub`);
  await waitForReady(companion);

  for (let warmup = 0; warmup < 2; warmup += 1) {
    await openHome(page);
    await openProject(page, warmup % 2 ? "Atlas" : "Beacon");
  }
  await openProject(page, "Atlas");
  await openProjectFile(page, "docs/README.md");
  const baseline = await collectMetrics(page, guard.requestCount);
  const checkpoints = [baseline];
  const timings = { project: [], file: [] };

  const cycleOverride = Number(process.env.CONTEXT_ROOM_UX_SOAK_CYCLES || 0);
  const durationMs = Math.max(60_000, Number(process.env.CONTEXT_ROOM_UX_SOAK_DURATION_MS || 15 * 60_000));
  let cycle = 0;
  while (cycleOverride ? cycle < Math.max(4, cycleOverride) : Date.now() - realStartedAt < durationMs) {
    await page.clock.setSystemTime(new Date(simulatedStart + cycle * 86_400_000));
    await openHome(page);
    timings.project.push(await openProject(page, cycle % 2 ? "Beacon" : "Atlas"));
    if (cycle % 2 === 0) await selectWorktree(page, cycle / 2);
    if (cycle % 2) timings.file.push(await openProjectFile(page, "docs/runbook.md"));
    else timings.file.push(await openProjectFile(page, cycle % 3 ? "docs/operations.md" : "docs/README.md"));

    await page.locator("#graphLocal").click();
    await expect(page.locator("#graphPage")).toBeVisible();
    await openHome(page);
    await openSettings(page, "preferences");
    await toggleSettingsDisclosure(page);
    await openHome(page);

    if (cycle % 4 === 0) {
      await page.reload();
      await waitForReady(page);
    }
    if (cycle % 3 === 0) {
      await openHome(companion);
      await openProject(companion, cycle % 2 ? "Atlas" : "Beacon");
    }
    if (cycle % 4 === 3) checkpoints.push(await collectMetrics(page, guard.requestCount));
    expect(await page.locator("body").getAttribute("data-workspace-diagnostics")).not.toContain('"phase":"recovery"');
    expect(await companion.locator("body").getAttribute("data-workspace-diagnostics")).not.toContain('"phase":"recovery"');
    cycle += 1;
  }

  await openProject(page, "Atlas");
  await openProjectFile(page, "docs/README.md");
  const final = await collectMetrics(page, guard.requestCount);
  assertStableMetrics(baseline, final);
  checkpoints.push(final);
  assertNoSustainedGrowth(checkpoints, "heap", 1_000_000);
  assertNoSustainedGrowth(checkpoints, "nodes", 100);
  assertNoSustainedGrowth(checkpoints, "domNodes", 100);
  expect(final.requests - baseline.requests).toBeLessThan(cycle * 80 + 80);
  expect(Math.max(...timings.project)).toBeLessThan(2_000);
  expect(Math.max(...timings.file)).toBeLessThan(2_000);
  expect(guard.failures, guard.failures.join("\n")).toEqual([]);
  expect(companionGuard.failures, companionGuard.failures.join("\n")).toEqual([]);
  await companion.close();

  await testInfo.attach("ux-soak-metrics", {
    body: JSON.stringify({ cycles: cycle, elapsedMs: Date.now() - realStartedAt, baseline, checkpoints, final, timings }, null, 2),
    contentType: "application/json",
  });
});

test("@soak time-dependent reviews, drafts, and shared reconnect safely", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const data = fixture();
  const guard = attachFailureGuards(page);
  const simulatedStart = Date.now();
  await page.clock.install({ time: new Date(simulatedStart) });
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  await waitForReady(page);
  await expect(page.getByText("Clarify Atlas review", { exact: true })).toBeVisible();

  const localReview = page.locator('[data-context-room-review-entry]:has([data-source="local"])').first();
  const reviewId = await localReview.getAttribute("data-context-room-review-entry");
  const reviewTitle = (await localReview.locator(".review-title").textContent())?.trim() || "";
  expect(reviewId).toBeTruthy();
  await localReview.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze…" }).click();
  await page.getByRole("button", { name: "1 hour" }).click();
  await expect(page.locator(`[data-context-room-review-entry="${reviewId}"]`)).toHaveCount(0);
  await openSettings(page);
  const snoozed = page.locator('[data-settings-disclosure="review-snoozed"]');
  await snoozed.locator("summary").click();
  await expect(snoozed).toContainText(reviewTitle);
  await page.clock.fastForward(3_700_000);
  await expect(snoozed.locator("[data-settings-snoozed-row]")).toHaveCount(0);
  await openHome(page);
  await expect(page.locator(`[data-context-room-review-entry="${reviewId}"]`)).toBeVisible();

  await openProject(page, "Atlas");
  await openProjectFile(page, "docs/README.md");
  const healthResponse = await page.request.get(data.origin + "/api/health");
  const hostProjectId = healthResponse.headers()["x-context-room-project"];
  const sharedHeaders = {
    "content-type": "application/json",
    "x-context-room-project": hostProjectId,
    "x-context-room-target-project": data.projects.atlas.id,
  };
  const initiallyOnline = await page.request.post(data.origin + "/api/shared-context/refresh", { headers: sharedHeaders, data: {} });
  const initialSharedStatus = (await initiallyOnline.json()).status;
  expect(initialSharedStatus.online).toBe(true);
  fs.appendFileSync(data.shared.seed + "/projects/atlas/docs/README.md", "\nAccepted update for reconnect QA.\n", "utf8");
  execFileSync("git", ["add", "projects/atlas/docs/README.md"], { cwd: data.shared.seed, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Update accepted shared context"], { cwd: data.shared.seed, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: data.shared.seed, stdio: "ignore" });
  const updated = await page.request.post(data.origin + "/api/shared-context/refresh", { headers: sharedHeaders, data: {} });
  const updatedSharedStatus = (await updated.json()).status;
  expect(updatedSharedStatus.online).toBe(true);
  expect(updatedSharedStatus.revision).not.toBe(initialSharedStatus.revision);
  const offlineRemote = data.shared.remote + ".offline";
  fs.renameSync(data.shared.remote, offlineRemote);
  try {
    const offline = await page.request.post(data.origin + "/api/shared-context/refresh", { headers: sharedHeaders, data: {} });
    expect(offline.status()).toBe(200);
    expect((await offline.json()).status.online).toBe(false);
  } finally {
    fs.renameSync(offlineRemote, data.shared.remote);
  }
  const reconnected = await page.request.post(data.origin + "/api/shared-context/refresh", { headers: sharedHeaders, data: {} });
  expect((await reconnected.json()).status.online).toBe(true);

  await openHome(page);
  await openProject(page, "Beacon");
  await openProjectFile(page, "notes/scratch.md");
  const editor = page.locator("#docEditor");
  const saved = await editor.inputValue();
  const draft = saved + "\nUnsaved workspace draft.\n";
  await editor.fill(draft);
  const fileResponse = await page.request.get(data.origin + "/api/file?path=notes%2Fscratch.md", {
    headers: { "x-context-room-project": hostProjectId, "x-context-room-target-project": data.projects.beacon.id },
  });
  const fileState = await fileResponse.json();
  const writer = await page.context().newPage();
  await writer.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.beacon.id)}&view=hub`);
  await waitForReady(writer);
  await ensureExplorerOpen(writer);
  await openProjectFile(writer, "notes/scratch.md");
  await writer.locator("#docEditor").fill(saved + "\nExternal workspace update.\n");
  await writer.locator("[data-file-save]").click();
  await expect(writer.locator("[data-file-save]")).toBeDisabled();
  await expect(page.locator("[data-conflict-keep]")).toBeVisible();
  await expect(page.locator("#docEditor")).toHaveValue(draft);
  const staleWrite = await page.request.post(data.origin + "/api/file", {
    headers: {
      "content-type": "application/json",
      "x-context-room-project": hostProjectId,
      "x-context-room-target-project": data.projects.beacon.id,
    },
    data: { path: "notes/scratch.md", content: "Stale overwrite", expectedContentHash: fileState.contentHash },
  });
  expect(staleWrite.status()).toBe(409);
  expect((await staleWrite.json()).code).toBe("file_revision_conflict");
  await writer.close();
  expect(guard.failures, guard.failures.join("\n")).toEqual([]);

  await testInfo.attach("temporal-workflow", {
    body: JSON.stringify({ reviewId, reviewTitle, staleWrite: staleWrite.status(), sharedReconnected: true }, null, 2),
    contentType: "application/json",
  });
});
