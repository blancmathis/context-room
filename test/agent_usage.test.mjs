import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentUsageReport, initializeContextRoomProject, writeDocReviewDecision } from "../src/context_room.mjs";
import { claudeCodeProjectSlug } from "../src/agent_usage.mjs";

const NOW = Date.parse("2026-06-30T00:00:00.000Z");

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-agent-usage-")));
  const root = path.join(base, "project"), home = path.join(base, "claude");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(base, { recursive: true, force: true }); });
  for (const [file, text] of [["docs/a.md", "# a\n"], ["docs/b.md", "# b\n"], ["AGENTS.md", "# Agents\n"], [".claude/skills/demo/SKILL.md", "# demo\n"], [".claude/skills/unused/SKILL.md", "# unused\n"]]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  initializeContextRoomProject(root, { allowedPaths: ["docs/", "AGENTS.md"], watchAllow: ["docs/", "AGENTS.md"] });
  for (const file of ["docs/a.md", "docs/b.md", "AGENTS.md"]) writeDocReviewDecision(root, file, { status: "verified" });
  fs.mkdirSync(path.join(home, "projects", claudeCodeProjectSlug(root)), { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
  const write = (name, entries, tail = "") => fs.writeFileSync(path.join(home, "projects", claudeCodeProjectSlug(root), name),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" + tail);
  return { root, home, write };
}

const tool = (sessionId, cwd, timestamp, id, name, input) => ({ type: "assistant", sessionId, cwd, timestamp, message: { content: [{ type: "tool_use", id, name, input }] } });

test("context usage counts Claude Code skills and document reads once per session, with coverage", (t) => {
  const { root, home, write } = fixture(t);
  const at = "2026-06-29T10:00:00.000Z";
  const forked = tool("s1", root, at, "t1", "Skill", { skill: "demo" });
  write("s1.jsonl", [
    forked,
    tool("s1", root, at, "t2", "Read", { file_path: path.join(root, "docs/a.md") }),
    tool("s1", root, at, "t3", "Read", { file_path: "docs/a.md" }),
    tool("s1", root, at, "t4", "Bash", { command: "grep -n x docs/a.md | head; cat xdocs/b.md.bak" }),
    { type: "user", uuid: "u1", sessionId: "s1", cwd: root, timestamp: at, message: { content: "<command-name>/demo</command-name>" } },
    tool("s1", root, "2026-05-01T00:00:00.000Z", "t6", "Read", { file_path: path.join(root, "docs/b.md") }),
    tool("s1", "/elsewhere", at, "t7", "Read", { file_path: path.join(root, "docs/b.md") }),
  ]);
  write("s2.jsonl", [{ ...forked, sessionId: "s2" }, tool("s2", path.join(root, "docs"), "2026-06-28T00:00:00.000Z", "t5", "Skill", { skill: "demo" })], '{"type":"assistant"');

  const report = agentUsageReport(root, { now: NOW });
  assert.deepEqual(report.coverage, { complete: true, reasons: [], sessionFiles: 2, sessionsWithUse: 2, unreadableFiles: 0, unreadableLines: 0, retentionDays: 90, notCounted: "Codex and other agents" });
  assert.deepEqual(report.skills, [{ name: "demo", uses: 2, calls: 3, lastUsedAt: at }]);
  assert.deepEqual(report.documents, [{ path: "docs/a.md", uses: 1, calls: 3, lastUsedAt: at }]);
  assert.deepEqual(report.loadedAtStartup, ["AGENTS.md"]);
  assert.deepEqual(report.notUsed, { skills: ["unused"], documents: ["docs/b.md"] });

  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
  const shortRetention = agentUsageReport(root, { now: NOW });
  assert.deepEqual(shortRetention.coverage.reasons, ["retention-shorter-than-window"]);
  assert.equal(shortRetention.notUsed, null);

  fs.writeFileSync(path.join(home, "settings.json"), "{}");
  write("s3.jsonl", [], '{"type":"tool_use" broken\n');
  const corrupt = agentUsageReport(root, { now: NOW });
  assert.deepEqual(corrupt.coverage.reasons, ["unreadable-session-data"]);
  assert.equal(corrupt.notUsed, null);

  const other = path.join(path.dirname(root), "other");
  fs.mkdirSync(other);
  assert.deepEqual(agentUsageReport(other, { now: NOW }).coverage.reasons, ["no-sessions"]);
  assert.throws(() => agentUsageReport(root, { days: 0 }), /--days must be/);

  const cli = (...extra) => spawnSync(process.execPath, [path.resolve("bin/context-room.mjs"), "context", "usage", "--root", root, ...extra, "--format=json"], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  assert.notEqual(cli("--days", "400").status, 0);
  const ok = cli("--days", "365");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).data.provider, "claude-code");
});
