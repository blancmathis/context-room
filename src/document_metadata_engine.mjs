import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { getNodeValue, parseTree } from "jsonc-parser";
import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";

export const DOCUMENT_METADATA_ENVELOPE_VERSION = "context-room.document-metadata/1";
export const METADATA_PROFILE_VERSION = "context-room.metadata-profile/1";
export const DOCUMENT_INSPECTION_VERSION = "context-room.document-inspection/1";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_METADATA_DEPTH = 64;
const MAX_PROFILE_FILES = 100;
const PROFILE_SCHEMA_PATH = new URL("../schemas/document-metadata-profile.schema.json", import.meta.url);
const BUILTIN_PROFILE_PATH = new URL("../profiles/context-room-documentation.profile.json", import.meta.url);

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function unixPath(value = "") {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function lineStarts(source = "") {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function sourcePosition(starts, offset = 0) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1, offset };
}

function rangeFor(starts, start = 0, end = start) {
  return { start: sourcePosition(starts, start), end: sourcePosition(starts, end) };
}

function setRange(target, pathParts, value) {
  target[pathParts.join(".")] = value;
}

function walkYamlNode(node, starts, ranges, pathParts = [], depth = 0) {
  if (!node || depth > MAX_METADATA_DEPTH) return;
  if (node.range) setRange(ranges, pathParts, rangeFor(starts, node.range[0], node.range[1]));
  if (isMap(node)) {
    for (const item of node.items || []) {
      if (!isPair(item)) continue;
      const key = isScalar(item.key) ? String(item.key.value) : String(item.key?.toJSON?.() ?? "");
      walkYamlNode(item.value, starts, ranges, [...pathParts, key], depth + 1);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => walkYamlNode(item, starts, ranges, [...pathParts, String(index)], depth + 1));
  }
}

function parseYamlMetadata(raw, sourceName) {
  if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) throw new Error(`Metadata exceeds ${MAX_METADATA_BYTES} bytes: ${sourceName}`);
  const document = parseDocument(raw, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    merge: false,
    schema: "core",
  });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  const data = document.toJS({ maxAliasCount: 50 });
  const ranges = {};
  walkYamlNode(document.contents, lineStarts(raw), ranges);
  return { data: data && typeof data === "object" ? data : {}, ranges, format: "yaml" };
}

function walkJsonNode(node, starts, ranges, pathParts = [], depth = 0) {
  if (!node || depth > MAX_METADATA_DEPTH) return;
  setRange(ranges, pathParts, rangeFor(starts, node.offset, node.offset + node.length));
  for (const child of node.children || []) {
    if (node.type === "object" && child.type === "property") {
      const key = String(getNodeValue(child.children?.[0]) ?? "");
      walkJsonNode(child.children?.[1], starts, ranges, [...pathParts, key], depth + 1);
    } else if (node.type === "array") {
      walkJsonNode(child, starts, ranges, [...pathParts, String((node.children || []).indexOf(child))], depth + 1);
    }
  }
}

function parseJsonMetadata(raw, sourceName, { allowComments = false } = {}) {
  if (Buffer.byteLength(raw, "utf8") > MAX_METADATA_BYTES) throw new Error(`Metadata exceeds ${MAX_METADATA_BYTES} bytes: ${sourceName}`);
  const errors = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: allowComments, disallowComments: !allowComments });
  if (!tree || errors.length) throw new Error(`Invalid JSON metadata in ${sourceName}`);
  const ranges = {};
  walkJsonNode(tree, lineStarts(raw), ranges);
  const data = getNodeValue(tree);
  return { data: data && typeof data === "object" ? data : {}, ranges, format: "json" };
}

export function parseMetadataSource(raw = "", { format = "yaml", source = "metadata", lineOffset = 0 } = {}) {
  try {
    const parsed = ["json", "jsonc"].includes(format) ? parseJsonMetadata(raw, source, { allowComments: format === "jsonc" }) : parseYamlMetadata(raw, source);
    if (lineOffset) {
      for (const value of Object.values(parsed.ranges)) {
        value.start.line += lineOffset;
        value.end.line += lineOffset;
      }
    }
    return { source, raw, parseError: "", ...parsed };
  } catch (error) {
    return { source, raw, data: {}, ranges: {}, format, parseError: error.message };
  }
}

function markdownFrontmatter(content = "") {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  return { raw: match[1], lineOffset: 1, block: match[0] };
}

