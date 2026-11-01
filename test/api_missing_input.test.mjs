import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createCodexPromptCenterProvider } from "../src/codex_prompt_center.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";

// Missing or wrong input is the caller's problem: a 4xx with a code, never a
// generic 500 "could not complete this request".
function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = (target) => {
    let stats;
    try { stats = fs.lstatSync(target); } catch { return; }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o755); } catch {}
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    } else if (!stats.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o644); } catch {}
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

test("missing input answers 4xx with a code, and Codex Prompt Center without Codex is an empty state", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-missing-input-"));
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  t.after(() => removeWritableTree(base));
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  });
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), "# Project\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: "Missing input", allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const room = createMemoryServer({
    root,
    codexPromptCenter: createCodexPromptCenterProvider({ storageRoot: path.join(base, "no-codex", "prompt-overrides") }),
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const get = async (route) => {
    const response = await fetch(origin + route, { headers: { "x-context-room-project": room.projectId } });
    return { status: response.status, body: await response.json() };
  };

  const prompts = await get("/api/codex-prompts");
  assert.equal(prompts.status, 200, JSON.stringify(prompts.body));
  assert.deepEqual(prompts.body.groups, []);
  assert.equal(prompts.body.summary.targets, 0);
  assert.equal(prompts.body.available, false);

  const expected = [
    ["/api/codex-prompts/target?id=missing", 404, "codex_prompt_target_not_found"],
    ["/api/startup-skills/file?folder=0&skill=missing", 404, "startup_file_not_found"],
    ["/api/startup-hooks/file?order=99", 404, "startup_file_not_found"],
    ["/api/startup-context/file?order=99", 404, "startup_file_not_found"],
    ["/api/docqa/shared-asset-file?path=docs/a.png", 409, "shared_review_not_open"],
    ["/api/file/diff", 400, "file_path_required"],
    ["/api/file/review-base", 400, "file_path_required"],
  ];
  for (const [route, status, code] of expected) {
    const result = await get(route);
    assert.equal(result.status, status, `${route}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, route);
  }
});
