import fs from "node:fs";
import http from "node:http";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room UX fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting/);
  await expect.poll(async () => {
    const diagnostics = await page.locator("body").getAttribute("data-workspace-diagnostics");
    return JSON.parse(diagnostics || "{}").phase || "";
  }).toBe("ready");
}

async function startLoopbackProxy(targetOrigin) {
  const target = new URL(targetOrigin);
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    });
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function showTerminalProposal(page, overrides = {}) {
  await page.evaluate((next) => {
    const proposal = next.proposal || "proposal/demo/terminal-action";
    const proposalHead = next.proposalHead || "0123456789abcdef0123456789abcdef01234567";
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        projectId: next.projectId || "demo-project",
        proposal,
        proposalHead,
        defaultBranch: "main",
        title: next.title || "Terminal action feedback",
        description: "Keep delivery feedback visible.",
        proposalFiles: ["README.md"],
        proposalChanges: [{ path: "README.md", status: "M", reviewKind: "proposal-change" }],
      },
    };
    state.docqa = {
      generatedAt: new Date().toISOString(),
      queue: [],
      pendingPaths: [],
      reviewedPaths: ["README.md"],
      summary: { needsReview: 0 },
    };
    state.proposalReviewKey = "";
    state.proposalActionBusy = false;
    state.proposalActionError = "";
    showProposalReview();
  }, overrides);
}

async function confirmTerminalAcceptance(page) {
  const dialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Put on main", exact: true }).click();
  return dialog;
}

