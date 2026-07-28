import path from "node:path";

import {
  CONTEXT_PROVIDER_PROFILE_VERSION,
  contextProviderProfile,
  isContextProvider,
  listContextProviderProfiles,
} from "./provider_profiles.mjs";

const RESOURCE_KINDS = new Set(["instruction", "skill", "hook", "provider-config", "document", "proposal"]);
const APPLICATION_STATUSES = new Set(["active", "inactive", "disabled", "shadowed", "uncertain", "blocked", "unverified"]);

function unixPath(value = "") {
  return String(value).replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function normalizedFolder(value = ".") {
  const folder = unixPath(value || ".");
  if (!folder || folder === ".") return ".";
  if (path.posix.isAbsolute(folder) || folder === ".." || folder.startsWith("../")) throw new Error(`Context folder must be relative: ${value}`);
  return path.posix.normalize(folder);
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== undefined && value !== null && value !== ""))];
}

function coordinateKey(coordinate) {
  return [coordinate.projectId, coordinate.locationId, coordinate.folder, coordinate.provider].join("\0");
}

export function normalizeContextCoordinate(input = {}) {
  const projectId = String(input.projectId || "").trim();
  const locationId = String(input.locationId || "").trim();
  const provider = String(input.provider || "codex").trim().toLowerCase();
  if (!projectId) throw new Error("Context coordinate requires projectId");
  if (provider !== "all" && !isContextProvider(provider)) throw new Error(`Unsupported context provider: ${provider}`);
  return Object.freeze({ projectId, locationId, folder: normalizedFolder(input.folder), provider });
}

export function createContextResource(input = {}) {
  const id = String(input.id || "").trim();
  const kind = String(input.kind || "").trim();
  if (!id) throw new Error("Context resource requires id");
  if (!RESOURCE_KINDS.has(kind)) throw new Error(`Unsupported context resource kind: ${kind || "(empty)"}`);
  const locator = String(input.locator || "").trim();
  if (!locator) throw new Error(`Context resource ${id} requires locator`);
  const providers = unique((input.providers || ["all"]).map((item) => String(item).trim().toLowerCase()));
  for (const provider of providers) {
    if (provider !== "all" && !isContextProvider(provider)) throw new Error(`Context resource ${id} has unsupported provider: ${provider}`);
  }
  return Object.freeze({
    ...input,
    id,
    kind,
    source: String(input.source || "local"),
    locator,
    providers,
    version: String(input.version || "unknown"),
    truthState: String(input.truthState || "unknown"),
    review: input.review ? { ...input.review } : null,
    metadata: input.metadata ? { ...input.metadata } : {},
  });
}

export function createContextApplication(input = {}) {
  const resourceId = String(input.resourceId || "").trim();
  if (!resourceId) throw new Error("Context application requires resourceId");
  const coordinate = normalizeContextCoordinate(input.coordinate || {});
  let status = String(input.status || "").trim();
  if (!status) status = input.evidence ? "active" : "uncertain";
  if (!APPLICATION_STATUSES.has(status)) throw new Error(`Unsupported context application status: ${status}`);
  return Object.freeze({
    ...input,
    resourceId,
    coordinate,
    status,
    scope: String(input.scope || "project"),
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    reason: String(input.reason || (status === "uncertain" ? "Activation was discovered but is not proven." : "")),
    ...(input.destination ? { destination: String(input.destination) } : {}),
    evidence: input.evidence ? { ...input.evidence } : null,
  });
}

export function createContextRelation(input = {}) {
  const from = String(input.from || "").trim();
  const to = String(input.to || "").trim();
  const type = String(input.type || "").trim();
  if (!from || !to || !type) throw new Error("Context relation requires from, to, and type");
  return Object.freeze({ from, to, type, evidence: input.evidence ? { ...input.evidence } : null });
}

function sameTarget(application, coordinate) {
  const target = application.coordinate;
  if (target.projectId !== coordinate.projectId) return false;
  if (target.locationId && target.locationId !== coordinate.locationId) return false;
  if (coordinate.provider !== "all" && target.provider !== "all" && target.provider !== coordinate.provider) return false;
  if (application.scope === "device" || application.scope === "project" || application.scope === "shared") return true;
  const subtree = unixPath(application.subtree || target.folder);
  return subtree === "." || coordinate.folder === subtree || coordinate.folder.startsWith(`${subtree}/`);
}

