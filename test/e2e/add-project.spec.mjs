import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createMemoryServer, initializeContextRoomProject, writeGlobalContextRoomPreferences } from "../../src/context_room.mjs";
import { contextHubHostRoot } from "../../src/context_hub.mjs";

// A temporary empty Hub: the real ~/.context-room and the Hub on 4319 are never read.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

async function emptyHub() {
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
    await page.getByRole("button", { name: "Add a project…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a project" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Folder", { exact: true }).fill(hub.folder);
    await dialog.getByLabel("Folder", { exact: true }).dispatchEvent("change");
    await expect(dialog.getByLabel("Project name")).toHaveValue("Existing Docs");
    await dialog.getByRole("button", { name: "Add this folder" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Add your first project" })).toBeHidden();
    await expect(page.locator("#status")).toContainText("Added Existing Docs");
    const files = page.locator("#explorerViewPanel");
    await expect(files.locator(".hl-select[aria-current=true]", { hasText: "Existing Docs" })).toBeVisible();
    await expect(files.getByRole("button", { name: "docs" }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await hub.close();
  }
});

test("an empty Hub explains an error in plain words and Create a new folder stays reachable", async ({ page }) => {
  const hub = await emptyHub();
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await page.getByRole("button", { name: "Add a project…" }).first().click();
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
