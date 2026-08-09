import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

import { createMemoryServer } from "../../src/context_room.mjs";
import { signRemoteIdentity } from "../../src/remote_identity.mjs";
import { attachLayoutFailureArtifacts, collectLayoutViolations } from "./layout-contract.mjs";

const REMOTE_HOST = "context.qm.peerlab.fr";
const PUBLIC_ORIGIN = `https://${REMOTE_HOST}`;
const HUMAN_SECRET = "hosted-ui-profile-human-secret-with-more-than-32-bytes";
const AGENT_SECRET = "hosted-ui-profile-agent-secret-with-more-than-32-bytes";
const HEALTH_SECRET = "hosted-ui-profile-health-secret-with-more-than-32-bytes";
const FORBIDDEN_HOSTED_PATHS = [
  "/api/health",
  "/api/settings",
  "/api/files",
  "/api/file",
  "/api/reports",
  "/api/docqa",
  "/api/codex-prompts",
  "/api/context/",
  "/api/startup-",
  "/api/shared-skills",
  "/api/shared-instructions",
];
const HOSTED_HUB_FORBIDDEN_SELECTORS = [
  ".app > aside",
  "#explorerOpen",
  "#explorerEdgeTrigger",
  "#sidebarToggle",
  "#settingsButton",
  "#graphOpen",
  "#graphLocal",
  "#contextEnginePanel",
  "#contextHealthPanel",
  "#codexPromptCenter",
  "#contextHubCreateProject",
  "#contextHubManageProjects",
  "#sharedSkillsWizard",
  "#codexReferencePopover",
  "[data-global-explorer-mode='computer']",
  "[data-context-room-mode-prompt]",
  "#sharedContextControls",
  "#newDocPage",
  "#settingsPage",
  "#graphPage",
  "#save",
  "#reload",
  "#deleteCurrent",
  "#verifyCurrent",
  "#contextPanelToggle",
];
const HOSTED_REVIEW_FORBIDDEN_SELECTORS = [
  ...HOSTED_HUB_FORBIDDEN_SELECTORS,
  ".app > aside",
  "#explorerOpen",
  "#explorerEdgeTrigger",
  "#sidebarToggle",
  "#home",
  "#sharedProposalWorkspace",
  "#contextHubCreateSharedProject",
  "#contextHubCreateSharedDocument",
  "#back",
  "#forward",
  "#gitDiffToggle",
  "[data-file-save]",
  "[data-file-delete]",
];
const ALL_HOSTED_BOOT_FORBIDDEN_SELECTORS = [...new Set([
  ...HOSTED_HUB_FORBIDDEN_SELECTORS,
  ...HOSTED_REVIEW_FORBIDDEN_SELECTORS,
])];

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room UX fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => {
    const diagnostics = JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}");
    return diagnostics.phase || "";
  }).toBe("ready");
}

function violationReport(violations) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
  }));
}

async function expectNoAccessibilityViolations(page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(violationReport(result.violations)).toEqual([]);
}

function scopedApiPath(pathname) {
  return String(pathname || "").replace(/^\/reviews\/[^/]+(?=\/api(?:\/|$))/, "");
}

function pathIsForbidden(pathname) {
  const apiPath = scopedApiPath(pathname);
  return FORBIDDEN_HOSTED_PATHS.some((prefix) => apiPath === prefix || apiPath.startsWith(prefix));
}

function requestPostData(request) {
  try {
    return request.postDataJSON?.() || null;
  } catch {
    return request.postData() || null;
  }
}

async function expectNoLayoutViolations(page, testInfo, label) {
  const report = await collectLayoutViolations(page, { label });
  if (report.violations.length) await attachLayoutFailureArtifacts(page, testInfo, report);
  expect(report.violations, JSON.stringify(report, null, 2)).toEqual([]);
}

async function expectNoHostedBootExposure(page, selectors) {
  const exposure = await page.evaluate(() => window.__contextRoomHostedBootExposure || null);
  expect(exposure?.ready).toBe(true);
  for (const selector of selectors) {
    expect(Object.hasOwn(exposure?.seen || {}, selector), `${selector} was not sampled during hosted boot`).toBe(true);
    expect(exposure.seen[selector], `${selector} became visible while the hosted profile booted: ${JSON.stringify(exposure.firstSeen?.[selector] || {})}`).toBe(false);
  }
}

async function expectSelectorsHidden(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    for (let index = 0; index < await locator.count(); index += 1) await expect(locator.nth(index), selector).toBeHidden();
  }
}

function expectHostedRequestHygiene(requests, forbiddenMarkers = []) {
  expect(requests.filter((request) => request.origin !== PUBLIC_ORIGIN), "Hosted UI must not contact loopback or third-party origins").toEqual([]);
  expect(requests.filter((request) => request.targetProject), "Hosted UI must not send a local target-project header").toEqual([]);
  expect(requests.filter((request) => request.ownerNonce || request.promptNonce), "Hosted UI must not carry local mutation nonces").toEqual([]);
  const registrations = requests.filter((request) => request.method === "POST" && scopedApiPath(request.pathname) === "/api/workspaces/register");
  expect(registrations.length).toBeGreaterThan(0);
  const allowedPresenceKeys = new Set([
    "workspaceId",
    "clientInstanceId",
    "projectId",
    "scopeProjectId",
    "projectTitle",
    "view",
    "proposal",
    "label",
    "sessionId",
    "visible",
    "focused",
    "title",
  ]);
  for (const registration of registrations) {
    expect(registration.postData && typeof registration.postData === "object").toBe(true);
    expect(Object.keys(registration.postData).filter((key) => !allowedPresenceKeys.has(key)), JSON.stringify(registration.postData)).toEqual([]);
    const serialized = JSON.stringify(registration.postData);
    for (const marker of forbiddenMarkers.filter(Boolean)) expect(serialized).not.toContain(marker);
  }
}

function expectHostedWorkspaceRegistrationFirst(requests) {
  const registerIndex = requests.findIndex((request) => request.method === "POST" && scopedApiPath(request.pathname) === "/api/workspaces/register");
  expect(registerIndex, "Hosted cold boot must register its Workspace").toBeGreaterThanOrEqual(0);
  for (const [index, request] of requests.entries()) {
    const apiPath = scopedApiPath(request.pathname);
    const startsWorkspaceRuntime = apiPath === "/api/runtime-events" || /^\/api\/workspaces\/[^/]+\/command$/.test(apiPath);
    if (startsWorkspaceRuntime) expect(index, `${apiPath} started before Workspace registration`).toBeGreaterThan(registerIndex);
  }
}

