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

test("@smoke a reviewed proposal row explains why it cannot be selected", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "The touch path shares the selection helper and is covered by the source contract test.");
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);

  await page.evaluate(() => {
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
  });

  const row = page.locator('[data-proposal-review-path="README.md"]');
  await expect(row).toContainText("Reviewed");
  const selectionResult = await page.evaluate(() => {
    const target = document.querySelector('[data-proposal-review-path="README.md"]');
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const notice = document.querySelector("#proposalReviewNotice");
    return {
      noticeVisible: !notice.hidden,
      noticeKind: notice.dataset.kind,
      noticeText: notice.textContent,
      selectedCount: document.querySelectorAll('[data-proposal-review-selected="true"]').length,
    };
  });
  expect(selectionResult).toEqual({
    noticeVisible: true,
    noticeKind: "info",
    noticeText: "This file is already Reviewed, so it cannot be selected again. Selection only applies to files still marked Review. Open the file normally to inspect it.",
    selectedCount: 0,
  });
  await expect(row).toContainText("Reviewed");
});

test("@smoke terminal proposal acceptance keeps progress and server errors visible", async ({ page }) => {
  const { origin } = fixture();
  await page.goto(origin + "/?hub=1");
  await waitForBoot(page);

  let resolveResponse;
  const responseGate = new Promise((resolve) => { resolveResponse = resolve; });
  await page.route("**/api/shared-context/accept", async (route) => {
    await responseGate;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "GitHub refused the proposal push.", code: "shared_context_acceptance_stale" }),
    });
  });

  await page.evaluate(() => {
    state.files = [{ path: "README.md", label: "README.md" }];
    state.sharedContext = {
      mode: "review",
      acceptedChangesRemain: true,
      review: {
        projectId: "demo-project",
        proposal: "proposal/demo/terminal-action",
        proposalHead: "0123456789abcdef",
        defaultBranch: "main",
        title: "Terminal action feedback",
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
  });

  await page.locator("#proposalDockAccept").click();
  const dialog = page.locator(".confirm-dialog");
  await dialog.locator("[data-confirm-checkbox]").check();
  await dialog.locator("[data-confirm-accept]").click();

  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-confirm-accept]")).toBeDisabled();
  await expect(dialog.locator("[data-confirm-accept]")).toHaveText("Putting on main…");

  resolveResponse();
  await expect(dialog.locator("[data-confirm-error]")).toHaveText("GitHub refused the proposal push.");
  await expect(dialog.locator("[data-confirm-accept]")).toBeEnabled();
  await expect(dialog.locator("[data-confirm-accept]")).toHaveText("Put on main");
});
