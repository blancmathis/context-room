import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const MAX_CONTEXT_TEXT_BYTES = 750_000;
export const AGENT_CONTEXT_OPERATIONS = Object.freeze([
  "capabilities:read",
  "accepted:read",
  "proposal:list",
  "proposal:write",
  "proposal:checkout",
  "proposal:publish",
  "ui:workspace:list",
  "ui:workspace:navigate",
  "ui:workspace:pair",
]);

function gatewayError(message, statusCode, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function safeProjectId(value) {
  const projectId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) throw gatewayError("The Context Room project id is invalid.", 400, "agent_project_invalid");
  return projectId;
}

export function assertAgentOperation(identity, operation, requestedProjectId) {
  if (identity?.kind !== "agent") throw gatewayError("An agent capability is required.", 403, "agent_identity_required");
  const projectId = safeProjectId(identity.projectId);
  if (projectId !== safeProjectId(requestedProjectId)) throw gatewayError("The agent capability belongs to another Context Room project.", 403, "agent_project_scope_denied");
  if (!AGENT_CONTEXT_OPERATIONS.includes(operation) || !Array.isArray(identity.operations) || !identity.operations.includes(operation)) {
    throw gatewayError("The agent capability does not allow this operation.", 403, "agent_operation_denied");
  }
  return { ...identity, projectId };
}

export function assertContextProjectPath(projectId, input) {
  const normalizedProjectId = safeProjectId(projectId);
  const raw = String(input || "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || raw.includes("\0") || raw.split("/").includes("..")) throw gatewayError("The requested path is outside the agent project.", 403, "agent_path_denied");
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  const prefixes = [
    `projects/${normalizedProjectId}/docs/`,
    `projects/${normalizedProjectId}/skills/`,
  ];
  if (!prefixes.some((prefix) => normalized.startsWith(prefix)) || normalized.endsWith("/")) throw gatewayError("The requested path is outside project docs and skills.", 403, "agent_path_denied");
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExpectedHash(value, field, length) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) throw gatewayError(`${field} is required.`, 400, "agent_revision_required");
  return normalized;
}

export function validateTextPatch(input, { projectId }) {
  const filePath = assertContextProjectPath(projectId, input?.path);
  const content = String(input?.content ?? "");
  if (content.includes("\0")) throw gatewayError("Binary content is not accepted.", 400, "agent_binary_denied");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_TEXT_BYTES) throw gatewayError("Context files cannot exceed 750 KB.", 413, "agent_file_too_large");
  if (String(input?.entryType || "file") !== "file") throw gatewayError("Symlinks and gitlinks are not accepted.", 400, "agent_entry_type_denied");
  return {
    path: filePath,
    content,
    expectedContentHash: assertExpectedHash(input?.expectedContentHash, "expectedContentHash", 64),
    expectedProposalHead: assertExpectedHash(input?.expectedProposalHead, "expectedProposalHead", 40),
    entryType: "file",
  };
}

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })).trim();
}

function assertRegularPath(root, filePath) {
  const absolute = path.join(root, ...filePath.split("/"));
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw gatewayError("The requested path escapes the proposal checkout.", 403, "agent_path_denied");
  if (fs.existsSync(absolute)) {
    const stats = fs.lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw gatewayError("Only regular text files can be changed.", 400, "agent_entry_type_denied");
    const mode = git(root, ["ls-files", "-s", "--", filePath]).split(/\s+/)[0] || "";
    if (mode && mode !== "100644" && mode !== "100755") throw gatewayError("Gitlinks and special Git entries are not accepted.", 400, "agent_entry_type_denied");
  }
  return absolute;
}

export function applyTextPatch(proposal, input, { projectId }) {
  const patch = validateTextPatch(input, { projectId });
  const actualHead = git(proposal.root, ["rev-parse", "HEAD"]);
  if (actualHead !== patch.expectedProposalHead) throw gatewayError("The proposal changed; reload its exact revision before editing.", 409, "agent_proposal_stale", { expectedProposalHead: patch.expectedProposalHead, currentProposalHead: actualHead });
  const absolute = assertRegularPath(proposal.root, patch.path);
  const current = fs.existsSync(absolute) ? fs.readFileSync(absolute) : Buffer.alloc(0);
  const currentHash = sha256(current);
  if (currentHash !== patch.expectedContentHash) throw gatewayError("The file changed; reload it before editing.", 409, "agent_file_stale", { path: patch.path, expectedContentHash: patch.expectedContentHash, currentContentHash: currentHash });
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, patch.content, { encoding: "utf8", mode: 0o644 });
  return { path: patch.path, contentHash: sha256(Buffer.from(patch.content, "utf8")), proposalHead: actualHead };
}

export function projectDocuments(documents, projectId) {
  const normalizedProjectId = safeProjectId(projectId);
  return documents.filter((item) => {
    try {
      assertContextProjectPath(normalizedProjectId, item.path);
      return true;
    } catch {
      return false;
    }
  }).map((item) => ({ ...item, contentHash: sha256(Buffer.from(item.content, "utf8")) }));
}
