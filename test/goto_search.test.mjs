#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerContextHubProject } from "../src/context_hub.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { resetGotoSearchIndexForTests } from "../src/goto_search.mjs";

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
  resetGotoSearchIndexForTests();
  let server = null;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
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
  assert.equal(limited.files.length + limited.text.length <= 6, true);
  assert.equal(limited.files.length, 3);
  assert.equal(limited.filesTotal, 6);

  const none = await get("zzzqqq");
  assert.deepEqual([none.files.length, none.text.length], [0, 0]);

  const missing = await fetch(`${origin}/api/context-hub/document-search?scope=all`);
  assert.equal(missing.status, 400);
  assert.equal(beta.id.length > 0, true);
});
