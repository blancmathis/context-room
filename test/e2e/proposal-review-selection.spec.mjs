import fs from "node:fs";
import http from "node:http";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room UX fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting/);
  await expect.poll(async () => {
    const diagnostics = await page.locator("body").getAttribute("data-workspace-diagnostics");
    return JSON.parse(diagnostics || "{}").phase || "";
  }).toBe("ready");
}

async function startLoopbackProxy(targetOrigin) {
  const target = new URL(targetOrigin);
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const headers = { ...request.headers, host: target.host };
    for (const header of ["origin", "referer"]) {
      const value = String(request.headers[header] || "");
      if (!value) continue;
      try {
        const forwarded = new URL(value);
        if (forwarded.host !== request.headers.host) continue;
        headers[header] = header === "origin"
          ? target.origin
          : `${target.origin}${forwarded.pathname}${forwarded.search}${forwarded.hash}`;
      } catch {}
    }
    const upstream = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    });
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function showTerminalProposal(page, overrides = {}) {
  await expect.poll(async () => page.evaluate(() => Boolean(state.bootMilestones.initialDataReady))).toBe(true);
  await page.evaluate(() => {
    cancelBackgroundRefresh();
    state.runtimeEventSource?.close();
    state.runtimeEventSource = null;
    state.runtimeEventsConnected = true;
    window.clearInterval(state.runtimeFallbackTimer);
    state.runtimeFallbackTimer = null;
  });
  await expect.poll(async () => page.evaluate(() => Boolean(state.refreshInFlight || state.reportsRefreshInFlight))).toBe(false);
  await page.evaluate((next) => {
    const proposal = next.proposal || "proposal/demo/terminal-action";
    const proposalHead = next.proposalHead || "0123456789abcdef0123456789abcdef01234567";
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        projectId: next.projectId || "demo-project",
        proposal,
        proposalHead,
        defaultBranch: "main",
        title: next.title || "Terminal action feedback",
        description: "Keep delivery feedback visible.",
        proposalFiles: ["README.md"],
        proposalChanges: [{ path: "README.md", status: "M", reviewKind: "proposal-change" }],
      },
    };
    state.docqa = {
      generatedAt: new Date().toISOString(),
      queue: [],
      pendingPaths: [],
      reviewedPaths: ["README.md"],
      summary: { needsReview: 0 },
    };
    state.contextHubSelection = proposal;
    state.proposalReviewKey = "";
    state.proposalActionBusy = false;
    state.proposalActionError = "";
    showProposalReview();
  }, overrides);
}

async function confirmTerminalAcceptance(page) {
  const dialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Put on main", exact: true }).click();
  return dialog;
}

test("@smoke a shared-only deep link boots without a local target and labels an offline cache honestly", async ({ page }) => {
  const { origin, shared } = fixture();
  const settingsTargets = [];
  const sharedOnly = {
    id: "shared:offline-repository:orphan",
    projectKey: "shared:offline-repository:orphan",
    logicalProjectId: "orphan",
    title: "Offline Shared",
    mode: "shared",
    root: "",
    current: false,
    available: false,
    lastOpenedAt: "",
    worktree: null,
    worktrees: [],
    worktreeCount: 0,
    localReviewCount: 0,
    sharedProposalCount: 0,
    shared: { repository: shared.remote, projectId: "orphan" },
    sharedStatus: {
      online: false,
      fetchError: "Remote unavailable",
      revision: "a".repeat(40),
      defaultBranch: "main",
      syncedAt: "2026-08-08T08:00:00.000Z",
    },
    sharedTitle: "Offline Shared",
    priorityId: "shared:offline-repository:orphan",
    priorityRank: null,
  };
  const withSharedOnly = (payload) => ({ ...payload, projects: [...payload.projects.filter((project) => project.id !== sharedOnly.id), sharedOnly] });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/settings") {
      settingsTargets.push(request.headers()["x-context-room-target-project"] || "");
    }
  });
  await page.route("**/api/context-hub/catalog", async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    await route.fulfill({ response, json: withSharedOnly(catalog) });
  });
  await page.route(/\/api\/context-hub$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withSharedOnly(await response.json()) });
  });

  await page.goto(origin + "/?hub=1&workspace=workspace-shared-only&project=shared%3Aorphan&view=hub");
  await waitForBoot(page);
  await expect.poll(() => page.evaluate(() => ({
    mode: state.globalExplorerMode,
    key: state.globalExplorerProjectKey,
    active: state.activeProjectLocationId,
    query: new URL(window.location.href).searchParams.get("project"),
  }))).toEqual({
    mode: "project",
    key: sharedOnly.projectKey,
    active: sharedOnly.id,
    query: sharedOnly.id,
  });
  await expect(page.locator(".global-project-folder-state")).toContainText("shared-only");
  expect(settingsTargets.length).toBeGreaterThan(0);
  expect(settingsTargets).toEqual(settingsTargets.map(() => ""));

  await page.evaluate(() => {
    state.globalExplorerMode = "projects";
    state.globalExplorerProjectKey = "";
    renderGlobalProjectExplorer();
  });
  const row = page.locator('[data-global-project-key="shared:offline-repository:orphan"]');
  await expect(row).toContainText("Offline · cached snapshot");
  await expect(row).not.toContainText("Up to date");

  const noCacheCopy = await page.evaluate(() => {
    state.sharedContext = {
      enabled: true,
      mode: "project",
      proposals: [],
      status: { online: false, revision: "", fetchError: "Remote unavailable" },
    };
    renderSharedContextControls();
    return document.querySelector("#sharedContextLabel")?.textContent || "";
  });
  expect(noCacheCopy).toBe("Main offline · no cached snapshot");
  expect(noCacheCopy).not.toContain("@");
});

