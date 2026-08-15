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
  await expect.poll(() => page.evaluate(() => state.runtimeEventsConnected)).toBe(true);
  const runtimeHubIsReady = () => page.evaluate(() => (!IS_GLOBAL_CONTEXT_ROOM && !IS_HOSTED_HUB) || Boolean(state.contextHub));
  await expect.poll(runtimeHubIsReady).toBe(true);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 175)));
  await expect.poll(runtimeHubIsReady).toBe(true);
  const hubRequestCounts = await page.evaluate(() => state.apiTrace.reduce((counts, entry) => {
    if (["/api/context-hub/catalog", "/api/context-hub/review-queue", "/api/context-hub/sections"].includes(entry.path)) {
      counts[entry.path] = (counts[entry.path] || 0) + 1;
    }
    return counts;
  }, {}));
  for (const [requestPath, count] of Object.entries(hubRequestCounts)) {
    expect(count, `${requestPath}: ${JSON.stringify(hubRequestCounts)}`).toBeLessThanOrEqual(6);
  }
}

async function waitForOpenedFile(page, path) {
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "file" && url.searchParams.get("file") === path);
  await waitForBoot(page);
  await expect(page.locator("body")).toHaveAttribute("data-last-file-open-path", path);
  await expect.poll(() => page.evaluate((expectedPath) => ({
    selected: state.selected || "",
    opening: state.openingFilePath || "",
    ready: state.fileContentReadyPath || "",
  }), path)).toEqual({ selected: path, opening: "", ready: "" });
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

async function expectTouchTarget(locator, label) {
  await expect(locator, label).toBeVisible();
  const subpixelTolerance = 0.01;
  await expect.poll(async () => {
    const rect = await locator.boundingBox();
    return Math.min(rect?.height || 0, rect?.width || 0) + subpixelTolerance;
  }, { message: `${label} touch target` }).toBeGreaterThanOrEqual(40);
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

// Hosted profile coverage adds proposals to this same Shared repository. Select
// the immutable setup revision so test ordering cannot change the review target.
async function exactSharedProposalEntry(page, { proposal, proposalHead }) {
  await expect.poll(() => page.evaluate(({ branch, head }) => contextHubReviewItems().filter((item) => (
    item.type === "shared"
    && item.branch === branch
    && item.head === head
  )).length, { branch: proposal, head: proposalHead })).toBe(1);
  const proposalId = await page.evaluate(({ branch, head }) => contextHubReviewItems().find((item) => (
    item.type === "shared"
    && item.branch === branch
    && item.head === head
  ))?.id || "", { branch: proposal, head: proposalHead });
  const entry = page.locator(`[data-context-room-review-entry=${JSON.stringify(proposalId)}]`);
  await expect(entry).toHaveCount(1);
  return entry;
}

async function audit(page, testInfo, label) {
  const report = await collectLayoutViolations(page, { label });
  if (process.env.CONTEXT_ROOM_LAYOUT_REPORT === "1" || report.violations.length) await attachLayoutFailureArtifacts(page, testInfo, report);
  expect(report.violations, JSON.stringify(report, null, 2)).toEqual([]);
}

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "The contract test owns its exact viewport matrix in one Chromium run.");
});

