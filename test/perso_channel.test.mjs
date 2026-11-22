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
  return { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, NO_INSTALL: "", CONTEXT_ROOM_HUB_HOME: path.join(home, "hub"), PERSO_STOP_WAIT: "1", PERSO_KILL_GRACE: "1", PERSO_LOAD_TRIES: "2" };
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

test("perso prune keeps current, previous and the 3 newest releases, and 10 backups", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  const names = ["a000001", "a000002", "a000003", "a000004", "a000005", "a000006", "a000007"];
  names.forEach((n, i) => {
    release(home, n, "1");
    const t = new Date(Date.now() - (names.length - i) * 60_000);
    fs.utimesSync(path.join(home, "releases", n), t, t);
  });
  fs.symlinkSync("releases/a000001", path.join(home, "current"));
  fs.symlinkSync("releases/a000002", path.join(home, "previous"));
  const backups = path.join(home, "state-backups");
  fs.mkdirSync(backups);
  for (let i = 0; i < 13; i++) {
    const f = path.join(backups, `hub-before-x${i}-2026.tgz`);
    fs.writeFileSync(f, "x");
    const t = new Date(Date.now() - (13 - i) * 60_000);
    fs.utimesSync(f, t, t);
  }
  const result = run(home, "prune");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(home, "releases")).sort(), ["a000001", "a000002", "a000005", "a000006", "a000007"]);
  assert.equal(fs.readdirSync(backups).length, 10);
  assert.ok(fs.existsSync(path.join(backups, "hub-before-x12-2026.tgz")));
});

// Fake launchctl with state: `print` works only while the job is loaded; `bootstrap` loads it, but the first
// bootstrap fails (bootout is async). Fake curl answers 200. Calls are logged in order.
function launchdEnv(home, { kickstartUnloadsFirst = false } = {}) {
  const bin = path.join(home, "mockbin");
  fs.mkdirSync(bin, { recursive: true });
  const st = path.join(home, "ld");
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(bin, "launchctl"), `#!/bin/sh
S=${st}; echo "$1" >> $S/calls
case $1 in
  print) [ -e $S/loaded ] ;;
  bootstrap) if [ -e $S/boot1 ]; then touch $S/loaded; else touch $S/boot1; exit 5; fi ;;
  kickstart) [ -e $S/loaded ] || exit 113
    if [ -n "${kickstartUnloadsFirst ? 1 : ""}" ] && [ ! -e $S/k1 ]; then touch $S/k1; rm -f $S/loaded $S/boot1; exit 113; fi ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nprintf 200\n", { mode: 0o755 });
  const fakeHome = path.join(home, "fakehome");
  fs.mkdirSync(path.join(fakeHome, ".local", "bin"), { recursive: true });
  const plist = path.join(home, "job.plist");
  fs.writeFileSync(plist, "<plist/>");
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, NO_INSTALL: "", PERSO_PLIST: plist, PERSO_LOAD_TRIES: "4", CONTEXT_ROOM_HUB_HOME: path.join(home, "hub") };
  const calls = () => fs.readFileSync(path.join(st, "calls"), "utf8").trim().split("\n");
  const loaded = () => fs.existsSync(path.join(st, "loaded"));
  return { env, calls, loaded };
}

test("restart bootstraps the job when it is not loaded, retrying until launchd has it, then kickstarts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  release(home, "aaaaaaa", "1"); release(home, "bbbbbbb", "1");
  fs.symlinkSync("releases/bbbbbbb", path.join(home, "current"));
  fs.symlinkSync("releases/aaaaaaa", path.join(home, "previous"));
  const ld = launchdEnv(home);
  const result = run(home, "rollback", ld.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rolled back to aaaaaaa/);
  assert.ok(ld.loaded(), "job must be loaded at the end");
  const c = ld.calls();
  assert.deepEqual(c.slice(0, 5), ["print", "bootstrap", "print", "bootstrap", "print"]);
  assert.equal(c.at(-1), "kickstart");
});

test("revert path reloads the job when the failed restart left it unloaded", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perso-"));
  release(home, "aaaaaaa", "1"); release(home, "bbbbbbb", "1"); release(home, "ccccccc", "1");
  fs.symlinkSync("releases/bbbbbbb", path.join(home, "current"));
  fs.symlinkSync("releases/aaaaaaa", path.join(home, "previous"));
  fs.writeFileSync(path.join(home, "launch-installed.py"), "RUNTIME = BASE / 'current/runtime'\n");
  const ld = launchdEnv(home, { kickstartUnloadsFirst: true });
  fs.writeFileSync(path.join(home, "ld", "loaded"), "");
  const result = spawnSync("bash", [script, "install", "ccccccc"], { encoding: "utf8", env: { ...process.env, PERSO_HOME: home, PERSO_PORT: "1", ...ld.env } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /switching back/);
  assert.equal(fs.readlinkSync(path.join(home, "current")), "releases/bbbbbbb");
  assert.ok(ld.loaded(), "the revert must leave the job loaded");
  assert.ok(ld.calls().includes("bootstrap"));
  assert.equal(ld.calls().at(-1), "kickstart");
});
