import { estimateTokens } from "./documentation.mjs";

// Fit a command's whole output, envelope included, to a token budget. A trimmer is
// either a dotted path to an array (its last item is dropped) or { name, apply },
// where apply(value) shortens something and returns false when it cannot. The first
// trimmer that can act does, so list the least useful first. The report says what
// was left out or shortened.
export function fitToTokenBudget(value, { budget, render, trimmers = [] }) {
  const trimmed = {};
  const report = { requested: budget, estimatedTokens: 0, fits: true, trimmed };
  const arrayAt = (dotted) => dotted.split(".").reduce((node, key) => node?.[key], value);
  let output = "";
  for (let pass = 0; pass < 100000; pass += 1) {
    output = render(value, report);
    const estimate = estimateTokens(output);
    if (estimate > budget) {
      const next = trimmers.find((trimmer) => typeof trimmer === "string"
        ? Array.isArray(arrayAt(trimmer)) && arrayAt(trimmer).length && (arrayAt(trimmer).pop(), true)
        : trimmer.apply(value));
      if (next) {
        const name = typeof next === "string" ? next : next.name;
        trimmed[name] = (trimmed[name] || 0) + 1;
        continue;
      }
    }
    // Render again until the report describes the output it is part of.
    if (report.estimatedTokens === estimate && report.fits === estimate <= budget) break;
    report.estimatedTokens = estimate;
    report.fits = estimate <= budget;
  }
  return { output, report };
}

const SHORT_SNIPPET_CHARS = 160;

// Before a search result is dropped, it loses its ranking reasons and keeps a short snippet.
export const COMPACT_SEARCH_RESULT = {
  name: "data.results.compacted",
  apply(value) {
    const result = [...(value.data?.results || [])].reverse()
      .find((item) => item.rankingReasons || String(item.snippet || "").length > SHORT_SNIPPET_CHARS + 1);
    if (!result) return false;
    delete result.rankingReasons;
    const snippet = String(result.snippet || "");
    if (snippet.length > SHORT_SNIPPET_CHARS + 1) result.snippet = snippet.slice(0, SHORT_SNIPPET_CHARS).trimEnd() + "…";
    return true;
  },
};

// Paths inside the printed result. Least useful first: duplicated health detail,
// provider inventories, review and health items, then the task's accepted documents.
export const CONTEXT_BUNDLE_TRIMMERS = [
  "data.environment.healthIssues",
  "data.environment.mcpServers",
  "data.environment.hooks",
  "data.environment.unknown",
  "data.environment.skills",
  "data.environment.providerConfigs",
  "data.environment.losses",
  "data.health.items",
  "data.review.items",
  "data.proposals",
  "data.documentation.pendingSession",
  "data.environment.instructions",
  "nextActions",
  "data.documentation.accepted",
  "warnings",
];