test("@smoke a reviewed proposal row explains selection and can return to review", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "The touch path shares the selection helper and is covered by the source contract test.");
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);
  await page.waitForTimeout(500);

  const selectionResult = await page.evaluate(() => {
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        proposal: "proposal/demo/reviewed-selection",
        proposalHead: "0123456789abcdef",
        defaultBranch: "main",
        title: "Reviewed selection explanation",
        description: "Review every changed file as one proposal.",
        proposalFiles: ["README.md"],
        proposalChanges: [{
          path: "README.md",
          status: "M",
          fromPath: null,
          score: null,
          reviewKind: "proposal-change",
        }],
      },
    };
    state.docqa = {
      generatedAt: new Date().toISOString(),
      queue: [],
      pendingPaths: [],
      reviewedPaths: ["README.md"],
      summary: { needsReview: 0 },
    };
    state.proposalReviewKey = "";
    state.proposalSelectionNotice = "";
    showProposalReview();
    const target = document.querySelector('[data-proposal-review-path="README.md"]');
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const notice = document.querySelector("#proposalReviewNotice");
    return {
      noticeVisible: !notice.hidden,
      noticeKind: notice.dataset.kind,
      noticeText: notice.textContent,
      rowText: target.textContent,
      selectedCount: document.querySelectorAll('[data-proposal-review-selected="true"]').length,
    };
  });
  expect(selectionResult).toEqual({
    noticeVisible: true,
    noticeKind: "info",
    noticeText: "This file is already Reviewed, so it cannot be selected again. Selection only applies to files still marked Review. Open the file normally to inspect it.",
    rowText: expect.stringContaining("Reviewed"),
    selectedCount: 0,
  });

  const unreview = page.getByRole("button", { name: "Unreview README.md and return it to Review" });
  await expect(unreview).toBeVisible();
  await unreview.click();
  expect(pageErrors).toEqual([]);
  const dialog = page.getByRole("dialog", { name: "Unreview this document?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Accepted shared main and the proposal branch remain unchanged.");
  const confirm = dialog.getByRole("button", { name: "Unreview", exact: true });
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("@smoke the last individual file decision never auto-accepts the proposal", async ({ page }, testInfo) => {
  const { origin } = fixture();
  const terminalRequests = [];
  const fileReviewRequests = [];
  const backgroundReportRequests = [];
  let fileDecisionSaved = false;
  let reviewedReportRequests = 0;
  let releaseFirstReviewedReport;
  const firstReviewedReportReady = new Promise((resolve) => { releaseFirstReviewedReport = resolve; });

  await page.route("**/api/reports*", async (route) => {
    const reviewed = fileDecisionSaved;
    if (reviewed) {
      backgroundReportRequests.push(route.request().url());
      reviewedReportRequests += 1;
      if (reviewedReportRequests === 1) await firstReviewedReportReady;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        docqa: {
          generatedAt: new Date().toISOString(),
          queue: reviewed ? [] : [{
            path: "README.md",
            label: "README.md",
            currentHash: "readme-content-hash",
            resourceState: "present",
            resourceVersion: null,
            dependencyVersions: {},
          }],
          pendingPaths: reviewed ? [] : ["README.md"],
          reviewedPaths: reviewed ? ["README.md"] : [],
          summary: { needsReview: reviewed ? 0 : 1 },
        },
        doctor: { issues: [] },
        startupContext: [],
        startupSkills: [],
        startupHooks: [],
      }),
    });
  });

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    terminalRequests.push({ kind: "challenge", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "unexpected-automatic-challenge",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    terminalRequests.push({ kind: "accept", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        commit: "89abcdef0123456789abcdef0123456789abcdef",
        verifiedRemoteHead: "89abcdef0123456789abcdef0123456789abcdef",
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
      }),
    });
  });
  await page.route("**/api/shared-context/review-files", async (route) => {
    fileReviewRequests.push(route.request().postDataJSON());
    fileDecisionSaved = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        docqa: {
          generatedAt: new Date().toISOString(),
          queue: [],
          pendingPaths: [],
          reviewedPaths: ["README.md"],
          summary: { needsReview: 0 },
        },
        sharedContext: {
          mode: "review",
          acceptedChangesRemain: true,
          review: {
            projectId: "demo-project",
            proposal: "proposal/demo/last-individual-review",
            proposalHead: "0123456789abcdef0123456789abcdef01234567",
            defaultBranch: "main",
            title: "Last individual review",
            description: "The terminal merge must remain an explicit separate decision.",
            proposalFiles: ["README.md"],
            proposalChanges: [{ path: "README.md", status: "M", reviewKind: "proposal-change" }],
          },
        },
      }),
    });
  });

  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        projectId: "demo-project",
        proposal: "proposal/demo/last-individual-review",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        defaultBranch: "main",
        title: "Last individual review",
        description: "The terminal merge must remain an explicit separate decision.",
        proposalFiles: ["README.md"],
        proposalChanges: [{ path: "README.md", status: "M", reviewKind: "proposal-change" }],
      },
    };
    state.docqa = {
      generatedAt: new Date().toISOString(),
      queue: [{
        path: "README.md",
        label: "README.md",
        currentHash: "readme-content-hash",
        resourceState: "present",
        resourceVersion: null,
        dependencyVersions: {},
      }],
      pendingPaths: ["README.md"],
      reviewedPaths: [],
      summary: { needsReview: 1 },
    };
    state.proposalReviewKey = "";
    state.proposalSelectedFiles.clear();
    state.proposalActionBusy = false;
    state.proposalActionError = "";
    state.lastReportRefreshAt = Date.now();
    state.lastFullRefreshAt = Date.now();
    showProposalReview();
  });

  const fileRow = page.getByRole("button", { name: /Open README\.md/ });
  if (testInfo.project.name === "chromium-mobile") {
    const pointer = await fileRow.evaluate((row) => {
      const rect = row.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        pointerId: 17,
        button: 0,
        buttons: 1,
        isPrimary: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      row.dispatchEvent(new PointerEvent("pointerdown", init));
      return init;
    });
    await page.waitForTimeout(650);
    await fileRow.evaluate((row, init) => {
      row.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    }, pointer);
  } else {
    await fileRow.click({ button: "right" });
  }
  await expect(page.getByRole("button", { name: "Accept selected", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Accept selected", exact: true }).click();

  await expect.poll(() => fileReviewRequests.length).toBe(1);
  expect(fileReviewRequests[0]).toEqual({
    expectedProposalHead: "0123456789abcdef0123456789abcdef01234567",
    decision: "accept",
    files: [{
      path: "README.md",
      expectedContentHash: "readme-content-hash",
      expectedResourceState: "present",
      expectedResourceVersion: null,
      expectedDependencyVersions: {},
    }],
  });
  const putOnMain = page.getByRole("button", { name: "Put on main", exact: true });
  await expect(putOnMain).toBeVisible();
  await expect(putOnMain).toBeEnabled();

  await page.evaluate(() => {
    state.lastReportRefreshAt = 0;
    scheduleBackgroundRefresh({ forceReports: true });
  });
  await expect.poll(() => backgroundReportRequests.length).toBe(1);
  await page.evaluate(() => scheduleBackgroundRefresh({ forceReports: true }));
  releaseFirstReviewedReport();
  await expect.poll(() => backgroundReportRequests.length).toBe(2);
  await expect.poll(() => page.evaluate(() => ({
    inFlight: state.reportsRefreshInFlight,
    pending: Boolean(state.backgroundRefreshPendingOptions),
    timer: Boolean(state.backgroundRefreshTimer),
  }))).toEqual({ inFlight: false, pending: false, timer: false });

  await expect(page.locator("#proposalReviewPage")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Last individual review" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open README\.md/ })).toContainText("Reviewed");
  await expect(putOnMain).toBeVisible();
  await expect(putOnMain).toBeEnabled();
  expect(await page.evaluate(() => ({
    page: state.page,
    mode: state.sharedContext?.mode,
    proposal: state.sharedContext?.review?.proposal,
    pendingPaths: state.docqa?.pendingPaths || [],
    reviewedPaths: state.docqa?.reviewedPaths || [],
    accepted: Boolean(state.sharedContext?.accepted?.accepted),
    rejected: Boolean(state.sharedContext?.rejected?.rejected),
  }))).toEqual({
    page: "proposal",
    mode: "review",
    proposal: "proposal/demo/last-individual-review",
    pendingPaths: [],
    reviewedPaths: ["README.md"],
    accepted: false,
    rejected: false,
  });
  expect(terminalRequests).toEqual([]);
});

test("@smoke terminal proposal acceptance obtains a one-shot challenge before confirmation", async ({ page }) => {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);

  let releaseChallenge;
  const challengeReady = new Promise((resolve) => { releaseChallenge = resolve; });
  const requests = [];
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    requests.push({ kind: "challenge", body: route.request().postDataJSON() });
    await challengeReady;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-terminal-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    requests.push({ kind: "accept", body: route.request().postDataJSON() });
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Accept must not run before confirmation." }) });
  });

  await showTerminalProposal(page);
  const acceptButton = page.getByRole("button", { name: "Put on main", exact: true });
  await expect(acceptButton).toBeVisible();
  await acceptButton.click();

  await expect.poll(() => requests.map((request) => request.kind)).toEqual(["challenge"]);
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toHaveCount(0);
  releaseChallenge();
  const dialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
  await expect(dialog).toBeVisible();
  expect(requests).toEqual([{
    kind: "challenge",
    body: { expectedProposalHead: "0123456789abcdef0123456789abcdef01234567" },
  }]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("@smoke verified terminal acceptance stays pending, reports the commit, then returns to the right Hub", async ({ page }) => {
  const { origin } = fixture();
  const hubUrl = `${origin}/?hub=1&workspace=workspace-demo&project=demo-project&view=hub&explorer=expanded`;
  const reviewUrl = new URL(origin + "/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-demo");
  reviewUrl.searchParams.set("project", "demo-project");
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", hubUrl);
  reviewUrl.searchParams.set("explorer", "collapsed");
  await page.goto(reviewUrl.toString());
  await waitForBoot(page);
  const explorerClose = page.getByRole("button", { name: "Close explorer" });
  if (await explorerClose.isVisible()) await explorerClose.click();

  const acceptedCommit = "89abcdef".repeat(8);
  const flashToken = "a".repeat(32);
  const requests = [];
  let releaseAccept;
  const acceptReady = new Promise((resolve) => { releaseAccept = resolve; });
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    requests.push({ kind: "challenge", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-success-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    requests.push({ kind: "accept", body: route.request().postDataJSON() });
    await acceptReady;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit: acceptedCommit,
        verifiedRemoteHead: acceptedCommit,
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
        flashToken,
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: flashToken });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "merge", commit: acceptedCommit, hubRefresh: { status: "complete" } }),
    });
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  const dialog = await confirmTerminalAcceptance(page);

  await expect.poll(() => requests.map((request) => request.kind)).toEqual(["challenge", "accept"]);
  expect(requests[1].body).toEqual({
    expectedProposalHead: "0123456789abcdef0123456789abcdef01234567",
    challengeId: "challenge-success-1",
  });
  await expect(dialog.getByRole("button", { name: "Putting on main…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Putting on main…", exact: true })).toHaveAttribute("aria-busy", "true");
  await expect(page).toHaveURL(reviewUrl.toString());

  releaseAccept();
  await expect(page).toHaveURL(hubUrl);
  await waitForBoot(page);
  const toast = page.locator('[data-context-room-toast][role="status"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Proposal merged into main");
  await expect(toast).toContainText(acceptedCommit);
});

