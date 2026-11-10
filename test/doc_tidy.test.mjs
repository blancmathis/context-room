import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeDocumentTidiness, DOC_TIDY_LIMITS, DOC_TIDY_RULES, headingSlugs, reviewVersionChecks } from "../src/doc_tidy.mjs";

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-tidy-"));
  for (const [relPath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), content);
  }
  const docs = Object.entries(files).map(([relPath, content]) => ({ path: relPath, content }));
  return { root, docs };
}

const prose = (label) => "This document explains " + label + " for readers and agents in a few short sentences.";

test("each tidiness rule cites its rule, source, and one action", () => {
  const shared = "Shared paragraph. ".repeat(20);
  const growing = "# Status\n\n" + prose("status") + "\n\n" + "- entry line\n".repeat(3000);
  const { root, docs } = project({
    "docs/index.md": "# Docs\n\n" + prose("the map") + "\n\n- [A](a.md)\n- [Status](status.md)\n- [Big](big.md)\n",
    "docs/a.md": "# A\n\n" + prose("A") + "\n\nSee [B](b.md#intro), [gone](missing.md), [bad anchor](status.md#nowhere) and [abs](" + "/tmp/outside.md).\n\n" + shared + "\n",
    "docs/b.md": "# B\n\n## Intro\n\n" + prose("B") + "\n\n" + shared + "\n",
    "docs/status.md": growing,
    "docs/big.md": "# Big\n\n## Details\n\n- " + "x".repeat(DOC_TIDY_LIMITS.agentReadChars) + "\n",
  });
  const history = (relPath) => relPath === "docs/status.md" ? { commits: 30, added: 900, deleted: 40 } : { commits: 30, added: 100, deleted: 90 };
  const { findings, summary } = analyzeDocumentTidiness({ root, docs, history });
  const types = (relPath) => findings.filter((item) => item.path === relPath).map((item) => item.type).sort();

  assert.deepEqual(types("docs/b.md"), ["doc_not_in_map", "duplicate_block"]);
  assert.deepEqual(types("docs/a.md"), ["dead_link", "dead_link"]);
  assert.deepEqual(findings.filter((item) => item.type === "dead_link").map((item) => item.evidence).sort(), ["missing.md", "status.md#nowhere"]);
  assert.deepEqual(types("docs/status.md"), ["log_in_state_doc"]);
  assert.deepEqual(types("docs/big.md"), ["doc_too_large", "missing_summary"]);
  assert.equal(findings.find((item) => item.type === "duplicate_block").evidence, "docs/a.md:7");
  for (const item of findings) {
    assert.ok(item.rule && item.evidence && Number.isInteger(item.line), item.type);
    assert.match(item.message, /\.$/);
  }
  assert.deepEqual(summary, { documents: 5, map: "docs/index.md", history: true });
});

test("a growing journal path, a missing map, or missing git history yields no guess", () => {
  const body = (label) => "# " + label + "\n\n" + prose(label) + "\n\n" + ("- " + label + " entry\n").repeat(6000);
  const { root, docs } = project({ "docs/journal/2026-10.md": body("log"), "docs/STATUS.md": body("status"), "docs/orphan.md": "# Orphan\n\n" + prose("orphans") + "\n" });
  const { findings, summary } = analyzeDocumentTidiness({ root, docs, history: () => null });
  assert.deepEqual(findings, []);
  assert.deepEqual(summary, { documents: 3, map: null, history: false });
});

test("heading slugs follow GitHub anchors and ignore code blocks", () => {
  const slugs = headingSlugs("# Title\n\n## Déjà vu: the API!\n\n```\n# not a heading\n```\n\n## Title\n");
  assert.deepEqual([...slugs].sort(), ["déjà-vu-the-api", "title", "title-1"]);
});

const VOCABULARY = "agent alpha archive backup branch bridge build cache canvas channel check client cloud commit config copy cursor daemon delta deploy device disk draft engine error event export field filter folder format gate graph guard hash header host index input issue job journal kernel key label layer limit link list lock log loop mail map memory merge mirror mode model module mount node note number object offset option order owner packet page panel parser patch path peer pipe policy port prompt proxy queue quota range reader record region release report request retry review role route rule runner schema scope script search secret server session shard signal skill slot snapshot socket source space stack state status step store stream table tablet target task thread token topic trace tree trigger update upload user value vault version view volume watch window worker".split(" ");
const article = (topic, count = 12) => { let seed = [...topic].reduce((total, char) => total * 31 + char.charCodeAt(0), 7) >>> 0; const word = () => VOCABULARY[(seed = (seed * 1103515245 + 12345) >>> 0) % VOCABULARY.length]; return Array.from({ length: count }, () => Array.from({ length: 30 }, word).join(" ") + ".").join("\n\n"); };

