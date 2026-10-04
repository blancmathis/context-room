// Deterministic checks for context an agent loses or receives twice. No model
// calls: every finding cites its rule, the source file, and the evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectInlinePathReferences } from "./doc_metadata.mjs";

// Codex 0.160.0 ships `project_doc_max_bytes = 32768` as its default.
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const CONTEXT_LOSS_LIMITS = Object.freeze({
  nearRatio: 0.8,
  // Agent Skills specification: description is at most 1,024 characters.
  skillDescriptionChars: 1024,
  findingsPerFile: 20,
});

export const CONTEXT_LOSS_RULES = Object.freeze({
  instruction_limit: "Codex joins project AGENTS.md files up to project_doc_max_bytes (32 KiB by default) and drops the rest.",
  duplicate_context: "The same content loaded twice costs tokens twice and adds nothing.",
  dead_path: "A path cited in an instruction or skill exists, relative to the file, the project, or the home folder.",
  missing_command: "A package script cited in an instruction exists in package.json.",
  skill_description: "A skill has a description of at most 1,024 characters (Agent Skills specification); agents choose skills from it.",
});

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function tomlTopLevelInteger(text, key) {
  const top = String(text || "").split(/^\s*\[/m, 1)[0];
  const match = top.match(new RegExp("^\\s*" + key + "\\s*=\\s*(\\d+)\\s*(?:#.*)?$", "m"));
  return match ? Number(match[1]) : null;
}

export function codexProjectDocLimit({ root = "", home = os.homedir() } = {}) {
  // Later sources win: user config, then the project's own .codex/config.toml.
  let limit = CODEX_PROJECT_DOC_MAX_BYTES;
  let source = "default";
  for (const file of [path.join(home, ".codex", "config.toml"), root ? path.join(root, ".codex", "config.toml") : ""].filter(Boolean)) {
    const value = tomlTopLevelInteger(readText(file), "project_doc_max_bytes");
    if (Number.isInteger(value)) {
      limit = value;
      source = file;
    }
  }
  return { limit, source };
}

function finding(type, entry, evidence, message, severity, line = null) {
  const resource = entry.resource;
  return {
    type,
    severity,
    resourceId: resource.id,
    path: resource.metadata?.absolutePath || resource.locator || "",
    locator: resource.locator || "",
    ...(line ? { line } : {}),
    rule: CONTEXT_LOSS_RULES[type],
    evidence,
    message,
  };
}

function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index < 0 ? null : text.slice(0, index).split("\n").length;
}

function resolveCited(reference, { fileDirectory, root, home }) {
  const clean = reference.split("#", 1)[0].split("?", 1)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return { skip: true };
  if (clean.startsWith("~/")) return { candidates: [path.join(home, clean.slice(2))] };
  if (path.isAbsolute(clean)) return { candidates: [clean] };
  return { candidates: [path.resolve(fileDirectory, clean), ...(root ? [path.resolve(root, clean)] : [])] };
}

function frontmatterField(text, field) {
  const block = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;
  const lines = block[1].split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp("^" + field + "\\s*:").test(line));
  if (start < 0) return null;
  let value = lines[start].replace(new RegExp("^" + field + "\\s*:\\s*"), "");
  // Folded or literal block scalars continue on indented lines.
  if (/^[>|][+-]?\s*$/.test(value) || value === "") {
    const continued = [];
    for (const line of lines.slice(start + 1)) {
      if (!/^\s+\S/.test(line)) break;
      continued.push(line.trim());
    }
    value = continued.join(" ");
  }
  return value.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
}

