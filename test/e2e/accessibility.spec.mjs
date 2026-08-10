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

async function freezeRuntimeUpdates(page) {
  await page.evaluate(() => {
    cancelBackgroundRefresh();
    state.runtimeEventSource?.close();
    state.runtimeEventSource = null;
    state.runtimeEventsConnected = true;
    window.clearInterval(state.runtimeFallbackTimer);
    state.runtimeFallbackTimer = null;
    window.clearTimeout(state.contextHubSnapshotPollTimer);
    state.contextHubSnapshotPollTimer = null;
    window.clearTimeout(state.runtimeContextHubRefreshTimer);
    state.runtimeContextHubRefreshTimer = null;
    state.runtimeContextHubRefreshPending = false;
    state.runtimeContextHubRefreshGeneration = "";
  });
  await expect.poll(() => page.evaluate(() => Boolean(
    state.refreshInFlight
    || state.reportsRefreshInFlight
    || state.runtimeContextHubRefreshPromise
  ))).toBe(false);
}

function violationReport(violations) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
  }));
}

const THEME_VARIANTS = [
  ["context-room", "dark"],
  ["context-room", "light"],
  ["vscode-dark", "dark"],
  ["github-dark", "dark"],
  ["dracula", "dark"],
  ["solarized-dark", "dark"],
  ["light-plus", "light"],
];

async function applyTheme(page, theme, mode) {
  await page.evaluate(({ theme, mode }) => {
    document.documentElement.dataset.fileTheme = theme;
    document.documentElement.dataset.colorMode = mode;
  }, { theme, mode });
  // Theme colors share the workbench's 160 ms surface transition. Audit the
  // settled palette instead of a deliberately interpolated transition frame.
  await page.waitForTimeout(180);
}

async function expectNoAccessibilityViolations(page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(violationReport(result.violations)).toEqual([]);
}

test("@a11y Home and Settings meet the automated WCAG AA contract", async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  await expect(page.locator("#reviewQueueHeading")).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.locator("#settingsButton").click();
  await waitForBoot(page);
  await expect(page.locator("#settingsPage")).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("@a11y Home and Settings text retain WCAG AA contrast in every theme", async ({ page }) => {
  const data = fixture();
  const failures = [];
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  await expect(page.locator("#reviewQueueHeading")).toBeVisible();
  for (const [theme, mode] of THEME_VARIANTS) {
    await applyTheme(page, theme, mode);
    const home = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
    if (home.violations.length) failures.push({ surface: "Home", theme, mode, violations: violationReport(home.violations) });
  }

  await page.locator("#settingsButton").click();
  await waitForBoot(page);
  await expect(page.locator("#settingsPage")).toBeVisible();
  const settingsTabs = page.locator("[data-settings-section-target]");
  for (const [theme, mode] of THEME_VARIANTS) {
    await applyTheme(page, theme, mode);
    for (let index = 0; index < await settingsTabs.count(); index += 1) {
      const tab = settingsTabs.nth(index);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const settings = await new AxeBuilder({ page })
        .include("#settingsPage")
        .withRules(["color-contrast"])
        .analyze();
      if (settings.violations.length) failures.push({
        surface: `Settings/${await tab.getAttribute("data-settings-section-target")}`,
        theme,
        mode,
        violations: violationReport(settings.violations),
      });
    }
  }
  expect(failures).toEqual([]);
});

test("@a11y responsive Explorer and Shared help retain names, focus, and semantics", async ({ page }) => {
  const data = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  const explorerToggle = page.locator("#explorerOpen:visible, #sidebarToggle:visible").first();
  const app = page.locator(".app");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) await explorerToggle.click();
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
  await expectNoAccessibilityViolations(page);

  await page.locator("#sidebarToggle:visible").click();
  await expect(app).toHaveClass(/sidebar-collapsed/);
  await page.locator("#settingsButton").click();
  await waitForBoot(page);
  const help = page.locator("#sharedContextHelpButton");
  if (await help.isVisible()) {
    await help.click();
    await expect(page.locator(".shared-context-help-dialog")).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
  }

  const agentEnvironmentTab = page.locator('[data-settings-section-target="agent-environment"]');
  await agentEnvironmentTab.click();
  await agentEnvironmentTab.focus();
  await page.evaluate(async (projectId) => {
    state.sharedSkillLocations.set(projectId, {
      connected: true,
      projectId,
      collections: [{ id: "team", title: "Team skills", skillCount: 1 }],
      assignments: [],
      providers: [{ id: "codex", label: "Codex" }],
      projects: [{ id: projectId, title: "Atlas" }],
      providerPreferences: { providers: { codex: "enabled" } },
      projectProviderOverrides: { codex: "inherit" },
    });
    await openSharedSkillsWizard({ mode: "assign", projectId });
  }, data.projects.atlas.id);
  const sharedSkillsWizard = page.locator("#sharedSkillsWizard");
  await expect(sharedSkillsWizard).toBeVisible();
  await expectNoAccessibilityViolations(page);
  await sharedSkillsWizard.locator(".context-hub-project-picker-close").focus();
  await page.keyboard.press("Escape");
  await expect(sharedSkillsWizard).toBeHidden();
  await expect(agentEnvironmentTab).toBeFocused();
});

