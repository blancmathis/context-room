import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { parseContextRoomUri } from "./doc_metadata.mjs";

const DOCUMENT_GRAPH_SCHEMA_VERSION = "context-room.document-relations-graph/2";
const GRAPH_LAYERS = new Set(["accepted", "unverified", "target", "historical", "proposal"]);
const GRAPH_NODE_LIMIT = 5000;
const GRAPH_EDGE_LIMIT = 10000;
let layoutWorker = null;
let layoutRequestId = 0;
let layoutWorkerKeepAlive = 0;
const layoutRequests = new Map();

function rejectLayoutRequests(error, worker = null) {
  for (const [requestId, request] of layoutRequests) {
    if (worker && request.worker !== worker) continue;
    clearTimeout(request.timer);
    request.reject(error);
    layoutRequests.delete(requestId);
  }
}

function ensureLayoutWorker() {
  if (layoutWorker) return layoutWorker;
  const worker = new Worker(new URL("./document_graph_layout_worker.mjs", import.meta.url));
  worker.on("message", (message = {}) => {
    const request = layoutRequests.get(message.id);
    if (!request) return;
    layoutRequests.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.positions || []);
    else request.reject(new Error(message.error || "Document graph layout failed"));
    stopIdleLayoutWorker(worker);
  });
  worker.on("error", (error) => {
    if (layoutWorker === worker) layoutWorker = null;
    rejectLayoutRequests(error, worker);
  });
  worker.on("exit", (code) => {
    if (layoutWorker === worker) layoutWorker = null;
    if (code) rejectLayoutRequests(new Error(`Document graph layout worker stopped with code ${code}`), worker);
  });
  layoutWorker = worker;
  worker.unref();
  return worker;
}

function stopIdleLayoutWorker(worker = layoutWorker) {
  if (!worker || [...layoutRequests.values()].some((request) => request.worker === worker)) return;
  if (layoutWorkerKeepAlive && layoutWorker === worker) {
    worker.unref();
    return;
  }
  if (layoutWorker === worker) layoutWorker = null;
  void worker.terminate();
}

export function warmDocumentRelationsGraphLayout() {
  layoutWorkerKeepAlive += 1;
  ensureLayoutWorker();
}

export function releaseDocumentRelationsGraphLayout() {
  layoutWorkerKeepAlive = Math.max(0, layoutWorkerKeepAlive - 1);
  stopIdleLayoutWorker();
}

