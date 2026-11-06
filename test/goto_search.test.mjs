#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerContextHubProject } from "../src/context_hub.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { createGotoEngine } from "../src/goto_search_engine.mjs";
import { gotoSearchProjects, gotoSearchStatsForTests, gotoWorkerSpawnsForTests, resetGotoSearchIndexForTests, searchGoto, setGotoWorkerUrlForTests, stopGotoSearchWorkerForTests } from "../src/goto_search.mjs";

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