function htmlMetadata(content = "") {
  const text = String(content);
  const explicit = text.match(/^\s*<!doctype\s+html\s*>\s*<!--\s*context-room-metadata\s*\r?\n([\s\S]*?)-->/i);
  if (explicit) return { raw: explicit[1].trimEnd(), lineOffset: text.slice(0, explicit.index + explicit[0].indexOf(explicit[1])).split(/\r?\n/).length - 1, block: explicit[0], explicit: true };
  const legacy = text.match(/^\s*<!doctype\s+html\s*>\s*<!--([\s\S]*?)-->/i);
  if (legacy && /^\s*(?:context_room|contextRoom)\s*:/m.test(legacy[1])) return { raw: legacy[1].trim(), lineOffset: 1, block: legacy[0], explicit: false };
  return null;
}

function metadataBlock(content, relPath) {
  return /\.html?$/i.test(relPath) ? htmlMetadata(content) : /\.(?:md|mdx)$/i.test(relPath) ? markdownFrontmatter(content) : null;
}

function sidecarCandidates(absolutePath) {
  return [`${absolutePath}.meta.yaml`, `${absolutePath}.meta.yml`, `${absolutePath}.meta.json`];
}

function mergeMetadataValue(target, incoming, sourceName, pathParts, provenance, conflicts) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const output = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  for (const [key, value] of Object.entries(incoming)) {
    const childPath = [...pathParts, key];
    const dotted = childPath.join(".");
    if (!(key in output)) {
      output[key] = value && typeof value === "object" && !Array.isArray(value)
        ? mergeMetadataValue({}, value, sourceName, childPath, provenance, conflicts)
        : value;
      provenance[dotted] = sourceName;
      continue;
    }
    if (output[key] && typeof output[key] === "object" && !Array.isArray(output[key]) && value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = mergeMetadataValue(output[key], value, sourceName, childPath, provenance, conflicts);
      continue;
    }
    if (JSON.stringify(output[key]) !== JSON.stringify(value)) {
      conflicts.push({ path: dotted, sources: [provenance[dotted] || "unknown", sourceName], values: [output[key], value] });
      continue;
    }
  }
  return output;
}

function withinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function extractDocumentMetadata({ content = "", relPath = "", root = "", absolutePath = "", readFile = fs.readFileSync } = {}) {
  const normalized = unixPath(relPath);
  const sources = [];
  const block = metadataBlock(content, normalized);
  if (block) sources.push(parseMetadataSource(block.raw, { source: `${normalized}#metadata`, lineOffset: block.lineOffset }));
  if (/\.(?:ya?ml|jsonc?)$/i.test(normalized) && !block) {
    sources.push(parseMetadataSource(content, { format: /\.jsonc$/i.test(normalized) ? "jsonc" : /\.json$/i.test(normalized) ? "json" : "yaml", source: normalized }));
  }
  const resolvedFile = absolutePath || (root && normalized ? path.resolve(root, normalized) : "");
  if (resolvedFile && root && withinRoot(resolvedFile, root)) {
    for (const candidate of sidecarCandidates(resolvedFile)) {
      if (!withinRoot(candidate, root) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const raw = readFile(candidate, "utf8");
      sources.push(parseMetadataSource(raw, { format: /\.json$/i.test(candidate) ? "json" : "yaml", source: unixPath(path.relative(root, candidate)) }));
    }
  }
  const merged = {};
  const provenance = {};
  const conflicts = [];
  for (const source of sources) if (!source.parseError) mergeMetadataValue(merged, source.data, source.source, [], provenance, conflicts);
  return {
    schemaVersion: DOCUMENT_METADATA_ENVELOPE_VERSION,
    path: normalized,
    sources,
    raw: merged,
    provenance,
    conflicts,
    parseErrors: sources.filter((source) => source.parseError).map((source) => ({ source: source.source, message: source.parseError })),
    sourceHash: sha256(sources.map((source) => `${source.source}\0${source.raw}`).join("\0")),
  };
}

export function valueAtPath(value, dottedPath = "") {
  if (!dottedPath) return value;
  return String(dottedPath).split(".").reduce((current, segment) => current == null ? undefined : current[segment], value);
}

function globToRegExp(glob = "") {
  const source = unixPath(glob);
  let expression = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*" && source[index + 2] === "/") {
      expression += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && source[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "i");
}

export function metadataProfileMatches(profile, relPath = "") {
  return (profile.match || []).some((glob) => globToRegExp(glob).test(unixPath(relPath)));
}

function loadProfileFile(filePath, origin) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = /\.json$/i.test(filePath) ? parseJsonMetadata(raw, filePath).data : parseYamlMetadata(raw, filePath).data;
  return { ...parsed, origin, filePath, contentHash: sha256(raw) };
}

function profileValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(PROFILE_SCHEMA_PATH, "utf8"));
  return ajv.compile(schema);
}

const validateProfile = profileValidator();

function normalizeProfile(profile, fallbackOrigin = "runtime") {
  const { origin = fallbackOrigin, filePath = "", contentHash = "", valid: _valid, errors: _errors, ...definition } = profile || {};
  const valid = validateProfile(definition);
  return { ...definition, origin, filePath: String(filePath || ""), contentHash, valid: Boolean(valid), errors: valid ? [] : (validateProfile.errors || []).map((error) => ({ path: error.instancePath, message: error.message })) };
}

const BUILTIN_PROFILE = normalizeProfile(loadProfileFile(BUILTIN_PROFILE_PATH, "builtin"));

export function builtinMetadataProfiles() {
  return [BUILTIN_PROFILE];
}

function profileFiles(directory) {
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.(?:json|ya?ml)$/i.test(entry.name)).slice(0, MAX_PROFILE_FILES).map((entry) => path.join(directory, entry.name));
}

export function loadMetadataProfiles({ root = "", deviceRoot = path.join(os.homedir(), ".context-room", "profiles"), sharedProfiles = [], pluginProfiles = [] } = {}) {
  const collected = [BUILTIN_PROFILE];
  for (const filePath of profileFiles(root ? path.join(root, ".context-room", "profiles") : "")) collected.push(loadProfileFile(filePath, "project"));
  for (const filePath of profileFiles(deviceRoot)) collected.push(loadProfileFile(filePath, "device"));
  collected.push(...sharedProfiles.map((profile) => ({ ...profile, origin: "shared" })), ...pluginProfiles.map((profile) => ({ ...profile, origin: "plugin" })));
  const profiles = collected.map((profile) => normalizeProfile(profile));
  const conflicts = [];
  const byId = new Map();
  for (const profile of profiles) {
    const existing = byId.get(profile.id);
    if (existing && (existing.version !== profile.version || existing.contentHash !== profile.contentHash)) conflicts.push({ id: profile.id, profiles: [existing, profile] });
    else if (!existing) byId.set(profile.id, profile);
  }
  return { profiles, conflicts };
}

