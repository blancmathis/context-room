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