test("@layout runtime invalidation bursts coalesce without starving the Explorer", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "One browser proves the client-side runtime scheduler contract.");
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  const runtimeHubIsIdle = () => page.evaluate(() => state.contextHub?.freshness?.refreshing !== true
    && !state.contextHubSnapshotPollTimer
    && !state.runtimeContextHubRefreshPromise
    && !state.runtimeContextHubRefreshTimer
    && !state.runtimeContextHubRefreshPending
    && !state.runtimeContextHubRefreshGeneration);
  await expect.poll(runtimeHubIsIdle).toBe(true);

  const nextGeneration = await page.evaluate(() => api("/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((result) => result.freshness?.generatedAt || result.generatedAt || ""));
  expect(nextGeneration).not.toBe("");
  // The explicit refresh publishes its own runtime invalidation. Let that
  // generation converge before measuring the separate synthetic burst below.
  await expect.poll(runtimeHubIsIdle).toBe(true);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 200)));
  await expect.poll(runtimeHubIsIdle).toBe(true);
  await page.evaluate(() => {
    state.apiTrace = [];
    document.body.dataset.apiTrace = "[]";
  });

  let releaseSnapshot;
  let resolveSnapshot;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotCaptured = new Promise((resolve) => { resolveSnapshot = resolve; });
  let blockFirstSnapshot = true;
  await page.route("**/api/context-hub", async (route) => {
    if (!blockFirstSnapshot) {
      await route.continue();
      return;
    }
    blockFirstSnapshot = false;
    const response = await route.fetch();
    const body = await response.text();
    const snapshot = JSON.parse(body);
    resolveSnapshot(snapshot.freshness?.generatedAt || snapshot.generatedAt || "");
    await snapshotRelease;
    await route.fulfill({ response, body });
  });

  await page.evaluate(() => handleRuntimeEvent({
    cursor: state.runtimeEventCursor + 1,
    type: "state-invalidated",
    data: { source: "filesystem" },
  }));
  const capturedGeneration = await snapshotCaptured;
  expect(capturedGeneration).toBe(nextGeneration);
  await page.evaluate((generatedAt) => {
    let cursor = state.runtimeEventCursor + 1;
    for (let index = 0; index < 50; index += 1) {
      handleRuntimeEvent({ cursor: cursor++, type: "state-invalidated", data: { source: "context-hub-refresh", generatedAt } });
      handleRuntimeEvent({ cursor: cursor++, type: "state-invalidated", data: { source: "filesystem", path: `docs/${index}.md` } });
    }
  }, capturedGeneration);
  releaseSnapshot();

  await expect.poll(runtimeHubIsIdle).toBe(true);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 200)));
  await expect.poll(runtimeHubIsIdle).toBe(true);
  const requestCounts = await page.evaluate(() => state.apiTrace.reduce((counts, entry) => {
    if (["/api/context-hub", "/api/context-hub/catalog", "/api/context-hub/review-queue", "/api/context-hub/sections"].includes(entry.path)) {
      counts[entry.path] = (counts[entry.path] || 0) + 1;
    }
    return counts;
  }, {}));
  expect(requestCounts["/api/context-hub"] || 0).toBeGreaterThanOrEqual(1);
  expect(requestCounts["/api/context-hub"] || 0).toBeLessThanOrEqual(3);
  for (const path of ["/api/context-hub/catalog", "/api/context-hub/review-queue", "/api/context-hub/sections"]) expect(requestCounts[path] || 0).toBe(0);

  const traceBeforeReflectedEvent = await page.evaluate(() => JSON.stringify(state.apiTrace));
  const reflectedGeneration = await page.evaluate(() => state.contextHub?.freshness?.generatedAt || state.contextHub?.generatedAt || "");
  await page.evaluate((generatedAt) => handleRuntimeEvent({
    cursor: state.runtimeEventCursor + 1,
    type: "state-invalidated",
    data: { source: "context-hub-refresh", generatedAt },
  }), reflectedGeneration);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 200)));
  expect(await page.evaluate(() => JSON.stringify(state.apiTrace))).toBe(traceBeforeReflectedEvent);
  await page.unroute("**/api/context-hub");

  await page.evaluate(() => {
    state.apiTrace = [];
    document.body.dataset.apiTrace = "[]";
  });
  let returnRefreshingSnapshot = true;
  await page.route("**/api/context-hub", async (route) => {
    const response = await route.fetch();
    if (!returnRefreshingSnapshot) {
      await route.fulfill({ response });
      return;
    }
    returnRefreshingSnapshot = false;
    const snapshot = JSON.parse(await response.text());
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...snapshot,
        freshness: { ...(snapshot.freshness || {}), refreshing: true },
      }),
    });
  });
  await page.evaluate(() => handleRuntimeEvent({
    cursor: state.runtimeEventCursor + 1,
    type: "state-invalidated",
    data: { source: "filesystem" },
  }));
  await expect.poll(runtimeHubIsIdle).toBe(true);
  const refreshingRecoveryRequests = await page.evaluate(() => state.apiTrace.filter((entry) => entry.path === "/api/context-hub").length);
  expect(refreshingRecoveryRequests).toBeGreaterThanOrEqual(2);
  expect(refreshingRecoveryRequests).toBeLessThanOrEqual(3);
  await page.unroute("**/api/context-hub");

  const firstProjectFile = page.locator("[data-global-project-file]").first();
  await expect(firstProjectFile).toBeVisible();
  await firstProjectFile.click();
  await expect.poll(() => page.evaluate(() => Boolean(state.selected && state.savedHash !== null))).toBe(true);
  await page.evaluate(() => {
    state.apiTrace = [];
    document.body.dataset.apiTrace = "[]";
    for (let index = 0; index < 12; index += 1) {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    }
  });
  await expect.poll(() => page.evaluate(() => (
    !state.localForegroundRefreshTimer
    && !state.refreshInFlight
    && !state.backgroundRefreshTimer
    && !state.backgroundRefreshPendingOptions
    && !state.reportsRefreshInFlight
  ))).toBe(true);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 100)));
  const foregroundFileReads = await page.evaluate(() => state.apiTrace.filter((entry) => entry.path === "/api/file").length);
  expect(foregroundFileReads).toBeLessThanOrEqual(1);
});