test("@a11y Explorer and critical review colors retain WCAG contrast in every theme", async ({ page }) => {
  const data = fixture();
  const failures = [];
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  await page.evaluate(() => {
    const probe = document.createElement("section");
    probe.id = "themeStatusContrastProbe";
    probe.setAttribute("aria-label", "Theme status contrast probe");
    probe.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;width:540px;max-height:calc(100vh - 24px);overflow:auto;padding:12px;background:var(--file-bg)";
    probe.innerHTML = '<div class="diff-code"><span class="diff-line add">+ Added review line</span><span class="diff-line del">- Deleted review line</span></div>'
      + '<div class="external-review-doc"><div class="external-change-stats"><span class="add">+12</span><span class="del">-8</span><span class="pending">Pending</span></div></div>'
      + '<div style="display:flex;gap:8px;padding:8px;background:var(--panel)"><span class="context-hub-source" data-source="shared">Shared</span><span class="context-hub-source" data-source="local">Local</span><span class="shared-proposal-project">Proposal</span><span class="context-hub-worktree-label">worktree</span></div>'
      + '<div style="padding:8px;background:var(--surface-sidebar)"><button class="tree-row folder" type="button">Folder</button><button class="tree-row file" type="button">File</button><span class="tree-entry watched-inherited"><span class="tree-name">Inherited watch</span></span></div>'
      + '<div class="external-review-block resolved"><span>Resolved review content</span></div>'
      + '<div class="agent-annotation"><span><strong>Agent note</strong><code>docs/review.md</code></span></div>'
      + '<div class="conflict-panel"><p>Resolve this conflict before saving.</p><div class="conflict-card"><div class="conflict-card-head"><small>Current file</small></div><div class="conflict-diff"><span class="conflict-diff-line add"><span class="marker">+</span><span>Added line</span></span><span class="conflict-diff-line del"><span class="marker">−</span><span>Deleted line</span></span><span class="conflict-diff-line ctx"><span class="marker"> </span><span>Context line</span></span></div></div></div>'
      + '<div class="agent-toast" style="position:static;max-width:none"><strong>Agent wants to navigate</strong><div>Open the requested file?</div><div class="agent-toast-actions"><button class="file-action" type="button">Later</button><button class="file-action primary" type="button">Go</button></div></div>'
      + '<div style="display:flex;gap:8px;padding:8px;background:var(--panel)"><span class="proposal-review-file-state">Review</span><span class="shared-proposal-card-state" data-state="updated">Updated</span><span class="codex-prompt-badge" data-status="restart_required">Restart required</span></div>'
      + '<div class="issue review-status-unconfirmed"><span>Review coverage is not current.</span><button class="quiet-button" type="button">Refresh</button></div>'
      + '<input id="themePlaceholderContrastProbe" type="text" aria-label="Placeholder contrast probe" placeholder="Search files…" style="width:100%;background:var(--panel)" />';
    document.body.append(probe);
  });
  for (const [theme, mode] of THEME_VARIANTS) {
    await applyTheme(page, theme, mode);
    const results = await page.locator("#themeStatusContrastProbe").evaluate((probe) => {
      const parseColor = (value) => {
        const serialized = String(value).trim();
        const rgb = serialized.match(/^rgba?\(([^)]+)\)$/i);
        if (rgb) {
          const parts = rgb[1].trim().split(/[\s,/]+/).filter(Boolean).map(Number);
          return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
        }
        const srgb = serialized.match(/^color\(srgb\s+([^/)]+?)(?:\s*\/\s*([^)]+))?\)$/i);
        if (srgb) {
          const parts = srgb[1].trim().split(/\s+/).map((part) => Number(part) * 255);
          return { r: parts[0], g: parts[1], b: parts[2], a: srgb[2] == null ? 1 : Number(srgb[2]) };
        }
        const oklab = serialized.match(/^oklab\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^)]+))?\)$/i);
        if (oklab) {
          const lightness = oklab[1].endsWith("%") ? Number.parseFloat(oklab[1]) / 100 : Number(oklab[1]);
          const axisA = Number(oklab[2]);
          const axisB = Number(oklab[3]);
          const lPrime = lightness + 0.3963377774 * axisA + 0.2158037573 * axisB;
          const mPrime = lightness - 0.1055613458 * axisA - 0.0638541728 * axisB;
          const sPrime = lightness - 0.0894841775 * axisA - 1.291485548 * axisB;
          const l = lPrime ** 3;
          const m = mPrime ** 3;
          const s = sPrime ** 3;
          const linear = [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
          ];
          const toSrgb = (value) => 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
          const [r, g, b] = linear.map((value) => Math.max(0, Math.min(255, toSrgb(value))));
          return { r, g, b, a: oklab[4] == null ? 1 : Number(oklab[4]) };
        }
        throw new Error("Unsupported computed color: " + value);
      };
      const composite = (front, back) => {
        const alpha = front.a + back.a * (1 - front.a);
        if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
          g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
          b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
          a: alpha,
        };
      };
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      const contrast = (first, second) => {
        const lighter = Math.max(luminance(first), luminance(second));
        const darker = Math.min(luminance(first), luminance(second));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const effectiveBackground = (element) => {
        let background = { r: 0, g: 0, b: 0, a: 0 };
        for (let current = element; current; current = current.parentElement) {
          background = composite(background, parseColor(getComputedStyle(current).backgroundColor));
          if (background.a >= 0.999) return background;
        }
        return composite(background, parseColor(getComputedStyle(document.documentElement).backgroundColor));
      };
      const results = [...probe.querySelectorAll(".diff-line, .external-change-stats span, .context-hub-source, .shared-proposal-project, .context-hub-worktree-label, .tree-row, .tree-name, .external-review-block.resolved, .agent-annotation, .agent-annotation strong, .agent-annotation code, .conflict-panel p, .conflict-card-head small, .conflict-diff-line, .conflict-diff-line > span, .agent-toast, .agent-toast strong, .agent-toast > div:not(.agent-toast-actions), .agent-toast code, .proposal-review-file-state, .shared-proposal-card-state, .codex-prompt-badge, .review-status-unconfirmed .quiet-button")]
        .map((element) => {
          const background = effectiveBackground(element);
          const foreground = composite(parseColor(getComputedStyle(element).color), background);
          return {
            text: element.textContent.trim(),
            ratio: contrast(foreground, background),
            color: getComputedStyle(element).color,
            background: getComputedStyle(element).backgroundColor,
          };
        });
      const placeholder = probe.querySelector("#themePlaceholderContrastProbe");
      const placeholderStyle = getComputedStyle(placeholder, "::placeholder");
      const placeholderBackground = effectiveBackground(placeholder);
      const placeholderColor = parseColor(placeholderStyle.color);
      placeholderColor.a *= Number.parseFloat(placeholderStyle.opacity) || 1;
      const placeholderForeground = composite(placeholderColor, placeholderBackground);
      results.push({
        text: "Search files placeholder",
        ratio: contrast(placeholderForeground, placeholderBackground),
        color: placeholderStyle.color,
        background: getComputedStyle(placeholder).backgroundColor,
      });
      return results;
    });
    const violations = results.filter((entry) => entry.ratio < 4.5);
    if (violations.length) failures.push({ theme, mode, violations });
  }
  expect(failures).toEqual([]);
});

