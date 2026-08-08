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
  if (await page.evaluate(() => window.innerWidth) > LAYOUT_CONTRACT.breakpoints.drawerMax) return;
  const app = page.locator(".app");
  const needsClosing = !await app.evaluate((node) => node.classList.contains("sidebar-collapsed"));
  if (needsClosing) await page.locator("#sidebarToggle").click();
  await expect(app).toHaveClass(/sidebar-collapsed/);
  if (needsClosing) {
    // Closing the responsive drawer intentionally restores focus on the next
    // animation frame. Let that handoff finish before testing another control.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}

async function openSettings(page) {
  await page.locator("#settingsButton").click();
  await expect(page.locator("#settingsPage")).toBeVisible();
}

async function emulateDesktopBrowserZoom(page, factor) {
  const baseline = await page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    layoutViewportWidth: window.innerWidth,
    layoutViewportHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    visualViewportScale: window.visualViewport?.scale || 1,
  }));
  const session = await page.context().newCDPSession(page);
  const zoomedViewport = {
    width: Math.ceil(baseline.layoutViewportWidth / factor),
    height: Math.ceil(baseline.layoutViewportHeight / factor),
  };

  // Chromium browser zoom keeps the physical screen fixed while reducing the
  // layout viewport and increasing the CSS pixel density by the same factor.
  // CDP reproduces those native metrics; a plain viewport resize or CSS zoom
  // would fail the assertions below.
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: zoomedViewport.width,
    height: zoomedViewport.height,
    deviceScaleFactor: baseline.devicePixelRatio * factor,
    mobile: false,
    screenWidth: baseline.screenWidth,
    screenHeight: baseline.screenHeight,
  });

  await expect.poll(async () => page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    layoutViewportWidth: window.innerWidth,
    layoutViewportHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    visualViewportScale: window.visualViewport?.scale || 1,
    inlineRootZoom: document.documentElement.style.zoom,
  }))).toEqual({
    devicePixelRatio: baseline.devicePixelRatio * factor,
    layoutViewportWidth: zoomedViewport.width,
    layoutViewportHeight: zoomedViewport.height,
    screenWidth: baseline.screenWidth,
    screenHeight: baseline.screenHeight,
    visualViewportScale: 1,
    inlineRootZoom: "",
  });

  return {
    baseline,
    zoomedViewport,
    async restore() {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: baseline.layoutViewportWidth,
        height: baseline.layoutViewportHeight,
        deviceScaleFactor: baseline.devicePixelRatio,
        mobile: false,
        screenWidth: baseline.screenWidth,
        screenHeight: baseline.screenHeight,
      });
      await session.detach();
    },
  };
}

async function expectInsideNativeViewport(page, selector) {
  const geometry = await page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      rendered: !node.hidden && style.display !== "none" && style.visibility !== "hidden",
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(geometry.rendered).toBe(true);
  expect(geometry.rect.left).toBeGreaterThanOrEqual(0);
  expect(geometry.rect.top).toBeGreaterThanOrEqual(0);
  expect(geometry.rect.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.rect.bottom).toBeLessThanOrEqual(geometry.viewport.height);
}

async function makeProposalTerminalReady(page) {
  await page.evaluate(() => {
    cancelBackgroundRefresh();
    state.runtimeEventSource?.close();
    state.runtimeEventSource = null;
    state.runtimeEventsConnected = true;
    window.clearInterval(state.runtimeFallbackTimer);
    state.runtimeFallbackTimer = null;
  });
  await expect.poll(async () => page.evaluate(() => Boolean(state.refreshInFlight || state.reportsRefreshInFlight))).toBe(false);
  await page.evaluate(() => {
    const review = state.sharedContext?.review || {};
    const reviewedPaths = review.proposalFiles?.length ? [...review.proposalFiles] : ["docs/README.md"];
    state.files = reviewedPaths.map((path) => ({ path, label: path.split("/").at(-1) || path }));
    state.sharedContext = {
      ...(state.sharedContext || {}),
      mode: "review",
      accepted: null,
      rejected: null,
      acceptedChangesRemain: true,
      review: {
        ...review,
        projectId: review.projectId || "atlas",
        proposal: review.proposal || "proposal/atlas/layout-terminal-action",
        proposalHead: review.proposalHead || "0123456789abcdef0123456789abcdef01234567",
        defaultBranch: review.defaultBranch || "main",
        proposalFiles: reviewedPaths,
        proposalChanges: review.proposalChanges?.length
          ? review.proposalChanges
          : reviewedPaths.map((path) => ({ path, status: "M", reviewKind: "proposal-change" })),
      },
    };
    state.docqa = {
      ...(state.docqa || {}),
      queue: [],
      pendingPaths: [],
      reviewedPaths,
      summary: { ...(state.docqa?.summary || {}), needsReview: 0 },
    };
    state.proposalAuthorityStatus = "";
    state.proposalActionBusy = false;
    state.proposalActionError = "";
    showProposalReview();
  });
}

