import fs from "node:fs";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}").phase || "").toBe("ready");
  await expect.poll(() => page.evaluate(() => Boolean(state.contextHub))).toBe(true);
}

async function openAtlas(page, data) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  await expect(page.locator("#projectPageHead h2")).toHaveText("Atlas");
  return page.evaluate(() => state.globalExplorerProjectKey);
}

async function resetTiles(page, data, projectKey) {
  if (!projectKey) return;
  // Through the page's own api(), so the request carries the same headers as the app.
  await page.evaluate((project) => api("/api/context-hub/project-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, page: { tiles: null } }),
  }), projectKey);
}

test("@layout the project page shows its own review first, then shortcuts that lead into the tree", async ({ page }) => {
  const data = fixture();
  let projectKey = "";
  try {
    projectKey = await openAtlas(page, data);
    await resetTiles(page, data, projectKey);
    await page.reload();
    await waitForBoot(page);
    // « To review » holds this project only; « What agents load » stays closed until asked for.
    await expect.poll(() => page.evaluate(() => state.sharedProposalProject)).toBe(projectKey);
    await expect(page.locator("#contextHealthPanel")).toBeHidden();
    // The project tab sits between Projects and Computer; the Projects tab leads back to the list.
    await expect(page.locator('[data-global-explorer-mode="project"]')).toHaveText("Atlas");
    await expect(page.locator('[data-global-explorer-mode="projects"]')).toHaveAttribute("aria-label", "Back to projects");

    // Default shortcuts: the agent files first, then each top-level folder. A folder does not look like a file.
    const tiles = page.locator("#projectTiles [data-project-tile]");
    await expect(tiles.first()).toHaveAttribute("data-tile-type", "agents");
    const docsTile = page.getByRole("button", { name: "Folder docs", exact: true });
    await expect(docsTile).toBeVisible();
    await expect(page.locator("#reviewQueuePanel")).toBeVisible();
    const order = await page.evaluate(() => ["#projectPageHead", "#reviewQueuePanel", "#projectTiles"].map((selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top)));
    expect(order, JSON.stringify(order)).toEqual([...order].sort((a, b) => a - b));

    // A folder shortcut opens that folder in the tree.
    await docsTile.click();
    const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
    await expect(docsFolder).toHaveAttribute("aria-expanded", "true");
    await expect(docsFolder).toBeFocused();

    // The agent files shortcut opens « What agents load »; Close hides it again.
    await tiles.first().click();
    await expect(page.locator("#contextHealthPanel")).toBeVisible();
    await expect(page.locator("#contextHealthPanel h2").first()).toHaveText("What agents load");
    await page.locator("#contextHealthPanel [data-pp-close]").click();
    await expect(page.locator("#contextHealthPanel")).toBeHidden();
  } finally {
    await resetTiles(page, data, projectKey).catch(() => {});
  }
});