test("@smoke verified terminal acceptance with a pending Hub refresh keeps success and returns to the right Hub", async ({ page }) => {
  const { origin } = fixture();
  const hubUrl = `${origin}/?hub=1&workspace=workspace-pending-refresh&project=demo-project&view=hub&explorer=expanded`;
  const reviewUrl = new URL(origin + "/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-pending-refresh");
  reviewUrl.searchParams.set("project", "demo-project");
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", hubUrl);
  reviewUrl.searchParams.set("explorer", "collapsed");
  await page.goto(reviewUrl.toString());
  await waitForBoot(page);

  const acceptedCommit = "76543210".repeat(5);
  const flashToken = "p".repeat(32);
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-pending-hub-refresh-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit: acceptedCommit,
        verifiedRemoteHead: acceptedCommit,
        defaultBranch: "main",
        hubRefresh: { status: "pending" },
        flashToken,
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: flashToken });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "merge",
        commit: acceptedCommit,
        hubRefresh: { status: "pending" },
      }),
    });
  });

  await showTerminalProposal(page);
  const explorerClose = page.getByRole("button", { name: "Close explorer" });
  if (await explorerClose.isVisible()) await explorerClose.click();
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  await confirmTerminalAcceptance(page);

  await expect(page).toHaveURL(hubUrl);
  await waitForBoot(page);
  const toast = page.locator('[data-context-room-toast][role="status"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Merged into main · Hub refresh pending");
  await expect(toast).toContainText(acceptedCommit);
  await expect(page.locator('[data-context-room-toast][role="alert"]')).toBeHidden();
  const target = new URL(page.url());
  expect(target.searchParams.get("view")).toBe("hub");
  expect(target.searchParams.has("proposal")).toBe(false);
});

