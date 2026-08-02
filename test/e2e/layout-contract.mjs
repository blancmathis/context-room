import fs from "node:fs";

export const LAYOUT_CONTRACT = Object.freeze({
  schemaVersion: "context-room.layout/1",
  breakpoints: Object.freeze({ mobileMax: 639, drawerMax: 980, desktopMin: 981, wideInspectorMin: 1280 }),
  spacing: Object.freeze({ allowed: [4, 8, 12, 16, 20, 24], workbench: 20, mobileWorkbench: 12, explorer: 8, inspector: 16, mobileInspector: 12, dialog: 20, mobileDialog: 12 }),
  tolerance: Object.freeze({ edge: 1, iconCenter: 0.5 }),
  surfaces: Object.freeze([
    { name: "Explorer", selector: ".app > aside", gutter: "explorer" },
    { name: "Home header", selector: "#reviewQueuePanel > header", gutter: "workbench" },
    { name: "Review toolbar", selector: ".context-room-review-toolbar", gutter: "workbench" },
    { name: "Review rows", selector: "#reviewQueue :is(.context-room-proposal-row, .context-hub-review-item, .review-item)", gutter: "workbench", first: true },
    { name: "Home folders", selector: "#hubFolders:not(:empty)", gutter: "workbench" },
    { name: "Settings header", selector: "#settingsCard > .settings-page-header", gutter: "workbench" },
    { name: "Settings section header", selector: ".settings-section:not([hidden]) > .settings-section-head", gutter: "workbench", first: true },
    { name: "Settings section body", selector: ".settings-section:not([hidden]) > .settings-section-body", gutter: "workbench", first: true },
    { name: "Settings footer", selector: ".settings-footer", gutter: "workbench" },
    { name: "File header", selector: ".file-panel > header", gutter: "workbench" },
    { name: "Diff header", selector: ".diff-header", gutter: "workbench" },
    { name: "Document context header", selector: ".document-context-head", gutter: "inspector" },
    { name: "Document context body", selector: ".document-context-body", gutter: "inspector" },
    { name: "Proposal header", selector: ".proposal-review-head", gutter: "workbench" },
    { name: "Proposal metadata", selector: ".proposal-review-meta", gutter: "workbench" },
    { name: "Proposal files", selector: ".proposal-review-file", gutter: "workbench", first: true },
    { name: "Graph toolbar", selector: ".graph-toolbar", gutter: "workbench" },
    { name: "Graph filters", selector: ".graph-filterbar", gutter: "workbench" },
    { name: "Graph rows", selector: ".graph-list-row", gutter: "workbench", first: true },
    { name: "Confirm dialog", selector: ".confirm-dialog", gutter: "dialog" },
    { name: "Project picker header", selector: ".context-hub-project-picker-head", gutter: "dialog" },
    { name: "Project picker search", selector: ".context-hub-project-picker-search-wrap", gutter: "dialog" },
    { name: "Project picker footer", selector: ".context-hub-project-picker-footer", gutter: "dialog" },
  ]),
  opticalExceptions: Object.freeze([
    { selector: ".settings-search-icon", reason: "The 15px search glyph is centered optically inside a 40px field." },
    { selector: ".settings-tab", reason: "The 2px active indicator is part of the tab content box." },
    { selector: ".explorer-open", reason: "The collapsed rail control is centered in a 48px navigation rail." },
  ]),
});

