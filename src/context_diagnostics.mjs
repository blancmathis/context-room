import crypto from "node:crypto";
import path from "node:path";

const FORBIDDEN_REPAIR_KINDS = new Set([
  "allowed-path.expand",
  "watch-rule.delete",
  "documentation.rewrite",
  "hook.modify-unknown",
  "review.accept",
  "review.reject",
  "review.verify",
]);

const SHARED_SKILL_PATH_PATTERNS = [
  /(^|\/)skill-locations\.json$/,
  /(^|\/)skills\//,
];

const SHARED_INSTRUCTION_PATH_PATTERNS = [
  /(^|\/)instruction-locations\.json$/,
  /(^|\/)instructions\/.*\.mdx?$/i,
];

export class ContextDiagnosticsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ContextDiagnosticsError";
    this.code = code;
    this.details = details;
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 20)}`;
}

function normalizedSlashPath(value = "") {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function structuredIssuePath(issue) {
  return normalizedSlashPath(issue.path || issue.relativePath || issue.locator?.path || "");
}

function doctorIssueIdentity(issue) {
  return compactObject({
    type: issue.type,
    resourceId: issue.resourceId,
    scope: issue.scope,
    provider: issue.provider,
    absolutePath: issue.absolutePath,
    path: issue.path,
    projectId: issue.projectId,
    locationId: issue.locationId,
    sharedProjectId: issue.sharedProjectId,
  });
}

/**
 * Normalize a Doctor issue using structured fields only. Message text is never
 * parsed to infer identity, scope, provider, or location.
 */
export function normalizeDoctorIssue(issue, defaults = {}) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new ContextDiagnosticsError("invalid-doctor-issue", "Doctor issues must be objects.");
  }
  const type = String(issue.type || "unknown").trim() || "unknown";
  const issuePath = structuredIssuePath(issue);
  const explicitAbsolutePath = issue.absolutePath ? path.resolve(String(issue.absolutePath)) : "";
  const absolutePath = explicitAbsolutePath || (defaults.root && issuePath && !issuePath.startsWith("~/")
    ? path.resolve(defaults.root, issuePath)
    : undefined);
  const resourceId = String(issue.resourceId || defaults.resourceId || (issuePath ? `file:${issuePath}` : "")).trim() || undefined;
  const normalized = compactObject({
    ...issue,
    type,
    severity: String(issue.severity || "medium"),
    resourceId,
    scope: String(issue.scope || defaults.scope || "project"),
    provider: String(issue.provider || defaults.provider || "all"),
    absolutePath,
    path: issuePath || undefined,
    projectId: issue.projectId || defaults.projectId,
    locationId: issue.locationId || defaults.locationId,
    sharedProjectId: issue.sharedProjectId || defaults.sharedProjectId,
  });
  normalized.key = String(issue.key || contentId("issue", doctorIssueIdentity(normalized)));
  return Object.freeze(normalized);
}

export function normalizeDoctorIssues(issues = [], defaults = {}) {
  return issues.map((issue) => normalizeDoctorIssue(issue, defaults));
}

function pathWithinFolder(issue, folder) {
  const wanted = normalizedSlashPath(folder).replace(/\/$/, "");
  if (!wanted || wanted === ".") return true;
  const candidate = structuredIssuePath(issue);
  if (candidate) return candidate === wanted || candidate.startsWith(`${wanted}/`);
  if (issue.absolutePath && path.isAbsolute(folder)) {
    const relative = path.relative(path.resolve(folder), path.resolve(issue.absolutePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
  return false;
}

/** Filter Doctor issues without inspecting human-readable messages. */
export function filterDoctorIssues(issues = [], filters = {}) {
  return issues.filter((rawIssue) => {
    const issue = normalizeDoctorIssue(rawIssue, filters.defaults || {});
    if (filters.issueKey && issue.key !== filters.issueKey) return false;
    if (filters.projectId && issue.projectId !== filters.projectId) return false;
    if (filters.locationId && issue.locationId !== filters.locationId) return false;
    if (filters.sharedProjectId && issue.sharedProjectId !== filters.sharedProjectId) return false;
    if (filters.provider && issue.provider !== filters.provider && issue.provider !== "all") return false;
    if (filters.scope && issue.scope !== filters.scope) return false;
    if (filters.resourceId && issue.resourceId !== filters.resourceId) return false;
    if (filters.severity && issue.severity !== filters.severity) return false;
    if (filters.folder && !pathWithinFolder(issue, filters.folder)) return false;
    return true;
  }).map((issue) => normalizeDoctorIssue(issue, filters.defaults || {}));
}

export function explainDoctorIssue(issueKey, { issues = [], explainers = {}, defaults = {} } = {}) {
  const normalized = normalizeDoctorIssues(issues, defaults);
  const issue = normalized.find((item) => item.key === issueKey);
  if (!issue) throw new ContextDiagnosticsError("doctor-issue-not-found", `Doctor issue not found: ${issueKey}`, { issueKey });
  const explain = explainers[issue.type];
  const explanation = typeof explain === "function" ? explain(issue) : null;
  return {
    issue,
    explanation: explanation || issue.message || "No additional explanation is available for this issue type.",
    evidence: Array.isArray(issue.evidence) ? issue.evidence : [],
  };
}

function assertSafeRepairAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new ContextDiagnosticsError("unsafe-doctor-plan", "A repair adapter returned an invalid action.");
  }
  const kind = String(action.kind || "");
  if (!kind) throw new ContextDiagnosticsError("unsafe-doctor-plan", "A repair action must declare its kind.");
  if (FORBIDDEN_REPAIR_KINDS.has(kind)) {
    throw new ContextDiagnosticsError("forbidden-doctor-repair", `Doctor cannot plan the forbidden repair ${kind}.`, { kind });
  }
  if (action.changesReviewDecision || action.removesWatchRule || action.widensAllowedPaths || action.rewritesDocumentation || action.modifiesUnknownHook) {
    throw new ContextDiagnosticsError("forbidden-doctor-repair", `Doctor cannot plan the repair ${kind} because it crosses a protected boundary.`, { kind });
  }
  return Object.freeze({ ...action });
}

/**
 * Build a deterministic repair plan only when the exact emitted issue type has
 * an explicit adapter. This function never applies the plan.
 */
export function planDoctorRepair(issueKey, { issues = [], repairAdapters = {}, defaults = {}, context = {} } = {}) {
  const normalized = normalizeDoctorIssues(issues, defaults);
  const issue = normalized.find((item) => item.key === issueKey);
  if (!issue) throw new ContextDiagnosticsError("doctor-issue-not-found", `Doctor issue not found: ${issueKey}`, { issueKey });
  const adapter = repairAdapters[issue.type];
  if (!adapter || typeof adapter.plan !== "function") {
    return {
      issue,
      repairable: false,
      reason: "No deterministic repair primitive is registered for this emitted issue type.",
      manualAction: adapter?.manualAction || issue.manualAction || "Inspect the structured evidence and resolve the issue manually.",
    };
  }
  const planned = adapter.plan(issue, context);
  if (!planned) {
    return {
      issue,
      repairable: false,
      reason: "The registered repair primitive cannot produce a deterministic plan for this issue instance.",
      manualAction: adapter.manualAction || issue.manualAction || "Resolve this issue manually.",
    };
  }
  const actions = (Array.isArray(planned.actions) ? planned.actions : [planned]).map(assertSafeRepairAction);
  const fingerprint = { issue: doctorIssueIdentity(issue), actions };
  return {
    issue,
    repairable: true,
    planId: contentId("doctor-plan", fingerprint),
    actions,
    expectedRevision: planned.expectedRevision || context.expectedRevision || undefined,
  };
}

function normalizeChangedFile(item) {
  if (typeof item === "string") return { path: normalizedSlashPath(item), status: "modified" };
  return compactObject({
    ...item,
    path: normalizedSlashPath(item.path || item.newPath || ""),
    oldPath: item.oldPath ? normalizedSlashPath(item.oldPath) : undefined,
    status: String(item.status || "modified").toLowerCase(),
  });
}

export function classifyProposalChangedFiles(files = []) {
  const changedFiles = files.map(normalizeChangedFile).filter((item) => item.path);
  const instructions = changedFiles.filter((item) => (
    /(^|\/)(AGENTS(?:\.override)?\.md|CLAUDE\.md)$/i.test(item.path)
    || SHARED_INSTRUCTION_PATH_PATTERNS.some((pattern) => pattern.test(item.path))
  ));
  const sharedSkills = changedFiles.filter((item) => SHARED_SKILL_PATH_PATTERNS.some((pattern) => pattern.test(item.path)));
  const documents = changedFiles.filter((item) => /(^|\/)docs?\//i.test(item.path) || /\.md$/i.test(item.path));
  return { changedFiles, documents, instructions, sharedSkills };
}

function issueMap(issues = [], defaults = {}) {
  return new Map(normalizeDoctorIssues(issues, defaults).map((issue) => [issue.key, issue]));
}

export function diffDoctorIssues(before = [], after = [], defaults = {}) {
  const previous = issueMap(before, defaults);
  const current = issueMap(after, defaults);
  return {
    resolved: [...previous.entries()].filter(([key]) => !current.has(key)).map(([, issue]) => issue),
    introduced: [...current.entries()].filter(([key]) => !previous.has(key)).map(([, issue]) => issue),
    unchanged: [...current.entries()].filter(([key]) => previous.has(key)).map(([, issue]) => issue),
  };
}

function requiredAdapter(adapters, name) {
  if (typeof adapters?.[name] !== "function") {
    throw new ContextDiagnosticsError("missing-diagnostics-adapter", `Proposal context impact requires the ${name} adapter.`, { adapter: name });
  }
  return adapters[name];
}

async function resolveProposalTarget(selector, repository, adapters) {
  if (repository) {
    return requiredAdapter(adapters, "readProposal")({ selector, repository });
  }
  const candidates = await requiredAdapter(adapters, "listProposalCandidates")({ selector });
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ContextDiagnosticsError("proposal-not-found", `Proposal not found: ${selector}`, { selector });
  }
  if (candidates.length > 1) {
    throw new ContextDiagnosticsError("proposal-repository-required", "The proposal selector is ambiguous; specify --repository.", {
      selector,
      candidates: candidates.map((candidate) => compactObject({ repository: candidate.repository, branch: candidate.branch, head: candidate.head })),
    });
  }
  return candidates[0];
}

function normalizeConsumers(consumers = []) {
  return consumers.map((consumer) => compactObject({
    projectId: consumer.projectId,
    locationId: consumer.locationId,
    sharedProjectId: consumer.sharedProjectId,
    provider: consumer.provider,
    folder: consumer.folder ? normalizedSlashPath(consumer.folder) : undefined,
    destination: consumer.destination,
  }));
}

/**
 * Read-only proposal impact orchestration. Adapters are deliberately granular:
 * integration code can supply current Git/shared/context/health implementations
 * without this module importing or mutating their state.
 */
export async function buildProposalContextImpact({ selector, repository = "", adapters = {} } = {}) {
  if (!selector) throw new ContextDiagnosticsError("proposal-selector-required", "A proposal selector is required.");
  const proposal = await resolveProposalTarget(selector, repository, adapters);
  const resolvedRepository = String(proposal?.repository || repository || "");
  if (!resolvedRepository) throw new ContextDiagnosticsError("proposal-repository-required", "The proposal repository could not be resolved.");
  if (!proposal?.head) throw new ContextDiagnosticsError("proposal-head-missing", "The proposal does not expose an exact head revision.");

  const accepted = await requiredAdapter(adapters, "readAcceptedRevision")({ repository: resolvedRepository, refresh: true });
  if (!accepted?.revision) throw new ContextDiagnosticsError("shared-freshness-unverified", "The accepted shared revision could not be verified.", { repository: resolvedRepository });
  const mergeBase = await requiredAdapter(adapters, "findMergeBase")({ repository: resolvedRepository, fromRevision: accepted.revision, toRevision: proposal.head });
  const rawFiles = await requiredAdapter(adapters, "diffRevisions")({ repository: resolvedRepository, fromRevision: accepted.revision, toRevision: proposal.head });
  const classified = classifyProposalChangedFiles(rawFiles);

  const contextDelta = typeof adapters.analyzeContextDelta === "function"
    ? await adapters.analyzeContextDelta({ repository: resolvedRepository, baseRevision: accepted.revision, headRevision: proposal.head, proposal, changedFiles: classified.changedFiles })
    : {};
  const consumers = typeof adapters.listRegisteredConsumers === "function"
    ? await adapters.listRegisteredConsumers({ repository: resolvedRepository, proposal, changedFiles: classified.changedFiles, contextDelta })
    : [];
  const conflicts = typeof adapters.detectGitConflicts === "function"
    ? await adapters.detectGitConflicts({ repository: resolvedRepository, baseRevision: accepted.revision, headRevision: proposal.head, mergeBase })
    : [];
  const skillImpact = typeof adapters.analyzeSharedSkills === "function"
    ? await adapters.analyzeSharedSkills({ repository: resolvedRepository, baseRevision: accepted.revision, headRevision: proposal.head, changedFiles: classified.sharedSkills, consumers })
    : {};
  const healthBefore = typeof adapters.readHealthAt === "function"
    ? await adapters.readHealthAt({ repository: resolvedRepository, revision: accepted.revision, proposal, phase: "accepted" })
    : [];
  const healthAfter = typeof adapters.readHealthAt === "function"
    ? await adapters.readHealthAt({ repository: resolvedRepository, revision: proposal.head, proposal, phase: "proposal" })
    : [];
  const invalidatedReviews = typeof adapters.listExactReviewInvalidations === "function"
    ? await adapters.listExactReviewInvalidations({ repository: resolvedRepository, baseRevision: accepted.revision, headRevision: proposal.head, changedFiles: classified.changedFiles })
    : [];
  const dependencyInvalidations = typeof adapters.analyzeDependencyInvalidations === "function"
    ? await adapters.analyzeDependencyInvalidations({ repository: resolvedRepository, baseRevision: accepted.revision, headRevision: proposal.head, changedFiles: classified.changedFiles, proposal })
    : { changedDependencies: [], dependentReviews: [], diagnostics: [] };

  return {
    repository: resolvedRepository,
    proposal: compactObject({ selector, branch: proposal.branch, title: proposal.title, projectId: proposal.projectId, scope: proposal.scope }),
    defaultBranch: accepted.defaultBranch,
    base: accepted.revision,
    head: proposal.head,
    mergeBase,
    needsRebase: mergeBase !== accepted.revision,
    changedFiles: classified.changedFiles,
    affected: {
      documents: contextDelta.documents || classified.documents,
      instructions: contextDelta.instructions || classified.instructions,
      sharedSkills: {
        files: classified.sharedSkills,
        collections: skillImpact.collections || [],
        assignments: skillImpact.assignments || [],
        providers: skillImpact.providers || [],
        destinations: skillImpact.destinations || [],
      },
      resources: contextDelta.resources || [],
      consumers: normalizeConsumers(consumers),
    },
    gitConflicts: Array.isArray(conflicts) ? conflicts : [],
    technicalCollisions: skillImpact.collisions || [],
    healthDelta: diffDoctorIssues(healthBefore, healthAfter),
    reviewInvalidation: {
      mode: "exact-revision",
      reviews: Array.isArray(invalidatedReviews) ? invalidatedReviews : [],
    },
    dependencyInvalidations: {
      schemaVersion: "context-room.proposal-dependency-invalidations/1",
      changedDependencies: dependencyInvalidations.changedDependencies || [],
      dependentReviews: dependencyInvalidations.dependentReviews || [],
      diagnostics: dependencyInvalidations.diagnostics || [],
      metadataInterpretationChanges: dependencyInvalidations.metadataInterpretationChanges || [],
    },
    contextCoverage: {
      schemaVersion: "context-room.proposal-context-coverage/1",
      evaluatedPaths: classified.changedFiles.map((item) => item.path),
      affectedConsumers: normalizeConsumers(consumers),
      requiredReviewPaths: [
        ...(Array.isArray(invalidatedReviews) ? invalidatedReviews : []).map((item) => item.path),
        ...(dependencyInvalidations.dependentReviews || []).map((item) => item.path),
      ].filter((value, index, values) => value && values.indexOf(value) === index),
      limitations: [
        "Only exact Git, metadata, dependency, provider, and registered-consumer relations were evaluated.",
        "Semantic contradictions were not evaluated.",
      ],
    },
    semanticConflicts: "not-evaluated",
    readOnly: true,
  };
}
