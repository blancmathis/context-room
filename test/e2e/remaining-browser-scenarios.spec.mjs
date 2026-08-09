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
  publishSharedProposal,
  readSharedProjectConnection,
} from "../../src/shared_context.mjs";

const HOSTED_HOST = "context.qm.peerlab.fr";
const HOSTED_ORIGIN = `https://${HOSTED_HOST}`;
const HOSTED_HUMAN_SECRET = "remaining-browser-human-secret-with-more-than-32-bytes";
const HOSTED_AGENT_SECRET = "remaining-browser-agent-secret-with-more-than-32-bytes";
const HOSTED_HEALTH_SECRET = "remaining-browser-health-secret-with-more-than-32-bytes";

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
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function canonicalPath(value) {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(String(value || "")); }
}

function browserEvidencePath(name) {
  const directory = path.join(process.cwd(), "test-results", "final-browser-evidence");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

function readJsonArtifact(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function hubSharedTransactionArtifacts(data) {
  const directory = path.join(data.home, ".context-room", "hub", "shared-transactions");
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJsonArtifact(path.join(directory, entry.name)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function projectSharedConfigArtifact(root) {
  const config = readJsonArtifact(path.join(root, ".context-room", "config.json"));
  if (!config) return null;
  return {
    sharedContext: config.sharedContext || null,
    allowedPaths: config.allowedPaths || [],
    readOnlyPaths: config.readOnlyPaths || [],
    hubSectionIds: (config.hubSections || []).map((section) => section.id),
  };
}

function createSharedRepositoryFixture(base, { slug, projectId, projectTitle }) {
  const remote = path.join(base, `${slug}.git`);
  const seed = path.join(base, `${slug}-seed`);

  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed, `${slug}-seed`);
  initializeSharedRepository(seed, { name: `${projectTitle} Shared Context` });
  write(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: projectId, title: projectTitle }],
  }, null, 2) + "\n");
  write(seed, `projects/${projectId}/docs/README.md`, `# ${projectTitle}\n\nAccepted browser baseline.\n`);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", `Initialize ${projectTitle} shared context`]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed, projectId, projectTitle };
}

function createSharedBrowserFixture(base, { slug, projectId, projectTitle, proposalTitle }) {
  const shared = createSharedRepositoryFixture(base, { slug, projectId, projectTitle });
  const project = path.join(base, `${slug}-project`);
  const proposalBranch = `proposal/${projectId}/${slug}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;

  fs.mkdirSync(project, { recursive: true });
  git(project, ["init", "--initial-branch=main"]);
  configureGit(project, `${slug}-project`);
  write(project, "docs/README.md", `# ${projectTitle}\n\nLocal browser fixture.\n`);
  initializeContextRoomProject(project, {
    title: projectTitle,
    allowedPaths: ["docs/"],
    watchAllow: ["docs/"],
  });
  git(project, ["add", "."]);
  git(project, ["commit", "-m", `Initialize ${projectTitle} local project`]);
  connectSharedContext(project, { repository: shared.remote, projectId: shared.projectId });

  const proposal = createSharedProposal(project, {
    title: proposalTitle,
    description: `Keep ${shared.projectTitle} visible in the real browser matrix.`,
    branch: proposalBranch,
  });
  configureGit(proposal.root, `${slug}-proposal`);
  write(
    proposal.root,
    `projects/${shared.projectId}/docs/README.md`,
    `# ${shared.projectTitle}\n\nProposed browser update for ${proposalTitle}.\n`,
  );
  const published = publishSharedProposal(project, { proposal: proposal.branch });
  return {
    ...shared,
    project,
    proposalTitle,
    proposalBranch: proposal.branch,
    proposalHead: published.head,
  };
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => {
    const diagnostics = JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}");
    return diagnostics.phase || "";
  }).toBe("ready");
}

