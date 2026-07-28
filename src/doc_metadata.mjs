import path from "node:path";
import { parseSimpleYaml, yamlScalar } from "./yaml_utils.mjs";

export const DOC_METADATA_KINDS = ["agents", "index", "canonical", "procedure", "decision"];
export const DOC_METADATA_STATUSES = ["current", "draft", "historical", "superseded"];

const DEFAULT_DOC_METADATA = {
  kind: "canonical",
  scope: "project",
  status: "draft",
  canonical_for: "",
  last_verified: "",
  sources: [],
};

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function metadataDefaultsForPath(relPath) {
  const inferredKind = inferDocKindFromPath(relPath);
  return {
    ...DEFAULT_DOC_METADATA,
    kind: inferredKind,
    status: "current",
    canonical_for: inferredKind === "canonical" ? path.basename(normalizeRelPath(relPath), ".md") : "",
    last_verified: todayIsoDate(),
  };
}

function inferDocKindFromPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  const originalBase = path.basename(normalized);
  const base = originalBase.toLowerCase();
  const lowered = normalized.toLowerCase();
  if (originalBase === "AGENTS.md" || originalBase === "CLAUDE.md" || base === ".hermes.md") return "agents";
  if (["index.md", "readme.md"].includes(base)) return "index";
  if (lowered.includes("decision") || lowered.includes("adr")) return "decision";
  if (lowered.includes("runbook") || lowered.includes("procedure") || lowered.includes("deployment") || lowered.includes("testing") || lowered.includes("monitoring")) return "procedure";
  return "canonical";
}

export function normalizeDocMetadata(raw = {}, relPath = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaults = metadataDefaultsForPath(relPath);
  const kind = DOC_METADATA_KINDS.includes(String(source.kind || "")) ? String(source.kind) : defaults.kind;
  const status = DOC_METADATA_STATUSES.includes(String(source.status || "")) ? String(source.status) : defaults.status;
  const sources = sanitizeReferenceList(source.sources || source.source || []);
  return {
    kind,
    scope: String(source.scope || defaults.scope || "project").trim() || "project",
    status,
    canonical_for: String(source.canonical_for || source.canonicalFor || defaults.canonical_for || "").trim(),
    last_verified: normalizeDateString(source.last_verified || source.lastVerified || defaults.last_verified || ""),
    sources,
  };
}

function normalizeDateString(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function sanitizeReferenceList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 80))];
}

function extractMarkdownFrontmatter(content = "") {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: null, body: String(content || ""), raw: "" };
  return { data: match[1], body: String(content || "").slice(match[0].length), raw: match[0] };
}

export function parseDocMetadata(content = "", relPath = "") {
  const frontmatter = extractMarkdownFrontmatter(content);
  if (!frontmatter.data || !/^\s*(context[_-]?room|contextRoom)\s*:/im.test(frontmatter.data)) {
    return {
      present: false,
      parseError: "",
      statusValid: false,
      ...normalizeDocMetadata({}, relPath),
      status: "",
    };
  }
  try {
    const parsed = parseSimpleYaml(frontmatter.data);
    const raw = parsed.context_room || parsed.contextRoom || {};
    const declaredStatus = String(raw.status || "").trim();
    const statusValid = DOC_METADATA_STATUSES.includes(declaredStatus);
    return {
      present: Boolean(parsed.context_room || parsed.contextRoom),
      parseError: "",
      statusValid,
      ...normalizeDocMetadata(raw, relPath),
      status: statusValid ? declaredStatus : "",
    };
  } catch (error) {
    return {
      present: false,
      parseError: error.message,
      statusValid: false,
      ...normalizeDocMetadata({}, relPath),
      status: "",
    };
  }
}

export function renderDocMetadataTemplateValues({ title, normalized, metadata }) {
  const docMetadata = normalizeDocMetadata({
    ...metadataDefaultsForPath(normalized),
    ...metadata,
  }, normalized);
  return {
    title,
    path: normalized,
    kind: docMetadata.kind,
    status: docMetadata.status,
    scope: docMetadata.scope,
    canonical_for: docMetadata.canonical_for,
    last_verified: docMetadata.last_verified,
    sources_inline: `[${docMetadata.sources.map(yamlScalar).join(", ")}]`,
    sources_list: docMetadata.sources.length ? docMetadata.sources.map((source) => `- ${source}`).join("\n") : "- Add source files, commands, or links.",
    kind_yaml: yamlScalar(docMetadata.kind),
    status_yaml: yamlScalar(docMetadata.status),
    scope_yaml: yamlScalar(docMetadata.scope),
    canonical_for_yaml: yamlScalar(docMetadata.canonical_for),
    last_verified_yaml: yamlScalar(docMetadata.last_verified),
  };
}

export function collectInlinePathReferences(content = "") {
  const refs = new Set();
  const text = String(content || "").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const value = match[1].trim();
    if (isPlausibleInlinePathReference(value, { fromMarkdownLink: true })) refs.add(value);
  }
  for (const match of text.matchAll(/`([^`]+\.(?:md|mdx|mjs|js|ts|tsx|jsx|py|json|yaml|yml|csv|sql))`/g)) {
    const value = match[1].trim();
    if (isPlausibleInlinePathReference(value, { fromMarkdownLink: false })) refs.add(value);
  }
  return [...refs].slice(0, 80);
}

function isPlausibleInlinePathReference(value, { fromMarkdownLink = false } = {}) {
  const clean = String(value || "").trim();
  if (!clean || clean.startsWith("#")) return false;
  if (/^[a-z]+:/i.test(clean)) return true;
  if (/\s/.test(clean)) return false;
  if (/[<>{}\[\]*]/.test(clean)) return false;
  if (/[;&|`$]/.test(clean)) return false;
  if (clean.includes("...")) return false;
  if (!fromMarkdownLink && !clean.includes("/") && !clean.startsWith("~") && !clean.startsWith(".")) {
    return /\.(?:md|mdx)$/i.test(clean);
  }
  return true;
}

function normalizeRelPath(relPath) {
  return String(relPath || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}