test("@smoke terminal acceptance without a valid returnTo falls back to the root Hub and preserves review scope", async ({ page }) => {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);

  const reviewUrl = new URL(origin + "/reviews/authority-demo/");
  reviewUrl.searchParams.set("hub", "1");
  reviewUrl.searchParams.set("workspace", "workspace-demo");
  reviewUrl.searchParams.set("project", "demo-project");
  reviewUrl.searchParams.set("view", "proposal");
  reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
  reviewUrl.searchParams.set("returnTo", "https://untrusted.invalid/?hub=1&workspace=wrong&project=wrong");
  await page.evaluate((url) => window.history.replaceState(window.history.state, "", url), reviewUrl.toString());

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-root-fallback-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    const commit = "89abcdef0123456789abcdef0123456789abcdef";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        commit,
        verifiedRemoteHead: commit,
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
        flashToken: "b".repeat(32),
      }),
    });
  });
  await page.route("**/api/context-hub/flash", async (route) => {
    const commit = "89abcdef0123456789abcdef0123456789abcdef";
    expect(route.request().postDataJSON()).toEqual({ token: "b".repeat(32) });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "merge", commit, hubRefresh: { status: "complete" } }),
    });
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  await confirmTerminalAcceptance(page);
  await page.waitForURL((url) => url.searchParams.get("view") === "hub");

  const target = new URL(page.url());
  expect(target.origin).toBe(origin);
  expect(target.pathname).toBe("/");
  expect(target.searchParams.get("hub")).toBe("1");
  expect(target.searchParams.get("workspace")).toBe("workspace-demo");
  expect(target.searchParams.get("project")).toBe("demo-project");
  expect(target.searchParams.get("view")).toBe("hub");
  expect(target.searchParams.has("proposal")).toBe(false);
  expect(target.searchParams.has("returnTo")).toBe(false);
  await waitForBoot(page);
});