function unixPath(value = "") {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeLayers(values = []) {
  const selected = unique(values.map((value) => String(value).trim().toLowerCase())).filter((value) => GRAPH_LAYERS.has(value));
  return selected.length ? selected : ["accepted"];
}

function normalizeFilters(values = [], allowed = null) {
  const selected = unique(values.map((value) => String(value).trim().toLowerCase()));
  return allowed ? selected.filter((value) => allowed.has(value)) : selected;
}

function stripReferenceDecoration(value = "") {
  let clean = String(value || "").trim();
  if (clean.startsWith("<") && clean.endsWith(">")) clean = clean.slice(1, -1);
  clean = clean.split(/[?#]/, 1)[0];
  try { clean = decodeURIComponent(clean); } catch {}
  return unixPath(clean);
}

function referenceTarget(fromPath, reference) {
  const clean = stripReferenceDecoration(reference);
  if (!clean || /^[a-z]+:/i.test(clean) || clean.startsWith("~") || path.posix.isAbsolute(clean)) return clean;
  return unixPath(path.posix.normalize(path.posix.join(path.posix.dirname(unixPath(fromPath)), clean)));
}

function documentTruthState(node, pendingPaths = new Set()) {
  const filePath = unixPath(node.path);
  if (node.metadata?.truthState === "historical") return "historical";
  if (node.metadata?.truthState === "target" || /(?:^|\/)target(?:\/|$)/i.test(filePath) || /_target\.(?:md|mdx|html?)$/i.test(filePath) || node.metadata?.status === "target") return "target";
  if (pendingPaths.has(filePath)) return "unverified";
  return "accepted";
}

function documentNode(input, pendingPaths, namespace = "project:location") {
  const filePath = unixPath(input.path);
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const kind = /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(filePath)
    ? "instruction"
    : /(?:^|\/)SKILL\.md$/i.test(filePath)
      ? "skill"
      : /\.(?:mmd|mermaid|puml|plantuml|dot|gv|drawio)$/i.test(filePath)
        ? "diagram"
      : /\.(?:ya?ml|json)$/i.test(filePath)
        ? "structured"
      : /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath)
        ? "image"
      : /\.html?$/i.test(filePath)
        ? "html"
        : "document";
  return {
    id: metadata.id && metadata.idValid ? `document:${namespace}:${metadata.id}` : `file:${namespace}:${filePath}`,
    documentId: String(metadata.id || ""),
    kind,
    path: filePath,
    label: input.label || path.posix.basename(filePath),
    summary: input.summary || "",
    truthState: documentTruthState(input, pendingPaths),
    source: input.source || "local",
    managed: true,
    missing: false,
    metadata: {
      contract: String(metadata.contract || "legacy"),
      id: String(metadata.id || ""),
      idValid: metadata.idValid === true,
      dependsOn: Array.isArray(metadata.dependsOn) ? metadata.dependsOn.map(String).filter(Boolean) : [],
      diagramLinks: Array.isArray(metadata.diagramLinks) ? metadata.diagramLinks.map((item) => ({ ...item })) : [],
      truthState: String(metadata.truthState || ""),
      kind: String(metadata.kind || ""),
      scope: String(metadata.scope || ""),
      status: String(metadata.status || ""),
      canonicalFor: String(metadata.canonical_for || metadata.canonicalFor || ""),
      sources: Array.isArray(metadata.sources) ? metadata.sources.map((item) => String(item || "")).filter(Boolean) : [],
      ...(Array.isArray(metadata.identities) ? { identities: metadata.identities.map((item) => ({ ...item })) } : {}),
      ...(Array.isArray(metadata.relations) ? { relations: metadata.relations.map((item) => ({ ...item })) } : {}),
      ...(Array.isArray(metadata.interpretations) ? { interpretations: metadata.interpretations.map((item) => ({ ...item })) } : {}),
    },
    backlinks: 0,
    outgoing: 0,
  };
}

function unresolvedNode(target, relation) {
  const clean = unixPath(target || relation.source || "unresolved");
  return {
    id: `unresolved:${clean}`,
    documentId: relation?.documentId || "",
    kind: "unresolved",
    path: clean,
    label: path.posix.basename(clean) || clean,
    summary: "Referenced but not present in the managed document set.",
    truthState: "accepted",
    source: "reference",
    managed: false,
    missing: true,
    backlinks: 0,
    outgoing: 0,
  };
}

function citedSourceNode(root, targetPath) {
  const clean = unixPath(targetPath);
  if (!clean || clean.startsWith("~") || /^[a-z]+:/i.test(clean) || path.posix.isAbsolute(clean)) return null;
  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, clean);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  let stats;
  try { stats = fs.statSync(absolutePath); } catch { return null; }
  if (!stats.isFile()) return null;
  const extension = path.extname(clean).toLowerCase();
  const kind = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)
    ? (extension === ".svg" ? "diagram" : "image")
    : [".mmd", ".mermaid", ".dot", ".puml", ".plantuml", ".drawio"].includes(extension)
      ? "diagram"
      : "source";
  return {
    id: `source:${clean}`,
    kind,
    path: clean,
    label: path.posix.basename(clean),
    summary: "Explicitly cited source file.",
    truthState: "accepted",
    source: "reference",
    managed: false,
    missing: false,
    backlinks: 0,
    outgoing: 0,
  };
}

function relationEdge(from, to, type, evidence = {}) {
  return { id: `${type}:${from}:${to}`, from, to, type, evidence };
}