test("@smoke a launcher-style project deep link renders immediately while its project refresh completes", async ({ page }) => {
  const { origin, projects } = fixture();
  let releaseProjectRefresh;
  let markProjectRequest;
  const projectRequest = new Promise((resolve) => { markProjectRequest = resolve; });
  const projectRefresh = new Promise((resolve) => { releaseProjectRefresh = resolve; });
  await page.route("**/api/context-hub/project", async (route) => {
    markProjectRequest(route.request().postDataJSON());
    await projectRefresh;
    await route.continue();
  });

  const navigation = page.goto(origin + "/?hub=1&project=" + encodeURIComponent(projects.atlas.id));
  const posted = await projectRequest;
  await navigation;
  try {
    expect(posted).toEqual({ projectId: projects.atlas.id });
    await waitForBoot(page);
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");
    await expect(page).toHaveURL((url) => url.searchParams.get("project") === projects.atlas.id && url.searchParams.get("view") === "hub");
    await page.getByRole("button", { name: "Back to projects" }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("project") && url.searchParams.get("view") === "hub");
    await expect(page.locator(".global-project-row", { hasText: "Atlas" })).toBeVisible();
    await expect(page.locator(".global-project-row", { hasText: "Beacon" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({
      opened: state.contextHubInitialProjectOpenedId,
      opening: state.contextHubInitialProjectOpen?.id || "",
      busy: state.contextHubBusy,
    }))).toEqual({ opened: "", opening: projects.atlas.id, busy: true });
  } finally {
    releaseProjectRefresh();
  }

  await waitForBoot(page);
  await expect.poll(() => page.evaluate(() => ({
    opened: state.contextHubInitialProjectOpenedId,
    opening: state.contextHubInitialProjectOpen?.id || "",
    busy: state.contextHubBusy,
  }))).toEqual({ opened: projects.atlas.id, opening: "", busy: false });
});

test("@smoke global boot stays pending until the Explorer catalogue is renderable", async ({ page }) => {
  const { origin } = fixture();
  let releaseCatalog;
  let markCatalogRequest;
  const catalogRequest = new Promise((resolve) => { markCatalogRequest = resolve; });
  const catalogGate = new Promise((resolve) => { releaseCatalog = resolve; });
  await page.route("**/api/context-hub/catalog", async (route) => {
    markCatalogRequest();
    await catalogGate;
    await route.continue();
  });

  const navigation = page.goto(origin + "/?hub=1&workspace=workspace-global-boot&view=hub&explorer=expanded");
  await catalogRequest;
  await navigation;
  try {
    await expect(page.locator("body")).toHaveClass(/app-booting/);
    await expect(page.locator("#globalProjectCount")).toHaveText("Loading…");
  } finally {
    releaseCatalog();
  }

  await waitForBoot(page);
  await expect(page.locator(".global-project-row").first()).toBeVisible();
  await expect(page.locator("#globalProjectCount")).not.toHaveText("Loading…");
});

test("@smoke an exact project settings deep link remains on Settings while project refresh finishes", async ({ page }) => {
  const { origin, projects } = fixture();
  let releaseProjectRefresh;
  let markProjectRequest;
  const projectRequest = new Promise((resolve) => { markProjectRequest = resolve; });
  const projectRefresh = new Promise((resolve) => { releaseProjectRefresh = resolve; });
  await page.route("**/api/context-hub/project", async (route) => {
    markProjectRequest(route.request().postDataJSON());
    await projectRefresh;
    await route.continue();
  });

  const navigation = page.goto(origin + "/?hub=1&workspace=workspace-project-settings-boot&project="
    + encodeURIComponent(projects.atlas.id)
    + "&view=settings&settings=review-trust");
  const posted = await projectRequest;
  await navigation;
  try {
    expect(posted).toEqual({ projectId: projects.atlas.id });
    await waitForBoot(page);
    await expect(page.locator("#settingsPage")).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get("view") === "settings"
      && url.searchParams.get("settings") === "review-trust");
  } finally {
    releaseProjectRefresh();
  }

  await waitForBoot(page);
  await expect(page.locator("#settingsPage")).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    project: state.activeProjectLocationId,
    page: state.page,
    section: state.settingsSection,
    navigationGeneration: state.workspaceNavigationGeneration,
  }))).toEqual({
    project: projects.atlas.id,
    page: "settings",
    section: "review-trust",
    navigationGeneration: 1,
  });
  const url = new URL(page.url());
  expect(url.searchParams.get("project")).toBe(projects.atlas.id);
  expect(url.searchParams.get("view")).toBe("settings");
  expect(url.searchParams.get("settings")).toBe("review-trust");
});

test("@smoke selecting a hybrid project refreshes its Shared snapshot before opening", async ({ page }) => {
  const { origin, projects } = fixture();
  const openings = [];
  await page.route("**/api/context-hub/project", async (route) => {
    openings.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto(origin + "/?hub=1&workspace=workspace-project-refresh&view=hub");
  await waitForBoot(page);
  const explorerOpen = page.getByRole("button", { name: "Open explorer" });
  if (await explorerOpen.isVisible()) await explorerOpen.click();

  await page.locator(".global-project-row", { hasText: "Atlas" }).click();
  await expect.poll(() => openings.length).toBe(1);
  expect([projects.atlas.id, projects.atlas.worktreeId]).toContain(openings[0].projectId);
  await expect(page.locator("#status")).toContainText("Shared snapshot synced");
});

test("@smoke the latest project and worktree selection survives an in-flight project refresh", async ({ page }) => {
  const { origin, projects } = fixture();
  let releaseFirstOpening;
  const firstOpeningGate = new Promise((resolve) => { releaseFirstOpening = resolve; });
  const openings = [];
  await page.route("**/api/context-hub/project", async (route) => {
    openings.push(route.request().postDataJSON());
    if (openings.length === 1) await firstOpeningGate;
    await route.continue();
  });
  await page.goto(origin + "/?hub=1&workspace=workspace-project-queue&view=hub");
  await waitForBoot(page);
  const explorerOpen = page.getByRole("button", { name: "Open explorer" });
  if (await explorerOpen.isVisible()) await explorerOpen.click();

  await page.locator(".global-project-row", { hasText: "Atlas" }).click();
  await expect.poll(() => openings.length).toBe(1);
  await page.getByRole("button", { name: "Back to projects" }).click();
  await page.locator(".global-project-row", { hasText: "Beacon" }).click();
  await page.locator(".global-project-row", { hasText: "Atlas" }).click();
  releaseFirstOpening();

  await expect.poll(() => openings.length).toBe(2);
  await expect(page.locator("#globalExplorerScope strong")).toHaveText("Atlas");
  const worktree = page.getByLabel("Choose worktree");
  await expect(worktree).toBeVisible();
  const selectedWorktree = await worktree.inputValue();
  await expect(page).toHaveURL((url) => url.searchParams.get("project") === selectedWorktree);
  const nextWorktree = [projects.atlas.id, projects.atlas.worktreeId].find((id) => id !== selectedWorktree);
  expect(nextWorktree).toBeTruthy();
  await worktree.selectOption(nextWorktree);
  await expect(page).toHaveURL((url) => url.searchParams.get("project") === nextWorktree);
  await expect(page.getByLabel("Choose worktree")).toHaveValue(nextWorktree);
});

test("@smoke expanded project folders stay isolated between worktrees", async ({ page }) => {
  const { origin, projects } = fixture();
  await page.goto(origin + "/?hub=1&workspace=workspace-worktree-folders&project="
    + encodeURIComponent(projects.atlas.id)
    + "&view=hub");
  await waitForBoot(page);
  const explorerOpen = page.getByRole("button", { name: "Open explorer" });
  if (await explorerOpen.isVisible()) await explorerOpen.click();

  const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
  await expect(docsFolder).toBeVisible();
  await docsFolder.click();
  await expect(docsFolder).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-global-project-file="docs/README.md"]').first()).toBeVisible();

  const worktree = page.getByLabel("Choose worktree");
  const selectedWorktree = await worktree.inputValue();
  const nextWorktree = [projects.atlas.id, projects.atlas.worktreeId].find((id) => id !== selectedWorktree);
  expect(nextWorktree).toBeTruthy();
  await worktree.selectOption(nextWorktree);
  await expect(page).toHaveURL((url) => url.searchParams.get("project") === nextWorktree);
  await expect(page.getByLabel("Choose worktree")).toHaveValue(nextWorktree);

  const switchedDocsFolder = page.locator('[data-global-project-folder="docs"]').first();
  await expect(switchedDocsFolder).toHaveAttribute("aria-expanded", "false");
  await switchedDocsFolder.click();
  await expect(switchedDocsFolder).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-global-project-file="docs/operations.md"]').first()).toBeVisible();
});

