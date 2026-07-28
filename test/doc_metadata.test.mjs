#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";

import { collectInlinePathReferences } from "../src/doc_metadata.mjs";

test("inline path references ignore shell commands, globs, and placeholders", () => {
  const refs = collectInlinePathReferences(`
Valid links: [Product](docs/PRODUCT.md), [Readme](README.md), \`docs/DEPLOYMENT.md\`, \`src/app.ts\`.
Commands and examples: \`python3 generate-index.py\`, \`cd tools && python3 run.py\`, \`GET /widget.js\`.
Patterns and placeholders: \`tests/**/*.test.ts\`, \`profiles/{id}.json\`, \`profiles/[id].json\`, \`.outbox/<slug>.json\`.
Bare code identifiers: \`factory.py\`, \`pipeline.json\`.
`);

  assert.deepEqual(refs, [
    "docs/PRODUCT.md",
    "README.md",
    "docs/DEPLOYMENT.md",
    "src/app.ts",
  ]);
});

test("inline path references ignore fenced configuration examples", () => {
  const refs = collectInlinePathReferences(`
\`docs/PRODUCT.md\` is a real repository reference.

\`\`\`json
{
  "source": "CLAUDE.md",
  "target": "apps/calls/AGENTS.md"
}
\`\`\`
`);

  assert.deepEqual(refs, ["docs/PRODUCT.md"]);
});