test("@layout rapid document switches settle Git review reads", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "WebKit exposed the watcher and optional Git lock feedback loop.");
  const data = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  const completedReads = [];
  const requestedReads = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["/api/file/diff", "/api/file/review-base"].includes(url.pathname)
      && ["docs/README.md", "docs/operations.md"].includes(url.searchParams.get("path"))
    ) {
      requestedReads.push({ path: url.pathname, file: url.searchParams.get("path") });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      ["/api/file/diff", "/api/file/review-base"].includes(url.pathname)
      && url.searchParams.get("path") === "docs/operations.md"
    ) {
      completedReads.push({ path: url.pathname, status: response.status() });
    }
  });

  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await ensureExplorerOpen(page);
  const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
  if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
  await page.locator('[data-global-project-file="docs/README.md"]').first().click();
  await expect(page).toHaveURL((url) => url.searchParams.get("file") === "docs/README.md");

  await ensureExplorerOpen(page);
  if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
  await page.locator('[data-global-project-file="docs/operations.md"]').first().click();
  await waitForOpenedFile(page, "docs/operations.md");

  await expect.poll(() => completedReads).toEqual(expect.arrayContaining([
    { path: "/api/file/diff", status: 200 },
    { path: "/api/file/review-base", status: 200 },
  ]));
  await expect.poll(() => page.evaluate(() => state.externalChange?.path || "")).toBe("docs/operations.md");
  await expect(page.locator(".external-review-block-controls").first()).toBeVisible();
  await page.waitForTimeout(300);
  for (const file of ["docs/README.md", "docs/operations.md"]) {
    for (const requestPath of ["/api/file/diff", "/api/file/review-base"]) {
      expect(requestedReads.filter((entry) => entry.path === requestPath && entry.file === file).length).toBeLessThanOrEqual(2);
    }
  }
});

test("@layout a fresh runtime subscription ignores replay already reflected by boot", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "WebKit's event dispatch timing deterministically exercises the fresh-subscription replay boundary.");
  const data = fixture();
  await page.addInitScript(() => {
    class ReplayedRuntimeEventSource {
      constructor() {
        this.listeners = new Map();
        this.closed = false;
        this.timers = [];
        this.timers.push(window.setTimeout(() => {
          this.emit("ready", { cursor: 14, replayableFrom: 1 });
          for (let cursor = 1; cursor <= 14; cursor += 1) {
            this.timers.push(window.setTimeout(() => this.emit("runtime", {
              cursor,
              type: "state-invalidated",
              data: { source: "filesystem", path: `docs/replayed-${cursor}.md` },
            }), cursor * 120));
          }
        }, 0));
      }

      addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
      }

      emit(type, payload) {
        if (this.closed) return;
        const event = new MessageEvent(type, { data: JSON.stringify(payload) });
        for (const listener of this.listeners.get(type) || []) listener.call(this, event);
      }

      close() {
        this.closed = true;
        for (const timer of this.timers) window.clearTimeout(timer);
      }
    }
    window.EventSource = ReplayedRuntimeEventSource;
  });

  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(() => page.evaluate(() => state.runtimeEventsConnected)).toBe(true);
  await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 2_100)));
  await expect.poll(() => page.evaluate(() => (
    !state.runtimeContextHubRefreshPromise
    && !state.runtimeContextHubRefreshTimer
    && !state.runtimeContextHubRefreshPending
    && !state.runtimeContextHubRefreshGeneration
  ))).toBe(true);
  const result = await page.evaluate(() => ({
    cursor: state.runtimeEventCursor,
    requestCounts: state.apiTrace.reduce((counts, entry) => {
      if (["/api/context-hub/catalog", "/api/context-hub/review-queue", "/api/context-hub/sections"].includes(entry.path)) {
        counts[entry.path] = (counts[entry.path] || 0) + 1;
      }
      return counts;
    }, {}),
  }));
  expect(result.cursor).toBe(14);
  for (const path of ["/api/context-hub/catalog", "/api/context-hub/review-queue", "/api/context-hub/sections"]) {
    expect(result.requestCounts[path] || 0).toBeLessThanOrEqual(2);
  }
});

