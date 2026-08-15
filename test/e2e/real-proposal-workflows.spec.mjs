import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

import {
  createMemoryServer,
  initializeContextRoomProject,
} from "../../src/context_room.mjs";
import {
  readContextHubRegistry,
  registerContextHubProject,
  registerContextHubSharedRepository,
  unregisterContextHubProject,
  unregisterContextHubSharedRepository,
} from "../../src/context_hub.mjs";
import { signRemoteIdentity } from "../../src/remote_identity.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  disconnectSharedContext,
  initializeSharedRepository,
  listSharedRepositoryProposals,
  publishSharedProposal,
  readSharedProjectConnection,
  sharedContextStatus,
} from "../../src/shared_context.mjs";

const HOSTED_HOST = "context.qm.peerlab.fr";
const HOSTED_ORIGIN = `https://${HOSTED_HOST}`;
const HOSTED_HUMAN_SECRET = "real-workflow-human-secret-with-more-than-32-bytes";
const HOSTED_AGENT_SECRET = "real-workflow-agent-secret-with-more-than-32-bytes";
const HOSTED_HEALTH_SECRET = "real-workflow-health-secret-with-more-than-32-bytes";
const HOSTED_FORBIDDEN_API_PREFIXES = [
  "/api/settings",
  "/api/files",
  "/api/file",
  "/api/reports",
  "/api/docqa",
  "/api/codex-prompts",
  "/api/context-hub/project",
  "/api/context-hub/shared-repositories",
  "/api/context/",
  "/api/startup-",
  "/api/shared-skills",
  "/api/shared-instructions",
];

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room UX fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureGit(root, label) {
  git(root, ["config", "user.email", `${label}@example.test`]);
  git(root, ["config", "user.name", `Context Room ${label}`]);
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createSharedWorkflowFixture(base, {
  slug,
  projectId,
  projectTitle,
  proposalTitle,
  proposalDescription,
  baselineFiles,
  proposalFiles,
}) {
  const remote = path.join(base, `${slug}.git`);
  const seed = path.join(base, `${slug}-seed`);
  const project = path.join(base, `${slug}-project`);
  const proposalBranch = `proposal/${projectId}/${slug}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;

  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed, `${slug}-seed`);
  initializeSharedRepository(seed, { name: `${projectTitle} Shared Context` });
  write(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: projectId, title: projectTitle }],
  }, null, 2) + "\n");
  for (const [relativePath, content] of Object.entries(baselineFiles)) {
    write(seed, `projects/${projectId}/${relativePath}`, content);
  }
  write(
    seed,
    `projects/${projectId}/skills/baseline/SKILL.md`,
    `---\nname: ${projectId}-baseline\ndescription: Keep the real Playwright workflow fixture complete.\n---\n\n# ${projectTitle} baseline\n`,
  );
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", `Initialize ${projectTitle} shared context`]);
  git(seed, ["push", "origin", "main"]);
  const mainHead = git(seed, ["rev-parse", "HEAD"]);

  fs.mkdirSync(project, { recursive: true });
  git(project, ["init", "--initial-branch=main"]);
  configureGit(project, `${slug}-project`);
  write(project, "docs/README.md", `# ${projectTitle}\n\nLocal project used only by this test fixture.\n`);
  initializeContextRoomProject(project, {
    title: projectTitle,
    allowedPaths: ["docs/"],
    watchAllow: ["docs/"],
  });
  git(project, ["add", "."]);
  git(project, ["commit", "-m", `Initialize ${projectTitle} local project`]);
  connectSharedContext(project, { repository: remote, projectId });

  const proposal = createSharedProposal(project, {
    title: proposalTitle,
    description: proposalDescription,
    branch: proposalBranch,
  });
  configureGit(proposal.root, `${slug}-proposal`);
  for (const [relativePath, content] of Object.entries(proposalFiles)) {
    write(proposal.root, `projects/${projectId}/${relativePath}`, content);
  }
  const published = publishSharedProposal(project, { proposal: proposal.branch });

  return {
    remote,
    seed,
    project,
    projectId,
    projectTitle,
    proposalTitle,
    proposalDescription,
    proposalBranch: proposal.branch,
    proposalHead: published.head,
    mainHead,
    baselineFiles,
    proposalFiles,
  };
}

function readProjectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".context-room", "config.json"), "utf8"));
}

function managedBaselineSkill(root) {
  return path.join(root, ".agents", "skills", "baseline");
}

function fixtureRepositoryIdentity(repository) {
  try { return fs.realpathSync(repository); } catch { return String(repository || ""); }
}

function sameFixtureRepository(left, right) {
  return fixtureRepositoryIdentity(left) === fixtureRepositoryIdentity(right);
}

function advanceSharedMain(item, label) {
  const marker = `${item.slug || item.projectTitle} accepted ${label}`;
  const skillPath = `projects/${item.projectId}/skills/baseline/SKILL.md`;
  write(
    item.seed,
    skillPath,
    `---\nname: ${item.projectId}-baseline\ndescription: Keep the real Playwright workflow fixture complete.\n---\n\n# ${item.projectTitle} baseline\n\n${marker}\n`,
  );
  write(item.seed, `projects/${item.projectId}/docs/${label}.md`, `# ${label}\n\n${marker}\n`);
  git(item.seed, ["add", skillPath, `projects/${item.projectId}/docs/${label}.md`]);
  git(item.seed, ["commit", "-m", `Advance ${item.projectTitle} accepted ${label}`]);
  git(item.seed, ["push", "origin", "main"]);
  return { marker, revision: git(item.seed, ["rev-parse", "HEAD"]) };
}