function htmlEscape(value) {
  return String(value).replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

export async function collectLayoutViolations(page, { label = "layout" } = {}) {
  // Geometry is only meaningful once finite UI transitions have reached their
  // final frame. Slower CI runners can otherwise sample the 160ms Explorer grid
  // transition while local machines have already completed it.
  await page.evaluate(async () => {
    const finiteAnimations = document.getAnimations().filter((animation) => {
      const endTime = Number(animation.effect?.getComputedTiming?.().endTime);
      return animation.playState === "running" && Number.isFinite(endTime) && endTime <= 1_000;
    });
    await Promise.allSettled(finiteAnimations.map((animation) => animation.finished));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return page.evaluate(({ contract, label: auditLabel }) => {
    const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
    const activeSurface = (element) => visible(element) && !element.closest("[hidden], [aria-hidden='true'], [inert]");
    const number = (value) => Number.parseFloat(value) || 0;
    const round = (value) => Math.round(value * 100) / 100;
    const pathFor = (element) => {
      const parts = [];
      for (let current = element; current && current !== document.body && parts.length < 5; current = current.parentElement) {
        let part = current.tagName.toLowerCase();
        if (current.id) part += `#${current.id}`;
        else if (current.classList.length) part += `.${[...current.classList].slice(0, 2).join(".")}`;
        parts.unshift(part);
      }
      return parts.join(" > ");
    };
    const violations = [];
    const add = (type, selector, expected, actual, element, detail = "") => violations.push({
      type,
      surface: auditLabel,
      selector,
      expected,
      actual,
      delta: typeof expected === "number" && typeof actual === "number" ? round(actual - expected) : null,
      parents: element ? pathFor(element) : "",
      detail,
    });
    const width = window.innerWidth;
    const mobile = width <= contract.breakpoints.mobileMax;
    const gutter = (kind) => {
      if (kind === "explorer") return contract.spacing.explorer;
      if (kind === "inspector") return mobile ? contract.spacing.mobileInspector : contract.spacing.inspector;
      if (kind === "dialog") return mobile ? contract.spacing.mobileDialog : contract.spacing.dialog;
      return mobile ? contract.spacing.mobileWorkbench : contract.spacing.workbench;
    };
    for (const surface of contract.surfaces) {
      const elements = [...document.querySelectorAll(surface.selector)].filter(activeSurface);
      const targets = surface.first ? elements.slice(0, 1) : elements;
      for (const element of targets) {
        const style = getComputedStyle(element);
        const expected = gutter(surface.gutter);
        const left = number(style.paddingLeft);
        const right = number(style.paddingRight);
        const collapsedExplorer = surface.name === "Explorer" && element.closest(".app")?.classList.contains("sidebar-collapsed");
        if (!collapsedExplorer && Math.abs(left - expected) > contract.tolerance.edge) add("padding-left", surface.selector, expected, round(left), element, surface.name);
        if (!collapsedExplorer && Math.abs(right - expected) > contract.tolerance.edge) add("padding-right", surface.selector, expected, round(right), element, surface.name);
        const rect = element.getBoundingClientRect();
        if (rect.left < -contract.tolerance.edge || rect.right > width + contract.tolerance.edge) add("viewport-overflow", surface.selector, `0..${width}`, `${round(rect.left)}..${round(rect.right)}`, element, surface.name);
      }
    }

    // Edge peek temporarily expands a collapsed Explorer into a full drawer. Its
    // toggle follows the drawer header layout, so the compact-rail centering
    // contract only applies while the rail itself is actually visible.
    const collapsedRail = document.querySelector(".app.sidebar-collapsed:not(.explorer-edge-peek) > aside");
    const collapsedToggle = collapsedRail?.querySelector("#sidebarToggle");
    if (width >= contract.breakpoints.desktopMin && activeSurface(collapsedRail) && activeSurface(collapsedToggle)) {
      const rail = collapsedRail.getBoundingClientRect();
      const toggle = collapsedToggle.getBoundingClientRect();
      const centerDelta = round(Math.abs((rail.left + rail.width / 2) - (toggle.left + toggle.width / 2)));
      if (centerDelta > contract.tolerance.iconCenter) add("rail-control-centering", "#sidebarToggle", contract.tolerance.iconCenter, centerDelta, collapsedToggle);
    }

    const pageOverflow = Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth);
    if (pageOverflow > contract.tolerance.edge) add("page-overflow", "html", 0, pageOverflow, document.documentElement);

    const majorContainers = ["main", ".workspace-page:not([hidden])", ".settings-panel", ".settings-content", ".review-queue", ".file-panel", ".proposal-review-shell", ".graph-page"];
    for (const selector of majorContainers) {
      for (const element of [...document.querySelectorAll(selector)].filter(activeSurface)) {
        const style = getComputedStyle(element);
        const overflow = element.scrollWidth - element.clientWidth;
        const intentional = ["auto", "scroll"].includes(style.overflowX) || element.matches(".settings-content");
        if (overflow > contract.tolerance.edge && !intentional) add("local-overflow", selector, 0, overflow, element);
      }
    }

    const settingsInput = document.querySelector("#settingsSearch");
    const settingsIcon = document.querySelector(".settings-search-icon");
    if (activeSurface(settingsInput) && activeSurface(settingsIcon)) {
      const input = settingsInput.getBoundingClientRect();
      const icon = settingsIcon.getBoundingClientRect();
      const rightInset = round(input.right - icon.right);
      const centerDelta = round(Math.abs((input.top + input.height / 2) - (icon.top + icon.height / 2)));
      if (Math.abs(rightInset - contract.spacing.mobileWorkbench) > contract.tolerance.edge) add("icon-inset", ".settings-search-icon", contract.spacing.mobileWorkbench, rightInset, settingsIcon);
      if (centerDelta > contract.tolerance.iconCenter) add("icon-centering", ".settings-search-icon", contract.tolerance.iconCenter, centerDelta, settingsIcon);
    }

    const footer = document.querySelector(".settings-footer");
    const content = document.querySelector(".settings-content");
    if (activeSurface(footer) && activeSurface(content)) {
      const footerRect = footer.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      if (contentRect.bottom > footerRect.top + contract.tolerance.edge) add("sticky-overlap", ".settings-footer", `content bottom <= ${round(footerRect.top)}`, round(contentRect.bottom), footer);
      const sections = [...content.querySelectorAll(".settings-section:not([hidden])")].filter(visible);
      const last = sections.at(-1);
      if (last) {
        const reachable = content.scrollHeight - content.clientHeight;
        const lastBottomAtMaxScroll = last.getBoundingClientRect().bottom - reachable;
        if (lastBottomAtMaxScroll > footerRect.top + contract.tolerance.edge) add("footer-obscures-content", ".settings-footer", `last content <= ${round(footerRect.top)}`, round(lastBottomAtMaxScroll), last);
      }
    }

    const overlapGroups = [".workspace-dock", ".sidebar-head", ".context-room-review-toolbar", ".settings-page-header", ".settings-footer", ".file-panel > header", ".proposal-review-head", ".graph-toolbar-controls", ".confirm-dialog"];
    for (const groupSelector of overlapGroups) {
      for (const group of [...document.querySelectorAll(groupSelector)].filter(activeSurface)) {
        const controls = [...group.querySelectorAll(":scope > button, :scope > a, :scope > input, :scope > select, :scope > label, :scope > .docqa-actions > button")].filter(activeSurface);
        for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
          const left = controls[leftIndex].getBoundingClientRect();
          for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
            const right = controls[rightIndex].getBoundingClientRect();
            const intersects = left.left < right.right - 0.5 && left.right > right.left + 0.5 && left.top < right.bottom - 0.5 && left.bottom > right.top + 0.5;
            if (intersects) add("interactive-overlap", groupSelector, "no overlap", `${pathFor(controls[leftIndex])} / ${pathFor(controls[rightIndex])}`, group);
          }
        }
      }
    }

    if (mobile) {
      const touchSelectors = ["#explorerOpen", "#sidebarToggle", "#brandHome", ".settings-tab", ".settings-footer button", ".file-action", ".global-explorer-mode", ".watch-filter", ".graph-open"];
      for (const selector of touchSelectors) {
        for (const element of [...document.querySelectorAll(selector)].filter(activeSurface)) {
          const rect = element.getBoundingClientRect();
          if (rect.width < 40 - contract.tolerance.edge || rect.height < 40 - contract.tolerance.edge) {
            const style = getComputedStyle(element);
            add("touch-target", selector, "40x40", `${round(rect.width)}x${round(rect.height)}`, element, `min ${style.minWidth}x${style.minHeight}; mobile media ${matchMedia(`(max-width: ${contract.breakpoints.mobileMax}px)`).matches}`);
          }
        }
      }
    }

    for (const container of document.querySelectorAll("[hidden], [aria-hidden='true'], [inert]")) {
      for (const control of container.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")) {
        if (!visible(control) || control.disabled || control.tabIndex < 0) continue;
        const previous = document.activeElement;
        control.focus({ preventScroll: true });
        const receivedFocus = document.activeElement === control;
        if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        if (receivedFocus) add("hidden-focusable", pathFor(control), "removed from focus order", control.tabIndex, control);
      }
    }

    const tabs = document.querySelector(".settings-tabs");
    if (activeSurface(tabs)) {
      const style = getComputedStyle(tabs);
      if (tabs.scrollWidth > tabs.clientWidth + 1 && !["auto", "scroll"].includes(style.overflowX)) add("tab-strip-clipped", ".settings-tabs", "horizontal scrolling", style.overflowX, tabs);
    }

    return { schemaVersion: contract.schemaVersion, label: auditLabel, viewport: { width, height: window.innerHeight }, violations };
  }, { contract: LAYOUT_CONTRACT, label });
}