test("@layout executable geometry contract stays continuous at every breakpoint", async ({ page }, testInfo) => {
  const data = fixture();
  const widths = process.env.CONTEXT_ROOM_LAYOUT_WIDTHS
    ? process.env.CONTEXT_ROOM_LAYOUT_WIDTHS.split(",").map(Number).filter(Number.isFinite)
    : [320, 375, 390, 639, 640, 768, 900, 980, 981, 1024, 1280, 1440];
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

test("@layout the 272px Explorer keeps project identity and metrics in separate readable rows", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${data.origin}/?hub=1&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await ensureExplorerOpen(page);
  await page.evaluate(() => document.documentElement.style.setProperty("--explorer-width", "272px"));

  const row = page.locator(".global-project-row:visible").first();
  await expect(row).toBeVisible();
  const geometry = await row.evaluate((node) => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height } : null;
    };
    const main = node.querySelector(".global-project-row-main");
    const title = node.querySelector(".global-project-row-title strong");
    const side = node.querySelector(".global-project-row-side");
    const metrics = side?.querySelector(":scope > span:first-child");
    const action = side?.querySelector(".global-project-row-action");
    return {
      explorerWidth: document.querySelector(".app > aside")?.getBoundingClientRect().width || 0,
      row: rect(node),
      main: rect(main),
      title: rect(title),
      side: rect(side),
      metrics: rect(metrics),
      action: rect(action),
    };
  });
  expect(geometry.explorerWidth).toBeCloseTo(272, 0);
  expect(geometry.title?.width || 0).toBeGreaterThan(24);
  expect(geometry.main?.bottom || 0).toBeLessThanOrEqual((geometry.side?.top || 0) + 0.5);
  expect(geometry.metrics?.right || 0).toBeLessThanOrEqual((geometry.action?.left || 0) + 0.5);
  for (const child of [geometry.main, geometry.side]) {
    expect(child?.left || 0).toBeGreaterThanOrEqual((geometry.row?.left || 0) - 0.5);
    expect(child?.right || 0).toBeLessThanOrEqual((geometry.row?.right || 0) + 0.5);
  }
});

