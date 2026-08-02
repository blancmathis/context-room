import path from "node:path";
import { parseSimpleYaml, yamlScalar } from "./yaml_utils.mjs";
import { builtinMetadataProfiles, extractDocumentMetadata, interpretDocumentMetadata } from "./document_metadata_engine.mjs";

export const DOC_METADATA_KINDS = ["agents", "index", "canonical", "procedure", "decision"];
export const DOC_METADATA_STATUSES = ["current", "target", "draft", "historical", "superseded"];
export const DOC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

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

export function documentIdForPath(relPath = "") {
  const normalized = normalizeRelPath(relPath)
    .replace(/\.(?:md|mdx|html?)$/i, "")
    .replace(/(?:^|\/)index$/i, "")
    .replace(/_target$/i, "")
    .toLowerCase();
  const segments = normalized.split("/")
    .map((segment) => segment.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean);
  if (segments[0] === "docs") segments.shift();
  if (segments.length < 2) segments.unshift("document");
  return segments.join(".") || "document.untitled";
}

export function isValidDocumentId(value = "") {
  return DOC_ID_PATTERN.test(String(value || "").trim());
}

export function isNativeProviderDocumentPath(relPath = "") {
  const base = path.basename(normalizeRelPath(relPath));
  return /^(?:AGENTS|CLAUDE)\.md$/i.test(base) || /^SKILL\.md$/i.test(base);
}