test("a document that repeats most of another is reported once as a likely duplicate", () => {
  const block = article("shared steps", 3).replace(/\n\n/g, " ");
  const original = "# Deploy\n\n" + article("deploy") + "\n\n" + block + "\n";
  const { root, docs } = project({
    "docs/index.md": "# Docs\n\n" + prose("the map") + "\n\n- [Deploy](deploy.md)\n- [Copy](deploy-copy.md)\n- [Backup](backup.md)\n",
    "docs/deploy.md": original,
    "docs/deploy-copy.md": "# Deploy (copy)\n\n" + prose("the copy") + "\n\n" + article("deploy", 10) + "\n\n" + block + "\n",
    "docs/backup.md": "# Backup\n\n" + article("backup") + "\n",
  });
  const { findings } = analyzeDocumentTidiness({ root, docs, history: () => null });
  const duplicates = findings.filter((item) => item.type === "duplicate_doc");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].path, "docs/deploy-copy.md");
  assert.equal(duplicates[0].evidence, "docs/deploy.md");
  assert.match(duplicates[0].message, /^Likely duplicate of docs\/deploy\.md \(\d+% of word sequences shared\)\. Keep one document and link to it\.$/);
  assert.equal(findings.some((item) => item.type === "duplicate_block" && item.path === "docs/deploy.md" && item.evidence.startsWith("docs/deploy-copy.md:")), true, "the whole-document finding adds to the block findings");
  assert.ok(DOC_TIDY_RULES.duplicate_doc);
});

test("documents built from one template are not likely duplicates, near-copies still are", () => {
  const template = (index, body) => `# ADR ${index}\n\n## Context\n\n${article("template context", 4)}\n\n## Decision\n\n${body}\n\n## Consequences\n\n${article("template consequences", 4)}\n`;
  const files = { "docs/index.md": "# Docs\n\n" + prose("the map") + "\n" };
  for (let index = 1; index <= 10; index += 1) files[`docs/adr/${index}.md`] = template(index, article(`decision ${index}`, 3));
  files["docs/release.md"] = "# Release\n\n" + article("release") + "\n";
  files["docs/release-copy.md"] = "# Release copy\n\n" + article("release", 11) + "\n";
  const { root, docs } = project(files);
  const { findings } = analyzeDocumentTidiness({ root, docs, history: () => null });
  assert.deepEqual(findings.filter((item) => item.type === "duplicate_doc").map((item) => `${item.path}>${item.evidence}`), ["docs/release-copy.md>docs/release.md"]);
  const others = Object.entries(files).filter(([rel]) => rel !== "docs/adr/3.md").map(([rel, content]) => ({ path: rel, content }));
  const checks = reviewVersionChecks({ root, path: "docs/adr/3.md", before: files["docs/adr/3.md"], after: template(3, article("decision three again", 3)), others });
  assert.equal(checks.some((item) => item.type === "duplicate_doc"), false);
});

test("review checks show only the dead links a version adds and a likely duplicate", () => {
  const { root } = project({
    "docs/index.md": "# Docs\n\n" + prose("the map") + "\n",
    "docs/deploy.md": "# Deploy\n\n" + article("deploy") + "\n",
  });
  const before = "# Notes\n\n" + prose("notes") + " See [old](old-gone.md).\n";
  const after = before + "\nAlso [new](new-gone.md) and [deploy](deploy.md#nowhere).\n\n" + article("deploy") + "\n";
  const others = [{ path: "docs/deploy.md", content: fs.readFileSync(path.join(root, "docs/deploy.md"), "utf8") }, { path: "docs/notes.md", content: before }];
  const checks = reviewVersionChecks({ root, path: "docs/notes.md", before, after, others });
  assert.deepEqual(checks.filter((item) => item.type === "dead_link").map((item) => item.evidence).sort(), ["deploy.md#nowhere", "new-gone.md"]);
  const duplicate = checks.find((item) => item.type === "duplicate_doc");
  assert.equal(duplicate.path, "docs/notes.md");
  assert.equal(duplicate.evidence, "docs/deploy.md");
  assert.deepEqual(reviewVersionChecks({ root, path: "docs/notes.md", before, after: before, others }), []);
  assert.deepEqual(reviewVersionChecks({ root, path: "docs/image.png", before: null, after: "x", others }), []);
});