test("@smoke verified acceptance carries its one-shot success toast across Hub ports", async ({ page }) => {
  const { origin } = fixture();
  const hubProxy = await startLoopbackProxy(origin);
  try {
    const hubUrl = `${hubProxy.origin}/?hub=1&workspace=workspace-cross-port&project=demo-project&view=hub&explorer=collapsed`;
    await page.goto(hubUrl);
    await waitForBoot(page);
    await page.evaluate(() => window.sessionStorage.removeItem("context-room:toast:v1"));

    const reviewUrl = new URL(origin + "/");
    reviewUrl.searchParams.set("hub", "1");
    reviewUrl.searchParams.set("workspace", "workspace-cross-port");
    reviewUrl.searchParams.set("project", "demo-project");
    reviewUrl.searchParams.set("view", "proposal");
    reviewUrl.searchParams.set("proposal", "proposal/demo/cross-port-toast");
    reviewUrl.searchParams.set("returnTo", hubUrl);
    reviewUrl.searchParams.set("explorer", "collapsed");
    await page.goto(reviewUrl.toString());
    await waitForBoot(page);
    const explorerClose = page.getByRole("button", { name: "Close explorer" });
    if (await explorerClose.isVisible()) await explorerClose.click();

    const acceptedCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const flashToken = "c".repeat(32);
    let flashConsumeCalls = 0;
    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: "challenge-cross-port-1",
          action: "accept",
          authorityId: "authority-demo",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          deliveryVerified: true,
          proposal: "proposal/demo/cross-port-toast",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          commit: acceptedCommit,
          verifiedRemoteHead: acceptedCommit,
          defaultBranch: "main",
          hubRefresh: { status: "complete" },
          flashToken,
        }),
      });
    });
    await page.route("**/api/context-hub/flash", async (route) => {
      flashConsumeCalls += 1;
      expect(route.request().postDataJSON()).toEqual({ token: flashToken });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "merge",
          commit: acceptedCommit,
          hubRefresh: { status: "complete" },
        }),
      });
    });

    await showTerminalProposal(page, { proposal: "proposal/demo/cross-port-toast" });
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    await confirmTerminalAcceptance(page);
    await page.waitForURL((url) => url.origin === hubProxy.origin && url.searchParams.get("view") === "hub");
    await waitForBoot(page);

    expect(await page.evaluate(() => window.sessionStorage.getItem("context-room:toast:v1"))).toBeNull();
    const toast = page.locator('[data-context-room-toast][role="status"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Proposal merged into main");
    await expect(toast).toContainText(acceptedCommit);
    expect(flashConsumeCalls).toBe(1);
    const deliveredUrl = new URL(page.url());
    expect([...deliveredUrl.searchParams.keys()].some((key) => /^cr(?:Flash|Outcome|Commit|HubRefresh)$/i.test(key))).toBe(false);

    await page.reload();
    await waitForBoot(page);
    await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  } finally {
    await hubProxy.close();
  }
});

test("@smoke a forged URL flash can never manufacture a verified merge success", async ({ page }) => {
  const { origin } = fixture();
  const forgedCommit = "badc0ffee0ddf00dbadc0ffee0ddf00dbadc0ffe";
  const forgedUrl = new URL(origin + "/");
  forgedUrl.searchParams.set("hub", "1");
  forgedUrl.searchParams.set("view", "hub");
  forgedUrl.searchParams.set("crFlash", JSON.stringify({
    title: "Proposal merged into main",
    message: "Commit " + forgedCommit,
    kind: "status",
  }));
  forgedUrl.searchParams.set("crOutcome", "merged");
  forgedUrl.searchParams.set("crCommit", forgedCommit);
  forgedUrl.searchParams.set("crHubRefresh", "complete");

  await page.goto(forgedUrl.toString());
  await waitForBoot(page);

  await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  await expect(page.locator("body")).not.toContainText("Proposal merged into main");
  await expect(page.locator("body")).not.toContainText(forgedCommit);
  const cleanedUrl = new URL(page.url());
  expect(["crFlash", "crOutcome", "crCommit", "crHubRefresh"].some((key) => cleanedUrl.searchParams.has(key))).toBe(false);
});