test("@layout shortcuts are edited on the page, pinned from the tree, and kept after a reload", async ({ page }) => {
  const data = fixture();
  let projectKey = "";
  try {
    projectKey = await openAtlas(page, data);
    await resetTiles(page, data, projectKey);
    await page.reload();
    await waitForBoot(page);
    const tiles = page.locator("#projectTiles [data-project-tile]");
    await expect(page.getByRole("button", { name: "Folder docs", exact: true })).toBeVisible();

    // Edit, remove the docs folder, Done: the change is saved in the Hub.
    await page.locator("#projectTiles [data-tiles-edit]").click();
    const saved = page.waitForResponse((response) => response.url().includes("/api/context-hub/project-page") && response.request().method() === "POST");
    await page.locator('#projectTiles [data-tile-remove][data-tile-key="folder:docs"]').click();
    expect((await saved).status()).toBe(200);
    await page.locator("#projectTiles [data-tiles-edit]").click();
    await expect(page.getByRole("button", { name: "Folder docs", exact: true })).toHaveCount(0);

    // Pin a file from the tree menu.
    const docsFolder = page.locator('[data-global-project-folder="docs"]').first();
    if (await docsFolder.getAttribute("aria-expanded") !== "true") await docsFolder.click();
    const readme = page.locator('[data-global-project-file="docs/README.md"]').first();
    await expect(readme).toBeVisible();
    await readme.click({ button: "right" });
    const pinned = page.waitForResponse((response) => response.url().includes("/api/context-hub/project-page") && response.request().method() === "POST");
    await page.locator("#explorerContextMenu [data-global-context-pin]").click();
    expect((await pinned).status()).toBe(200);
    await expect(page.getByRole("button", { name: "File README.md", exact: true })).toBeVisible();

    await page.reload();
    await waitForBoot(page);
    await expect(page.getByRole("button", { name: "File README.md", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Folder docs", exact: true })).toHaveCount(0);
    await expect(tiles.first()).toHaveAttribute("data-tile-type", "agents");

    // A file shortcut opens the document.
    await page.getByRole("button", { name: "File README.md", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("docs/README.md");
  } finally {
    await resetTiles(page, data, projectKey).catch(() => {});
  }
});

test("@layout the project page shows what agents load per level and this project's recent docs", async ({ page }) => {
  const data = fixture();
  let projectKey = "";
  try {
    projectKey = await openAtlas(page, data);
    await resetTiles(page, data, projectKey);
    await page.reload();
    await waitForBoot(page);

    // « What agents load »: one box per level; the root holds AGENTS.md with its tokens.
    await page.locator("#projectPageHead [data-pp-agents]").click();
    const root = page.locator('#projectAgentLevels [data-pp-level="root"]');
    await expect(root).toBeVisible();
    await expect(root.locator("summary")).toContainText("Project root");
    await expect(root.locator("summary")).toContainText("tokens at start");
    await expect(root.locator('[data-pp-open="AGENTS.md"]')).toBeVisible();
    await page.locator("#contextHealthPanel [data-pp-close]").click();
    await expect(page.locator("#projectAgentLevels")).toBeHidden();

    // « Recent » lists the docs of this project, and a row opens its file.
    await page.locator("#projectTiles [data-tiles-edit]").click();
    const saved = page.waitForResponse((response) => response.url().includes("/api/context-hub/project-page") && response.request().method() === "POST");
    await page.locator("#projectTiles [data-tile-add]", { hasText: "Recent" }).click();
    expect((await saved).status()).toBe(200);
    await page.locator("#projectTiles [data-tiles-edit]").click();
    await page.locator('#projectTiles [data-tile-type="recent"]').click();
    const recent = page.locator("#projectRecentDocs [data-pp-open]");
    await expect(recent.first()).toBeVisible();
    expect(await recent.evaluateAll((nodes) => nodes.map((node) => node.dataset.ppOpen))).toContain("docs/README.md");
    await page.locator('#projectRecentDocs [data-pp-open="docs/README.md"]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("docs/README.md");
  } finally {
    await resetTiles(page, data, projectKey).catch(() => {});
  }
});

test("@layout at 820 px the Explorer does not cover the project page and the back button keeps the count", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub&explorer=expanded`);
  await waitForBoot(page);
  const head = page.locator("#projectPageHead");
  await expect(head.locator("h2")).toHaveText("Atlas");
  await expect(page.locator(".app")).toHaveClass(/sidebar-collapsed/);
  await expect.poll(() => head.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
  const total = await page.evaluate(() => state.contextHub.projects.reduce((sum, item) => sum + Number(item.localReviewCount || 0) + Number(item.sharedProposalCount || 0), 0));
  expect(total).toBeGreaterThan(0);
  await expect(head.locator("[data-pp-home]")).toHaveText(`‹ To review · ${total}`);

  // A project with nothing to review has no « To review » band.
  await expect(page.locator("#reviewQueuePanel")).toBeVisible();
  // A Hub snapshot may still land after boot and bring the counts back: empty the project until the band hides.
  await expect.poll(() => page.evaluate(async () => {
    const key = state.globalExplorerProjectKey;
    for (const project of state.contextHub.projects) {
      if (project.projectKey === key) Object.assign(project, { localReviewCount: 0, sharedProposalCount: 0 });
    }
    state.contextHub.items = state.contextHub.items.filter((item) => contextHubProjectForItem(item)?.projectKey !== key);
    state.contextHub.workingDrafts = [];
    syncProjectPage();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return document.getElementById("reviewQueuePanel").classList.contains("pp-none");
  })).toBe(true);
  await expect(page.locator("#reviewQueuePanel")).toBeHidden();
  await expect(head.locator(".pp-count")).toHaveText("Nothing to review");

  // A local proposal alone keeps the band: it is work to review.
  const band = await page.evaluate(async () => {
    const project = state.contextHub.projects.find((item) => item.projectKey === state.globalExplorerProjectKey);
    state.contextHub.items.push({ type: "local-proposal", id: "e2e-proposal", projectKey: project.projectKey, projectId: project.id, title: "Proposal", fileCount: 1 });
    syncProjectPage();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { counts: reviewCountOf(project), hidden: document.getElementById("reviewQueuePanel").classList.contains("pp-none") };
    function reviewCountOf(item) { return Number(item.localReviewCount || 0) + Number(item.sharedProposalCount || 0); }
  });
  expect(band, "only a local proposal: " + JSON.stringify(band)).toEqual({ counts: 0, hidden: false });
  await expect(page.locator("#reviewQueuePanel")).toBeVisible();
});

test("@layout To review groups the files per project and Open project leads to that page", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  await waitForBoot(page);
  const header = page.locator("#reviewQueue > .pp-group").first();
  await expect(header).toBeVisible();
  await expect(header.locator("strong")).toHaveText(/ · \d+$/);
  // One header per project, and its count is the project's whole review.
  const groups = await page.evaluate(() => [...document.querySelectorAll("#reviewQueue > .pp-group")].map((node) => {
    const project = state.contextHub.projects.find((item) => item.projectKey === node.dataset.ppGroup);
    const own = contextHubReviewItems().filter((item) => (item.type === "local-proposal" || item.type === "local-asset") && contextHubProjectForItem(item)?.projectKey === project.projectKey).length;
    return { key: node.dataset.ppGroup, shown: Number(node.querySelector("strong").textContent.split(" · ").pop()), total: Number(project.localReviewCount || 0) + Number(project.sharedProposalCount || 0) + own };
  }));
  expect(new Set(groups.map((group) => group.key)).size, JSON.stringify(groups)).toBe(groups.length);
  for (const group of groups) expect(group.shown, JSON.stringify(group)).toBe(group.total);
  const title = (await header.locator("strong").textContent()).replace(/ · \d+$/, "");
  await header.getByRole("button", { name: "Open project ›" }).click();
  await expect(page.locator("#projectPageHead h2")).toHaveText(title);
});

test("@layout a direct link to a doc shows the breadcrumb, opens the tree on it with review dots, and the project name leads back", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=file&file=docs/operations.md&explorer=expanded`);
  await waitForBoot(page);
  const crumb = page.locator("#workspaceTitle");
  await expect(crumb).toHaveText("Atlas › docs › operations.md");
  await expect(page.locator("#status")).not.toHaveText(/open$/);
  const row = page.locator('[data-global-project-file="docs/operations.md"]');
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(row.locator(".tree-dot")).toHaveAttribute("aria-label", /review/i);
  // One review dot per queued file; the folder shows how many of its files wait.
  const queued = await page.locator("#globalProjectList .tree-dot").count();
  expect(queued).toBeGreaterThan(0);
  await expect(page.locator('[data-global-project-folder="docs"] [data-review-count]')).toHaveText(/^[1-9]\d*$/);

  await page.reload();
  await waitForBoot(page);
  await expect(page.locator('[data-global-project-file="docs/operations.md"]')).toHaveAttribute("aria-current", "page");

  await crumb.locator("[data-crumb-project]").click();
  await expect(page.locator("#projectPageHead h2")).toHaveText("Atlas");
});
