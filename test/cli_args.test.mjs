import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CONFIG_FILE, REVIEW_GATE_FILE } from "../src/context_room.mjs";

const cli = path.resolve("bin/context-room.mjs");
const packageVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version;

function makeRoot(t, name = "project") {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-cli-"));
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return root;
}

test("CLI accepts equals-style root and title options", (t) => {
  const root = makeRoot(t, "Project With Spaces");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");

  const result = spawnSync(
    process.execPath,
    [cli, "init", `--root=${root}`, "--title=Equals Style Project", "--watch=docs/"],
    { cwd: path.dirname(root), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
  assert.equal(saved.title, "Equals Style Project");
  assert.deepEqual(saved.watchAllow, ["docs/"]);
  assert.match(result.stdout, new RegExp(`Context Room initialized: ${path.join(root, CONFIG_FILE)}`));
  assert.match(result.stdout, /Agent next step: read .* and follow its setup checklist\./);
  assert.match(result.stdout, new RegExp(`Run: context-room setup --root '${root}'`));

  const repeated = spawnSync(process.execPath, [cli, "init", `--root=${root}`], { encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Documentation discovery skipped: the existing configuration was preserved\./);
});

test("CLI --version exits without initializing a project", (t) => {
  const root = makeRoot(t);
  const missingRoot = path.join(root, "does-not-exist");
  const result = spawnSync(process.execPath, [cli, "--version", `--root=${missingRoot}`], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageVersion);
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
  assert.equal(fs.existsSync(missingRoot), false);
});

test("agent help explains capabilities, commands, and the human-owned review decision without writing project state", (t) => {
  const root = makeRoot(t);
  const result = spawnSync(process.execPath, [cli, "agent", "help", `--root=${root}`], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Context Room Agent CLI/);
  assert.match(result.stdout, /Give this to your agent/);
  assert.match(result.stdout, /context-room capabilities/);
  assert.doesNotMatch(result.stdout, /capabilities --intent/);
  assert.match(result.stdout, /context-room review list --root \./);
  assert.match(result.stdout, /context-room agent watch --root \./);
  assert.match(result.stdout, /context-room context ask/);
  assert.doesNotMatch(result.stdout, /context-room brief --root \./);
  assert.doesNotMatch(result.stdout, /context-room agent queue --root \./);
  assert.match(result.stdout, /context-room doctor --root \./);
  assert.match(result.stdout, /More CLI capabilities/);
  assert.match(result.stdout, /shared skills status\|effective\|explain\|reconcile\|assign\|unassign\|link\|unlink\|import/);
  assert.match(result.stdout, /Only a human can accept or reject each file awaiting review/);
  assert.match(result.stdout, /does not require a separate human decision/);
  assert.doesNotMatch(result.stdout, /owner-controlled review gate/);
  assert.equal(fs.existsSync(path.join(root, ".context-room")), false);
});

test("redundant discovery and compatibility commands are not executable", () => {
  for (const argv of [
    ["resolve", "--intent=test"],
    ["capabilities", "--intent=test"],
    ["docs", "capabilities"],
    ["events"],
    ["review", "follow"],
    ["agent", "environment"],
    ["agent", "explain", "AGENTS.md"],
    ["agent", "queue"],
    ["agent", "review-queue"],
    ["brief"],
    ["hub", "start"],
    ["hub", "status"],
    ["agent", "navigate"],
    ["shared", "connect"],
    ["shared", "list"],
    ["shared", "proposal-create"],
    ["shared", "proposal-push"],
    ["install-hook"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...argv, "--format=json"], { encoding: "utf8" });
    assert.notEqual(result.status, 0, argv.join(" "));
  }
});

test("agent-first CLI emits versioned envelopes, caches prepare, and previews mutations without applying them", (t) => {
  const root = makeRoot(t);
  const hubHome = path.join(path.dirname(root), "hub-home");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  let result = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--watch=docs/"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const env = { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome };

  result = spawnSync(process.execPath, [cli, "capabilities", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.schemaVersion, "context-room.cli/1");
  assert.equal(capabilities.data.contractAudience, "ai-agent");
  assert.equal(capabilities.data.commands.some((item) => /accept|reject|verify/.test(item.path)), false);
  assert.equal(capabilities.data.commands.some((item) => item.path === "agent environment"), false);

  const registrationPlanResult = spawnSync(process.execPath, [cli, "project", "register", `--root=${root}`, "--format=json"], { encoding: "utf8", env });
  assert.equal(registrationPlanResult.status, 0, registrationPlanResult.stderr);
  const registrationPlan = JSON.parse(registrationPlanResult.stdout).data.planId;
  result = spawnSync(process.execPath, [cli, "project", "register", `--root=${root}`, `--apply=${registrationPlan}`, "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const before = fs.readFileSync(path.join(root, CONFIG_FILE), "utf8");
  result = spawnSync(process.execPath, [cli, "agent", "watch", `--root=${root}`, "--path=other/", "--plan", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).data.planId, /^plan-/);
  assert.equal(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"), before);

  const prepareArgs = [cli, "agent", "prepare", `--root=${root}`, "--task=Read guide", "--format=json"];
  const cold = spawnSync(process.execPath, prepareArgs, { encoding: "utf8", env });
  const warm = spawnSync(process.execPath, prepareArgs, { encoding: "utf8", env });
  assert.equal(cold.status, 0, cold.stderr);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(JSON.parse(cold.stdout).freshness.cache, "cold");
  assert.equal(JSON.parse(warm.stdout).freshness.cache, "warm");

  result = spawnSync(process.execPath, [cli, "agent", "prepare", "--project=missing-project", "--task=Read guide", "--non-interactive", "--format=json"], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "unknown-project");
  assert.doesNotMatch(result.stderr, /choose interactively|\?\s*$/i);

  result = spawnSync(process.execPath, [cli, "completion", "zsh"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /#compdef context-room/);
});

test("Context Engine CLI resolves, snapshots, diffs, and paginates one accepted local context", (t) => {
  const root = makeRoot(t, "Context Engine");
  const hubHome = path.join(path.dirname(root), "hub-context-engine");
  fs.mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  const env = { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome, CONTEXT_ROOM_SNAPSHOT_HOME: path.join(path.dirname(root), "snapshots") };
  let result = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--allow=AGENTS.md,docs/", "--watch=AGENTS.md,docs/"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync(process.execPath, [cli, "context", "effective", `--root=${root}`, "--provider=codex", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const effective = JSON.parse(result.stdout);
  assert.equal(effective.ok, true);
  assert.equal(effective.data.schemaVersion, "context-room.context-effective/1");
  assert.equal(effective.data.proposals instanceof Array, true);

  result = spawnSync(process.execPath, [cli, "context", "graph", `--root=${root}`, "--provider=codex", "--limit=1", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout).data;
  assert.equal(graph.resources.length, 1);
  assert.equal(graph.pagination.limit, 1);

  result = spawnSync(process.execPath, [cli, "context", "impact", `--root=${root}`, "--provider=codex", "--limit=1", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.impacts.length, 1);

  result = spawnSync(process.execPath, [cli, "context", "snapshot", `--root=${root}`, "--provider=codex", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const snapshotId = JSON.parse(result.stdout).data.manifest.snapshotId;
  assert.match(snapshotId, /^[a-f0-9]{64}$/);

  result = spawnSync(process.execPath, [cli, "context", "diff", `--root=${root}`, "--provider=codex", `--from=${snapshotId}`, "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.resources.modified, []);
});

test("Settings CLI applies only an exact typed plan and emits the changed state", (t) => {
  const root = makeRoot(t, "Settings CLI");
  const hubHome = path.join(path.dirname(root), "hub-settings-cli");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  const env = { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome };
  let result = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--allow=docs/", "--watch=docs/"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync(process.execPath, [cli, "settings", "plan", `--root=${root}`, "--set=startupSkills.enabled=false", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout).data;
  assert.match(plan.planId, /^plan-/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8")).startupSkills.enabled, true);

  result = spawnSync(process.execPath, [cli, "settings", "apply", plan.planId, `--root=${root}`, "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.settingsChangedEvent, "settings.changed");

  result = spawnSync(process.execPath, [cli, "settings", "get", "startupSkills.enabled", `--root=${root}`, "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.value, false);

  result = spawnSync(process.execPath, [cli, "settings", "plan", `--root=${root}`, "--set=appearance.theme=dark", "--format=json"], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error.code, "setting-not-manageable");
});

test("CLI treats an equals-style occupied port as explicit and leaves its listener running", async (t) => {
  const root = makeRoot(t);
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const port = occupied.address().port;

  const result = spawnSync(
    process.execPath,
    [cli, "setup", `--root=${root}`, `--port=${port}`],
    { encoding: "utf8", timeout: 10_000 },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`port ${port} is already in use`, "i"));
  assert.doesNotMatch(result.stdout, /selected \d+ without stopping another Context Room/);
  assert.equal(occupied.listening, true);
  assert.equal(occupied.address().port, port);
  assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
});

test("failed setup validation preserves an existing config byte-for-byte", async (t) => {
  const root = makeRoot(t);
  const initialized = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--title=Original"], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = path.join(root, CONFIG_FILE);
  const before = fs.readFileSync(configPath, "utf8");

  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));

  const result = spawnSync(process.execPath, [
    cli,
    "setup",
    `--root=${root}`,
    "--title=Must Not Be Written",
    `--port=${occupied.address().port}`,
  ], { encoding: "utf8", timeout: 10_000 });

  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("CLI rejects empty or missing option values before setup", (t) => {
  const root = makeRoot(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-cli-empty-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const emptyRoot = spawnSync(process.execPath, [cli, "init", "--root="], {
    cwd: scratch,
    encoding: "utf8",
  });
  assert.equal(emptyRoot.status, 2);
  assert.match(emptyRoot.stderr, /--root requires a path/);

  const emptyTitle = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--title="], {
    encoding: "utf8",
  });
  assert.equal(emptyTitle.status, 2);
  assert.match(emptyTitle.stderr, /--title requires a value/);

  const emptyPort = spawnSync(process.execPath, [cli, "setup", `--root=${root}`, "--port="], {
    encoding: "utf8",
  });
  assert.equal(emptyPort.status, 2);
  assert.match(emptyPort.stderr, /--port requires a number/);

  const missingAllow = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--allow"], {
    encoding: "utf8",
  });
  assert.equal(missingAllow.status, 2);
  assert.match(missingAllow.stderr, /--allow requires a path list/);

  const missingWatch = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--watch"], {
    encoding: "utf8",
  });
  assert.equal(missingWatch.status, 2);
  assert.match(missingWatch.stderr, /--watch requires a path list/);

  assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
  assert.equal(fs.existsSync(path.join(scratch, CONFIG_FILE)), false);
});

test("agent watch exposes every folder mode, defaults to recursive live, and unwatch removes the rule", (t) => {
  const root = makeRoot(t);
  fs.mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "docs", "nested", "deep.md"), "# Deep\n");

  const initialized = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--allow=docs/"], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const modes = ["recursive-live", "recursive-current", "direct-current", "direct-live"];
  const expectedMatchedFiles = new Map([
    ["recursive-live", null],
    ["recursive-current", 2],
    ["direct-current", 1],
    ["direct-live", null],
  ]);
  for (const mode of modes) {
    const modeArgs = mode === "recursive-live" ? [] : [`--mode=${mode}`];
    const watched = spawnSync(
      process.execPath,
      [cli, "agent", "watch", `--root=${root}`, "--path=docs/", ...modeArgs],
      { encoding: "utf8" },
    );

    assert.equal(watched.status, 0, watched.stderr);
    const output = JSON.parse(watched.stdout);
    assert.equal(output.rule.path, "docs/");
    assert.equal(output.rule.mode, mode);
    assert.equal(output.matchedFiles, expectedMatchedFiles.get(mode));
    const saved = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    assert.equal(saved.watchRules.at(-1).path, "docs/");
    assert.equal(saved.watchRules.at(-1).mode, mode);
    if (mode.endsWith("-current")) assert.ok(Array.isArray(output.rule.files));
    else assert.equal("files" in output.rule, false);
  }

  const unwatched = spawnSync(
    process.execPath,
    [cli, "agent", "unwatch", `--root=${root}`, "--path=docs/"],
    { encoding: "utf8" },
  );
  assert.equal(unwatched.status, 0, unwatched.stderr);
  const output = JSON.parse(unwatched.stdout);
  assert.equal(output.path, "docs/");
  assert.equal(output.removed, true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
  assert.equal(saved.watchRules.some((rule) => rule.path === "docs/"), false);
  assert.equal(saved.watchAllow.includes("docs/"), false);
});

test("agent watch accepts an explicitly allowed external home folder", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-cli-home-"));
  const root = path.join(home, "project");
  const externalRoot = path.join(home, "shared");
  fs.mkdirSync(path.join(externalRoot, "nested"), { recursive: true });
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(externalRoot, "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(externalRoot, "nested", "deep.md"), "# Deep\n");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };

  const initialized = spawnSync(
    process.execPath,
    [cli, "init", `--root=${root}`, "--allow=~/shared/"],
    { encoding: "utf8", env },
  );
  assert.equal(initialized.status, 0, initialized.stderr);

  const watched = spawnSync(
    process.execPath,
    [cli, "agent", "watch", `--root=${root}`, "--path=~/shared/", "--mode=direct-current"],
    { encoding: "utf8", env },
  );
  assert.equal(watched.status, 0, watched.stderr);
  const output = JSON.parse(watched.stdout);
  assert.equal(output.rule.path, "~/shared/");
  assert.equal(output.rule.mode, "direct-current");
  assert.deepEqual(output.rule.files, ["~/shared/guide.md"]);
  assert.equal(output.matchedFiles, 1);
});

test("agent watch validates its path and mode before changing configuration", (t) => {
  const root = makeRoot(t);
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");

  const initialized = spawnSync(process.execPath, [cli, "init", `--root=${root}`, "--allow=docs/"], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = path.join(root, CONFIG_FILE);
  const before = fs.readFileSync(configPath, "utf8");

  const missingPath = spawnSync(process.execPath, [cli, "agent", "watch", `--root=${root}`], { encoding: "utf8" });
  assert.equal(missingPath.status, 2);
  assert.match(missingPath.stderr, /Usage: context-room agent watch/);

  const missingMode = spawnSync(
    process.execPath,
    [cli, "agent", "watch", `--root=${root}`, "--path=docs/", "--mode"],
    { encoding: "utf8" },
  );
  assert.equal(missingMode.status, 2);
  assert.match(missingMode.stderr, /--mode requires a folder watch mode/);

  const invalidMode = spawnSync(
    process.execPath,
    [cli, "agent", "watch", `--root=${root}`, "--path=docs/", "--mode=forever"],
    { encoding: "utf8" },
  );
  assert.equal(invalidMode.status, 2);
  assert.match(invalidMode.stderr, /Unknown folder watch mode: forever/);

  const missingUnwatchPath = spawnSync(
    process.execPath,
    [cli, "agent", "unwatch", `--root=${root}`],
    { encoding: "utf8" },
  );
  assert.equal(missingUnwatchPath.status, 2);
  assert.match(missingUnwatchPath.stderr, /Usage: context-room agent unwatch/);

  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("CLI rejects unknown options, invalid ports, and missing roots before writing", (t) => {
  const root = makeRoot(t);
  const missingRoot = path.join(root, "typo-project");

  const unknown = spawnSync(process.execPath, [cli, "init", "--roo", missingRoot], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option: --roo/);

  for (const port of ["not-a-port", "0", "65536"]) {
    const invalidPort = spawnSync(process.execPath, [cli, "setup", `--root=${root}`, `--port=${port}`], {
      encoding: "utf8",
    });
    assert.equal(invalidPort.status, 1);
    assert.match(invalidPort.stderr, /Invalid Context Room port/);
  }

  const missing = spawnSync(process.execPath, [cli, "init", `--root=${missingRoot}`], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /root must be an existing directory/);
  assert.equal(fs.existsSync(missingRoot), false);
  assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
});

test("malformed config errors stay concise and preserve the file", (t) => {
  const root = makeRoot(t);
  const configPath = path.join(root, CONFIG_FILE);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{ malformed\n");

  for (const command of ["init", "setup"]) {
    const result = spawnSync(process.execPath, [cli, command, `--root=${root}`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Context Room (?:initialization|setup|Hub) failed: Invalid Context Room config JSON/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(fs.readFileSync(configPath, "utf8"), "{ malformed\n");
  }

  const doctor = spawnSync(process.execPath, [cli, "doctor", `--root=${root}`], { encoding: "utf8" });
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /Context Room OK/);
  assert.match(doctor.stdout + doctor.stderr, /\[critical\].*Invalid Context Room config JSON/);

  const strictDoctor = spawnSync(process.execPath, [cli, "doctor", `--root=${root}`, "--strict"], { encoding: "utf8" });
  assert.notEqual(strictDoctor.status, 0);
  assert.doesNotMatch(strictDoctor.stdout + strictDoctor.stderr, /Context Room OK/);
  assert.equal(fs.readFileSync(configPath, "utf8"), "{ malformed\n");
});

test("doctor reports a malformed owner review gate as critical", (t) => {
  const root = makeRoot(t);
  const initialized = spawnSync(process.execPath, [cli, "init", `--root=${root}`], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const reviewGatePath = path.join(root, REVIEW_GATE_FILE);
  fs.writeFileSync(reviewGatePath, "{ malformed\n");

  const doctor = spawnSync(process.execPath, [cli, "doctor", `--root=${root}`], { encoding: "utf8" });
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /Context Room OK/);
  assert.match(doctor.stdout + doctor.stderr, /\[critical\].*Invalid Context Room review gate JSON/);

  const strictDoctor = spawnSync(process.execPath, [cli, "doctor", `--root=${root}`, "--strict"], { encoding: "utf8" });
  assert.notEqual(strictDoctor.status, 0);
  assert.equal(fs.readFileSync(reviewGatePath, "utf8"), "{ malformed\n");
});