test("@smoke an accepted HTTP 200 without complete remote proof stays on the proposal and offers retry", async ({ page }) => {
  const { origin } = fixture();
  const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
  const soundCalls = [];
  let acceptCalls = 0;
  await page.exposeFunction("recordIncompleteProofSound", (cue) => soundCalls.push(cue));
  await page.goto(reviewUrl);
  await waitForBoot(page);

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-incomplete-proof-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    acceptCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        deliveryVerified: true,
        commit: "89abcdef0123456789abcdef0123456789abcdef",
        verifiedRemoteHead: "not-an-exact-remote-head",
        defaultBranch: "main",
        hubRefresh: { status: "complete" },
      }),
    });
  });
  await page.evaluate(() => {
    const originalPlayContextRoomSound = window.playContextRoomSound;
    window.playContextRoomSound = (cue, ...args) => {
      if (cue === "proposal-accepted") void window.recordIncompleteProofSound(cue);
      return originalPlayContextRoomSound(cue, ...args);
    };
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  const dialog = await confirmTerminalAcceptance(page);

  await expect.poll(() => acceptCalls).toBe(1);
  await expect(dialog).toBeHidden();
  await expect.soft(page).toHaveURL(reviewUrl, { timeout: 1_500 });
  expect.soft(soundCalls).toEqual([]);
  await expect.soft(page.locator('[data-context-room-toast][role="status"]')).toBeHidden({ timeout: 1_500 });
  const errorToast = page.locator('[data-context-room-toast][role="alert"]');
  await expect.soft(errorToast).toBeVisible({ timeout: 1_500 });
  await expect.soft(errorToast).toContainText("Context Room could not verify this proposal on the remote main branch.", { timeout: 1_500 });
  await expect.soft(errorToast.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 1_500 });
});

test("@smoke a cross-origin accepted HTTP 200 without a flash token stays on the proposal and offers retry", async ({ page }) => {
  const { origin } = fixture();
  const hubProxy = await startLoopbackProxy(origin);
  const soundCalls = [];
  let acceptCalls = 0;
  try {
    const hubUrl = `${hubProxy.origin}/?hub=1&workspace=workspace-cross-origin-proof&project=demo-project&view=hub`;
    const reviewUrl = new URL(origin + "/");
    reviewUrl.searchParams.set("hub", "1");
    reviewUrl.searchParams.set("workspace", "workspace-cross-origin-proof");
    reviewUrl.searchParams.set("project", "demo-project");
    reviewUrl.searchParams.set("view", "proposal");
    reviewUrl.searchParams.set("proposal", "proposal/demo/terminal-action");
    reviewUrl.searchParams.set("returnTo", hubUrl);
    await page.exposeFunction("recordMissingFlashSound", (cue) => soundCalls.push(cue));
    await page.goto(reviewUrl.toString());
    await waitForBoot(page);
    const explorerClose = page.getByRole("button", { name: "Close explorer" });
    if (await explorerClose.isVisible()) await explorerClose.click();

    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: "challenge-missing-cross-origin-flash-1",
          action: "accept",
          authorityId: "authority-demo",
          proposal: "proposal/demo/terminal-action",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      acceptCalls += 1;
      const commit = "89abcdef0123456789abcdef0123456789abcdef";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          deliveryVerified: true,
          proposal: "proposal/demo/terminal-action",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          commit,
          verifiedRemoteHead: commit,
          defaultBranch: "main",
          hubRefresh: { status: "complete" },
        }),
      });
    });
    await page.evaluate(() => {
      window.playContextRoomSound = (cue) => {
        if (cue === "proposal-accepted") void window.recordMissingFlashSound(cue);
      };
    });

    await showTerminalProposal(page);
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    const dialog = await confirmTerminalAcceptance(page);

    await expect.poll(() => acceptCalls).toBe(1);
    await expect(dialog).toBeHidden();
    await expect.soft(page).toHaveURL(reviewUrl.toString(), { timeout: 1_500 });
    expect.soft(soundCalls).toEqual([]);
    await expect.soft(page.locator('[data-context-room-toast][role="status"]')).toBeHidden({ timeout: 1_500 });
    const errorToast = page.locator('[data-context-room-toast][role="alert"]');
    await expect.soft(errorToast).toBeVisible({ timeout: 1_500 });
    await expect.soft(errorToast).toContainText("Context Room could not verify this proposal on the remote main branch.", { timeout: 1_500 });
    await expect.soft(errorToast.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 1_500 });
  } finally {
    await hubProxy.close();
  }
});

