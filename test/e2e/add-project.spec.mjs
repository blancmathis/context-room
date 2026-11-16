import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createMemoryServer, initializeContextRoomProject, writeGlobalContextRoomPreferences } from "../../src/context_room.mjs";
import { contextHubHostRoot, registerContextHubProject } from "../../src/context_hub.mjs";
import { openNotebook } from "../../src/notebooks.mjs";

// A temporary empty Hub: the real ~/.context-room and the Hub on 4319 are never read.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

async function emptyHub({ registered = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-add-project-")));
  const previous = {};
  for (const key of ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME", "GIT_CONFIG_GLOBAL"]) {
    previous[key] = process.env[key];
    process.env[key] = key === "GIT_CONFIG_GLOBAL" ? "/dev/null" : path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const folder = path.join(process.env.HOME, "work", "Existing Docs");
  fs.mkdirSync(path.join(folder, "docs"), { recursive: true });
  fs.writeFileSync(path.join(folder, "docs", "guide.md"), "# Existing guide\n");
  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room Hub", allowedPaths: [], watchAllow: [] });
  // A Hub with projects already in it: the internal Hub folder and one project with a notebook.
  if (registered) {
    registerContextHubProject(hostRoot, { title: "Context Room Hub" });
    initializeContextRoomProject(folder, { title: "Existing Docs", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
    // A notebook is listed only inside a watched folder.
    openNotebook(folder, { path: "docs/plan.crnb", title: "Plan", canWrite: () => true, createOnly: true });
    registerContextHubProject(folder, { title: "Existing Docs" });
  }
  const globalPreferencesPath = path.join(base, "preferences.json");
  writeGlobalContextRoomPreferences({ explorer: { computerRoot: process.env.HOME } }, globalPreferencesPath);
  const runtime = createMemoryServer({ root: hostRoot, registerInHub: false, globalPreferencesPath });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${runtime.server.address().port}`,
    folder,
    async close() {
      await new Promise((resolve) => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); });
      await runtime.waitForShutdown?.();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

test("@smoke an empty Hub offers Add a project and an existing folder appears in the Explorer", async ({ page }) => {
  const hub = await emptyHub();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(page.getByRole("heading", { name: "Add your first project" })).toBeVisible();
    await expect(page.getByText("No project matches this search.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a project…" })).toHaveCount(1);
    await expect(page.locator("#contextHubWelcome")).toContainText(".context-room settings folder");
    await expect(page.locator("#contextHubWelcome")).not.toContainText("only reads");
    await page.getByRole("button", { name: "Add a project…" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a project" });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText("only reads");
    await expect(dialog.getByLabel("Show hidden folders")).not.toBeChecked();
    await dialog.getByLabel("Folder", { exact: true }).fill(hub.folder);
    await dialog.getByLabel("Folder", { exact: true }).dispatchEvent("change");
    await expect(dialog.getByLabel("Project name")).toHaveValue("Existing Docs");
    await dialog.getByRole("button", { name: "Add this folder" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Add your first project" })).toBeHidden();
    await expect(page.locator("#status")).toContainText("Added Existing Docs");
    // D1: the new project has no accepted version, so the explicit gesture is offered with the exact list.
    const trust = page.getByRole("dialog", { name: "Trust the current versions?" });
    await expect(trust).toBeVisible();
    await expect(trust.getByRole("list", { name: "1 file to trust" })).toContainText("docs/guide.md");
    // One Enter or Space never accepts a whole project: the dialog opens on Cancel.
    await expect(trust.getByRole("button", { name: "Cancel" })).toBeFocused();
    await trust.getByRole("button", { name: "Trust 1 file" }).click();
    await expect(trust).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("Trusted 1 current version");
    // R12: the new project opens on its own page, not in a Files view; once trusted, nothing waits and no offer stays.
    await expect(page.locator("#projectPageHead h2")).toHaveText("Existing Docs");
    await expect(page.locator("#explorerViewPanel")).toHaveCount(0);
    await expect(page.locator("#projectPageHead .pp-count")).toHaveText("Nothing to review", { timeout: 30_000 });
    await expect(page.locator("#projectTrust")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await hub.close();
  }
});

test("an empty Hub explains an error in plain words and Create a new folder stays reachable", async ({ page }) => {
  const hub = await emptyHub();
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await page.getByRole("button", { name: "Add a project…" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a project" });
    await dialog.getByLabel("Folder", { exact: true }).fill("/definitely/not/inside");
    await dialog.getByRole("button", { name: "Add this folder" }).click();
    await expect(dialog.getByRole("status")).toContainText(/not inside the Computer root/);
    await dialog.getByRole("button", { name: "Create a new folder instead" }).click();
    await expect(page.getByRole("dialog", { name: "Create a project" })).toBeVisible();
  } finally {
    await hub.close();
  }
});

const projectRow = (page, title) => page.locator("#globalProjectList a.global-project-row", { has: page.locator(".global-project-row-title strong", { hasText: title }) });

test("@smoke Trust the current versions from the project page leaves a receipt that undoes it", async ({ page }) => {
  const hub = await emptyHub();
  const errors = [];
  const failed = [];
  // A page.reload cuts a refresh short; WebKit reports that as "due to access control checks". Other errors count.
  page.on("pageerror", (error) => { if (!/due to access control checks/.test(error.message)) errors.push(error.message); });
  page.on("response", (response) => { if (response.status() >= 400) failed.push(response.status() + " " + response.url()); });
  // Only the dialog reads the exact list: the page itself never asks for it (the offer is the snapshot's hint).
  let listReads = 0;
  page.on("request", (request) => { if (request.method() === "GET" && request.url().includes("/api/context-hub/trust-current")) listReads += 1; });
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await page.getByRole("button", { name: "Add a project…" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a project" });
    await dialog.getByLabel("Folder", { exact: true }).fill(hub.folder);
    await dialog.getByLabel("Folder", { exact: true }).dispatchEvent("change");
    await dialog.getByRole("button", { name: "Add this folder" }).click();
    // Cancel the offer made after adding: the project page keeps it in view.
    await page.getByRole("dialog", { name: "Trust the current versions?" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#projectPageHead h2")).toHaveText("Existing Docs");
    const offer = page.locator("#projectTrust");
    await expect(offer).toContainText("No file of this project has an accepted version yet", { timeout: 30_000 });
    expect(listReads).toBe(1);
    await offer.getByRole("button", { name: "Trust the current versions…" }).click();
    const trust = page.getByRole("dialog", { name: "Trust the current versions?" });
    await expect(trust.getByRole("list", { name: "1 file to trust" })).toContainText("docs/guide.md");
    await trust.getByRole("button", { name: "Trust 1 file" }).click();
    await expect(page.locator("#status")).toContainText("Trusted 1 current version · undo from Recent decisions");
    await expect(offer).toBeHidden({ timeout: 30_000 });
    expect(listReads).toBe(2);

    // An agent then changes the accepted file: it waits for review, and the offer does not come back (a version is accepted).
    fs.writeFileSync(path.join(hub.folder, "docs", "guide.md"), "# Existing guide\n\nChanged by an agent.\n");
    await expect(async () => {
      await page.reload();
      await expect(page.locator("#projectPageHead .pp-count")).toHaveText("1 to review", { timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
    await expect(offer).toBeHidden();
    expect(listReads).toBe(2);

    // The receipt is in Recent decisions; undoing it brings the offer back on the project page.
    await page.goto(hub.origin + "/?hub=1&view=hub");
    const history = page.locator("#reviewHistoryPanel");
    await expect(history).toBeVisible({ timeout: 30_000 });
    await history.locator("summary").click();
    const receipt = history.locator("li", { hasText: "Trusted 1 current version" }).first();
    await receipt.getByRole("button", { name: "Undo this trust" }).click();
    await page.getByRole("dialog", { name: "Undo this trust?" }).getByRole("button", { name: "Undo trust" }).click();
    await expect(page.locator("#status")).toContainText("Trust undone");
    await projectRow(page, "Existing Docs").click();
    await expect(page.locator("#projectPageHead h2")).toHaveText("Existing Docs");
    await expect(offer).toContainText("No file of this project has an accepted version yet", { timeout: 30_000 });
    expect(listReads).toBe(2);
    expect(errors).toEqual([]);
    expect(failed).toEqual([]);
  } finally {
    await hub.close();
  }
});

test("@smoke the project page lists its notebooks, and ⋯ hides the project and shows the internal Hub folder", async ({ page }) => {
  const hub = await emptyHub({ registered: true });
  const errors = [];
  // A page.goto cuts a refresh short; WebKit reports that as "due to access control checks". Other errors count.
  page.on("pageerror", (error) => { if (!/due to access control checks/.test(error.message)) errors.push(error.message); });
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    const list = page.locator("#globalProjectList");
    // The internal Hub folder stays out of the Projects list until asked for.
    await expect(projectRow(page, "Existing Docs")).toBeVisible({ timeout: 30_000 });
    await expect(projectRow(page, "Context Room Hub")).toHaveCount(0);
    await expect(page.locator("#globalProjectCount")).toHaveText("1 · 1 hidden");

    await projectRow(page, "Existing Docs").click();
    await expect(page.locator("#projectPageHead h2")).toHaveText("Existing Docs");
    const notes = page.locator("#projectNotebooks");
    await expect(notes.getByRole("heading", { name: "Notebooks · 1" })).toBeVisible({ timeout: 30_000 });
    await notes.getByRole("button", { name: "Plan" }).click();
    await expect(page.locator("dialog.notebook-dialog[open]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.notebook-dialog[open]")).toHaveCount(0);

    // ⋯ › Hide: out of the list, still found by a search.
    const more = page.locator("#projectPageHead [data-pp-more]");
    await expect(more).toHaveAttribute("aria-label", "Project actions · Existing Docs");
    // The offer comes with the Hub snapshot: wait for its banner before reading the menu.
    await expect(page.locator("[data-pp-trust]")).toBeVisible({ timeout: 30_000 });
    // From the keyboard (WebKit does not focus a clicked button): Escape gives the focus back to ⋯.
    await more.focus();
    await page.keyboard.press("Enter");
    const menu = page.locator("#explorerContextMenu");
    // Nothing is accepted yet in this project, so the menu offers Trust.
    await expect(menu.getByRole("menuitem", { name: "Trust the current versions…" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.click();
    await menu.getByRole("menuitem", { name: "Hide from the Projects list" }).click();
    await expect(page.locator("#status")).toContainText("Existing Docs is hidden from the Projects list");
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(page.locator("#globalProjectCount")).toHaveText("0 · 2 hidden", { timeout: 30_000 });
    await expect(projectRow(page, "Existing Docs")).toHaveCount(0);
    await page.locator("#globalProjectSearch").fill("Existing");
    await projectRow(page, "Existing Docs").click();
    await expect(page.locator("#projectPageHead h2")).toHaveText("Existing Docs");

    // ⋯ › Show the internal Hub folder, then Show in the Projects list.
    await more.click();
    await menu.getByRole("menuitem", { name: "Show the internal Hub folder" }).click();
    await more.click();
    await menu.getByRole("menuitem", { name: "Show in the Projects list" }).click();
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(projectRow(page, "Context Room Hub")).toBeVisible({ timeout: 30_000 });
    await expect(projectRow(page, "Existing Docs")).toBeVisible();
    await expect(page.locator("#globalProjectCount")).toHaveText("2");
    await expect(list).not.toContainText("hidden");
    expect(errors).toEqual([]);
  } finally {
    await hub.close();
  }
});
