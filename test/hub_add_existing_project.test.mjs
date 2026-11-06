import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-add-existing-")));
process.env.CONTEXT_ROOM_HUB_HOME = path.join(scratch, "hub");
process.env.CONTEXT_ROOM_SHARED_HOME = path.join(scratch, "shared");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const { addExistingContextHubProject, createMemoryServer, initializeContextRoomProject, readMemoryWebappSettings, writeGlobalContextRoomPreferences } = await import("../src/context_room.mjs");
const { listContextHubProjects, readContextHubRegistry } = await import("../src/context_hub.mjs");

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function folder(name, files = { "docs/guide.md": "# Guide\n" }) {
  const root = path.join(scratch, "computer", name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const computerRoot = path.join(scratch, "computer");
fs.mkdirSync(computerRoot, { recursive: true });

test("an existing folder without config is initialized by inference and registered", () => {
  const root = folder("fresh");
  const result = addExistingContextHubProject({ computerRoot, path: root, title: "Fresh docs" });
  assert.equal(result.alreadyRegistered, false);
  assert.equal(result.projectRoot, fs.realpathSync(root));
  assert.equal(result.registered.title, "Fresh docs");
  assert.ok(fs.existsSync(path.join(root, ".context-room", "config.json")));
  assert.ok(listContextHubProjects({ readOnly: true }).some((entry) => entry.root === fs.realpathSync(root)));
});

test("an existing config is kept as it is", () => {
  const root = folder("configured");
  initializeContextRoomProject(root, { title: "Mine", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const configPath = path.join(root, ".context-room", "config.json");
  const before = fs.readFileSync(configPath, "utf8");
  addExistingContextHubProject({ computerRoot, path: root, title: "Other title" });
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  assert.deepEqual(readMemoryWebappSettings(root).allowedPaths, ["docs/"]);
});

test("refuses outside the root, missing, relative, a file, a symlink, the root itself", () => {
  const outside = fs.mkdtempSync(path.join(scratch, "outside-"));
  assert.throws(() => addExistingContextHubProject({ computerRoot, path: outside }), /inside the Computer root/);
  assert.throws(() => addExistingContextHubProject({ computerRoot, path: path.join(computerRoot, "nope") }), /not found/i);
  assert.throws(() => addExistingContextHubProject({ computerRoot, path: "relative/dir" }), /absolute/);
  const file = path.join(computerRoot, "a-file.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => addExistingContextHubProject({ computerRoot, path: file }), /not a folder/i);
  const real = folder("real-target");
  const link = path.join(computerRoot, "linked");
  fs.symlinkSync(real, link);
  assert.throws(() => addExistingContextHubProject({ computerRoot, path: link }), /symbolic link/i);
  assert.throws(() => addExistingContextHubProject({ computerRoot, path: computerRoot }), /whole Computer root/);
});

test("an already registered folder returns the entry and does not rewrite the registry", () => {
  const root = folder("twice");
  const first = addExistingContextHubProject({ computerRoot, path: root });
  const registryFile = path.join(process.env.CONTEXT_ROOM_HUB_HOME, "registry.json");
  const before = fs.readFileSync(registryFile, "utf8");
  const second = addExistingContextHubProject({ computerRoot, path: root, title: "Renamed" });
  assert.equal(second.alreadyRegistered, true);
  assert.equal(second.registered.id, first.registered.id);
  assert.equal(fs.readFileSync(registryFile, "utf8"), before);
  assert.ok(readContextHubRegistry());
});

test("POST /api/context-hub/projects with existing:true adds the folder and reports duplicates", async (t) => {
  const host = path.join(scratch, "host");
  fs.mkdirSync(host);
  initializeContextRoomProject(host, { allowedPaths: [], watchAllow: [] });
  const preferencesPath = path.join(scratch, "prefs.json");
  writeGlobalContextRoomPreferences({ explorer: { computerRoot } }, preferencesPath);
  const { server } = createMemoryServer({ root: host, globalPreferencesPath: preferencesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = folder("via-api");
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/context-hub/projects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const added = await post({ existing: true, path: root, title: "Via API" });
  const body = await added.json();
  assert.equal(added.status, 201, JSON.stringify(body));
  assert.equal(body.alreadyRegistered, false);
  assert.ok(body.catalog.projects.some((p) => p.root === fs.realpathSync(root) || (p.worktrees || []).some((w) => w.root === fs.realpathSync(root))));
  const again = await post({ existing: true, path: root });
  const againBody = await again.json();
  assert.equal(again.status, 200);
  assert.equal(againBody.alreadyRegistered, true);
  const bad = await post({ existing: true, path: path.join(scratch, "elsewhere") });
  assert.equal(bad.status, 400);
});

test("refuses Context Room's own homes, anything inside them, and anything that holds them", () => {
  const hub = process.env.CONTEXT_ROOM_HUB_HOME;
  const shared = process.env.CONTEXT_ROOM_SHARED_HOME;
  const authority = path.join(hub, "review-authority");
  for (const dir of [hub, path.join(hub, "host"), shared, authority]) fs.mkdirSync(dir, { recursive: true });
  const wide = scratch; // holds the Hub, Shared and authority homes
  for (const target of [hub, path.join(hub, "host"), shared, authority, path.join(shared, "locks")]) {
    fs.mkdirSync(target, { recursive: true });
    assert.throws(() => addExistingContextHubProject({ computerRoot: wide, path: target }), /Context Room itself|holds its data/, target);
  }
  // A parent that holds them is refused too, even when it is below the Computer root.
  const parent = path.join(scratch, "wrapper");
  const prior = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(parent, "deep", "hub");
  try {
    fs.mkdirSync(process.env.CONTEXT_ROOM_HUB_HOME, { recursive: true });
    assert.throws(() => addExistingContextHubProject({ computerRoot: scratch, path: parent }), /holds its data/);
  } finally { process.env.CONTEXT_ROOM_HUB_HOME = prior; }
});

test("refuses a Hub home reached through a symlinked HOME-like path (real paths compared)", () => {
  const realHub = path.join(scratch, "real-hub-store");
  fs.mkdirSync(realHub, { recursive: true });
  const linkHub = path.join(scratch, "hub-link");
  fs.symlinkSync(realHub, linkHub);
  const prior = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = linkHub;
  try {
    assert.throws(() => addExistingContextHubProject({ computerRoot: scratch, path: realHub }), /Context Room itself|holds its data/);
  } finally { process.env.CONTEXT_ROOM_HUB_HOME = prior; }
});

test("refuses a folder that holds the home folder", () => {
  const prior = process.env.HOME;
  const fakeHome = path.join(scratch, "people", "me");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  const priorOs = os.homedir;
  try {
    // os.homedir() follows HOME on POSIX.
    assert.throws(() => addExistingContextHubProject({ computerRoot: scratch, path: path.join(scratch, "people") }), /contains it/);
    assert.throws(() => addExistingContextHubProject({ computerRoot: scratch, path: fakeHome }), /whole home folder/);
  } finally { process.env.HOME = prior; os.homedir = priorOs; }
});

test("refuses ~/.context-room and its folders (backups, logs) even when the Hub home lives elsewhere", () => {
  const prior = process.env.HOME;
  const fakeHome = path.join(scratch, "people-cr", "me");
  const own = path.join(fakeHome, ".context-room");
  for (const dir of ["backups", "logs"]) fs.mkdirSync(path.join(own, dir), { recursive: true });
  process.env.HOME = fakeHome; // CONTEXT_ROOM_HUB_HOME stays outside this home.
  try {
    for (const target of [own, path.join(own, "backups"), path.join(own, "logs")]) {
      assert.throws(() => addExistingContextHubProject({ computerRoot: scratch, path: target }), /Context Room itself|holds its data/, target);
    }
    assert.equal(fs.existsSync(path.join(own, "backups", ".context-room")), false);
  } finally { process.env.HOME = prior; }
});

test("the folder lister hides dot-folders for the picker and flags symlinks", async (t) => {
  const host = path.join(scratch, "host2");
  fs.mkdirSync(host);
  initializeContextRoomProject(host, { allowedPaths: [], watchAllow: [] });
  const preferencesPath = path.join(scratch, "prefs2.json");
  const lister = path.join(scratch, "lister");
  fs.mkdirSync(path.join(lister, ".secret"), { recursive: true });
  fs.mkdirSync(path.join(lister, "visible"));
  fs.symlinkSync(path.join(lister, "visible"), path.join(lister, "linked"));
  writeGlobalContextRoomPreferences({ explorer: { computerRoot: lister } }, preferencesPath);
  const { server } = createMemoryServer({ root: host, globalPreferencesPath: preferencesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = async (query) => (await fetch(`http://127.0.0.1:${server.address().port}/api/context-hub/computer-explorer${query}`)).json();
  const names = (body) => body.entries.map((entry) => entry.name);
  assert.ok(names(await get("")).includes(".secret"), "default Explorer keeps its setting");
  assert.ok(!names(await get("?foldersOnly=1")).includes(".secret"));
  assert.ok(names(await get("?foldersOnly=1&hidden=1")).includes(".secret"));
  const linked = (await get("?foldersOnly=1")).entries.find((entry) => entry.name === "linked");
  assert.equal(linked.symlink, true);
});
