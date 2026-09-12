import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDocumentAssetPath, DOCUMENT_ASSET_FORMATS } from "./document_assets.mjs";

import { buildDocQaReport, buildDocumentationGraph, buildReadOnlyDocumentationReviewSnapshot, listMemoryFiles, readProjectDocumentAssets } from "./context_room.mjs";
import { collectInlinePathReferences, collectMermaidDocumentLinks, parseContextRoomUri, parseDocMetadata } from "./doc_metadata.mjs";
import { inspectDocumentMetadata, loadMetadataProfiles, valueAtPath } from "./document_metadata_engine.mjs";
import { buildContextCoverage, groupDocumentSearchResults } from "./product_compression.mjs";
import {
  readSharedDocumentationProposalDocuments,
  readAcceptedSharedMetadataProfiles,
  readSharedSessionProposalDocuments,
  resolveSharedDocumentationTarget,
  resolveSharedSessionProposals,
  sharedContextStatus,
} from "./shared_context.mjs";

export const DEFAULT_DOCUMENTATION_BUDGET = 1200;

const MAX_DOC_BYTES = 2_000_000;
const MAX_SEARCH_RESULTS = 30;
const MIN_CONTEXT_BUDGET = 256;
const MAX_CONTEXT_BUDGET = 8000;

function normalizedPath(value = "") {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function documentationAbsolutePath(root, relPath) {
  const value = normalizedPath(relPath);
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.resolve(root, value);
}

function isWithin(parent, candidate) {
  const base = path.resolve(parent);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

function gitOutput(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function resolveDocumentationProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {}
  while (true) {
    if (fs.existsSync(path.join(current, ".context-room", "config.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const gitRoot = gitOutput(path.resolve(start), ["rev-parse", "--show-toplevel"]);
  return gitRoot ? path.resolve(gitRoot) : path.resolve(start);
}

function decodeHtmlEntities(value = "") {
  return String(value)
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripHtmlTags(value = "") {
  return decodeHtmlEntities(String(value).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function searchableHtml(value = "") {
  return String(value)
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, title) => `\n${"#".repeat(Number(level))} ${stripHtmlTags(title)}\n`)
    .replace(/<\/(?:p|li|div|section|article|aside|header|footer|main|tr|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .split("\n")
    .map((line) => decodeHtmlEntities(line).replace(/[\t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function documentReferences(content, kind) {
  const references = new Set(collectInlinePathReferences(content));
  if (kind === "html") {
    for (const match of String(content).matchAll(/\bhref=["']([^"']+)["']/gi)) {
      const href = match[1].trim();
      if (href && !href.startsWith("#")) references.add(href);
    }
  }
  return [...references].slice(0, 100);
}

function slugifyHeading(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function withoutFrontmatter(content = "") {
  const lines = String(content).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { text: String(content), lineOffset: 0 };
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end === -1) return { text: String(content), lineOffset: 0 };
  return { text: lines.slice(end + 2).join("\n"), lineOffset: end + 2 };
}

function sectionRecords(content, relPath, kind) {
  const prepared = kind === "html" ? searchableHtml(content) : withoutFrontmatter(content).text;
  const lineOffset = kind === "html" ? 0 : withoutFrontmatter(content).lineOffset;
  const lines = prepared.split(/\r?\n/);
  const headings = [];
  const stack = [];
  const slugCounts = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const level = match[1].length;
    const heading = match[2].trim();
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    stack.push({ level, heading });
    const baseSlug = slugifyHeading(heading);
    const count = (slugCounts.get(baseSlug) || 0) + 1;
    slugCounts.set(baseSlug, count);
    headings.push({
      index,
      level,
      heading,
      headingPath: stack.map((item) => item.heading),
      slug: count === 1 ? baseSlug : `${baseSlug}-${count}`,
    });
  }
  if (!headings.length) {
    const text = prepared.trim();
    return [{
      selector: relPath,
      slug: "",
      heading: "Document",
      headingPath: [],
      level: 0,
      lineStart: lineOffset + 1,
      lineEnd: lineOffset + Math.max(lines.length, 1),
      content: text,
      tokenEstimate: estimateTokens(text),
    }];
  }
  return headings.map((item, itemIndex) => {
    let endIndex = lines.length;
    for (const next of headings.slice(itemIndex + 1)) {
      if (next.level <= item.level) {
        endIndex = next.index;
        break;
      }
    }
    const text = lines.slice(item.index, endIndex).join("\n").trim();
    return {
      selector: `${relPath}#${item.slug}`,
      slug: item.slug,
      heading: item.heading,
      headingPath: item.headingPath,
      level: item.level,
      lineStart: lineOffset + item.index + 1,
      lineEnd: lineOffset + Math.max(endIndex, item.index + 1),
      content: text,
      tokenEstimate: estimateTokens(text),
    };
  });
}

function inferredTruthState(relPath, metadata) {
  if (["current", "target", "historical"].includes(metadata?.truthState)) return metadata.truthState;
  const value = normalizedPath(relPath).toLowerCase();
  if (/(^|\/)(?:_?targets?|plans?|proposals?|roadmap)(\/|$)/.test(value) || /(?:^|[_-])target\.(?:md|mdx|html?)$/.test(value)) return "target";
  if (metadata?.kind === "decision" || ["historical", "superseded"].includes(metadata?.status)) return "record";
  if (metadata?.present && metadata?.statusValid) return metadata.status;
  return "current";
}

function inferredKind(relPath, metadata, fileKind) {
  if (metadata?.present) return metadata.kind;
  const value = normalizedPath(relPath).toLowerCase();
  if (/(^|\/)(?:agents|claude)\.md$/.test(value)) return "agents";
  if (/(^|\/)(?:index|readme)\.(?:md|mdx|html?)$/.test(value)) return "index";
  if (/(decision|adr|record|incident|research)/.test(value)) return "decision";
  return fileKind === "html" ? "visual" : "canonical";
}

function sourceDetails(root, absolutePath, shared, localRevision) {
  if (shared.connected && shared.cacheRoot && isWithin(shared.cacheRoot, absolutePath)) {
    return { source: "shared-accepted", revision: shared.revision || "unknown" };
  }
  if (isWithin(root, absolutePath)) return { source: "local", revision: localRevision || "unversioned" };
  return { source: "external-local", revision: "working-tree" };
}

function documentationFileKind(filePath) {
  if (/[.]html?$/i.test(filePath)) return "html";
  if (/[.](?:md|mdx|txt)$/i.test(filePath)) return "markdown";
  if (/[.](?:mmd|mermaid)$/i.test(filePath)) return "diagram";
  if (/[.](?:ya?ml|jsonc?)$/i.test(filePath)) return "structured";
  return "";
}

function sharedDocumentationFiles(target) {
  const files = [];
  const visit = (absoluteRoot) => {
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
      const absolutePath = path.join(absoluteRoot, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && (documentationFileKind(entry.name) || isDocumentAssetPath(entry.name))) files.push(absolutePath);
    }
  };
  for (const root of target.roots || []) visit(root.absolutePath);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function sharedAcceptedDocuments(target) {
  return sharedDocumentationFiles(target).flatMap((absolutePath) => {
    const repositoryPath = path.relative(target.root, absolutePath).replaceAll(path.sep, "/");
    const fileKind = documentationFileKind(repositoryPath);
    let stats;
    try { stats = fs.statSync(absolutePath); } catch { return []; }
    if (!stats.isFile() || stats.size > (isDocumentAssetPath(repositoryPath) ? 20 * 1024 * 1024 : MAX_DOC_BYTES)) return [];
    if (isDocumentAssetPath(repositoryPath)) {
      const bytes = fs.readFileSync(absolutePath), digest = createHash("sha256").update(bytes).digest("hex"), mimeType = DOCUMENT_ASSET_FORMATS.get(path.extname(repositoryPath).slice(1));
      const content = `${repositoryPath}\nAccepted ${mimeType} asset. SHA-256 ${digest}.`;
      return [{ path: repositoryPath, repositoryPath, absolutePath, label: path.basename(repositoryPath), format: "asset", kind: "asset", truthState: "current",
        reviewStatus: "accepted", source: "shared-accepted", revision: target.revision, metadata: {}, references: [], health: [],
        bytes: bytes.length, updatedAt: null, contentHash: digest, rawContent: content, content, sections: [],
        asset: { mimeType, acceptedFile: absolutePath, bytes: bytes.length } }];
    }
    const rawContent = fs.readFileSync(absolutePath, "utf8");
    const metadata = parseDocMetadata(rawContent, repositoryPath);
    const document = {
      path: repositoryPath,
      repositoryPath,
      absolutePath,
      label: path.basename(repositoryPath),
      format: fileKind,
      kind: inferredKind(repositoryPath, metadata, fileKind),
      truthState: inferredTruthState(repositoryPath, metadata),
      reviewStatus: "accepted",
      metadata,
      references: documentReferences(rawContent, fileKind),
      health: [],
      source: "shared-accepted",
      revision: target.revision,
      bytes: stats.size,
      updatedAt: null,
      contentHash: contentHash(rawContent),
      rawContent,
      content: fileKind === "html" ? searchableHtml(rawContent) : withoutFrontmatter(rawContent).text.trim(),
      sections: sectionRecords(rawContent, repositoryPath, fileKind),
    };
    document.sections = document.sections.map((section) => ({ ...section, contentHash: contentHash(section.content) }));
    return [document];
  });
}

function contentHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sessionProposalOverlayFromEnvironment() {
  const raw = String(process.env.CONTEXT_ROOM_DOC_PROPOSALS || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("overlay must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`Invalid frozen session proposal overlay: ${error.message}`);
  }
}

function proposalVirtualPath(proposal, repositoryPath) {
  return normalizedPath(`_session-proposals/${proposal.branch}/${repositoryPath}`);
}

function sessionProposalDocuments(projectRoot, overlay, sharedTarget = null) {
  if (!overlay?.sessionId || !Array.isArray(overlay.proposals) || !overlay.proposals.length) return [];
  const proposalDocuments = sharedTarget
    ? readSharedDocumentationProposalDocuments(sharedTarget, overlay)
    : readSharedSessionProposalDocuments(projectRoot, overlay);
  return proposalDocuments.map((item) => {
    const fileKind = /[.]html?$/i.test(item.path) ? "html" : "markdown";
    const relPath = proposalVirtualPath(item.proposal, item.path);
    const metadata = parseDocMetadata(item.content, item.path);
    const document = {
      path: relPath,
      repositoryPath: item.path,
      absolutePath: "",
      label: path.basename(item.path),
      format: fileKind,
      kind: inferredKind(item.path, metadata, fileKind),
      truthState: "proposal",
      reviewStatus: "proposal",
      metadata,
      references: documentReferences(item.content, fileKind),
      health: [],
      source: "session-proposal",
      revision: item.proposal.head,
      bytes: Buffer.byteLength(item.content),
      updatedAt: null,
      contentHash: contentHash(item.content),
      rawContent: item.content,
      content: fileKind === "html" ? searchableHtml(item.content) : withoutFrontmatter(item.content).text.trim(),
      sections: sectionRecords(item.content, relPath, fileKind),
      deleted: item.deleted,
      proposal: item.proposal,
    };
    document.sections = document.sections.map((section) => ({ ...section, contentHash: contentHash(section.content) }));
    return document;
  });
}

export function estimateTokens(value = "") {
  return Math.max(1, Math.ceil(String(value).length / 4));
}

export function buildDocumentationCorpus(root = process.cwd(), options = {}) {
  const acceptedOnly = options.acceptedOnly !== false || process.env.CONTEXT_ROOM_DOC_ACCEPTED_ONLY === "1";
  const readOnly = options.readOnly === true;
  const sessionId = acceptedOnly
    ? ""
    : String(options.sessionId || process.env.CONTEXT_ROOM_DOC_SESSION || process.env.CODEX_THREAD_ID || "").trim();
  const frozenOverlay = acceptedOnly ? null : options.proposalOverlay || sessionProposalOverlayFromEnvironment();
  const repository = String(options.repository || "").trim();
  const projectId = String(options.projectId || "").trim();
  if (Boolean(repository) !== Boolean(projectId)) throw new Error("Shared-only documentation requires both --repository and --project");
  const sharedTarget = repository ? (options.sharedTarget || resolveSharedDocumentationTarget(repository, {
    projectId,
    sessionId,
    acceptedRevision: options.acceptedRevision,
    allowOffline: options.allowOffline !== false,
  })) : null;
  const projectRoot = sharedTarget?.root || resolveDocumentationProjectRoot(root);
  const shared = sharedTarget ? { connected: true, revision: sharedTarget.revision } : sharedContextStatus(projectRoot);
  const connectedTarget = !sharedTarget && shared.connected ? resolveSharedDocumentationTarget(shared.connection.repository, {
    projectId: shared.connection.projectId, sessionId: "", allowOffline: options.allowOffline !== false,
  }) : null;
  if (connectedTarget) shared.revision = connectedTarget.revision;
  const localRevision = sharedTarget ? "" : gitOutput(projectRoot, ["rev-parse", "HEAD"]);
  const documents = sharedTarget ? sharedAcceptedDocuments(sharedTarget) : [];
  if (!sharedTarget) {
    const readOnlySnapshot = acceptedOnly || readOnly ? buildReadOnlyDocumentationReviewSnapshot(projectRoot) : null;
    const files = (acceptedOnly ? readOnlySnapshot?.acceptedFiles : readOnlySnapshot?.files) || listMemoryFiles(projectRoot);
    const graph = readOnlySnapshot
      ? buildDocumentationGraph(projectRoot, {
          settings: readOnlySnapshot.settings,
          files,
          sharedProfiles: [],
          readOnly: true,
        })
      : buildDocumentationGraph(projectRoot);
    const reviewByPath = readOnlySnapshot?.reviewByPath
      || new Map((buildDocQaReport(projectRoot).queue || []).map((item) => [normalizedPath(item.path), item]));
    const graphByPath = new Map(graph.nodes.map((node) => [node.path, node]));
    for (const file of files) {
      if (!file.exists || !["markdown", "html", "json", "yaml", "diagram-source"].includes(file.kind) && !/\.(?:mmd|mermaid|ya?ml|jsonc?)$/i.test(file.path)) continue;
      const absolutePath = documentationAbsolutePath(projectRoot, file.path);
      let stats;
      if (file.acceptedSnapshot) stats = { size: file.bytes, mtime: new Date(file.updatedAt || 0), isFile: () => true };
      else { try { stats = fs.statSync(absolutePath); } catch { continue; } }
      if (!stats.isFile() || stats.size > MAX_DOC_BYTES) continue;
      const rawContent = typeof file.content === "string" ? file.content : fs.readFileSync(absolutePath, "utf8");
      const graphNode = graphByPath.get(file.path);
      const parsedMetadata = parseDocMetadata(rawContent, file.path);
      const metadata = graphNode?.metadata || parsedMetadata;
      const details = sourceDetails(projectRoot, absolutePath, shared, localRevision);
      // Managed Shared projections can lag or move during a command. Use the pinned snapshot below.
      if (connectedTarget && details.source === "shared-accepted") continue;
      const queuedReview = reviewByPath.get(normalizedPath(file.path));
      const dependencyFreshness = queuedReview?.reviewReason === "dependency-changed" ? "needs-review" : "current";
      const acceptedSharedMain = details.source === "shared-accepted";
      const document = {
        path: file.path,
        absolutePath,
        label: file.label || path.basename(file.path),
        format: documentationFileKind(file.path) || file.kind,
        kind: inferredKind(file.path, metadata, file.kind),
        truthState: inferredTruthState(file.path, parsedMetadata),
        reviewStatus: file.acceptedSnapshot || acceptedSharedMain || !queuedReview || queuedReview.reviewReason === "dependency-changed" ? "accepted" : "unverified",
        dependencyFreshness,
        metadata,
        references: graphNode?.references || documentReferences(rawContent, file.kind),
        health: graphNode?.health || [],
        source: details.source,
        revision: details.revision,
        bytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
        contentHash: contentHash(rawContent),
        rawContent,
        content: file.kind === "html" ? searchableHtml(rawContent) : withoutFrontmatter(rawContent).text.trim(),
        sections: sectionRecords(rawContent, file.path, documentationFileKind(file.path) || file.kind),
      };
      document.sections = document.sections.map((section) => ({
        ...section,
        contentHash: contentHash(section.content),
      }));
      documents.push(document);
    }
  }
  if (connectedTarget) {
    for (const document of sharedAcceptedDocuments(connectedTarget)) {
      const virtualPath = `_shared/${document.repositoryPath}`;
      documents.push({ ...document, path: virtualPath,
        sections: document.sections.map((section) => ({ ...section, selector: section.selector.replace(document.path, virtualPath) })) });
    }
  }
  if (!sharedTarget) {
    for (const asset of readProjectDocumentAssets(projectRoot, { acceptedOnly: true })) {
      if (!asset.before) continue;
      const content = `${asset.path}\nAccepted ${asset.mimeType} asset. SHA-256 ${asset.before.hash}.`;
      documents.push({ path: asset.path, absolutePath: asset.before.absolutePath, label: path.basename(asset.path),
        format: "asset", kind: "asset", truthState: "current", reviewStatus: "accepted", dependencyFreshness: "current",
        metadata: {}, references: [], health: [], source: "local", revision: asset.before.hash,
        bytes: asset.before.bytes.length, updatedAt: asset.before.at, contentHash: asset.before.hash,
        rawContent: content, content, sections: [], asset: { mimeType: asset.mimeType, acceptedFile: asset.before.absolutePath, bytes: asset.before.bytes.length } });
    }
  }
  if (acceptedOnly) {
    for (let index = documents.length - 1; index >= 0; index -= 1) {
      const document = documents[index];
      if (document.reviewStatus !== "accepted" || document.source === "session-proposal") {
        documents.splice(index, 1);
      }
    }
  }
  const acceptedCorpusHash = contentHash(documents
    .map((document) => `${document.path}\0${document.contentHash}`)
    .sort()
    .join("\n"));
  const expectedAcceptedRevision = String(options.expectedAcceptedRevision || process.env.CONTEXT_ROOM_DOC_EXPECTED_REVISION || "").trim();
  if (acceptedOnly && expectedAcceptedRevision && acceptedCorpusHash !== expectedAcceptedRevision) {
    throw new Error(`Accepted documentation corpus changed during read-only research (expected ${expectedAcceptedRevision}, received ${acceptedCorpusHash})`);
  }
  if (sessionId && frozenOverlay?.sessionId && frozenOverlay.sessionId !== sessionId) {
    throw new Error(`Frozen session proposal overlay belongs to ${frozenOverlay.sessionId}, not ${sessionId}`);
  }
  const proposalOverlay = acceptedOnly ? null : frozenOverlay || (sessionId
    ? sharedTarget?.proposalOverlay || resolveSharedSessionProposals(projectRoot, { sessionId })
    : null);
  const proposals = sessionProposalDocuments(projectRoot, proposalOverlay, sharedTarget);
  documents.push(...proposals);
  const corpusHash = contentHash(documents
    .map((document) => `${document.path}\0${document.revision}\0${document.contentHash}`)
    .sort()
    .join("\n"));
  return {
    generatedAt: new Date().toISOString(),
    root: projectRoot,
    access: { acceptedOnly },
    target: sharedTarget ? {
      mode: sharedTarget.mode,
      repository: sharedTarget.repository,
      repositoryName: sharedTarget.repositoryName,
      projectId: sharedTarget.projectId,
      projectTitle: sharedTarget.projectTitle,
      online: sharedTarget.online,
      fetchError: sharedTarget.fetchError,
    } : connectedTarget ? { mode: "mixed-or-connected", repository: connectedTarget.repository, projectId: connectedTarget.projectId,
      online: connectedTarget.online, fetchError: connectedTarget.fetchError,
      remoteStatus: connectedTarget.online ? "verified" : "unverified-cached" }
      : { mode: "local", projectId: "" },
    revision: {
      local: sharedTarget ? "not-applicable" : localRevision || "unversioned",
      shared: shared.connected ? shared.revision || "unknown" : "not-connected",
      acceptedCorpus: acceptedCorpusHash,
      corpus: corpusHash,
      sessionProposals: (proposalOverlay?.proposals || []).map((proposal) => ({ branch: proposal.branch, head: proposal.head })),
    },
    session: proposalOverlay?.sessionId ? {
      id: proposalOverlay.sessionId,
      proposals: proposalOverlay.proposals || [],
    } : null,
    documents: documents.sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

export function documentationCapabilities(root = process.cwd(), options = {}) {
  const current = options.corpus || buildDocumentationCorpus(root, options);
  const canonicalSubjects = [...new Set(current.documents
    .filter((document) => document.source !== "session-proposal" && document.metadata?.canonical_for)
    .map((document) => document.metadata.canonical_for))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .slice(0, 100);
  return {
    version: 1,
    projectRoot: current.root,
    target: current.target,
    revision: current.revision,
    corpus: {
      documents: current.documents.length,
      acceptedDocuments: current.documents.filter((document) => document.source !== "session-proposal").length,
      pendingSessionDocuments: current.documents.filter((document) => document.source === "session-proposal").length,
      sections: current.documents.reduce((sum, document) => sum + document.sections.length, 0),
      sources: countBy(current.documents.map((document) => document.source)),
      truthStates: countBy(current.documents.map((document) => document.truthState)),
      kinds: countBy(current.documents.map((document) => document.kind)),
      canonicalSubjects,
    },
    session: current.session,
    commands: [
      { name: "search", usage: "context-room docs search <query> [--status current|target] [--kind canonical] [--limit 8] [--budget 1200]", purpose: "Find compact evidence in accepted documentation without reading whole documents." },
      { name: "read", usage: "context-room docs read <path[#section]> [--budget 1600]", purpose: "Read one exact document or section with provenance." },
      { name: "related", usage: "context-room docs related <path>", purpose: "Follow declared sources, Markdown links, and incoming documentation references." },
      { name: "trace", usage: "context-room docs trace <path[#section]>", purpose: "Inspect truth state, canonical ownership, revision, hash, and health." },
      { name: "inspect", usage: "context-room docs inspect <path-or-id>", purpose: "Return the compact aggregate of metadata, profiles, relations, diagrams, trust, and health." },
      { name: "metadata", usage: "context-room docs metadata <path-or-id>", purpose: "Inspect raw and interpreted metadata with source provenance." },
      { name: "links", usage: "context-room docs links <path-or-id>", purpose: "List outgoing references and reference-strength relations." },
      { name: "backlinks", usage: "context-room docs backlinks <path-or-id>", purpose: "List incoming references and derived inverse relations." },
      { name: "dependencies", usage: "context-room docs dependencies <path-or-id>", purpose: "Inspect declared relations and their freshness independently from content verification." },
      { name: "diagrams", usage: "context-room docs diagrams <path-or-id>", purpose: "Inspect Mermaid sources and safe Context Room node links." },
      { name: "validate", usage: "context-room docs validate <path-or-id>", purpose: "Run metadata, profile, relation, renderer, and trust diagnostics for one document." },
    ],
  };
}

function normalizedSearchText(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function searchTerms(query = "") {
  return [...new Set(normalizedSearchText(query).match(/[a-z0-9][a-z0-9._/-]{1,}/g) || [])];
}

function searchScore(document, section, query, terms) {
  const phrase = normalizedSearchText(query).trim();
  const heading = normalizedSearchText(section.headingPath.join(" "));
  const canonical = normalizedSearchText(document.metadata?.canonical_for || "");
  const docPath = normalizedSearchText(document.path);
  const content = normalizedSearchText(section.content);
  let score = 0;
  if (phrase && heading.includes(phrase)) score += 120;
  if (phrase && canonical.includes(phrase)) score += 110;
  if (phrase && docPath.includes(phrase)) score += 80;
  if (phrase && content.includes(phrase)) score += 45;
  for (const term of terms) {
    if (heading.includes(term)) score += 28;
    if (canonical.includes(term)) score += 24;
    if (docPath.includes(term)) score += 16;
    if (content.includes(term)) score += 7;
  }
  if (!score) return 0;
  if (document.truthState === "current") score += 18;
  if (document.kind === "index") score += 8;
  if (document.kind === "canonical") score += 6;
  if (document.truthState === "historical" || document.truthState === "record") score -= 4;
  return score;
}

function searchRankingReasons(document, section, query, terms) {
  const phrase = normalizedSearchText(query).trim();
  const heading = normalizedSearchText(section.headingPath.join(" "));
  const canonical = normalizedSearchText(document.metadata?.canonical_for || document.metadata?.canonicalFor || "");
  const docPath = normalizedSearchText(document.path);
  const content = normalizedSearchText(section.content);
  const reasons = [];
  if (phrase && canonical.includes(phrase)) reasons.push("Matches the declared canonical subject.");
  if (phrase && heading.includes(phrase)) reasons.push("Matches the section heading exactly.");
  if (phrase && docPath.includes(phrase)) reasons.push("Matches the document path.");
  if (phrase && content.includes(phrase)) reasons.push("Matches the section content.");
  if (terms.some((term) => heading.includes(term))) reasons.push("Heading contains task terms.");
  if (document.truthState === "current" && document.reviewStatus === "accepted") reasons.push("Accepted current documentation.");
  if (["canonical", "index"].includes(document.kind)) reasons.push(document.kind === "canonical" ? "Declared canonical document." : "Documentation entry point.");
  return uniqueStrings(reasons).slice(0, 4);
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function compactSnippet(content, query, maxChars = 420) {
  const text = String(content).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const normalized = normalizedSearchText(text);
  const terms = searchTerms(query);
  const indexes = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0);
  const center = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, Math.min(text.length - maxChars, center - Math.floor(maxChars / 3)));
  const excerpt = text.slice(start, start + maxChars).trim();
  return `${start ? "…" : ""}${excerpt}${start + maxChars < text.length ? "…" : ""}`;
}

function normalizeLimit(value, fallback = 8) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_RESULTS) throw new Error(`limit must be an integer from 1 to ${MAX_SEARCH_RESULTS}`);
  return parsed;
}

export function normalizeContextBudget(value, fallback = DEFAULT_DOCUMENTATION_BUDGET) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < MIN_CONTEXT_BUDGET || parsed > MAX_CONTEXT_BUDGET) {
    throw new Error(`budget must be an integer from ${MIN_CONTEXT_BUDGET} to ${MAX_CONTEXT_BUDGET}`);
  }
  return parsed;
}

const STRUCTURED_SEARCH_FILTERS = new Set(["id", "profile", "depends-on", "referenced-by", "diagram", "truth"]);

function parseStructuredSearchQuery(query = "") {
  const filters = [];
  const remaining = [];
  for (const token of String(query).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      remaining.push(token);
      continue;
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1).replace(/^"|"$/g, "");
    if (!value || (!STRUCTURED_SEARCH_FILTERS.has(key) && !key.startsWith("meta."))) {
      remaining.push(token);
      continue;
    }
    filters.push({ key, value });
  }
  return { text: remaining.join(" ").trim(), filters };
}

function documentMetadataRaw(document) {
  return document.metadata?.metadataEnvelope?.raw || document.metadata?.rawMetadata || {};
}

function documentProfileIds(document) {
  return (document.metadata?.interpretations || []).map((item) => item.profile?.id).filter(Boolean);
}

function structuredSearchMatch(document, filter, corpus) {
  const wanted = normalizedSearchText(filter.value);
  if (filter.key === "id") return (document.metadata?.identities || []).some((identity) => normalizedSearchText(identity.value) === wanted) || normalizedSearchText(document.metadata?.id || "") === wanted;
  if (filter.key === "profile") return documentProfileIds(document).some((id) => normalizedSearchText(id).includes(wanted));
  if (filter.key === "truth") return normalizedSearchText(document.truthState) === wanted;
  if (filter.key === "depends-on") return (document.metadata?.relations || []).some((relation) => relation.type === "depends-on" && normalizedSearchText(relation.target).includes(wanted)) || (document.metadata?.dependsOn || []).some((value) => normalizedSearchText(value).includes(wanted));
  if (filter.key === "diagram") return /```mermaid/i.test(document.rawContent || "") && (!wanted || normalizedSearchText(document.rawContent).includes(wanted));
  if (filter.key === "referenced-by") {
    const currentIds = new Set([document.metadata?.id, ...(document.metadata?.identities || []).map((identity) => identity.value)].filter(Boolean).map(normalizedSearchText));
    return corpus.documents.some((candidate) => normalizedSearchText(candidate.path).includes(wanted) && (candidate.references || []).some((reference) => currentIds.has(normalizedSearchText(parseContextRoomUri(reference.target || reference)?.id || reference.target || reference))));
  }
  if (filter.key.startsWith("meta.")) {
    const actual = valueAtPath(documentMetadataRaw(document), filter.key.slice(5));
    return normalizedSearchText(Array.isArray(actual) ? actual.join(" ") : actual == null ? "" : typeof actual === "object" ? JSON.stringify(actual) : actual).includes(wanted);
  }
  return true;
}

export function searchDocumentation(root = process.cwd(), query = "", options = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("search requires a query");
  const structured = parseStructuredSearchQuery(text);
  const corpus = options.corpus || buildDocumentationCorpus(root, options);
  const limit = normalizeLimit(options.limit);
  const budget = normalizeContextBudget(options.budget);
  const status = String(options.status || "").trim();
  const kind = String(options.kind || "").trim();
  const terms = searchTerms(structured.text);
  const candidates = [];
  for (const document of corpus.documents) {
    if (!status && (document.truthState !== "current" || document.reviewStatus !== "accepted")) continue;
    if (status === "unverified" ? document.reviewStatus !== "unverified" : status && document.truthState !== status) continue;
    if (kind && document.kind !== kind) continue;
    if (!structured.filters.every((filter) => structuredSearchMatch(document, filter, corpus))) continue;
    for (const section of document.sections) {
      const score = structured.text ? searchScore(document, section, structured.text, terms) : 1;
      if (score <= 0) continue;
      candidates.push({ document, section, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score
    || left.document.path.localeCompare(right.document.path, "en")
    || left.section.lineStart - right.section.lineStart);
  const results = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    if (results.length >= limit) break;
    const snippet = compactSnippet(candidate.section.content, structured.text);
    const tokenEstimate = estimateTokens(snippet);
    if (results.length && usedTokens + tokenEstimate > budget) break;
    usedTokens += tokenEstimate;
    results.push({
      selector: candidate.section.selector,
      path: candidate.document.path,
      repositoryPath: candidate.document.repositoryPath,
      section: candidate.section.headingPath.join(" > ") || candidate.section.heading,
      lineStart: candidate.section.lineStart,
      lineEnd: candidate.section.lineEnd,
      truthState: candidate.document.truthState,
      kind: candidate.document.kind,
      source: candidate.document.source,
      revision: candidate.document.revision,
      score: candidate.score,
      rankingReasons: searchRankingReasons(candidate.document, candidate.section, structured.text, terms),
      snippet,
      contentHash: candidate.section.contentHash,
      deleted: candidate.document.deleted,
      proposal: candidate.document.proposal,
    });
  }
  const grouped = groupDocumentSearchResults(results);
  return {
    schemaVersion: "context-room.document-search/2",
    query: text,
    filters: { status: status || null, kind: kind || null, structured: structured.filters },
    budget,
    estimatedTokens: usedTokens,
    revision: corpus.revision,
    results,
    groups: grouped.groups,
  };
}

function splitSelector(value = "") {
  const raw = String(value || "").trim();
  const contextLink = parseContextRoomUri(raw);
  if (contextLink) return { path: contextLink.id, section: contextLink.anchor, documentId: contextLink.id };
  const selector = normalizedPath(raw);
  const hashIndex = selector.indexOf("#");
  return hashIndex === -1
    ? { path: selector, section: "" }
    : { path: selector.slice(0, hashIndex), section: selector.slice(hashIndex + 1) };
}

function findDocument(corpus, requestedPath) {
  const requestedId = parseContextRoomUri(requestedPath)?.id || (/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(requestedPath) ? requestedPath : "");
  if (requestedId) {
    const matches = corpus.documents.filter((document) => document.metadata?.id === requestedId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Ambiguous documentation ID: ${requestedId}. Matches: ${matches.map((item) => item.path).join(", ")}`);
    throw new Error(`Documentation ID not found: ${requestedId}`);
  }
  const exact = corpus.documents.find((document) => document.path === requestedPath);
  if (exact) return exact;
  const lowered = normalizedSearchText(requestedPath);
  const matches = corpus.documents.filter((document) => normalizedSearchText(document.path) === lowered
    || normalizedSearchText(path.basename(document.path)) === lowered);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous documentation path: ${requestedPath}. Matches: ${matches.map((item) => item.path).join(", ")}`);
  throw new Error(`Documentation path not found: ${requestedPath}`);
}

function findSection(document, requestedSection) {
  if (!requestedSection) return null;
  const normalized = slugifyHeading(requestedSection);
  const exact = document.sections.find((section) => section.slug === requestedSection || section.slug === normalized
    || normalizedSearchText(section.heading) === normalizedSearchText(requestedSection));
  if (exact) return exact;
  const matches = document.sections.filter((section) => normalizedSearchText(section.heading).includes(normalizedSearchText(requestedSection)));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous documentation section: ${requestedSection}. Matches: ${matches.map((item) => item.selector).join(", ")}`);
  throw new Error(`Documentation section not found: ${document.path}#${requestedSection}`);
}

function truncateToTokenBudget(content, budget) {
  const maxChars = budget * 4;
  const text = String(content);
  if (text.length <= maxChars) return { content: text, truncated: false, estimatedTokens: estimateTokens(text) };
  return { content: text.slice(0, maxChars).trimEnd() + "\n\n[Truncated: request this section again with a larger --budget.]", truncated: true, estimatedTokens: budget };
}

export function readDocumentation(root = process.cwd(), selector = "", options = {}) {
  const requested = splitSelector(selector || options.path || "");
  if (!requested.path) throw new Error("read requires a documentation path");
  if (options.section) requested.section = String(options.section);
  const corpus = options.corpus || buildDocumentationCorpus(root, options);
  const document = findDocument(corpus, requested.path);
  const section = findSection(document, requested.section);
  const budget = normalizeContextBudget(options.budget, 1600);
  const selectedContent = section?.content || document.content;
  const output = truncateToTokenBudget(selectedContent, budget);
  return {
    selector: section?.selector || document.path,
    path: document.path,
    documentId: document.metadata?.id || "",
    repositoryPath: document.repositoryPath,
    section: section?.headingPath.join(" > ") || null,
    lineStart: section?.lineStart || 1,
    lineEnd: section?.lineEnd || document.content.split(/\r?\n/).length,
    truthState: document.truthState,
    kind: document.kind,
    source: document.source,
    revision: document.revision,
    contentHash: section?.contentHash || document.contentHash,
    truncated: output.truncated,
    estimatedTokens: output.estimatedTokens,
    content: output.content,
    ...(document.asset ? { asset: document.asset } : {}),
    deleted: document.deleted,
    proposal: document.proposal,
    availableSections: section ? [] : document.sections.map((item) => ({ selector: item.selector, heading: item.headingPath.join(" > ") || item.heading })),
  };
}

function referencePath(fromPath, reference) {
  const clean = String(reference || "").split("#")[0].split("?")[0].trim();
  if (!clean || /^[a-z]+:/i.test(clean) || clean.startsWith("~/") || path.isAbsolute(clean)) return clean;
  return normalizedPath(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), clean)));
}

export function relatedDocumentation(root = process.cwd(), selector = "", options = {}) {
  const requested = splitSelector(selector || options.path || "");
  if (!requested.path) throw new Error("related requires a documentation path");
  const corpus = options.corpus || buildDocumentationCorpus(root, options);
  const document = findDocument(corpus, requested.path);
  const byId = new Map();
  for (const candidate of corpus.documents) {
    const documentId = candidate.metadata?.id;
    if (!documentId) continue;
    if (!byId.has(documentId)) byId.set(documentId, []);
    byId.get(documentId).push(candidate);
  }
  const dependencies = [...new Set(document.metadata?.dependsOn || [])].map((documentId) => {
    const matches = byId.get(documentId) || [];
    return { documentId, resolvedPath: matches.length === 1 ? matches[0].path : "", status: matches.length === 1 ? "resolved" : matches.length ? "ambiguous" : "not-found" };
  });
  const outgoing = [...new Set([...(document.metadata?.sources || []), ...document.references])].map((reference) => ({
    reference,
    resolvedPath: referencePath(document.path, reference),
  }));
  const incoming = [];
  const dependedOnBy = [];
  for (const candidate of corpus.documents) {
    if (candidate.path === document.path) continue;
    const references = [...new Set([...(candidate.metadata?.sources || []), ...candidate.references])];
    if (references.some((reference) => referencePath(candidate.path, reference) === document.path)) {
      incoming.push({ path: candidate.path, truthState: candidate.truthState, kind: candidate.kind, source: candidate.source });
    }
    if (document.metadata?.id && (candidate.metadata?.dependsOn || []).includes(document.metadata.id)) dependedOnBy.push({ path: candidate.path, documentId: candidate.metadata?.id || "", truthState: candidate.truthState, kind: candidate.kind, source: candidate.source });
  }
  return {
    path: document.path,
    documentId: document.metadata?.id || "",
    repositoryPath: document.repositoryPath,
    source: document.source,
    proposal: document.proposal,
    revision: corpus.revision,
    outgoing,
    incoming,
    dependsOn: dependencies,
    dependedOnBy,
  };
}

export function traceDocumentation(root = process.cwd(), selector = "", options = {}) {
  const requested = splitSelector(selector || options.path || "");
  if (!requested.path) throw new Error("trace requires a documentation path");
  const corpus = options.corpus || buildDocumentationCorpus(root, options);
  const document = findDocument(corpus, requested.path);
  const section = findSection(document, requested.section || options.section || "");
  return {
    selector: section?.selector || document.path,
    path: document.path,
    documentId: document.metadata?.id || "",
    repositoryPath: document.repositoryPath,
    section: section?.headingPath.join(" > ") || null,
    truthState: document.truthState,
    kind: document.kind,
    scope: document.metadata?.scope || "project",
    canonicalFor: document.metadata?.canonical_for || "",
    lastVerified: document.metadata?.last_verified || "",
    declaredSources: document.metadata?.sources || [],
    dependsOn: document.metadata?.dependsOn || [],
    dependencyFreshness: document.dependencyFreshness || "current",
    metadataProfiles: document.metadata?.interpretations?.map((item) => item.profile) || [],
    references: document.references,
    source: document.source,
    revision: document.revision,
    contentHash: section?.contentHash || document.contentHash,
    deleted: document.deleted,
    proposal: document.proposal,
    health: document.health,
    corpusRevision: corpus.revision,
  };
}

function documentInspection(root, selector, options = {}) {
  const requested = splitSelector(selector || options.path || "");
  if (!requested.path) throw new Error("inspect requires a documentation path or ID");
  const corpus = options.corpus || buildDocumentationCorpus(root, options);
  const document = findDocument(corpus, requested.path);
  const rawContent = document.rawContent ?? (document.absolutePath && fs.existsSync(document.absolutePath) ? fs.readFileSync(document.absolutePath, "utf8") : "");
  const profileSet = options.profileSet || loadMetadataProfiles({ root: corpus.root, sharedProfiles: readAcceptedSharedMetadataProfiles(corpus.root) });
  const metadataInspection = inspectDocumentMetadata({
    content: rawContent,
    relPath: document.repositoryPath || document.path,
    root: corpus.root,
    absolutePath: document.absolutePath || "",
  }, { profileSet });
  return { corpus, document, metadataInspection, rawContent };
}

export function inspectDocumentation(root = process.cwd(), selector = "", options = {}) {
  const { corpus, document, metadataInspection, rawContent } = documentInspection(root, selector, options);
  const related = relatedDocumentation(root, document.path, { ...options, corpus });
  const diagrams = collectMermaidDocumentLinks(rawContent);
  return {
    schemaVersion: "context-room.docs-inspect/1",
    document: {
      path: document.path,
      repositoryPath: document.repositoryPath,
      documentId: document.metadata?.id || "",
      kind: document.kind,
      format: document.format,
      truthState: document.truthState,
      reviewStatus: document.reviewStatus,
      dependencyFreshness: document.dependencyFreshness || "current",
      source: document.source,
      revision: document.revision,
      contentHash: document.contentHash,
    },
    metadata: metadataInspection.metadata,
    profiles: metadataInspection.profiles,
    identities: metadataInspection.identities,
    relations: metadataInspection.relations,
    references: related.outgoing,
    backlinks: related.incoming,
    dependencies: related.dependsOn,
    dependedOnBy: related.dependedOnBy,
    diagramAppearances: diagrams,
    health: [...(document.health || []), ...metadataInspection.health],
    freshness: { corpusRevision: corpus.revision, dependency: document.dependencyFreshness || "current" },
  };
}

export function metadataDocumentation(root = process.cwd(), selector = "", options = {}) {
  const inspected = inspectDocumentation(root, selector, options);
  return { schemaVersion: "context-room.docs-metadata/1", document: inspected.document, metadata: inspected.metadata, profiles: inspected.profiles, identities: inspected.identities, health: inspected.health };
}

export function linksDocumentation(root = process.cwd(), selector = "", options = {}) {
  const inspected = inspectDocumentation(root, selector, options);
  return { schemaVersion: "context-room.docs-links/1", document: inspected.document, links: inspected.references, relations: inspected.relations.filter((item) => item.strength !== "declared") };
}

export function backlinksDocumentation(root = process.cwd(), selector = "", options = {}) {
  const inspected = inspectDocumentation(root, selector, options);
  return { schemaVersion: "context-room.docs-backlinks/1", document: inspected.document, backlinks: inspected.backlinks, dependedOnBy: inspected.dependedOnBy };
}

export function dependenciesDocumentation(root = process.cwd(), selector = "", options = {}) {
  const inspected = inspectDocumentation(root, selector, options);
  return { schemaVersion: "context-room.docs-dependencies/1", document: inspected.document, dependencyFreshness: inspected.document.dependencyFreshness, dependencies: inspected.dependencies, dependedOnBy: inspected.dependedOnBy, declaredRelations: inspected.relations.filter((item) => item.strength === "declared") };
}

export function diagramsDocumentation(root = process.cwd(), selector = "", options = {}) {
  const { document, rawContent } = documentInspection(root, selector, options);
  const blocks = [];
  for (const match of String(rawContent).matchAll(/```mermaid\s*\n([\s\S]*?)```/gi)) {
    const before = rawContent.slice(0, match.index);
    blocks.push({ line: before.split(/\r?\n/).length, source: match[1], links: collectMermaidDocumentLinks(match[0]) });
  }
  if (/\.(?:mmd|mermaid)$/i.test(document.path)) blocks.push({ line: 1, source: rawContent, links: collectMermaidDocumentLinks(`\`\`\`mermaid\n${rawContent}\n\`\`\``) });
  return { schemaVersion: "context-room.docs-diagrams/1", document: { path: document.path, documentId: document.metadata?.id || "", truthState: document.truthState, revision: document.revision }, diagrams: blocks };
}

export function validateDocumentation(root = process.cwd(), selector = "", options = {}) {
  const inspected = inspectDocumentation(root, selector, options);
  return { schemaVersion: "context-room.docs-validate/1", document: inspected.document, valid: !inspected.health.some((issue) => ["error", "high"].includes(issue.severity)), issues: inspected.health };
}
