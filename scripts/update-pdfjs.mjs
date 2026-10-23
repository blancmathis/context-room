#!/usr/bin/env node
// Copies the pinned pdf.js build into src/vendor/pdfjs/. Usage: node scripts/update-pdfjs.mjs [path-to-unpacked-pdfjs-dist]
// Without a path it downloads pdfjs-dist@PINNED_VERSION with `npm pack` into a fresh temporary folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PINNED_VERSION = "6.4.299";
const destination = fileURLToPath(new URL("../src/vendor/pdfjs/", import.meta.url));
const COPIES = [
  ["legacy/build/pdf.min.mjs", "pdf.min.mjs"],
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["LICENSE", "LICENSE"],
];
const DIRECTORIES = [
  ["standard_fonts", /^[A-Za-z0-9._-]+\.(?:pfb|ttf)$|^LICENSE_[A-Z]+$/],
  ["cmaps", /^[A-Za-z0-9._-]+\.bcmap$/],
  ["wasm", /^(?:jbig2|openjpeg|qcms_bg)\.wasm$|^(?:jbig2|openjpeg)_nowasm_fallback\.js$|^LICENSE_[A-Z_0-9]+$/], // never quickjs-eval.*
];

function sourceRoot() {
  const given = process.argv[2];
  if (given) return path.resolve(given);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pdfjs-update-"));
  const packed = execFileSync("npm", ["pack", `pdfjs-dist@${PINNED_VERSION}`, "--pack-destination", work, "--silent"], { cwd: work, encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", path.join(work, packed), "-C", work]);
  return path.join(work, "package");
}

const source = sourceRoot();
const version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version;
if (version !== PINNED_VERSION) throw new Error(`pdf.js ${version} found, ${PINNED_VERSION} expected. Change PINNED_VERSION on purpose, then review the diff.`);
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const [from, to] of COPIES) fs.copyFileSync(path.join(source, from), path.join(destination, to));
for (const [directory, pattern] of DIRECTORIES) {
  fs.mkdirSync(path.join(destination, directory), { recursive: true });
  for (const name of fs.readdirSync(path.join(source, directory))) if (pattern.test(name)) fs.copyFileSync(path.join(source, directory, name), path.join(destination, directory, name));
}
fs.writeFileSync(path.join(destination, "VERSION"), `pdfjs-dist ${PINNED_VERSION}\n`);
console.log(`pdf.js ${PINNED_VERSION} copied to ${destination}`);
