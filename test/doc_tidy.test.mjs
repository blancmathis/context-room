import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeDocumentTidiness, DOC_TIDY_LIMITS, headingSlugs } from "../src/doc_tidy.mjs";

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
