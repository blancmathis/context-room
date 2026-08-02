#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "src", "context_room.mjs");
const source = fs.readFileSync(sourcePath, "utf8");
const styleStart = source.indexOf("<style>");
const styleEnd = source.indexOf("</style>", styleStart);
if (styleStart < 0 || styleEnd < 0) throw new Error("Context Room embedded stylesheet was not found");
const css = source.slice(styleStart + "<style>".length, styleEnd);
const violations = [];
const geometryPattern = /\b(?:padding(?:-(?:inline|block|left|right|top|bottom))?|margin(?:-(?:inline|block|left|right|top|bottom))?|gap|row-gap|column-gap|inset|top|right|bottom|left|width|min-width|max-width|height|min-height|max-height|grid-template-columns|grid-template-rows)\s*:/;

for (const breakpoint of [640, 680, 900]) {
  const mediaPattern = new RegExp(`@media\\s*\\(max-width:\\s*${breakpoint}px\\)\\s*\\{`, "g");
  for (const match of css.matchAll(mediaPattern)) {
    const open = css.indexOf("{", match.index);
    let depth = 1;
    let end = open + 1;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      if (depth === 0) break;
    }
    const block = css.slice(match.index, end + 1);
    if (geometryPattern.test(block)) violations.push({ type: "legacy-breakpoint-geometry", breakpoint, excerpt: block.slice(0, 180).replace(/\s+/g, " ") });
  }
}

const requiredTokens = ["--workbench-gutter", "--workbench-gutter-compact", "--explorer-gutter", "--inspector-gutter", "--dialog-gutter"];
for (const token of requiredTokens) if (!css.includes(`${token}:`)) violations.push({ type: "missing-layout-token", token });

for (const marker of ["LAYOUT CONTRACT: START", "LAYOUT CONTRACT: END"]) if (!css.includes(marker)) violations.push({ type: "missing-authoritative-marker", marker });

const authoritativeStart = css.indexOf("LAYOUT CONTRACT: START");
const migratedSelectors = new Set([
  ".app > aside", ".sidebar-head", ".document-context-head", ".document-context-body", ".workspace-dock",
  ".review-item", ".settings-page", ".settings-page-header", ".settings-search", ".settings-search input",
  ".settings-search-icon", ".settings-panel", ".settings-shell", ".settings-tabs", ".settings-tab", ".settings-content",
  ".settings-section-head", ".settings-section-body", ".settings-footer", ".diff-header", ".file-panel header",
  ".context-room-review-toolbar", ".proposal-review-head", ".proposal-review-meta", ".proposal-review-file",
]);
const structuralPattern = /(?:^|;)\s*(?:display|flex-direction|padding(?:-(?:inline|block|left|right|top|bottom))?|margin(?:-(?:inline|block|left|right|top|bottom))?|gap|row-gap|column-gap|inset|top|right|bottom|left|width|min-width|max-width|height|min-height|max-height|grid-template-columns|grid-template-rows|align-items|justify-content|position|overflow(?:-x|-y)?)\s*:/;
const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
for (const match of css.matchAll(rulePattern)) {
  if (authoritativeStart < 0 || match.index >= authoritativeStart) continue;
  const selectors = match[1].trim().replace(/\s+/g, " ").split(",").map((selector) => selector.trim());
  const migrated = selectors.filter((selector) => migratedSelectors.has(selector));
  if (migrated.length && structuralPattern.test(match[2])) violations.push({ type: "geometry-outside-authoritative-section", selectors: migrated });
}

const allowedBreakpoints = [...css.matchAll(/@media\s*\((?:min|max)-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
const unsupported = [...new Set(allowedBreakpoints.filter((value) => ![639, 980, 981, 1279, 1280].includes(value)))];
if (unsupported.length) violations.push({ type: "unsupported-responsive-tier", breakpoints: unsupported });

const report = { schemaVersion: "context-room.layout-css/1", source: path.relative(root, sourcePath), violations };
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
else if (violations.length) process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write("Layout CSS audit passed.\n");
if (violations.length) process.exitCode = 1;