async function installTerminalReadyReportsFixture(page) {
  const reviewedPaths = await page.evaluate(() => {
    const proposalFiles = state.sharedContext?.review?.proposalFiles || [];
    return proposalFiles.length ? proposalFiles : ["projects/atlas/docs/README.md"];
  });
  const handler = async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        docqa: {
          generatedAt: new Date().toISOString(),
          queue: [],
          pendingPaths: [],
          reviewedPaths,
          summary: { needsReview: 0 },
        },
        doctor: { issues: [] },
        startupContext: [],
        startupSkills: [],
        startupHooks: [],
      }),
    });
  };
  await page.route("**/api/reports*", handler);
  return () => page.unroute("**/api/reports*", handler);
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

    if (width > LAYOUT_CONTRACT.breakpoints.mobileMax) {
      const browserZoom = await emulateDesktopBrowserZoom(page, 2);
      try {
        await audit(page, testInfo, `native-browser-zoom-200-${width}`);
      } finally {
        await browserZoom.restore();
      }
    }

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
    const removeTerminalReadyReportsFixture = await installTerminalReadyReportsFixture(page);
    await proposal.click();
    await expect(page).toHaveURL((url) => (
      url.port !== new URL(data.origin).port
      && url.searchParams.get("view") === "proposal"
    ));
    await waitForBoot(page);
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    await audit(page, testInfo, `proposal-${width}`);

    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      const { expectedProposalHead } = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: `layout-challenge-${width}`,
          action: "accept",
          authorityId: "layout-authority",
          proposalHead: expectedProposalHead,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await makeProposalTerminalReady(page);
    const terminalAction = page.locator("#proposalDockAccept");
    await expect(terminalAction).toBeVisible();
    await expect(terminalAction).toHaveAccessibleName("Put on main");
    await expect(terminalAction).toBeInViewport({ ratio: 1 });
    await audit(page, testInfo, `proposal-terminal-${width}`);

    const browserZoom = width > LAYOUT_CONTRACT.breakpoints.mobileMax
      ? await emulateDesktopBrowserZoom(page, 2)
      : null;
    try {
      if (browserZoom) {
        await closeExplorerDrawer(page);
      }
      if (browserZoom) await expectInsideNativeViewport(page, "#proposalDockAccept");
      else await expect(terminalAction).toBeInViewport({ ratio: 1 });
      await audit(
        page,
        testInfo,
        browserZoom ? `proposal-terminal-native-browser-zoom-200-${width}` : `proposal-terminal-mobile-viewport-${width}`,
      );
      const terminalControl = page.locator("#proposalDockAccept");
      await expect(terminalControl).toBeVisible();
      if (browserZoom) {
        const terminalLabel = () => terminalControl.evaluate((node) => node.getAttribute("aria-label") || node.textContent?.trim() || "");
        expect(await terminalLabel()).toBe("Put on main");
        await terminalControl.evaluate((node) => node.focus());
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("proposalDockAccept");
        expect(await terminalLabel()).toBe("Put on main");
      } else {
        await expect(terminalControl).toHaveAccessibleName("Put on main");
        await terminalControl.focus();
        await expect(terminalControl).toBeFocused();
      }
      await page.keyboard.press("Enter");
      const terminalDialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
      await expect(terminalDialog).toBeVisible();
      if (browserZoom) await expectInsideNativeViewport(page, ".confirm-dialog");
      else await expect(terminalDialog).toBeInViewport({ ratio: 1 });
      await audit(
        page,
        testInfo,
        browserZoom ? `proposal-terminal-dialog-native-browser-zoom-200-${width}` : `proposal-terminal-dialog-mobile-viewport-${width}`,
      );
      const cancelTerminalDecision = terminalDialog.getByRole("button", { name: "Cancel" });
      if (browserZoom) await expectInsideNativeViewport(page, ".confirm-dialog [data-confirm-cancel]");
      else {
        await cancelTerminalDecision.scrollIntoViewIfNeeded();
        await expect(cancelTerminalDecision).toBeInViewport({ ratio: 1 });
      }
      await cancelTerminalDecision.click();
    } finally {
      await browserZoom?.restore();
      await removeTerminalReadyReportsFixture();
    }
  }
});

test("@layout layout contract and responsive tiers are internally coherent", async () => {
  expect(LAYOUT_CONTRACT.breakpoints).toEqual({ mobileMax: 639, drawerMax: 980, desktopMin: 981, wideInspectorMin: 1280 });
  expect(LAYOUT_CONTRACT.spacing.allowed).toEqual([4, 8, 12, 16, 20, 24]);
});
