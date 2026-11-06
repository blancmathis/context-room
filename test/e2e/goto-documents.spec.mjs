import fs from "node:fs";
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

async function openGoto(page) {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1&workspace=workspace-goto-documents&view=hub");
  await waitForBoot(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#contextHubProjectPickerTitle")).toHaveText("Go to");
  await expect(page.locator("#contextHubProjectPickerSearch")).toHaveAttribute("placeholder", "Projects, files or text…");
  return page.locator("#contextHubProjectPickerSearch");
}

test("@smoke Go to finds a document by its text and opens it", async ({ page }) => {
  const search = await openGoto(page);
  await search.fill("procedure");
  const group = page.locator('#contextHubProjectPickerList [role="group"][aria-label="In text"]');
  await expect(group).toBeVisible();
  const row = group.getByRole("option").first();
  await expect(row).toContainText("operations.md");
  await expect(row.locator("mark")).toHaveText(/procedure/i);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#contextHubProjectPicker")).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("docs/operations.md");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("file");
});

test("@smoke Go to finds a document by its name, ignoring case", async ({ page }) => {
  const search = await openGoto(page);
  await search.fill("RUNBOOK");
  const group = page.locator('#contextHubProjectPickerList [role="group"][aria-label="Files"]');
  await expect(group).toBeVisible();
  await expect(group.getByRole("option").first()).toContainText("docs/runbook.md");
  await expect(group.getByRole("option").first()).toContainText("Beacon");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#contextHubProjectPicker")).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("docs/runbook.md");
});

test("@smoke Go to keeps projects first and Escape closes it", async ({ page }) => {
  const search = await openGoto(page);
  await search.fill("atlas");
  await expect(page.locator("#contextHubProjectPickerList [role='option']").first()).toContainText("Atlas");
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("Searching");
  await page.keyboard.press("Escape");
  await expect(page.locator("#contextHubProjectPicker")).toBeHidden();
});

test("Go to opens the exact location that was searched", async ({ page }) => {
  const { projects } = fixture();
  const search = await openGoto(page);
  await search.fill("procedure");
  await expect(page.locator('#contextHubProjectPickerList [role="group"][aria-label="In text"]')).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("docs/operations.md");
  expect(new URL(page.url()).searchParams.get("project")).toBe(projects.atlas.id);
});

test("Go to opens the project id the server returned, not the selected worktree", async ({ page }) => {
  const { projects } = fixture();
  await page.route("**/api/context-hub/document-search?*", (route) => route.fulfill({
    json: { files: [{ projectKey: "local:x", projectId: projects.atlas.worktreeId, projectTitle: "Atlas", path: "docs/operations.md", name: "operations.md" }], text: [] },
  }));
  const search = await openGoto(page);
  await search.fill("zzqqword");
  await expect(page.locator('#contextHubProjectPickerList [role="group"][aria-label="Files"]')).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe(projects.atlas.worktreeId);
});

test("Go to never opens a result of an older query, and Enter waits for the new one", async ({ page }) => {
  const search = await openGoto(page);
  await search.fill("runbook");
  await expect(page.locator('#contextHubProjectPickerList [role="group"][aria-label="Files"]')).toBeVisible();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/context-hub/document-search?*", async (route) => { await gate; await route.continue(); });
  await search.pressSequentially(" zzznomatch");
  await page.keyboard.press("Enter");
  await expect(page.locator('#contextHubProjectPickerList [role="group"][aria-label="Files"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("file")).toBeNull();
  release();
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("Searching");
  expect(new URL(page.url()).searchParams.get("file")).toBeNull();
});

test("Go to keeps the input at the same place while results change, and counts one document correctly", async ({ page }) => {
  const search = await openGoto(page);
  const top = async () => Math.round((await search.boundingBox()).y);
  await page.waitForTimeout(400); // the open animation (180 ms) has ended
  const start = await top();
  await search.fill("pro");
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("Searching");
  expect(await top()).toBe(start);
  await search.fill("procedure");
  await expect(page.locator("#contextHubProjectPickerStatus")).toContainText("1 document");
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("1 documents");
  expect(await top()).toBe(start);
  await search.fill("zzqqnothing");
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("Searching");
  expect(await top()).toBe(start);
  expect(start).toBeLessThan(200);
});

test("Go to does not open a result when Enter was pressed for an earlier query", async ({ page }) => {
  const search = await openGoto(page);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/context-hub/document-search?*", async (route) => { await gate; await route.fulfill({ json: { files: [{ projectKey: "local:x", projectId: fixture().projects.atlas.id, projectTitle: "Atlas", path: "docs/operations.md", name: "operations.md" }], text: [] } }); });
  await search.pressSequentially("zzq");
  await page.keyboard.press("Enter");
  await search.pressSequentially("qword");
  release();
  await expect(page.locator('#contextHubProjectPickerList [role="group"][aria-label="Files"]')).toBeVisible();
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("Searching");
  await page.waitForTimeout(300);
  expect(new URL(page.url()).searchParams.get("file")).toBeNull();
  await expect(page.locator("#contextHubProjectPicker")).toBeVisible();
});

test("Go to tells the user when search failed or was partial", async ({ page }) => {
  let mode = "failed";
  await page.route("**/api/context-hub/document-search?*", (route) => route.fulfill({
    json: mode === "failed" ? { files: [], text: [], failed: true, truncated: true }
      : { files: [], text: [{ projectKey: "local:x", projectId: "x", projectTitle: "X", path: "a.md", name: "a.md", snippet: "zzword", matchStart: 0, matchLength: 6, line: 1, term: "zzword" }], truncated: true },
  }));
  const search = await openGoto(page);
  await search.fill("zzqqword");
  await expect(page.locator("#contextHubProjectPickerStatus")).toContainText("Search unavailable");
  await expect(page.locator("#contextHubProjectPickerList")).toContainText("Document search is unavailable");
  mode = "partial";
  await search.fill("zzqqword2");
  await expect(page.locator("#contextHubProjectPickerStatus")).toContainText("Partial results");
});

test("Go to keeps its footer inside a laptop-height window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const files = Array.from({ length: 40 }, (_, i) => ({ projectKey: "local:x", projectId: "x", projectTitle: "X", path: `docs/f${i}.md`, name: `f${i}.md` }));
  await page.route("**/api/context-hub/document-search?*", (route) => route.fulfill({ json: { files, text: files.map((item) => ({ ...item, snippet: "zzqqword", matchStart: 0, matchLength: 8, line: 1, term: "zzqqword" })) } }));
  const search = await openGoto(page);
  await search.fill("zzqqword");
  await expect(page.locator('#contextHubProjectPickerList [role="group"][aria-label="In text"]')).toBeVisible();
  await page.waitForTimeout(400);
  const footer = await page.locator("#contextHubProjectPicker footer").first().boundingBox();
  expect(footer.y + footer.height).toBeLessThanOrEqual(800);
});

test("Go to keeps a queued Enter when a keystroke leaves the trimmed query unchanged", async ({ page }) => {
  const search = await openGoto(page);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/context-hub/document-search?*", async (route) => { await gate; await route.continue(); });
  await search.fill("runbook");
  await page.keyboard.press("Enter");
  await search.pressSequentially(" ");
  release();
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("docs/runbook.md");
});

test("Go to says search is unavailable, then searches again by itself", async ({ page }) => {
  test.setTimeout(45_000);
  let calls = 0;
  await page.route("**/api/context-hub/document-search?*", async (route) => {
    calls += 1;
    if (calls === 1) await route.fulfill({ json: { terms: [], files: [], text: [], truncated: true, building: false, failed: true } });
    else await route.continue();
  });
  const search = await openGoto(page);
  await search.fill("zzqqnothing");
  const list = page.locator("#contextHubProjectPickerList");
  await expect(list).toContainText("Document search is unavailable.");
  await expect(list).toContainText("Projects still match by name. Type again in a few seconds.");
  await expect(page.locator("#contextHubProjectPickerStatus")).toContainText("Search unavailable");
  await expect(page.locator("#contextHubProjectPickerStatus")).not.toContainText("Search unavailable", { timeout: 15_000 });
  expect(calls).toBeGreaterThanOrEqual(2);
  await expect(list).toContainText("Nothing found.");
});
