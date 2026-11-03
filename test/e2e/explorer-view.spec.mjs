import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createMemoryServer, initializeContextRoomProject } from "../../src/context_room.mjs";
import { contextHubHostRoot, registerContextHubProject } from "../../src/context_hub.mjs";

// A temporary Hub home: the real ~/.context-room and the Hub on 4319 are never read.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

function write(root, relativePath, content) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content, "utf8");
}

async function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-explorer-view-")));
  const previous = {};
  for (const key of ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME", "GIT_CONFIG_GLOBAL"]) {
    previous[key] = process.env[key];
    process.env[key] = key === "GIT_CONFIG_GLOBAL" ? "/dev/null" : path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const projects = {};
  for (const [name, files] of Object.entries({
    Alpha: { "CONTEXT.md": "# Alpha context\n", "README.md": "# Alpha\n", "page.html": "<h1>Page</h1>", "docs/guide.md": "# Guide\n\nHello guide.\n", "docs/deep/notes.md": "# Deep notes\n" },
    Beta: { "README.md": "# Beta readme\n", "plan.md": "# Plan\n" },
  })) {
    const root = path.join(base, name);
    for (const [file, content] of Object.entries(files)) write(root, file, content);
    initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
    registerContextHubProject(root, { title: name });
    projects[name] = root;
  }
  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room Hub", allowedPaths: [], watchAllow: [] });
  registerContextHubProject(hostRoot, { title: "Context Room Hub" });
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
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

const view = (page) => page.locator("#explorerViewPanel");
const projectButton = (page, title) => view(page).locator(".hl-select", { hasText: title });
const fileLink = (page, name) => view(page).locator("a.hl-file", { hasText: name });

async function openExplorer(page, origin) {
  await page.goto(origin + "/?hub=1&view=hub");
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await page.locator("[data-home-explorer]").click();
  await expect(view(page)).toBeVisible();
  await expect(page).toHaveURL(/view=explorer/);
  await expect(projectButton(page, "Alpha")).toBeVisible({ timeout: 15_000 });
}

test("@explorer Files opens from the home in one click, hides the internal Hub, and keeps the home intact", async ({ page }) => {
  const hub = await fixture();
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(page.locator("#contextHubProjectsPanel")).toBeVisible({ timeout: 15_000 });
    await expect(view(page)).toBeHidden();
    await page.locator("[data-home-explorer]").click();
    await expect(view(page)).toBeVisible();
    await expect(page.locator("#contextHubProjectsPanel")).toBeHidden();
    await expect(projectButton(page, "Alpha")).toBeVisible({ timeout: 15_000 });
    await expect(projectButton(page, "Beta")).toBeVisible();
    // « Context Room Hub » is hidden by default; the View menu can show it.
    await expect(view(page).getByText("Context Room Hub")).toHaveCount(0);
    await view(page).locator(".hl-view > summary").click();
    await view(page).locator("[data-hl-internal]").click();
    await expect(projectButton(page, "Context Room Hub")).toBeVisible();
    await view(page).locator("[data-hl-internal]").click();
    await expect(view(page).getByText("Context Room Hub")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await view(page).locator(".hl-view > summary").evaluate((node) => { node.parentElement.open = false; });
    await expect(view(page).locator('.hl-folders button[data-hl-dir=".context-room"]')).toHaveCount(0);
    if (process.env.CR_EXPLORER_SHOT) {
      await projectButton(page, "Alpha").click();
      await expect(fileLink(page, "CONTEXT.md")).toBeVisible();
      await expect(view(page).locator(".hl-agent")).not.toContainText("Reading…", { timeout: 30_000 });
      await page.screenshot({ path: process.env.CR_EXPLORER_SHOT });
    }
    // The Home button returns to the Hub home as it is today.
    await view(page).locator("[data-explorer-home]").click();
    await expect(page.locator("#contextHubProjectsPanel")).toBeVisible();
    await expect(view(page)).toBeHidden();
    await expect(page).toHaveURL(/view=hub/);
  } finally { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await hub.close(); } }
});

test("@explorer Files renders on a quiet Hub: no catalog refresh needed after the click, and Home comes back", async ({ page }) => {
  // The real Hub (2026-11-03) sends no catalog refresh after the click: the view must not wait for one.
  const hub = await fixture();
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(page.locator("#contextHubProjectsPanel")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#contextHubHomeProjectList")).toContainText("Alpha", { timeout: 15_000 });
    // From here, the catalog and the event stream stay silent.
    await page.route((url) => url.pathname === "/api/context-hub" || url.pathname === "/api/runtime-events", () => {});
    await page.locator("[data-home-explorer]").click();
    await expect(page).toHaveURL(/view=explorer/);
    await expect(view(page)).toBeVisible();
    await expect(page.locator("#contextHubProjectsPanel")).toBeHidden();
    await expect(projectButton(page, "Alpha")).toBeVisible({ timeout: 15_000 });
    await projectButton(page, "Alpha").click();
    await expect(fileLink(page, "README.md")).toBeVisible({ timeout: 15_000 });
    await view(page).locator("[data-explorer-home]").click();
    await expect(page).toHaveURL(/view=hub/);
    await expect(page.locator("#contextHubProjectsPanel")).toBeVisible();
    await expect(view(page)).toBeHidden();
    // Back in the browser history reopens the Files view.
    await page.goBack();
    await expect(page).toHaveURL(/view=explorer/);
    await expect(view(page)).toBeVisible();
  } finally { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await hub.close(); } }
});