test("@a11y form control boundaries retain non-text contrast in every theme", async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  await page.evaluate(() => {
    const probe = document.createElement("input");
    probe.id = "themeControlContrastProbe";
    probe.type = "text";
    probe.setAttribute("aria-label", "Theme control contrast probe");
    probe.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;width:240px;background:var(--panel);border:1px solid var(--control-line)";
    document.body.append(probe);
  });
  for (const [theme, mode] of THEME_VARIANTS) {
    await applyTheme(page, theme, mode);
    const ratio = await page.locator("#themeControlContrastProbe").evaluate((probe) => {
      const parseColor = (value) => {
        const match = String(value).trim().match(/^rgba?\(([^)]+)\)$/i);
        if (!match) throw new Error(`Unsupported computed color: ${value}`);
        const parts = match[1].trim().split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
      };
      const composite = (front, back) => {
        const alpha = front.a + back.a * (1 - front.a);
        if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
          g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
          b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
          a: alpha,
        };
      };
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      const contrast = (first, second) => {
        const lighter = Math.max(luminance(first), luminance(second));
        const darker = Math.min(luminance(first), luminance(second));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const canvas = parseColor(getComputedStyle(document.body).backgroundColor);
      const style = getComputedStyle(probe);
      const border = composite(parseColor(style.borderTopColor), canvas);
      const control = composite(parseColor(style.backgroundColor), canvas);
      return contrast(border, control);
    });
    expect(ratio, `${theme}/${mode}`).toBeGreaterThanOrEqual(3);
  }
});

