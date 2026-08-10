import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sensitivePackagePath = /(?:^|\/)(?:\.env(?:\.(?!(?:example|sample|template)$)[^/]+)?|\.netrc|\.npmrc|\.pypirc|credentials(?:\.json)?|id_(?:dsa|ecdsa|ed25519|rsa)|[^/]+\.(?:key|p12|pfx))$/i;
const followsDataRootPlaceholder = (match) => String(match.input || "").slice(0, match.index).endsWith("<dataRoot>");
const contentPatterns = [
  {
    label: "absolute user-home path",
    expression: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+|\/root(?=[/\\]|$)|[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g,
    ignore: (_value, match) => followsDataRootPlaceholder(match),
  },
  { label: "email address", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ignore: (value) => value.toLowerCase().startsWith("git@") },
  { label: "private key", expression: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  { label: "GitHub access token", expression: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g },
  { label: "AWS access key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: "Google API key", expression: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "Slack access token", expression: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { label: "Stripe secret key", expression: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { label: "API secret key", expression: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitLab access token", expression: /\bglpat-[0-9A-Za-z_-]{20,}\b/g },
  { label: "npm access token", expression: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: "PyPI access token", expression: /\bpypi-AgEI[0-9A-Za-z_-]{40,}\b/g },
];

function normalizedDeniedTerms(value) {
  const terms = Array.isArray(value) ? value : String(value || "").split(",");
  return terms.map((term) => String(term).trim().toLowerCase()).filter(Boolean);
}

export function packagePrivacyFindings({ root, files, deniedTerms = [] }) {
  const resolvedRoot = path.resolve(root);
  const findings = [];
  const normalizedTerms = normalizedDeniedTerms(deniedTerms);

  for (const entry of Array.isArray(files) ? files : []) {
    const relativePath = String(entry?.path || "").replaceAll("\\", "/");
    if (!relativePath) {
      findings.push("<unknown>: package manifest path is missing");
      continue;
    }
    if (sensitivePackagePath.test(relativePath)) {
      findings.push(`${relativePath}: sensitive credential filename`);
    }

    const absolutePath = path.resolve(resolvedRoot, relativePath);
    if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + path.sep)) {
      findings.push(`${relativePath}: package path escapes the repository`);
      continue;
    }

    let content;
    try {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        findings.push(`${relativePath}: package entry is not a regular file`);
        continue;
      }
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      findings.push(`${relativePath}: package file cannot be inspected`);
      continue;
    }

    for (const pattern of contentPatterns) {
      pattern.expression.lastIndex = 0;
      const matches = [...content.matchAll(pattern.expression)].filter((match) => !pattern.ignore?.(match[0], match));
      if (matches.length) findings.push(`${relativePath}: ${pattern.label}`);
    }
    const lowered = content.toLowerCase();
    for (const term of normalizedTerms) {
      if (lowered.includes(term)) findings.push(`${relativePath}: denied release term`);
    }
  }

  return [...new Set(findings)];
}

function main() {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (packed.status !== 0) {
    process.stderr.write(packed.stderr || packed.stdout || "Unable to inspect the npm package.\n");
    process.exitCode = packed.status || 1;
    return;
  }

  let manifest;
  try {
    [manifest] = JSON.parse(packed.stdout);
  } catch (error) {
    process.stderr.write(`Unable to parse npm package manifest: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(manifest?.files)) {
    process.stderr.write("Unable to inspect npm package files: the manifest is incomplete.\n");
    process.exitCode = 1;
    return;
  }

  const findings = packagePrivacyFindings({
    root: packageRoot,
    files: manifest.files,
    deniedTerms: process.env.CONTEXT_ROOM_PRIVACY_DENY,
  });
  if (findings.length) {
    process.stderr.write(`Package privacy check failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Package privacy check OK (${manifest.files.length} files).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