function relationValues(value) {
  if (value == null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

export function interpretDocumentMetadata(envelope, profiles = []) {
  const interpretations = [];
  for (const profile of profiles) {
    if (!profile.valid || !metadataProfileMatches(profile, envelope.path)) continue;
    const identityValue = profile.identity?.path ? valueAtPath(envelope.raw, profile.identity.path) : undefined;
    const relations = [];
    for (const relation of profile.relations || []) {
      for (const target of relationValues(valueAtPath(envelope.raw, relation.path))) {
        relations.push({
          type: relation.type,
          label: relation.label,
          reverseLabel: relation.reverseLabel,
          strength: relation.strength || "declared",
          target,
          metadataPath: relation.path,
          sourceRange: envelope.sources.map((source) => source.ranges?.[relation.path]).find(Boolean) || null,
        });
      }
    }
    interpretations.push({
      profile: { id: profile.id, version: profile.version, origin: profile.origin, filePath: profile.filePath || "" },
      identity: identityValue == null || identityValue === "" ? null : { value: String(identityValue), metadataPath: profile.identity.path, sourceRange: envelope.sources.map((source) => source.ranges?.[profile.identity.path]).find(Boolean) || null },
      relations,
      display: profile.display || {},
      schema: profile.schema || null,
    });
  }
  const identities = interpretations.map((item) => item.identity && ({ ...item.identity, profileId: item.profile.id })).filter(Boolean);
  const identityConflicts = identities.length > 1 && new Set(identities.map((item) => item.value)).size > 1 ? identities : [];
  return { interpretations, identities, identityConflicts };
}

function readProfileSchema(profile, { root = "", schemaDocuments = {} } = {}) {
  const definition = profile.schema;
  if (!definition) return { schema: null, issue: null };
  let raw = "";
  let source = "";
  if (definition.path) {
    const candidate = path.resolve(root || process.cwd(), definition.path);
    if (!root || !withinRoot(candidate, root)) return { schema: null, issue: { type: "metadata_schema_outside_project", severity: "error", profileId: profile.id, source: definition.path } };
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return { schema: null, issue: { type: "metadata_schema_missing", severity: "error", profileId: profile.id, source: definition.path } };
    raw = fs.readFileSync(candidate, "utf8");
    source = unixPath(path.relative(root, candidate));
  } else if (definition.url) {
    raw = String(schemaDocuments[definition.url] || "");
    source = definition.url;
    if (!raw) return { schema: null, issue: { type: "metadata_schema_download_required", severity: "warning", profileId: profile.id, source: definition.url, message: "Remote schemas are never downloaded while opening a document." } };
  }
  if (definition.sha256 && sha256(raw) !== definition.sha256) return { schema: null, issue: { type: "metadata_schema_hash_mismatch", severity: "error", profileId: profile.id, source } };
  try {
    return { schema: JSON.parse(raw), source, issue: null };
  } catch (error) {
    return { schema: null, issue: { type: "metadata_schema_invalid", severity: "error", profileId: profile.id, source, message: error.message } };
  }
}

function validateAgainstProfileSchemas(envelope, profiles, options = {}) {
  const issues = [];
  for (const profile of profiles) {
    if (!profile.valid || !metadataProfileMatches(profile, envelope.path) || !profile.schema) continue;
    const loaded = readProfileSchema(profile, options);
    if (loaded.issue) {
      issues.push(loaded.issue);
      continue;
    }
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(loaded.schema);
      if (!validate(envelope.raw)) issues.push({
        type: "metadata_schema_validation_failed",
        severity: "error",
        profileId: profile.id,
        source: loaded.source,
        errors: (validate.errors || []).map((error) => ({ path: error.instancePath, message: error.message })),
      });
    } catch (error) {
      issues.push({ type: "metadata_schema_incompatible", severity: "error", profileId: profile.id, source: loaded.source, message: error.message });
    }
  }
  return issues;
}

function evaluateProfileLintRules(envelope, profiles) {
  const issues = [];
  for (const profile of profiles) {
    if (!profile.valid || !metadataProfileMatches(profile, envelope.path)) continue;
    for (const rule of profile.lintRules || []) {
      const actual = valueAtPath(envelope.raw, rule.path);
      let failed = false;
      if (rule.operator === "required") failed = actual == null || actual === "" || (Array.isArray(actual) && !actual.length);
      else if (rule.operator === "equals") failed = JSON.stringify(actual) !== JSON.stringify(rule.value);
      else if (rule.operator === "one-of") failed = !(rule.values || []).some((value) => JSON.stringify(value) === JSON.stringify(actual));
      else if (rule.operator === "matches") {
        try { failed = !new RegExp(rule.pattern || "").test(String(actual ?? "")); }
        catch { failed = true; }
      }
      if (failed) issues.push({
        type: "metadata_profile_lint",
        severity: rule.severity || "warning",
        profileId: profile.id,
        ruleId: rule.id,
        metadataPath: rule.path,
        sourceRange: envelope.sources.map((source) => source.ranges?.[rule.path]).find(Boolean) || null,
        message: rule.message,
      });
    }
  }
  return issues;
}

export function inspectDocumentMetadata(input = {}, options = {}) {
  const envelope = extractDocumentMetadata(input);
  const loaded = options.profileSet || loadMetadataProfiles({ root: input.root, sharedProfiles: options.sharedProfiles, pluginProfiles: options.pluginProfiles });
  const interpreted = interpretDocumentMetadata(envelope, loaded.profiles);
  return {
    schemaVersion: DOCUMENT_INSPECTION_VERSION,
    document: { path: envelope.path, sourceHash: envelope.sourceHash },
    metadata: envelope,
    profiles: interpreted.interpretations,
    identities: interpreted.identities,
    relations: interpreted.interpretations.flatMap((item) => item.relations.map((relation) => ({ ...relation, profileId: item.profile.id }))),
    health: [
      ...envelope.parseErrors.map((error) => ({ type: "metadata_parse_error", severity: "error", ...error })),
      ...envelope.conflicts.map((conflict) => ({ type: "metadata_source_conflict", severity: "error", ...conflict })),
      ...loaded.profiles.filter((profile) => !profile.valid).map((profile) => ({ type: "metadata_profile_invalid", severity: "error", profileId: profile.id || "unknown", errors: profile.errors })),
      ...loaded.conflicts.map((conflict) => ({ type: "metadata_profile_conflict", severity: "error", profileId: conflict.id })),
      ...(interpreted.identityConflicts.length ? [{ type: "metadata_identity_conflict", severity: "error", identities: interpreted.identityConflicts }] : []),
      ...validateAgainstProfileSchemas(envelope, loaded.profiles, { root: input.root, schemaDocuments: options.schemaDocuments }),
      ...evaluateProfileLintRules(envelope, loaded.profiles),
    ],
  };
}