function contextResourceNode(resource = {}) {
  const filePath = unixPath(resource.metadata?.relativePath || resource.locator || resource.id);
  return {
    id: `context:${resource.id}`,
    kind: resource.kind === "provider-config" ? "configuration" : resource.kind,
    path: filePath,
    label: resource.metadata?.label || path.posix.basename(filePath) || resource.id,
    summary: resource.metadata?.description || resource.metadata?.reason || "",
    truthState: resource.truthState === "proposal" ? "proposal" : resource.truthState === "unverified" ? "unverified" : "accepted",
    source: resource.source || "local",
    managed: resource.metadata?.managed !== false,
    missing: false,
    backlinks: 0,
    outgoing: 0,
  };
}

function localSubgraph(nodes, edges, centerPath, depth) {
  const center = nodes.find((node) => node.path === unixPath(centerPath));
  if (!center) return { nodes: [], edges: [], centerId: "" };
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }
  const visible = new Set([center.id]);
  let frontier = new Set([center.id]);
  for (let step = 0; step < depth; step += 1) {
    const next = new Set();
    for (const id of frontier) for (const neighbor of adjacency.get(id) || []) if (!visible.has(neighbor)) next.add(neighbor);
    for (const id of next) visible.add(id);
    frontier = next;
  }
  return {
    nodes: nodes.filter((node) => visible.has(node.id)),
    edges: edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)),
    centerId: center.id,
  };
}

function countConnections(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from) from.outgoing += 1;
    if (to) to.backlinks += 1;
  }
  return nodes.map((node) => ({ ...node, radius: Math.min(18, 5 + Math.sqrt(node.backlinks * 2 + node.outgoing + 1) * 2.2) }));
}

function truncateGraph(nodes, edges, centerId = "") {
  if (nodes.length <= GRAPH_NODE_LIMIT && edges.length <= GRAPH_EDGE_LIMIT) {
    return { nodes, edges, truncated: false };
  }
  const orderedNodes = centerId
    ? [...nodes.filter((node) => node.id === centerId), ...nodes.filter((node) => node.id !== centerId)]
    : nodes;
  const limitedNodes = orderedNodes.slice(0, GRAPH_NODE_LIMIT);
  const ids = new Set(limitedNodes.map((node) => node.id));
  const limitedEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).slice(0, GRAPH_EDGE_LIMIT);
  return { nodes: limitedNodes, edges: limitedEdges, truncated: true };
}