test("@layout mobile controls and modal semantics remain keyboard and touch accessible", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await ensureExplorerOpen(page);

  const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
  await expect(docsFolder).toHaveAttribute("aria-expanded", /true|false/);
  await expect(docsFolder).toHaveAccessibleName(/docs.*folder/i);
  await expectTouchTarget(page.locator("#globalProjectSearch"), "Explorer search");
  await expectTouchTarget(docsFolder, "Explorer folder row");
  const clearExplorerSearch = page.locator("#clearGlobalProjectSearch");
  await expect(clearExplorerSearch).toBeHidden();
  await page.locator("#globalProjectSearch").fill("README");
  await expect(clearExplorerSearch).toBeVisible();
  await expectTouchTarget(clearExplorerSearch, "Explorer search clear");
  await clearExplorerSearch.click();
  await expect(clearExplorerSearch).toBeHidden();

  await closeExplorerDrawer(page);
  await page.locator("#contextRoomReviewProjectFilter").click();
  const projectPicker = page.locator("#contextHubProjectPicker");
  await expect(projectPicker).toBeVisible();
  await expectTouchTarget(projectPicker.locator(".context-hub-project-picker-close"), "Project picker close");
  await expectTouchTarget(projectPicker.locator("#contextHubManageProjects"), "Project picker manage");
  await page.keyboard.press("Escape");
  await expect(projectPicker).toBeHidden();

  await openSettings(page);
  await page.locator('[data-settings-section-target="project"]').click();
  await expectTouchTarget(page.locator("#sharedContextHelpButton"), "Shared Context help");
  const priority = page.locator(".project-priority-actions button:visible").first();
  await expectTouchTarget(priority, "Project priority control");
  await page.locator('[data-settings-section-target="agent-environment"]').click();
  await page.locator('#settings-section-startup details').evaluateAll((details) => details.forEach((item) => { item.open = true; }));
  for (const [id, label] of [
    ["startupContextFileNames", "Ancestor filenames"],
    ["startupContextGlobalPaths", "Global instruction paths"],
    ["startupSkillFolderNames", "Skill folder names"],
    ["startupHookFileNames", "Git hook filenames"],
    ["startupHookManagerPaths", "Hook manager paths"],
    ["startupAgentHookSources", "Agent hook source definitions"],
  ]) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(label);
  }

  const settingsReturnTarget = page.locator('[data-settings-section-target="agent-environment"]');
  await settingsReturnTarget.focus();
  await page.evaluate(async () => {
    const projectId = state.projectId || "atlas";
    state.sharedSkillLocations.set(projectId, {
      connected: true,
      projectId,
      collections: [{ id: "team", title: "Team skills", skillCount: 1 }],
      assignments: [],
      providers: [{ id: "codex", label: "Codex" }],
      projects: [{ id: projectId, title: "Atlas" }],
      providerPreferences: { providers: { codex: "enabled" } },
      projectProviderOverrides: { codex: "inherit" },
    });
    await openSharedSkillsWizard({ mode: "assign", projectId });
  });
  const wizard = page.locator("#sharedSkillsWizard");
  await expect(wizard).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("inert", "");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("#sharedSkillsWizard") != null)).toBe(true);
  const close = wizard.locator(".context-hub-project-picker-close");
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#sharedSkillsWizardNext")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(wizard).toBeHidden();
  await expect(page.locator(".app")).not.toHaveAttribute("inert", "");
  await expect(settingsReturnTarget).toBeFocused();
});

