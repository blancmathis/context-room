import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";

import {
  initializeContextRoomProject,
  writeDocReviewDecision,
} from "../../src/context_room.mjs";
import {
  registerContextHubProject,
  unregisterContextHubProject,
  unregisterContextHubSharedRepository,
} from "../../src/context_hub.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  materializeSharedReview,
  publishSharedProposal,
} from "../../src/shared_context.mjs";

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

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function configureGit(root) {
  git(root, ["config", "user.email", "proposal-acceptance-e2e@example.test"]);
  git(root, ["config", "user.name", "Context Room acceptance E2E"]);
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting/);
  await expect.poll(async () => {
    const diagnostics = await page.locator("body").getAttribute("data-workspace-diagnostics");
    return JSON.parse(diagnostics || "{}").phase || "";
  }).toBe("ready");
}

async function activeProposalCount(page) {
  const metric = page.locator("#reviewSummary .review-summary-item").filter({
    has: page.locator("span", { hasText: /^proposals?$/ }),
  });
  await expect(metric).toHaveCount(1);
  return Number.parseInt((await metric.locator("strong").textContent()) || "0", 10);
}

test("@smoke verified real-server acceptance removes the proposal from active Hub state and preserves its proof branch", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "The real Git delivery path only needs one browser execution.");

  const data = fixture();
  const projectId = "acceptance-e2e";
  const proposalTitle = "Verified acceptance leaves active Hub state";
  const proposalBranch = `proposal/${projectId}/verified-hub-removal`;
  const project = path.join(data.base, "Acceptance-E2E");
  const remote = path.join(data.base, "acceptance-e2e.git");
  let canonicalRemote = remote;
  const seed = path.join(data.base, "acceptance-e2e-seed");
  let registered = false;

  try {
    git(data.base, ["init", "--bare", "--initial-branch=main", remote]);
    canonicalRemote = fs.realpathSync(remote);
    git(data.base, ["clone", remote, seed]);
    configureGit(seed);
    initializeSharedRepository(seed, { name: "Acceptance E2E Shared Context" });
    write(seed, "projects.json", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, title: "Acceptance E2E" }],
    }, null, 2) + "\n");
    write(seed, `projects/${projectId}/docs/README.md`, "# Acceptance E2E\n\nAccepted baseline.\n");
    write(
      seed,
      `projects/${projectId}/skills/baseline/SKILL.md`,
      "---\nname: baseline\ndescription: Keep the complete project scope present in the Git fixture.\n---\n\n# Baseline\n",
    );
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "Initialize acceptance E2E shared context"]);
    git(seed, ["push", "origin", "main"]);

    fs.mkdirSync(project, { recursive: true });
    git(project, ["init", "--initial-branch=main"]);
    configureGit(project);
    initializeContextRoomProject(project, {
      title: "Acceptance E2E",
      allowedPaths: ["docs/"],
      watchAllow: ["docs/"],
    });
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "Initialize acceptance E2E project"]);
    connectSharedContext(project, { repository: canonicalRemote, projectId });

    const proposal = createSharedProposal(project, {
      title: proposalTitle,
      description: "Prove verified delivery, active queue removal, counters, and retained Git evidence.",
      branch: proposalBranch,
    });
    configureGit(proposal.root);
    write(
      proposal.root,
      `projects/${projectId}/docs/README.md`,
      "# Acceptance E2E\n\nAccepted baseline plus the verified proposal.\n",
    );
    const published = publishSharedProposal(project, { proposal: proposal.branch });

    const review = materializeSharedReview(project, {
      proposal: proposal.branch,
      expectedHead: published.head,
    });
    initializeContextRoomProject(review.reviewRoot, {
      title: `Review · ${proposal.branch}`,
      allowedPaths: [`projects/${projectId}/`],
      watchAllow: [`projects/${projectId}/`],
    });
    writeDocReviewDecision(review.reviewRoot, `projects/${projectId}/docs/README.md`, {
      status: "verified",
      note: "Reviewed in the isolated real-server E2E fixture",
    });

    registerContextHubProject(project, {
      title: "Acceptance E2E",
      shared: { repository: canonicalRemote, projectId },
    });
    registered = true;

    await page.goto(`${data.origin}/?hub=1&view=hub`);
    await waitForBoot(page);
    await page.evaluate(async () => {
      await refreshContextHubUi();
    });

    const proposalRow = page.locator("[data-context-room-review-entry]", { hasText: proposalTitle });
    await expect(proposalRow).toHaveCount(1);
    const proposalsBefore = await activeProposalCount(page);
    const activeStateBefore = await page.evaluate(({ repository, sharedProjectId, branch }) => {
      const projectState = state.contextHub.projects.find((item) => (
        item.shared?.repository === repository && item.shared?.projectId === sharedProjectId
      ));
      return {
        proposalPresent: state.contextHub.proposals.some((item) => item.branch === branch),
        summaryProposals: Number(state.contextHub.summary?.proposals || 0),
        projectProposalCount: Number(projectState?.sharedProposalCount || 0),
      };
    }, { repository: canonicalRemote, sharedProjectId: projectId, branch: proposal.branch });
    expect(activeStateBefore).toEqual({
      proposalPresent: true,
      summaryProposals: proposalsBefore,
      projectProposalCount: 1,
    });

    const hubOrigin = new URL(data.origin).origin;
    await proposalRow.getByRole("button", { name: `Open proposal ${proposalTitle}` }).click();
    await expect(page).toHaveURL((url) => url.origin !== hubOrigin && url.searchParams.get("view") === "proposal");
    await waitForBoot(page);

    const acceptResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/shared-context/accept"
    ));
    await page.getByRole("button", { name: "Put on main", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /Put this proposal on main\?/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Put on main", exact: true }).click();

    const acceptResponse = await acceptResponsePromise;
    expect(acceptResponse.status()).toBe(200);

    await expect(page).toHaveURL((url) => url.origin === hubOrigin && url.searchParams.get("view") === "hub");
    await waitForBoot(page);
    git(seed, ["fetch", "origin"]);
    const acceptedCommit = git(seed, ["rev-parse", "origin/main"]);
    expect(acceptedCommit).toMatch(/^[a-f0-9]{40}$/);
    const acceptedMessage = git(seed, ["show", "-s", "--format=%B", acceptedCommit]);
    expect(acceptedMessage).toContain(`Context-Room-Proposal: ${proposal.branch}`);
    expect(acceptedMessage).toContain(`Context-Room-Proposal-Head: ${published.head}`);
    const toast = page.locator('[data-context-room-toast][role="status"]');
    await expect(toast).toContainText(/(?:Proposal merged into main|Merged into main · Hub refresh pending)/);
    await expect(toast).toContainText(acceptedCommit);
    await expect(page.locator("[data-context-room-review-entry]", { hasText: proposalTitle })).toHaveCount(0);
    await expect.poll(() => activeProposalCount(page)).toBe(proposalsBefore - 1);

    const activeStateAfter = await page.evaluate(({ repository, sharedProjectId, branch }) => {
      const projectState = state.contextHub.projects.find((item) => (
        item.shared?.repository === repository && item.shared?.projectId === sharedProjectId
      ));
      return {
        proposalPresent: state.contextHub.proposals.some((item) => item.branch === branch),
        itemPresent: state.contextHub.items.some((item) => item.type === "shared" && item.branch === branch),
        summaryProposals: Number(state.contextHub.summary?.proposals || 0),
        projectProposalCount: Number(projectState?.sharedProposalCount || 0),
      };
    }, { repository: canonicalRemote, sharedProjectId: projectId, branch: proposal.branch });
    expect(activeStateAfter).toEqual({
      proposalPresent: false,
      itemPresent: false,
      summaryProposals: proposalsBefore - 1,
      projectProposalCount: 0,
    });

    expect(git(seed, ["show", `origin/main:projects/${projectId}/docs/README.md`])).toContain("verified proposal");
    expect(spawnSync("git", ["merge-base", "--is-ancestor", acceptedCommit, "origin/main"], { cwd: seed }).status).toBe(0);
    expect(git(seed, ["ls-remote", "--heads", "origin", `refs/heads/${proposal.branch}`]).split(/\s+/)[0]).toBe(published.head);
  } finally {
    if (registered) unregisterContextHubProject(project);
    try { unregisterContextHubSharedRepository(canonicalRemote); } catch {}
    if (page.url().startsWith(data.origin)) {
      await page.evaluate(async () => {
        await refreshContextHubUi();
      }).catch(() => {});
    }
  }
});
