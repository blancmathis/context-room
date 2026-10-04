// What the effective context costs an agent, in three parts: loaded at startup,
// loaded on demand, and unknown. Estimates only (characters ÷ 4, no tokenizer);
// gauges compare against hard limits only. Deterministic, no model calls.
import fs from "node:fs";
import os from "node:os";

import { CONTEXT_LOSS_LIMITS, codexProjectDocLimit, frontmatterField } from "./context_losses.mjs";
import { estimateTokens } from "./documentation.mjs";

export const CONTEXT_COST_METHOD = "Estimate: characters ÷ 4, no tokenizer.";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function withoutFrontmatter(text) {
  return String(text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function tokens(text) {
  return text ? estimateTokens(text) : 0;
}

// effective: resolveEffectiveContext() output.
export function contextCost(effective, { root = "", home = os.homedir(), readFile = readText } = {}) {
  const provider = effective?.coordinate?.provider || "";
  const entries = {};
  const startup = { tokens: 0, resources: 0, unmeasured: 0 };
  const onDemand = { tokens: 0, resources: 0, unmeasured: 0 };
  const limits = [];
  const text = (entry) => {
    const file = entry.resource?.metadata?.absolutePath || "";
    return file ? readFile(file) : null;
  };

  for (const entry of effective?.instructions || []) {
    const content = text(entry);
    const cost = { mode: "startup", startupTokens: content == null ? null : tokens(content), bytes: content == null ? null : Buffer.byteLength(content) };
    // Claude Code loads @path imports too; their size is not counted here.
    if (content != null && provider === "claude-code" && /^@[^\s@]+/m.test(content)) cost.note = "Imported files (@path) are not counted.";
    entries[entry.resource.id] = cost;
    startup.resources += 1;
    if (cost.startupTokens == null) startup.unmeasured += 1;
    else startup.tokens += cost.startupTokens;
  }

  for (const entry of effective?.skills || []) {
    const content = text(entry);
    const name = content == null ? "" : frontmatterField(content, "name") || entry.resource.metadata?.name || "";
    const description = content == null ? "" : frontmatterField(content, "description") || "";
    // Agents read every skill's name and description at startup and the body only when they use it.
    const cost = content == null
      ? { mode: "description", startupTokens: null, onDemandTokens: null }
      : { mode: "description", startupTokens: tokens(`${name}: ${description}`), onDemandTokens: tokens(withoutFrontmatter(content).trim()), descriptionChars: description.length };
    entries[entry.resource.id] = cost;
    startup.resources += 1;
    onDemand.resources += 1;
    if (cost.startupTokens == null) {
      startup.unmeasured += 1;
      onDemand.unmeasured += 1;
    } else {
      startup.tokens += cost.startupTokens;
      onDemand.tokens += cost.onDemandTokens;
    }
    if (cost.descriptionChars >= CONTEXT_LOSS_LIMITS.skillDescriptionChars * CONTEXT_LOSS_LIMITS.nearRatio) {
      limits.push({ id: "skill-description", label: `${name || entry.resource.locator} description`, locator: entry.resource.locator, used: cost.descriptionChars, max: CONTEXT_LOSS_LIMITS.skillDescriptionChars, unit: "characters" });
    }
  }

  for (const entry of effective?.documents || []) {
    const content = text(entry);
    const cost = { mode: "on-demand", onDemandTokens: content == null ? null : tokens(content) };
    entries[entry.resource.id] = cost;
    onDemand.resources += 1;
    if (cost.onDemandTokens == null) onDemand.unmeasured += 1;
    else onDemand.tokens += cost.onDemandTokens;
  }

  const unknownIds = new Set((effective?.unknown || []).map((item) => item.resourceId));
  for (const entry of [...(effective?.hooks || []), ...(effective?.mcpServers || [])]) {
    entries[entry.resource.id] = { mode: unknownIds.has(entry.resource.id) ? "unknown" : "none" };
  }
  for (const entry of effective?.providerConfigs || []) entries[entry.resource.id] = { mode: "none" };

  const unknown = (effective?.unknown || []).map(({ kind, locator, reason }) => ({ kind, locator, reason }));
  if (provider === "claude-code") {
    unknown.push({ kind: "memory", locator: "~/.claude/projects/…/memory/MEMORY.md", reason: "Claude Code can load its auto memory at startup; Context Room does not measure it." });
  }

  if (provider === "codex") {
    const { limit, source } = codexProjectDocLimit({ root, home });
    const used = (effective?.instructions || [])
      .filter((entry) => entry.application?.scope !== "device")
      .reduce((sum, entry) => sum + (entries[entry.resource.id]?.bytes || 0), 0);
    limits.unshift({ id: "codex-project-doc", label: "Codex project instructions", used, max: limit, unit: "bytes", source });
  }

  return { schemaVersion: "context-room.context-cost/1", method: CONTEXT_COST_METHOD, startup, onDemand, unknown, limits, entries };
}
