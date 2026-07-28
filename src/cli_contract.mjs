import { createHash, randomUUID } from "node:crypto";
import {
  CLI_COMMAND_REGISTRY,
  cliCapabilitiesFromRegistry,
  renderCliCompletionFromRegistry,
  renderCliHelpFromRegistry,
} from "./cli_registry.mjs";

export const CLI_SCHEMA_VERSION = "context-room.cli/1";
export const CLI_EVENT_SCHEMA_VERSION = "context-room.event/1";

export class ContextRoomCliError extends Error {
  constructor(code, message, { details = null, retryable = false, exitCode = 1, nextActions = [] } = {}) {
    super(message);
    this.name = "ContextRoomCliError";
    this.code = String(code || "operation-failed");
    this.details = details;
    this.retryable = Boolean(retryable);
    this.exitCode = Number(exitCode) || 1;
    this.nextActions = Array.isArray(nextActions) ? nextActions : [];
  }
}

export function cliRequestId() {
  return randomUUID();
}

export function cliEnvelope(command, {
  requestId = cliRequestId(),
  target = null,
  freshness = null,
  data = null,
  warnings = [],
  nextActions = [],
} = {}) {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    command: String(command || "unknown"),
    requestId,
    ok: true,
    target,
    freshness,
    data,
    warnings: Array.isArray(warnings) ? warnings : [],
    nextActions: Array.isArray(nextActions) ? nextActions : [],
  };
}

export function cliErrorEnvelope(command, error, { requestId = cliRequestId(), target = null } = {}) {
  const known = error instanceof ContextRoomCliError;
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    command: String(command || "unknown"),
    requestId,
    ok: false,
    target,
    error: {
      code: known ? error.code : "operation-failed",
      message: String(error?.message || error || "Context Room command failed"),
      retryable: known ? error.retryable : false,
      details: known ? error.details : null,
    },
    warnings: [],
    nextActions: known ? error.nextActions : [],
  };
}

export function stableCliPlanId({ command, target = null, input = null, revision = null } = {}) {
  return "plan-" + createHash("sha256")
    .update(JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, command, target, input, revision }))
    .digest("hex")
    .slice(0, 24);
}

export function stableCliOperationId({ planId, idempotencyKey = "" } = {}) {
  return "op-" + createHash("sha256")
    .update(`${String(planId || "")}\0${String(idempotencyKey || "")}`)
    .digest("hex")
    .slice(0, 24);
}

export function normalizeCliFormat(value, fallback = "legacy") {
  const format = String(value || fallback).trim().toLowerCase();
  if (!["legacy", "human", "json", "jsonl"].includes(format)) {
    throw new ContextRoomCliError("invalid-format", `Unknown output format: ${format}`, {
      details: { expected: ["human", "json", "jsonl"] },
      exitCode: 2,
    });
  }
  return format;
}

function readPath(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, key) => current == null ? undefined : current[key], value);
}

function writePath(target, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) current = current[parts[index]] ||= {};
  if (parts.length) current[parts.at(-1)] = value;
}

function summarizeValue(value, path, expanded, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (expanded.has(path)) return value;
  if (Array.isArray(value)) return { count: value.length };
  if (depth >= 2) return { keys: Object.keys(value), count: Object.keys(value).length };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, summarizeValue(child, path ? `${path}.${key}` : key, expanded, depth + 1)]));
}

export function projectCliData(data, { fields = [], summary = false, expand = [] } = {}) {
  const selectedFields = Array.isArray(fields) ? fields.filter(Boolean) : String(fields || "").split(",").map((item) => item.trim()).filter(Boolean);
  const expanded = new Set(Array.isArray(expand) ? expand.filter(Boolean) : String(expand || "").split(",").map((item) => item.trim()).filter(Boolean));
  let projected = data;
  if (selectedFields.length) {
    projected = {};
    for (const field of selectedFields) {
      const value = readPath(data, field);
      if (value !== undefined) writePath(projected, field, value);
    }
  }
  return summary ? summarizeValue(projected, "", expanded) : projected;
}

export const CLI_COMMANDS = CLI_COMMAND_REGISTRY;

export function cliCapabilities({ version = "", include = "canonical" } = {}) {
  return {
    ...cliCapabilitiesFromRegistry({ version, include }),
    invariants: [
      "No CLI command accepts, rejects, or verifies a file review.",
      "Shared main changes only after file-level human review completes.",
      "Worktrees are registered explicitly and are never discovered by scanning the computer.",
      "Unmanaged skill destinations are never replaced.",
    ],
    mutationProtocol: { preview: "omit --apply or pass --plan", apply: "--apply <plan-id>", staleError: "stale-plan", idempotentReceipts: true },
    limits: { eventJournalEntries: 10_000, eventPayload: "metadata-only", implicitWorktreeDiscovery: false, humanReviewDecisionsInCli: false },
    aliases: { "--root": "location path" },
  };
}

export function renderCliCompletion(shell = "zsh") {
  try {
    return renderCliCompletionFromRegistry(shell);
  } catch (error) {
    throw new ContextRoomCliError("invalid-shell", error.message, {
      details: { expected: ["zsh", "bash", "fish"] },
      exitCode: 2,
    });
  }
}

export function renderCliHelp() {
  return renderCliHelpFromRegistry();
}