test("@layout compact controls keep 40px targets and the graph list reflows at 320px", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=collapsed`);
  await waitForBoot(page);

  const mobileReviewScroll = await page.locator("#reviewQueue").evaluate((list) => {
    const style = getComputedStyle(list);
    return { maxHeight: style.maxHeight, overflowY: style.overflowY, scrollbarGutter: style.scrollbarGutter };
  });
  expect(mobileReviewScroll).toEqual({ maxHeight: "none", overflowY: "visible", scrollbarGutter: "auto" });

  await page.evaluate(() => {
    const probe = document.createElement("section");
    probe.id = "compactTargetProbe";
    probe.setAttribute("aria-label", "Compact target probe");
    probe.style.cssText = "position:fixed;z-index:9999;right:4px;top:52px;display:grid;gap:4px;padding:4px;background:var(--panel)";
    probe.innerHTML = '<div class="startup-skill-pill"><button class="startup-skill-button" type="button">Skill</button><button class="startup-skill-delete" type="button" aria-label="Delete skill">×</button></div>'
      + '<button class="startup-skill-add" type="button" aria-label="Add skill">+</button>'
      + '<div class="startup-skill-create"><input aria-label="Skill name" /><button type="button" aria-label="Confirm skill">✓</button></div>'
      + '<details class="startup-hooks-help"><summary>Hook help</summary></details>'
      + '<button class="proposal-review-file-unreview" type="button">Unreview</button>'
      + '<div class="graph-toolbar"><div class="graph-toolbar-controls"><label>Scope<select><option>All</option></select></label><button class="file-action" type="button">Fit</button></div></div>';
    document.body.append(probe);
  });

  for (const [selector, label] of [
    [".startup-skill-button", "Skill open"],
    [".startup-skill-delete", "Skill delete"],
    [".startup-skill-add", "Skill add"],
    [".startup-skill-create input", "Skill name"],
    [".startup-skill-create button", "Skill confirm"],
    [".startup-hooks-help summary", "Hook help"],
    [".proposal-review-file-unreview", "Proposal unreview"],
    [".graph-toolbar-controls select", "Graph scope"],
    [".graph-toolbar-controls .file-action", "Graph fit"],
  ]) await expectTouchTarget(page.locator(`#compactTargetProbe ${selector}`), label);
  const deletePresentation = await page.locator("#compactTargetProbe .startup-skill-delete").evaluate((button) => {
    const style = getComputedStyle(button);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents, position: style.position };
  });
  expect(deletePresentation).toEqual({ opacity: "1", pointerEvents: "auto", position: "static" });
  await page.locator("#compactTargetProbe").evaluate((node) => node.remove());
  await page.evaluate(() => showGraphPage({ scope: "global", pushHistory: false }));
  await expect(page.locator("#graphPage")).toBeVisible();
  await page.locator("#graphListToggle").click();
  const graphGeometry = await page.evaluate(() => {
    const list = document.querySelector("#graphAccessibleList");
    if (!list) throw new Error("The graph accessible list is unavailable");
    if (!list.querySelector(".graph-list-row")) {
      list.innerHTML = '<button class="graph-list-row" type="button"><span><strong>Architecture decision record with a long title</strong><small>docs/architecture/decisions/context-room.md</small></span><small>document</small><span class="graph-node-state">accepted</span></button>';
    }
    const row = list.querySelector(".graph-list-row");
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width };
    };
    const cells = row.children;
    return {
      viewportWidth: window.innerWidth,
      row: rect(row),
      rowOverflow: row.scrollWidth - row.clientWidth,
      listOverflow: list.scrollWidth - list.clientWidth,
      title: rect(cells[0]),
      kind: rect(cells[1]),
      state: rect(cells[2]),
    };
  });
  expect(graphGeometry.row.left).toBeGreaterThanOrEqual(0);
  expect(graphGeometry.row.right).toBeLessThanOrEqual(graphGeometry.viewportWidth);
  expect(graphGeometry.rowOverflow).toBeLessThanOrEqual(1);
  expect(graphGeometry.listOverflow).toBeLessThanOrEqual(1);
  expect(graphGeometry.title.bottom).toBeLessThanOrEqual(graphGeometry.kind.top + 1);
  expect(graphGeometry.kind.right).toBeLessThanOrEqual(graphGeometry.state.left + 1);

  await page.setViewportSize({ width: 640, height: 900 });
  await expectTouchTarget(page.locator("#explorerOpen"), "Tablet Explorer open");
});

test("@layout transient catalogue gaps preserve the selected project", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await ensureExplorerOpen(page);
  await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");

  const transition = await page.evaluate(() => {
    const completeCatalog = state.contextHub;
    const projectKey = state.globalExplorerProjectKey;
    const proposalProject = state.sharedProposalProject;
    state.contextHub = {
      ...completeCatalog,
      projects: (completeCatalog?.projects || []).filter((project) => project.projectKey !== projectKey),
    };
    renderGlobalProjectExplorer();
    renderSharedProposalWorkspace();
    const duringGap = {
      explorerMode: state.globalExplorerMode,
      explorerProjectKey: state.globalExplorerProjectKey,
      proposalProject: state.sharedProposalProject,
    };
    state.contextHub = completeCatalog;
    renderGlobalProjectExplorer();
    renderSharedProposalWorkspace();
    return { duringGap, projectKey, proposalProject };
  });

  expect(transition.projectKey).toBeTruthy();
  expect(transition.proposalProject).toBe(transition.projectKey);
  expect(transition.duringGap).toEqual({
    explorerMode: "project",
    explorerProjectKey: transition.projectKey,
    proposalProject: transition.projectKey,
  });
  await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");
  await expect(page.locator('[data-global-project-folder="docs"]')).toBeVisible();
});