for (const mismatch of [
  {
    label: "proposal",
    proposal: "proposal/demo/a-different-terminal-action",
    proposalHead: "0123456789abcdef0123456789abcdef01234567",
  },
  {
    label: "proposal head",
    proposal: "proposal/demo/terminal-action",
    proposalHead: "fedcba9876543210fedcba9876543210fedcba98",
  },
]) {
  test(`@smoke an accepted HTTP 200 bound to a different ${mismatch.label} stays on the proposal and offers retry`, async ({ page }) => {
    const { origin } = fixture();
    const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
    const soundCalls = [];
    let acceptCalls = 0;
    await page.exposeFunction("recordMismatchedAcceptanceSound", (cue) => soundCalls.push(cue));
    await page.goto(reviewUrl);
    await waitForBoot(page);

    await page.route("**/api/shared-context/accept-challenge", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          challengeId: `challenge-mismatched-${mismatch.label.replace(/\s+/g, "-")}-1`,
          action: "accept",
          authorityId: "authority-demo",
          proposal: "proposal/demo/terminal-action",
          proposalHead: "0123456789abcdef0123456789abcdef01234567",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    await page.route("**/api/shared-context/accept", async (route) => {
      acceptCalls += 1;
      const commit = "89abcdef0123456789abcdef0123456789abcdef";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          deliveryVerified: true,
          proposal: mismatch.proposal,
          proposalHead: mismatch.proposalHead,
          commit,
          verifiedRemoteHead: commit,
          defaultBranch: "main",
          hubRefresh: { status: "complete" },
        }),
      });
    });
    await page.evaluate(() => {
      window.playContextRoomSound = (cue) => {
        if (cue === "proposal-accepted") void window.recordMismatchedAcceptanceSound(cue);
      };
    });

    await showTerminalProposal(page);
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    const dialog = await confirmTerminalAcceptance(page);

    await expect.poll(() => acceptCalls).toBe(1);
    await expect(dialog).toBeHidden();
    await expect.soft(page).toHaveURL(reviewUrl, { timeout: 1_500 });
    expect.soft(soundCalls).toEqual([]);
    await expect.soft(page.locator('[data-context-room-toast][role="status"]')).toBeHidden({ timeout: 1_500 });
    const errorToast = page.locator('[data-context-room-toast][role="alert"]');
    await expect.soft(errorToast).toBeVisible({ timeout: 1_500 });
    await expect.soft(errorToast).toContainText("Context Room could not verify this proposal on the remote main branch.", { timeout: 1_500 });
    await expect.soft(errorToast.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 1_500 });
  });
}