export function buildProjectDocumentRelationsGraph({
  root = "",
  projectId = "",
  locationId = "",
  title = "",
  scope = "project",
  centerPath = "",
  depth = 1,
  layers = ["accepted"],
  types = [],
  relations = [],
  includeUnresolved = false,
  documentationGraph = {},
  contextGraph = null,
  pendingPaths = [],
  proposals = [],
} = {}) {
  const selectedLayers = normalizeLayers(layers);
  const selectedTypes = normalizeFilters(types);
  const selectedRelations = normalizeFilters(relations);
  const pending = new Set(pendingPaths.map(unixPath));
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const byPath = new Map();
  const byDocumentId = new Map();
  const byIdentity = new Map();
  const namespace = `${projectId || "project"}:${locationId || "location"}`;
  const addNode = (node) => {
    if (!node?.id || nodeIds.has(node.id)) return node;
    nodeIds.add(node.id);
    nodes.push(node);
    if (node.path && !byPath.has(node.path)) byPath.set(node.path, node);
    if (node.documentId && node.managed !== false) {
      if (!byDocumentId.has(node.documentId)) byDocumentId.set(node.documentId, []);
      byDocumentId.get(node.documentId).push(node);
    }
    for (const identity of node.metadata?.identities || []) {
      const key = `${identity.profileId}:${identity.value}`;
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(node);
    }
    return node;
  };
  for (const item of documentationGraph.nodes || []) addNode(documentNode(item, pending, namespace));
  const resolveDocumentId = (documentId) => {
    const candidates = byDocumentId.get(documentId) || [];
    return candidates.length === 1 ? { target: candidates[0], ambiguous: false, candidates } : { target: null, ambiguous: candidates.length > 1, candidates };
  };
  const resolveIdentity = (profileId, value) => {
    const candidates = byIdentity.get(`${profileId}:${value}`) || [];
    return candidates.length === 1 ? { target: candidates[0], ambiguous: false, candidates } : { target: null, ambiguous: candidates.length > 1, candidates };
  };
  for (const from of nodes.filter((node) => node.documentId)) {
    for (const dependencyId of from.metadata?.dependsOn || []) {
      const resolution = resolveDocumentId(dependencyId);
      let target = resolution.target;
      if (!target && includeUnresolved) target = addNode(unresolvedNode(`cr://${dependencyId}`, { documentId: dependencyId }));
      if (target) edges.push(relationEdge(from.id, target.id, "depends-on", {
        documentId: dependencyId,
        ambiguous: resolution.ambiguous,
        candidates: resolution.candidates.map((candidate) => candidate.path),
      }));
    }
    for (const diagramLink of from.metadata?.diagramLinks || []) {
      const resolution = resolveDocumentId(diagramLink.id);
      let target = resolution.target;
      if (!target && includeUnresolved) target = addNode(unresolvedNode(diagramLink.uri || `cr://${diagramLink.id}`, { documentId: diagramLink.id }));
      if (target) edges.push(relationEdge(from.id, target.id, "appears-in-diagram", {
        documentId: diagramLink.id,
        anchor: diagramLink.anchor || "",
        nodeId: diagramLink.nodeId || "",
        ambiguous: resolution.ambiguous,
      }));
    }
  }
  for (const relation of documentationGraph.edges || []) {
    const sourcePath = unixPath(relation.from?.replace(/^doc:/, ""));
    const from = byPath.get(sourcePath);
    if (!from) continue;
    const rawTarget = relation.source || relation.to?.replace(/^(?:source|reference):/, "");
    const crTarget = parseContextRoomUri(rawTarget);
    const declaredResolution = relation.targetIdentity ? resolveIdentity(relation.profileId || "context-room-documentation", relation.targetIdentity) : null;
    const idResolution = declaredResolution || (crTarget ? resolveDocumentId(crTarget.id) : null);
    let targetPath = crTarget ? "" : referenceTarget(sourcePath, rawTarget);
    let target = idResolution?.target || byPath.get(targetPath);
    if (!target && targetPath && !path.posix.extname(targetPath)) {
      const markdownTarget = `${targetPath}.md`;
      target = byPath.get(markdownTarget);
      if (target) targetPath = markdownTarget;
    }
    if (!target) target = addNode(citedSourceNode(root, targetPath));
    if (!target && includeUnresolved) target = addNode(unresolvedNode(crTarget ? rawTarget : targetPath, { ...relation, documentId: crTarget?.id || "" }));
    if (target) edges.push(relationEdge(from.id, target.id, relation.type || "references", {
      source: relation.source || "",
      documentId: crTarget?.id || relation.targetIdentity || "",
      anchor: crTarget?.anchor || "",
      ambiguous: Boolean(idResolution?.ambiguous),
      truthState: from.truthState,
      label: relation.label || "",
      reverseLabel: relation.reverseLabel || "",
      strength: relation.strength || (relation.targetIdentity ? "declared" : "reference"),
      profileId: relation.profileId || "",
      sourceRange: relation.sourceRange || null,
    }));
  }
  if (contextGraph) {
    const contextNodes = new Map();
    for (const resource of contextGraph.resources || []) {
      if (!["instruction", "skill", "document"].includes(resource.kind)) continue;
      const existing = byPath.get(unixPath(resource.metadata?.relativePath || resource.locator));
      contextNodes.set(resource.id, existing || addNode(contextResourceNode(resource)));
    }
    const projectAnchor = addNode({ id: `project:${projectId || locationId || "project"}`, kind: "project", path: "", label: title || projectId || "Project", summary: "Registered project context", truthState: "accepted", source: "registry", managed: true, missing: false, backlinks: 0, outgoing: 0, anchor: true });
    for (const application of contextGraph.applications || []) {
      const resourceNode = contextNodes.get(application.resourceId);
      if (!resourceNode || !projectAnchor) continue;
      edges.push(relationEdge(resourceNode.id, projectAnchor.id, "applies-to", { scope: application.scope, subtree: application.subtree || application.coordinate?.folder || ".", provider: application.coordinate?.provider || "all", status: application.status }));
      if (application.destination) {
        const destination = addNode({ id: `destination:${application.destination}`, kind: "destination", path: application.destination, label: path.posix.basename(unixPath(application.destination)) || application.destination, summary: "Managed local destination", truthState: "accepted", source: "device", managed: true, missing: false, backlinks: 0, outgoing: 0 });
        edges.push(relationEdge(resourceNode.id, destination.id, "managed-link", { provider: application.coordinate?.provider || "all" }));
      }
    }
    for (const relation of contextGraph.relations || []) {
      const from = contextNodes.get(relation.from);
      const to = contextNodes.get(relation.to);
      if (from && to) edges.push(relationEdge(from.id, to.id, relation.type === "managed-link" ? "managed-link" : "shared-origin", relation.evidence || {}));
    }
  }
  if (selectedLayers.includes("proposal")) {
    for (const proposal of proposals || []) {
      const proposalNode = addNode({ id: `proposal:${proposal.id || proposal.branch}`, kind: "proposal", path: proposal.branch || "", label: proposal.title || proposal.branch || "Proposal", summary: proposal.description || "Pending shared proposal", truthState: "proposal", source: "shared-proposal", managed: true, missing: false, backlinks: 0, outgoing: 0 });
      for (const changedPath of proposal.files || []) {
        const target = byPath.get(unixPath(changedPath));
        if (target) edges.push(relationEdge(proposalNode.id, target.id, "references", { head: proposal.head || "", pending: true }));
      }
    }
  }
  const deduplicatedEdges = new Map();
  for (const edge of edges) {
    const existing = deduplicatedEdges.get(edge.id);
    if (!existing || (!existing.evidence?.profileId && edge.evidence?.profileId)) deduplicatedEdges.set(edge.id, edge);
  }
  let visibleNodes = nodes.filter((node) => selectedLayers.includes(node.truthState));
  if (selectedTypes.length) visibleNodes = visibleNodes.filter((node) => selectedTypes.includes(node.kind));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  let visibleEdges = [...deduplicatedEdges.values()].filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  if (selectedRelations.length) visibleEdges = visibleEdges.filter((edge) => selectedRelations.includes(edge.type));
  let centerId = "";
  if (scope === "local") {
    const local = localSubgraph(visibleNodes, visibleEdges, centerPath, Math.min(3, Math.max(1, Number(depth) || 1)));
    visibleNodes = local.nodes;
    visibleEdges = local.edges;
    centerId = local.centerId;
  }
  const limited = truncateGraph(visibleNodes, visibleEdges, centerId);
  visibleNodes = countConnections(limited.nodes, limited.edges);
  visibleEdges = limited.edges;
  return {
    schemaVersion: DOCUMENT_GRAPH_SCHEMA_VERSION,
    target: { scope, projectId, locationId, root, path: unixPath(centerPath), depth: Math.min(3, Math.max(1, Number(depth) || 1)) },
    freshness: contextGraph?.freshness || { state: "local", generatedAt: documentationGraph.generatedAt || new Date().toISOString() },
    layers: selectedLayers,
    nodes: visibleNodes,
    edges: visibleEdges,
    groups: [{ id: `project:${projectId || locationId || "project"}`, kind: "project", label: title || projectId || "Project", nodeIds: visibleNodes.map((node) => node.id) }],
    stats: { nodes: visibleNodes.length, edges: visibleEdges.length, unresolved: visibleNodes.filter((node) => node.missing).length, accepted: visibleNodes.filter((node) => node.truthState === "accepted").length, unverified: visibleNodes.filter((node) => node.truthState === "unverified").length, targets: visibleNodes.filter((node) => node.truthState === "target").length, historical: visibleNodes.filter((node) => node.truthState === "historical").length, proposals: visibleNodes.filter((node) => node.truthState === "proposal").length },
    truncation: { truncated: limited.truncated, nodeLimit: GRAPH_NODE_LIMIT, edgeLimit: GRAPH_EDGE_LIMIT },
    centerId,
  };
}