function expectProjectSharedEffects(root, item, expected) {
  const connection = readSharedProjectConnection(root);
  expect(connection).toMatchObject({ projectId: item.projectId });
  expect(fs.realpathSync(connection.repository)).toBe(fs.realpathSync(item.remote));
  expect(fs.realpathSync(connection.projectRoot)).toBe(fs.realpathSync(root));
  const status = sharedContextStatus(root);
  expect(status.connected).toBe(true);
  if (expected?.revision) expect(status.revision).toBe(expected.revision);
  const current = path.join(status.cacheRoot, "current");
  expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);
  if (expected?.revision) expect(fs.realpathSync(current)).toBe(fs.realpathSync(path.join(status.cacheRoot, "snapshots", expected.revision)));
  const skillLink = managedBaselineSkill(root);
  expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
  if (expected?.revision) expect(fs.realpathSync(skillLink)).toContain(path.join("snapshots", expected.revision));
  if (expected?.marker) expect(fs.readFileSync(path.join(skillLink, "SKILL.md"), "utf8")).toContain(expected.marker);
  const config = readProjectConfig(root);
  expect(config.sharedContext).toMatchObject({ enabled: true, projectId: item.projectId });
  expect(sameFixtureRepository(config.sharedContext.repository, item.remote)).toBe(true);
  expect((config.hubSections || []).some((section) => section.id === "shared-context")).toBe(true);
}

async function expectProjectSharedEffectsEventually(root, item, expected) {
  if (expected?.revision) {
    await expect.poll(() => sharedContextStatus(root).revision, {
      message: `Shared snapshot ${expected.revision} becomes current for ${item.projectTitle}`,
    }).toBe(expected.revision);
  }
  expectProjectSharedEffects(root, item, expected);
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => {
    const diagnostics = JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}");
    return diagnostics.phase || "";
  }).toBe("ready");
}

async function refreshContextHubThroughUi(page) {
  const posts = [];
  const recordPost = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/context-hub/refresh") {
      posts.push(request.postDataJSON());
    }
  };
  page.on("request", recordPost);
  try {
    const responsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/context-hub/refresh"
    ));
    const browserState = await page.evaluate(async () => {
      const deadline = Date.now() + 30_000;
      while (state.contextHubBusy || state.sharedContextBusy) {
        if (Date.now() >= deadline) {
          throw new Error(`Context Hub stayed busy before refresh: ${JSON.stringify({
            contextHubBusy: state.contextHubBusy,
            sharedContextBusy: state.sharedContextBusy,
            reviewQueueReady: state.contextHubReviewQueueReady,
          })}`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      await refreshContextHubUi();
      return {
        repositoryErrors: state.contextHub?.repositoryErrors || [],
        sharedRepositories: (state.contextHub?.sharedRepositories || []).map((repository) => ({
          id: repository.id,
          availability: repository.availability,
          projectIds: (repository.projects || []).map((project) => project.id),
          status: repository.status,
        })),
        proposals: (state.contextHub?.proposals || []).map((proposal) => ({
          title: proposal.title,
          branch: proposal.branch,
          repositoryId: proposal.repositoryId,
          projectId: proposal.projectId,
          projectKey: proposal.projectKey,
          projectKeys: proposal.projectKeys,
          reviewStatus: proposal.reviewStatus,
        })),
        selectedProject: {
          locationId: state.activeProjectLocationId,
          projectKey: state.globalExplorerProjectKey,
        },
      };
    });
    const response = await responsePromise;
    const responseBody = await response.json();
    expect(response.status(), JSON.stringify(responseBody)).toBe(200);
    expect(posts).toEqual([{}]);
    return { browserState, responseBody };
  } finally {
    page.off("request", recordPost);
  }
}

async function openProjectSharedSettings(page) {
  if (!await page.locator("#settingsPage").isVisible()) {
    await expect(page.locator("#settingsButton")).toBeVisible();
    await page.locator("#settingsButton").click();
  }
  await expect(page.locator("#settingsPage")).toBeVisible();
  await page.locator("#settings-tab-project").click();
  await expect(page.locator('[data-settings-section-panel="shared-contexts"]')).toBeVisible();
  const disclosure = page.locator('[data-settings-disclosure="project-shared-connection"]');
  await expect(disclosure).toBeVisible();
  if (!await disclosure.evaluate((node) => node.open)) await disclosure.locator("summary").click();
  return disclosure;
}

function proposalRow(page, title) {
  return page.locator("[data-context-room-review-entry]", { hasText: title });
}

async function openProposalFromHub(page, title) {
  const opening = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/context-hub/review"
  )).then((response) => response.status());
  await proposalRow(page, title)
    .getByRole("button", { name: `Open proposal ${title}` })
    .click();
  expect(await opening).toBe(201);
}

function proposalFileButton(page, filePath) {
  return page.locator("[data-proposal-review-path]").filter({ hasText: filePath }).first();
}

async function decideProposalFileFromList(page, filePath, decision) {
  const button = proposalFileButton(page, filePath);
  await expect(button).toBeVisible();
  await expect(button).toContainText("Review");
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/api/shared-context/review-files")
  ));
  await button.click({ button: "right" });
  const action = page.getByRole("button", {
    name: decision === "accept" ? "Accept selected" : "Reject selected",
    exact: true,
  });
  await expect(action).toBeVisible();
  await action.click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
  await expect(button).toContainText("Reviewed");
}