function acceptedDocument(resource) {
  if (resource.kind !== "document") return true;
  if (resource.truthState !== "accepted") return false;
  if (resource.metadata?.documentStatus && resource.metadata.documentStatus !== "current") return false;
  if (resource.metadata?.managed === false) return false;
  return resource.source === "shared-main" || ["verified", "accepted"].includes(resource.review?.status);
}

function effectiveStatus(resource, application) {
  if (resource.kind === "proposal" || resource.truthState === "proposal") return "inactive";
  if (!resource.providers.includes("all") && application.coordinate.provider !== "all" && !resource.providers.includes(application.coordinate.provider)) return "inactive";
  if (resource.kind === "document" && !acceptedDocument(resource)) {
    return resource.truthState === "unverified" || resource.review?.status === "unverified" ? "unverified" : "blocked";
  }
  return application.status;
}

function selectorCandidates(resources, selector, kind = "") {
  const needle = String(selector || "").trim();
  if (!needle) return [];
  return resources.filter((resource) => {
    if (kind && resource.kind !== kind) return false;
    return resource.id === needle || resource.locator === needle || path.posix.basename(resource.locator) === needle || resource.metadata?.name === needle;
  });
}

export function buildContextGraph(input = {}) {
  const coordinate = normalizeContextCoordinate(input.coordinate || {});
  const resources = (input.resources || []).map(createContextResource);
  const resourceIds = new Set(resources.map((item) => item.id));
  if (resourceIds.size !== resources.length) throw new Error("Context resources require unique ids");
  const registeredTargets = (input.registeredTargets || []).map((item) => normalizeContextCoordinate(item));
  const applications = (input.applications || []).map(createContextApplication).filter((application) => {
    if (!registeredTargets.length || !application.coordinate.locationId) return true;
    return registeredTargets.some((target) => target.projectId === application.coordinate.projectId && target.locationId === application.coordinate.locationId);
  });
  for (const application of applications) {
    if (!resourceIds.has(application.resourceId)) throw new Error(`Context application references unknown resource: ${application.resourceId}`);
  }
  const relations = (input.relations || []).map(createContextRelation);
  return Object.freeze({
    schemaVersion: "context-room.context-graph/1",
    coordinate,
    resolverVersion: String(input.resolverVersion || "context-core/1"),
    providerProfileVersion: CONTEXT_PROVIDER_PROFILE_VERSION,
    providerProfile: coordinate.provider === "all" ? null : contextProviderProfile(coordinate.provider),
    freshness: input.freshness ? { ...input.freshness } : { state: "unknown" },
    localEnvironment: input.localEnvironment || (coordinate.locationId ? "available" : "unavailable"),
    resources,
    applications,
    relations,
    proposals: (input.proposals || []).map((item) => ({ id: item.id, title: item.title || item.id, head: item.head || "", status: item.status || "open" })),
    healthIssues: (input.healthIssues || []).map((item) => ({ ...item })),
    registeredTargets,
  });
}

export function resolveEffectiveContext(input = {}) {
  const graph = input.schemaVersion === "context-room.context-graph/1" ? input : buildContextGraph(input);
  const resources = new Map(graph.resources.map((item) => [item.id, item]));
  const effectiveApplications = graph.applications
    .filter((item) => sameTarget(item, graph.coordinate))
    .map((application) => ({ ...application, status: effectiveStatus(resources.get(application.resourceId), application) }))
    .sort((left, right) => left.order - right.order || left.resourceId.localeCompare(right.resourceId));
  const grouped = { instructions: [], skills: [], hooks: [], providerConfigs: [], documents: [], inactive: [] };
  const keyForKind = { instruction: "instructions", skill: "skills", hook: "hooks", "provider-config": "providerConfigs", document: "documents" };
  for (const application of effectiveApplications) {
    const resource = resources.get(application.resourceId);
    const entry = { resource, application };
    const key = keyForKind[resource.kind];
    if (application.status === "active" && key) grouped[key].push(entry);
    else grouped.inactive.push(entry);
  }
  return {
    schemaVersion: "context-room.context-effective/1",
    coordinate: graph.coordinate,
    resolverVersion: graph.resolverVersion,
    providerProfileVersion: graph.providerProfileVersion,
    freshness: graph.freshness,
    localEnvironment: graph.localEnvironment,
    ...grouped,
    proposals: graph.proposals,
    healthIssues: graph.healthIssues.filter((issue) => !issue.resourceId || resources.has(issue.resourceId)),
    graph,
  };
}

