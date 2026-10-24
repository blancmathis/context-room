import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { createMemoryServer, initializeContextRoomProject } from "../../src/context_room.mjs";
import { contextHubHostRoot, registerContextHubProject, registerContextHubSharedRepository } from "../../src/context_hub.mjs";
import { initializeSharedRepository } from "../../src/shared_context.mjs";

// page.route must see every Hub request, so no service worker answers first.
test.use({ serviceWorkers: "block" });

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Context Room Switch",
  GIT_AUTHOR_EMAIL: "switch@example.test",
  GIT_COMMITTER_NAME: "Context Room Switch",
  GIT_COMMITTER_EMAIL: "switch@example.test",
};

function git(root, args) {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, relativePath, content) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content, "utf8");
}

async function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-project-switch-")));
  const previous = {};
  for (const key of ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME", "GIT_CONFIG_GLOBAL"]) {
    previous[key] = process.env[key];
    process.env[key] = key === "GIT_CONFIG_GLOBAL" ? "/dev/null" : path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });

  const beacon = path.join(base, "Beacon");
  write(beacon, "docs/README.md", "# Beacon\n\nLocal documentation.\n");
  initializeContextRoomProject(beacon, { title: "Beacon", allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const remote = path.join(base, "shared.git");
  const seed = path.join(base, "shared-seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  initializeSharedRepository(seed, { name: "Switch Shared Context" });
  write(seed, "projects.json", JSON.stringify({ version: 1, projects: [{ id: "comet", title: "Comet" }, { id: "delta", title: "Delta" }] }, null, 2) + "\n");
  write(seed, "projects/comet/docs/README.md", "# Comet\n\nShared documentation.\n");
  write(seed, "projects/delta/docs/README.md", "# Delta\n\nShared documentation.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared documentation"]);
  git(seed, ["push", "origin", "main"]);

  registerContextHubSharedRepository(remote);
  registerContextHubProject(beacon, { title: "Beacon" });
  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room", allowedPaths: [], watchAllow: [] });
  const runtime = createMemoryServer({ root: hostRoot, registerInHub: false });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${runtime.server.address().port}`,
    async close() {
      await new Promise((resolve) => { runtime.server.closeAllConnections(); runtime.server.close(resolve); });
      await runtime.waitForShutdown();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Shared snapshots are read-only on disk.
      try { execFileSync("chmod", ["-R", "u+w", base], { stdio: "ignore" }); } catch {}
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

async function showProjectList(page) {
  const app = page.locator(".app");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) {
    await page.locator("#explorerOpen:visible, #sidebarToggle:visible").first().click();
  }
  await page.locator('[data-global-explorer-mode="projects"]').click();
  const back = page.locator("[data-global-explorer-back]");
  if (await back.isVisible().catch(() => false)) await back.click();
}

function projectRow(page, title) {
  return page.locator("a.global-project-row", { has: page.locator(".global-project-row-title strong", { hasText: title }) }).first();
}

test("@perf a local project opens at once while a Shared refresh is delayed, and Shared rows stay listed", async ({ page }) => {
  const hub = await fixture();
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
    await showProjectList(page);
    for (const title of ["Beacon", "Comet", "Delta"]) await expect(projectRow(page, title)).toBeVisible({ timeout: 15_000 });

    let releaseRefresh;
    const refreshHeld = new Promise((resolve) => { releaseRefresh = resolve; });
    let refreshCalls = 0;
    await page.route("**/api/context-hub/refresh", async (route) => {
      refreshCalls += 1;
      await refreshHeld;
      await route.continue().catch(() => {});
    });

    await projectRow(page, "Comet").click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Comet");
    await expect.poll(() => refreshCalls).toBe(1);

    await showProjectList(page);
    const clickedAt = Date.now();
    await projectRow(page, "Beacon").click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Beacon", { timeout: 1_000 });
    expect(Date.now() - clickedAt).toBeLessThan(1_000);

    // Beacon's open wrote the registry. The catalogue read right after it must
    // keep the Shared rows, not the locals-only navigation fallback.
    const titlesAfterOpen = await page.evaluate(async () => (await api("/api/context-hub")).projects.map((project) => project.title));
    expect(titlesAfterOpen).toEqual(expect.arrayContaining(["Beacon", "Comet", "Delta"]));

    // The stale refresh (Comet's) must not move the selection away from Beacon.
    releaseRefresh();
    await expect.poll(() => page.evaluate(() => Boolean(state.contextHubSharedRefreshPromise))).toBe(false);
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Beacon");
    expect(refreshCalls).toBe(1);

    // The opens wrote the registry. The Hub catalogue the client reads next
    // must still hold the Shared rows, not the locals-only fallback.
    await showProjectList(page);
    for (let index = 0; index < 4; index += 1) {
      const titles = await page.evaluate(async () => {
        const ticket = beginContextHubSnapshotRequest();
        applyContextHubSnapshot(await api("/api/context-hub"), ticket);
        renderGlobalProjectExplorer();
        return (state.contextHub?.projects || []).map((project) => project.title).sort();
      });
      expect(titles).toEqual(expect.arrayContaining(["Beacon", "Comet", "Delta"]));
      for (const title of ["Beacon", "Comet", "Delta"]) await expect(projectRow(page, title)).toBeVisible({ timeout: 1_000 });
      await page.waitForTimeout(500);
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hub.close();
  }
});

async function openHub(page, hub) {
  await page.goto(hub.origin + "/?hub=1&view=hub");
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await showProjectList(page);
  for (const title of ["Beacon", "Comet", "Delta"]) await expect(projectRow(page, title)).toBeVisible({ timeout: 15_000 });
  // The boot poll is over: later catalogue reads come from the code under test.
  await expect.poll(() => page.evaluate(() => state.contextHubSnapshotPollTimer === null && !state.contextHub?.freshness?.refreshing), { timeout: 15_000 }).toBe(true);
}

async function holdRefresh(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const hold = { calls: 0, release };
  await page.route("**/api/context-hub/refresh", async (route) => {
    hold.calls += 1;
    await held;
    await route.continue().catch(() => {});
  });
  return hold;
}

test("@perf a project opens at once while a manual Refresh is held, and the Refresh sends one POST", async ({ page }) => {
  const hub = await fixture();
  try {
    await openHub(page, hub);
    const refresh = await holdRefresh(page);
    await page.evaluate(() => { void refreshContextHubUi(); void refreshContextHubUi(); });
    await expect.poll(() => refresh.calls).toBe(1);
    // The Refresh status button stays disabled for the whole refresh.
    expect(await page.evaluate(() => Boolean(state.contextHubBusy || state.contextHubRefreshPromise))).toBe(true);

    await showProjectList(page);
    const clickedAt = Date.now();
    await projectRow(page, "Beacon").click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Beacon", { timeout: 1_000 });
    expect(Date.now() - clickedAt).toBeLessThan(1_000);
    await expect(page.locator("#status")).toHaveText(/^project selected/);
    await page.evaluate(() => { void refreshContextHubUi(); });
    expect(await page.evaluate(() => Boolean(state.contextHubBusy || state.contextHubRefreshPromise))).toBe(true);

    // The late result must not take the status line from the open.
    refresh.release();
    await expect.poll(() => page.evaluate(() => Boolean(state.contextHubRefreshPromise))).toBe(false);
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Beacon");
    await expect(page.locator("#status")).toHaveText(/^project selected/);
    expect(refresh.calls).toBe(1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hub.close();
  }
});

test("@perf a failure while applying the background Shared refresh ends as a status, not an unhandled rejection", async ({ page }) => {
  const hub = await fixture();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await openHub(page, hub);
    await page.route("**/api/context-hub/refresh", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failWhileApplying: true }),
    }));
    await page.evaluate(() => {
      const apply = applyContextHubSnapshot;
      window.applyContextHubSnapshot = (catalog, ticket) => {
        if (catalog?.failWhileApplying) throw new Error("catalogue render failed");
        return apply(catalog, ticket);
      };
    });

    await projectRow(page, "Comet").click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Comet");
    await expect(page.locator("#status")).toHaveText(/Shared refresh failed · catalogue render failed/);
    await expect.poll(() => page.evaluate(() => Boolean(state.contextHubSharedRefreshPromise))).toBe(false);
    await page.waitForTimeout(300);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hub.close();
  }
});

test("@perf a Refresh result dropped for a newer read is read again", async ({ page }) => {
  const hub = await fixture();
  try {
    await openHub(page, hub);
    const reads = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/context-hub") reads.push(Date.now());
    });
    const refresh = await holdRefresh(page);
    await page.evaluate(() => { void refreshContextHubUi(); });
    await expect.poll(() => refresh.calls).toBe(1);
    // A newer read takes the ticket, so the held result can no longer apply.
    await page.evaluate(() => { beginContextHubSnapshotRequest(); });

    const releasedAt = Date.now();
    refresh.release();
    await expect.poll(() => page.evaluate(() => Boolean(state.contextHubRefreshPromise))).toBe(false);
    await expect.poll(() => reads.filter((at) => at >= releasedAt).length, { timeout: 3_000 }).toBeGreaterThan(0);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hub.close();
  }
});

test("@perf a Shared project opened during a manual Refresh joins it without a second POST", async ({ page }) => {
  const hub = await fixture();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await openHub(page, hub);
    const refresh = await holdRefresh(page);
    await page.evaluate(() => { void refreshContextHubUi().catch(() => {}); });
    await expect.poll(() => refresh.calls).toBe(1);

    await showProjectList(page);
    const clickedAt = Date.now();
    await projectRow(page, "Comet").click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Comet", { timeout: 1_000 });
    expect(Date.now() - clickedAt).toBeLessThan(1_000);
    await page.waitForTimeout(500);
    // The manual Refresh already runs the Shared pass: no second one.
    expect(refresh.calls).toBe(1);

    refresh.release();
    await expect.poll(() => page.evaluate(() => Boolean(state.contextHubSharedRefreshPromise || state.contextHubRefreshPromise))).toBe(false);
    await expect(page.locator("#status")).toHaveText(/^project selected · Shared (snapshot synced|offline|sync continuing)/);
    expect(refresh.calls).toBe(1);

    // A failed manual Refresh ends the joined open as a status.
    await page.unroute("**/api/context-hub/refresh");
    const failing = { calls: 0 };
    await page.route("**/api/context-hub/refresh", async (route) => {
      failing.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refresh broke" }) }).catch(() => {});
    });
    await page.evaluate(() => { void refreshContextHubUi().catch(() => {}); });
    await expect.poll(() => failing.calls).toBe(1);
    await showProjectList(page);
    await projectRow(page, "Delta").click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Delta", { timeout: 1_000 });
    await expect(page.locator("#status")).toHaveText(/^project selected · Shared refresh failed · /);
    await page.waitForTimeout(300);
    expect(failing.calls).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hub.close();
  }
});