test("@smoke failed terminal acceptance stays put, stays silent, and retries with a fresh challenge", async ({ page }) => {
  const { origin } = fixture();
  const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
  await page.goto(reviewUrl);
  await waitForBoot(page);

  const challengeIds = ["challenge-failure-1", "challenge-failure-2"];
  let challengeCalls = 0;
  let acceptCalls = 0;
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    const challengeId = challengeIds[challengeCalls++];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId,
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    acceptCalls += 1;
    expect(route.request().postDataJSON().challengeId).toBe(challengeIds[acceptCalls - 1]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "GitHub refused the proposal push.", code: "shared_context_acceptance_stale" }),
    });
  });
  await page.evaluate(() => {
    window.__proposalAcceptedSoundCalls = [];
    const originalPlayContextRoomSound = window.playContextRoomSound;
    window.playContextRoomSound = (cue, ...args) => {
      if (cue === "proposal-accepted") window.__proposalAcceptedSoundCalls.push(cue);
      return originalPlayContextRoomSound(cue, ...args);
    };
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toBeVisible();
  const dialog = await confirmTerminalAcceptance(page);
  await expect(dialog.getByRole("button", { name: "Putting on main…", exact: true })).toBeDisabled();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL((url) => url.origin === origin && url.searchParams.get("view") === "proposal");
  expect(await page.evaluate(() => window.__proposalAcceptedSoundCalls)).toEqual([]);

  const toast = page.locator('[data-context-room-toast][role="alert"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("GitHub refused the proposal push.");
  await toast.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => challengeCalls).toBe(2);
  expect(acceptCalls).toBe(1);
  const retryDialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
  await expect(retryDialog).toBeVisible();
  await expect(retryDialog.getByRole("checkbox")).not.toBeChecked();
  await expect(retryDialog.getByRole("button", { name: "Put on main", exact: true })).toBeDisabled();
  await retryDialog.getByRole("checkbox").check();
  await retryDialog.getByRole("button", { name: "Put on main", exact: true }).click();
  await expect.poll(() => acceptCalls).toBe(2);
  expect(challengeCalls).toBe(2);
  await expect(retryDialog).toBeHidden();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("GitHub refused the proposal push.");
  await expect(page).toHaveURL((url) => url.origin === origin && url.searchParams.get("view") === "proposal");
  expect(await page.evaluate(() => window.__proposalAcceptedSoundCalls)).toEqual([]);
});

test("@smoke a terminal acceptance network failure stays on the proposal with a persistent alert and retry", async ({ page }) => {
  const { origin } = fixture();
  const reviewUrl = origin + "/?hub=1&view=proposal&proposal=proposal%2Fdemo%2Fterminal-action";
  const challengeIds = ["challenge-network-failure-1", "challenge-network-failure-2"];
  let challengeCalls = 0;
  let acceptCalls = 0;
  await page.goto(reviewUrl);
  await waitForBoot(page);

  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    const challengeId = challengeIds[challengeCalls++];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId,
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/shared-context/accept", async (route) => {
    acceptCalls += 1;
    expect(route.request().postDataJSON().challengeId).toBe(challengeIds[acceptCalls - 1]);
    await route.abort("failed");
  });

  await showTerminalProposal(page);
  await page.getByRole("button", { name: "Put on main", exact: true }).click();
  const dialog = await confirmTerminalAcceptance(page);

  await expect.poll(() => acceptCalls).toBe(1);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(reviewUrl);
  await expect(page.locator('[data-context-room-toast][role="status"]')).toBeHidden();
  const errorToast = page.locator('[data-context-room-toast][role="alert"]');
  await expect(errorToast).toBeVisible();
  await expect(errorToast).toContainText("Failed to fetch");
  const retry = errorToast.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();

  await page.waitForTimeout(1_500);
  await expect(errorToast).toBeVisible();
  await expect(page).toHaveURL(reviewUrl);
  await retry.click();
  await expect.poll(() => challengeCalls).toBe(2);
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toBeVisible();
  expect(acceptCalls).toBe(1);
  await expect(page).toHaveURL(reviewUrl);
});

test("@smoke terminal action is in the viewport and keyboard-operable on mobile at 200% zoom", async ({ page }) => {
  const { origin } = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/?hub=1&view=proposal");
  await waitForBoot(page);
  await page.route("**/api/shared-context/accept-challenge", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "challenge-mobile-1",
        action: "accept",
        authorityId: "authority-demo",
        proposalHead: "0123456789abcdef0123456789abcdef01234567",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });

  await showTerminalProposal(page);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const acceptButton = page.getByRole("button", { name: "Put on main", exact: true });
  await expect(acceptButton).toBeVisible();
  await expect(acceptButton).toBeInViewport();
  await acceptButton.focus();
  await expect(acceptButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /Put this proposal on main\?/ })).toBeVisible();
});