test("@layout a runtime snapshot can recover a superseded initial project selection", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "One browser proves the snapshot ordering contract.");
  const data = fixture();
  await page.addInitScript(() => {
    class SupersedingRuntimeEventSource {
      constructor() {
        this.listeners = new Map();
        this.closed = false;
        this.timers = [
          window.setTimeout(() => this.emit("ready", { cursor: 1, replayableFrom: 1 }), 0),
          window.setTimeout(() => {
            state.activeProjectLocationId = new URL(window.location.href).searchParams.get("project") || "";
            state.globalExplorerMode = "projects";
            state.globalExplorerProjectKey = "";
            this.emit("runtime", {
              cursor: 2,
              type: "state-invalidated",
              data: { source: "filesystem", path: "docs/runtime-race.md" },
            });
          }, 50),
        ];
      }

      addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
      }

      emit(type, payload) {
        if (this.closed) return;
        const event = new MessageEvent(type, { data: JSON.stringify(payload) });
        for (const listener of this.listeners.get(type) || []) listener.call(this, event);
      }

      close() {
        this.closed = true;
        for (const timer of this.timers) window.clearTimeout(timer);
      }
    }
    window.EventSource = SupersedingRuntimeEventSource;
  });
  await page.route("**/api/context-hub/catalog", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ response });
  });

  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await ensureExplorerOpen(page);
  await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");
  await expect(page.locator('[data-global-project-folder="docs"]')).toBeVisible();
  expect(await page.evaluate(() => state.apiTrace.filter((entry) => entry.path === "/api/context-hub").length)).toBeGreaterThanOrEqual(1);
});

test("@layout slow project activation does not hold the Hub behind its boot screen", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "One browser proves the boot boundary.");
  const data = fixture();
  let releaseProject;
  let markProjectRequested;
  const projectRelease = new Promise((resolve) => { releaseProject = resolve; });
  const projectRequested = new Promise((resolve) => { markProjectRequested = resolve; });
  await page.route(/\/api\/context-hub\/project$/, async (route) => {
    markProjectRequested();
    await projectRelease;
    await route.continue();
  });

  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await projectRequested;
  const projectSearch = page.locator("#globalProjectSearch");
  const clearProjectSearch = page.locator("#clearGlobalProjectSearch");
  try {
    await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/, { timeout: 3_000 });
    await ensureExplorerOpen(page);
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");
    await expect(page.locator('[data-global-project-folder="docs"]')).toBeVisible();
    await projectSearch.fill("README");
    await expect(clearProjectSearch).toBeVisible();
  } finally {
    releaseProject();
  }
  await expect.poll(() => page.evaluate(() => state.contextHubBusy)).toBe(false);
  await expect(projectSearch).toHaveValue("README");
  await expect(clearProjectSearch).toBeVisible();
});

test("@layout same-project activation preserves an in-flight Explorer folder", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "One browser proves the same-selection request lifetime contract.");
  const data = fixture();
  let releaseProject;
  let markProjectRequested;
  let releaseFolder;
  let markFolderRequested;
  const projectRelease = new Promise((resolve) => { releaseProject = resolve; });
  const projectRequested = new Promise((resolve) => { markProjectRequested = resolve; });
  const folderRelease = new Promise((resolve) => { releaseFolder = resolve; });
  const folderRequested = new Promise((resolve) => { markFolderRequested = resolve; });
  await page.route(/\/api\/context-hub\/project$/, async (route) => {
    markProjectRequested();
    await projectRelease;
    await route.continue();
  });
  await page.route("**/api/context-hub/project-explorer?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "docs") {
      await route.continue();
      return;
    }
    markFolderRequested();
    await folderRelease;
    await route.continue();
  });

  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await projectRequested;
  try {
    await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/, { timeout: 3_000 });
    await ensureExplorerOpen(page);
    const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
    await expect(docsFolder).toBeVisible();
    if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
    await folderRequested;
    releaseProject();
    await expect.poll(() => page.evaluate(() => state.contextHubBusy)).toBe(false);
    releaseFolder();
    await expect(page.locator('[data-global-project-file="docs/README.md"]').first()).toBeVisible();
  } finally {
    releaseProject();
    releaseFolder();
  }
});