test("@smoke review filters and stale snapshots never masquerade as an all-clear queue", async ({ page }) => {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1&workspace=workspace-filtered-review-queue&view=hub");
  await waitForBoot(page);
  await expect.poll(() => page.evaluate(() => Boolean(state.contextHubReviewQueueReady && state.contextHub?.projects?.length))).toBe(true);
  await page.evaluate(() => {
    cancelBackgroundRefresh();
    state.runtimeEventSource?.close();
    state.runtimeEventSource = null;
    state.runtimeEventsConnected = true;
    window.clearInterval(state.runtimeFallbackTimer);
    state.runtimeFallbackTimer = null;
  });
  await expect.poll(() => page.evaluate(() => Boolean(state.refreshInFlight || state.reportsRefreshInFlight))).toBe(false);
  const filteredState = await page.evaluate(() => {
    const pendingProject = state.contextHub.projects[0];
    if (!pendingProject) throw new Error("Missing project fixture");
    const pending = {
      id: "shared:filtered-review",
      type: "shared",
      projectId: pendingProject.id,
      projectKey: pendingProject.projectKey,
      projectTitle: pendingProject.title,
      reviewStatus: "ready",
      title: "Filtered review fixture",
      branch: "proposal/filtered-review-fixture",
      head: "a".repeat(40),
      files: ["docs/README.md"],
      fileCount: 1,
      available: true,
    };
    const emptyProject = {
      ...pendingProject,
      id: "empty-review-project",
      projectKey: "empty-review-project",
      title: "Empty review project",
      current: false,
      localReviewCount: 0,
      sharedProposalCount: 0,
      worktrees: [],
      worktreeCount: 0,
    };
    state.docqa = {
      ...(state.docqa || {}),
      queue: [],
      summary: { ...(state.docqa?.summary || {}), needsReview: 0, deletedDocs: 0 },
    };
    state.contextHub = {
      ...state.contextHub,
      projects: [pendingProject, emptyProject],
      items: [pending],
      freshness: { generatedAt: new Date().toISOString(), ageMs: 0, fresh: true, refreshing: false },
    };
    state.contextHubReviewQueueReady = true;
    state.sharedProposalProject = emptyProject.projectKey;
    state.contextHubSource = "all";
    state.sharedProposalSearch = "";
    renderContextRoomGlobalReviewQueue();
    const result = {
      toolbarVisible: !document.querySelector(".context-room-review-toolbar")?.hidden,
      allClear: Boolean(document.querySelector(".review-all-clear")),
      queueText: document.querySelector("#reviewQueue")?.textContent || "",
    };
    state.sharedProposalProject = "";
    renderContextRoomGlobalReviewQueue();
    result.pendingVisible = Boolean([...document.querySelectorAll("[data-context-room-review-entry]")]
      .find((entry) => entry.getAttribute("data-context-room-review-entry") === pending.id));
    return result;
  });

  expect(filteredState.toolbarVisible).toBe(true);
  expect(filteredState.allClear).toBe(false);
  expect(filteredState.queueText).toContain("Review work is still pending. Clear the filters or refresh to show it.");
  expect(filteredState.pendingVisible).toBe(true);

  let refreshCalls = 0;
  await page.route("**/api/context-hub/refresh", async (route) => {
    refreshCalls += 1;
    await route.continue();
  });
  const staleState = await page.evaluate(() => {
    state.contextHub = {
      ...state.contextHub,
      repositoryErrors: [{ repositoryId: "offline-fixture", code: "shared_repository_unavailable" }],
      freshness: { generatedAt: new Date().toISOString(), ageMs: 0, fresh: false, refreshing: true },
    };
    state.contextHubReviewQueueReady = true;
    renderContextRoomGlobalReviewQueue();
    const unconfirmed = document.querySelector(".review-status-unconfirmed");
    const refresh = unconfirmed?.querySelector("[data-review-refresh]");
    const result = {
      allClear: Boolean(document.querySelector(".review-all-clear")),
      unconfirmedText: unconfirmed?.textContent || "",
      hasRefresh: Boolean(refresh),
      pendingVisible: Boolean(document.querySelector('[data-context-room-review-entry="shared:filtered-review"]')),
    };
    refresh?.click();
    return result;
  });
  expect(staleState.allClear).toBe(false);
  expect(staleState.unconfirmedText).toContain("The proposals shown below may be incomplete");
  expect(staleState.hasRefresh).toBe(true);
  expect(staleState.pendingVisible).toBe(true);
  await expect.poll(() => refreshCalls).toBe(1);
});