async function refreshHubFixture(data) {
  const response = await fetch(`${data.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text);
}

async function openProjectManagerFromHome(page) {
  if (await page.locator("#sharedProposalWorkspaceHeading").getByText("Manage projects", { exact: true }).isVisible()) return;
  await expect(page.locator("#home")).toBeVisible();
  await page.locator("#contextRoomReviewProjectFilter").click();
  const picker = page.locator("#contextHubProjectPicker");
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Manage projects…", exact: true }).click();
  await expect(page.locator("#sharedProposalWorkspaceHeading")).toHaveText("Manage projects");
  await expect(page.locator("#contextHubCreateProject")).toBeVisible();
}

async function selectManagedProject(page, title) {
  const card = page.locator("[data-context-hub-item]", { hasText: title }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator("#sharedProposalOverviewTitle")).toHaveText(title);
  return card;
}

async function openSelectedProjectSharedSettings(page) {
  if (!await page.locator("#settingsPage").isVisible()) {
    if (await page.locator("#sharedProposalWorkspace").isVisible()) {
      await page.locator("#sharedProposalWorkspaceClose").click();
    }
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

async function openExplorerIfNeeded(page) {
  const app = page.locator(".app");
  const aside = page.locator(".app > aside");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) {
    await page.locator("#explorerOpen").click();
    await expect(app).not.toHaveClass(/sidebar-collapsed/);
    await expect(aside).toBeVisible();
  }
}

function chromiumUserMatrix(testInfo) {
  return ["chromium-desktop", "chromium-mobile"].includes(testInfo.project.name);
}

test.describe("remaining real browser user matrix", () => {
  test("@layout project modals isolate both workspaces and cancelled creation ignores its late response", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "One desktop browser proves the shared modal boundary and cancellation lifecycle.");
    const data = fixture();
    await page.goto(`${data.origin}/?hub=1&view=hub`);
    await waitForBoot(page);
    await openProjectManagerFromHome(page);

    const app = page.locator(".app");
    const workspace = page.locator("#sharedProposalWorkspace");
    const projectPickerTrigger = page.locator("#sharedProposalProjectFilter");
    const initialIsolation = await page.evaluate(() => ({
      appInert: document.querySelector(".app")?.getAttribute("inert") ?? null,
      appAriaHidden: document.querySelector(".app")?.getAttribute("aria-hidden") ?? null,
      workspaceInert: document.getElementById("sharedProposalWorkspace")?.getAttribute("inert") ?? null,
      workspaceAriaHidden: document.getElementById("sharedProposalWorkspace")?.getAttribute("aria-hidden") ?? null,
    }));

    await projectPickerTrigger.click();
    await expect(page.locator("#contextHubProjectPicker")).toBeVisible();
    await expect(app).toHaveAttribute("inert", "");
    await expect(app).toHaveAttribute("aria-hidden", "true");
    await expect(workspace).toHaveAttribute("inert", "");
    await expect(workspace).toHaveAttribute("aria-hidden", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#contextHubProjectPicker")).toBeHidden();
    await expect.poll(() => page.evaluate(() => ({
      appInert: document.querySelector(".app")?.getAttribute("inert") ?? null,
      appAriaHidden: document.querySelector(".app")?.getAttribute("aria-hidden") ?? null,
      workspaceInert: document.getElementById("sharedProposalWorkspace")?.getAttribute("inert") ?? null,
      workspaceAriaHidden: document.getElementById("sharedProposalWorkspace")?.getAttribute("aria-hidden") ?? null,
    }))).toEqual(initialIsolation);
    await expect(projectPickerTrigger).toBeFocused();

    const lateProjectId = `cancelled-${randomUUID()}`;
    const lateCatalog = await page.evaluate(() => structuredClone(state.contextHub));
    lateCatalog.projects = [...(lateCatalog.projects || []), {
      id: lateProjectId,
      projectKey: `local:${lateProjectId}`,
      title: "Cancelled late project",
      mode: "local",
      worktrees: [],
    }];
    let markStarted;
    let releaseResponse;
    let markFinished;
    const requestStarted = new Promise((resolve) => { markStarted = resolve; });
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    const handlerFinished = new Promise((resolve) => { markFinished = resolve; });
    const creationHandler = async (route) => {
      markStarted();
      await responseGate;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ catalog: lateCatalog, project: { id: lateProjectId } }),
        });
      } catch {
        // The browser can discard the intercepted route immediately after AbortController cancels fetch.
      } finally {
        markFinished();
      }
    };
    await page.route("**/api/context-hub/projects", creationHandler);

    const createButton = page.locator("#contextHubCreateProject");
    await createButton.click();
    const dialog = page.locator(".confirm-backdrop");
    await expect(dialog).toBeVisible();
    await expect(app).toHaveAttribute("inert", "");
    await expect(workspace).toHaveAttribute("inert", "");
    await dialog.locator('[name="title"]').fill("Cancelled late project");
    await dialog.locator('[name="folderName"]').fill(lateProjectId);
    await dialog.locator("[data-creation-submit]").click();
    await requestStarted;
    await expect(dialog.locator("[data-creation-cancel]")).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(createButton).toBeFocused();
    await expect.poll(() => page.evaluate(() => state.contextHubCreationController)).toBeNull();
    releaseResponse();
    await handlerFinished;
    await expect.poll(() => page.evaluate((id) => (
      (state.contextHub?.projects || []).some((project) => project.id === id)
    ), lateProjectId)).toBe(false);
    await expect.poll(() => page.evaluate(() => ({
      appInert: document.querySelector(".app")?.getAttribute("inert") ?? null,
      appAriaHidden: document.querySelector(".app")?.getAttribute("aria-hidden") ?? null,
      workspaceInert: document.getElementById("sharedProposalWorkspace")?.getAttribute("inert") ?? null,
      workspaceAriaHidden: document.getElementById("sharedProposalWorkspace")?.getAttribute("aria-hidden") ?? null,
    }))).toEqual(initialIsolation);
    await page.unroute("**/api/context-hub/projects", creationHandler);
  });

  test("@smoke Home project manager creates a real local project and keeps it after reload", async ({ page }, testInfo) => {
    test.skip(!chromiumUserMatrix(testInfo), "The real creation path is required on Chromium desktop and mobile.");
    test.setTimeout(120_000);
    const data = fixture();
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
    const title = `Created ${suffix}`;
    const folderName = `created-${suffix}`;
    const createdRoot = path.join(data.home, folderName);

    try {
      await page.goto(`${data.origin}/?hub=1&workspace=create-${suffix}&view=hub`);
      await waitForBoot(page);
      await openProjectManagerFromHome(page);
      await page.locator("#contextHubCreateProject").click();
      const dialog = page.getByRole("dialog", { name: "Create a project" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Project name").fill(title);
      await dialog.getByLabel("Folder name").fill(folderName);
      await dialog.getByLabel("Parent folder").fill(data.home);
      const creation = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/context-hub/projects"
      ));
      await dialog.getByRole("button", { name: "Create project", exact: true }).click();
      const response = await creation;
      expect(response.status(), await response.text()).toBe(201);
      const creationPayload = await response.json();
      expect(canonicalPath(creationPayload.projectRoot)).toBe(canonicalPath(createdRoot));
      expect(canonicalPath(creationPayload.project?.root || "")).toBe(canonicalPath(createdRoot));
      await expect(dialog).toHaveCount(0);
      expect(fs.existsSync(path.join(createdRoot, ".context-room", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(createdRoot, "docs"))).toBe(true);
      await expect(page.locator("[data-context-hub-item]", { hasText: title }).first()).toBeVisible();

      await page.reload();
      await waitForBoot(page);
      await openProjectManagerFromHome(page);
      await expect(page.locator("[data-context-hub-item]", { hasText: title }).first()).toBeVisible();
      const persistedCatalog = await page.request.get(`${data.origin}/api/context-hub/catalog`);
      expect(persistedCatalog.status(), await persistedCatalog.text()).toBe(200);
      expect((await persistedCatalog.json()).projects.some((project) => (
        canonicalPath(project.root || project.worktrees?.[0]?.root || "") === canonicalPath(createdRoot)
      ))).toBe(true);
    } finally {
      try { unregisterContextHubProject(createdRoot); } catch {}
    }
  });

  test("@smoke Home creates a Shared-project proposal in the explicitly selected repository and nowhere else", async ({ page }, testInfo) => {
    test.skip(!chromiumUserMatrix(testInfo), "The real local Shared-project creation path is required on Chromium desktop and mobile.");
    test.setTimeout(180_000);
    const data = fixture();
    const runBase = fs.mkdtempSync(path.join(data.base, "remaining-shared-project-"));
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`;
    const target = createSharedRepositoryFixture(runBase, {
      slug: `target-${suffix}`,
      projectId: `existing-target-${suffix}`,
      projectTitle: `Target repository ${suffix}`,
    });
    const decoy = createSharedRepositoryFixture(runBase, {
      slug: `decoy-${suffix}`,
      projectId: `existing-decoy-${suffix}`,
      projectTitle: `Decoy repository ${suffix}`,
    });
    for (const item of [target, decoy]) registerContextHubSharedRepository(item.remote);
    const targetMainBefore = git(target.remote, ["rev-parse", "refs/heads/main"]);
    const decoyMainBefore = git(decoy.remote, ["rev-parse", "refs/heads/main"]);
    const projectId = `browser-shared-${suffix}`;
    const title = `Browser Shared ${suffix}`;
    const description = `Create ${title} in the exact selected Shared repository without creating a local folder.`;

    try {
      await refreshHubFixture(data);
      await page.goto(`${data.origin}/?hub=1&workspace=shared-project-${suffix}&view=hub`);
      await waitForBoot(page);
      await openProjectManagerFromHome(page);
      const createButton = page.locator("#contextHubCreateSharedProject");
      await expect(createButton).toBeVisible();
      await createButton.click();
      const dialog = page.getByRole("dialog", { name: "Create a shared project" });
      await expect(dialog).toBeVisible();
      const repositorySelect = dialog.locator('[name="repository"]');
      const repositoryRecords = await page.evaluate(() => (
        (state.contextHub?.sharedRepositories || []).map((repository) => ({
          repository: repository.repository,
          name: repository.name,
          online: repository.status?.online,
        }))
      ));
      const targetRecord = repositoryRecords.find((repository) => (
        canonicalPath(repository.repository) === canonicalPath(target.remote)
      ));
      const decoyRecord = repositoryRecords.find((repository) => (
        canonicalPath(repository.repository) === canonicalPath(decoy.remote)
      ));
      expect(targetRecord, JSON.stringify(repositoryRecords, null, 2)).toBeTruthy();
      expect(decoyRecord, JSON.stringify(repositoryRecords, null, 2)).toBeTruthy();
      expect(targetRecord.online).toBe(true);
      expect(decoyRecord.online).toBe(true);
      await expect(repositorySelect.locator("option")).toHaveCount(repositoryRecords.length);
      await repositorySelect.selectOption(targetRecord.repository);
      await dialog.locator('[name="projectId"]').fill(projectId);
      await dialog.locator('[name="title"]').fill(title);
      await dialog.locator('[name="path"]').fill("overview.md");
      await dialog.locator('[name="description"]').fill(description);
      const creation = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/context-hub/shared-projects"
      ));
      await dialog.getByRole("button", { name: "Create proposal", exact: true }).click();
      const response = await creation;
      const responseText = await response.text();
      expect(response.status(), responseText).toBe(201);
      const created = JSON.parse(responseText);
      expect(created.projectId).toBe(projectId);
      expect(created.projectTitle).toBe(title);
      expect(canonicalPath(created.repository)).toBe(canonicalPath(target.remote));
      expect(created.repositoryPath).toBe(`projects/${projectId}/docs/overview.md`);
      expect(created.proposal?.branch).toMatch(new RegExp(`^proposal/${projectId}/`));
      expect(created.proposal?.head).toMatch(/^[a-f0-9]{40}$/);
      await expect(dialog).toHaveCount(0);

      expect(git(target.remote, ["rev-parse", "refs/heads/main"])).toBe(targetMainBefore);
      expect(git(decoy.remote, ["rev-parse", "refs/heads/main"])).toBe(decoyMainBefore);
      const targetCatalog = JSON.parse(git(target.remote, ["show", "refs/heads/main:projects.json"]));
      const decoyCatalog = JSON.parse(git(decoy.remote, ["show", "refs/heads/main:projects.json"]));
      expect(targetCatalog.projects.some((project) => project.id === projectId)).toBe(false);
      expect(decoyCatalog.projects.some((project) => project.id === projectId)).toBe(false);
      const proposedCatalog = JSON.parse(git(target.remote, ["show", `${created.proposal.head}:projects.json`]));
      expect(proposedCatalog.projects).toContainEqual({ id: projectId, title });
      expect(git(target.remote, ["show", `${created.proposal.head}:${created.repositoryPath}`])).toContain(`# ${title}`);
      expect(git(decoy.seed, ["ls-remote", "--heads", "origin", created.proposal.branch])).toBe("");
      expect(fs.existsSync(path.join(data.home, projectId))).toBe(false);

      await expect.poll(() => page.evaluate(({ expectedId, expectedHead }) => (
        (state.contextHub?.proposals || []).filter((proposal) => (
          proposal.createsProject === true
          && proposal.projectId === expectedId
          && proposal.head === expectedHead
        )).length
      ), { expectedId: projectId, expectedHead: created.proposal.head })).toBe(1);
      await expect(page.locator("[data-context-room-review-entry]", { hasText: `Add ${title}` })).toHaveCount(1);

      await page.reload();
      await waitForBoot(page);
      await expect(page.locator("[data-context-room-review-entry]", { hasText: `Add ${title}` })).toHaveCount(1);
    } finally {
      for (const item of [target, decoy]) {
        try { unregisterContextHubSharedRepository(item.remote); } catch {}
      }
    }
  });

  test("@smoke global Home selects the exact local project and connects then disconnects the right Shared repository", async ({ page }, testInfo) => {
    test.skip(!chromiumUserMatrix(testInfo), "The real multi-Shared connection path is required on Chromium desktop and mobile.");
    test.setTimeout(180_000);
    const data = fixture();
    const runBase = fs.mkdtempSync(path.join(data.base, "remaining-connect-"));
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`;
    const target = createSharedBrowserFixture(runBase, {
      slug: `right-${suffix}`,
      projectId: `right-${suffix}`,
      projectTitle: `Right Shared ${suffix}`,
      proposalTitle: `Right proposal ${suffix}`,
    });
    const decoy = createSharedBrowserFixture(runBase, {
      slug: `decoy-${suffix}`,
      projectId: `decoy-${suffix}`,
      projectTitle: `Decoy Shared ${suffix}`,
      proposalTitle: `Decoy proposal ${suffix}`,
    });
    disconnectSharedContext(target.project);
    const registered = registerContextHubProject(target.project, { title: target.projectTitle });
    registerContextHubSharedRepository(target.remote);
    registerContextHubSharedRepository(decoy.remote);

    try {
      await refreshHubFixture(data);
      await page.goto(`${data.origin}/?hub=1&workspace=connect-${suffix}&view=hub`);
      await waitForBoot(page);
      await openProjectManagerFromHome(page);
      await selectManagedProject(page, target.projectTitle);
      const opening = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/context-hub/project"
      ));
      await page.locator("#sharedProposalOpenReview").getByText("Select this project", { exact: true }).click();
      const opened = await opening;
      expect(opened.status(), await opened.text()).toBe(201);
      await expect.poll(() => page.evaluate(() => state.activeProjectLocationId)).toBe(registered.id);

      let disclosure = await openSelectedProjectSharedSettings(page);
      await expect(disclosure.locator(".shared-context-connection-project strong")).toHaveText(target.projectTitle);
      const repositorySelect = disclosure.locator("#sharedContextRepositorySelect");
      const repositoryOptions = await repositorySelect.locator("option").allTextContents();
      const repositoryDiagnostics = await page.evaluate(() => ({
        repositories: (state.contextHub?.sharedRepositories || []).map((repository) => ({
          name: repository.name,
          repository: repository.repository,
          availability: repository.availability,
          status: repository.status,
          error: repository.error,
          projectIds: (repository.projects || []).map((project) => project.id),
        })),
        repositoryErrors: state.contextHub?.repositoryErrors || [],
      }));
      expect(repositoryOptions.some((label) => label.includes(target.projectTitle)), JSON.stringify(repositoryDiagnostics, null, 2)).toBe(true);
      expect(repositoryOptions.some((label) => label.includes(decoy.projectTitle)), JSON.stringify(repositoryDiagnostics, null, 2)).toBe(true);
      const targetRepositoryOption = repositorySelect.locator("option", { hasText: target.projectTitle });
      const targetRepositoryValue = await targetRepositoryOption.getAttribute("value");
      expect(targetRepositoryValue).toBeTruthy();
      await repositorySelect.selectOption(targetRepositoryValue);
      const projectSelect = disclosure.locator("#sharedContextProjectSelect");
      await expect(projectSelect.locator(`option[value="${target.projectId}"]`)).toHaveText(target.projectTitle);
      await projectSelect.selectOption(target.projectId);
      const connecting = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/context-hub/project-shared-context"
      ));
      await disclosure.getByRole("button", { name: "Connect project", exact: true }).click();
      const connectedResponse = await connecting;
      const connectedResponseText = await connectedResponse.text();
      const connectionDiagnostics = connectedResponse.status() === 200 ? null : {
        response: connectedResponseText,
        hubRegistry: readJsonArtifact(path.join(data.home, ".context-room", "hub", "registry.json")),
        hubSharedTransactions: hubSharedTransactionArtifacts(data),
        sharedRegistry: readJsonArtifact(path.join(data.home, ".context-room", "shared", "registry.json")),
        projectConfig: projectSharedConfigArtifact(target.project),
        projectConnection: readSharedProjectConnection(target.project),
      };
      expect(connectedResponse.status(), JSON.stringify(connectionDiagnostics, null, 2)).toBe(200);
      const connection = readSharedProjectConnection(target.project);
      expect(connection?.projectId).toBe(target.projectId);
      expect(canonicalPath(connection?.projectRoot)).toBe(canonicalPath(target.project));
      expect(canonicalPath(connection?.repository)).toBe(canonicalPath(target.remote));

      disclosure = await openSelectedProjectSharedSettings(page);
      await expect(disclosure).toContainText("Connected");
      await expect(disclosure).toContainText(target.projectTitle);
      await expect(disclosure).not.toContainText(decoy.projectTitle);
      const disconnecting = page.waitForResponse((response) => (
        response.request().method() === "DELETE"
        && new URL(response.url()).pathname === "/api/context-hub/project-shared-context"
      ));
      await disclosure.getByRole("button", { name: "Disconnect", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: new RegExp(`Disconnect ${target.projectTitle}`) });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Disconnect project", exact: true }).click();
      const disconnectedResponse = await disconnecting;
      expect(disconnectedResponse.status(), await disconnectedResponse.text()).toBe(200);
      expect(readSharedProjectConnection(target.project)).toBe(null);
      disclosure = await openSelectedProjectSharedSettings(page);
      await expect(disclosure.getByRole("button", { name: "Connect project", exact: true })).toBeVisible();
    } finally {
      for (const item of [target, decoy]) {
        try { if (readSharedProjectConnection(item.project)) disconnectSharedContext(item.project); } catch {}
        try { unregisterContextHubProject(item.project); } catch {}
      }
      for (const item of [target, decoy]) {
        try { unregisterContextHubSharedRepository(item.remote); } catch {}
      }
    }
  });

  test("@smoke one cached-offline Shared warns visibly without hiding another repository's online proposal", async ({ page }, testInfo) => {
    test.skip(!chromiumUserMatrix(testInfo), "The partial-offline multi-Shared path is required on Chromium desktop and mobile.");
    test.setTimeout(180_000);
    const data = fixture();
    const runBase = fs.mkdtempSync(path.join(data.base, "remaining-offline-"));
    const suffix = `${testInfo.project.name.replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`;
    const online = createSharedBrowserFixture(runBase, {
      slug: `online-${suffix}`,
      projectId: `online-${suffix}`,
      projectTitle: `Online Shared ${suffix}`,
      proposalTitle: `Online proposal stays visible ${suffix}`,
    });
    const offline = createSharedBrowserFixture(runBase, {
      slug: `offline-${suffix}`,
      projectId: `offline-${suffix}`,
      projectTitle: `Offline Shared ${suffix}`,
      proposalTitle: `Offline cached proposal ${suffix}`,
    });
    for (const item of [online, offline]) {
      registerContextHubSharedRepository(item.remote);
      registerContextHubProject(item.project, {
        title: item.projectTitle,
        shared: { repository: item.remote, projectId: item.projectId },
      });
    }
    const offlineRemote = `${offline.remote}.unavailable`;

    try {
      await refreshHubFixture(data);
      fs.renameSync(offline.remote, offlineRemote);
      await refreshHubFixture(data);
      await page.goto(`${data.origin}/?hub=1&workspace=offline-${suffix}&view=hub`);
      await waitForBoot(page);
      const warning = page.locator(".review-status-unconfirmed");
      await expect(warning).toBeVisible();
      await expect(warning).toContainText(/Some Shared repositories could not be checked|Review coverage is not current/);
      const onlineProposal = page.locator("[data-context-room-review-entry]", { hasText: online.proposalTitle });
      const offlineProposal = page.locator("[data-context-room-review-entry]", { hasText: offline.proposalTitle });
      await expect(onlineProposal).toHaveCount(1);
      await expect(offlineProposal).toHaveCount(1);
      await expect(onlineProposal).toBeVisible();
      await expect(offlineProposal).toBeVisible();
      await page.screenshot({
        path: browserEvidencePath(`global-home-multi-shared-${testInfo.project.name}.png`),
        fullPage: true,
      });

      await openExplorerIfNeeded(page);
      const offlineProject = page.locator("[data-global-project-key]", { hasText: offline.projectTitle }).first();
      await expect(offlineProject).toBeVisible();
      await expect(offlineProject).toContainText("Offline · cached snapshot");
      await expect(onlineProposal).toBeVisible();
      await expect(warning).toBeVisible();
      const browserState = await page.evaluate((titles) => ({
        repositories: (state.contextHub?.sharedRepositories || []).map((repository) => ({
          name: repository.name,
          online: repository.status?.online,
          revision: repository.status?.revision,
        })),
        proposals: (state.contextHub?.proposals || []).filter((proposal) => titles.includes(proposal.title)).map((proposal) => proposal.title),
      }), [online.proposalTitle, offline.proposalTitle]);
      expect(browserState.repositories.some((repository) => repository.online === true)).toBe(true);
      expect(browserState.repositories.some((repository) => repository.online === false && /^[a-f0-9]{40}$/.test(repository.revision))).toBe(true);
      expect(browserState.proposals).toEqual(expect.arrayContaining([online.proposalTitle, offline.proposalTitle]));
    } finally {
      if (fs.existsSync(offlineRemote) && !fs.existsSync(offline.remote)) fs.renameSync(offlineRemote, offline.remote);
      for (const item of [online, offline]) {
        try { if (readSharedProjectConnection(item.project)) disconnectSharedContext(item.project); } catch {}
        try { unregisterContextHubProject(item.project); } catch {}
        try { unregisterContextHubSharedRepository(item.remote); } catch {}
      }
    }
  });
});

async function installHostedTransport(page, localOrigin, identityHeaders) {
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
    for (const [name, value] of Object.entries(identityHeaders())) headers.set(name, value);
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

test("@smoke Hosted follows the system light theme and computes reduced-motion styles", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const data = fixture();
  const room = createMemoryServer({
    root: data.projects.atlas.root,
    registerInHub: false,
    remoteAccess: {
      expectedHost: HOSTED_HOST,
      humanSecret: HOSTED_HUMAN_SECRET,
      agentSecret: HOSTED_AGENT_SECRET,
      healthSecret: HOSTED_HEALTH_SECRET,
      adminSubjects: ["remaining-browser-owner"],
      projectRoots: { atlas: data.projects.atlas.root },
      sharedRepositories: [{ repository: data.shared.remote, projectIds: ["atlas"] }],
    },
  });
  let localOrigin = "";
  let sequence = 0;
  const identityHeaders = () => ({
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "remaining-browser-owner",
      role: "admin",
      operations: ["view", "review", "accept", "reject"],
    }, HOSTED_HUMAN_SECRET, { jti: `remaining-browser-${testInfo.project.name}-${process.pid}-${++sequence}` }),
  });

  try {
    await new Promise((resolve, reject) => {
      room.server.once("error", reject);
      room.server.listen(0, "127.0.0.1", resolve);
    });
    localOrigin = `http://127.0.0.1:${room.server.address().port}`;
    const warmResponse = await fetch(`${localOrigin}/api/context-hub/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": HOSTED_HOST,
        "x-forwarded-proto": "https",
        ...identityHeaders(),
      },
      body: "{}",
    });
    const warmResponseText = await warmResponse.text();
    expect(warmResponse.status, warmResponseText).toBe(200);
    await installHostedTransport(page, localOrigin, identityHeaders);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${HOSTED_ORIGIN}/?hub=1&workspace=hosted-theme-${testInfo.project.name}&view=hub`);
    await waitForBoot(page);

    const lightContract = await page.evaluate(() => {
      const cssTimeToMilliseconds = (value) => {
        const text = String(value || "").trim();
        const numeric = Number.parseFloat(text) || 0;
        return text.endsWith("ms") ? numeric : numeric * 1_000;
      };
      const root = getComputedStyle(document.documentElement);
      const indicator = getComputedStyle(document.querySelector(".boot-indicator"));
      const visibleTransitionMilliseconds = [...document.querySelectorAll("button")]
        .filter((button) => button.getClientRects().length)
        .flatMap((button) => getComputedStyle(button).transitionDuration.split(",").map(cssTimeToMilliseconds));
      return {
        profile: document.documentElement.dataset.contextRoomRuntimeProfile,
        fileTheme: document.documentElement.dataset.fileTheme,
        preference: document.documentElement.dataset.colorPreference,
        mode: document.documentElement.dataset.colorMode,
        lightMedia: matchMedia("(prefers-color-scheme: light)").matches,
        reducedMotionMedia: matchMedia("(prefers-reduced-motion: reduce)").matches,
        colorScheme: root.colorScheme,
        background: root.getPropertyValue("--bg").trim(),
        panel: root.getPropertyValue("--panel").trim(),
        indicatorAnimation: indicator.animationName,
        indicatorDurationMilliseconds: cssTimeToMilliseconds(indicator.animationDuration),
        visibleTransitionMilliseconds,
      };
    });
    expect(lightContract).toMatchObject({
      profile: "hosted-hub",
      fileTheme: "context-room",
      preference: "system",
      mode: "light",
      lightMedia: true,
      reducedMotionMedia: true,
      colorScheme: "light",
      background: "#f7f8f6",
      panel: "#ffffff",
      indicatorAnimation: "none",
    });
    expect(lightContract.indicatorDurationMilliseconds).toBeLessThanOrEqual(0.02);
    expect(
      lightContract.visibleTransitionMilliseconds.every((duration) => duration <= 0.02),
      JSON.stringify(lightContract.visibleTransitionMilliseconds),
    ).toBe(true);
    if (testInfo.project.name === "chromium-desktop") {
      await page.screenshot({
        path: browserEvidencePath("hosted-shared-only-system-light.png"),
        fullPage: true,
      });
    }

    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").getAttribute("data-color-mode")).toBe("dark");
    await expect(page.locator("html")).toHaveAttribute("data-color-preference", "system");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").getAttribute("data-color-mode")).toBe("light");
  } finally {
    if (room.server.listening) {
      await new Promise((resolve) => {
        room.server.close(resolve);
        room.server.closeAllConnections?.();
      });
    }
    await room.waitForShutdown?.();
  }
});
