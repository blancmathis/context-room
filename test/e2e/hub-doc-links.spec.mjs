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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-hub-doc-links-")));
  const previous = {};
  for (const key of ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME", "GIT_CONFIG_GLOBAL"]) {
    previous[key] = process.env[key];
    process.env[key] = key === "GIT_CONFIG_GLOBAL" ? "/dev/null" : path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const projects = {};
  for (const [name, files] of Object.entries({
    Alpha: {
      "README.md": "# Alpha\n\nRead the [Guide](docs/guide.md) and the [Deep notes](./docs/deep/notes.md).\nAlso the [Gone page](docs/gone.md) and the [Old page](old/gone.md).\nSee the [Far part](docs/guide.md#far-part).\n",
      "docs/guide.md": "# Guide\n\nHello guide.\n\n" + "Filler line.\n\n".repeat(120) + "## Far part\n\nThe [Other](other/page.md) and [Back](../README.md).\n\n" + "Filler line.\n\n".repeat(60),
      "docs/deep/notes.md": "# Deep notes\n",
      "docs/other/page.md": "# Other page\n",
    },
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

test("@links a relative link in a Hub document opens the target; a link to a missing file is greyed", async ({ page }) => {
  const hub = await fixture();
  // No folder read may answer 404: a missing folder means a missing file, never a request for it.
  const failures = [];
  const listings = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && [404, 409].includes(response.status())) failures.push(response.status() + " " + response.url());
    if (response.url().includes("/project-explorer?")) listings.push(new URL(response.url()).searchParams.get("path") || "");
  });
  // The first read of docs/ fails: it must be read again (no state kept from a failed read).
  let failDocs = true;
  await page.route(/project-explorer\?.*path=docs(&|$)/, (route) => {
    if (!failDocs) return route.continue();
    failDocs = false;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "test failure" }) });
  });
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
    await page.locator("[data-home-explorer]").click();
    await view(page).locator(".hl-select", { hasText: "Alpha" }).click();
    const reader = page.locator("#docReader");
    await view(page).locator("a.hl-file", { hasText: "README.md" }).click();
    await expect(reader).toContainText("Read the", { timeout: 15_000 });
    await expect.poll(() => failDocs).toBe(false);
    // Three real links are clickable; the dead ones (missing file, missing folder) are greyed labels, not raw markdown.
    await expect(reader.locator("a[data-doc-link-path]")).toHaveCount(3, { timeout: 15_000 });
    await expect(reader.locator(".markdown-doc-link-missing")).toHaveText(["Gone page", "Old page"]);
    await expect(reader.locator("a", { hasText: "Gone page" })).toHaveCount(0);
    await expect(reader).not.toContainText("](");
    if (process.env.CR_LINKS_SHOT) await page.screenshot({ path: process.env.CR_LINKS_SHOT });
    // An anchor link: the reader redraws once for docs/other/ and keeps the anchor in view.
    await reader.locator("a[data-doc-link-path]", { hasText: "Far part" }).click();
    await expect(page.locator("#docReader")).toContainText("Hello guide.", { timeout: 15_000 });
    await expect(page.locator("#docReader a[data-doc-link-path]", { hasText: "Other" })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("#docReader a[data-doc-link-path]", { hasText: "Back" })).toHaveCount(1);
    await expect(page.locator('#docReader [data-heading-id="far-part"]')).toBeInViewport();
    expect(listings).not.toContain("old");
    expect(failures).toEqual([]);
  } finally {
    await hub.close();
  }
});
