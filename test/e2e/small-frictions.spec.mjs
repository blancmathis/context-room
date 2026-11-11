import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { assistantFixture } from "../fixtures/assistant.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../../src/context_room.mjs";
import { contextHubHostRoot, registerContextHubProject } from "../../src/context_hub.mjs";

// A temporary Hub home: the real ~/.context-room and the Hub on 4319 are never read.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

function write(root, relativePath, content) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content, "utf8");
}

async function fixture({ only = null } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-small-frictions-")));
  const previous = {};
  for (const key of ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME", "GIT_CONFIG_GLOBAL"]) {
    previous[key] = process.env[key];
    process.env[key] = key === "GIT_CONFIG_GLOBAL" ? "/dev/null" : path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const projects = {};
  for (const [name, files] of Object.entries({
    Alpha: { "CONTEXT.md": "# Alpha context\n", "README.md": "# Alpha\n", "page.html": "<h1>Page</h1>", "docs/guide.md": "# Guide\n\nHello guide.\n", "docs/deep/notes.md": "# Deep notes\n", "notes/blob.bin": "x" },
    Beta: { "README.md": "# Beta readme\n", "plan.md": "# Plan\n" },
  }).filter(([name]) => !only || only.includes(name))) {
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
async function ready(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
}
async function openAlphaFile(page, origin, name) {
  await page.goto(origin + "/?hub=1&view=hub");
  await ready(page);
  await page.locator("[data-home-explorer]").click();
  await view(page).locator(".hl-select", { hasText: "Alpha" }).click();
  const link = view(page).locator("a.hl-file", { hasText: name });
  await expect(link).toBeVisible({ timeout: 15_000 });
  return new URL(await link.getAttribute("href"));
}
async function closeHub(page, hub) { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await hub.close(); } }

test("@a11y document toolbar buttons say what they do, and Dictate differs from Voice", async ({ page }) => {
  const f = await assistantFixture();
  try {
    fs.writeFileSync(path.join(f.root, "docs/Original.md"), "# Original document\n\nSome text.\n");
    await page.goto(f.url);
    await page.waitForFunction(() => Boolean(state.ownerMutationNonce && state.projectId));
    await page.evaluate(() => selectFile("docs/Original.md"));
    const titles = {};
    for (const key of ["conversation", "dictate", "voice", "annotate"]) {
      const button = page.locator(`.file-actions [data-file-${key}]`);
      await expect(button).toBeVisible({ timeout: 20_000 });
      titles[key] = await button.getAttribute("title");
      expect(titles[key], key).toBeTruthy();
    }
    expect(new Set(Object.values(titles)).size).toBe(4);
    expect(titles.dictate).toMatch(/type/i);
    expect(titles.voice).toMatch(/agent/i);
  } finally { try { if (!page.isClosed()) await page.goto("about:blank"); } finally { await f.close(); } }
});

test("@a11y the Explorer back-to-projects button has a name and a tooltip", async ({ page }) => {
  const hub = await fixture();
  try {
    const href = await openAlphaFile(page, hub.origin, "README.md");
    await page.goto(href.toString());
    await ready(page);
    const back = page.locator("[data-global-explorer-back]");
    await expect(back).toHaveAttribute("aria-label", "Back to projects");
    await expect(back).toHaveAttribute("title", "Back to projects");
  } finally { await closeHub(page, hub); }
});

test("@a11y the first Tab reaches a Skip to content link that moves focus to the main area", async ({ page }) => {
  const hub = await fixture();
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await ready(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await expect(page).not.toHaveURL(/#/);
  } finally { await closeHub(page, hub); }
});

test("@smoke a file that no longer exists says so and offers a way back; a real refusal keeps its message", async ({ page }) => {
  const hub = await fixture();
  try {
    const href = await openAlphaFile(page, hub.origin, "README.md");
    const open = (file) => { const target = new URL(href); target.searchParams.set("view", "file"); target.searchParams.set("file", file); return target.toString(); };
    await page.goto(open("notes/nope.md"));
    await expect(page.getByText("This file no longer exists")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("It may have been moved or deleted.")).toBeVisible();
    await expect(page.getByText("Path not allowed")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to home" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // F32: a calm empty state, not an error: UI font, neutral colour, only the path in monospace.
    const calm = await page.locator("#viewer .file-load-state").evaluate((node) => {
      const strong = getComputedStyle(node.querySelector("strong"));
      const [r, g, b] = strong.color.match(/\d+/g).map(Number);
      return { error: node.classList.contains("error"), role: node.getAttribute("role"), strongMono: /mono|menlo|courier/i.test(strong.fontFamily), strongRed: r - Math.max(g, b) > 40, codeMono: /mono|menlo/i.test(getComputedStyle(node.querySelector("code")).fontFamily) };
    });
    expect(calm, JSON.stringify(calm)).toEqual({ error: false, role: "status", strongMono: false, strongRed: false, codeMono: true });
    await page.getByRole("button", { name: "Back to home" }).click();
    await expect(page.locator("#reviewQueuePanel")).toBeVisible();
    await page.goto(open("notes/blob.bin"));
    await expect(page.getByText("Could not open this file")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#viewer").getByText(/Path not allowed/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to home" })).toHaveCount(0);
  } finally { await closeHub(page, hub); }
});

test("@smoke Files and settings use the singular for one project", async ({ page }) => {
  const hub = await fixture({ only: ["Alpha"] });
  try {
    await page.goto(hub.origin + "/?hub=1&view=hub");
    await ready(page);
    await page.locator("[data-home-explorer]").click();
    await expect(view(page).locator(".hl-head p")).toContainText("with files here", { timeout: 15_000 });
    await expect(view(page).locator(".hl-head p")).not.toContainText(/\b1 projects/);
    const counts = await page.evaluate(() => [nounCount(1, "projects"), nounCount(1, "repositories"), nounCount(2, "repositories"), nounCount(0, "gates")]);
    expect(counts).toEqual(["1 project", "1 repository", "2 repositories", "0 gates"]);
  } finally { await closeHub(page, hub); }
});

test("@smoke graph filters wrap inside the toolbar at 1440 px and stay tappable", async ({ page }) => {
  const hub = await fixture();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const href = await openAlphaFile(page, hub.origin, "README.md");
    await page.goto(href.toString().replace(/&file=[^&]*/, "") + "&file=README.md");
    await ready(page);
    await page.locator("#graphLocal").click();
    await expect(page.locator("#graphPage")).toBeVisible();
    const geometry = await page.locator(".graph-filterbar").evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      const last = [...bar.children].at(-1).getBoundingClientRect();
      return { overflowX: bar.scrollWidth - bar.clientWidth, refreshRight: last.right, barRight: box.right, wraps: getComputedStyle(bar).flexWrap };
    });
    expect(geometry.overflowX).toBeLessThanOrEqual(1);
    expect(geometry.refreshRight).toBeLessThanOrEqual(geometry.barRight - 8);
  } finally { await closeHub(page, hub); }
});

test("@a11y graph filter targets are at least 40 px on a touch device", async ({ browser }) => {
  const hub = await fixture();
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const href = await openAlphaFile(page, hub.origin, "README.md");
    await page.goto(href.toString());
    await ready(page);
    await page.locator("#graphLocal").click();
    await expect(page.locator("#graphPage")).toBeVisible();
    const heights = await page.locator(".graph-filterbar label, #graphRefresh").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(5);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(40);
  } finally { await context.close(); await closeHub(page, hub); }
});

test("@smoke counters use the singular for one item (source guard on nounCount)", async () => {
  const source = fs.readFileSync(new URL("../../src/ui/app.mjs", import.meta.url), "utf8");
  const bad = source.match(/[+] " (paths|agent paths|git names|sources|local files|proposals)"/g);
  expect(bad).toBeNull();
});

for (const width of [1280, 1440]) {
  test(`@smoke graph filter bar is one row at ${width} px and Refresh sits with Fit and List`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "touch devices use 44 px targets and may wrap; covered by the ux-endurance caps");
    const hub = await fixture();
    try {
      await page.setViewportSize({ width, height: 900 });
      const href = await openAlphaFile(page, hub.origin, "README.md");
      await page.goto(href.toString());
      await ready(page);
      await page.locator("#graphLocal").click();
      await expect(page.locator("#graphPage")).toBeVisible();
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector(".graph-filterbar").getBoundingClientRect();
        // A select narrower than its chosen option cuts the text ("All relatic"): measure the text it must show.
        const context = document.createElement("canvas").getContext("2d");
        const clipped = [...document.querySelectorAll(".graph-filterbar select")].filter((select) => {
          const style = getComputedStyle(select);
          context.font = style.fontSize + " " + style.fontFamily;
          const text = select.options[select.selectedIndex].text;
          return Math.ceil(context.measureText(text).width) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) > select.clientWidth;
        }).map((select) => select.options[select.selectedIndex].text);
        return { children: [...document.querySelector(".graph-filterbar").children].map((c) => Math.round(c.getBoundingClientRect().width)).join(","), avail: bar.width, barHeight: bar.height, clipped, refreshInHeader: Boolean(document.querySelector(".graph-toolbar #graphRefresh")) };
      });
      expect(geometry.clipped, JSON.stringify(geometry)).toEqual([]);
      expect(geometry.refreshInHeader).toBe(true);
      expect(geometry.barHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(46);
    } finally { await closeHub(page, hub); }
  });
}