test("@smoke a failed worktree switch restores the committed project selection", async ({ page }) => {
  const { origin, projects } = fixture();
  await page.goto(`${origin}/?hub=1&workspace=workspace-switch-rollback&project=${encodeURIComponent(projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  await page.evaluate(() => {
    cancelBackgroundRefresh();
    state.runtimeEventSource?.close();
    state.runtimeEventSource = null;
    state.runtimeEventsConnected = true;
    window.clearInterval(state.runtimeFallbackTimer);
    state.runtimeFallbackTimer = null;
  });
  await expect.poll(() => page.evaluate(() => Boolean(state.refreshInFlight || state.reportsRefreshInFlight))).toBe(false);
  const explorerOpen = page.getByRole("button", { name: "Open explorer" });
  if (await explorerOpen.isVisible()) await explorerOpen.click();
  const select = page.locator("[data-global-project-worktree]");
  await expect(select).toBeVisible();
  const initialValue = await select.inputValue();
  const values = await select.locator("option").evaluateAll((options) => options.map((option) => option.value));
  const nextValue = values.find((value) => value !== initialValue);
  expect(nextValue).toBeTruthy();
  await page.locator("#globalProjectSearch").fill("README");
  const before = await page.evaluate(() => ({
    map: state.globalProjectWorktreeIds.get(state.globalExplorerProjectKey) || "",
    active: state.activeProjectLocationId,
    projectKey: state.globalExplorerProjectKey,
    search: state.globalProjectSearch,
    query: new URL(window.location.href).searchParams.get("project") || "",
  }));
  let switchCalls = 0;
  await page.route("**/api/context-hub/project", async (route) => {
    switchCalls += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "simulated worktree switch failure" }),
    });
  });

  await select.selectOption(nextValue);
  await expect.poll(() => switchCalls).toBe(1);
  await expect(page.locator("#status")).toContainText("simulated worktree switch failure");
  await expect(select).toHaveValue(initialValue);
  await expect(page.locator("#globalProjectSearch")).toHaveValue("README");
  await expect.poll(() => page.evaluate(() => ({
    map: state.globalProjectWorktreeIds.get(state.globalExplorerProjectKey) || "",
    active: state.activeProjectLocationId,
    projectKey: state.globalExplorerProjectKey,
    search: state.globalProjectSearch,
    query: new URL(window.location.href).searchParams.get("project") || "",
    busy: state.contextHubBusy,
  }))).toEqual({ ...before, busy: false });

  const beforeProjectFailure = await page.evaluate((projectId) => {
    state.globalExplorerMode = "projects";
    state.globalExplorerProjectKey = "";
    state.globalProjectSearch = "";
    renderGlobalProjectExplorer();
    const project = state.contextHub.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Missing alternate project fixture");
    const row = [...document.querySelectorAll(".global-project-row")]
      .find((entry) => entry.getAttribute("data-global-project-key") === project.projectKey);
    if (!row) throw new Error("Missing alternate project row");
    const result = {
      targetProjectKey: project.projectKey,
      targetMap: state.globalProjectWorktreeIds.get(project.projectKey) || "",
      active: state.activeProjectLocationId,
      query: new URL(window.location.href).searchParams.get("project") || "",
    };
    row.click();
    return result;
  }, projects.beacon.id);
  await expect.poll(() => switchCalls).toBe(2);
  await expect(page.locator("#status")).toContainText("simulated worktree switch failure");
  await expect.poll(() => page.evaluate((snapshot) => ({
    targetMap: state.globalProjectWorktreeIds.get(snapshot.targetProjectKey) || "",
    active: state.activeProjectLocationId,
    failedProjectSelected: state.globalExplorerProjectKey === snapshot.targetProjectKey,
    query: new URL(window.location.href).searchParams.get("project") || "",
    busy: state.contextHubBusy,
  }), beforeProjectFailure)).toEqual({
    targetMap: beforeProjectFailure.targetMap,
    active: beforeProjectFailure.active,
    failedProjectSelected: false,
    query: beforeProjectFailure.query,
    busy: false,
  });
});

test("@smoke a proposal already opening keeps its visual selection while busy", async ({ page }) => {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1&workspace=workspace-busy-selection&view=hub");
  await waitForBoot(page);
  await expect.poll(() => page.evaluate(() => contextHubReviewItems().some((item) => item.type === "shared"))).toBe(true);
  const ids = await page.evaluate(() => {
    const first = contextHubReviewItems().find((item) => item.type === "shared");
    if (!first) throw new Error("Missing proposal fixture");
    const second = {
      ...first,
      id: first.id + ":second",
      branch: first.branch + "-second",
      title: first.title + " second",
    };
    state.contextHub = {
      ...state.contextHub,
      items: [first, second],
      proposals: [first, second],
    };
    state.contextHubSelection = first.id;
    state.contextRoomOpeningProposalId = first.id;
    state.sharedContextBusy = true;
    renderContextRoomGlobalReviewQueue();
    return { first: first.id, second: second.id };
  });

  const blockedProposal = page.locator('[data-context-room-review="' + ids.second + '"]');
  await expect(blockedProposal).toBeDisabled();
  await blockedProposal.evaluate((button) => button.click());
  await expect.poll(() => page.evaluate(() => ({
    selection: state.contextHubSelection,
    opening: state.contextRoomOpeningProposalId,
  }))).toEqual({ selection: ids.first, opening: ids.first });
});

test("@smoke verified terminal rejection refreshes and returns to the Hub", async ({ page }) => {
  const { origin, projects } = fixture();
  const hubUrl = `${origin}/?hub=1&workspace=workspace-rejection&project=${projects.atlas.id}&view=hub`;
  const reviewUrl = new URL(origin + "/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-rejection");
  reviewUrl.searchParams.set("project", projects.atlas.id);
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", hubUrl);
  const rejectionBranch = "rejected/demo/terminal-action-0123456789ab";
  const flashToken = "r".repeat(32);
  await page.route("**/api/shared-context/reject", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rejected: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        rejectionBranch,
        rejectionPrefix: "rejected/",
        hubRefresh: { status: "complete" },
        flashToken,
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: flashToken });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "reject", rejectionBranch, rejectionPrefix: "rejected/", hubRefresh: { status: "complete" } }),
    });
  });

  await page.goto(reviewUrl.toString());
  await waitForBoot(page);
  await showTerminalProposal(page, { projectId: projects.atlas.id });
  await page.getByRole("button", { name: "Reject proposal", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject this proposal?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Reject proposal", exact: true }).click();

  await expect(page).toHaveURL(hubUrl);
  await waitForBoot(page);
  const toast = page.locator('[data-context-room-toast][role="status"]');
  await expect(toast).toContainText("Proposal rejected");
  await expect(toast).toContainText(rejectionBranch);
});

test("@smoke a reviewed proposal row explains selection and can return to review", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "The touch path shares the selection helper and is covered by the source contract test.");
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);
  await page.waitForTimeout(500);

  const selectionResult = await page.evaluate(() => {
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        proposal: "proposal/demo/reviewed-selection",
        proposalHead: "0123456789abcdef",
        defaultBranch: "main",
        title: "Reviewed selection explanation",
        description: "Review every changed file as one proposal.",
        proposalFiles: ["README.md"],
        proposalChanges: [{
          path: "README.md",
          status: "M",
          fromPath: null,
          score: null,
          reviewKind: "proposal-change",
        }],
      },
    };
    state.docqa = {
      generatedAt: new Date().toISOString(),
      queue: [],
      pendingPaths: [],
      reviewedPaths: ["README.md"],
      summary: { needsReview: 0 },
    };
    state.proposalReviewKey = "";
    state.proposalSelectionNotice = "";
    showProposalReview();
    const target = document.querySelector('[data-proposal-review-path="README.md"]');
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const notice = document.querySelector("#proposalReviewNotice");
    return {
      noticeVisible: !notice.hidden,
      noticeKind: notice.dataset.kind,
      noticeText: notice.textContent,
      rowText: target.textContent,
      selectedCount: document.querySelectorAll('[data-proposal-review-selected="true"]').length,
    };
  });
  expect(selectionResult).toEqual({
    noticeVisible: true,
    noticeKind: "info",
    noticeText: "This file is already Reviewed, so it cannot be selected again. Selection only applies to files still marked Review. Open the file normally to inspect it.",
    rowText: expect.stringContaining("Reviewed"),
    selectedCount: 0,
  });

  const unreview = page.getByRole("button", { name: "Unreview README.md and return it to Review" });
  await expect(unreview).toBeVisible();
  await unreview.click();
  expect(pageErrors).toEqual([]);
  const dialog = page.getByRole("dialog", { name: "Unreview this document?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Accepted shared main and the proposal branch remain unchanged.");
  const confirm = dialog.getByRole("button", { name: "Unreview", exact: true });
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("@smoke the last individual file decision never auto-accepts the proposal", async ({ page }, testInfo) => {
  const { origin } = fixture();
  const terminalRequests = [];
  const fileReviewRequests = [];
  const backgroundReportRequests = [];
  let fileDecisionSaved = false;
  let reviewedReportRequests = 0;
  let releaseFirstReviewedReport;
  const firstReviewedReportReady = new Promise((resolve) => { releaseFirstReviewedReport = resolve; });

  await page.route("**/api/reports*", async (route) => {
    const reviewed = fileDecisionSaved;
    if (reviewed) {
      backgroundReportRequests.push(route.request().url());
      reviewedReportRequests += 1;
      if (reviewedReportRequests === 1) await firstReviewedReportReady;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        docqa: {
          generatedAt: new Date().toISOString(),
          queue: reviewed ? [] : [{
            path: "README.md",
            label: "README.md",
            currentHash: "readme-content-hash",
            resourceState: "present",
            resourceVersion: null,
            dependencyVersions: {},
          }],
          pendingPaths: reviewed ? [] : ["README.md"],
          reviewedPaths: reviewed ? ["README.md"] : [],
          summary: { needsReview: reviewed ? 0 : 1 },
        },
        doctor: { issues: [] },
        startupContext: [],
        startupSkills: [],
        startupHooks: [],
      }),
    });
  });

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    terminalRequests.push({ kind: "challenge", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "unexpected-automatic-challenge",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    terminalRequests.push({ kind: "accept", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        commit: "89abcdef0123456789abcdef0123456789abcdef",
        verifiedRemoteHead: "89abcdef0123456789abcdef0123456789abcdef",
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
      }),
    });
  });
  await page.route("**/api/shared-context/review-files", async (route) => {
    fileReviewRequests.push(route.request().postDataJSON());
    fileDecisionSaved = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        docqa: {
          generatedAt: new Date().toISOString(),
          queue: [],
          pendingPaths: [],
          reviewedPaths: ["README.md"],
          summary: { needsReview: 0 },
        },
        sharedContext: {
          mode: "review",
          acceptedChangesRemain: true,
          review: {
            projectId: "demo-project",
            proposal: "proposal/demo/last-individual-review",
            proposalHead: "0123456789abcdef0123456789abcdef01234567",
            defaultBranch: "main",
            title: "Last individual review",
            description: "The terminal merge must remain an explicit separate decision.",
            proposalFiles: ["README.md"],
            proposalChanges: [{ path: "README.md", status: "M", reviewKind: "proposal-change" }],
          },
        },
      }),
    });
  });

  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        projectId: "demo-project",
        proposal: "proposal/demo/last-individual-review",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        defaultBranch: "main",
        title: "Last individual review",
        description: "The terminal merge must remain an explicit separate decision.",
        proposalFiles: ["README.md"],
        proposalChanges: [{ path: "README.md", status: "M", reviewKind: "proposal-change" }],
      },
    };
    state.docqa = {
      generatedAt: new Date().toISOString(),
      queue: [{
        path: "README.md",
        label: "README.md",
        currentHash: "readme-content-hash",
        resourceState: "present",
        resourceVersion: null,
        dependencyVersions: {},
      }],
      pendingPaths: ["README.md"],
      reviewedPaths: [],
      summary: { needsReview: 1 },
    };
    state.proposalReviewKey = "";
    state.proposalSelectedFiles.clear();
    state.proposalActionBusy = false;
    state.proposalActionError = "";
    state.lastReportRefreshAt = Date.now();
    state.lastFullRefreshAt = Date.now();
    showProposalReview();
  });

  const fileRow = page.getByRole("button", { name: /Open README\.md/ });
  if (testInfo.project.name === "chromium-mobile") {
    const pointer = await fileRow.evaluate((row) => {
      const rect = row.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        pointerId: 17,
        button: 0,
        buttons: 1,
        isPrimary: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      row.dispatchEvent(new PointerEvent("pointerdown", init));
      return init;
    });
    await page.waitForTimeout(650);
    await page.locator('[data-proposal-review-path="README.md"]').evaluate((row, init) => {
      row.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    }, pointer);
  } else {
    await fileRow.click({ button: "right" });
  }
  const selectedFileRow = page.locator('[data-proposal-review-path="README.md"]');
  await expect(selectedFileRow).toHaveAttribute("aria-pressed", "true");
  await expect(selectedFileRow).toHaveAccessibleName("Remove README.md from selection");
  await expect(page.locator("#proposalReviewSelection").getByRole("status")).toContainText("1 selected");
  await expect(page.getByRole("button", { name: "Accept selected", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Accept selected", exact: true }).click();

  await expect.poll(() => fileReviewRequests.length).toBe(1);
  expect(fileReviewRequests[0]).toEqual({
    expectedProposalHead: "0123456789abcdef0123456789abcdef01234567",
    decision: "accept",
    files: ["README.md"],
  });
  const putOnMain = page.getByRole("button", { name: "Put on main", exact: true });
  await expect(putOnMain).toBeVisible();
  await expect(putOnMain).toBeEnabled();

  await page.evaluate(() => {
    state.lastReportRefreshAt = 0;
    scheduleBackgroundRefresh({ forceReports: true });
  });
  await expect.poll(() => backgroundReportRequests.length).toBe(1);
  await page.evaluate(() => scheduleBackgroundRefresh({ forceReports: true }));
  releaseFirstReviewedReport();
  await expect.poll(() => backgroundReportRequests.length).toBe(2);
  await expect.poll(() => page.evaluate(() => ({
    inFlight: state.reportsRefreshInFlight,
    pending: Boolean(state.backgroundRefreshPendingOptions),
    timer: Boolean(state.backgroundRefreshTimer),
  }))).toEqual({ inFlight: false, pending: false, timer: false });

  await expect(page.locator("#proposalReviewPage")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Last individual review" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open README\.md/ })).toContainText("Reviewed");
  await expect(putOnMain).toBeVisible();
  await expect(putOnMain).toBeEnabled();
  expect(await page.evaluate(() => ({
    page: state.page,
    mode: state.sharedContext?.mode,
    proposal: state.sharedContext?.review?.proposal,
    pendingPaths: state.docqa?.pendingPaths || [],
    reviewedPaths: state.docqa?.reviewedPaths || [],
    accepted: Boolean(state.sharedContext?.accepted?.accepted),
    rejected: Boolean(state.sharedContext?.rejected?.rejected),
  }))).toEqual({
    page: "proposal",
    mode: "review",
    proposal: "proposal/demo/last-individual-review",
    pendingPaths: [],
    reviewedPaths: ["README.md"],
    accepted: false,
    rejected: false,
  });
  expect(terminalRequests).toEqual([]);
});

test("@smoke terminal proposal acceptance obtains a one-shot challenge before confirmation", async ({ page }) => {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);

  let releaseChallenge;
  const challengeReady = new Promise((resolve) => { releaseChallenge = resolve; });
  const requests = [];
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    requests.push({ kind: "challenge", body: route.request().postDataJSON() });
    await challengeReady;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-terminal-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    requests.push({ kind: "accept", body: route.request().postDataJSON() });
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Accept must not run before confirmation." }) });
  });

  await showTerminalProposal(page);
  const acceptButton = page.getByRole("button", { name: "Put on main", exact: true });
  await expect(acceptButton).toBeVisible();
  await acceptButton.click();

  await expect.poll(() => requests.map((request) => request.kind)).toEqual(["challenge"]);
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toHaveCount(0);
  releaseChallenge();
  const dialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
  await expect(dialog).toBeVisible();
  expect(requests).toEqual([{
    kind: "challenge",
    body: { expectedProposalHead: "0123456789abcdef0123456789abcdef01234567" },
  }]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("@smoke verified terminal acceptance stays pending, reports the commit, then returns to the right Hub", async ({ page }, testInfo) => {
  const { origin, projects } = fixture();
  const projectId = projects.beacon.id;
  const mobileProject = testInfo.project.name.includes("mobile");
  const hubUrl = `${origin}/?hub=1&workspace=workspace-demo&project=${encodeURIComponent(projectId)}&view=hub&explorer=expanded`;
  const reviewUrl = new URL(origin + "/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-demo");
  reviewUrl.searchParams.set("project", projectId);
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", hubUrl);
  reviewUrl.searchParams.set("explorer", mobileProject ? "collapsed" : "expanded");
  await page.goto(reviewUrl.toString());
  await waitForBoot(page);
  if (!mobileProject) await expect(page.locator(".app > aside")).toBeVisible();

  const acceptedCommit = "89abcdef".repeat(8);
  const flashToken = "a".repeat(32);
  const requests = [];
  let releaseAccept;
  const acceptReady = new Promise((resolve) => { releaseAccept = resolve; });
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    requests.push({ kind: "challenge", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-success-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    requests.push({ kind: "accept", body: route.request().postDataJSON() });
    await acceptReady;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit: acceptedCommit,
        verifiedRemoteHead: acceptedCommit,
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
        flashToken,
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: flashToken });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "merge", commit: acceptedCommit, hubRefresh: { status: "complete" } }),
    });
  });

  await showTerminalProposal(page, { projectId });
  const putOnMain = page.getByRole("button", { name: "Put on main", exact: true });
  if (!mobileProject) {
    await expect.poll(async () => page.evaluate(() => {
      const accept = document.querySelector("#proposalDockAccept")?.getBoundingClientRect();
      const explorer = document.querySelector(".app > aside")?.getBoundingClientRect();
      return Boolean(accept && explorer && accept.left >= explorer.right);
    })).toBe(true);
  }
  await putOnMain.click();
  const dialog = await confirmTerminalAcceptance(page);

  await expect.poll(() => requests.map((request) => request.kind)).toEqual(["challenge", "accept"]);
  expect(requests[1].body).toEqual({
    expectedProposalHead: "0123456789abcdef0123456789abcdef01234567",
    challengeId: "challenge-success-1",
  });
  await expect(dialog.getByRole("button", { name: "Putting on main…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Putting on main…", exact: true })).toHaveAttribute("aria-busy", "true");
  await expect(page).toHaveURL((url) => (
    url.origin === origin
    && url.pathname === "/"
    && url.searchParams.get("workspace") === "workspace-demo"
    && url.searchParams.get("project") === projectId
    && url.searchParams.get("view") === "proposal"
    && url.searchParams.get("proposal") === "proposal/demo/terminal-action"
    && url.searchParams.get("returnTo") === hubUrl
  ));

  releaseAccept();
  await expect(page).toHaveURL(hubUrl);
  await waitForBoot(page);
  const toast = page.locator('[data-context-room-toast][role="status"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Proposal merged into main");
  await expect(toast).toContainText(acceptedCommit);
});

test("@smoke verified terminal acceptance with a pending Hub refresh keeps success and returns to the right Hub", async ({ page }) => {
  const { origin, projects } = fixture();
  const projectId = projects.beacon.id;
  const hubUrl = `${origin}/?hub=1&workspace=workspace-pending-refresh&project=${encodeURIComponent(projectId)}&view=hub&explorer=expanded`;
  const reviewUrl = new URL(origin + "/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-pending-refresh");
  reviewUrl.searchParams.set("project", projectId);
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", hubUrl);
  reviewUrl.searchParams.set("explorer", "collapsed");
  await page.goto(reviewUrl.toString());
  await waitForBoot(page);

  const acceptedCommit = "76543210".repeat(5);
  const flashToken = "p".repeat(32);
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-pending-hub-refresh-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit: acceptedCommit,
        verifiedRemoteHead: acceptedCommit,
        defaultBranch: "main",
        hubRefresh: { status: "pending" },
        flashToken,
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: flashToken });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "merge",
        commit: acceptedCommit,
        hubRefresh: { status: "pending" },
      }),
    });
  });

  await showTerminalProposal(page, { projectId });
  await page.evaluate(() => setExplorerEdgePeek(true));
  await expect(page.locator(".app")).not.toHaveClass(/explorer-edge-peek/);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  await confirmTerminalAcceptance(page);

  await expect(page).toHaveURL(hubUrl);
  await waitForBoot(page);
  const toast = page.locator('[data-context-room-toast][role="status"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Proposal merged into main · Hub refresh pending");
  await expect(toast).toContainText(acceptedCommit);
  await expect(page.locator('[data-context-room-toast][role="alert"]')).toBeHidden();
  const target = new URL(page.url());
  expect(target.searchParams.get("view")).toBe("hub");
  expect(target.searchParams.has("proposal")).toBe(false);
});

test("@smoke terminal acceptance without a valid returnTo falls back to the root Hub and preserves review scope", async ({ page }) => {
  const { origin, projects } = fixture();
  const projectId = projects.beacon.id;
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);
  await expect.poll(async () => page.evaluate(() => Boolean(state.bootMilestones.initialDataReady))).toBe(true);

  const reviewUrl = new URL(origin + "/reviews/authority-demo/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-demo");
  reviewUrl.searchParams.set("project", projectId);
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", "https://untrusted.invalid/?hub=1&workspace=wrong&project=wrong");
  await page.evaluate((url) => window.history.replaceState(window.history.state, "", url), reviewUrl.toString());

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-root-fallback-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    const commit = "89abcdef0123456789abcdef0123456789abcdef";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit,
        verifiedRemoteHead: commit,
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
        flashToken: "b".repeat(32),
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    const commit = "89abcdef0123456789abcdef0123456789abcdef";
    expect(route.request().postDataJSON()).toEqual({ token: "b".repeat(32) });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "merge", commit, hubRefresh: { status: "complete" } }),
    });
  });

  await showTerminalProposal(page, { projectId });
  const explorerClose = page.getByRole("button", { name: "Close explorer" });
  if (await explorerClose.isVisible()) await explorerClose.click();
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  await confirmTerminalAcceptance(page);
  await page.waitForURL((url) => url.searchParams.get("view") === "hub");

  const target = new URL(page.url());
  expect(target.origin).toBe(origin);
  expect(target.pathname).toBe("/");
  expect(target.searchParams.get("hub")).toBe("1");
  expect(target.searchParams.get("workspace")).toBe("workspace-demo");
  expect(target.searchParams.get("project")).toBe(projectId);
  expect(target.searchParams.get("view")).toBe("hub");
  expect(target.searchParams.has("proposal")).toBe(false);
  expect(target.searchParams.has("returnTo")).toBe(false);
  await waitForBoot(page);
});

test("@smoke verified acceptance carries its one-shot success toast across Hub ports", async ({ page }) => {
  const { origin, projects } = fixture();
  const projectId = projects.beacon.id;
  const hubProxy = await startLoopbackProxy(origin);
  try {
    const hubUrl = `${hubProxy.origin}/?hub=1&workspace=workspace-cross-port&project=${encodeURIComponent(projectId)}&view=hub&explorer=collapsed`;
    await page.goto(hubUrl);
    await waitForBoot(page);
    await page.evaluate(() => window.sessionStorage.removeItem("context-room:toast:v1"));

    const reviewUrl = new URL(origin + "/");
    reviewUrl.searchParams.set("hub", "1");
    reviewUrl.searchParams.set("workspace", "workspace-cross-port");
    reviewUrl.searchParams.set("project", projectId);
    reviewUrl.searchParams.set("view", "proposal");
    reviewUrl.searchParams.set("proposal", "proposal/demo/cross-port-toast");
    reviewUrl.searchParams.set("returnTo", hubUrl);
    reviewUrl.searchParams.set("explorer", "collapsed");
    await page.goto(reviewUrl.toString());
    await waitForBoot(page);
    const explorerClose = page.getByRole("button", { name: "Close explorer" });
    if (await explorerClose.isVisible()) await explorerClose.click();

    const acceptedCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const flashToken = "c".repeat(32);
    let flashConsumeCalls = 0;
    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: "challenge-cross-port-1",
          action: "accept",
          authorityId: "authority-demo",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          deliveryVerified: true,
          proposal: "proposal/demo/cross-port-toast",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          commit: acceptedCommit,
          verifiedRemoteHead: acceptedCommit,
          defaultBranch: "main",
          hubRefresh: { status: "complete" },
          flashToken,
        }),
      });
    });
    await page.route("**/api/context-hub/flash", async (route) => {
      flashConsumeCalls += 1;
      expect(route.request().postDataJSON()).toEqual({ token: flashToken });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "merge",
          commit: acceptedCommit,
          hubRefresh: { status: "complete" },
        }),
      });
    });

    await showTerminalProposal(page, { projectId, proposal: "proposal/demo/cross-port-toast" });
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    await confirmTerminalAcceptance(page);
    await page.waitForURL((url) => url.origin === hubProxy.origin && url.searchParams.get("view") === "hub");
    await waitForBoot(page);

    expect(await page.evaluate(() => window.sessionStorage.getItem("context-room:toast:v1"))).toBeNull();
    const toast = page.locator('[data-context-room-toast][role="status"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Proposal merged into main");
    await expect(toast).toContainText(acceptedCommit);
    expect(flashConsumeCalls).toBe(1);
    const deliveredUrl = new URL(page.url());
    expect([...deliveredUrl.searchParams.keys()].some((key) => /^cr(?:Flash|Outcome|Commit|HubRefresh)$/i.test(key))).toBe(false);

    await page.reload();
    await waitForBoot(page);
    await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  } finally {
    await hubProxy.close();
  }
});

test("@smoke verified rejection carries its one-shot success toast across Hub ports", async ({ page }) => {
  const { origin, projects } = fixture();
  const projectId = projects.beacon.id;
  const hubProxy = await startLoopbackProxy(origin);
  try {
    const hubUrl = `${hubProxy.origin}/?hub=1&workspace=workspace-cross-port-rejection&project=${encodeURIComponent(projectId)}&view=hub&explorer=collapsed`;
    await page.goto(hubUrl);
    await waitForBoot(page);
    await page.evaluate(() => window.sessionStorage.removeItem("context-room:toast:v1"));

    const proposal = "proposal/demo/cross-port-rejection";
    const reviewUrl = new URL(origin + "/");
    reviewUrl.searchParams.set("hub", "1");
    reviewUrl.searchParams.set("workspace", "workspace-cross-port-rejection");
    reviewUrl.searchParams.set("project", projectId);
    reviewUrl.searchParams.set("view", "proposal");
    reviewUrl.searchParams.set("proposal", proposal);
    reviewUrl.searchParams.set("returnTo", hubUrl);
    reviewUrl.searchParams.set("explorer", "collapsed");
    await page.goto(reviewUrl.toString());
    await waitForBoot(page);
    const explorerClose = page.getByRole("button", { name: "Close explorer" });
    if (await explorerClose.isVisible()) await explorerClose.click();

    const rejectionBranch = "rejected/demo/cross-port-rejection-0123456789ab";
    const flashToken = "j".repeat(32);
    let flashConsumeCalls = 0;
    await page.route("**/api/shared-context/reject", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rejected: true,
          proposal,
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          rejectionBranch,
          rejectionPrefix: "rejected/",
          hubRefresh: { status: "pending" },
          flashToken,
        }),
      });
    });
    await page.route("**/api/context-hub/flash", async (route) => {
      flashConsumeCalls += 1;
      expect(route.request().postDataJSON()).toEqual({ token: flashToken });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "reject",
          rejectionBranch,
          rejectionPrefix: "rejected/",
          hubRefresh: { status: "pending" },
        }),
      });
    });

    await showTerminalProposal(page, { projectId, proposal });
    await page.getByRole("button", { name: "Reject proposal", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Reject this proposal?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Reject proposal", exact: true }).click();
    await page.waitForURL((url) => url.origin === hubProxy.origin && url.searchParams.get("view") === "hub");
    await waitForBoot(page);

    expect(await page.evaluate(() => window.sessionStorage.getItem("context-room:toast:v1"))).toBeNull();
    const toast = page.locator('[data-context-room-toast][role="status"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Proposal rejected · Hub refresh pending");
    await expect(toast).toContainText(rejectionBranch);
    expect(flashConsumeCalls).toBe(1);
    const deliveredUrl = new URL(page.url());
    expect([...deliveredUrl.searchParams.keys()].some((key) => /^cr(?:Flash|Outcome|Commit|HubRefresh)$/i.test(key))).toBe(false);

    await page.reload();
    await waitForBoot(page);
    await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  } finally {
    await hubProxy.close();
  }
});

test("@smoke a forged URL flash can never manufacture a verified merge success", async ({ page }) => {
  const { origin } = fixture();
  const forgedCommit = "badc0ffee0ddf00dbadc0ffee0ddf00dbadc0ffe";
  const forgedUrl = new URL(origin + "/");
  forgedUrl.searchParams.set("hub", "1");
  forgedUrl.searchParams.set("view", "hub");
  forgedUrl.searchParams.set("crFlash", JSON.stringify({
    title: "Proposal merged into main",
    message: "Commit " + forgedCommit,
    kind: "status",
  }));
  forgedUrl.searchParams.set("crOutcome", "merged");
  forgedUrl.searchParams.set("crCommit", forgedCommit);
  forgedUrl.searchParams.set("crHubRefresh", "complete");

  await page.goto(forgedUrl.toString());
  await waitForBoot(page);

  await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  await expect(page.locator("body")).not.toContainText("Proposal merged into main");
  await expect(page.locator("body")).not.toContainText(forgedCommit);
  const cleanedUrl = new URL(page.url());
  expect(["crFlash", "crOutcome", "crCommit", "crHubRefresh"].some((key) => cleanedUrl.searchParams.has(key))).toBe(false);
});

test("@smoke two different valid delivery SHAs stay on the proposal and offer retry", async ({ page }) => {
  const { origin } = fixture();
  const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
  const soundCalls = [];
  let acceptCalls = 0;
  await page.exposeFunction("recordIncompleteProofSound", (cue) => soundCalls.push(cue));
  await page.goto(reviewUrl);
  await waitForBoot(page);

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-incomplete-proof-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    acceptCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit: "89abcdef0123456789abcdef0123456789abcdef",
        verifiedRemoteHead: "fedcba9876543210fedcba9876543210fedcba98",
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
        flashToken: "v".repeat(32),
      }),
    });
  });
  await page.evaluate(() => {
    const originalPlayContextRoomSound = window.playContextRoomSound;
    window.playContextRoomSound = (cue, ...args) => {
      if (cue === "proposal-accepted") void window.recordIncompleteProofSound(cue);
      return originalPlayContextRoomSound(cue, ...args);
    };
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  const dialog = await confirmTerminalAcceptance(page);

  await expect.poll(() => acceptCalls).toBe(1);
  await expect(dialog).toBeHidden();
  await expect.soft(page).toHaveURL(reviewUrl, { timeout: 1_500 });
  expect.soft(soundCalls).toEqual([]);
  await expect.soft(page.locator('[data-context-room-toast][role="status"]')).toBeHidden({ timeout: 1_500 });
  const errorToast = page.locator('[data-context-room-toast][role="alert"]');
  await expect.soft(errorToast).toBeVisible({ timeout: 1_500 });
  await expect.soft(errorToast).toContainText("Context Room could not verify this proposal on the remote main branch.", { timeout: 1_500 });
  await expect.soft(errorToast.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 1_500 });
});

test("@smoke a cross-origin accepted HTTP 200 without a flash token stays on the proposal and offers retry", async ({ page }) => {
  const { origin, projects } = fixture();
  const projectId = projects.beacon.id;
  const hubProxy = await startLoopbackProxy(origin);
  const soundCalls = [];
  let acceptCalls = 0;
  try {
    const hubUrl = `${hubProxy.origin}/?hub=1&workspace=workspace-cross-origin-proof&project=${encodeURIComponent(projectId)}&view=hub`;
    const reviewUrl = new URL(origin + "/");
    reviewUrl.searchParams.set("hub", "1");
    reviewUrl.searchParams.set("workspace", "workspace-cross-origin-proof");
    reviewUrl.searchParams.set("project", projectId);
    reviewUrl.searchParams.set("view", "proposal");
    reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
    reviewUrl.searchParams.set("returnTo", hubUrl);
    await page.exposeFunction("recordMissingFlashSound", (cue) => soundCalls.push(cue));
    await page.goto(reviewUrl.toString());
    await waitForBoot(page);
    const explorerClose = page.getByRole("button", { name: "Close explorer" });
    if (await explorerClose.isVisible()) await explorerClose.click();

    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: "challenge-missing-cross-origin-flash-1",
          action: "accept",
          authorityId: "authority-demo",
          proposal: "proposal/demo/terminal-action",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      acceptCalls += 1;
      const commit = "89abcdef0123456789abcdef0123456789abcdef";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          deliveryVerified: true,
          proposal: "proposal/demo/terminal-action",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          commit,
          verifiedRemoteHead: commit,
          defaultBranch: "main",
          hubRefresh: { status: "complete" },
        }),
      });
    });
    await page.evaluate(() => {
      window.playContextRoomSound = (cue) => {
        if (cue === "proposal-accepted") void window.recordMissingFlashSound(cue);
      };
    });

    await showTerminalProposal(page, { projectId });
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    const dialog = await confirmTerminalAcceptance(page);

    await expect.poll(() => acceptCalls).toBe(1);
    await expect(dialog).toBeHidden();
    await expect.soft(page).toHaveURL((url) => (
      url.origin === origin
      && url.pathname === "/"
      && url.searchParams.get("workspace") === "workspace-cross-origin-proof"
      && url.searchParams.get("project") === projectId
      && url.searchParams.get("view") === "proposal"
      && url.searchParams.get("proposal") === "proposal/demo/terminal-action"
      && url.searchParams.get("returnTo") === hubUrl
    ), { timeout: 1_500 });
    expect.soft(soundCalls).toEqual([]);
    await expect.soft(page.locator('[data-context-room-toast][role="status"]')).toBeHidden({ timeout: 1_500 });
    const errorToast = page.locator('[data-context-room-toast][role="alert"]');
    await expect.soft(errorToast).toBeVisible({ timeout: 1_500 });
    await expect.soft(errorToast).toContainText("Context Room could not verify this proposal on the remote main branch.", { timeout: 1_500 });
    await expect.soft(errorToast.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 1_500 });
  } finally {
    await hubProxy.close();
  }
});

for (const mismatch of [
  {
    label: "proposal",
    proposal: "proposal/demo/a-different-terminal-action",
    proposalHead: "0123456789abcdef0123456789abcdef01234567",
  },
  {
    label: "proposal head",
    proposal: "proposal/demo/terminal-action",
    proposalHead: "fedcba9876543210fedcba9876543210fedcba98",
  },
]) {
  test(`@smoke an accepted HTTP 200 bound to a different ${mismatch.label} stays on the proposal and offers retry`, async ({ page }) => {
    const { origin } = fixture();
    const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
    const soundCalls = [];
    let acceptCalls = 0;
    await page.exposeFunction("recordMismatchedAcceptanceSound", (cue) => soundCalls.push(cue));
    await page.goto(reviewUrl);
    await waitForBoot(page);

    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: `challenge-mismatched-${mismatch.label.replace(/\s+/g, "-")}-1`,
          action: "accept",
          authorityId: "authority-demo",
          proposal: "proposal/demo/terminal-action",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      acceptCalls += 1;
      const commit = "89abcdef0123456789abcdef0123456789abcdef";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          deliveryVerified: true,
          proposal: mismatch.proposal,
          proposalHead: mismatch.proposalHead,
          commit,
          verifiedRemoteHead: commit,
          defaultBranch: "main",
          hubRefresh: { status: "complete" },
        }),
      });
    });
    await page.evaluate(() => {
      window.playContextRoomSound = (cue) => {
        if (cue === "proposal-accepted") void window.recordMismatchedAcceptanceSound(cue);
      };
    });

    await showTerminalProposal(page);
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    const dialog = await confirmTerminalAcceptance(page);

    await expect.poll(() => acceptCalls).toBe(1);
    await expect(dialog).toBeHidden();
    await expect.soft(page).toHaveURL(reviewUrl, { timeout: 1_500 });
    expect.soft(soundCalls).toEqual([]);
    await expect.soft(page.locator('[data-context-room-toast][role="status"]')).toBeHidden({ timeout: 1_500 });
    const errorToast = page.locator('[data-context-room-toast][role="alert"]');
    await expect.soft(errorToast).toBeVisible({ timeout: 1_500 });
    await expect.soft(errorToast).toContainText("Context Room could not verify this proposal on the remote main branch.", { timeout: 1_500 });
    await expect.soft(errorToast.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 1_500 });
  });
}

test("@smoke failed terminal acceptance stays put, stays silent, and retries with a fresh challenge", async ({ page }) => {
  const { origin } = fixture();
  const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
  await page.goto(reviewUrl);
  await waitForBoot(page);

  const challengeIds = ["challenge-failure-1", "challenge-failure-2"];
  let challengeCalls = 0;
  let acceptCalls = 0;
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    const challengeId = challengeIds[challengeCalls++];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId,
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    acceptCalls += 1;
    expect(route.request().postDataJSON().challengeId).toBe(challengeIds[acceptCalls - 1]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "GitHub refused the proposal push.", code: "shared_context_acceptance_stale" }),
    });
  });
  await page.evaluate(() => {
    window.__proposalAcceptedSoundCalls = [];
    const originalPlayContextRoomSound = window.playContextRoomSound;
    window.playContextRoomSound = (cue, ...args) => {
      if (cue === "proposal-accepted") window.__proposalAcceptedSoundCalls.push(cue);
      return originalPlayContextRoomSound(cue, ...args);
    };
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toBeVisible();
  const dialog = await confirmTerminalAcceptance(page);
  await expect(dialog.getByRole("button", { name: "Putting on main…", exact: true })).toBeDisabled();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL((url) => url.origin === origin && url.searchParams.get("view") === "proposal");
  expect(await page.evaluate(() => window.__proposalAcceptedSoundCalls)).toEqual([]);

  const toast = page.locator('[data-context-room-toast][role="alert"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("GitHub refused the proposal push.");
  await toast.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => challengeCalls).toBe(2);
  expect(acceptCalls).toBe(1);
  const retryDialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
  await expect(retryDialog).toBeVisible();
  await expect(retryDialog.getByRole("checkbox")).not.toBeChecked();
  await expect(retryDialog.getByRole("button", { name: "Put on main", exact: true })).toBeDisabled();
  await retryDialog.getByRole("checkbox").check();
  await retryDialog.getByRole("button", { name: "Put on main", exact: true }).click();
  await expect.poll(() => acceptCalls).toBe(2);
  expect(challengeCalls).toBe(2);
  await expect(retryDialog).toBeHidden();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("GitHub refused the proposal push.");
  await expect(page).toHaveURL((url) => url.origin === origin && url.searchParams.get("view") === "proposal");
  expect(await page.evaluate(() => window.__proposalAcceptedSoundCalls)).toEqual([]);
});

test("@smoke a terminal acceptance network failure stays on the proposal with a persistent alert and retry", async ({ page }) => {
  const { origin } = fixture();
  const proposal = "proposal/demo/terminal-action";
  const reviewUrl = origin + "/?hub=1&view=proposal&proposal=" + encodeURIComponent(proposal);
  const staysOnProposal = (url) => (
    url.origin === origin
    && url.pathname === "/"
    && url.searchParams.get("hub") === "1"
    && url.searchParams.get("view") === "proposal"
    && url.searchParams.get("proposal") === proposal
  );
  const challengeIds = ["challenge-network-failure-1", "challenge-network-failure-2"];
  let challengeCalls = 0;
  let acceptCalls = 0;
  await page.goto(reviewUrl);
  await waitForBoot(page);

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    const challengeId = challengeIds[challengeCalls++];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId,
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    acceptCalls += 1;
    expect(route.request().postDataJSON().challengeId).toBe(challengeIds[acceptCalls - 1]);
    await route.abort("failed");
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  const dialog = await confirmTerminalAcceptance(page);

  await expect.poll(() => acceptCalls).toBe(1);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(staysOnProposal);
  await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  const errorToast = page.locator('[data-context-room-toast][role="alert"]');
  await expect(errorToast).toBeVisible();
  await expect(errorToast).toContainText(/Failed to fetch|NetworkError|Load failed/i);
  const retry = errorToast.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();

  await page.waitForTimeout(1_500);
  await expect(errorToast).toBeVisible();
  await expect(page).toHaveURL(staysOnProposal);
  expect(await page.evaluate(() => ({
    mode: state.sharedContext?.mode || "",
    proposalHead: state.sharedContext?.review?.proposalHead || "",
    remaining: proposalReviewFileEntries().filter((entry) => !entry.reviewed).length,
    busy: state.proposalActionBusy,
  }))).toEqual({
    mode: "review",
    proposalHead: "0123456789abcdef0123456789abcdef01234567",
    remaining: 0,
    busy: false,
  });
  await retry.click();
  await expect.poll(() => challengeCalls).toBe(2);
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toBeVisible();
  expect(acceptCalls).toBe(1);
  await expect(page).toHaveURL(staysOnProposal);
});

test("@smoke terminal action is in the viewport and keyboard-operable on mobile at 200% zoom", async ({ page }) => {
  const { origin } = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/?hub=1&view=proposal");
  await waitForBoot(page);
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-mobile-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });

  await showTerminalProposal(page);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const acceptButton = page.getByRole("button", { name: "Put on main", exact: true });
  await expect(acceptButton).toBeVisible();
  await expect(acceptButton).toBeInViewport();
  expect(await page.evaluate(() => {
    const accept = document.querySelector("#proposalDockAccept");
    const home = document.querySelector("#brandHome");
    return Boolean(
      accept
      && home
      && (accept.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING)
      && accept.getBoundingClientRect().left <= home.getBoundingClientRect().left
    );
  })).toBe(true);
  await acceptButton.focus();
  await expect(acceptButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#brandHome")).toBeFocused();
  await acceptButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toBeVisible();
});
