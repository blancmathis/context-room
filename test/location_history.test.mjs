import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { legacyRootIdentities } from "../src/location_history.mjs";

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-location-history-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project"), store = path.join(base, "assistant");
  for (const directory of [root, path.join(store, "conversations")]) fs.mkdirSync(directory, { recursive: true });
  const ino = String(fs.lstatSync(root).ino);
  const write = (directory, rel, value) => {
    fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true });
    fs.writeFileSync(path.join(directory, rel), JSON.stringify(value));
  };
  return { base, root, store, ino, write };
}

test("earlier identities come only from the known field of each record kind", (t) => {
  const { root, store, ino, write } = fixture(t);
  write(root, ".context-room/notebooks/v1/resources/a/header.json", { rootIdentity: `1:${ino}` });
  write(root, ".context-room/local-proposals/proposals/p.json", { rootIdentity: `2:${ino}` });
  write(root, ".context-room/workflow-state.json", { rootIdentity: `3:${ino}` });
  write(root, ".context-room/migrations/workflow-v1/journal.json", { plan: { rootIdentity: `4:${ino}` } });
  write(store, "conversations/c.json", { origin: { root, rootIdentity: `5:${ino}` } });
  write(store, "conversations/other.json", { origin: { root: root + "-copy", rootIdentity: `6:${ino}` } });
  write(root, ".context-room/notebooks/v1/resources/b/header.json", { unexpected: { rootIdentity: `7:${ino}` }, note: `"rootIdentity": "8:${ino}"` });
  write(root, ".context-room/local-proposals/proposals/other-inode.json", { rootIdentity: "9:1" });
  assert.deepEqual(legacyRootIdentities(root, { ino, conversationRoot: store }), [`1:${ino}`, `2:${ino}`, `3:${ino}`, `4:${ino}`, `5:${ino}`]);
});

test("earlier identities are never read through a linked directory or file", (t) => {
  const { base, root, ino, write } = fixture(t);
  write(base, "outside/a/header.json", { rootIdentity: `11:${ino}` });
  write(base, "outside-state.json", { rootIdentity: `12:${ino}` });
  fs.mkdirSync(path.join(root, ".context-room/notebooks/v1"), { recursive: true });
  fs.symlinkSync(path.join(base, "outside"), path.join(root, ".context-room/notebooks/v1/resources"));
  fs.symlinkSync(path.join(base, "outside-state.json"), path.join(root, ".context-room/workflow-state.json"));
  write(base, "hardlinked.json", { rootIdentity: `13:${ino}` });
  fs.mkdirSync(path.join(root, ".context-room/local-proposals/proposals"), { recursive: true });
  fs.linkSync(path.join(base, "hardlinked.json"), path.join(root, ".context-room/local-proposals/proposals/p.json"));
  assert.deepEqual(legacyRootIdentities(root, { ino }), []);
});
