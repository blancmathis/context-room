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
  await page.evaluate(() => {
    for (const project of state.contextHub.projects) {
      if (project.projectKey === state.globalExplorerProjectKey) Object.assign(project, { localReviewCount: 0, sharedProposalCount: 0 });
    }
    syncProjectPage();
  });
  await expect(page.locator("#reviewQueuePanel")).toBeHidden();
  await expect(head.locator(".pp-count")).toHaveText("Nothing to review");
});

test("@layout To review groups the files per project and Open project leads to that page", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  await waitForBoot(page);
  const header = page.locator("#reviewQueue > .pp-group").first();
  await expect(header).toBeVisible();
  await expect(header.locator("strong")).toHaveText(/ · \d+$/);
  const title = (await header.locator("strong").textContent()).replace(/ · \d+$/, "");
  await header.getByRole("button", { name: "Open project ›" }).click();
  await expect(page.locator("#projectPageHead h2")).toHaveText(title);
});
