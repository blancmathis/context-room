import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `npm test` gives each test file temporary Hub and Shared homes. A direct
// `node --test` run does not, and used to write review-authority state and
// registry entries into the real ~/.context-room. Inside a Node test process
// without explicit homes, use temporary ones too.
if (process.env.NODE_TEST_CONTEXT) {
  const created = [];
  for (const [key, prefix] of [["CONTEXT_ROOM_HUB_HOME", "context-room-test-hub-"], ["CONTEXT_ROOM_SHARED_HOME", "context-room-test-shared-"]]) {
    if (process.env[key]) continue;
    process.env[key] = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(process.env[key]);
  }
  if (created.length) {
    process.once("exit", () => {
      for (const directory of created) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
      }
    });
  }
}
