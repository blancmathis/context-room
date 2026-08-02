import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAgentOperation,
  assertContextProjectPath,
  validateTextPatch,
} from "../src/qm_gateway.mjs";

const agent = {
  kind: "agent",
  projectId: "hicharlie",
  operations: ["accepted:read", "proposal:list", "proposal:write", "proposal:publish"],
};

test("agent gateway keeps every request in its QM project and allowed operations", () => {
  assert.equal(assertAgentOperation(agent, "accepted:read", "hicharlie").projectId, "hicharlie");
  assert.throws(() => assertAgentOperation(agent, "accepted:read", "peerlab"), (error) => error.code === "agent_project_scope_denied");
  assert.throws(() => assertAgentOperation(agent, "proposal:accept", "hicharlie"), (error) => error.code === "agent_operation_denied");
});

test("agent gateway accepts only project docs and skills text paths", () => {
  assert.equal(assertContextProjectPath("hicharlie", "projects/hicharlie/docs/PRODUCT.md"), "projects/hicharlie/docs/PRODUCT.md");
  assert.equal(assertContextProjectPath("hicharlie", "projects/hicharlie/skills/release/SKILL.md"), "projects/hicharlie/skills/release/SKILL.md");
  for (const value of [
    "projects/peerlab/docs/README.md",
    "projects/hicharlie/../peerlab/docs/README.md",
    "/etc/passwd",
    "projects/hicharlie/assets/logo.png",
  ]) {
    assert.throws(() => assertContextProjectPath("hicharlie", value), (error) => error.code === "agent_path_denied");
  }
});

test("agent gateway rejects binary, oversized, symlink, gitlink, and stale patch inputs", () => {
  const valid = validateTextPatch({
    path: "projects/hicharlie/docs/PRODUCT.md",
    content: "# Product\n",
    expectedContentHash: "a".repeat(64),
    expectedProposalHead: "b".repeat(40),
    entryType: "file",
  }, { projectId: "hicharlie" });
  assert.equal(valid.content, "# Product\n");

  const invalid = [
    { ...valid, content: "bad\0binary" },
    { ...valid, content: "x".repeat(750_001) },
    { ...valid, entryType: "symlink" },
    { ...valid, entryType: "gitlink" },
    { ...valid, expectedContentHash: "" },
    { ...valid, expectedProposalHead: "" },
  ];
  for (const input of invalid) assert.throws(() => validateTextPatch(input, { projectId: "hicharlie" }));
});
