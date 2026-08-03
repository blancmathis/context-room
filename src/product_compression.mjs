export const ATTENTION_ITEM_SCHEMA = "context-room.attention-item/1";
export const DOCUMENT_SEARCH_GROUPS_SCHEMA = "context-room.document-search-groups/1";
export const CONTEXT_COVERAGE_SCHEMA = "context-room.context-coverage/2";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function attentionPriority(kind, severity = "") {
  if (kind === "review") return 0;
  if (kind === "recheck") return 1;
  if (kind === "decide") return 2;
  if (kind === "fix" && ["critical", "high"].includes(severity)) return 3;
  return 4;
}

export function buildAttentionItems({ reviews = [], freshness = [], decisions = [], healthIssues = [], project = null } = {}) {
  const projectId = project?.projectKey || project?.id || "";
  const items = [
    ...reviews.map((review) => ({
      schemaVersion: ATTENTION_ITEM_SCHEMA,
      id: review.id || `review:${projectId}:${review.path || review.localFile || "unknown"}`,
      kind: "review",
      title: review.title || review.label || review.path || "Document review",
      description: review.description || "A human must accept or reject the exact version shown; an operating agent needs two separate explicit confirmations for the exact action.",
      projectId: review.projectKey || projectId,
      resourceId: review.path || review.localFile || "",
      severity: "review",
      state: "open",
      action: "Review",
    })),
    ...freshness.map((item) => ({
      schemaVersion: ATTENTION_ITEM_SCHEMA,
      id: item.id || `freshness:${projectId}:${item.path || "unknown"}`,
      kind: "recheck",
      title: item.title || item.path || "Recheck documentation",
      description: item.description || "A declared dependency changed after this document was verified.",
      projectId: item.projectKey || projectId,
      resourceId: item.path || "",
      severity: item.severity || "medium",
      state: "open",
      action: "Recheck",
    })),
    ...decisions.map((item) => ({
      schemaVersion: ATTENTION_ITEM_SCHEMA,
      id: item.id || `decision:${projectId}:${item.resourceId || "unknown"}`,
      kind: "decide",
      title: item.title || "Decision required",
      description: item.description || "Choose how Context Room should handle this explicit conflict.",
      projectId: item.projectKey || projectId,
      resourceId: item.resourceId || "",
      severity: item.severity || "high",
      state: "open",
      action: "Decide",
    })),
    ...healthIssues.filter((issue) => !issue?.acknowledged && ["critical", "high", "medium"].includes(issue?.severity)).map((issue) => ({
      schemaVersion: ATTENTION_ITEM_SCHEMA,
      id: issue.id || issue.key || `health:${projectId}:${issue.type || issue.message}`,
      kind: "fix",
      title: issue.title || issue.message || "Context issue",
      description: issue.path ? `Affects ${issue.path}.` : "Context Health found a problem that can affect trusted context.",
      projectId,
      resourceId: issue.resourceId || issue.path || "",
      severity: issue.severity || "medium",
      state: "open",
      action: "Inspect",
    })),
  ];
  return [...new Map(items.map((item) => [item.id, item])).values()]
    .sort((left, right) => attentionPriority(left.kind, left.severity) - attentionPriority(right.kind, right.severity) || left.title.localeCompare(right.title, "en"));
}

export function documentSearchGroup(result = {}) {
  if (["target", "proposal"].includes(result.truthState)) return "pending-target";
  if (["historical", "record"].includes(result.truthState)) return "history";
  if (["source", "image", "diagram", "structured"].includes(result.kind)) return "linked-files";
  if (result.truthState === "current" && ["canonical", "index"].includes(result.kind)) return "canonical-current";
  return "current-context";
}

export function groupDocumentSearchResults(results = []) {
  const order = ["canonical-current", "current-context", "pending-target", "history", "linked-files"];
  const labels = {
    "canonical-current": "Canonical current definition",
    "current-context": "Other current context",
    "pending-target": "Targets and proposals",
    history: "History and records",
    "linked-files": "Linked project files",
  };
  const grouped = new Map(order.map((id) => [id, []]));
  for (const result of results) grouped.get(documentSearchGroup(result)).push(result);
  return {
    schemaVersion: DOCUMENT_SEARCH_GROUPS_SCHEMA,
    groups: order.map((id) => ({ id, label: labels[id], results: grouped.get(id) })).filter((group) => group.results.length),
  };
}

export function buildContextCoverage({ corpus, searchResults = [], depth = "standard", budget = 0, obligations = [] } = {}) {
  const documents = corpus?.documents || [];
  const acceptedOnly = corpus?.access?.acceptedOnly === true;
  const accepted = documents.filter((document) => document.truthState === "current" && document.reviewStatus === "accepted" && document.source !== "session-proposal");
  const evidencePaths = unique(searchResults.map((result) => result.path));
  const acceptedPathSet = new Set(accepted.map((document) => document.path));
  const includedPaths = evidencePaths.filter((itemPath) => acceptedPathSet.has(itemPath));
  const includedSet = new Set(includedPaths);
  const excluded = accepted.filter((document) => !includedSet.has(document.path));
  const canonicalOwners = new Map();
  for (const document of accepted) {
    const owner = clean(document.metadata?.canonical_for || document.metadata?.canonicalFor);
    if (!owner) continue;
    canonicalOwners.set(owner, [...(canonicalOwners.get(owner) || []), document.path]);
  }
  const redundancy = [...canonicalOwners.entries()].filter(([, paths]) => paths.length > 1).map(([subject, paths]) => ({ subject, paths }));
  const estimatedTokens = searchResults.reduce((sum, result) => sum + Math.max(1, Math.ceil(String(result.snippet || "").length / 4)), 0);
  return {
    schemaVersion: CONTEXT_COVERAGE_SCHEMA,
    candidateUniverse: {
      documents: documents.length,
      acceptedCurrent: accepted.length,
      target: documents.filter((document) => document.truthState === "target").length,
      historical: documents.filter((document) => ["historical", "record"].includes(document.truthState)).length,
      ...(acceptedOnly ? {} : { proposals: documents.filter((document) => document.truthState === "proposal" || document.source === "session-proposal").length }),
    },
    included: { documents: includedPaths.length, paths: includedPaths, evidencePaths },
    excluded: {
      documents: excluded.length,
      sample: excluded.slice(0, 12).map((document) => ({ path: document.path, reason: "Not selected by deterministic retrieval." })),
    },
    obligations: obligations.map((item) => typeof item === "string" ? { id: item, status: "considered" } : item),
    budget: {
      requestedTokens: Number(budget || 0),
      estimatedTokens,
      pressure: budget > 0 ? Math.min(1, estimatedTokens / budget) : null,
      truncated: budget > 0 && estimatedTokens >= budget,
    },
    redundancy,
    limitations: [
      "Coverage proves which deterministic candidates were considered; it does not prove semantic completeness.",
      acceptedOnly
        ? "The research corpus contains accepted documentation only; proposal content is unavailable."
        : "Proposal content remains separate from accepted current context.",
      depth === "quick" ? "Quick depth favors a small evidence set." : "Only managed documentation and explicitly linked project files are considered.",
    ],
  };
}
