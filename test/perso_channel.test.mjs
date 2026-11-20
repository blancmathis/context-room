import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/perso.sh");
function run(home, arg, env = {}) {
  return spawnSync("bash", [script, arg], { encoding: "utf8", env: { ...process.env, PERSO_HOME: home, PERSO_PORT: "1", NO_INSTALL: "1", ...env } });
}
function release(home, name, format) {
  const dir = path.join(home, "releases", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "perso.json"), JSON.stringify({ sha: name, branch: "main", builtAt: "2026-11-20T00:00:00Z", dataFormat: format }));
}

test("perso status and rollback dry run read the pointers and touch nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  release(home, "aaaaaaa", "1"); release(home, "bbbbbbb", "1");
  fs.symlinkSync("releases/bbbbbbb", path.join(home, "current"));
  fs.symlinkSync("releases/aaaaaaa", path.join(home, "previous"));
  const status = run(home, "status");
  assert.match(status.stdout, /current:\s+bbbbbbb\s+branch=main/);
  assert.match(status.stdout, /previous: aaaaaaa/);
  const dry = run(home, "rollback");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run.*bbbbbbb -> aaaaaaa/);
  assert.equal(fs.readlinkSync(path.join(home, "current")), "releases/bbbbbbb");
});

test("perso refuses a rollback across a data format change", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  release(home, "aaaaaaa", "1"); release(home, "bbbbbbb", "2");
  fs.symlinkSync("releases/bbbbbbb", path.join(home, "current"));
  fs.symlinkSync("releases/aaaaaaa", path.join(home, "previous"));
  const result = run(home, "rollback");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema migration/);
});

// Fake launchctl (always fails) and fake pgrep (reports a live "old hub" process).
function mockEnv(home, victimPid) {
  const bin = path.join(home, "mockbin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pgrep"), `#!/bin/sh\necho ${victimPid}\n`, { mode: 0o755 });
  const fakeHome = path.join(home, "fakehome");
  fs.mkdirSync(path.join(fakeHome, ".local", "bin"), { recursive: true });
  return { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, NO_INSTALL: "", CONTEXT_ROOM_HUB_HOME: path.join(home, "hub"), PERSO_STOP_WAIT: "1", PERSO_KILL_GRACE: "1" };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("perso rollback does not kill the old hub when launchctl kickstart fails", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  release(home, "aaaaaaa", "1"); release(home, "bbbbbbb", "1");
  fs.symlinkSync("releases/bbbbbbb", path.join(home, "current"));
  fs.symlinkSync("releases/aaaaaaa", path.join(home, "previous"));
  const victim = spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const pid = Number(victim.stdout.trim());
  try {
    const result = run(home, "rollback", mockEnv(home, pid));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kickstart failed/);
    assert.ok(alive(pid), "old hub must stay alive");
  } finally { try { process.kill(pid, "SIGKILL"); } catch {} }
});

test("failed install restores previous instead of pointing it at the broken release", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  release(home, "aaaaaaa", "1"); release(home, "bbbbbbb", "1"); release(home, "ccccccc", "1");
  fs.symlinkSync("releases/bbbbbbb", path.join(home, "current"));
  fs.symlinkSync("releases/aaaaaaa", path.join(home, "previous"));
  fs.writeFileSync(path.join(home, "launch-installed.py"), "RUNTIME = BASE / 'current/runtime'\n");
  const victim = spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const pid = Number(victim.stdout.trim());
  try {
    const result = spawnSync("bash", [script, "install", "ccccccc"], { encoding: "utf8", env: { ...process.env, PERSO_HOME: home, PERSO_PORT: "1", ...mockEnv(home, pid) } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.readlinkSync(path.join(home, "current")), "releases/bbbbbbb");
    assert.equal(fs.readlinkSync(path.join(home, "previous")), "releases/aaaaaaa");
    assert.ok(alive(pid));
  } finally { try { process.kill(pid, "SIGKILL"); } catch {} }
});
