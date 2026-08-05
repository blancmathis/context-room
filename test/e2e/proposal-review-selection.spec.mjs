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
  await row.click({ button: "right" });

  const notice = page.locator("#proposalReviewNotice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-kind", "info");
  await expect(notice).toHaveText("This file is already Reviewed, so it cannot be selected again. Selection only applies to files still marked Review. Open the file normally to inspect it.");
  await expect(page.locator('[data-proposal-review-selected="true"]')).toHaveCount(0);
  await expect(row).toContainText("Reviewed");
});
