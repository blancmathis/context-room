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
