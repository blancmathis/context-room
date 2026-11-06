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