async function expectNoHostedStateLeaks(page, forbiddenMarkers = []) {
  const snapshot = await page.evaluate(() => {
    const sensitiveKeys = [];
    const walk = (value, trail = "state") => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${trail}[${index}]`));
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        const next = `${trail}.${key}`;
        if (["repository", "root", "worktree", "worktreeRoot", "worktrees"].includes(key) && entry) sensitiveKeys.push(next);
        walk(entry, next);
      }
    };
    const publicState = { contextHub: state.contextHub, sharedContext: state.sharedContext };
    walk(publicState);
    return {
      sensitiveKeys,
      serialized: JSON.stringify(publicState),
      text: document.body.innerText,
    };
  });
  expect(snapshot.sensitiveKeys).toEqual([]);
  for (const marker of forbiddenMarkers.filter(Boolean)) {
    expect(snapshot.serialized).not.toContain(marker);
    expect(snapshot.text).not.toContain(marker);
  }
}

async function emulateDesktopBrowserZoom(page, factor) {
  const baseline = await page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    layoutViewportWidth: window.innerWidth,
    layoutViewportHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
  }));
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: Math.ceil(baseline.layoutViewportWidth / factor),
    height: Math.ceil(baseline.layoutViewportHeight / factor),
    deviceScaleFactor: baseline.devicePixelRatio * factor,
    mobile: false,
    screenWidth: baseline.screenWidth,
    screenHeight: baseline.screenHeight,
  });
  return {
    async restore() {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: baseline.layoutViewportWidth,
        height: baseline.layoutViewportHeight,
        deviceScaleFactor: baseline.devicePixelRatio,
        mobile: false,
        screenWidth: baseline.screenWidth,
        screenHeight: baseline.screenHeight,
      });
      await session.detach();
    },
  };
}

test.describe("hosted runtime profiles", () => {
  let room;
  let origin;
  let repositoryId;
  let reviewPath;
  let reviewHead;
  let reviewFiles = [];
  let forbiddenHostMarkers = [];
  let tokenSequence = 0;

  const identityHeaders = () => ({
    "x-forwarded-host": REMOTE_HOST,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "hosted-ui-owner",
      role: "admin",
      operations: ["view", "review", "accept", "reject"],
    }, HUMAN_SECRET, { jti: `hosted-ui-profile-${process.pid}-${++tokenSequence}` }),
  });

  const remoteJson = async (pathname, options = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...identityHeaders(),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBeGreaterThanOrEqual(200);
    expect(response.status, JSON.stringify(payload)).toBeLessThan(300);
    return payload;
  };

  test.beforeAll(async () => {
    const data = fixture();
    forbiddenHostMarkers = [data.projects.atlas.root, data.shared.remote, process.env.HOME].filter(Boolean);
    room = createMemoryServer({
      root: data.projects.atlas.root,
      remoteAccess: {
        expectedHost: REMOTE_HOST,
        humanSecret: HUMAN_SECRET,
        agentSecret: AGENT_SECRET,
        healthSecret: HEALTH_SECRET,
        adminSubjects: ["hosted-ui-owner"],
        projectRoots: { atlas: data.projects.atlas.root },
        sharedRepositories: [{ repository: data.shared.remote, projectIds: ["atlas"], scopes: ["projects"] }],
      },
    });
    await new Promise((resolve, reject) => {
      room.server.once("error", reject);
      room.server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${room.server.address().port}`;
    const catalog = await remoteJson("/api/context-hub/refresh", {
      method: "POST",
      body: "{}",
    });
    repositoryId = catalog.sharedRepositories?.[0]?.repositoryId || catalog.sharedRepositories?.[0]?.id || "";
    expect(repositoryId).not.toBe("");
    const target = (catalog.proposals || []).find((proposal) => proposal.branch === data.shared.proposal);
    expect(target?.head).toBe(data.shared.proposalHead);
    const opened = await remoteJson("/api/context-hub/review", {
      method: "POST",
      body: JSON.stringify({ repositoryId, proposal: target.id || target.branch, expectedHead: target.head }),
    });
    reviewPath = new URL(opened.url, origin).pathname;
    reviewHead = opened.review?.proposalHead || data.shared.proposalHead;
    reviewFiles = opened.files || [];
    expect(reviewPath).toMatch(/^\/reviews\/[a-f0-9-]{36}\/$/i);
    expect(reviewHead).toMatch(/^[a-f0-9]{40}$/);
    expect(reviewFiles.length).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    if (!room?.server.listening) return;
    await new Promise((resolve) => {
      room.server.close(resolve);
      room.server.closeAllConnections?.();
    });
  });

  test.beforeEach(async ({ page }) => {
    await page.route(`${PUBLIC_ORIGIN}/**`, async (route) => {
      const publicUrl = new URL(route.request().url());
      if (publicUrl.pathname.endsWith("/api/runtime-events")) {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 60000\nevent: ready\ndata: {}\n\n" });
        return;
      }
      const request = route.request();
      const headers = new Headers(request.headers());
      headers.delete("host");
      headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      headers.set("x-forwarded-proto", "https");
      for (const [name, value] of Object.entries(identityHeaders())) headers.set(name, value);
      const method = request.method();
      const response = await fetch(`${origin}${publicUrl.pathname}${publicUrl.search}`, {
        method,
        headers,
        redirect: "manual",
        ...(["GET", "HEAD"].includes(method) ? {} : { body: request.postDataBuffer() || undefined }),
      });
      const responseHeaders = Object.fromEntries(response.headers.entries());
      delete responseHeaders["content-length"];
      delete responseHeaders["transfer-encoding"];
      if (responseHeaders.location?.startsWith(origin)) responseHeaders.location = PUBLIC_ORIGIN + responseHeaders.location.slice(origin.length);
      await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.addInitScript((selectors) => {
      const exposure = {
        ready: false,
        seen: Object.fromEntries(selectors.map((selector) => [selector, false])),
        firstSeen: {},
      };
      window.__contextRoomHostedBootExposure = exposure;
      const scan = () => {
        for (const selector of selectors) {
          const visible = [...document.querySelectorAll(selector)].some((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
          if (visible) {
            exposure.seen[selector] = true;
            if (!exposure.firstSeen[selector]) {
              const node = [...document.querySelectorAll(selector)].find((candidate) => candidate.getClientRects().length && getComputedStyle(candidate).visibility !== "hidden");
              exposure.firstSeen[selector] = {
                readyState: document.readyState,
                profile: document.documentElement.dataset.contextRoomRuntimeProfile || "",
                display: node ? getComputedStyle(node).display : "",
              };
            }
          }
        }
      };
      // Mutation callbacks run before style/layout has settled and can report parser-only
      // states that were never painted. Keep observing DOM churn, but sample exposure at
      // animation-frame boundaries so this assertion represents what a user could see.
      const observer = new MutationObserver(() => {});
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
      const sampleFrame = () => {
        scan();
        if (document.body && !document.body.classList.contains("app-booting")) {
          requestAnimationFrame(() => {
            scan();
            exposure.ready = true;
            observer.disconnect();
          });
          return;
        }
        requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    }, ALL_HOSTED_BOOT_FORBIDDEN_SELECTORS);
  });

  test("@smoke hosted runtime waits for a successful Workspace registration before becoming ready", async ({ page }) => {
    const runtimeRequests = [];
    let registrationCalls = 0;
    let markFirstRegistration;
    let releaseFirstRegistration;
    const firstRegistrationStarted = new Promise((resolve) => { markFirstRegistration = resolve; });
    const firstRegistrationGate = new Promise((resolve) => { releaseFirstRegistration = resolve; });
    page.on("request", (request) => {
      const pathname = scopedApiPath(new URL(request.url()).pathname);
      if (pathname === "/api/runtime-events" || /^\/api\/workspaces\/[^/]+\/command$/.test(pathname)) runtimeRequests.push(pathname);
    });
    await page.route(`${PUBLIC_ORIGIN}/api/workspaces/register`, async (route) => {
      registrationCalls += 1;
      if (registrationCalls === 1) {
        markFirstRegistration();
        await firstRegistrationGate;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Workspace registration temporarily unavailable." }),
        });
        return;
      }
      await route.fallback();
    });

    const navigation = page.goto(`${PUBLIC_ORIGIN}/?hub=1&workspace=hosted-register-gate&view=hub`);
    await firstRegistrationStarted;
    await navigation;
    try {
      await expect.poll(() => page.evaluate(() => state.contextHubReviewQueueReady)).toBe(true);
      await expect(page.locator("body")).toHaveClass(/app-booting/);
      await expect(page.locator("#status")).not.toContainText(/ready/i);
      expect(runtimeRequests).toEqual([]);
    } finally {
      releaseFirstRegistration();
    }

    await expect(page.locator("body")).toHaveClass(/app-recovery/);
    await expect(page.locator("#status")).not.toContainText(/ready/i);
    expect(runtimeRequests).toEqual([]);
    await page.getByRole("button", { name: "Retry once", exact: true }).click();
    await waitForBoot(page);
    await expect(page.locator("#reviewQueueHeading")).toBeVisible();
    await expect.poll(() => runtimeRequests.includes("/api/runtime-events")).toBe(true);
    expect(registrationCalls).toBeGreaterThanOrEqual(2);
  });

  test("@smoke hosted boot recovers when a persisted-page restore interrupts initial registration", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      let holdFirstRegistration = true;
      window.__e2eInitialRegisterStarted = false;
      window.fetch = (input, options = {}) => {
        const href = typeof input === "string" ? input : input?.url || "";
        if (holdFirstRegistration && new URL(href, location.href).pathname === "/api/workspaces/register") {
          holdFirstRegistration = false;
          window.__e2eInitialRegisterStarted = true;
          return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
            if (options.signal?.aborted) {
              abort();
              return;
            }
            options.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return nativeFetch(input, options);
      };
    });

    const workspace = `hosted-initial-restore-${testInfo.project.name}`;
    await page.goto(`${PUBLIC_ORIGIN}/?hub=1&workspace=${workspace}&view=hub`);
    await expect.poll(() => page.evaluate(() => window.__e2eInitialRegisterStarted)).toBe(true);
    await expect(page.locator("body")).toHaveClass(/app-booting/);
    await page.evaluate(() => {
      let event;
      try { event = new PageTransitionEvent("pagehide", { persisted: true }); }
      catch {
        event = new Event("pagehide");
        Object.defineProperty(event, "persisted", { value: true });
      }
      window.dispatchEvent(event);
    });
    await expect.poll(() => page.evaluate(() => ({
      outcome: state.workspaceLastUnloadOutcome,
      pending: state.workspaceInitialRegistrationPending,
      registrationSettled: state.workspaceRegistrationPromise === null,
      stopped: state.workspaceRuntimeStopped,
      suspended: state.workspaceRuntimeSuspended,
    }))).toEqual({ outcome: "suspended", pending: true, registrationSettled: true, stopped: true, suspended: true });
    await page.evaluate(() => {
      let event;
      try { event = new PageTransitionEvent("pageshow", { persisted: true }); }
      catch {
        event = new Event("pageshow");
        Object.defineProperty(event, "persisted", { value: true });
      }
      window.dispatchEvent(event);
    });

    await waitForBoot(page);
    await expect(page.locator("body")).not.toHaveClass(/app-recovery/);
    await expect.poll(() => page.evaluate(() => ({
      pending: state.workspaceInitialRegistrationPending,
      stopped: state.workspaceRuntimeStopped,
      runtimeEvents: Boolean(state.runtimeEventSource),
      workspaceChannel: Boolean(state.workspaceChannel),
    }))).toEqual({ pending: false, stopped: false, runtimeEvents: true, workspaceChannel: true });
  });

  test("@smoke hosted-hub keeps a failed boot visible and recovers on retry", async ({ page }) => {
    let catalogCalls = 0;
    await page.route(`${PUBLIC_ORIGIN}/api/context-hub/catalog`, async (route) => {
      catalogCalls += 1;
      if (catalogCalls === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Hosted catalogue temporarily unavailable." }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(`${PUBLIC_ORIGIN}/?hub=1&view=hub`);
    await expect(page.locator("body")).toHaveClass(/app-recovery/);
    const recovery = page.locator("#bootScreenContent.boot-recovery");
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText("Context Room could not start safely");
    await expect(recovery).toContainText("hosted Shared catalogue is unavailable");
    await recovery.getByRole("button", { name: "Retry once", exact: true }).click();

    await waitForBoot(page);
    await expect(page.locator("#reviewQueueHeading")).toBeVisible();
    expect(catalogCalls).toBe(2);
  });

  test("@smoke hosted-review keeps a failed boot visible and recovers on retry", async ({ page }) => {
    let reviewCalls = 0;
    await page.route(`${PUBLIC_ORIGIN}${reviewPath}api/shared-context`, async (route) => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Hosted review temporarily unavailable." }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(`${PUBLIC_ORIGIN}${reviewPath}`);
    await expect(page.locator("body")).toHaveClass(/app-recovery/);
    const recovery = page.locator("#bootScreenContent.boot-recovery");
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText("Context Room could not start safely");
    await expect(recovery).toContainText("Hosted review temporarily unavailable");
    await recovery.getByRole("button", { name: "Retry once", exact: true }).click();

    await waitForBoot(page);
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    expect(reviewCalls).toBeGreaterThanOrEqual(2);
  });

  test("@smoke hosted-review file loading shows a persistent error and retries the exact file", async ({ page }) => {
    await page.goto(`${PUBLIC_ORIGIN}${reviewPath}`);
    await waitForBoot(page);
    await expect(page.locator("#proposalReviewPage")).toBeVisible();

    const firstPath = reviewFiles[0].path;
    let exactFileAttempts = 0;
    await page.route((url) => (
      scopedApiPath(url.pathname) === "/api/shared-context"
      && url.searchParams.get("file") === firstPath
    ), async (route) => {
      exactFileAttempts += 1;
      if (exactFileAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Exact review file temporarily unavailable." }),
        });
        return;
      }
      await route.fallback();
    });

    await page.locator("[data-proposal-review-path]").filter({ hasText: firstPath }).first().click();
    const fileError = page.locator(".file-load-state.error[role='alert']");
    await expect(fileError).toBeVisible();
    await expect(fileError).toContainText("Exact review file temporarily unavailable");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept file", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject file", exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => ({
      opening: state.openingFilePath,
      errorKind: state.fileLoadError?.kind || "",
    }))).toEqual({ opening: null, errorKind: "hosted-review" });

    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("[data-hosted-review-file]")).toBeVisible();
    await expect(fileError).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Accept file", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject file", exact: true })).toBeVisible();
    expect(exactFileAttempts).toBe(2);
  });

  test("@smoke @a11y @layout hosted-hub is Shared-only from the first frame", async ({ page }, testInfo) => {
    const requests = [];
    page.on("request", (request) => {
      if (/^https?:/i.test(request.url())) {
        const requestUrl = new URL(request.url());
        requests.push({
        method: request.method(),
        origin: requestUrl.origin,
        pathname: requestUrl.pathname,
        search: requestUrl.search,
        postData: requestPostData(request),
        ownerNonce: request.headers()["x-context-room-owner-nonce"] || "",
        promptNonce: request.headers()["x-context-room-prompt-nonce"] || "",
        targetProject: request.headers()["x-context-room-target-project"] || "",
        });
      }
    });

    await page.goto(`${PUBLIC_ORIGIN}/?hub=0&view=settings&file=${encodeURIComponent(".codex/config.toml")}`);
    await waitForBoot(page);
    await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "hosted-hub");
    await expect(page.locator("body")).toHaveClass(/global-context-room/);
    await expect(page.locator("#reviewQueueHeading")).toBeVisible();
    await expect(page.locator("#contextRoomReviewSourceFilter")).toHaveValue("shared");
    await expect(page.locator("#contextRoomReviewSourceFilter option")).toHaveCount(1);
    await expect(page.locator("#contextRoomReviewSourceFilter option")).toHaveValue("shared");
    await expect(page.locator("#contextHubSourceFilter option")).toHaveCount(1);
    await expect(page.locator("#contextHubSourceFilter")).toHaveValue("shared");

    await expectSelectorsHidden(page, HOSTED_HUB_FORBIDDEN_SELECTORS);
    await expectNoHostedBootExposure(page, HOSTED_HUB_FORBIDDEN_SELECTORS);

    const hostedState = await page.evaluate(() => ({
      global: IS_GLOBAL_CONTEXT_ROOM,
      local: IS_LOCAL,
      hostedHub: IS_HOSTED_HUB,
      page: state.page,
      projects: (state.contextHub?.projects || []).map((project) => ({ mode: project.mode, root: project.root, worktrees: project.worktrees })),
      items: (state.contextHub?.items || []).map((item) => item.type),
    }));
    expect(hostedState).toMatchObject({ global: true, local: false, hostedHub: true, page: "hub" });
    expect(hostedState.projects.every((project) => project.mode === "shared" && !project.root && !project.worktrees)).toBe(true);
    expect(hostedState.items.every((type) => type === "shared")).toBe(true);
    const initialCanonical = new URL(page.url());
    expect(initialCanonical.searchParams.get("view")).toBe("hub");
    expect(initialCanonical.searchParams.has("file")).toBe(false);

    const hubRefreshPaths = ["/api/context-hub/catalog", "/api/context-hub/review-queue", "/api/context-hub/sections"];
    const hubRefreshCount = (pathname) => requests.filter((request) => scopedApiPath(request.pathname) === pathname).length;
    const hubRefreshCountsBeforeForeground = Object.fromEntries(hubRefreshPaths.map((pathname) => [pathname, hubRefreshCount(pathname)]));
    await page.evaluate(() => {
      for (let index = 0; index < 12; index += 1) {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        void handleWorkspaceMessage({
          type: "workspace-update",
          workspaceId: `foreground-peer-${index}`,
          event: "catalog-refreshed",
        });
      }
    });
    await expect.poll(() => page.evaluate(() => (
      !state.runtimeContextHubRefreshPromise
      && !state.runtimeContextHubRefreshTimer
      && !state.runtimeContextHubRefreshPending
      && !state.runtimeContextHubRefreshGeneration
    ))).toBe(true);
    await page.waitForTimeout(500);
    for (const pathname of hubRefreshPaths) {
      expect(hubRefreshCount(pathname) - hubRefreshCountsBeforeForeground[pathname]).toBeLessThanOrEqual(1);
    }

    await page.locator("#contextRoomReviewProjectFilter").click();
    const projectPicker = page.locator("#contextHubProjectPicker");
    await expect(projectPicker).toBeVisible();
    await projectPicker.locator("#contextHubProjectPickerSearch").fill("Atlas");
    await projectPicker.getByRole("option", { name: /Atlas/ }).click();

    const createSharedDocument = page.locator("#contextHubCreateSharedDocument");
    await expect(createSharedDocument).toBeVisible();
    const hostedHubVisualContract = await page.evaluate(() => {
      const button = document.querySelector("#contextHubCreateSharedDocument");
      const summary = document.querySelector("#reviewSummary");
      const meta = document.querySelector(".context-room-proposal-meta");
      const description = document.querySelector(".context-room-proposal-description");
      const path = document.querySelector(".context-room-proposal-file");
      const panel = document.querySelector("#reviewQueuePanel");
      const buttonStyle = getComputedStyle(button);
      const buttonBefore = getComputedStyle(button, "::before");
      const panelStyle = getComputedStyle(panel);
      const buttonRect = button.getBoundingClientRect();
      const summaryRect = summary.getBoundingClientRect();
      return {
        buttonBorderStyle: buttonStyle.borderTopStyle,
        buttonBorderWidth: Number.parseFloat(buttonStyle.borderTopWidth),
        buttonBefore: buttonBefore.content,
        rowCenterDelta: Math.abs((buttonRect.top + buttonRect.height / 2) - (summaryRect.top + summaryRect.height / 2)),
        metaSize: Number.parseFloat(getComputedStyle(meta).fontSize),
        descriptionSize: Number.parseFloat(getComputedStyle(description).fontSize),
        pathSize: Number.parseFloat(getComputedStyle(path).fontSize),
        panelRadius: Number.parseFloat(panelStyle.borderTopLeftRadius),
        panelShadow: panelStyle.boxShadow,
      };
    });
    expect(hostedHubVisualContract.buttonBorderStyle).not.toBe("none");
    expect(hostedHubVisualContract.buttonBorderWidth).toBeGreaterThanOrEqual(1);
    expect(hostedHubVisualContract.buttonBefore).toContain("+");
    expect(hostedHubVisualContract.metaSize).toBeGreaterThanOrEqual(11);
    expect(hostedHubVisualContract.descriptionSize).toBeGreaterThanOrEqual(13);
    expect(hostedHubVisualContract.pathSize).toBeGreaterThanOrEqual(11);
    if (testInfo.project.name === "chromium-mobile") {
      expect(hostedHubVisualContract.rowCenterDelta).toBeLessThanOrEqual(1);
      expect(hostedHubVisualContract.panelRadius).toBe(0);
    } else {
      expect(hostedHubVisualContract.panelRadius).toBeGreaterThanOrEqual(14);
      expect(hostedHubVisualContract.panelShadow).not.toBe("none");
    }
    await createSharedDocument.click();
    const createDialog = page.getByRole("dialog", { name: "Create a shared document" });
    await expect(createDialog).toBeVisible();
    const documentPath = `qa/hosted-${testInfo.project.name}.md`;
    await createDialog.locator('[name="title"]').fill(`Hosted QA ${testInfo.project.name}`);
    await createDialog.locator('[name="path"]').fill(documentPath);
    await createDialog.locator('[name="description"]').fill("Verify that the hosted Hub creates a Shared proposal without receiving a local repository path.");
    await createDialog.getByRole("button", { name: "Create proposal", exact: true }).click();
    await expect(createDialog).toBeHidden();
    await expect.poll(() => requests.filter((request) => (
      request.method === "POST" && scopedApiPath(request.pathname) === "/api/context-hub/shared-documents"
    )).at(-1)?.postData).toEqual({
      repositoryId,
      projectId: "atlas",
      title: `Hosted QA ${testInfo.project.name}`,
      path: documentPath,
      description: "Verify that the hosted Hub creates a Shared proposal without receiving a local repository path.",
    });

    const createSharedProject = page.locator("#contextHubCreateSharedProject");
    await expect(createSharedProject).toBeVisible();
    await createSharedProject.click();
    const projectDialog = page.getByRole("dialog", { name: "Create a shared project" });
    await expect(projectDialog).toBeVisible();
    await expect(projectDialog.locator('[name="repository"]')).toHaveValue(repositoryId);
    const projectId = `hosted-${testInfo.project.name}`;
    await projectDialog.locator('[name="projectId"]').fill(projectId);
    await projectDialog.locator('[name="title"]').fill(`Hosted ${testInfo.project.name}`);
    await projectDialog.locator('[name="path"]').fill("overview.md");
    await projectDialog.locator('[name="description"]').fill("Verify that Hosted can propose a new Shared project while exposing no local files, roots, or Codex prompt settings.");
    await projectDialog.getByRole("button", { name: "Create proposal", exact: true }).click();
    await expect(projectDialog).toBeHidden();
    await expect.poll(() => requests.filter((request) => (
      request.method === "POST" && scopedApiPath(request.pathname) === "/api/context-hub/shared-projects"
    )).at(-1)?.postData).toEqual({
      repositoryId,
      projectId,
      title: `Hosted ${testInfo.project.name}`,
      path: "overview.md",
      description: "Verify that Hosted can propose a new Shared project while exposing no local files, roots, or Codex prompt settings.",
    });
    await expect.poll(() => page.evaluate((expectedProjectId) => {
      const proposal = (state.contextHub?.proposals || []).find((item) => item.createsProject === true && item.projectId === expectedProjectId);
      return proposal ? {
        projectId: proposal.projectId,
        projectPath: proposal.projectPath,
        files: [...(proposal.files || [])].sort(),
      } : null;
    }, projectId)).toEqual({
      projectId,
      projectPath: `projects/${projectId}`,
      files: [
        "projects.json",
        `projects/${projectId}/docs/overview.md`,
      ],
    });
    await expect(createSharedDocument).toBeHidden();

    await page.locator("#contextRoomReviewSourceFilter").evaluate((select) => {
      select.value = "local";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator("#contextRoomReviewSourceFilter")).toHaveValue("shared");

    await page.evaluate(() => {
      history.pushState({}, "", "/?hub=1&view=codex-prompts&file=.codex%2Fconfig.toml&folder=..%2F..%2F");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(() => page.evaluate(() => state.page)).toBe("hub");
    await page.evaluate(async () => {
      await executeAgentCommand({ id: "hosted-forged-settings", view: "settings", path: ".codex/config.toml" }).catch(() => {});
    });
    await expect.poll(() => page.evaluate(() => state.page)).toBe("hub");
    const requestsBeforeDirectGuards = requests.length;
    const directGuards = await page.evaluate(async () => {
      const apiErrors = [];
      for (const path of ["/api/settings", "/api/file?path=.codex%2Fconfig.toml", "/api/codex-prompts"]) {
        try { await api(path); apiErrors.push(""); }
        catch (error) { apiErrors.push(error?.code || error?.message || "error"); }
      }
      showSettingsPage();
      showNewDocPage();
      await showGraphPage().catch(() => {});
      await selectFile(".codex/config.toml").catch(() => {});
      openContextRoomView("codex-prompts");
      document.querySelector("#settingsButton")?.click();
      return {
        apiErrors,
        page: state.page,
        selected: state.selected || "",
        filters: [...(state.pathFilters || [])],
        contextHubView: state.contextHubView,
      };
    });
    expect(directGuards.apiErrors).toEqual([
      "hosted_client_operation_unavailable",
      "hosted_client_operation_unavailable",
      "hosted_client_operation_unavailable",
    ]);
    expect(directGuards).toMatchObject({ page: "hub", selected: "", filters: [], contextHubView: "home" });
    expect(requests.slice(requestsBeforeDirectGuards).filter((request) => pathIsForbidden(request.pathname))).toEqual([]);
    const forgedCanonical = new URL(page.url());
    for (const key of ["view", "file", "folder", "settings", "proposal"]) {
      if (key === "view") expect(forgedCanonical.searchParams.get(key)).toBe("hub");
      else expect(forgedCanonical.searchParams.has(key)).toBe(false);
    }

    expect(requests.filter((request) => pathIsForbidden(request.pathname))).toEqual([]);
    expectHostedWorkspaceRegistrationFirst(requests);
    expectHostedRequestHygiene(requests, forbiddenHostMarkers);
    await expectNoHostedStateLeaks(page, forbiddenHostMarkers);
    await expectNoLayoutViolations(page, testInfo, `hosted-hub-${testInfo.project.name}`);
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath(`hosted-hub-${testInfo.project.name}.png`), fullPage: true });
  });

  test("@smoke @a11y @layout hosted-review is an exact whole-file read-only decision surface", async ({ page }, testInfo) => {
    const requests = [];
    page.on("request", (request) => {
      if (/^https?:/i.test(request.url())) {
        const requestUrl = new URL(request.url());
        requests.push({
          method: request.method(),
          origin: requestUrl.origin,
          pathname: requestUrl.pathname,
          search: requestUrl.search,
          postData: requestPostData(request),
          ownerNonce: request.headers()["x-context-room-owner-nonce"] || "",
          promptNonce: request.headers()["x-context-room-prompt-nonce"] || "",
          targetProject: request.headers()["x-context-room-target-project"] || "",
        });
      }
    });

    const staleWorkspaceId = "stale-project-a-workspace";
    await page.addInitScript(({ workspaceId }) => {
      const staleNavigation = {
        version: 6,
        workspaceId,
        root: "hosted-review",
        projectId: "project-a",
        page: "file",
        selectedPath: ".codex/config.toml",
        activeProjectLocationId: "project-a-local-worktree",
        pathFilters: ["../project-a"],
      };
      sessionStorage.setItem("context-room:workspace-id", workspaceId);
      sessionStorage.setItem(`context-room:workspace-navigation:${workspaceId}:hosted-review`, JSON.stringify(staleNavigation));
      localStorage.setItem("context-room:navigation:hosted-review", JSON.stringify(staleNavigation));
    }, { workspaceId: staleWorkspaceId });

    const forgedReturn = encodeURIComponent(`${origin}/?hub=1&view=settings`);
    await page.goto(`${PUBLIC_ORIGIN}${reviewPath}?hub=1&workspace=${staleWorkspaceId}&project=project-a&view=settings&file=${encodeURIComponent(".codex/config.toml")}&returnTo=${forgedReturn}`);
    await waitForBoot(page);
    await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "hosted-review");
    await expect(page.locator("body")).not.toHaveClass(/global-context-room/);
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    await expect(page.locator(".app > aside")).toBeHidden();
    expect(await page.evaluate(() => contextRoomReturnUrl())).toBe("");
    const directHome = new URL(await page.evaluate(() => contextRoomHomeUrl()));
    expect(directHome.origin).toBe(PUBLIC_ORIGIN);
    expect(directHome.pathname).toBe("/");
    expect(directHome.searchParams.get("hub")).toBe("1");
    expect(directHome.searchParams.get("view")).toBe("hub");
    await expect(page.locator("#brandHome")).toBeVisible();
    await expect(page.locator("#brandHome")).toHaveAttribute("aria-label", "Back to main Context Room");
    const validReturn = `${PUBLIC_ORIGIN}/?hub=1&view=hub`;
    await page.evaluate((returnTo) => {
      const target = new URL(location.href);
      target.searchParams.set("returnTo", returnTo);
      history.replaceState(history.state, "", target);
      updateActionBanner();
    }, validReturn);
    await expect(page.locator("#brandHome")).toBeVisible();
    await expect(page.locator("#brandHome")).toHaveAttribute("aria-label", "Back to main Context Room");
    await page.evaluate(() => {
      const target = new URL(location.href);
      target.searchParams.delete("returnTo");
      history.replaceState(history.state, "", target);
      updateActionBanner();
    });
    await expect(page.locator("#brandHome")).toBeVisible();
    expect(new URL(await page.evaluate(() => contextRoomHomeUrl())).origin).toBe(PUBLIC_ORIGIN);
    const initialReviewCanonical = new URL(page.url());
    expect(initialReviewCanonical.pathname).toBe(reviewPath);
    expect(initialReviewCanonical.searchParams.get("view")).toBe("proposal");
    for (const key of ["hub", "project", "file", "folder", "settings", "proposal"]) expect(initialReviewCanonical.searchParams.has(key)).toBe(false);

    const reviewLoadsBeforeForeground = requests.filter((request) => scopedApiPath(request.pathname) === "/api/shared-context").length;
    await page.evaluate(() => {
      for (let index = 0; index < 12; index += 1) {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      }
    });
    await expect.poll(() => page.evaluate(() => (
      !state.hostedReviewRefreshPromise
      && !state.hostedReviewRefreshTimer
      && !state.hostedReviewRefreshPending
    ))).toBe(true);
    await page.waitForTimeout(500);
    const reviewLoadsAfterForeground = requests.filter((request) => scopedApiPath(request.pathname) === "/api/shared-context").length;
    expect(reviewLoadsAfterForeground - reviewLoadsBeforeForeground).toBeLessThanOrEqual(1);

    const returnMatrix = await page.evaluate(({ publicOrigin, reviewPathname }) => {
      const original = location.href;
      const cases = {
        sameOriginHttps: `${publicOrigin}/?view=home`,
        sameHostHttp: `http://${location.host}/?view=home`,
        loopbackHttps: "https://127.0.0.1/?view=home",
        siblingHttps: "https://qm.peerlab.fr/?view=home",
        hostileHttps: "https://example.invalid/?view=home",
        credentials: `https://user:password@${location.host}/?view=home`,
      };
      const results = {};
      for (const [name, target] of Object.entries(cases)) {
        const current = new URL(original);
        current.searchParams.set("returnTo", target);
        history.replaceState(history.state, "", current);
        results[name] = contextRoomReturnUrl();
      }
      history.replaceState(history.state, "", original);
      return results;
    }, { publicOrigin: PUBLIC_ORIGIN, reviewPathname: reviewPath });
    expect(returnMatrix.sameOriginHttps).toMatch(/^https:\/\/context\.qm\.peerlab\.fr\//);
    expect({ ...returnMatrix, sameOriginHttps: "" }).toEqual({
      sameOriginHttps: "",
      sameHostHttp: "",
      loopbackHttps: "",
      siblingHttps: "",
      hostileHttps: "",
      credentials: "",
    });

    await expectSelectorsHidden(page, HOSTED_REVIEW_FORBIDDEN_SELECTORS);
    await expectNoHostedBootExposure(page, HOSTED_REVIEW_FORBIDDEN_SELECTORS);
    await expect(page.locator("textarea:visible")).toHaveCount(0);
    await expect(page.locator("[data-external-block-decision]")).toHaveCount(0);
    await expect(page.locator("[data-external-review-all]")).toHaveCount(0);
    await expect(page.locator(".external-review-block-controls")).toHaveCount(0);

    const requestsBeforePathGuards = requests.length;
    const pathGuardState = await page.evaluate(async (paths) => {
      const outcomes = [];
      for (const path of paths) {
        try { await selectFile(path); outcomes.push("resolved"); }
        catch (error) { outcomes.push(error?.code || error?.message || "rejected"); }
      }
      showSettingsPage();
      showNewDocPage();
      await showGraphPage().catch(() => {});
      openContextRoomView("codex-prompts");
      document.querySelector("#settingsButton")?.click();
      return {
        outcomes,
        page: state.page,
        selected: state.selected || "",
        manifest: (state.sharedContext?.files || []).map((file) => file.path),
      };
    }, ["/etc/passwd", "..\\project-a\\SECRET.md", "../project-a/SECRET.md", ".codex/config.toml", "projects/atlas/docs/UNKNOWN.md", "projects/atlas/docs/NUL\0.md"]);
    expect(pathGuardState.page).toBe("proposal");
    expect(pathGuardState.selected).toBe("");
    expect(requests.slice(requestsBeforePathGuards).filter((request) => (
      request.method === "GET"
      && scopedApiPath(request.pathname) === "/api/shared-context"
      && new URLSearchParams(request.search || "").has("file")
    ))).toEqual([]);

    await page.evaluate(() => {
      const forged = new URL(location.href);
      forged.searchParams.set("hub", "1");
      forged.searchParams.set("project", "project-a");
      forged.searchParams.set("view", "file");
      forged.searchParams.set("file", "../project-a/SECRET.md");
      history.pushState({}, "", forged);
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("proposal");
    const scrubbedReviewUrl = new URL(page.url());
    for (const key of ["hub", "project", "file", "folder", "settings", "proposal"]) expect(scrubbedReviewUrl.searchParams.has(key)).toBe(false);

    const requestsBeforeAgentCommand = requests.length;
    const agentCommandResult = await page.evaluate(async () => {
      try {
        await executeAgentCommand({
          id: "stale-project-a-command",
          projectId: "project-a",
          view: "file",
          path: ".codex/config.toml",
          proposal: "proposal/project-a-stale",
          filters: ["../project-a"],
        });
        return { rejected: false, message: "" };
      } catch (error) {
        return { rejected: true, message: String(error?.message || error || "") };
      }
    });
    expect(typeof agentCommandResult.rejected).toBe("boolean");
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    const postCommandState = await page.evaluate(() => ({
      pathname: location.pathname,
      search: location.search,
      page: state.page,
      selected: state.selected || "",
      manifest: (state.sharedContext?.files || []).map((file) => file.path),
    }));
    expect(postCommandState.pathname).toBe(reviewPath);
    expect(postCommandState.search).not.toContain("hub=");
    expect(postCommandState.search).not.toContain("project=project-a");
    expect(postCommandState.page).toBe("proposal");
    expect(postCommandState.selected === "" || postCommandState.manifest.includes(postCommandState.selected)).toBe(true);
    expect(requests.slice(requestsBeforeAgentCommand).filter((request) => scopedApiPath(request.pathname).startsWith("/api/context-hub") || pathIsForbidden(request.pathname))).toEqual([]);

    const firstPath = reviewFiles[0].path;
    const proposalTypography = await page.evaluate(() => {
      const technical = document.querySelector(".proposal-review-technical summary");
      const meta = document.querySelector(".proposal-review-meta");
      const filePath = document.querySelector(".proposal-review-file-copy code");
      const fileState = document.querySelector(".proposal-review-file-state");
      const technicalRect = technical.getBoundingClientRect();
      return {
        technicalHeight: technicalRect.height,
        technicalSize: Number.parseFloat(getComputedStyle(technical).fontSize),
        technicalMarker: getComputedStyle(technical, "::before").content,
        metaSize: Number.parseFloat(getComputedStyle(meta).fontSize),
        filePathSize: Number.parseFloat(getComputedStyle(filePath).fontSize),
        fileStateSize: Number.parseFloat(getComputedStyle(fileState).fontSize),
      };
    });
    expect(proposalTypography.technicalSize).toBeGreaterThanOrEqual(11);
    expect(proposalTypography.metaSize).toBeGreaterThanOrEqual(11);
    expect(proposalTypography.filePathSize).toBeGreaterThanOrEqual(11);
    expect(proposalTypography.fileStateSize).toBeGreaterThanOrEqual(11);
    expect(proposalTypography.technicalMarker).toContain("›");
    if (testInfo.project.name === "chromium-mobile") expect(proposalTypography.technicalHeight).toBeGreaterThanOrEqual(40);
    const technicalDisclosure = page.locator(".proposal-review-technical");
    await technicalDisclosure.locator("summary").click();
    await expect(technicalDisclosure).toHaveAttribute("open", "");
    const changeKind = page.locator(".proposal-review-file-change").first();
    await expect(changeKind).toBeVisible();
    expect((await changeKind.textContent())?.trim()).not.toBe("");
    const proposalFileButton = page.locator("[data-proposal-review-path]").filter({ hasText: firstPath }).first();
    await expect(proposalFileButton).toHaveAttribute("data-proposal-review-path", firstPath);
    const requestsBeforeFileOpen = requests.length;
    await proposalFileButton.click();
    await expect(page.locator("[data-hosted-review-file]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept file", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject file", exact: true })).toBeVisible();
    await expect(page.locator("textarea:visible")).toHaveCount(0);
    await expect(page.locator("[data-external-block-decision]")).toHaveCount(0);
    await expect(page.locator("[data-external-review-all]")).toHaveCount(0);
    await expect(page.locator(".external-review-block-controls")).toHaveCount(0);
    const hostedFileSurface = await page.locator(".hosted-review-file-shell").evaluate((shell) => {
      const style = getComputedStyle(shell);
      return {
        boxShadow: style.boxShadow,
        borderRadius: Number.parseFloat(style.borderTopLeftRadius),
      };
    });
    expect(hostedFileSurface.boxShadow).toBe("none");
    expect(hostedFileSurface.borderRadius).toBeLessThanOrEqual(10);
    const exactFileReads = requests.slice(requestsBeforeFileOpen).filter((request) => (
      request.method === "GET"
      && scopedApiPath(request.pathname) === "/api/shared-context"
      && new URLSearchParams(request.search || "").get("file") === firstPath
    ));
    expect(exactFileReads).toHaveLength(1);
    await expectNoLayoutViolations(page, testInfo, `hosted-review-file-${testInfo.project.name}`);
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath(`hosted-review-file-${testInfo.project.name}.png`), fullPage: true });
    if (testInfo.project.name === "chromium-desktop") {
      const zoom = await emulateDesktopBrowserZoom(page, 2);
      try {
        await expect(page.locator("[data-hosted-review-file]")).toBeVisible();
        await expectNoLayoutViolations(page, testInfo, "hosted-review-file-zoom-200");
      } finally {
        await zoom.restore();
      }
    }

    await page.getByRole("button", { name: "Accept file", exact: true }).click();
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
    await expect.poll(() => requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/api/shared-context/review-files")).at(-1)?.postData).toEqual({
      expectedProposalHead: reviewHead,
      decision: "accept",
      files: [firstPath],
    });
    expect(requests.some((request) => request.pathname.endsWith("/api/shared-context/accept"))).toBe(false);
    await expect.poll(() => page.evaluate((path) => ({
      selected: state.selected || "",
      reviewed: state.sharedContext?.files?.find((file) => file.path === path)?.reviewed === true,
      decision: state.sharedContext?.files?.find((file) => file.path === path)?.decision || "",
    }), firstPath)).toEqual({ selected: "", reviewed: true, decision: "accept" });

    const unreview = page.locator("[data-proposal-unreview-path]").filter({ hasText: "Unreview" }).first();
    await expect(unreview).toHaveAttribute("data-proposal-unreview-path", firstPath);
    await expect(unreview).toBeVisible();
    await unreview.click();
    const unreviewDialog = page.getByRole("dialog", { name: /Unreview this document/ });
    await unreviewDialog.getByRole("button", { name: "Unreview", exact: true }).click();
    await expect.poll(() => requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/api/shared-context/unreview-file")).at(-1)?.postData).toEqual({
      expectedProposalHead: reviewHead,
      path: firstPath,
    });
    await expect.poll(() => page.evaluate((path) => ({
      pending: state.docqa?.pendingPaths?.includes(path) === true,
      reviewed: state.sharedContext?.files?.find((file) => file.path === path)?.reviewed === true,
      unreviewVisible: [...document.querySelectorAll("[data-proposal-unreview-path]")].some((node) => node.dataset.proposalUnreviewPath === path && !node.hidden),
    }), firstPath)).toEqual({ pending: true, reviewed: false, unreviewVisible: false });

    expect(requests.filter((request) => pathIsForbidden(request.pathname))).toEqual([]);
    expect(requests.filter((request) => scopedApiPath(request.pathname).startsWith("/api/context-hub"))).toEqual([]);
    expectHostedWorkspaceRegistrationFirst(requests);
    expectHostedRequestHygiene(requests, forbiddenHostMarkers);
    await expectNoHostedStateLeaks(page, forbiddenHostMarkers);
    await expectNoLayoutViolations(page, testInfo, `hosted-review-${testInfo.project.name}`);
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath(`hosted-review-list-${testInfo.project.name}.png`), fullPage: true });
    await page.locator("#brandHome").click();
    await page.waitForURL((url) => url.origin === PUBLIC_ORIGIN && url.pathname === "/" && url.searchParams.get("hub") === "1" && url.searchParams.get("view") === "hub");
    await waitForBoot(page);
    await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "hosted-hub");
  });

  test("@smoke hosted-review keeps post-challenge acceptance failures on its canonical review URL", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "One browser proves the Hosted terminal failure URL contract.");

    let challengeCalls = 0;
    const acceptBodies = [];
    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      challengeCalls += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: `hosted-terminal-challenge-${challengeCalls}`,
          proposalHead: reviewHead,
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      acceptBodies.push(route.request().postDataJSON());
      if (acceptBodies.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Hosted delivery is temporarily unavailable after confirmation.",
            code: "remote_request_rejected",
            retryable: true,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          proposalHead: reviewHead,
          deliveryVerified: false,
        }),
      });
    });

    await page.goto(`${PUBLIC_ORIGIN}${reviewPath}?hub=1&project=forged-local&view=proposal&proposal=forged-proposal`);
    await waitForBoot(page);
    await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "hosted-review");

    for (const file of reviewFiles) {
      const row = page.locator("[data-proposal-review-path]").filter({ hasText: file.path }).first();
      await expect(row).toBeVisible();
      if ((await row.textContent())?.includes("Reviewed")) continue;
      const decisionResponse = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/api/shared-context/review-files")
      ));
      await row.click();
      await expect(page.locator("[data-hosted-review-file]")).toBeVisible();
      await page.getByRole("button", { name: "Accept file", exact: true }).click();
      expect((await decisionResponse).status()).toBe(200);
      await expect(page.locator("#proposalReviewPage")).toBeVisible();
    }

    const assertCanonicalReviewUrl = async () => {
      await expect(page).toHaveURL((url) => (
        url.origin === PUBLIC_ORIGIN
        && url.pathname === reviewPath
        && url.searchParams.get("view") === "proposal"
        && ["hub", "project", "proposal", "file", "folder", "settings"].every((key) => !url.searchParams.has(key))
      ));
    };
    await assertCanonicalReviewUrl();
    await expect(page.getByRole("button", { name: "Put on main", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    let confirmation = page.getByRole("dialog", { name: /Put this proposal on main/ });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("checkbox").check();
    const serverFailure = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/api/shared-context/accept")
    ));
    await confirmation.getByRole("button", { name: "Put on main", exact: true }).click();
    expect((await serverFailure).status()).toBe(503);
    await expect(page.locator('[data-context-room-toast][role="alert"]')).toContainText("temporarily unavailable after confirmation");
    await assertCanonicalReviewUrl();

    await page.locator('[data-context-room-toast][role="alert"]').getByRole("button", { name: "Retry", exact: true }).click();
    confirmation = page.getByRole("dialog", { name: /Put this proposal on main/ });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("checkbox").check();
    const incompleteSuccess = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/api/shared-context/accept")
    ));
    await confirmation.getByRole("button", { name: "Put on main", exact: true }).click();
    expect((await incompleteSuccess).status()).toBe(200);
    await expect(page.locator('[data-context-room-toast][role="alert"]')).toContainText("could not verify this proposal");
    await assertCanonicalReviewUrl();

    expect(challengeCalls).toBe(2);
    expect(acceptBodies).toEqual([
      { expectedProposalHead: reviewHead, challengeId: "hosted-terminal-challenge-1" },
      { expectedProposalHead: reviewHead, challengeId: "hosted-terminal-challenge-2" },
    ]);
    await expect(page.locator("#proposalReviewPage")).toBeVisible();
  });
});