async function unreviewProposalFileFromList(page, filePath) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/api/shared-context/unreview-file")
  ));
  await page.getByRole("button", { name: `Unreview ${filePath} and return it to Review` }).click();
  const dialog = page.getByRole("dialog", { name: /Unreview this document/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Unreview", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
  await expect(proposalFileButton(page, filePath)).toContainText("Review");
}

function scopedHostedApiPath(pathname) {
  return String(pathname || "").replace(/^\/reviews\/[^/]+(?=\/api(?:\/|$))/, "");
}

function hostedPathIsForbidden(pathname) {
  const apiPath = scopedHostedApiPath(pathname);
  return HOSTED_FORBIDDEN_API_PREFIXES.some((prefix) => apiPath === prefix || apiPath.startsWith(prefix));
}

function hostedIdentityHeaders(sequence) {
  return {
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "real-workflow-owner",
      role: "admin",
      operations: ["view", "review", "accept", "reject"],
    }, HOSTED_HUMAN_SECRET, { jti: `real-workflow-${process.pid}-${sequence}` }),
  };
}

async function installHostedTransport(page, localOrigin, nextIdentityHeaders) {
  await page.route(`${HOSTED_ORIGIN}/**`, async (route) => {
    const publicUrl = new URL(route.request().url());
    if (publicUrl.pathname.endsWith("/api/runtime-events")) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "retry: 60000\nevent: ready\ndata: {}\n\n",
      });
      return;
    }
    const request = route.request();
    const headers = new Headers(request.headers());
    headers.delete("host");
    headers.delete("content-length");
    headers.set("accept-encoding", "identity");
    headers.set("x-forwarded-host", HOSTED_HOST);
    headers.set("x-forwarded-proto", "https");
    for (const [name, value] of Object.entries(nextIdentityHeaders())) headers.set(name, value);
    const method = request.method();
    const response = await fetch(`${localOrigin}${publicUrl.pathname}${publicUrl.search}`, {
      method,
      headers,
      redirect: "manual",
      ...(["GET", "HEAD"].includes(method) ? {} : { body: request.postDataBuffer() || undefined }),
    });
    const responseHeaders = Object.fromEntries(response.headers.entries());
    delete responseHeaders["content-length"];
    delete responseHeaders["transfer-encoding"];
    if (responseHeaders.location?.startsWith(localOrigin)) {
      responseHeaders.location = HOSTED_ORIGIN + responseHeaders.location.slice(localOrigin.length);
    }
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

