import { VISUAL_DOCUMENT_PATTERNS } from "./context_room.mjs";
import { VISUAL_PATTERN_EXAMPLES } from "./visual_pattern_examples.mjs";

// What an agent in any project needs to write a visual HTML document that Context Room
// renders: when to choose HTML, the rules, a page skeleton, and the cr-* patterns.
// Deterministic; the same for every project.
export const VISUAL_GUIDE_CHOOSE = Object.freeze([
  "Write Markdown by default.",
  "Choose HTML only when several relationships, branches, actors, states, boundaries or layers are easier to follow spatially.",
  "Do not diagram a simple idea: with fewer than three meaningful relationships, write prose, bullets or a short comparison.",
  "Each visual answers one explicit question, stated in a sentence before it.",
  "Use metrics and charts only for genuinely quantitative questions.",
]);

export const VISUAL_GUIDE_RULES = Object.freeze([
  "Write semantic HTML with cr-* classes. Context Room injects their styles in the reader and in the review.",
  "No <script>, no external resource, no copied theme CSS. Previews block scripts.",
  "Keep the meaning in text: headings, short labels, one sentence before and after each visual. Agents read the extracted text, not the markup.",
  "Use <details> for secondary detail. Never require hover or animation.",
  "Wrap a diagram in <div class=\"cr-diagram-scroll\" tabindex=\"0\">. Place nodes with --col, --row, --span and --rows; link them with .cr-diagram-edge[data-dir=\"h\"|\"v\"] and name each relationship that is not obvious.",
  "Node kinds: data-kind=\"external|state|decision|event|store\". Tones: data-tone=\"accent|positive|warning|negative\".",
]);

export const VISUAL_GUIDE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Title</title></head>
<body>
<main class="cr-page">
  <header class="cr-header"><div><p class="cr-kicker">Area</p><h1>Title</h1><p>The question this page answers.</p></div></header>
  <section>
    <h2>Section</h2>
    <p>One sentence that says what the visual shows.</p>
    <!-- one cr-* pattern: context-room docs visual-guide --pattern <id> -->
    <p>One sentence on what to conclude.</p>
  </section>
</main>
</body>
</html>`;

const DIAGRAM_GROUP = "diagram";

export function visualGuide({ pattern = "" } = {}) {
  const patterns = VISUAL_DOCUMENT_PATTERNS.map(({ id, className, group }) => ({
    id, className, group, title: VISUAL_PATTERN_EXAMPLES[id]?.title || id, purpose: VISUAL_PATTERN_EXAMPLES[id]?.purpose || "",
  }));
  const guide = { schemaVersion: "context-room.visual-guide/1", choose: VISUAL_GUIDE_CHOOSE, rules: VISUAL_GUIDE_RULES, page: VISUAL_GUIDE_PAGE, patterns };
  if (!pattern) return guide;
  const selected = patterns.find((entry) => entry.id === pattern || entry.className === pattern);
  if (!selected) throw Object.assign(new Error(`Unknown visual pattern: ${pattern}. Run docs visual-guide for the list.`), { code: "visual_pattern_unknown" });
  const html = VISUAL_PATTERN_EXAMPLES[selected.id].example;
  return { ...guide, example: { ...selected,
    html: selected.group === DIAGRAM_GROUP ? `<div class="cr-diagram-scroll" tabindex="0">\n  ${html}\n</div>` : html } };
}

export function renderVisualGuide(guide) {
  if (guide.example) return `${guide.example.title} (${guide.example.className}): ${guide.example.purpose}\n\n${guide.example.html}\n`;
  const groups = new Map();
  for (const entry of guide.patterns) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(`  ${entry.id} (${entry.className}): ${entry.purpose}`);
  }
  return [
    "Visual HTML documents", "", "Choose", ...guide.choose.map((line) => `- ${line}`), "",
    "Rules", ...guide.rules.map((line) => `- ${line}`), "", "Page", guide.page, "",
    `Patterns (${guide.patterns.length}). Print one example: context-room docs visual-guide --pattern <id>`,
    ...[...groups].flatMap(([group, lines]) => [`${group}`, ...lines]),
  ].join("\n") + "\n";
}
