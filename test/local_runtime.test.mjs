import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMemoryServer, renderAppHtml, contextRoomWebAssetBundle } from "../src/context_room.mjs";

test("retired hosted profiles fail before touching stored user data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-local-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "legacy-proposal.json"), "preserved");
  assert.throws(() => createMemoryServer({ root, remoteAccess: { secret: "obsolete" } }), /retired/);
  assert.deepEqual(fs.readdirSync(root), ["legacy-proposal.json"]);
  assert.equal(fs.readFileSync(path.join(root, "legacy-proposal.json"), "utf8"), "preserved");
  for (const runtimeProfile of ["hosted-hub", "hosted-review"]) {
    assert.throws(() => renderAppHtml({ runtimeProfile }), /retired/);
    assert.throws(() => contextRoomWebAssetBundle("", "", runtimeProfile), /retired/);
  }
  assert.match(renderAppHtml(), /data-context-room-runtime-profile="local"/);
});

test("the package has no hosted entrypoint and the old transport fails explicitly", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.bin), ["context-room"]);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/context-room.mjs", import.meta.url)), "ui", "list", "--json"], {
    encoding: "utf8", env: { ...process.env, CONTEXT_ROOM_REMOTE_URL: "https://example.invalid", CONTEXT_ROOM_REMOTE_TOKEN: "obsolete" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /retired/);
});