export function traceContext(graphInput, selector, { kind = "" } = {}) {
  const graph = graphInput.schemaVersion === "context-room.context-graph/1" ? graphInput : buildContextGraph(graphInput);
  const candidates = selectorCandidates(graph.resources, selector, kind);
  if (!candidates.length) return { status: "not-found", selector, candidates: [] };
  if (candidates.length > 1) return { status: "ambiguous", selector, candidates: candidates.map((item) => ({ id: item.id, kind: item.kind, locator: item.locator })) };
  const selected = candidates[0];
  const selectedKind = selected.kind;
  const chain = graph.applications
    .filter((item) => sameTarget(item, graph.coordinate))
    .filter((item) => graph.resources.find((resource) => resource.id === item.resourceId)?.kind === selectedKind)
    .map((application) => ({ resource: graph.resources.find((item) => item.id === application.resourceId), application }))
    .sort((left, right) => left.application.order - right.application.order || left.resource.id.localeCompare(right.resource.id));
  return {
    status: "ok",
    selector,
    selected,
    chain,
    relations: graph.relations.filter((item) => item.from === selected.id || item.to === selected.id),
  };
}

export function impactContext(graphInput, selector, { kind = "", provider = "" } = {}) {
  const graph = graphInput.schemaVersion === "context-room.context-graph/1" ? graphInput : buildContextGraph(graphInput);
  const candidates = selectorCandidates(graph.resources, selector, kind);
  if (!candidates.length) return { status: "not-found", selector, candidates: [] };
  if (candidates.length > 1) return { status: "ambiguous", selector, candidates: candidates.map((item) => ({ id: item.id, kind: item.kind, locator: item.locator })) };
  const resource = candidates[0];
  const applications = graph.applications.filter((item) => item.resourceId === resource.id && (!provider || item.coordinate.provider === provider || item.coordinate.provider === "all"));
  const consumers = applications.map((item) => ({
    projectId: item.coordinate.projectId,
    locationId: item.coordinate.locationId,
    provider: item.coordinate.provider,
    scope: item.scope,
    ...(item.scope === "folder" || item.scope === "subtree" ? { subtree: unixPath(item.subtree || item.coordinate.folder) } : {}),
    ...(item.destination ? { destination: item.destination } : {}),
    status: effectiveStatus(resource, item),
    reason: item.reason,
  }));
  return {
    status: "ok",
    selector,
    resource,
    consumers,
    projects: unique(consumers.map((item) => item.projectId)),
    worktrees: unique(consumers.map((item) => item.locationId)),
    providers: unique(consumers.map((item) => item.provider)),
    destinations: unique(consumers.map((item) => item.destination)),
    reviews: resource.review ? [{ resourceId: resource.id, version: resource.version, ...resource.review }] : [],
    relations: graph.relations.filter((item) => item.from === resource.id || item.to === resource.id),
  };
}

export function createContextEngine(adapters = {}) {
  if (typeof adapters.inventory !== "function") throw new Error("Context engine requires an inventory adapter");
  const graph = (coordinate, options = {}) => buildContextGraph({ coordinate, ...adapters.inventory(normalizeContextCoordinate(coordinate), options) });
  return Object.freeze({
    graph,
    effective(coordinate, options = {}) { return resolveEffectiveContext(graph(coordinate, options)); },
    trace(coordinate, selector, options = {}) { return traceContext(graph(coordinate, options), selector, options); },
    impact(coordinate, selector, options = {}) { return impactContext(graph(coordinate, options), selector, options); },
  });
}

export { contextProviderProfile, listContextProviderProfiles };
