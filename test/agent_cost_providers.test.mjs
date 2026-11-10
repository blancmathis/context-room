import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { contextCost } from "../src/context_cost.mjs";

const cli = path.resolve("bin/context-room.mjs");

function lab(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-cost-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, "home"), config = path.join(temp, "config"), root = path.join(temp, "project");
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write(path.join(home, ".claude/CLAUDE.md"), "# home claude\n");
  write(path.join(home, ".claude/skills/home-skill/SKILL.md"), "---\nname: home-skill\ndescription: from home\n---\nbody\n");
  write(path.join(config, "CLAUDE.md"), "# config dir claude\n");
  write(path.join(config, "skills/config-skill/SKILL.md"), "---\nname: config-skill\ndescription: from config\n---\nbody\n");
  write(path.join(home, ".codex/AGENTS.md"), "# codex home\n");
  write(path.join(root, "AGENTS.md"), "# Agents\nrules\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  const env = { ...process.env, HOME: home, CONTEXT_ROOM_HUB_HOME: path.join(temp, "hub"), CONTEXT_ROOM_SHARED_HOME: path.join(temp, "shared"), CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: path.join(temp, "ra") };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  // A Claude Code version that loads AGENTS.md, first on PATH, so the result never depends on the machine's own install.
  fs.mkdirSync(path.join(temp, "bin")); fs.mkdirSync(path.join(temp, "versions"));
  fs.writeFileSync(path.join(temp, "versions/9.9.9"), "");
  fs.symlinkSync(path.join(temp, "versions/9.9.9"), path.join(temp, "bin/claude"));
  env.PATH = `${path.join(temp, "bin")}${path.delimiter}${env.PATH || ""}`;
  let run;
  run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args, "--root", root], { encoding: "utf8", env: { ...env, ...extra }, cwd: root });
  const effective = (provider, extra) => { const r = run(["context", "effective", "--provider", provider], extra); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout).data; };
  const init = run(["init"]); assert.equal(init.status, 0, init.stderr + init.stdout);
  return { run, effective, home, config, root };
}
const names = (data, kind = "instructions") => data[kind].map((entry) => entry.resource.locator);

test("--provider all lists what every agent loads, not Codex alone", (t) => {
  const { effective } = lab(t);
  const all = effective("all");
  assert.ok(names(all).some((name) => name.endsWith("/.claude/CLAUDE.md")), names(all).join());
  assert.ok(names(all).some((name) => name.endsWith("/.codex/AGENTS.md")), names(all).join());
  assert.ok(names(all, "skills").some((name) => name.includes("home-skill")));
});

test("CLAUDE_CONFIG_DIR replaces ~/.claude for Claude Code", (t) => {
  const { effective, config } = lab(t);
  const data = effective("claude-code", { CLAUDE_CONFIG_DIR: config });
  assert.ok(names(data).some((name) => name === path.join(config, "CLAUDE.md")), names(data).join());
  assert.ok(!names(data).some((name) => name.endsWith("/home/.claude/CLAUDE.md")));
  assert.ok(names(data, "skills").some((name) => name.includes("config-skill")));
  assert.ok(!names(data, "skills").some((name) => name.includes("home-skill")));
});

test("--format human prints text for context effective", (t) => {
  const { run } = lab(t);
  const r = run(["context", "effective", "--provider", "claude-code", "--format", "human"]);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => JSON.parse(r.stdout));
  assert.match(r.stdout, /Effective context/);
  assert.match(r.stdout, /AGENTS\.md/);
});

test("a file reached by two resources is counted once at startup", () => {
  const file = path.resolve("AGENTS.md");
  const entry = (id, scope) => ({ resource: { id, kind: "instruction", metadata: { absolutePath: file } }, application: { status: "active", scope } });
  const effective = { coordinate: { provider: "claude-code" }, instructions: [entry("local", "project"), entry("shared", "context-room")], skills: [], hooks: [], providerConfigs: [], mcpServers: [], unknown: [] };
  const single = contextCost({ ...effective, instructions: [entry("local", "project")] }, { root: process.cwd() });
  const double = contextCost(effective, { root: process.cwd() });
  assert.equal(double.startup.tokens, single.startup.tokens);
  assert.equal(double.startup.resources, 1);
});

test("a Shared link that is still uncertain does not count the local AGENTS.md twice", () => {
  const file = path.resolve("AGENTS.md");
  const entry = (id, status) => ({ resource: { id, kind: "instruction", metadata: { absolutePath: file } }, application: { status, scope: "project" } });
  const effective = { coordinate: { provider: "claude-code" }, instructions: [entry("local", "active"), entry("shared", "uncertain")], skills: [], hooks: [], providerConfigs: [], mcpServers: [], unknown: [] };
  const single = contextCost({ ...effective, instructions: [entry("local", "active")] }, { root: process.cwd() });
  const double = contextCost(effective, { root: process.cwd() });
  assert.equal(double.startup.tokens, single.startup.tokens);
  assert.equal(double.startup.resources, 1);
});