test("@layout project switching renders before background activation completes", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "One browser proves the optimistic project-switch contract.");
  const data = fixture();
  let releaseProject;
  let markProjectRequested;
  const projectRelease = new Promise((resolve) => { releaseProject = resolve; });
  const projectRequested = new Promise((resolve) => { markProjectRequested = resolve; });
  await page.route(/\/api\/context-hub\/project$/, async (route) => {
    if (route.request().postDataJSON().projectId !== data.projects.beacon.id) {
      await route.continue();
      return;
    }
    markProjectRequested();
    await projectRelease;
    await route.continue();
  });

  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await ensureExplorerOpen(page);
  await page.locator("[data-global-explorer-back]").click();
  const beacon = page.locator("a.global-project-row", { hasText: "Beacon" }).first();
  await expect(beacon).toBeVisible();
  await beacon.click();
  await projectRequested;
  try {
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Beacon", { timeout: 1_000 });
    await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  } finally {
    releaseProject();
  }
  await expect.poll(() => page.evaluate(() => state.contextHubBusy)).toBe(false);
});

test("@layout themes, zoom, files, graph, proposals, and dialogs preserve geometry", async ({ page, browserName }, testInfo) => {
  const data = fixture();
  const widths = process.env.CONTEXT_ROOM_LAYOUT_WIDTHS
    ? process.env.CONTEXT_ROOM_LAYOUT_WIDTHS.split(",").map(Number).filter(Number.isFinite)
    : [320, 375, 390, 1024, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
    await waitForBoot(page);
    await closeExplorerDrawer(page);
    for (const theme of ["context-room", "vscode-dark", "github-dark", "dracula", "solarized-dark", "light-plus"]) {
      await page.evaluate((nextTheme) => { document.documentElement.dataset.fileTheme = nextTheme; }, theme);
      await audit(page, testInfo, `theme-${theme}-${width}`);
    }

    if (browserName === "chromium" && width > LAYOUT_CONTRACT.breakpoints.mobileMax) {
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
    await expect(docsFolder).toBeVisible();
    if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
    const readmeFile = page.locator('[data-global-project-file="docs/README.md"]').first();
    await expect(readmeFile).toBeVisible();
    await readmeFile.click();
    await waitForOpenedFile(page, "docs/README.md");
    await expect(page.locator("#viewer")).toBeVisible();
    await expect(page.locator(".file-load-state.error")).toHaveCount(0);
    await closeExplorerDrawer(page);
    await audit(page, testInfo, `document-${width}`);
    if (width <= LAYOUT_CONTRACT.breakpoints.mobileMax) {
      await ensureExplorerOpen(page);
      if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
      const operationsFile = page.locator('[data-global-project-file="docs/operations.md"]').first();
      await expect(operationsFile).toBeVisible();
      await operationsFile.click();
      await waitForOpenedFile(page, "docs/operations.md");
      await expect(page.locator(".file-load-state.error")).toHaveCount(0);
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
    const proposal = await exactSharedProposalEntry(page, data.shared);
    const removeTerminalReadyReportsFixture = await installTerminalReadyReportsFixture(page);
    await proposal.click();
    await expect(page).toHaveURL((url) => (
      url.origin === new URL(data.origin).origin
      && /^\/reviews\/[^/]+\/$/.test(url.pathname)
      && url.searchParams.get("view") === "proposal"
    ), { timeout: 30_000 });
    await waitForBoot(page);
    await expect.poll(() => page.evaluate(() => ({
      proposal: state.sharedContext?.review?.proposal || "",
      proposalHead: state.sharedContext?.review?.proposalHead || "",
    }))).toEqual({ proposal: data.shared.proposal, proposalHead: data.shared.proposalHead });
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
    await expect(terminalAction).toHaveAccessibleName("Accept proposal");
    await expect(terminalAction).toBeInViewport({ ratio: 1 });
    await audit(page, testInfo, `proposal-terminal-${width}`);

    const browserZoom = browserName === "chromium" && width > LAYOUT_CONTRACT.breakpoints.mobileMax
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
        expect(await terminalLabel()).toBe("Accept proposal");
        await terminalControl.evaluate((node) => node.focus());
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("proposalDockAccept");
        expect(await terminalLabel()).toBe("Accept proposal");
      } else {
        await expect(terminalControl).toHaveAccessibleName("Accept proposal");
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
