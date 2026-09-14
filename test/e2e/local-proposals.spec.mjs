import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function checkDialogAccessibility(page) {
  const result = await new AxeBuilder({ page }).include('dialog[open]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
}

for (const ambiguous of [false, true]) test(`@smoke a newer Hub snapshot ${ambiguous ? "preserves an ambiguous project warning" : "renders the Explorer"} when the initial catalogue was superseded`, async ({ page }) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hub-render-ui-"));
  const previous = {};
  for (const key of ["CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"]) {
    previous[key] = process.env[key]; process.env[key] = path.join(base, key);
  }
  const { initializeContextRoomProject, createMemoryServer } = await import("../../src/context_room.mjs");
  const { registerContextHubProject } = await import("../../src/context_hub.mjs");
  const root = path.join(base, "project"); fs.mkdirSync(root);
  initializeContextRoomProject(root, { title: "Catalogue race" });
  registerContextHubProject(root, { title: "Catalogue race" });
  if (ambiguous) {
    const second = path.join(base, "second-project"); fs.mkdirSync(second);
    initializeContextRoomProject(second, { title: "Catalogue race" });
    registerContextHubProject(second, { title: "Catalogue race" });
  }
  const runtime = createMemoryServer({ root });
  await new Promise(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${runtime.server.address().port}/?hub=1&view=hub&explorer=expanded`);
    const row = page.locator(".global-project-row", { hasText: "Catalogue race" });
    await expect(row).toHaveCount(ambiguous ? 2 : 1);
    await expect(row.first()).toBeVisible();
    await page.evaluate(async (ambiguous) => {
      stopWorkspaceRuntime();
      await Promise.allSettled([state.contextHubReadyPromise, state.runtimeContextHubRefreshPromise].filter(Boolean));
      const catalog = structuredClone(state.contextHub);
      if (ambiguous) {
        const url = new URL(location.href); url.searchParams.set("project", "Catalogue race");
        history.replaceState(history.state, "", url);
        state.activeProjectLocationId = "Catalogue race";
        state.globalExplorerMode = "projects";
        state.globalExplorerProjectKey = "";
        document.body.classList.add("app-booting");
        setStatus("ready");
      }
      state.contextHub = null;
      renderGlobalProjectExplorer();
      const initialTicket = beginContextHubSnapshotRequest();
      const newerTicket = beginContextHubSnapshotRequest();
      await applyInitialContextHubWhenReady(Promise.resolve({ contextHub: catalog, ticket: newerTicket }));
      await applyInitialContextHubWhenReady(Promise.resolve({ contextHub: { ...catalog, projects: [] }, ticket: initialTicket }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      document.body.classList.remove("app-booting");
    }, ambiguous);
    await expect(row.first()).toBeVisible();
    await expect(page.locator("#globalProjectCount")).not.toHaveText("Loading…");
    if (ambiguous) {
      await expect(page.locator("#status")).toContainText("Several projects match");
      expect(await page.evaluate(() => ({ active: state.activeProjectLocationId, selected: state.globalExplorerProjectKey }))).toEqual({ active: "", selected: "" });
    }
  } finally {
    if (!page.isClosed()) await page.goto("about:blank");
    await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); });
    await runtime.waitForShutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("@smoke local proposal review accepts a correction and rejects rendered HTML without changing it", async ({ page }, testInfo) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-local-proposal-ui-"));
  const previousHub = process.env.CONTEXT_ROOM_HUB_HOME;
  const previousShared = process.env.CONTEXT_ROOM_SHARED_HOME;
  const previousAuthority = process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(parent, "hub");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(parent, "shared");
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = path.join(parent, "authority");
  const { initializeContextRoomProject, writeMemoryWebappSettings, writeDocReviewDecision,
    createLocalDocumentationProposal, submitLocalDocumentationProposal, createMemoryServer } = await import("../../src/context_room.mjs");
  const { registerContextHubProject } = await import("../../src/context_hub.mjs");
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Project guide\n\nAccepted guidance.\n");
  fs.writeFileSync(path.join(root, "docs/overview.html"), "<h1>Accepted overview</h1><p>This page is already reviewed.</p>");
  const png = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 160; const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 240, 160); return canvas.toDataURL("image/png").split(",")[1]; });
  fs.writeFileSync(path.join(root, "docs/drawing.png"), Buffer.from(png, "base64"));
  initializeContextRoomProject(root, { title: "Local review", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  writeDocReviewDecision(root, "docs/guide.md", { status: "verified" });
  writeDocReviewDecision(root, "docs/overview.html", { status: "verified" });
  const proposal = createLocalDocumentationProposal(root, { title: "Clarify the onboarding documents" });
  fs.writeFileSync(path.join(proposal.editRoot, "docs/guide.md"), "# Project guide\n\nProposed guidance.\n");
  fs.writeFileSync(path.join(proposal.editRoot, "docs/overview.html"), "<h1>Proposed overview</h1><p>Check the new wording.</p>");
  fs.writeFileSync(path.join(proposal.editRoot, "docs/zdiagram.mmd"), "flowchart LR\n  A[Agent] --> H[Human review]\n  H --> D[Accepted document]\n");
  submitLocalDocumentationProposal(root, proposal.id);
  registerContextHubProject(root, { title: "Local review" });
  const { server, waitForShutdown } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin + "/?view=hub");
    const row = page.locator('[data-context-room-review^="local-proposal:"]').filter({ hasText: proposal.title });
    await expect(row).toBeVisible({ timeout: 45000 });
    await row.click();
    const dialog = page.getByRole("dialog", { name: proposal.title });
    const editor = dialog.getByRole("textbox", { name: "Proposed content: docs/guide.md" });
    await expect(editor).toHaveValue(/Proposed guidance/);
    await editor.fill("# Project guide\n\nHuman clarified guidance.\n");
    await checkDialogAccessibility(page);
    await page.screenshot({ path: testInfo.outputPath("local-review-correction.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Save and accept file" }).click();
    await expect.poll(() => fs.readFileSync(path.join(root, "docs/guide.md"), "utf8")).toContain("Human clarified guidance");
    await expect(dialog.locator("iframe")).toHaveCount(2);
    await expect(dialog.locator("textarea")).toHaveCount(0);
    await expect(dialog.frameLocator('iframe[title="Proposed: docs/overview.html"]').getByRole("heading", { name: "Proposed overview" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("local-review-html.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Reject file" }).click();
    const diagramEditor = dialog.getByRole("textbox", { name: "Proposed content: docs/zdiagram.mmd" });
    await expect(diagramEditor).toBeVisible();
    await expect(dialog.getByLabel("Proposed diagram").locator("svg")).toBeVisible();
    await diagramEditor.fill("flowchart LR\n  A[Draft] --> H[Human decision]\n  H --> D[Accepted]\n");
    await expect(dialog.getByLabel("Proposed diagram")).toContainText("Human decision");
    const diagramBox = await dialog.getByLabel("Proposed diagram").locator("svg").boundingBox();
    const footerBox = await dialog.locator("footer").boundingBox();
    expect(diagramBox.y + diagramBox.height).toBeLessThan(footerBox.y);
    await page.screenshot({ path: testInfo.outputPath("local-review-mermaid.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Save and accept file" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(fs.readFileSync(path.join(root, "docs/overview.html"), "utf8")).toContain("Accepted overview");
    const asset = page.locator('[data-context-room-review^="local-asset:"]').filter({ hasText: "docs/drawing.png" });
    await expect(asset).toBeVisible(); await asset.click();
    const imageReview = page.getByRole("dialog", { name: "docs/drawing.png" });
    await imageReview.getByRole("button", { name: "Draw on image", exact: true }).click();
    const canvas = imageReview.getByLabel("Drawing: docs/drawing.png");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 100, { steps: 8 }); await page.mouse.up();
    await expect(imageReview.getByRole("button", { name: "Save and accept file" })).toBeVisible();
    const drawn = await canvas.evaluate(node => node.toDataURL());
    await imageReview.getByRole("button", { name: "Undo stroke", exact: true }).click();
    expect(await canvas.evaluate(node => node.toDataURL())).not.toBe(drawn);
    await imageReview.getByRole("button", { name: "Redo stroke", exact: true }).click();
    expect(await canvas.evaluate(node => node.toDataURL())).toBe(drawn);

    await page.screenshot({ path: testInfo.outputPath("local-review-drawing.png"), fullPage: true });
    await imageReview.getByRole("button", { name: "Save and accept file" }).click();
    await expect(imageReview).toHaveCount(0); await expect(asset).toHaveCount(0);
    expect(fs.readFileSync(path.join(root, "docs/drawing.png")).equals(Buffer.from(png, "base64"))).toBe(false);
    await page.getByRole("button", { name: "Clean up older changes", exact: true }).click();
    const cleanup = page.getByRole("dialog", { name: "Review cleanup" });
    await expect(cleanup.getByRole("checkbox")).not.toBeChecked();
    await checkDialogAccessibility(page);
    await cleanup.getByRole("button", { name: "Preview older changes" }).click();
    await expect(cleanup.getByRole("status")).toContainText("0 changes");
    await cleanup.getByRole("button", { name: "Close", exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) await page.goto("about:blank").catch(() => {});
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    await waitForShutdown();
    if (previousHub === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME; else process.env.CONTEXT_ROOM_HUB_HOME = previousHub;
    if (previousShared === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME; else process.env.CONTEXT_ROOM_SHARED_HOME = previousShared;
    if (previousAuthority === undefined) delete process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME; else process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = previousAuthority;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("@smoke Shared image review saves exact drawn bytes while main remains unchanged before final acceptance", async ({ page }, testInfo) => {
  const base = fs.mkdtempSync(path.join(os.homedir(), ".cr-shared-image-ui-"));
  const previous = {};
  for (const key of ["CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"]) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  const { execFileSync } = await import("node:child_process");
  const { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer, buildDocQaReport } = await import("../../src/context_room.mjs");
  const { initializeSharedRepository, connectSharedContext, createSharedProposal, publishSharedProposal, materializeSharedReview } = await import("../../src/shared_context.mjs");
  const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = path.join(base, "remote.git"), seed = path.join(base, "seed"), project = path.join(base, "project");
  let runtime;
  try {
    fs.mkdirSync(project); git(base, ["init", "--bare", "--initial-branch=main", remote]); git(base, ["clone", remote, seed]);
    git(seed, ["config", "user.name", "Context Room browser fixture"]); git(seed, ["config", "user.email", "browser@example.test"]);
    initializeSharedRepository(seed, { name: "Shared drawing fixture" });
    fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }));
    const imagePath = "projects/demo/docs/drawing.png";
    fs.mkdirSync(path.join(seed, "projects/demo/docs"), { recursive: true });
    fs.mkdirSync(path.join(seed, "projects/demo/skills"), { recursive: true }); fs.writeFileSync(path.join(seed, "projects/demo/skills/.gitkeep"), "");
    const png = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 120; const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 200, 120); return canvas.toDataURL().split(",")[1]; });
    fs.writeFileSync(path.join(seed, imagePath), Buffer.from(png, "base64")); fs.writeFileSync(path.join(seed, "projects/demo/docs/README.md"), "# Demo\n");
    git(seed, ["add", "."]); git(seed, ["commit", "-m", "Accepted drawing"]); git(seed, ["push", "origin", "main"]);
    initializeContextRoomProject(project, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
    connectSharedContext(project, { repository: remote, projectId: "demo" });
    const proposal = createSharedProposal(project, { title: "Drawing to review", branch: "proposal/demo/drawing-to-review" });
    git(proposal.root, ["config", "user.name", "Context Room browser fixture"]);
    git(proposal.root, ["config", "user.email", "browser@example.test"]);
    const proposed = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 120; const ctx = canvas.getContext("2d"); ctx.fillStyle = "#b5d8e2"; ctx.fillRect(0, 0, 200, 120); return canvas.toDataURL().split(",")[1]; });
    fs.writeFileSync(path.join(proposal.root, imagePath), Buffer.from(proposed, "base64"));
    const published = publishSharedProposal(project, { proposal: proposal.branch });
    const review = materializeSharedReview(project, { proposal: proposal.branch });
    initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
    writeMemoryWebappSettings(review.reviewRoot, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
    runtime = createMemoryServer({ root: review.reviewRoot });
    await new Promise(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${runtime.server.address().port}/?view=proposal`);
    const row = page.locator(`[data-proposal-review-path="${imagePath}"]`);
    await expect(row).toBeVisible({ timeout: 45000 }); await row.click();
    const dialog = page.getByRole("dialog", { name: imagePath });
    await expect(dialog.getByRole("img", { name: `Accepted: ${imagePath}` })).toBeVisible();
    await dialog.getByRole("button", { name: "Draw on image", exact: true }).click();
    const canvas = dialog.getByLabel(`Drawing: ${imagePath}`), box = await canvas.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 70, { steps: 4 }); await page.mouse.up();
    await page.screenshot({ path: testInfo.outputPath("shared-image-review.png"), fullPage: true });
    await checkDialogAccessibility(page);
    await dialog.getByRole("button", { name: "Save and accept file" }).click(); await expect(dialog).toHaveCount(0);
    expect(fs.readFileSync(path.join(review.reviewRoot, imagePath)).equals(Buffer.from(proposed, "base64"))).toBe(false);
    expect(buildDocQaReport(review.reviewRoot).reviewedPaths).toContain(imagePath);
    expect(git(seed, ["rev-parse", "origin/main"])).not.toBe(published.head);
    expect(fs.readFileSync(path.join(seed, imagePath)).equals(Buffer.from(png, "base64"))).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) { console.error(error); throw error; } finally {
    if (!page.isClosed()) await page.goto("about:blank").catch(() => {});
    if (runtime) { await new Promise(resolve => { runtime.server.close(resolve); runtime.server.closeAllConnections?.(); }); await runtime.waitForShutdown(); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const writable = target => { const info = fs.lstatSync(target); if (info.isDirectory() && !info.isSymbolicLink()) { fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) writable(path.join(target, name)); } };
    writable(base); fs.rmSync(base, { recursive: true, force: true });
  }
});
