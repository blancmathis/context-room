#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerContextHubProject } from "../src/context_hub.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { createGotoEngine } from "../src/goto_search_engine.mjs";
import { gotoSearchProjects, gotoSearchStatsForTests, gotoWorkerSpawnsForTests, resetGotoSearchIndexForTests, searchGoto, setGotoTimingsForTests, setGotoWorkerUrlForTests, stopGotoSearchWorkerForTests } from "../src/goto_search.mjs";

function makeProject(base, name, files) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"], watchAllow: ["docs/"] });
  return registerContextHubProject(root);
}

test("Go to search finds file names and file text across projects, folds accents and case, and respects the limit", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-"));
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  await resetGotoSearchIndexForTests();
  let server = null;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await stopGotoSearchWorkerForTests();
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const alpha = makeProject(base, "alpha", {
    "docs/Mémo-équipe.md": "# Équipe\n\nRien ici.\n",
    "docs/notes.md": "# Notes\n\nLe répartiteur décide <b>quoi</b> faire.\nUne autre ligne.\n",
  });
  const beta = makeProject(base, "beta", {
    "docs/runbook.md": "# Runbook\n\nSteps.\n",
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`docs/bulk-${i}.md`, `# Bulk ${i}\n\nshared bulkword here\n`])),
  });
  ({ server } = createMemoryServer({ root: alpha.root }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (query, extra = "") => {
    const response = await fetch(`${origin}/api/context-hub/document-search?scope=all&query=${encodeURIComponent(query)}${extra}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const byName = await get("RUNBOOK");
  assert.equal(byName.files[0].path, "docs/runbook.md");
  assert.equal(byName.files[0].projectTitle, "beta");
  assert.equal(byName.files[0].projectKey.startsWith("local:"), true);

  const accents = await get("memo");
  assert.equal(accents.files.some((item) => item.path === "docs/Mémo-équipe.md"), true, "memo finds Mémo");

  const byText = await get("repartiteur");
  assert.equal(byText.files.length, 0);
  assert.equal(byText.text.length, 1);
  assert.equal(byText.text[0].path, "docs/notes.md");
  assert.equal(byText.text[0].line, 3);
  const hit = byText.text[0];
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase(), "répartiteur");

  const limited = await get("bulk", "&limit=3");
  assert.equal(limited.text.length, 0, "the six bulk files match by name only");
  assert.equal(limited.files.length <= 3, true);
  assert.equal(limited.files.length, 3);
  assert.equal(limited.filesTotal, 6);

  const none = await get("zzzqqq");
  assert.deepEqual([none.files.length, none.text.length], [0, 0]);

  const missing = await fetch(`${origin}/api/context-hub/document-search?scope=all`);
  assert.equal(missing.status, 400);
  assert.equal(beta.id.length > 0, true);
});

async function serve(t, base, root) {
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  await resetGotoSearchIndexForTests();
  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await stopGotoSearchWorkerForTests();
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async (query) => (await fetch(`${origin}/api/context-hub/document-search?scope=all&query=${encodeURIComponent(query)}`)).json();
}

test("Go to never returns files outside the project's access rules, even when they change after indexing", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-access-"));
  const outside = path.join(base, "outside.md");
  fs.writeFileSync(outside, "# Outside\n\nsecretword leaks\n");
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  const project = makeProject(base, "gate", {
    "docs/visible.md": "# Visible\n\nsecretword visible\n",
    "docs/swap.md": "# Swap\n\nsecretword swap\n",
    "docs/.hidden/dot.md": "secretword dot\n",
    "docs/node_modules/pkg/readme.md": "secretword node_modules\n",
    ".git/notes.md": "secretword git\n",
    "src/outside-allowed.md": "secretword not allowed\n",
  });
  fs.symlinkSync(outside, path.join(project.root, "docs", "link.md"));
  const search = await serve(t, base, project.root);

  const first = await search("secretword");
  const paths = first.text.map((item) => item.path).sort();
  assert.deepEqual(paths, ["docs/swap.md", "docs/visible.md"]);

  // The index now holds docs/swap.md. Replace it with a symlink that leaves the project, delete the other file.
  fs.rmSync(path.join(project.root, "docs", "swap.md"));
  fs.symlinkSync(outside, path.join(project.root, "docs", "swap.md"));
  fs.rmSync(path.join(project.root, "docs", "visible.md"));
  const second = await search("secretword");
  assert.deepEqual(second.text.map((item) => item.path), [], "a symlink swapped in after indexing and a deleted file are not served");
});

test("Go to shows the current text of a file edited after indexing", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-fresh-"));
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  const project = makeProject(base, "fresh", { "docs/a.md": "# A\n\noldword here\n" });
  const search = await serve(t, base, project.root);
  assert.equal((await search("oldword")).text.length, 1);
  fs.writeFileSync(path.join(project.root, "docs", "a.md"), "# A\n\nnewword here and a longer line\n");
  assert.equal((await search("oldword")).text.length, 0);
  assert.equal((await search("newword")).text.length, 1);
});

test("Go to picks the main checkout of a project and skips shared, unavailable and notebook entries", () => {
  const picked = gotoSearchProjects([
    { id: "wt", logicalProjectId: "p", root: "/r/wt", worktree: { main: false } },
    { id: "main", logicalProjectId: "p", root: "/r/main", worktree: { main: true } },
    { id: "gone", logicalProjectId: "q", root: "/r/gone", available: false },
    { id: "shared", logicalProjectId: "s", root: "/r/s", mode: "shared" },
    { id: "space", logicalProjectId: "n", root: "/r/n", space: { kind: "notebook" } },
  ]);
  assert.deepEqual(picked.map((item) => item.id), ["main"]);
});

test("Go to builds a large project without blocking the main thread", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-loop-"));
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  const files = {};
  for (let i = 0; i < 2500; i += 1) files[`docs/big/n${i}.md`] = `# Note ${i}\n\n${"filler words for the index ".repeat(40)}\nneedle${i}\n`;
  const project = makeProject(base, "large", files);
  const search = await serve(t, base, project.root);
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  try {
    let result = await search("needle2499");
    for (let tries = 0; result.building && tries < 40; tries += 1) { await new Promise((resolve) => setTimeout(resolve, 100)); result = await search("needle2499"); }
    assert.equal(result.text.length, 1);
  } finally { clearInterval(timer); }
  assert.equal(worst < 120, true, `main-thread gap ${Math.round(worst)} ms`);
});

test("Go to engine bounds memory globally, frees removed projects and re-reads only changed files", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-engine-"));
  const mk = (name, count) => {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < count; i += 1) fs.writeFileSync(path.join(root, `f${i}.md`), `# F${i}\n${"x".repeat(1000)} word${i}\n`);
    return { id: name, root, title: name, projectKey: `local:${name}` };
  };
  const projects = ["a", "b", "c"].map((name) => mk(name, 20));
  let resolves = 0;
  const engine = createGotoEngine({
    maxTotalBytes: 30_000,
    ttlMs: 0,
    listFiles: (root) => fs.readdirSync(root).map((name) => {
      const stat = fs.statSync(path.join(root, name));
      return { path: name, exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    }),
    resolveFile: (root, rel) => { resolves += 1; return path.join(root, rel); },
  });
  try {
    for (const project of projects) await engine.search([project], "word1");
    assert.equal(engine.stats().bytes <= 30_000, true, "total index bytes stay under the global cap");
    await engine.search([projects[0]], "word1");
    assert.equal(engine.stats().projects, 1, "projects no longer registered are freed");
    await engine.search([projects[0]], "zzz");
    const before = resolves;
    engine.warm([projects[0]]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(resolves, before, "a refresh of unchanged files reads nothing");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

function listDir(root) {
  return fs.readdirSync(root).map((name) => {
    const stat = fs.statSync(path.join(root, name));
    return { path: name, exists: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
  });
}

test("Go to evicts old projects so the newest one keeps its text search, and says when a file was left unread", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-evict-"));
  const mk = (name, count) => {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < count; i += 1) fs.writeFileSync(path.join(root, `f${i}.md`), `# F${i}\n${"x".repeat(1000)} ${name}needle${i}\n`);
    return { id: name, root, title: name, projectKey: `local:${name}` };
  };
  const [a, b, c] = ["a", "b", "c"].map((name) => mk(name, 20));
  const engine = createGotoEngine({ maxTotalBytes: 30_000, ttlMs: 0, listFiles: listDir, resolveFile: (root, rel) => path.join(root, rel) });
  try {
    for (let round = 0; round < 2; round += 1) {
      for (const project of [a, b, c]) {
        const result = await engine.search([a, b, c], `${project.id}needle1`);
        assert.equal(result.text.length > 0, true, `project ${project.id} still has text search in round ${round}`);
        assert.equal(engine.stats().bytes <= 30_000, true);
      }
    }
    const huge = mk("huge", 40); // 40 KB of text, cap 30 KB: some files cannot be read
    const partial = await engine.search([huge], "hugeneedle1");
    assert.equal(partial.truncated, true, "a project that does not fit says so");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("Go to reports a worker that cannot start and does not start a new one for every request", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-broken-"));
  const broken = path.join(base, "broken-worker.mjs");
  fs.writeFileSync(broken, 'throw new Error("cannot load");\n');
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(" ")); };
  await stopGotoSearchWorkerForTests();
  setGotoWorkerUrlForTests(new URL(`file://${broken}`));
  t.after(async () => { console.error = originalError; await stopGotoSearchWorkerForTests(); setGotoWorkerUrlForTests(null); fs.rmSync(base, { recursive: true, force: true }); });
  const projects = [{ id: "p", root: base, title: "p" }];
  const first = await searchGoto(projects, "anything");
  assert.equal(first.failed, true, "the failure reaches the caller");
  assert.equal(first.building, false, "a failure is not shown as an index still building");
  const second = await searchGoto(projects, "anything");
  const third = await searchGoto(projects, "anything");
  assert.equal(second.failed && third.failed, true);
  assert.equal(gotoWorkerSpawnsForTests(), 1, "one spawn attempt, then back-off");
  assert.equal(logged.some((line) => line.includes("cannot load")), true, "the cause is logged");
});

test("Go to: projects of one search do not evict each other, so a repeated query reads no file", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-thrash-"));
  const mk = (name) => {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(root, `f${i}.md`), `# F${i}\n${"x".repeat(1000)} ${name}needle${i}\n`);
    return { id: name, root, title: name, projectKey: `local:${name}` };
  };
  const projects = ["a", "b", "c"].map(mk);
  const engine = createGotoEngine({ maxTotalBytes: 30_000, listFiles: listDir, resolveFile: (root, rel) => path.join(root, rel) });
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...rest) { if (String(file).startsWith(base)) reads += 1; return realRead.call(this, file, ...rest); };
  try {
    const first = await engine.search(projects, "f1");
    assert.equal(first.truncated, true, "projects that do not fit together say the read was partial");
    assert.equal(first.files.length > 0, true);
    for (let round = 0; round < 5; round += 1) {
      reads = 0;
      const again = await engine.search(projects, round % 2 ? "f1" : "zzznomatch");
      assert.equal(reads, 0, `round ${round}: a repeated query inside the cache time reads 0 files`);
      assert.equal(again.truncated, true);
      assert.equal(engine.stats().projects, 3, "no project was evicted by another one of the same search");
      assert.equal(engine.stats().bytes <= 30_000, true);
    }
  } finally { fs.readFileSync = realRead; fs.rmSync(base, { recursive: true, force: true }); }
});

test("Go to: re-reading a changed file at verify time respects the global cap", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-verify-cap-"));
  const root = path.join(base, "p");
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(root, `f${i}.md`), `# F${i}\n${"x".repeat(1000)}\n`);
  const project = { id: "p", root, title: "p", projectKey: "local:p" };
  const engine = createGotoEngine({ maxTotalBytes: 12_000, listFiles: listDir, resolveFile: (r, rel) => path.join(r, rel) });
  try {
    await engine.search([project], "f3");
    fs.writeFileSync(path.join(root, "f3.md"), `# F3\n${"y".repeat(3000)}\n`);
    const result = await engine.search([project], "f3");
    assert.equal(result.files.some((item) => item.path === "f3.md"), true, "the changed file is still found by name");
    assert.equal(engine.stats().bytes <= 12_000, true, `index bytes ${engine.stats().bytes} stay under the cap`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("Go to replaces a worker that hangs: a timeout counts as a worker failure", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-hung-"));
  const marker = path.join(base, "hung-once");
  const hung = path.join(base, "hung-worker.mjs");
  fs.writeFileSync(hung, `import fs from "node:fs";
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id }) => {
  if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, "x"); for (;;); }
  parentPort.postMessage({ id, result: { terms: [], files: [], text: [], truncated: false, building: false, searchedProjects: 0, filesTotal: 0, textTotal: 0 } });
});
`);
  const originalError = console.error;
  console.error = () => {};
  await stopGotoSearchWorkerForTests();
  setGotoWorkerUrlForTests(new URL(`file://${hung}`));
  setGotoTimingsForTests({ timeoutMs: 300, backoffMs: 50 });
  t.after(async () => { console.error = originalError; await stopGotoSearchWorkerForTests(); setGotoTimingsForTests(); setGotoWorkerUrlForTests(null); fs.rmSync(base, { recursive: true, force: true }); });
  const projects = [{ id: "p", root: base, title: "p" }];
  const first = await searchGoto(projects, "anything");
  assert.equal(first.failed, true, "the hung request fails");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await searchGoto(projects, "anything");
  assert.equal(second.failed, undefined, "after the back-off a new worker answers");
  assert.equal(gotoWorkerSpawnsForTests(), 2, "the hung worker was replaced");
});

test("Go to: overlapping builds (warm) never hold more than the global cap, and the cut is reported", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-overlap-"));
  const projects = ["a", "b", "c"].map((name) => {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 100; i += 1) fs.writeFileSync(path.join(root, `f${i}.md`), `# F${i}\n${"x".repeat(1000)}\n`);
    return { id: name, root, title: name, projectKey: `local:${name}` };
  });
  const engine = createGotoEngine({ maxTotalBytes: 30_000, listFiles: listDir, resolveFile: (root, rel) => path.join(root, rel) });
  try {
    engine.warm(projects);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(engine.stats().bytes <= 30_000, true, `index bytes ${engine.stats().bytes} stay under the 30000 cap`);
    const result = await engine.search(projects, "f1");
    assert.equal(engine.stats().bytes <= 30_000, true, "still under the cap after a search");
    assert.equal(result.truncated, true, "a project that was cut says Partial results");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("Go to: a worker that reports progress is not killed by the timeout", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-goto-slow-"));
  const slow = path.join(base, "slow-worker.mjs");
  fs.writeFileSync(slow, `import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id }) => {
  let n = 0;
  const beat = setInterval(() => {
    parentPort.postMessage({ progress: true });
    if (++n === 8) { clearInterval(beat); parentPort.postMessage({ id, result: { terms: [], files: [], text: [], truncated: false, building: false, searchedProjects: 1, filesTotal: 0, textTotal: 0 } }); }
  }, 100);
});
`);
  await stopGotoSearchWorkerForTests();
  setGotoWorkerUrlForTests(new URL(`file://${slow}`));
  setGotoTimingsForTests({ timeoutMs: 300, backoffMs: 50 });
  t.after(async () => { await stopGotoSearchWorkerForTests(); setGotoTimingsForTests(); setGotoWorkerUrlForTests(null); fs.rmSync(base, { recursive: true, force: true }); });
  const reply = await searchGoto([{ id: "p", root: base, title: "p" }], "anything");
  assert.equal(reply.failed, undefined, "800 ms of work with progress every 100 ms survives a 300 ms timeout");
  assert.equal(gotoWorkerSpawnsForTests(), 1, "the worker was not replaced");
});

test("Go to palette: failure retries and 'building' retries share one budget and then stop", async () => {
  const source = fs.readFileSync(new URL("../src/ui/app.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const GOTO_RETRY_BUDGET") >= 0 ? source.indexOf("const GOTO_RETRY_BUDGET") : source.indexOf("function scheduleGotoSearch");
  const end = source.indexOf("function warmGotoSearch");
  assert.equal(start > 0 && end > start, true, "palette code found");
  const timers = [];
  let calls = 0;
  const answers = [{ failed: true, truncated: true }, { building: true, truncated: true }];
  const state = { gotoSearch: { seq: 0, timer: null }, contextHubProjectPickerQuery: "notes", contextHubProjectPickerPurpose: "open", contextHubProjectPickerOpen: true };
  const sandbox = {
    state, IS_HOSTED_HUB: false, GOTO_MIN_QUERY: 2,
    window: { clearTimeout: () => {}, setTimeout: (fn) => { timers.push(fn); return timers.length; } },
    api: async () => answers[calls++ % 2],
    renderContextHubProjectPicker: () => {}, contextHubProjectPickerChoices: () => ({ choices: [] }), activateContextHubProjectPickerIndex: () => {},
  };
  const vm = await import("node:vm");
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + "\nthis.scheduleGotoSearch = scheduleGotoSearch;", sandbox);
  sandbox.scheduleGotoSearch();
  for (let guard = 0; timers.length && guard < 60; guard += 1) { await timers.shift()(); }
  assert.equal(timers.length, 0, "the retries end");
  assert.equal(calls <= 9, true, `at most 1 + 8 requests, got ${calls}`);
  assert.equal(state.gotoSearch.truncated, true, "the palette says Partial results");
  assert.equal(state.gotoSearch.exhausted, true, "the palette says it gave up");
});
