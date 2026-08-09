import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

function fixture() {
  const fixturePath = process.env.CONTEXT_ROOM_E2E_FIXTURE;
  if (!fixturePath) throw new Error("Missing Context Room accessibility fixture");
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

async function waitForBoot(page) {
  await expect(page.locator("body")).not.toHaveClass(/app-booting|app-recovery/);
  await expect.poll(async () => {
    const diagnostics = JSON.parse(await page.locator("body").getAttribute("data-workspace-diagnostics") || "{}");
    return diagnostics.phase || "";
  }).toBe("ready");
}

test("@a11y Markdown reader exposes document structure and opens links from the keyboard", async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=file&file=${encodeURIComponent("docs/README.md")}`);
  await waitForBoot(page);
  const targetPath = await page.evaluate(() => {
    const target = "docs/guide.md";
    state.files = [{ path: target }];
    state.selected = "__accessibility_probe__/source.md";
    globalThis.__openedMarkdownTarget = "";
    openMarkdownDocLink = async (value) => { globalThis.__openedMarkdownTarget = value; };
    const probe = document.createElement("section");
    probe.id = "markupAccessibilityProbe";
    const markdown = [
      "# Accessible heading",
      "",
      "- First item",
      "- Second item",
      "> Quoted guidance",
      "---",
      `[Open target](${target})`,
      `\`${target}\``,
      target,
    ].join("\n");
    probe.innerHTML = renderMarkdownLineView(markdown).replace('id="docReader"', 'id="markupAccessibilityReader"');
    document.body.append(probe);
    wireMarkdownDocLinks(probe);
    return target;
  });

  const reader = page.locator("#markupAccessibilityReader");
  await expect(reader.getByRole("heading", { level: 1, name: "Accessible heading" })).toHaveCount(1);
  await expect(reader.getByRole("list")).toHaveCount(1);
  await expect(reader.getByRole("listitem")).toHaveCount(2);
  await expect(reader.locator("blockquote")).toHaveCount(1);
  await expect(reader.getByRole("separator", { name: "Thematic break" })).toHaveCount(1);
  await expect(reader.getByRole("link")).toHaveCount(3);
  expect(await reader.locator("[data-line-index]").evaluateAll((lines) => lines.map((line) => Number(line.dataset.lineIndex)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

  const accessibility = await new AxeBuilder({ page })
    .include("#markupAccessibilityProbe")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);

  const link = reader.getByRole("link", { name: "Open target" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => globalThis.__openedMarkdownTarget)).toBe(targetPath);
});
