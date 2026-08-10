#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerContextHubProject } from "../src/context_hub.mjs";
import {
  createMemoryServer,
  initializeContextRoomProject,
  readDocReviewState,
  readGlobalReviewLedger,
  readMemoryWebappSettings,
} from "../src/context_room.mjs";
import { inspectOwnerReviewScope, inspectOwnerTrustedState } from "../src/review_authority.mjs";

function directorySnapshot(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const walk = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(prefix, entry.name);
      const stats = fs.lstatSync(absolutePath, { bigint: true });
      entries.push({
        path: relativePath,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        size: String(stats.size),
        mtimeNs: String(stats.mtimeNs),
      });
      if (entry.isDirectory()) walk(absolutePath, relativePath);
    }
  };
  walk(root);
  return entries;
}

test("Context Hub inspection, document graph, and document search GETs do not bootstrap review authority", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-read-only-surfaces-"));
  const root = path.join(base, "project");
  const hubHome = path.join(base, "hub");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Index\n\nRead-only search marker.\n");

  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  let server = null;
  t.after(async () => {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"], watchAllow: ["docs/"] });
  const project = registerContextHubProject(root);
  ({ server } = createMemoryServer({ root }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const reviewState = readDocReviewState(root);
  const reviewLedger = readGlobalReviewLedger(root);
  const authorityPaths = [
    inspectOwnerReviewScope(root, readMemoryWebappSettings(root), { readOnly: true }).authorityPath,
    inspectOwnerTrustedState(root, "review-state", reviewState, { readOnly: true }).authorityPath,
    inspectOwnerTrustedState(root, "review-ledger", reviewLedger, { readOnly: true }).authorityPath,
  ];
  for (const authorityPath of authorityPaths) {
    for (const suffix of ["", ".backup", ".lock"]) fs.rmSync(authorityPath + suffix, { force: true });
  }

  const authorityRoot = path.join(hubHome, "review-authority");
  const before = directorySnapshot(authorityRoot);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const routes = [
    `/api/context-hub/project-explorer?projectId=${encodeURIComponent(project.id)}&path=docs`,
    `/api/context-hub/project-settings?projectId=${encodeURIComponent(project.id)}`,
    `/api/context-hub/project-inspection?projectId=${encodeURIComponent(project.id)}`,
    `/api/context-hub/document-graph?scope=project&locationId=${encodeURIComponent(project.id)}&layout=0&allowStale=1`,
    `/api/context-hub/document-search?locationId=${encodeURIComponent(project.id)}&query=${encodeURIComponent("Read-only search marker")}`,
  ];

  for (const route of routes) {
    const response = await fetch(origin + route);
    const body = await response.text();
    assert.equal(response.status, 200, `${route}: ${body}`);
    assert.doesNotThrow(() => JSON.parse(body));
  }

  assert.deepEqual(directorySnapshot(authorityRoot), before);
});