test.describe.serial("real proposal workflows", () => {
  test("@smoke global and project-scoped Hub review a mixed proposal and deliver only accepted files", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "The real multi-repository Git workflow runs once on Chromium desktop.");
    test.setTimeout(180_000);

    const data = fixture();
    const runBase = fs.mkdtempSync(path.join(data.base, "real-proposal-global-"));
    const first = createSharedWorkflowFixture(runBase, {
      slug: "global-alpha",
      projectId: "demo",
      projectTitle: "Global Alpha",
      proposalTitle: "Global Alpha mixed review",
      proposalDescription: "Accept, reject, unreview, review again, and deliver the exact fixture result.",
      baselineFiles: {
        "docs/keep.md": "# Keep\n\nAccepted baseline keep.\n",
        "docs/reject.md": "# Reject\n\nAccepted baseline reject.\n",
        "docs/unreview.md": "# Unreview\n\nAccepted baseline unreview.\n",
      },
      proposalFiles: {
        "docs/keep.md": "# Keep\n\nProposal keep must reach main.\n",
        "docs/reject.md": "# Reject\n\nProposal reject must stay out of main.\n",
        "docs/unreview.md": "# Unreview\n\nProposal unreview must reach main after a second decision.\n",
      },
    });
    const second = createSharedWorkflowFixture(runBase, {
      slug: "project-beta",
      projectId: "demo",
      projectTitle: "Project Beta",
      proposalTitle: "Project Beta independent proposal",
      proposalDescription: "Prove that a project-scoped Hub opens the proposal from the other repository.",
      baselineFiles: {
        "docs/README.md": "# Project Beta\n\nAccepted beta baseline.\n",
      },
      proposalFiles: {
        "docs/README.md": "# Project Beta\n\nIndependent beta proposal.\n",
      },
    });
    const registeredProjects = [];
    const registeredRepositories = [];
    let exactPage = null;

    try {
      for (const item of [first, second]) {
        registerContextHubSharedRepository(item.remote);
        registeredRepositories.push(item.remote);
        registeredProjects.push(registerContextHubProject(item.project, {
          title: item.projectTitle,
          shared: { repository: item.remote, projectId: item.projectId },
        }));
      }
      const secondProject = registeredProjects.find((entry) => entry.root === second.project) || registeredProjects[1];

      const hubUrl = `${data.origin}/?hub=1&workspace=real-global-workflow&view=hub`;
      await page.goto(hubUrl);
      await waitForBoot(page);
      await refreshContextHubThroughUi(page);

      await expect(proposalRow(page, first.proposalTitle)).toHaveCount(1);
      await expect(proposalRow(page, second.proposalTitle)).toHaveCount(1);
      const discovered = await page.evaluate((titles) => (
        (state.contextHub?.proposals || [])
          .filter((item) => titles.includes(item.title))
          .map((item) => ({
            title: item.title,
            branch: item.branch,
            repositoryKey: item.repositoryId || item.repository || "",
          }))
      ), [first.proposalTitle, second.proposalTitle]);
      expect(discovered).toHaveLength(2);
      expect(discovered.every((item) => item.repositoryKey)).toBe(true);
      expect(new Set(discovered.map((item) => item.repositoryKey)).size).toBe(2);

      const initialSecondStatus = sharedContextStatus(second.project);
      const initialSecondCurrent = fs.realpathSync(path.join(initialSecondStatus.cacheRoot, "current"));
      expect(initialSecondCurrent).toBe(fs.realpathSync(path.join(initialSecondStatus.cacheRoot, "snapshots", second.mainHead)));
      expectProjectSharedEffects(second.project, second, { revision: second.mainHead });
      const secondM1 = advanceSharedMain(second, "freshness-m1");

      const ambiguousProjectPosts = [];
      const recordAmbiguousProjectPost = (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/context-hub/project") {
          ambiguousProjectPosts.push(request.postDataJSON());
        }
      };
      page.on("request", recordAmbiguousProjectPost);
      const ambiguousProjectUrl = `${data.origin}/?hub=1&workspace=real-ambiguous-workflow&project=demo&view=hub`;
      await page.goto(ambiguousProjectUrl);
      await waitForBoot(page);
      await expect(proposalRow(page, first.proposalTitle)).toHaveCount(1);
      await expect(proposalRow(page, second.proposalTitle)).toHaveCount(1);
      await expect(page.locator("#status")).toContainText("Several projects match");
      await expect(page.locator("#status")).not.toContainText("project index unavailable");
      expect(await page.evaluate(() => ({
        page: state.page,
        activeProjectLocationId: state.activeProjectLocationId,
        globalExplorerProjectKey: state.globalExplorerProjectKey,
        globalExplorerMode: state.globalExplorerMode,
        contextHubView: state.contextHubView,
      }))).toEqual({
        page: "hub",
        activeProjectLocationId: "",
        globalExplorerProjectKey: "",
        globalExplorerMode: "projects",
        contextHubView: "home",
      });
      expect(ambiguousProjectPosts).toEqual([]);
      expect(fs.realpathSync(path.join(initialSecondStatus.cacheRoot, "current"))).toBe(initialSecondCurrent);
      expect(fs.readFileSync(path.join(managedBaselineSkill(second.project), "SKILL.md"), "utf8")).not.toContain(secondM1.marker);
      page.off("request", recordAmbiguousProjectPost);

      const projectHubUrl = `${data.origin}/?hub=1&workspace=real-project-workflow&project=${encodeURIComponent(secondProject.id)}&view=hub`;
      exactPage = await page.context().newPage();
      const exactProjectPosts = [];
      const exactProjectStatuses = [];
      exactPage.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/context-hub/project") {
          exactProjectPosts.push(request.postDataJSON());
        }
      });
      exactPage.on("response", (response) => {
        if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/context-hub/project") {
          exactProjectStatuses.push(response.status());
        }
      });
      await exactPage.goto(projectHubUrl);
      await waitForBoot(exactPage);
      await expect.poll(() => exactProjectPosts.length).toBe(1);
      await expect.poll(() => exactProjectStatuses.length).toBe(1);
      expect(exactProjectPosts).toEqual([{ projectId: secondProject.id }]);
      expect(exactProjectStatuses).toEqual([201]);
      await expectProjectSharedEffectsEventually(second.project, second, secondM1);
      await expect(exactPage.locator("#contextRoomReviewProjectFilter .context-hub-project-trigger-label")).toHaveText(second.projectTitle);
      await expect(proposalRow(exactPage, second.proposalTitle)).toHaveCount(1);
      await expect(proposalRow(exactPage, first.proposalTitle)).toHaveCount(0);

      const secondM2 = advanceSharedMain(second, "freshness-m2");
      await exactPage.reload();
      await waitForBoot(exactPage);
      await expect.poll(() => exactProjectPosts.length).toBe(2);
      await expect.poll(() => exactProjectStatuses.length).toBe(2);
      expect(exactProjectPosts).toEqual([{ projectId: secondProject.id }, { projectId: secondProject.id }]);
      expect(exactProjectStatuses).toEqual([201, 201]);
      await expectProjectSharedEffectsEventually(second.project, second, secondM2);
      await expect(exactPage.locator("#contextRoomReviewProjectFilter .context-hub-project-trigger-label")).toHaveText(second.projectTitle);
      await refreshContextHubThroughUi(exactPage);
      await expect(proposalRow(exactPage, second.proposalTitle)).toHaveCount(1);
      await exactPage.close();

      await page.goto(hubUrl);
      await waitForBoot(page);
      await expect(proposalRow(page, first.proposalTitle)).toHaveCount(1);
      await expect(proposalRow(page, second.proposalTitle)).toHaveCount(1);

      await openProposalFromHub(page, first.proposalTitle);
      await expect(page).toHaveURL((url) => url.origin === new URL(data.origin).origin
        && /^\/reviews\/[^/]+\/?$/.test(url.pathname)
        && url.searchParams.get("view") === "proposal");
      await expect(page.getByRole("heading", { name: first.proposalTitle })).toBeVisible();
      await expect(page.locator("[data-proposal-review-path]")).toHaveCount(3);

      const keepPath = `projects/${first.projectId}/docs/keep.md`;
      const rejectPath = `projects/${first.projectId}/docs/reject.md`;
      const unreviewPath = `projects/${first.projectId}/docs/unreview.md`;
      await decideProposalFileFromList(page, keepPath, "accept");
      await decideProposalFileFromList(page, rejectPath, "reject");
      await decideProposalFileFromList(page, unreviewPath, "accept");
      await unreviewProposalFileFromList(page, unreviewPath);
      await decideProposalFileFromList(page, unreviewPath, "accept");

      const hubReturnStatuses = [];
      const flashConsumePosts = [];
      const recordTerminalReturn = (response) => {
        const url = new URL(response.url());
        if (
          response.request().isNavigationRequest()
          && url.origin === new URL(data.origin).origin
          && url.pathname === "/"
          && url.searchParams.has("crFlash")
        ) hubReturnStatuses.push(response.status());
      };
      const recordFlashConsume = (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/context-hub/flash") {
          flashConsumePosts.push(request.postDataJSON());
        }
      };
      page.on("response", recordTerminalReturn);
      page.on("request", recordFlashConsume);
      await expect(page.getByRole("button", { name: "Accept proposal", exact: true })).toBeEnabled();
      const challengePromise = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/api/shared-context/accept-challenge")
      ));
      await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
      const challengeResponse = await challengePromise;
      expect(challengeResponse.status(), await challengeResponse.text()).toBe(201);
      const dialog = page.getByRole("dialog", { name: /Put this proposal on main/ });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("checkbox").check();
      const acceptancePromise = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/api/shared-context/accept")
      )).then((response) => response.status());
      await dialog.getByRole("button", { name: "Put on main", exact: true }).click();
      expect(await acceptancePromise).toBe(200);

      await expect(page).toHaveURL((url) => url.origin === new URL(data.origin).origin && url.searchParams.get("view") === "hub");
      await waitForBoot(page);
      await expect.poll(() => hubReturnStatuses.length).toBe(1);
      await expect.poll(() => flashConsumePosts.length).toBe(1);
      expect(hubReturnStatuses).toEqual([200]);
      expect(new URL(page.url()).searchParams.has("crFlash")).toBe(false);
      await expect(page.locator('[data-context-room-toast][role="status"]')).toContainText("Proposal merged into main");
      page.off("response", recordTerminalReturn);
      page.off("request", recordFlashConsume);
      await expect(proposalRow(page, first.proposalTitle)).toHaveCount(0);
      await expect(proposalRow(page, second.proposalTitle)).toHaveCount(1);

      git(first.seed, ["fetch", "origin"]);
      const acceptedCommit = git(first.seed, ["rev-parse", "origin/main"]);
      expect(acceptedCommit).toMatch(/^[a-f0-9]{40}$/);
      const acceptedMessage = git(first.seed, ["show", "-s", "--format=%B", acceptedCommit]);
      expect(acceptedMessage).toContain(`Context-Room-Proposal: ${first.proposalBranch}`);
      expect(acceptedMessage).toContain(`Context-Room-Proposal-Head: ${first.proposalHead}`);
      expect(git(first.seed, ["show", `origin/main:${keepPath}`])).toContain("Proposal keep must reach main.");
      expect(git(first.seed, ["show", `origin/main:${rejectPath}`])).toContain("Accepted baseline reject.");
      expect(git(first.seed, ["show", `origin/main:${rejectPath}`])).not.toContain("Proposal reject must stay out of main.");
      expect(git(first.seed, ["show", `origin/main:${unreviewPath}`])).toContain("after a second decision");
      expect(git(first.seed, ["ls-remote", "--heads", "origin", `refs/heads/${first.proposalBranch}`])).toBe("");

      await page.goto(projectHubUrl);
      await waitForBoot(page);
      const finalRefresh = await refreshContextHubThroughUi(page);
      const betaRemoteHead = git(second.seed, ["ls-remote", "--heads", "origin", `refs/heads/${second.proposalBranch}`]).split(/\s+/)[0];
      const betaRepositoryState = listSharedRepositoryProposals(second.remote, { refresh: true, allowOffline: true });
      const betaDirectProposal = betaRepositoryState.proposals.find((proposal) => proposal.branch === second.proposalBranch);
      expect(betaRemoteHead).toBe(second.proposalHead);
      expect(betaDirectProposal?.head).toBe(second.proposalHead);
      await expect(page.locator("#contextRoomReviewProjectFilter .context-hub-project-trigger-label")).toHaveText(second.projectTitle);
      await expect(proposalRow(page, second.proposalTitle), JSON.stringify({
        browser: finalRefresh.browserState,
        refreshResponse: {
          repositoryErrors: finalRefresh.responseBody.repositoryErrors,
          proposalBranches: (finalRefresh.responseBody.proposals || []).map((proposal) => proposal.branch),
        },
        direct: {
          status: betaRepositoryState.status,
          proposalBranches: betaRepositoryState.proposals.map((proposal) => proposal.branch),
          remoteHead: betaRemoteHead,
        },
      }, null, 2)).toHaveCount(1);
      await openProposalFromHub(page, second.proposalTitle);
      await expect(page).toHaveURL((url) => url.origin === new URL(data.origin).origin
        && /^\/reviews\/[^/]+\/?$/.test(url.pathname)
        && url.searchParams.get("view") === "proposal");
      await expect(page.getByRole("heading", { name: second.proposalTitle })).toBeVisible();
      expect(await page.evaluate(() => ({
        proposal: state.sharedContext?.review?.proposal,
        projectId: state.sharedContext?.review?.projectId,
      }))).toEqual({ proposal: second.proposalBranch, projectId: second.projectId });
    } finally {
      try { if (exactPage && !exactPage.isClosed()) await exactPage.close(); } catch {}
      for (const item of [first, second]) {
        try {
          if (readSharedProjectConnection(item.project)) disconnectSharedContext(item.project);
        } catch {}
        try { unregisterContextHubProject(item.project); } catch {}
      }
      for (const repository of registeredRepositories) {
        try { unregisterContextHubSharedRepository(repository); } catch {}
      }
    }
  });

  test("@smoke a direct local project room manages its exact Shared connection and boot refresh effects", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "The real local Settings workflow runs once on Chromium desktop.");
    test.setTimeout(180_000);

    const data = fixture();
    const runBase = fs.mkdtempSync(path.join(data.base, "real-project-settings-"));
    const managed = createSharedWorkflowFixture(runBase, {
      slug: "settings-delta",
      projectId: "settings-delta",
      projectTitle: "Settings Delta",
      proposalTitle: "Settings Delta retained proposal",
      proposalDescription: "Keep a real proposal present while the local project connection is managed independently.",
      baselineFiles: {
        "docs/README.md": "# Settings Delta\n\nAccepted settings baseline.\n",
      },
      proposalFiles: {
        "docs/README.md": "# Settings Delta\n\nRetained proposal remains separate from connection management.\n",
      },
    });
    expect(disconnectSharedContext(managed.project).disconnected).toBe(true);
    expect(readSharedProjectConnection(managed.project)).toBe(null);
    expect(fs.existsSync(managedBaselineSkill(managed.project))).toBe(false);
    const initialConfig = readProjectConfig(managed.project);
    expect(initialConfig.sharedContext).toBeUndefined();
    expect((initialConfig.hubSections || []).some((section) => section.id === "shared-context")).toBe(false);

    const registeredProject = registerContextHubProject(managed.project, { title: managed.projectTitle });
    const room = createMemoryServer({ root: managed.project, registerInHub: false, persistentDocumentGraphLayout: true });
    let localOrigin = "";

    try {
      await new Promise((resolve, reject) => {
        room.server.once("error", reject);
        room.server.listen(0, "127.0.0.1", resolve);
      });
      localOrigin = `http://127.0.0.1:${room.server.address().port}`;
      await page.goto(`${localOrigin}/?workspace=real-local-project-settings`);
      await waitForBoot(page);
      expect(new URL(page.url()).searchParams.has("hub")).toBe(false);
      await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "local");

      let connectionDisclosure = await openProjectSharedSettings(page);
      await expect(connectionDisclosure).toContainText(managed.projectTitle);
      await expect(connectionDisclosure.getByRole("button", { name: "Connect project", exact: true })).toBeVisible();
      expect(readContextHubRegistry().projects.find((entry) => entry.id === registeredProject.id)?.shared || null).toBe(null);

      const addRepositoryResponse = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/context-hub/shared-repositories"
      ));
      await page.locator("#sharedContextRepositoryInput").fill(managed.remote);
      await page.getByRole("button", { name: "Add repository", exact: true }).click();
      const added = await addRepositoryResponse;
      expect([200, 201], await added.text()).toContain(added.status());
      await expect(page.locator('[data-shared-repository]', { hasText: managed.remote })).toContainText("Online");
      const storedManagedRepository = readContextHubRegistry().sharedRepositories.find((entry) => sameFixtureRepository(entry.repository, managed.remote))?.repository;
      expect(storedManagedRepository).toBeTruthy();

      connectionDisclosure = await openProjectSharedSettings(page);
      await expect(connectionDisclosure.locator(".shared-context-connection-project strong")).toHaveText(managed.projectTitle);
      await page.locator("#sharedContextRepositorySelect").selectOption(storedManagedRepository);
      await page.locator("#sharedContextProjectSelect").selectOption(managed.projectId);
      const connectResponse = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/context-hub/project-shared-context"
      ));
      await page.getByRole("button", { name: "Connect project", exact: true }).click();
      const connected = await connectResponse;
      expect(connected.status(), await connected.text()).toBe(200);
      connectionDisclosure = await openProjectSharedSettings(page);
      await expect(connectionDisclosure).toContainText("Connected");
      await expect(connectionDisclosure).toContainText(managed.projectTitle);
      await expect(connectionDisclosure).toContainText(managed.remote);
      expectProjectSharedEffects(managed.project, managed, { revision: managed.mainHead });
      const registeredShared = readContextHubRegistry().projects.find((entry) => entry.id === registeredProject.id)?.shared;
      expect(registeredShared?.projectId).toBe(managed.projectId);
      expect(sameFixtureRepository(registeredShared?.repository, managed.remote)).toBe(true);

      const managedM1 = advanceSharedMain(managed, "settings-m1");
      const localRefreshPosts = [];
      const localRefreshStatuses = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/shared-context/refresh") {
          localRefreshPosts.push(request.postDataJSON());
        }
      });
      page.on("response", (response) => {
        if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/shared-context/refresh") {
          localRefreshStatuses.push(response.status());
        }
      });
      await page.reload();
      await waitForBoot(page);
      await expect.poll(() => localRefreshPosts.length).toBe(1);
      await expect.poll(() => localRefreshStatuses.length).toBe(1);
      expect(localRefreshPosts).toEqual([{}]);
      expect(localRefreshStatuses).toEqual([200]);
      expectProjectSharedEffects(managed.project, managed, managedM1);
      await expect.poll(() => new URL(page.url()).searchParams.has("hub")).toBe(false);

      connectionDisclosure = await openProjectSharedSettings(page);
      const disconnectResponse = page.waitForResponse((response) => (
        response.request().method() === "DELETE"
        && new URL(response.url()).pathname === "/api/context-hub/project-shared-context"
      ));
      await connectionDisclosure.getByRole("button", { name: "Disconnect", exact: true }).click();
      const disconnectDialog = page.getByRole("dialog", { name: new RegExp(`Disconnect ${managed.projectTitle}`) });
      await expect(disconnectDialog).toBeVisible();
      await disconnectDialog.getByRole("button", { name: "Disconnect project", exact: true }).click();
      const disconnected = await disconnectResponse;
      expect(disconnected.status(), await disconnected.text()).toBe(200);
      expect(readSharedProjectConnection(managed.project)).toBe(null);
      expect(fs.existsSync(managedBaselineSkill(managed.project))).toBe(false);
      const disconnectedConfig = readProjectConfig(managed.project);
      expect(disconnectedConfig.sharedContext).toBeUndefined();
      expect((disconnectedConfig.hubSections || []).some((section) => section.id === "shared-context")).toBe(false);
      expect(readContextHubRegistry().projects.find((entry) => entry.id === registeredProject.id)?.shared || null).toBe(null);
      connectionDisclosure = await openProjectSharedSettings(page);
      await expect(connectionDisclosure).toContainText(managed.projectTitle);
      await expect(connectionDisclosure.getByRole("button", { name: "Connect project", exact: true })).toBeVisible();

      const repositoryDisclosure = page.locator('[data-settings-disclosure="project-shared-repositories"]');
      if (!await repositoryDisclosure.evaluate((node) => node.open)) await repositoryDisclosure.locator("summary").click();
      const repositoryRow = page.locator("[data-shared-repository]", { hasText: managed.remote });
      const removeResponse = page.waitForResponse((response) => (
        response.request().method() === "DELETE"
        && new URL(response.url()).pathname === "/api/context-hub/shared-repositories"
      ));
      await repositoryRow.getByRole("button", { name: "Remove", exact: true }).click();
      const removeDialog = page.getByRole("dialog", { name: "Remove shared repository from this device?" });
      await expect(removeDialog).toBeVisible();
      await removeDialog.getByRole("button", { name: "Remove repository", exact: true }).click();
      const removed = await removeResponse;
      expect(removed.status(), await removed.text()).toBe(200);
      expect(readContextHubRegistry().sharedRepositories.some((entry) => sameFixtureRepository(entry.repository, managed.remote))).toBe(false);
      expect(fs.existsSync(managed.remote)).toBe(true);
      git(managed.seed, ["fetch", "origin"]);
      expect(git(managed.seed, ["rev-parse", "origin/main"])).toBe(managedM1.revision);
      expect(git(managed.seed, ["ls-remote", "--heads", "origin", `refs/heads/${managed.proposalBranch}`]).split(/\s+/)[0]).toBe(managed.proposalHead);
    } finally {
      if (room.server.listening) {
        await new Promise((resolve) => {
          room.server.close(resolve);
          room.server.closeAllConnections?.();
        });
      }
      try { if (readSharedProjectConnection(managed.project)) disconnectSharedContext(managed.project); } catch {}
      try { unregisterContextHubProject(managed.project); } catch {}
      try { unregisterContextHubSharedRepository(managed.remote); } catch {}
    }
  });

  test("@smoke hosted Shared-only UI performs real whole-file decisions and fails terminal actions closed without GitHub credentials", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "The real Hosted Git workflow runs once on Chromium desktop.");
    test.setTimeout(180_000);
    testInfo.annotations.push({
      type: "harness-limit",
      description: "Only the infinite runtime-events stream uses the existing finite Playwright heartbeat bridge; catalog, review, unreview, both terminal gates, and Git effects come from the real local Hosted server.",
    });
    testInfo.annotations.push({
      type: "credential-limit",
      description: "No GitHub App credentials are available, so the test proves both remote terminal actions fail closed without mutating Git. Credentialed rejection and acceptance are covered by the dedicated server integration tests.",
    });

    const data = fixture();
    const runBase = fs.mkdtempSync(path.join(data.base, "real-proposal-hosted-"));
    const hosted = createSharedWorkflowFixture(runBase, {
      slug: "hosted-gamma",
      projectId: "hosted-gamma",
      projectTitle: "Hosted Gamma",
      proposalTitle: "Hosted Gamma whole-file review",
      proposalDescription: "Exercise exact Hosted decisions without exposing or mutating local project files.",
      baselineFiles: {
        "docs/keep.md": "# Hosted keep\n\nHosted accepted baseline keep.\n",
        "docs/reject.md": "# Hosted reject\n\nHosted accepted baseline reject.\n",
        "docs/unreview.md": "# Hosted unreview\n\nHosted accepted baseline unreview.\n",
      },
      proposalFiles: {
        "docs/keep.md": "# Hosted keep\n\nHosted proposal keep.\n",
        "docs/reject.md": "# Hosted reject\n\nHosted proposal reject.\n",
        "docs/unreview.md": "# Hosted unreview\n\nHosted proposal unreview.\n",
      },
    });
    const room = createMemoryServer({
      root: hosted.project,
      remoteAccess: {
        expectedHost: HOSTED_HOST,
        humanSecret: HOSTED_HUMAN_SECRET,
        agentSecret: HOSTED_AGENT_SECRET,
        healthSecret: HOSTED_HEALTH_SECRET,
        adminSubjects: ["real-workflow-owner"],
        projectRoots: { [hosted.projectId]: hosted.project },
        sharedRepositories: [{ repository: hosted.remote, projectIds: [hosted.projectId] }],
      },
    });
    let localOrigin = "";
    let identitySequence = 0;
    const nextIdentityHeaders = () => hostedIdentityHeaders(++identitySequence);
    const remoteJson = async (pathname, options = {}) => {
      const response = await fetch(`${localOrigin}${pathname}`, {
        ...options,
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          "x-forwarded-host": HOSTED_HOST,
          "x-forwarded-proto": "https",
          ...nextIdentityHeaders(),
          ...(options.headers || {}),
        },
      });
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBeGreaterThanOrEqual(200);
      expect(response.status, JSON.stringify(payload)).toBeLessThan(300);
      return payload;
    };

    try {
      await new Promise((resolve, reject) => {
        room.server.once("error", reject);
        room.server.listen(0, "127.0.0.1", resolve);
      });
      localOrigin = `http://127.0.0.1:${room.server.address().port}`;
      const warmed = await remoteJson("/api/context-hub/refresh", { method: "POST", body: "{}" });
      expect((warmed.proposals || warmed.items || []).some((item) => item.branch === hosted.proposalBranch)).toBe(true);

      await installHostedTransport(page, localOrigin, nextIdentityHeaders);
      const requests = [];
      page.on("request", (request) => {
        if (!/^https?:/i.test(request.url())) return;
        const url = new URL(request.url());
        requests.push({ method: request.method(), pathname: url.pathname });
      });

      await page.goto(`${HOSTED_ORIGIN}/?hub=1&workspace=real-hosted-workflow&view=hub`);
      await waitForBoot(page);
      await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "hosted-hub");
      await expect(page.locator("#settingsButton")).toBeHidden();
      await expect(page.locator(".app > aside")).toBeHidden();
      await expect(page.locator('[data-settings-disclosure="project-shared-connection"]')).toHaveCount(0);
      await expect(page.locator("[data-connect-shared-context], [data-disconnect-shared-context], #sharedContextRepositoryInput")).toHaveCount(0);
      await expect(proposalRow(page, hosted.proposalTitle)).toHaveCount(1);

      await openProposalFromHub(page, hosted.proposalTitle);
      await expect(page).toHaveURL((url) => /^\/reviews\/[a-f0-9-]{36}\/$/i.test(url.pathname) && url.searchParams.get("view") === "proposal");
      await waitForBoot(page);
      await expect(page.locator("html")).toHaveAttribute("data-context-room-runtime-profile", "hosted-review");
      await expect(page.getByRole("heading", { name: hosted.proposalTitle })).toBeVisible();
      await expect(page.locator("[data-proposal-review-path]")).toHaveCount(3);
      await expect(page.locator("textarea:visible")).toHaveCount(0);
      await expect(page.locator('[data-settings-disclosure="project-shared-connection"]')).toHaveCount(0);
      await expect(page.locator("[data-connect-shared-context], [data-disconnect-shared-context], #sharedContextRepositoryInput")).toHaveCount(0);

      const keepPath = `projects/${hosted.projectId}/docs/keep.md`;
      const rejectPath = `projects/${hosted.projectId}/docs/reject.md`;
      const unreviewPath = `projects/${hosted.projectId}/docs/unreview.md`;
      for (const [filePath, decision] of [[keepPath, "accept"], [rejectPath, "reject"], [unreviewPath, "accept"]]) {
        await proposalFileButton(page, filePath).click();
        await expect(page.locator("[data-hosted-review-file]")).toBeVisible();
        await expect(page.locator("textarea:visible")).toHaveCount(0);
        const decisionResponse = page.waitForResponse((response) => (
          response.request().method() === "POST"
          && new URL(response.url()).pathname.endsWith("/api/shared-context/review-files")
        ));
        await page.getByRole("button", {
          name: decision === "accept" ? "Accept file" : "Reject file",
          exact: true,
        }).click();
        const response = await decisionResponse;
        expect(response.status(), await response.text()).toBe(200);
        await expect(page.locator("#proposalReviewPage")).toBeVisible();
        await expect(proposalFileButton(page, filePath)).toContainText("Reviewed");
      }

      await unreviewProposalFileFromList(page, unreviewPath);
      await proposalFileButton(page, unreviewPath).click();
      await expect(page.locator("[data-hosted-review-file]")).toBeVisible();
      const secondDecisionResponse = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/api/shared-context/review-files")
      ));
      await page.getByRole("button", { name: "Accept file", exact: true }).click();
      const secondDecision = await secondDecisionResponse;
      expect(secondDecision.status(), await secondDecision.text()).toBe(200);
      await expect(page.getByRole("button", { name: "Accept proposal", exact: true })).toBeEnabled();

      const unavailableAcceptance = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/api/shared-context/accept-challenge")
      ));
      await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
      const unavailableResponse = await unavailableAcceptance;
      const unavailablePayload = await unavailableResponse.json();
      expect(unavailableResponse.status(), JSON.stringify(unavailablePayload)).toBe(503);
      expect(unavailablePayload.code).toBe("shared_context_remote_acceptance_unavailable");
      await expect(page.locator('[data-context-room-toast][role="alert"]')).toContainText("temporarily unavailable");
      await expect(page).toHaveURL((url) => (
        url.origin === HOSTED_ORIGIN
        && /^\/reviews\/[a-f0-9-]{36}\/$/i.test(url.pathname)
        && url.searchParams.get("view") === "proposal"
      ));

      const rejectionChallengePromise = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/api/shared-context/reject-challenge")
      ));
      await page.getByRole("button", { name: "Reject proposal", exact: true }).click();
      const rejectionResponse = await rejectionChallengePromise;
      const rejectionPayload = await rejectionResponse.json();
      expect(rejectionResponse.status(), JSON.stringify(rejectionPayload)).toBe(503);
      expect(rejectionPayload.code).toBe("shared_context_remote_rejection_unavailable");
      await expect(page.getByRole("dialog", { name: "Reject this proposal?" })).toBeHidden();
      await expect(page.locator('[data-context-room-toast][role="alert"]')).toContainText("temporarily unavailable");
      await expect(page.locator('[data-context-room-toast][role="alert"]')).toContainText("Retry");
      await expect(page.locator("#proposalReviewTitle")).toHaveText(hosted.proposalTitle);
      await expect(page).toHaveURL((url) => (
        url.origin === HOSTED_ORIGIN
        && /^\/reviews\/[a-f0-9-]{36}\/$/i.test(url.pathname)
        && url.searchParams.get("view") === "proposal"
      ));

      git(hosted.seed, ["fetch", "origin"]);
      const rejectionRef = git(hosted.seed, ["ls-remote", "--heads", "origin", "refs/heads/rejected/*"]);
      expect(rejectionRef).toBe("");
      expect(git(hosted.seed, ["rev-parse", "origin/main"])).toBe(hosted.mainHead);
      expect(git(hosted.seed, ["ls-remote", "--heads", "origin", `refs/heads/${hosted.proposalBranch}`]).split(/\s+/)[0]).toBe(hosted.proposalHead);
      expect(git(hosted.seed, ["show", `origin/main:projects/${hosted.projectId}/docs/keep.md`])).toContain("Hosted accepted baseline keep.");
      expect(requests.filter((request) => hostedPathIsForbidden(request.pathname))).toEqual([]);
    } finally {
      if (room.server.listening) {
        await new Promise((resolve) => {
          room.server.close(resolve);
          room.server.closeAllConnections?.();
        });
      }
    }
  });
});