test("@a11y Explorer context menu restores focus after a keyboard command", async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&project=${encodeURIComponent(data.projects.atlas.id)}&view=hub`);
  await waitForBoot(page);
  await freezeRuntimeUpdates(page);
  const explorerToggle = page.locator("#explorerOpen:visible, #sidebarToggle:visible").first();
  const app = page.locator(".app");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) await explorerToggle.click();
  await page.evaluate(async (projectId) => {
    const project = state.contextHub.projects.find((item) => item.id === projectId || item.worktrees?.some((worktree) => worktree.id === projectId));
    if (!project) throw new Error("Missing project fixture");
    await openGlobalProjectExplorer(project);
  }, data.projects.atlas.id);

  const origin = page.locator("[data-global-project-file]").first();
  await expect(origin).toBeVisible();
  await origin.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.locator("#explorerContextMenu");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await menu.getByRole("menuitem", { name: "New file" }).press("Enter");
  await expect(page.locator("#globalContextMarkdownTitle")).toBeFocused();
  const cancel = menu.locator("[data-global-context-new-file-form]:not([hidden]) [data-global-context-cancel]");
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(origin).toBeFocused();

  const folder = page.locator("[data-global-project-folder]").first();
  await expect(folder).toBeVisible();
  await folder.focus();
  await page.keyboard.press("Shift+F10");
  const toggleLabel = await folder.getAttribute("aria-expanded") === "true" ? "Collapse" : "Expand";
  await menu.getByRole("menuitem", { name: toggleLabel, exact: true }).press("Enter");
  await expect(menu).toBeHidden();
  await expect(folder).toBeFocused();
});

test("@a11y review and Explorer selection expose state while snooze restores focus", async ({ page }) => {
  const data = fixture();
  await page.goto(`${data.origin}/?hub=1&view=hub`);
  await waitForBoot(page);
  await freezeRuntimeUpdates(page);
  await page.evaluate(() => {
    const project = state.contextHub?.projects?.find((candidate) => candidate.mode !== "shared");
    if (!project) throw new Error("Missing local project fixture");
    const worktree = project.worktrees?.[0] || project.worktree || null;
    const item = {
      id: "a11y-local-review",
      type: "local",
      projectId: worktree?.id || project.id,
      projectKey: project.projectKey,
      projectTitle: project.title,
      reviewStatus: "local_changes",
      updatedAt: new Date().toISOString(),
      reviews: [{
        path: "README.md",
        label: "README.md",
        worktreeId: worktree?.id || project.id,
        worktreeLabel: worktree?.branch || "main",
        resourceState: "present",
        currentHash: "a11y-review-version",
        reviewStatus: "needs_review",
      }],
    };
    state.contextHub.items = [item, ...(state.contextHub.items || []).filter((candidate) => candidate.id !== item.id)];
    state.contextHub.attention = { ...(state.contextHub.attention || {}), snoozes: {} };
    state.contextHub.freshness = { ...(state.contextHub.freshness || {}), refreshing: false };
    state.sharedContextBusy = false;
    state.contextHubBusy = false;
    state.sharedProposalProject = "";
    state.contextHubSource = "all";
    renderContextRoomGlobalReviewQueue();
  });

  const reviewEntry = page.locator('[data-context-room-review-entry^="a11y-local-review:"]').first();
  await expect(reviewEntry).toBeVisible();
  const reviewId = await reviewEntry.getAttribute("data-context-room-review-entry");
  const reviewButton = () => page.locator(`[data-context-room-review-entry=${JSON.stringify(reviewId)}] [data-context-room-review]`).first();
  await expect(reviewButton()).not.toHaveAttribute("aria-pressed", /.+/);
  await reviewButton().focus();
  await reviewButton().click({ button: "right" });
  const reviewMenu = page.locator("#contextRoomReviewContextMenu");
  await expect(reviewMenu).toBeVisible();
  await expect(reviewMenu).toHaveAttribute("role", "menu");
  await reviewMenu.getByRole("menuitem", { name: "Select this item", exact: true }).click();
  await expect(reviewButton()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#contextRoomReviewSelection").getByRole("status")).toContainText("1 selected");
  await reviewButton().click();
  await expect(reviewButton()).not.toHaveAttribute("aria-pressed", /.+/);

  await reviewButton().focus();
  await reviewButton().click({ button: "right" });
  await reviewMenu.getByRole("menuitem", { name: "Snooze…", exact: true }).click();
  await expect(reviewMenu).toHaveAttribute("role", "dialog");
  await expect(reviewMenu).toHaveAccessibleName(/Snooze review/);
  await expect(reviewMenu.getByRole("group", { name: "Quick snooze durations" })).toBeVisible();
  await expect(reviewMenu.getByRole("button", { name: "Apply duration", exact: true })).toBeVisible();
  await reviewMenu.locator("summary").click();
  await expect(reviewMenu.getByLabel("Exact return time", { exact: true })).toBeVisible();
  await expect(reviewMenu.getByRole("button", { name: "Apply return time", exact: true })).toBeVisible();
  await reviewMenu.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(reviewMenu).toBeHidden();
  await expect(reviewButton()).toBeFocused();

  await page.goto(data.origin + "/");
  await waitForBoot(page);
  await freezeRuntimeUpdates(page);
  const app = page.locator(".app");
  if (await app.evaluate((node) => node.classList.contains("sidebar-collapsed"))) {
    await page.locator("#explorerOpen:visible, #sidebarToggle:visible").first().click();
    await expect(app).not.toHaveClass(/sidebar-collapsed/);
  }
  const explorerFolder = page.locator(".tree [data-folder-path]").first();
  await expect(explorerFolder).toBeVisible();
  const folderPath = await explorerFolder.getAttribute("data-folder-path");
  await expect(explorerFolder).not.toHaveAttribute("aria-pressed", /.+/);
  await explorerFolder.click({ button: "right" });
  await page.locator("#explorerContextMenu").getByRole("menuitem", { name: "Select", exact: true }).click();
  const selectedExplorerFolder = page.locator(`[data-folder-path=${JSON.stringify(folderPath)}]`).first();
  await expect(selectedExplorerFolder).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#selectionCount")).toContainText("1 selected");
  await selectedExplorerFolder.click();
  await expect(page.locator(`[data-folder-path=${JSON.stringify(folderPath)}]`).first()).not.toHaveAttribute("aria-pressed", /.+/);
});
