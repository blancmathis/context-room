import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = "context-room.context-snapshot/1";
export const DEFAULT_CONTEXT_SNAPSHOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_CONTEXT_SNAPSHOT_MAX_ENTRIES = 1_000;

const OMITTED_METADATA_KEYS = new Set([
  "body",
  "bytes",
  "content",
  "contents",
  "diff",
  "document",
  "documents",
  "event",
  "events",
  "prompt",
  "prompts",
  "raw",
  "task",
  "tasks",
  "text",
]);

export class ContextSnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ContextSnapshotError";
    this.code = code;
    this.details = details;
  }
}

function snapshotHome() {
  const configured = process.env.CONTEXT_ROOM_SNAPSHOT_HOME;
  return configured
    ? path.resolve(configured)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "context-snapshots");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function cleanString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function safeMetadata(value, depth = 0) {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => safeMetadata(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (OMITTED_METADATA_KEYS.has(key.toLowerCase())) continue;
    const normalized = safeMetadata(value[key], depth + 1);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function metadataOrNull(value) {
  const normalized = safeMetadata(value);
  return normalized === undefined ? null : normalized;
}

function normalizeCoordinate(coordinate = {}) {
  return {
    projectId: cleanString(coordinate.projectId),
    locationId: cleanString(coordinate.locationId),
    folder: cleanString(coordinate.folder || ".") || ".",
    provider: cleanString(coordinate.provider || "all") || "all",
  };
}

function normalizeResource(resource = {}) {
  return {
    id: cleanString(resource.id),
    kind: cleanString(resource.kind),
    source: metadataOrNull(resource.source),
    locator: metadataOrNull(resource.locator),
    providers: [...new Set((resource.providers || []).map(cleanString).filter(Boolean))].sort(),
    version: metadataOrNull(resource.version),
    truthState: cleanString(resource.truthState),
    review: metadataOrNull(resource.review),
  };
}

function normalizeApplication(application = {}, fallbackCoordinate) {
  return {
    resourceId: cleanString(application.resourceId),
    coordinate: normalizeCoordinate(application.coordinate || fallbackCoordinate),
    status: cleanString(application.status),
    scope: metadataOrNull(application.scope),
    order: Number.isFinite(Number(application.order)) ? Number(application.order) : null,
    reason: metadataOrNull(application.reason),
    destination: metadataOrNull(application.destination),
    provider: cleanString(application.provider || application.coordinate?.provider || fallbackCoordinate.provider),
  };
}

function normalizeSharedRevision(shared = {}) {
  return {
    id: cleanString(shared.id || shared.sharedId || shared.repository),
    repository: cleanString(shared.repository),
    defaultBranch: cleanString(shared.defaultBranch || "main") || "main",
    projectId: cleanString(shared.projectId),
    revision: cleanString(shared.revision),
  };
}

function sortByStableValue(items) {
  return [...items].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function normalizedWatermarks(effective = {}) {
  const source = effective.watermarks || {};
  return safeMetadata({
    gitHead: source.gitHead ?? effective.gitHead ?? "",
    configRevision: source.configRevision ?? effective.configRevision ?? "",
    review: source.review ?? source.reviewRevision ?? effective.reviewWatermark ?? "",
  });
}

function manifestPayload(effective, options = {}) {
  const coordinate = normalizeCoordinate(effective.coordinate || effective.target || options.coordinate);
  const resources = sortByStableValue((effective.resources || []).map(normalizeResource));
  const applications = sortByStableValue((effective.applications || []).map((application) => normalizeApplication(application, coordinate)));
  const sharedRevisions = sortByStableValue((effective.sharedRevisions || effective.shared?.revisions || []).map(normalizeSharedRevision));
  return {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    resolverVersion: cleanString(options.resolverVersion || effective.resolverVersion || "1"),
    providerProfileVersion: cleanString(options.providerProfileVersion || effective.providerProfileVersion || "1"),
    coordinate,
    resources,
    applications,
    watermarks: normalizedWatermarks(effective),
    sharedRevisions,
  };
}

function payloadId(payload) {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function snapshotPath(storageRoot, snapshotId) {
  if (!/^[a-f0-9]{64}$/.test(String(snapshotId || ""))) {
    throw new ContextSnapshotError("invalid-snapshot-id", "Context snapshot ID must be a SHA-256 hexadecimal digest.", { snapshotId });
  }
  return path.join(storageRoot, `${snapshotId}.json`);
}

function writePrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function revisionFromVerification(result) {
  if (typeof result === "string") return { revision: result, online: true };
  return {
    revision: cleanString(result?.revision || result?.head || result?.commit),
    online: result?.online !== false && result?.verified !== false,
  };
}

async function verifySharedRevisions(sharedRevisions, verifySharedRevision) {
  if (sharedRevisions.length === 0) return;
  if (typeof verifySharedRevision !== "function") {
    throw new ContextSnapshotError(
      "shared-freshness-unverified",
      "Creating a shared context snapshot requires an online verification of the accepted branch head.",
      { sharedRevisions },
    );
  }
  for (const shared of sharedRevisions) {
    let verified;
    try {
      verified = revisionFromVerification(await verifySharedRevision(shared, { refresh: true }));
    } catch (error) {
      throw new ContextSnapshotError("shared-freshness-unverified", "Unable to verify the accepted shared branch head.", {
        shared,
        cause: error?.message || String(error),
      });
    }
    if (!verified.online || !verified.revision || verified.revision !== shared.revision) {
      throw new ContextSnapshotError("shared-freshness-unverified", "The shared revision is not the currently verified accepted branch head.", {
        shared,
        verifiedRevision: verified.revision,
      });
    }
  }
}

export function buildContextSnapshotManifest(effective, options = {}) {
  const payload = manifestPayload(effective || {}, options);
  return { snapshotId: payloadId(payload), ...payload };
}

export async function createContextSnapshot(effective, options = {}) {
  const storageRoot = path.resolve(options.storageRoot || snapshotHome());
  const manifest = buildContextSnapshotManifest(effective, options);
  await verifySharedRevisions(manifest.sharedRevisions, options.verifySharedRevision);
  const filePath = snapshotPath(storageRoot, manifest.snapshotId);
  const existed = fs.existsSync(filePath);
  if (!existed) writePrivateJson(filePath, manifest);
  else fs.chmodSync(filePath, 0o600);
  fs.chmodSync(storageRoot, 0o700);
  pruneContextSnapshots({
    storageRoot,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
    maxEntries: options.maxEntries,
    preserve: [manifest.snapshotId],
  });
  return { manifest, path: filePath, created: !existed };
}

export function readContextSnapshot(snapshotId, options = {}) {
  const storageRoot = path.resolve(options.storageRoot || snapshotHome());
  const filePath = snapshotPath(storageRoot, snapshotId);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new ContextSnapshotError("snapshot-not-found", `Context snapshot ${snapshotId} was not found.`, { snapshotId });
    throw new ContextSnapshotError("invalid-snapshot", `Context snapshot ${snapshotId} cannot be read.`, { snapshotId, cause: error?.message || String(error) });
  }
  if (manifest?.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
    throw new ContextSnapshotError("invalid-snapshot", `Context snapshot ${snapshotId} uses an unsupported schema.`, { snapshotId, schemaVersion: manifest?.schemaVersion });
  }
  const { snapshotId: storedId, ...payload } = manifest;
  if (storedId !== snapshotId || payloadId(payload) !== snapshotId) {
    throw new ContextSnapshotError("invalid-snapshot", `Context snapshot ${snapshotId} failed its content-address check.`, { snapshotId });
  }
  return manifest;
}

export function listContextSnapshots(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || snapshotHome());
  if (!fs.existsSync(storageRoot)) return [];
  return fs.readdirSync(storageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(storageRoot, entry.name);
      const stat = fs.statSync(filePath);
      return { snapshotId: entry.name.slice(0, -5), path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.snapshotId.localeCompare(right.snapshotId));
}

export function pruneContextSnapshots(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || snapshotHome());
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Math.max(0, Number(options.maxAgeMs)) : DEFAULT_CONTEXT_SNAPSHOT_MAX_AGE_MS;
  const maxEntries = Number.isFinite(Number(options.maxEntries)) ? Math.max(0, Math.floor(Number(options.maxEntries))) : DEFAULT_CONTEXT_SNAPSHOT_MAX_ENTRIES;
  const preserve = new Set(options.preserve || []);
  const entries = listContextSnapshots({ storageRoot });
  const removed = [];
  let retained = 0;
  for (const entry of entries) {
    const keepExplicitly = preserve.has(entry.snapshotId);
    const withinAge = now - entry.mtimeMs <= maxAgeMs;
    const withinCount = retained < maxEntries;
    if (keepExplicitly || (withinAge && withinCount)) {
      retained += 1;
      continue;
    }
    fs.unlinkSync(entry.path);
    removed.push(entry.snapshotId);
  }
  return removed;
}

function byId(items) {
  return new Map((items || []).map((item) => [item.id || item.resourceId, item]));
}

function changedFields(left, right, fields) {
  return fields.filter((field) => stableJson(left?.[field]) !== stableJson(right?.[field]));
}

function applicationKey(application) {
  return stableJson({
    resourceId: application.resourceId,
    coordinate: application.coordinate,
    scope: application.scope,
  });
}

function locatorPath(resource) {
  const locator = resource?.locator;
  if (typeof locator === "string") return locator;
  return cleanString(locator?.path || locator?.repositoryPath || locator?.relativePath);
}

function acceptedReview(review) {
  const status = cleanString(review?.status || review?.state).toLowerCase();
  return ["accepted", "reviewed", "verified"].includes(status);
}

function targetKey(coordinate) {
  return stableJson(normalizeCoordinate(coordinate));
}

function offlineSharedTransition(previous, current, changedResources) {
  const applicablePaths = [...new Set(changedResources.map(locatorPath).filter(Boolean))].sort();
  return {
    id: current.id || previous.id,
    repository: current.repository || previous.repository,
    defaultBranch: current.defaultBranch || previous.defaultBranch,
    fromRevision: previous.revision,
    toRevision: current.revision,
    history: "not-checked-offline",
    commitCount: null,
    changedPaths: applicablePaths,
    applicablePaths,
  };
}

function inferredApplicablePaths(changedPaths, changedResources) {
  const resourcePaths = changedResources.map(locatorPath).filter(Boolean);
  return changedPaths.filter((changedPath) => resourcePaths.some((resourcePath) => (
    changedPath === resourcePath
    || changedPath.startsWith(`${resourcePath.replace(/\/$/, "")}/`)
    || resourcePath.startsWith(`${changedPath.replace(/\/$/, "")}/`)
  )));
}

async function sharedTransitions(from, to, changedResources, diffSharedRevisions) {
  const previousById = new Map(from.sharedRevisions.map((item) => [item.id || item.repository, item]));
  const currentById = new Map(to.sharedRevisions.map((item) => [item.id || item.repository, item]));
  const transitions = [];
  for (const id of [...new Set([...previousById.keys(), ...currentById.keys()])].sort()) {
    const previous = previousById.get(id);
    const current = currentById.get(id);
    if (!previous || !current) {
      transitions.push({
        id,
        repository: current?.repository || previous?.repository || "",
        defaultBranch: current?.defaultBranch || previous?.defaultBranch || "main",
        fromRevision: previous?.revision || null,
        toRevision: current?.revision || null,
        history: previous ? "removed" : "added",
        commitCount: null,
        changedPaths: [],
        applicablePaths: [],
      });
      continue;
    }
    if (previous.revision === current.revision) continue;
    if (typeof diffSharedRevisions !== "function") {
      transitions.push(offlineSharedTransition(previous, current, changedResources));
      continue;
    }
    const result = await diffSharedRevisions(current.repository || previous.repository, {
      fromRevision: previous.revision,
      toRevision: current.revision,
      projectId: current.projectId || previous.projectId || to.coordinate.projectId,
      defaultBranch: current.defaultBranch || previous.defaultBranch,
    });
    if (result?.diverged || result?.history === "diverged" || result?.reachable === false) {
      throw new ContextSnapshotError("shared-history-diverged", "The accepted shared history was rewritten or the target revision is no longer a descendant of the source revision.", {
        sharedId: id,
        fromRevision: previous.revision,
        toRevision: current.revision,
      });
    }
    const changedPaths = [...new Set((result?.changedPaths || result?.paths || []).map(cleanString).filter(Boolean))].sort();
    const callbackApplicablePaths = [...new Set((result?.applicablePaths || []).map(cleanString).filter(Boolean))].sort();
    transitions.push({
      id,
      repository: current.repository || previous.repository,
      defaultBranch: current.defaultBranch || previous.defaultBranch,
      fromRevision: previous.revision,
      toRevision: current.revision,
      history: cleanString(result?.history || "first-parent"),
      commitCount: Number.isFinite(Number(result?.commitCount)) ? Number(result.commitCount) : Array.isArray(result?.commits) ? result.commits.length : null,
      commits: safeMetadata(result?.commits || []),
      changedPaths,
      applicablePaths: callbackApplicablePaths.length > 0
        ? callbackApplicablePaths
        : inferredApplicablePaths(changedPaths, changedResources),
    });
  }
  return transitions;
}

export async function diffContextSnapshots(from, to, options = {}) {
  if (!from || !to) throw new ContextSnapshotError("snapshot-required", "Both context snapshots are required for a diff.");
  if (targetKey(from.coordinate) !== targetKey(to.coordinate)) {
    throw new ContextSnapshotError("snapshot-target-mismatch", "Context snapshots describe different project, location, folder, or provider targets.", {
      from: from.coordinate,
      to: to.coordinate,
    });
  }
  const previousResources = byId(from.resources);
  const currentResources = byId(to.resources);
  const added = [];
  const removed = [];
  const modified = [];
  for (const id of [...new Set([...previousResources.keys(), ...currentResources.keys()])].sort()) {
    const previous = previousResources.get(id);
    const current = currentResources.get(id);
    if (!previous) added.push(current);
    else if (!current) removed.push(previous);
    else {
      const fields = changedFields(previous, current, ["kind", "source", "locator", "providers", "version", "truthState", "review"]);
      if (fields.length > 0) modified.push({ resourceId: id, fields, from: previous, to: current });
    }
  }

  const previousApplications = new Map(from.applications.map((item) => [applicationKey(item), item]));
  const currentApplications = new Map(to.applications.map((item) => [applicationKey(item), item]));
  const applications = [];
  for (const key of [...new Set([...previousApplications.keys(), ...currentApplications.keys()])].sort()) {
    const previous = previousApplications.get(key);
    const current = currentApplications.get(key);
    if (!previous) applications.push({ change: "added", to: current });
    else if (!current) applications.push({ change: "removed", from: previous });
    else {
      const fields = changedFields(previous, current, ["status", "destination", "provider", "reason", "order"]);
      if (fields.length > 0) applications.push({ change: "modified", resourceId: current.resourceId, fields, from: previous, to: current });
    }
  }

  const reviewsObsolete = modified
    .filter((entry) => entry.fields.includes("version") && acceptedReview(entry.from.review))
    .map((entry) => ({ resourceId: entry.resourceId, reason: "version-changed", reviewedVersion: entry.from.version, currentVersion: entry.to.version }));
  reviewsObsolete.push(...removed
    .filter((resource) => acceptedReview(resource.review))
    .map((resource) => ({ resourceId: resource.id, reason: "resource-removed", reviewedVersion: resource.version, currentVersion: null })));
  const changedResources = [...added, ...removed, ...modified.flatMap((entry) => [entry.from, entry.to])];
  const transitions = await sharedTransitions(from, to, changedResources, options.diffSharedRevisions);
  return {
    schemaVersion: "context-room.context-diff/1",
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    coordinate: to.coordinate,
    resources: { added, removed, modified },
    applications,
    reviewsObsolete,
    watermarks: changedFields(from, to, ["watermarks"]).length > 0 ? { from: from.watermarks, to: to.watermarks } : null,
    sharedTransitions: transitions,
    applicablePaths: [...new Set([
      ...changedResources.map(locatorPath).filter(Boolean),
      ...transitions.flatMap((transition) => transition.applicablePaths || []),
    ])].sort(),
  };
}

export async function diffStoredContextSnapshots(fromSnapshotId, toSnapshotId, options = {}) {
  const from = readContextSnapshot(fromSnapshotId, options);
  const to = readContextSnapshot(toSnapshotId, options);
  return diffContextSnapshots(from, to, options);
}
