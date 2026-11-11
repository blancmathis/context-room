import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { buildContextRoomDoctorReport, createMemoryServer, initializeContextRoomProject, readMemoryWebappSettings } from "../../src/context_room.mjs";
import { contextHubHostRoot, registerContextHubProject } from "../../src/context_hub.mjs";
import { inspectOwnerReviewScope } from "../../src/review_authority.mjs";

// The two review scope notices of Settings > Review and trust (docs/features/review-authority.md, "Owner-authorized scope"):
// "Changed outside Settings" and "Owner review authority is missing". Each test uses its own temporary Hub, never
// ~/.context-room and never the Hub on 4317 to 4320.
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

const ENV_KEYS = ["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME", "GIT_CONFIG_GLOBAL"];

async function scopeHub(names = ["Alpha"]) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-scope-notice-")));
  const previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    process.env[key] = key === "GIT_CONFIG_GLOBAL" ? "/dev/null" : path.join(base, key);
  }
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const projects = {};
  for (const name of names) {
    const root = path.join(base, name);
    for (const folder of ["docs", "notes"]) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
      fs.writeFileSync(path.join(root, folder, "a.md"), `# ${name} ${folder}\n`);
    }
    initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/", "notes/"], watchAllow: ["docs/", "notes/"] });
    const entry = registerContextHubProject(root, { title: name });
    const configPath = path.join(root, ".context-room", "config.json");
    const authorityPath = inspectOwnerReviewScope(root, readMemoryWebappSettings(root), { readOnly: true }).authorityPath;
    projects[name] = {
      id: entry.id,
      name,
      root,
      configPath,
      authorityPath,
      witnessPath: authorityPath.replace(/\.json$/, ".signed"),
      watchAllow: () => JSON.parse(fs.readFileSync(configPath, "utf8")).watchAllow,
      allowedPaths: () => JSON.parse(fs.readFileSync(configPath, "utf8")).allowedPaths,
      // As an agent or a tool would: config.json loses notes/ without going through Settings.
      reduceConfig() {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
        raw.allowedPaths = ["docs/"];
        raw.watchAllow = ["docs/"];
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
      },
      // The signed file and its backup are gone; only the witness (<id>.signed) remains.
      deleteAuthority() {
        fs.rmSync(authorityPath);
        fs.rmSync(`${authorityPath}.backup`, { force: true });
      },
      // The signed authority itself (not config.json): what it protects, read through inspectOwnerReviewScope with an empty scope.
      signedScope: () => inspectOwnerReviewScope(root, { allowedPaths: [], watchAllow: [] }, { readOnly: true }).reductions.filter((r) => r.field === "allowedPaths" || r.field === "watchAllow").map((r) => `${r.field}:${r.value}`).sort(),
      tamperIssue: () => buildContextRoomDoctorReport(root, { readOnly: true }).issues.some((issue) => issue.type === "review_authority_tamper"),
    };
  }
  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room Hub", allowedPaths: [], watchAllow: [] });
  const runtime = createMemoryServer({ root: hostRoot, registerInHub: false });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${runtime.server.address().port}`,
    projects,
    async close() {
      await new Promise((resolve) => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); });
      await runtime.waitForShutdown?.();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

// Waits until the page has no request in flight, no scheduled refresh and no pending save of its place.
const inFlightRequests = new WeakMap();
function trackRequests(page) {
  const open = new Set(); inFlightRequests.set(page, open);
  page.on("request", (request) => { if (!request.url().includes("/api/runtime-events")) open.add(request); }); // that stream stays open on purpose
  for (const event of ["requestfinished", "requestfailed"]) page.on(event, (request) => open.delete(request));
}
async function waitForQuiet(page) {
  const busy = () => page.evaluate(() => Boolean(
    state.refreshInFlight || state.reportsRefreshInFlight || state.backgroundRefreshTimer || state.backgroundRefreshPendingOptions
    || state.localForegroundRefreshTimer || state.workspaceRegistrationPromise || state.workspacePresenceDrainPromise || state.workspacePresenceQueued
    || state.runtimeContextHubRefreshPromise || state.runtimeContextHubRefreshTimer || state.contextHubBusy || state.contextHubOpensInFlight
    || state.contextAttentionLoading || state.contextHubSnapshotPollTimer || state.contextHub?.freshness?.refreshing || state.sessionStateTimer));
  const open = inFlightRequests.get(page);
  const quiet = async () => open.size === 0 && !(await busy());
  await expect.poll(quiet, { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(quiet, { timeout: 15_000 }).toBe(true);
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}").phase || "").toBe("ready");
  await expect.poll(() => page.evaluate(() => state.runtimeEventsConnected)).toBe(true);
}

// Opens Settings on the Review and trust tab with the project selected, after a reload that waited for quiet.
async function openReviewSettings(page, hub, project) {
  await page.goto(`${hub.origin}/?hub=1&project=${encodeURIComponent(project.id)}&view=hub`);
  await waitForBoot(page);
  await waitForQuiet(page);
  await showSettings(page);
}

async function showSettings(page) {
  await page.locator("#settingsButton").click();
  await expect(page.locator("#settingsPage")).toBeVisible();
  await page.locator('[data-settings-section-target="review-trust"]').click();
  await expect(page.locator("#watchAllow")).toBeVisible();
}

const notice = (page) => page.locator("[data-review-scope-notice]");
const save = (page) => page.locator("#saveSettings");

test.beforeEach(async ({ page }) => { trackRequests(page); });

test("@smoke @settings a reduction made outside Settings shows the notice; Keep and Save keeps the signed scope", async ({ page }) => {
  const hub = await scopeHub();
  const alpha = hub.projects.Alpha;
  try {
    alpha.reduceConfig();
    expect(alpha.tamperIssue()).toBe(true);
    await openReviewSettings(page, hub, alpha);
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("Changed outside Settings");
    await expect(notice(page).locator("li code")).toHaveText(["notes/"]);
    await expect(notice(page).getByRole("button", { name: "Accept the reduction" })).toBeVisible();
    // The field still shows the owner-authorized scope.
    await expect(page.locator("#watchAllow")).toHaveValue(/docs\/\nnotes\/|notes\/\ndocs\//);
    await expect(page.locator("#settingsSaveState")).toContainText("Your decision is needed");
    await expect(save(page)).toBeEnabled();

    await save(page).click();
    await expect(page.locator("#status")).toContainText("project settings saved");
    await expect(page.locator("#status")).toContainText("still in review, reduction discarded: notes/");
    await expect(notice(page)).toHaveCount(0);
    expect(alpha.watchAllow()).toEqual(expect.arrayContaining(["docs/", "notes/"]));
    expect(alpha.allowedPaths()).toEqual(expect.arrayContaining(["docs/", "notes/"]));
    expect(alpha.signedScope()).toEqual(["allowedPaths:docs/", "allowedPaths:notes/", "watchAllow:docs/", "watchAllow:notes/"]);
    expect(alpha.tamperIssue()).toBe(false);
    await expect(page.locator("#watchAllow")).toHaveValue(/notes\//);
  } finally {
    await hub.close();
  }
});

test("@smoke @settings Accept the reduction then Save signs the reduced scope", async ({ page }) => {
  const hub = await scopeHub();
  const alpha = hub.projects.Alpha;
  try {
    alpha.reduceConfig();
    await openReviewSettings(page, hub, alpha);
    await expect(notice(page)).toContainText("Changed outside Settings");
    await notice(page).getByRole("button", { name: "Accept the reduction" }).click();
    await expect(notice(page).locator("[data-review-scope-accepted]")).toContainText("Reduction accepted");
    await expect(notice(page).getByRole("button", { name: "Accept the reduction" })).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("reduction accepted: notes/");
    // Accepting is visible in the field: notes/ is gone from it.
    await expect(page.locator("#watchAllow")).not.toHaveValue(/notes\//);

    await save(page).click();
    await expect(page.locator("#status")).toContainText("project settings saved");
    await expect(page.locator("#status")).toContainText("reduction accepted: notes/");
    await expect(notice(page)).toHaveCount(0);
    expect(alpha.watchAllow()).toEqual(["docs/"]);
    expect(alpha.signedScope()).toEqual(["allowedPaths:docs/", "watchAllow:docs/"]);
    expect(alpha.tamperIssue()).toBe(false);
  } finally {
    await hub.close();
  }
});

test("@smoke @settings a deleted authority shows the missing notice; an unconfirmed Save is refused in words, Confirm then Save signs", async ({ page }) => {
  const hub = await scopeHub();
  const alpha = hub.projects.Alpha;
  try {
    expect(fs.existsSync(alpha.witnessPath)).toBe(true);
    alpha.deleteAuthority();
    alpha.reduceConfig();
    expect(alpha.tamperIssue()).toBe(true);
    await openReviewSettings(page, hub, alpha);
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("Owner review authority is missing");
    await expect(notice(page).getByRole("button", { name: "Confirm this scope" })).toBeVisible();
    await expect(page.locator("#settingsSaveState")).toContainText("Your decision is needed");

    const refused = page.waitForResponse((r) => r.url().includes("/api/context-hub/project-settings") && r.request().method() === "POST");
    await save(page).click();
    expect((await refused).status()).toBe(409);
    await expect(page.locator("#status")).toContainText("The signed review scope is missing");
    await expect(page.locator("#status")).not.toContainText("review_authority_confirmation_required");
    expect(fs.existsSync(alpha.authorityPath)).toBe(false);
    await expect(notice(page)).toContainText("Owner review authority is missing");

    await notice(page).getByRole("button", { name: "Confirm this scope" }).click();
    await expect(notice(page).locator("[data-review-scope-accepted]")).toContainText("Scope confirmed");
    await save(page).click();
    await expect(page.locator("#status")).toContainText("project settings saved");
    await expect.poll(() => fs.existsSync(alpha.authorityPath)).toBe(true);
    expect(alpha.signedScope()).toEqual(["allowedPaths:docs/", "watchAllow:docs/"]);
    await expect(notice(page)).toHaveCount(0);
    expect(alpha.tamperIssue()).toBe(false);
  } finally {
    await hub.close();
  }
});

test("@smoke @settings a scope confirmed on one project is not confirmed on another opened in the same page", async ({ page }) => {
  const hub = await scopeHub(["Alpha", "Bravo"]);
  const { Alpha: alpha, Bravo: bravo } = hub.projects;
  try {
    for (const project of [alpha, bravo]) { project.deleteAuthority(); project.reduceConfig(); }
    await openReviewSettings(page, hub, alpha);
    await expect(notice(page)).toContainText("Owner review authority is missing");
    await notice(page).getByRole("button", { name: "Confirm this scope" }).click();
    await expect(notice(page).locator("[data-review-scope-accepted]")).toBeVisible();

    // Same page, no reload: switch to Bravo through the project list.
    const app = page.locator(".app");
    if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) await page.locator("#explorerOpen:visible, #sidebarToggle:visible").first().click();
    await page.locator('[data-global-explorer-mode="projects"]').click();
    const back = page.locator("[data-global-explorer-back]");
    if (await back.isVisible().catch(() => false)) await back.click();
    await page.locator("a.global-project-row", { has: page.locator(".global-project-row-title strong", { hasText: "Bravo" }) }).first().click();
    await expect(page.locator("#globalExplorerScope strong")).toHaveText("Bravo");
    await waitForQuiet(page);
    if (await page.locator("#settingsPage").isHidden()) await page.locator("#settingsButton").click();
    await expect(page.locator("#settingsPage")).toBeVisible();
    await page.locator('[data-settings-section-target="review-trust"]').click();
    await expect(page.locator("#watchAllow")).toBeVisible();

    await expect(notice(page)).toContainText("Owner review authority is missing");
    await expect(notice(page).locator("[data-review-scope-accepted]")).toHaveCount(0);
    await expect(notice(page).getByRole("button", { name: "Confirm this scope" })).toBeVisible();
    const refusedBravo = page.waitForResponse((r) => r.url().includes("/api/context-hub/project-settings") && r.request().method() === "POST");
    await save(page).click();
    expect((await refusedBravo).status()).toBe(409);
    await expect(page.locator("#status")).toContainText("The signed review scope is missing");
    expect(fs.existsSync(bravo.authorityPath)).toBe(false);
    expect(fs.existsSync(alpha.authorityPath)).toBe(false);
  } finally {
    await hub.close();
  }
});

for (const [variant, width] of [["changed", 800], ["missing", 800], ["changed", 1280], ["missing", 1280]]) {
  test.describe(`${variant} notice at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    async function openVariant(page, hub, alpha) {
      if (variant === "missing") alpha.deleteAuthority();
      alpha.reduceConfig();
      await openReviewSettings(page, hub, alpha);
      await expect(notice(page)).toContainText(variant === "missing" ? "Owner review authority is missing" : "Changed outside Settings");
    }

    test(`@layout the ${variant} notice does not overflow`, async ({ page }) => {
      const hub = await scopeHub();
      try {
        await openVariant(page, hub, hub.projects.Alpha);
        const fit = await notice(page).evaluate((node) => {
          const box = node.getBoundingClientRect();
          const wide = [...node.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > box.right + 1).map((child) => child.tagName);
          return { scroll: node.scrollWidth - node.clientWidth, wide, page: document.documentElement.scrollWidth - window.innerWidth, left: box.left, right: window.innerWidth - box.right };
        });
        expect(fit.scroll).toBeLessThanOrEqual(0);
        expect(fit.wide).toEqual([]);
        expect(fit.page).toBeLessThanOrEqual(0);
        expect(fit.left).toBeGreaterThanOrEqual(0);
        expect(fit.right).toBeGreaterThanOrEqual(0);
      } finally {
        await hub.close();
      }
    });

    // Touch targets: the notice buttons and Save settings are at least 44 px at 800 and 1280 px.
    for (const [label, targets] of [["notice buttons", (page) => notice(page).locator("button")], ["Save settings", (page) => save(page)]]) {
      test(`@layout the ${variant} ${label} are at least 44 px`, async ({ page }) => {
        const hub = await scopeHub();
        try {
          await openVariant(page, hub, hub.projects.Alpha);
          const buttons = await targets(page).all();
          expect(buttons.length).toBeGreaterThan(0);
          for (const button of buttons) {
            const box = await button.boundingBox();
            expect(box, "button is laid out").not.toBeNull();
            expect(box.height, await button.innerText()).toBeGreaterThanOrEqual(43.99); // 44 px minus sub-pixel rounding
            expect(box.width).toBeGreaterThanOrEqual(43.99);
          }
        } finally {
          await hub.close();
        }
      });
    }
  });
}