export function buildGlobalDocumentRelationsGraph({ projects = [], projectOrder = [] } = {}) {
  const order = new Map(projectOrder.map((id, index) => [id, index]));
  const nodes = projects.map((project) => {
    const worktrees = Array.isArray(project.worktrees) && project.worktrees.length ? project.worktrees : (project.root ? [project] : []);
    const priorityId = project.priorityId || project.projectKey || project.id;
    const priority = order.has(priorityId) ? order.get(priorityId) : projects.length;
    const relationCount = Number(project.localReviewCount || 0) + Number(project.sharedProposalCount || 0) + worktrees.length;
    return {
      id: `project:${project.projectKey || project.id}`,
      kind: "project",
      path: "",
      label: project.title || project.sharedTitle || project.id,
      summary: `${worktrees.length || 0} registered worktree${worktrees.length === 1 ? "" : "s"}`,
      truthState: "accepted",
      source: project.mode || "local",
      projectId: project.id,
      projectKey: project.projectKey || project.id,
      locationId: worktrees[0]?.id || project.id,
      priority,
      worktrees: worktrees.map((item) => ({ id: item.id, branch: item.branch || "", root: item.root || "" })),
      backlinks: 0,
      outgoing: 0,
      radius: Math.min(22, 8 + Math.sqrt(relationCount + Math.max(0, projects.length - priority)) * 1.8),
    };
  });
  const edges = [];
  const sharedGroups = new Map();
  for (const project of projects) {
    const repository = project.shared?.repository;
    if (!repository) continue;
    if (!sharedGroups.has(repository)) sharedGroups.set(repository, []);
    sharedGroups.get(repository).push(`project:${project.projectKey || project.id}`);
  }
  for (const [repository, ids] of sharedGroups) {
    for (let index = 1; index < ids.length; index += 1) edges.push(relationEdge(ids[index - 1], ids[index], "shared-origin", { repository }));
  }
  const limited = truncateGraph(nodes, edges);
  return {
    schemaVersion: DOCUMENT_GRAPH_SCHEMA_VERSION,
    target: { scope: "global", projectId: "", locationId: "", root: "", path: "", depth: 1 },
    freshness: { state: "snapshot", generatedAt: new Date().toISOString() },
    layers: ["accepted"],
    nodes: limited.nodes,
    edges: limited.edges,
    groups: [...sharedGroups].map(([repository, nodeIds]) => ({ id: `shared:${repository}`, kind: "shared", label: path.basename(repository), nodeIds })),
    stats: { nodes: limited.nodes.length, edges: limited.edges.length, projects: limited.nodes.length, sharedRelations: limited.edges.length },
    truncation: { truncated: limited.truncated, nodeLimit: GRAPH_NODE_LIMIT, edgeLimit: GRAPH_EDGE_LIMIT },
    centerId: "",
  };
}

export async function layoutDocumentRelationsGraph(graph, { timeoutMs = 10_000 } = {}) {
  if (!graph?.nodes?.length) return graph;
  const worker = ensureLayoutWorker();
  worker.ref();
  const requestId = `layout-${++layoutRequestId}`;
  const positions = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      layoutRequests.delete(requestId);
      reject(new Error("Document graph layout timed out"));
      stopIdleLayoutWorker(worker);
    }, timeoutMs);
    timer.unref?.();
    layoutRequests.set(requestId, { resolve, reject, timer, worker });
    worker.postMessage({ id: requestId, payload: { nodes: graph.nodes, edges: graph.edges } });
  });
  const byId = new Map(positions.map((item) => [item.id, item]));
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, position: byId.get(node.id) || { x: 0.5, y: 0.5 } })) };
}

export { DOCUMENT_GRAPH_SCHEMA_VERSION };
