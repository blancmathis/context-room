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
