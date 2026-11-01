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
  // Dropping the last items of one array one render at a time is quadratic on a large
  // result. The output only shrinks as items go, so find by bisection the smallest
  // number of drops that fits (or all of them) and land there; the state and the
  // trimmed count are the ones the one-at-a-time loop reaches. An empty array may
  // render longer than one item (a "nothing found" line), so never assume that
  // dropping everything is the shortest output.
  const popUntilItFits = (dotted) => {
    const array = arrayAt(dotted);
    const base = trimmed[dotted] || 0;
    const removed = [];
    const fitsAfter = (count) => {
      while (removed.length < count) removed.push(array.pop());
      while (removed.length > count) array.push(removed.pop());
      trimmed[dotted] = base + count;
      return estimateTokens(render(value, report)) <= budget;
    };
    const length = array.length;
    let low = 1;
    let high = length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fitsAfter(mid)) high = mid;
      else low = mid + 1;
    }
    fitsAfter(low);
    return dotted;
  };
  let output = "";
  for (let pass = 0; pass < 100000; pass += 1) {
    output = render(value, report);
    const estimate = estimateTokens(output);
    if (estimate > budget) {
      const arrayTrimmer = trimmers.find((trimmer) => typeof trimmer === "string" && Array.isArray(arrayAt(trimmer)) && arrayAt(trimmer).length);
      const objectBefore = arrayTrimmer === undefined ? trimmers.slice() : trimmers.slice(0, trimmers.indexOf(arrayTrimmer));
      // An object trimmer listed before the first usable array still goes first, one step at a time.
      const next = objectBefore.find((trimmer) => typeof trimmer !== "string" && trimmer.apply(value))
        || (arrayTrimmer !== undefined && popUntilItFits(arrayTrimmer));
      if (next) {
        const name = typeof next === "string" ? next : next.name;
        if (typeof next !== "string") trimmed[name] = (trimmed[name] || 0) + 1;
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