export function documentTruthStateForPath(relPath = "") {
  const normalized = normalizeRelPath(relPath).toLowerCase();
  if (/(?:^|\/)docs\/lifecycle\/changes\/archive(?:\/|$)/.test(normalized)
    || /(?:^|\/)lifecycle\/changes\/archive(?:\/|$)/.test(normalized)
    || /(?:^|\/)docs\/evolution\/changes\/archive(?:\/|$)/.test(normalized)
    || /(?:^|\/)evolution\/changes\/archive(?:\/|$)/.test(normalized)
    || /(?:^|\/)(?:decisions|records)(?:\/|$)/.test(normalized)) return "historical";
  if (/(?:^|\/)docs\/lifecycle\/changes\/active(?:\/|$)/.test(normalized)
    || /(?:^|\/)lifecycle\/changes\/active(?:\/|$)/.test(normalized)
    || /(?:^|\/)docs\/evolution\/changes\/active(?:\/|$)/.test(normalized)
    || /(?:^|\/)evolution\/changes\/active(?:\/|$)/.test(normalized)
    || /(?:^|\/)target(?:\/|$)/.test(normalized)
    || /_target\.(?:md|mdx|html?)$/i.test(normalized)) return "target";
  return "current";
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

function extractHtmlMetadataComment(content = "") {
  const text = String(content || "");
  const match = text.match(/^\s*<!doctype\s+html\s*>\s*<!--([\s\S]*?)-->/i);
  if (!match) return { data: null, body: text, raw: "" };
  return { data: match[1].trim(), body: text.slice(match[0].length), raw: match[0] };
}

function extractDocumentMetadataBlock(content = "", relPath = "") {
  return /\.html?$/i.test(normalizeRelPath(relPath))
    ? extractHtmlMetadataComment(content)
    : extractMarkdownFrontmatter(content);
}

export function parseDocMetadata(content = "", relPath = "") {
  const envelope = extractDocumentMetadata({ content, relPath });
  const generic = interpretDocumentMetadata(envelope, builtinMetadataProfiles());
  const parsed = envelope.raw || {};
  const raw = parsed.context_room || parsed.contextRoom || {};
  if (!raw || typeof raw !== "object" || !Object.keys(raw).length) {
    return {
      present: false,
      parseError: "",
      statusValid: false,
      contract: "legacy",
      id: "",
      idValid: false,
      dependsOn: [],
      truthState: documentTruthStateForPath(relPath),
      rawMetadata: envelope.raw,
      metadataEnvelope: envelope,
      interpretations: generic.interpretations,
      ...normalizeDocMetadata({}, relPath),
      status: "",
    };
  }
  try {
    const hasMinimalContract = Object.hasOwn(raw, "id") || Object.hasOwn(raw, "depends_on") || Object.hasOwn(raw, "dependsOn");
    const hasLegacyContract = ["kind", "scope", "status", "canonical_for", "canonicalFor", "last_verified", "lastVerified", "sources", "source"].some((key) => Object.hasOwn(raw, key));
    const contract = hasMinimalContract && !hasLegacyContract ? "minimal" : "legacy";
    const id = String(raw.id || "").trim();
    const dependsOn = sanitizeReferenceList(raw.depends_on || raw.dependsOn || []);
    const pathTruthState = documentTruthStateForPath(relPath);
    const declaredStatus = String(raw.status || "").trim();
    const statusValid = contract === "minimal" ? true : DOC_METADATA_STATUSES.includes(declaredStatus);
    const truthState = contract === "legacy" && declaredStatus === "target" ? "target" : pathTruthState;
    const inferredStatus = truthState === "current" ? "current" : truthState === "historical" ? "historical" : "draft";
    return {
      present: Boolean(parsed.context_room || parsed.contextRoom),
      parseError: "",
      statusValid,
      contract,
      id,
      idValid: isValidDocumentId(id),
      dependsOn,
      truthState,
      rawMetadata: envelope.raw,
      metadataEnvelope: envelope,
      interpretations: generic.interpretations,
      ...normalizeDocMetadata(raw, relPath),
      status: statusValid ? (contract === "minimal" ? inferredStatus : declaredStatus) : "",
    };
  } catch (error) {
    return {
      present: false,
      parseError: error.message,
      statusValid: false,
      contract: "legacy",
      id: "",
      idValid: false,
      dependsOn: [],
      truthState: documentTruthStateForPath(relPath),
      rawMetadata: envelope.raw,
      metadataEnvelope: envelope,
      interpretations: generic.interpretations,
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
    id: String(metadata?.id || documentIdForPath(normalized)).trim(),
    id_yaml: yamlScalar(String(metadata?.id || documentIdForPath(normalized)).trim()),
    depends_on_block: (() => {
      const dependencies = sanitizeReferenceList(metadata?.depends_on || metadata?.dependsOn || []);
      return dependencies.length ? `  depends_on:\n${dependencies.map((dependency) => `    - ${yamlScalar(dependency)}`).join("\n")}\n` : "";
    })(),
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
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const value = match[1].split("|", 1)[0].trim();
    if (value && !/[<>{}\[\]*;&|`$]/.test(value) && !value.includes("...") && !/^\s*#/.test(value)) refs.add(value);
  }
  for (const match of text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1].trim();
    if (isPlausibleInlinePathReference(value, { fromMarkdownLink: true })) refs.add(value);
  }
  return [...refs].slice(0, 80);
}

export function parseContextRoomUri(value = "") {
  const match = String(value || "").trim().match(/^cr:\/\/([^#?]+?)(?:#([^\s]+))?$/i);
  if (!match) return null;
  const segments = match[1].split("/").filter(Boolean);
  if (!segments.length || segments.length > 2) return null;
  let projectId = "";
  let id = "";
  try {
    if (segments.length === 2) projectId = decodeURIComponent(segments[0]);
    id = decodeURIComponent(segments.at(-1));
  } catch {
    return null;
  }
  let anchor = "";
  try { anchor = decodeURIComponent(match[2] || ""); } catch { anchor = match[2] || ""; }
  return projectId ? { id, projectId, anchor } : { id, anchor };
}

export function collectContextRoomLinks(content = "") {
  const links = [];
  const seen = new Set();
  for (const match of String(content || "").matchAll(/cr:\/\/[^\s"'<>`\])}]+/gi)) {
    const parsed = parseContextRoomUri(match[0]);
    if (!parsed) continue;
    const key = `${parsed.id}#${parsed.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(parsed);
  }
  return links;
}

export function collectMermaidDocumentLinks(content = "") {
  const links = [];
  for (const block of String(content || "").matchAll(/```mermaid\s*\n([\s\S]*?)```/gi)) {
    for (const match of block[1].matchAll(/^\s*click\s+([A-Za-z0-9_-]+)\s+["'](cr:\/\/[^"']+)["']/gim)) {
      const target = parseContextRoomUri(match[2]);
      if (target) links.push({ nodeId: match[1], ...target, uri: match[2] });
    }
  }
  return links;
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