test("@explorer pin, hide and unhide a project; the choice survives a reload", async ({ page }) => {
  const hub = await fixture();
  try {
    await openExplorer(page, hub.origin);
    await view(page).getByRole("button", { name: "Pin Beta" }).click();
    await expect(view(page).getByRole("button", { name: "Unpin Beta" })).toHaveAttribute("aria-pressed", "true");
    await expect(view(page).locator(".hl-group-title", { hasText: "Pinned" })).toBeVisible();
    await view(page).locator(".hl-view > summary").click();
    await view(page).locator("[data-hl-edit]").click();
    await view(page).locator(".hl-row", { has: page.locator(".hl-select", { hasText: "Alpha" }) }).locator("[data-hl-hide]").click();
    const hiddenCount = await view(page).locator("details.hl-group > summary", { hasText: "Hidden" }).count();
    expect(hiddenCount).toBe(1);
    await page.reload();
    await expect(view(page)).toBeVisible();
    await expect(view(page).getByRole("button", { name: "Unpin Beta" })).toBeVisible({ timeout: 15_000 });
    const hidden = view(page).locator("details.hl-group", { hasText: "Hidden" });
    await expect(hidden).toHaveCount(1);
    await hidden.locator("summary").click();
    await expect(hidden.locator(".hl-select", { hasText: "Alpha" })).toBeVisible();
    await hidden.locator("[data-hl-hide]").click();
    await expect(view(page).locator("details.hl-group", { hasText: "Hidden" })).toHaveCount(0);
    await page.reload();
    await expect(view(page).locator("details.hl-group", { hasText: "Hidden" })).toHaveCount(0);
    await expect(view(page).getByRole("button", { name: "Unpin Beta" })).toBeVisible({ timeout: 15_000 });
  } finally { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await hub.close(); } }
});

test("@explorer type filter and sort apply to the files and survive a reload", async ({ page }) => {
  const hub = await fixture();
  try {
    await openExplorer(page, hub.origin);
    await projectButton(page, "Alpha").click();
    await expect(fileLink(page, "CONTEXT.md")).toBeVisible();
    await expect(fileLink(page, "page.html")).toBeVisible();
    await view(page).locator('[data-hl-type="html"]').click();
    await expect(fileLink(page, "page.html")).toBeVisible();
    await expect(fileLink(page, "CONTEXT.md")).toHaveCount(0);
    await page.reload();
    await expect(view(page).locator('[data-hl-type="html"]')).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await expect(fileLink(page, "CONTEXT.md")).toHaveCount(0);
    await view(page).locator('[data-hl-type="all"]').click();
    await view(page).locator(".hl-view > summary").click();
    const names = () => view(page).locator("a.hl-file .hl-file-name strong").allTextContents();
    await view(page).locator('[data-hl-pref="fileSort"]').selectOption("type");
    const byType = await names();
    expect(byType.indexOf("page.html")).toBeLessThan(byType.indexOf("CONTEXT.md"));
    await view(page).locator('[data-hl-pref="fileSort"]').selectOption("name");
    expect(await names()).toEqual(["CONTEXT.md", "page.html", "README.md"]);
    await page.reload();
    await view(page).locator(".hl-view > summary").click();
    await expect(view(page).locator('[data-hl-pref="fileSort"]')).toHaveValue("name", { timeout: 15_000 });
  } finally { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await hub.close(); } }
});

test("@explorer open a folder, go back through the breadcrumb, open a file; the place survives a reload", async ({ page }) => {
  const hub = await fixture();
  try {
    await openExplorer(page, hub.origin);
    await projectButton(page, "Alpha").click();
    const crumbs = view(page).getByRole("navigation", { name: "Path" });
    // The path is visible even at the top: the project name appears once as the current segment.
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("Alpha");
    await view(page).locator('.hl-folders button[data-hl-dir="docs"]').click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("docs");
    await expect(fileLink(page, "guide.md")).toBeVisible();
    await view(page).locator('.hl-folders button[data-hl-dir="docs/deep"]').click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("deep");
    await expect(fileLink(page, "notes.md")).toBeVisible();
    await expect(page).toHaveURL(/explorerDir=docs%2Fdeep/);
    await page.reload();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("deep", { timeout: 15_000 });
    await expect(fileLink(page, "notes.md")).toBeVisible();
    await crumbs.getByRole("button", { name: "docs", exact: true }).click();
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText("docs");
    await crumbs.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(fileLink(page, "README.md")).toBeVisible();
    await expect(page).not.toHaveURL(/explorerDir=/);
    await view(page).locator('.hl-folders button[data-hl-dir="docs"]').click();
    await fileLink(page, "guide.md").click();
    await expect(page.locator("#viewer")).toContainText("Hello guide", { timeout: 15_000 });
    await expect(view(page)).toBeHidden();
    // Back returns to the folder, inside the Files view.
    await page.goBack();
    await expect(view(page)).toBeVisible({ timeout: 15_000 });
    await expect(view(page).getByRole("navigation", { name: "Path" }).locator('[aria-current="page"]')).toHaveText("docs");
  } finally { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await hub.close(); } }
});