export async function attachLayoutFailureArtifacts(page, testInfo, report) {
  const artifactRoot = testInfo.outputPath("layout-audit");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const jsonPath = `${artifactRoot}/report.json`;
  const htmlPath = `${artifactRoot}/report.html`;
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const rows = report.violations.map((violation) => `<tr><td>${htmlEscape(violation.type)}</td><td><code>${htmlEscape(violation.selector)}</code></td><td>${htmlEscape(violation.expected)}</td><td>${htmlEscape(violation.actual)}</td><td>${htmlEscape(violation.delta ?? "")}</td><td>${htmlEscape(violation.parents)}</td><td>${htmlEscape(violation.detail)}</td></tr>`).join("");
  fs.writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8"><title>Context Room layout audit</title><style>body{font:14px/1.5 system-ui;margin:24px;color:#18202a}table{border-collapse:collapse;width:100%}th,td{padding:8px;border:1px solid #cbd5e1;text-align:left;vertical-align:top}code{white-space:pre-wrap}</style><h1>${htmlEscape(report.label)}</h1><p>${htmlEscape(JSON.stringify(report.viewport))}</p><table><thead><tr><th>Type</th><th>Selector</th><th>Expected</th><th>Actual</th><th>Delta</th><th>Parents</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`);
  await testInfo.attach("layout-audit-json", { path: jsonPath, contentType: "application/json" });
  await testInfo.attach("layout-audit-html", { path: htmlPath, contentType: "text/html" });
  if (!report.violations.length) return;
  await page.evaluate((violations) => {
    document.querySelector("#context-room-layout-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "context-room-layout-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    for (const [index, violation] of violations.slice(0, 24).entries()) {
      let element;
      try { element = [...document.querySelectorAll(violation.selector)].find((candidate) => candidate.getClientRects().length); } catch {}
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const marker = document.createElement("div");
      marker.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #ff375f;background:rgba(255,55,95,.09);box-sizing:border-box`;
      const label = document.createElement("span");
      label.textContent = `${index + 1} ${violation.type}`;
      label.style.cssText = "position:absolute;left:0;top:0;padding:2px 4px;background:#ff375f;color:white;font:10px/1.2 ui-monospace";
      marker.append(label);
      overlay.append(marker);
    }
    document.body.append(overlay);
  }, report.violations);
  await page.screenshot({ path: `${artifactRoot}/overlay.png`, fullPage: true });
  await testInfo.attach("layout-audit-overlay", { path: `${artifactRoot}/overlay.png`, contentType: "image/png" });
}