// effective: resolveEffectiveContext() output; provider: the selected provider.
export function analyzeContextLosses(effective, { provider = "", root = "", home = os.homedir(), readFile = readText, sizeOf = fileBytes, exists = fs.existsSync } = {}) {
  const findings = [];
  const instructions = (effective?.instructions || []).filter((entry) => entry.application?.status === "active");
  const skills = (effective?.skills || []).filter((entry) => entry.application?.status === "active");
  const selectedProvider = provider || effective?.coordinate?.provider || "";

  if (selectedProvider === "codex") {
    // The user-level ~/.codex/AGENTS.md has its own slot; project documents share the budget.
    const projectDocs = instructions
      .filter((entry) => entry.application.scope !== "device")
      .sort((left, right) => left.application.order - right.application.order);
    const { limit, source } = codexProjectDocLimit({ root, home });
    let total = 0;
    let reported = false;
    for (const entry of projectDocs) {
      const bytes = sizeOf(entry.resource.metadata?.absolutePath || "");
      if (!Number.isInteger(bytes)) continue;
      const before = total;
      total += bytes;
      if (!reported && total > limit) {
        reported = true;
        findings.push(finding("instruction_limit", entry, `${total} of ${limit} bytes (${source === "default" ? "Codex default" : source})`,
          `Codex drops ${total - limit} bytes: the limit of ${limit} bytes is reached ${before >= limit ? "before" : "inside"} this file. Shorten the instructions or move detail to linked docs.`, "high"));
      }
    }
    if (!reported && projectDocs.length && total >= limit * CONTEXT_LOSS_LIMITS.nearRatio) {
      findings.push(finding("instruction_limit", projectDocs.at(-1), `${total} of ${limit} bytes`,
        `Close to the Codex limit: ${total} of ${limit} bytes (${Math.round((total / limit) * 100)} %). The next additions will be dropped.`, "low"));
    }
  }

  for (const group of [instructions, skills]) {
    const firstByVersion = new Map();
    for (const entry of [...group].sort((left, right) => left.application.order - right.application.order)) {
      const version = entry.resource.version;
      if (!version) continue;
      const first = firstByVersion.get(version);
      if (!first) firstByVersion.set(version, entry);
      else if (first.resource.id !== entry.resource.id) {
        findings.push(finding("duplicate_context", entry, first.resource.locator,
          `Same content as ${first.resource.locator}: loaded twice. Keep one copy.`, "medium"));
      }
    }
  }

  let scripts = null;
  const packageScripts = () => {
    if (scripts) return scripts;
    try {
      scripts = JSON.parse(readFile(path.join(root, "package.json")) || "null")?.scripts || null;
    } catch {
      scripts = null;
    }
    return scripts;
  };
  const checked = [
    // Global instructions describe other projects: check only their home paths.
    ...instructions.map((entry) => ({ entry, homeOnly: entry.application.scope === "device" })),
    ...skills.map((entry) => ({ entry, homeOnly: false })),
  ];
  for (const { entry, homeOnly } of checked) {
    const file = entry.resource.metadata?.absolutePath || "";
    const text = file ? readFile(file) : null;
    if (text == null) continue;
    let count = 0;
    const add = (item) => {
      if (count++ < CONTEXT_LOSS_LIMITS.findingsPerFile) findings.push(item);
    };
    for (const reference of collectInlinePathReferences(text)) {
      // A bare file name is usually generic prose; only a path with a folder is checked.
      if (!reference.includes("/") || (homeOnly && !reference.startsWith("~/"))) continue;
      const resolved = resolveCited(reference, { fileDirectory: path.dirname(file), root: entry.resource.kind === "skill" ? "" : root, home });
      if (resolved.skip || resolved.candidates.some((candidate) => exists(candidate))) continue;
      add(finding("dead_path", entry, reference, `Dead path: ${reference} does not exist. Fix or remove the reference.`, "medium", lineOf(text, reference)));
    }
    if (entry.resource.kind === "instruction" && !homeOnly && root) {
      for (const match of text.matchAll(/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-z0-9:_-]+)/gi)) {
        const manager = match[1].toLowerCase();
        const name = match[2];
        const builtins = new Set(["install", "i", "ci", "add", "remove", "exec", "dlx", "x", "pack", "publish", "init", "create", "update", "upgrade", "link", "audit", "view", "version", "help", "why", "outdated", "rebuild", "uninstall", "config"]);
        if (builtins.has(name.toLowerCase()) || (manager === "npm" && !/\brun\s/.test(match[0]) && !["test", "start", "stop", "restart"].includes(name))) continue;
        const available = packageScripts();
        if (!available || Object.hasOwn(available, name)) continue;
        add(finding("missing_command", entry, match[0], `Missing script: ${match[0]} has no "${name}" entry in package.json.`, "medium", lineOf(text, match[0])));
      }
    }
    if (entry.resource.kind === "skill") {
      const description = frontmatterField(text, "description");
      if (!description) {
        add(finding("skill_description", entry, "no description", "No description: agents cannot tell when to use this skill. Add one sentence.", "medium"));
      } else if (description.length > CONTEXT_LOSS_LIMITS.skillDescriptionChars) {
        add(finding("skill_description", entry, `${description.length} characters`,
          `Description of ${description.length} characters is over the 1,024 of the Agent Skills specification: a provider may cut or reject it.`, "low"));
      }
    }
  }
  return findings;
}
