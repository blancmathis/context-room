import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  clearContextHubRuntime,
  listContextHubProjects,
  readContextHubRegistry,
  readContextHubAttention,
  readContextHubRuntime,
  readContextHubSnapshot,
  registerContextHubProject,
  registerContextHubSharedRepository,
  removeContextHubReviewSnoozes,
  setContextHubProjectOrder,
  setContextHubReviewSnoozes,
  writeContextHubSnapshot,
  writeContextHubRuntime,
} from "../src/context_hub.mjs";
import {
  createMemoryServer,
  initializeContextRoomProject,
  listProjectExplorerPage,
  readMemoryWebappSettings,
} from "../src/context_room.mjs";

function makeProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), `# ${name}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "hub@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Hub Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  return root;
}

function withHubHome(t, hubHome) {
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
  });
}

test("Context Hub registry keeps local projects and shared repositories independent", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-registry-"));
  withHubHome(t, path.join(base, "hub"));
  const first = makeProject(base, "First project");
  const registered = registerContextHubProject(first);
  registerContextHubSharedRepository("git@github.com:example/shared-context.git");

  const registry = readContextHubRegistry();
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].id, registered.id);
  assert.equal(registry.sharedRepositories.length, 1);
  assert.equal(listContextHubProjects()[0].available, true);
  assert.equal(fs.statSync(path.join(base, "hub")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(base, "hub", "registry.json")).mode & 0o777, 0o600);

  writeContextHubRuntime({ pid: 43210, port: 4319, root: first, url: "https://example.test/not-trusted" });
  assert.equal(readContextHubRuntime().port, 4319);
  assert.equal(readContextHubRuntime().url, "http://127.0.0.1:4319");
  assert.equal(clearContextHubRuntime(43210), true);
  assert.equal(readContextHubRuntime(), null);
});

test("Context Hub snapshot is private, atomic, versioned, and fails closed when corrupted", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-snapshot-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  writeContextHubSnapshot({ projects: [], items: [], summary: { projects: 0 } }, { generatedAt: "2026-07-26T12:00:00.000Z" });
  const snapshotPath = path.join(hubHome, "snapshot.json");
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
  assert.equal(readContextHubSnapshot().generatedAt, "2026-07-26T12:00:00.000Z");
  fs.writeFileSync(snapshotPath, "{broken", "utf8");
  assert.equal(readContextHubSnapshot(), null);
});

test("Context Hub attention keeps project order and exact-version snoozes private and revision-safe", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-attention-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);

  const initial = readContextHubAttention();
  const ordered = setContextHubProjectOrder(["local:important", "shared:team:project"], { expectedRevision: initial.revision });
  assert.deepEqual(ordered.projectOrder, ["local:important", "shared:team:project"]);
  assert.notEqual(ordered.revision, initial.revision);

  const until = new Date(Date.now() + 3_600_000).toISOString();
  const snoozed = setContextHubReviewSnoozes([
    { reviewId: "local:project:file:docs/README.md", revisionToken: "local:current:sha256:abc", until },
    { reviewId: "shared:repo:proposal/example", revisionToken: "shared:def", until },
  ], { expectedRevision: ordered.revision });
  assert.equal(snoozed.snoozes["local:project:file:docs/README.md"].revisionToken, "local:current:sha256:abc");
  assert.equal(snoozed.snoozes["shared:repo:proposal/example"].until, until);
  assert.equal(fs.statSync(path.join(hubHome, "attention.json")).mode & 0o777, 0o600);

  assert.throws(
    () => setContextHubProjectOrder([], { expectedRevision: initial.revision }),
    (error) => error.code === "attention_revision_conflict" && error.statusCode === 409,
  );

  const returned = removeContextHubReviewSnoozes(["local:project:file:docs/README.md"], { expectedRevision: snoozed.revision });
  assert.equal(returned.snoozes["local:project:file:docs/README.md"], undefined);
  assert.ok(returned.snoozes["shared:repo:proposal/example"]);
});

test("progressive project Explorer bounds a 20,000-file folder and searches paths without content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-large-explorer-"));
  const docs = path.join(root, "docs");
  fs.mkdirSync(docs, { recursive: true });
  for (let index = 0; index < 20_000; index += 1) {
    fs.writeFileSync(path.join(docs, `file-${String(index).padStart(5, "0")}.md`), "", "utf8");
  }
  initializeContextRoomProject(root, { title: "Large Explorer", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const first = listProjectExplorerPage(root, { directory: "docs" });
  assert.equal(first.total, 20_000);
  assert.equal(first.entries.length, 250);
  assert.ok(first.entries.every((entry) => typeof entry.name === "string" && entry.name.length > 0));
  assert.equal(first.nextCursor, "250");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 100_000);
  assert.equal(first.entries.every((entry) => !("content" in entry) && !("summary" in entry)), true);
  const second = listProjectExplorerPage(root, { directory: "docs", cursor: first.nextCursor });
  assert.equal(second.entries[0].path, "docs/file-00250.md");
  const search = listProjectExplorerPage(root, { query: "file-00001" });
  assert.deepEqual(search.entries.map((entry) => entry.path), ["docs/file-00001.md"]);
});

test("registered Git worktrees stay distinct locally but appear as one logical project", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-worktrees-"));
  withHubHome(t, path.join(base, "hub"));
  const mainRoot = makeProject(base, "Grouped project");
  const worktreeRoot = path.join(base, "Grouped project agent");
  execFileSync("git", ["worktree", "add", "-b", "agent/grouped-project", worktreeRoot], { cwd: mainRoot, stdio: "ignore" });
  if (!fs.existsSync(path.join(worktreeRoot, ".context-room", "config.json"))) {
    fs.cpSync(path.join(mainRoot, ".context-room"), path.join(worktreeRoot, ".context-room"), { recursive: true });
  }
  fs.appendFileSync(path.join(worktreeRoot, "docs", "README.md"), "\nChanged in the agent worktree.\n", "utf8");

  const main = registerContextHubProject(mainRoot);
  const agent = registerContextHubProject(worktreeRoot);
  assert.notEqual(main.id, agent.id);
  assert.equal(main.logicalProjectId, agent.logicalProjectId);
  assert.equal(readContextHubRegistry().projects.length, 2);

  const room = createMemoryServer({ root: mainRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const hub = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(hub.summary.localProjects, 1);
  assert.equal(hub.summary.localWorktrees, 2);
  const project = hub.projects.find((item) => item.logicalProjectId === main.logicalProjectId);
  assert.equal(project.worktreeCount, 2);
  assert.deepEqual(new Set(project.worktrees.map((worktree) => worktree.id)), new Set([main.id, agent.id]));
  assert.equal(project.localReviews.some((review) => review.worktreeId === agent.id && review.worktreeLabel === "agent/grouped-project"), true);

  const html = await (await fetch(origin + "/")).text();
  assert.match(html, /id="singleProjectWorktreeSwitch"/);
  assert.match(html, /function contextHubWorktreeSelectorMarkup\(/);
  assert.match(html, /data-global-project-worktree/);
  assert.match(html, /data-single-project-worktree/);
  assert.match(html, /context-hub-worktree-count/);
});

test("Context Room Home combines global review queues without nesting another Home", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-api-"));
  withHubHome(t, path.join(base, "hub"));
  const first = makeProject(base, "First project");
  const second = makeProject(base, "Second project");
  fs.appendFileSync(path.join(second, "docs", "README.md"), "\nNeeds review.\n", "utf8");
  fs.writeFileSync(path.join(second, "docs", "SECOND.md"), "# Second file\n", "utf8");
  fs.writeFileSync(
    path.join(second, ".context-room", "review-state.json"),
    JSON.stringify({
      version: 1,
      reviews: {
        "docs/README.md": {
          status: "verified",
          reviewedAt: "2026-07-24T12:00:00.000Z",
          resourceState: "present",
        },
      },
    }, null, 2) + "\n",
    "utf8",
  );
  const firstEntry = registerContextHubProject(first);
  const secondEntry = registerContextHubProject(second);

  const room = createMemoryServer({ root: first });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const rootPage = await fetch(origin + "/");
  assert.equal(rootPage.headers.get("content-security-policy"), "frame-ancestors 'self'");
  const rootHtml = await rootPage.text();
  assert.match(rootHtml, /class="context-room-brand"/);
  assert.doesNotMatch(rootHtml, /data-context-room-view=/);
  assert.doesNotMatch(rootHtml, /contextRoomReviewHistory|Review history|contextHubHistoryItems|localReviewHistory/);
  assert.match(rootHtml, /id="contextHubManageProjects"[^>]*>Manage projects…</);
  assert.match(rootHtml, /id="openCodexPromptCenter"/);
  assert.ok(rootHtml.indexOf("Review queue") < rootHtml.indexOf("<h2>Context health</h2>"));
  assert.doesNotMatch(rootHtml, /Your sections/);
  assert.doesNotMatch(rootHtml, /id="contextHubHome"/);
  assert.doesNotMatch(rootHtml, /id="contextHubHomeProjectFrame"/);
  assert.doesNotMatch(rootHtml, /context-room-project-home-height/);
  assert.doesNotMatch(rootHtml, /body\.context-hub-project-embed/);
  assert.match(rootHtml, /id="contextHubProjectPicker"/);
  assert.match(rootHtml, /id="contextHubProjectPickerSearch"/);
  assert.match(rootHtml, /data-context-hub-project-picker-trigger="room-home"/);
  assert.match(rootHtml, /id="contextRoomReviewSourceFilter"/);
  assert.match(rootHtml, /id="contextRoomReviewSearch"/);
  assert.match(rootHtml, /data-context-room-review/);
  assert.match(rootHtml, /class="context-room-review-proposal/);
  assert.match(rootHtml, /class="context-room-proposal-hitbox"/);
  assert.match(rootHtml, /context-room-proposal-hitbox[^\n]+data-context-room-review=/);
  assert.match(rootHtml, /data-context-room-proposal-description=/);
  assert.match(rootHtml, /data-context-room-proposal-description-toggle=/);
  assert.match(rootHtml, /function syncContextRoomProposalDescriptionToggles\(\)/);
  assert.ok(rootHtml.indexOf("const descriptionToggle = event.target.closest") < rootHtml.indexOf("const selectionEntry = event.target.closest"));
  assert.doesNotMatch(rootHtml, /data-context-room-proposal-toggle/);
  assert.match(rootHtml, /id="contextRoomReviewSelection"/);
  assert.match(rootHtml, /id="contextRoomReviewContextMenu"/);
  assert.match(rootHtml, /data-context-room-review-entry=/);
  assert.match(rootHtml, /addEventListener\("contextmenu"/);
  assert.match(rootHtml, /data-context-room-selection-toggle=/);
  assert.match(rootHtml, /state\.contextRoomSelectedReviews\.size > 0 && selectionEntry/);
  assert.match(rootHtml, /function toggleContextRoomReviewSelection\(item\)/);
  assert.doesNotMatch(rootHtml, /data-context-room-select=/);
  assert.match(rootHtml, /data-context-room-reject-selected/);
  assert.doesNotMatch(rootHtml, /data-context-room-review-visibility="snoozed"/);
  assert.match(rootHtml, /data-context-room-snooze-open=/);
  assert.match(rootHtml, /data-context-room-snooze-selected/);
  assert.match(rootHtml, /data-context-room-snooze-preset="1h"/);
  assert.match(rootHtml, /data-context-room-snooze-duration/);
  assert.match(rootHtml, /data-context-room-snooze-time/);
  assert.match(rootHtml, /Only the versions currently shown are hidden/);
  assert.match(rootHtml, /id: "review-snoozed"/);
  assert.match(rootHtml, /id="settingsSnoozedReviewSearch"/);
  assert.match(rootHtml, /data-settings-unsnooze-review=/);
  assert.match(rootHtml, /data-global-context-snooze-reviews/);
  assert.match(rootHtml, /data-context-snooze-reviews/);
  assert.match(rootHtml, /function contextRoomReviewSnooze\(item\)/);
  assert.match(rootHtml, /snooze\.revisionToken !== item\.revisionToken/);
  assert.match(rootHtml, /data-global-context-priority="top"/);
  assert.match(rootHtml, /title: "Project priority"/);
  assert.doesNotMatch(rootHtml, /data-context-room-reject-proposal/);
  assert.match(rootHtml, /\/api\/context-hub\/reject/);
  assert.match(rootHtml, /exact Git revision stays archived on a rejected branch/);
  assert.match(rootHtml, /Local files stay atomic\. Shared changes stay grouped by proposal\./);
  assert.match(rootHtml, /function buildContextRoomModeCodexPrompt/);
  assert.match(rootHtml, /data-context-room-mode-prompt="shared"/);
  assert.match(rootHtml, /Two review flows are active for/);
  assert.match(rootHtml, /state\.contextHubSource = "all"/);
  assert.match(rootHtml, /function contextRoomReviewPriority/);
  assert.match(rootHtml, /function renderContextRoomGlobalReviewQueue/);
  assert.match(rootHtml, /CONTEXT_HUB_HOME_REVIEW_LIMIT = 80/);
  assert.match(rootHtml, /id="sharedProposalProjectFilter"[^>]+aria-haspopup="dialog"/);
  assert.match(rootHtml, /function renderContextHubProjectPicker/);
  assert.match(rootHtml, /contextHubProjectPickerQuery = event\.target\.value/);
  assert.match(rootHtml, /state\.activeProjectLocationId = IS_GLOBAL_CONTEXT_ROOM/);
  assert.match(rootHtml, /x-context-room-target-project/);
  assert.match(rootHtml, /target\.searchParams\.set\("hub", "1"\)/);
  assert.doesNotMatch(rootHtml, /state\.contextHubView = "review"/);
  const hubResponse = await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  });
  assert.equal(hubResponse.status, 200);
  const hub = await hubResponse.json();
  assert.equal(hub.summary.localProjects, 2);
  assert.equal(hub.projects.some((project) => project.id === firstEntry.id && project.current), true);
  assert.equal(hub.items.some((item) => item.type === "local" && item.projectId === secondEntry.id && item.reviewStatus === "local_changes" && item.fileCount === 2), true);
  const secondProject = hub.projects.find((project) => project.id === secondEntry.id);
  assert.deepEqual(secondProject.localReviewFiles.sort(), ["docs/README.md", "docs/SECOND.md"]);
  assert.deepEqual(secondProject.localReviews.map((review) => review.path).sort(), ["docs/README.md", "docs/SECOND.md"]);
  assert.equal("localReviewHistory" in secondProject, false);
  assert.equal("reviewHistory" in hub.summary, false);
  const secondLocalItem = hub.items.find((item) => item.type === "local" && item.projectId === secondEntry.id);
  assert.deepEqual(secondLocalItem.reviews.map((review) => review.path).sort(), ["docs/README.md", "docs/SECOND.md"]);
  const snoozeReview = secondLocalItem.reviews.find((review) => review.path === "docs/SECOND.md");
  const snoozeId = `${secondLocalItem.id}:worktree:${snoozeReview.worktreeId || secondLocalItem.projectId}:file:${snoozeReview.path}`;
  const snoozeToken = `local:${snoozeReview.resourceState}:${snoozeReview.resourceVersion || "-"}:${snoozeReview.currentHash}`;
  const snoozeResponse = await fetch(origin + "/api/context-hub/reviews/snooze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({
      until: new Date(Date.now() + 3_600_000).toISOString(),
      expectedRevision: hub.attention.revision,
      items: [{ id: snoozeId, revisionToken: snoozeToken }],
    }),
  });
  const snoozeResult = await snoozeResponse.json();
  assert.equal(snoozeResponse.status, 200, JSON.stringify(snoozeResult));
  assert.equal(snoozeResult.attention.snoozes[snoozeId].revisionToken, snoozeToken);
  const staleSnooze = await fetch(origin + "/api/context-hub/reviews/snooze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({
      until: new Date(Date.now() + 3_600_000).toISOString(),
      expectedRevision: snoozeResult.attention.revision,
      items: [{ id: snoozeId, revisionToken: snoozeToken + ":stale" }],
    }),
  });
  assert.equal(staleSnooze.status, 409);
  assert.equal((await staleSnooze.json()).code, "review_revision_conflict");
  const unsnoozeResponse = await fetch(origin + "/api/context-hub/reviews/unsnooze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ reviewIds: [snoozeId], expectedRevision: snoozeResult.attention.revision }),
  });
  assert.equal(unsnoozeResponse.status, 200);
  assert.equal((await unsnoozeResponse.json()).attention.snoozes[snoozeId], undefined);
  assert.ok(secondProject.hubSections.length > 0);
  assert.ok(secondProject.hubSections.flatMap((section) => section.cards).some((card) => card.paths.length > 0));

  const catalogResponse = await fetch(origin + "/api/context-hub/catalog");
  assert.equal(catalogResponse.status, 200);
  assert.match(catalogResponse.headers.get("server-timing") || "", /catalog;dur=/);
  const catalog = await catalogResponse.json();
  assert.equal("localReviews" in catalog.projects[0], false);
  assert.equal("hubSections" in catalog.projects[0], false);
  const reviewPage = await (await fetch(origin + "/api/context-hub/review-queue?limit=1")).json();
  assert.equal(reviewPage.items.length, 1);
  assert.ok(reviewPage.nextCursor);
  const sectionsPage = await (await fetch(origin + "/api/context-hub/sections")).json();
  assert.equal(sectionsPage.projects.some((project) => project.projectKey === secondProject.projectKey && project.hubSections.length > 0), true);

  fs.writeFileSync(path.join(second, "docs", "THIRD.md"), "# Third file\n", "utf8");
  const cachedHub = await (await fetch(origin + "/api/context-hub")).json();
  assert.equal(cachedHub.items.find((item) => item.type === "local" && item.projectId === secondEntry.id).fileCount, 2);
  const refreshedHub = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(refreshedHub.items.find((item) => item.type === "local" && item.projectId === secondEntry.id).fileCount, 3);

  const rejectedLocal = await fetch(origin + "/api/context-hub/reject", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ items: [{ id: `local:${secondEntry.id}:file:docs/SECOND.md` }] }),
  });
  assert.equal(rejectedLocal.status, 200);
  const rejectedLocalResult = await rejectedLocal.json();
  assert.equal(rejectedLocalResult.summary.localReviews, 1);
  const hubAfterRejection = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(
    hubAfterRejection.projects.find((project) => project.id === secondEntry.id)
      .localReviews.find((review) => review.path === "docs/SECOND.md").reviewStatus,
    "needs_changes",
  );

  const openedResponse = await fetch(origin + "/api/context-hub/project", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ projectId: secondEntry.id }),
  });
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  assert.equal(opened.current, true);
  assert.equal(opened.url, origin);
  const projectFilesResponse = await fetch(origin + "/api/files", {
    headers: {
      "x-context-room-project": room.projectId,
      "x-context-room-target-project": secondEntry.id,
    },
  });
  assert.equal(projectFilesResponse.status, 200);
  assert.equal(projectFilesResponse.headers.get("x-context-room-target-project"), secondEntry.id);
  const projectFiles = await projectFilesResponse.json();
  assert.equal(fs.realpathSync(projectFiles.root), fs.realpathSync(second));
  assert.ok(projectFiles.files.some((file) => file.path === "docs/SECOND.md"));
});

test("global Explorer context actions stay scoped to the selected local project", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-explorer-actions-"));
  withHubHome(t, path.join(base, "hub"));
  const hostRoot = makeProject(base, "Host project");
  const targetRoot = makeProject(base, "Target project");
  const target = registerContextHubProject(targetRoot);
  registerContextHubProject(hostRoot);
  const room = createMemoryServer({ root: hostRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const request = (body) => fetch(origin + "/api/context-hub/project-explorer/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ projectId: target.id, ...body }),
  });

  const createFolderResponse = await request({ action: "create-folder", path: "docs/context-menu" });
  assert.equal(createFolderResponse.status, 200);
  assert.equal(fs.existsSync(path.join(targetRoot, "docs", "context-menu")), true);
  assert.equal(fs.existsSync(path.join(hostRoot, "docs", "context-menu")), false);

  const createFileResponse = await request({ action: "create-markdown", path: "docs/context-menu/notes.md", title: "Notes" });
  assert.equal(createFileResponse.status, 200);
  assert.equal(fs.existsSync(path.join(targetRoot, "docs", "context-menu", "notes.md")), true);

  const rootExplorerResponse = await fetch(origin + "/api/context-hub/project-explorer?projectId=" + encodeURIComponent(target.id));
  assert.equal(rootExplorerResponse.status, 200);
  assert.match(rootExplorerResponse.headers.get("server-timing") || "", /explorer;dur=/);
  const rootExplorer = await rootExplorerResponse.json();
  assert.equal(rootExplorer.mode, "directory");
  assert.equal(rootExplorer.entries.some((entry) => entry.type === "directory" && entry.path === "docs"), true);
  assert.equal(rootExplorer.entries.some((entry) => entry.path === "docs/README.md"), false);
  assert.equal("content" in rootExplorer.entries[0], false);

  const docsExplorer = await (await fetch(origin + "/api/context-hub/project-explorer?projectId=" + encodeURIComponent(target.id) + "&path=docs")).json();
  assert.equal(docsExplorer.entries.some((entry) => entry.path === "docs/README.md"), true);
  assert.equal(docsExplorer.entries.some((entry) => entry.path === "docs/context-menu" && entry.hasChildren), true);

  const settingsResponse = await fetch(origin + "/api/context-hub/project-settings?projectId=" + encodeURIComponent(target.id));
  const settingsText = await settingsResponse.text();
  assert.equal(settingsResponse.status, 200, settingsText);
  assert.match(settingsResponse.headers.get("etag") || "", /^"[a-f0-9]+"$/);
  assert.ok(Buffer.byteLength(settingsText) < 50_000);
  const settingsPayload = JSON.parse(settingsText);
  assert.equal("hubSections" in settingsPayload, false);
  assert.ok(settingsPayload.revision);
  const notModified = await fetch(origin + "/api/context-hub/project-settings?projectId=" + encodeURIComponent(target.id), {
    headers: { "if-none-match": settingsResponse.headers.get("etag") },
  });
  assert.equal(notModified.status, 304);
  const staleSave = await fetch(origin + "/api/context-hub/project-settings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ projectId: target.id, expectedRevision: "stale", settings: settingsPayload.settings }),
  });
  assert.equal(staleSave.status, 409);

  const watchResponse = await request({ action: "watch-folder", path: "docs/context-menu", mode: "recursive-live" });
  assert.equal(watchResponse.status, 200);
  assert.equal(readMemoryWebappSettings(targetRoot).watchRules.some((rule) => rule.path.replace(/\/$/, "") === "docs/context-menu"), true);

  const inspectionResponse = await fetch(origin + "/api/context-hub/project-inspection?projectId=" + encodeURIComponent(target.id));
  assert.equal(inspectionResponse.status, 200);
  const inspection = await inspectionResponse.json();
  assert.equal(inspection.project.id, target.id);
  assert.equal(fs.realpathSync(inspection.project.root), fs.realpathSync(targetRoot));
  assert.ok(Array.isArray(inspection.doctor.issues));
  assert.ok(Array.isArray(inspection.startupContext));
  assert.ok(Array.isArray(inspection.startupSkills));
  assert.ok(Array.isArray(inspection.startupHooks));
});

test("Context Room keeps a 150-project registry complete in the live picker while the review queue stays bounded", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-many-projects-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const activeRoot = makeProject(base, "Active project");
  const active = registerContextHubProject(activeRoot);
  const registry = readContextHubRegistry();
  const projects = [
    active,
    ...Array.from({ length: 149 }, (_, index) => ({
      root: path.join(base, "archived", `Project ${String(index + 1).padStart(3, "0")}`),
      title: `Project ${String(index + 1).padStart(3, "0")}`,
      registeredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      lastOpenedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      shared: null,
    })),
  ];
  fs.writeFileSync(
    path.join(hubHome, "registry.json"),
    JSON.stringify({ ...registry, projects }, null, 2) + "\n",
    "utf8",
  );

  assert.equal(listContextHubProjects().length, 150);
  assert.equal(listContextHubProjects()[0].available, true);

  const room = createMemoryServer({ root: activeRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const hub = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(hub.summary.localProjects, 150);
  assert.equal(hub.projects.filter((project) => project.mode !== "shared").length, 150);
  assert.ok(hub.projects.length >= 150);

  const html = await (await fetch(origin + "/")).text();
  assert.match(html, /visibleReviews = renderedReviews\.slice\(0, CONTEXT_HUB_HOME_REVIEW_LIMIT\)/);
  assert.match(html, /choices: needle \? projects : \[null, \.\.\.projects\]/);
  assert.match(html, /contextHubProjectPickerQuery = event\.target\.value/);
});
