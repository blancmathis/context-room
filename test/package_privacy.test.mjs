import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { packagePrivacyFindings } from "../scripts/check-package-privacy.mjs";

function privacyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-package-privacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixture(root, relativePath, content) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  return { path: relativePath };
}

test("package privacy accepts documented placeholders and example environment files", (t) => {
  const root = privacyFixture(t);
  const files = [
    writeFixture(
      root,
      "docs/example.md",
      "Use ghp_example, person@example, <dataRoot>/home/.context-room/shared, <dataRoot>/root/shared, and <dataRoot>/Users/example/shared.\n",
    ),
    writeFixture(root, ".env.example", "TOKEN=replace-me\n"),
  ];

  assert.deepEqual(packagePrivacyFindings({ root, files }), []);
});

test("package privacy keeps detecting real Linux, root, macOS, and Windows user homes", (t) => {
  const root = privacyFixture(t);
  const files = [
    writeFixture(root, "docs/linux.md", "Private path: /home/alice/context-room\n"),
    writeFixture(root, "docs/root.md", "Private path: /root/context-room\n"),
    writeFixture(root, "docs/macos.md", "Private path: /Users/alice/context-room\n"),
    writeFixture(root, "docs/windows.md", "Private path: C:\\Users\\alice\\context-room\n"),
    writeFixture(root, "docs/windows-forward.md", "Private path: C:/Users/alice/context-room\n"),
  ];

  assert.deepEqual(packagePrivacyFindings({ root, files }), [
    "docs/linux.md: absolute user-home path",
    "docs/root.md: absolute user-home path",
    "docs/macos.md: absolute user-home path",
    "docs/windows.md: absolute user-home path",
    "docs/windows-forward.md: absolute user-home path",
  ]);
});

test("package privacy reports high-confidence secrets without printing their values", (t) => {
  const root = privacyFixture(t);
  const githubToken = `ghp_${"a".repeat(36)}`;
  const apiKey = `sk-proj-${"b".repeat(32)}`;
  const privateKeyHeader = `-----BEGIN ${"PRIVATE KEY"}-----`;
  const files = [writeFixture(
    root,
    "docs/leak.md",
    [`Path: /Users/alice/private`, githubToken, apiKey, privateKeyHeader].join("\n"),
  )];

  const findings = packagePrivacyFindings({ root, files });
  assert.deepEqual(findings, [
    "docs/leak.md: absolute user-home path",
    "docs/leak.md: private key",
    "docs/leak.md: GitHub access token",
    "docs/leak.md: API secret key",
  ]);
  assert.doesNotMatch(findings.join("\n"), new RegExp(githubToken));
  assert.doesNotMatch(findings.join("\n"), new RegExp(apiKey));
});

test("package privacy rejects sensitive filenames, denied terms, and manifest escapes", (t) => {
  const root = privacyFixture(t);
  const files = [
    writeFixture(root, ".env.production", "SAFE_PLACEHOLDER=1\n"),
    writeFixture(root, "docs/release.md", "Internal codename: Zephyr\n"),
    { path: "../outside.txt" },
  ];

  assert.deepEqual(packagePrivacyFindings({ root, files, deniedTerms: ["zephyr"] }), [
    ".env.production: sensitive credential filename",
    "docs/release.md: denied release term",
    "../outside.txt: package path escapes the repository",
  ]);
});
