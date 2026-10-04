import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeContextLosses, codexProjectDocLimit } from "../src/context_losses.mjs";

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-losses-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, home, write };
}

function entry(kind, file, { scope = "project", order = 0, version = file } = {}) {
  return {
    resource: { id: "file://" + file, kind, locator: file, version, metadata: { absolutePath: file } },
    application: { status: "active", scope, order },
  };
}

test("Codex drops project instructions past project_doc_max_bytes and warns from 80 %", (t) => {
  const { root, home, write } = workspace(t);
  const first = write(path.join(root, "AGENTS.md"), "a".repeat(20_000));
  const second = write(path.join(root, "pkg/AGENTS.md"), "b".repeat(20_000));
  const global = write(path.join(home, ".codex/AGENTS.md"), "g".repeat(40_000));
  const effective = { coordinate: { provider: "codex" }, instructions: [entry("instruction", global, { scope: "device" }), entry("instruction", first, { order: 1 }), entry("instruction", second, { order: 2 })], skills: [] };

  const exceeded = analyzeContextLosses(effective, { root, home });
  assert.deepEqual(exceeded.map((item) => [item.type, item.severity, item.path]), [["instruction_limit", "high", second]]);
  assert.match(exceeded[0].message, /Codex drops 7232 bytes/);
  assert.match(exceeded[0].evidence, /40000 of 32768 bytes \(Codex default\)/);

  write(path.join(home, ".codex/config.toml"), "project_doc_max_bytes = 49152\n\n[profiles.x]\nproject_doc_max_bytes = 1\n");
  assert.equal(codexProjectDocLimit({ root, home }).limit, 49152);
  const near = analyzeContextLosses(effective, { root, home });
  assert.deepEqual(near.map((item) => [item.type, item.severity]), [["instruction_limit", "low"]]);
  assert.equal(analyzeContextLosses({ ...effective, coordinate: { provider: "claude-code" } }, { root, home }).length, 0);
});

test("duplicates, dead paths, missing scripts, and skill descriptions cite their source", (t) => {
  const { root, home, write } = workspace(t);
  write(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "x" } }));
  write(path.join(root, "docs/real.md"), "# Real\n");
  write(path.join(home, "tools/run.py"), "#!/bin/sh\n");
  const agents = write(path.join(root, "AGENTS.md"), [
    "Read `docs/real.md`, `docs/missing.md` and `notes.md`.",
    "Run `npm test`, `npm run build`, `npm run lint`, `npm install` and `pnpm deploy`.",
    "Home tools: `~/tools/run.py` and `~/tools/gone.py`.",
  ].join("\n"));
  const copy = write(path.join(root, "sub/AGENTS.md"), fs.readFileSync(agents, "utf8"));
  const global = write(path.join(home, ".codex/AGENTS.md"), "Elsewhere: `docs/other.md` and `~/tools/gone.py`.\n");
  const skill = write(path.join(home, "skills/a/SKILL.md"), "---\nname: a\ndescription: >\n  " + "x".repeat(1100) + "\n---\nUse `scripts/run.py`.\n");
  write(path.join(home, "skills/a/scripts/run.py"), "");
  const bare = write(path.join(home, "skills/b/SKILL.md"), "---\nname: b\n---\nBody\n");

  const findings = analyzeContextLosses({
    coordinate: { provider: "claude-code" },
    instructions: [
      entry("instruction", global, { scope: "device", order: 0 }),
      entry("instruction", agents, { order: 1, version: "same" }),
      entry("instruction", copy, { order: 2, version: "same" }),
    ],
    skills: [entry("skill", skill, { scope: "device", order: 3 }), entry("skill", bare, { scope: "device", order: 4 })],
  }, { root, home });
  const summary = findings.map((item) => [item.type, path.relative(path.dirname(root), item.path), item.evidence]);
  assert.deepEqual(summary, [
    ["duplicate_context", "project/sub/AGENTS.md", agents],
    ["dead_path", "home/.codex/AGENTS.md", "~/tools/gone.py"],
    ["dead_path", "project/AGENTS.md", "docs/missing.md"],
    ["dead_path", "project/AGENTS.md", "~/tools/gone.py"],
    ["missing_command", "project/AGENTS.md", "npm run lint"],
    ["missing_command", "project/AGENTS.md", "pnpm deploy"],
    ["dead_path", "project/sub/AGENTS.md", "docs/missing.md"],
    ["dead_path", "project/sub/AGENTS.md", "~/tools/gone.py"],
    ["missing_command", "project/sub/AGENTS.md", "npm run lint"],
    ["missing_command", "project/sub/AGENTS.md", "pnpm deploy"],
    ["skill_description", "home/skills/a/SKILL.md", "1100 characters"],
    ["skill_description", "home/skills/b/SKILL.md", "no description"],
  ]);
  for (const item of findings) assert.ok(item.rule && item.message.endsWith("."), item.type);
  assert.equal(findings.find((item) => item.evidence === "docs/missing.md").line, 1);
});
