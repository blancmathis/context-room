// Exact examples for the cr-* visual patterns, from the reviewed visual catalogs
// (docs/context-room-*-visual-components.html, removed from docs in c8eee34).
// Generated once; edit by hand.
export const VISUAL_PATTERN_EXAMPLES = Object.freeze({
  "data-metric-grid": {
    "title": "Metric grid",
    "purpose": "Headline values.",
    "example": "<div class=\"cr-metrics\"><div class=\"cr-metric\"><strong>96%</strong><span>trusted docs</span></div><div class=\"cr-metric\"><strong>4.8s</strong><span>median review</span></div><div class=\"cr-metric\"><strong>14</strong><span>decisions</span></div></div>"
  },
  "data-kpi-grid": {
    "title": "KPI grid",
    "purpose": "Values with context.",
    "example": "<div class=\"cr-kpi-grid\"><div class=\"cr-kpi\" data-tone=\"positive\"><span>Coverage</span><strong>92%</strong><span>Target 90%</span></div><div class=\"cr-kpi\" data-tone=\"warning\"><span>Review age</span><strong>2.4d</strong><span>Target below 2d</span></div></div>"
  },
  "data-stat-strip": {
    "title": "Stat strip",
    "purpose": "Compact shared facts.",
    "example": "<div class=\"cr-stat-strip\"><div class=\"cr-stat\"><strong>30</strong><span>files</span></div><div class=\"cr-stat\"><strong>16</strong><span>watched</span></div><div class=\"cr-stat\"><strong>6</strong><span>changed</span></div></div>"
  },
  "data-scorecard": {
    "title": "Scorecard",
    "purpose": "Criteria and verdicts.",
    "example": "<div class=\"cr-scorecard\"><div class=\"cr-score\" data-tone=\"positive\"><strong>Accuracy</strong><span class=\"cr-score-grade\">Strong</span></div><div class=\"cr-score\" data-tone=\"warning\"><strong>Freshness</strong><span class=\"cr-score-grade\">Watch</span></div></div>"
  },
  "data-progress-list": {
    "title": "Progress list",
    "purpose": "Parallel completion.",
    "example": "<div class=\"cr-progress-list\"><div class=\"cr-progress\" data-tone=\"positive\"><strong>Docs reviewed</strong><span>84%</span><div class=\"cr-progress-track\"><div class=\"cr-progress-fill\" style=\"--value:84%\"></div></div></div><div class=\"cr-progress\"><strong>Tests covered</strong><span>68%</span><div class=\"cr-progress-track\"><div class=\"cr-progress-fill\" style=\"--value:68%\"></div></div></div></div>"
  },
  "data-bullet-chart": {
    "title": "Bullet chart",
    "purpose": "Actual versus target.",
    "example": "<div class=\"cr-bullet-chart\"><div class=\"cr-bullet\" data-tone=\"positive\"><strong>Trust</strong><div class=\"cr-bullet-track\" style=\"--value:92%;--target:90%\"></div><span>92 / 90</span></div><div class=\"cr-bullet\" data-tone=\"warning\"><strong>Speed</strong><div class=\"cr-bullet-track\" style=\"--value:64%;--target:80%\"></div><span>64 / 80</span></div></div>"
  },
  "data-gauge": {
    "title": "Gauge",
    "purpose": "Value across bands.",
    "example": "<div class=\"cr-gauge\"><div class=\"cr-gauge-head\"><strong>Context health</strong><span>72 / 100</span></div><div class=\"cr-gauge-track\" style=\"--value:72%\"></div></div>"
  },
  "data-ring": {
    "title": "Ring",
    "purpose": "One bounded proportion.",
    "example": "<div class=\"cr-ring\" data-tone=\"positive\" style=\"--value:78%\"><div><strong>78%</strong><span>reviewed</span></div></div>"
  },
  "data-delta-grid": {
    "title": "Delta grid",
    "purpose": "Signed movement.",
    "example": "<div class=\"cr-delta-grid\"><div class=\"cr-delta\" data-tone=\"positive\"><strong>+18%</strong><span>faster opening</span></div><div class=\"cr-delta\" data-tone=\"negative\"><strong>-4</strong><span>stale pages</span></div></div>"
  },
  "data-status-summary": {
    "title": "Status summary",
    "purpose": "Counts by state.",
    "example": "<div class=\"cr-status-summary\"><div class=\"cr-status\" data-tone=\"positive\"><strong>18</strong><span>current</span></div><div class=\"cr-status\" data-tone=\"warning\"><strong>4</strong><span>review</span></div><div class=\"cr-status\" data-tone=\"negative\"><strong>2</strong><span>blocked</span></div></div>"
  },
  "data-comparison": {
    "title": "Comparison",
    "purpose": "Parallel choices.",
    "example": "<div class=\"cr-comparison\"><article class=\"cr-option\" data-tone=\"positive\"><h3>Shared review</h3><p>Trust follows the file.</p></article><article class=\"cr-option\" data-tone=\"warning\"><h3>Room review</h3><p>Trust stays local.</p></article></div>"
  },
  "data-before-after": {
    "title": "Before and after",
    "purpose": "Two changed states.",
    "example": "<div class=\"cr-before-after\"><article><h3>Before</h3><p>12 duplicate reviews.</p></article><span class=\"cr-change-arrow\">&gt;</span><article><h3>After</h3><p>1 shared review.</p></article></div>"
  },
  "data-pros-cons": {
    "title": "Pros and cons",
    "purpose": "Benefits and costs.",
    "example": "<div class=\"cr-pros-cons\"><article><h3>Benefits</h3><ul><li>Visual review</li><li>Theme consistency</li></ul></article><article><h3>Costs</h3><ul><li>More markup</li><li>Whole-file review</li></ul></article></div>"
  },
  "data-decision-matrix": {
    "title": "Decision matrix",
    "purpose": "Scored options.",
    "example": "<div class=\"cr-decision-matrix\"><div class=\"cr-decision-row\" data-head=\"\" style=\"--columns:2\"><strong>Option</strong><span>Clarity</span><span>Speed</span></div><div class=\"cr-decision-row\" style=\"--columns:2\"><strong>Markdown</strong><span>4</span><span>5</span></div><div class=\"cr-decision-row\" style=\"--columns:2\"><strong>HTML</strong><span>5</span><span>3</span></div></div>"
  },
  "data-feature-matrix": {
    "title": "Feature matrix",
    "purpose": "Dense capability comparison.",
    "example": "<table class=\"cr-feature-matrix\"><tbody><tr><th>Capability</th><th>MD</th><th>HTML</th></tr><tr><td>Fast edit</td><td>Yes</td><td>Partial</td></tr><tr><td>Spatial view</td><td>Limited</td><td>Yes</td></tr></tbody></table>"
  },
  "data-quadrant": {
    "title": "Quadrant",
    "purpose": "Two-axis classification.",
    "example": "<div class=\"cr-quadrant\"><div class=\"cr-quadrant-cell\"><h3>High value</h3><p>Low effort</p></div><div class=\"cr-quadrant-cell\"><h3>High value</h3><p>High effort</p></div><div class=\"cr-quadrant-cell\"><h3>Low value</h3><p>Low effort</p></div><div class=\"cr-quadrant-cell\"><h3>Low value</h3><p>High effort</p></div></div>"
  },
  "data-spectrum": {
    "title": "Spectrum",
    "purpose": "Positions on one axis.",
    "example": "<div class=\"cr-spectrum\"><div class=\"cr-spectrum-track\"><span class=\"cr-spectrum-point\" style=\"--value:24%\"></span><span class=\"cr-spectrum-point\" data-tone=\"positive\" style=\"--value:78%\"></span></div><div class=\"cr-spectrum-labels\"><span>Linear prose</span><span>Spatial explanation</span></div></div>"
  },
  "data-ranking": {
    "title": "Ranking",
    "purpose": "Ordered alternatives.",
    "example": "<ol class=\"cr-ranking\"><li><strong>Bar chart</strong><div class=\"cr-ranking-bar\" style=\"--value:92%\"></div><span>92</span></li><li data-tone=\"positive\"><strong>Dot plot</strong><div class=\"cr-ranking-bar\" style=\"--value:81%\"></div><span>81</span></li></ol>"
  },
  "data-benchmark": {
    "title": "Benchmark",
    "purpose": "Current versus baseline.",
    "example": "<div class=\"cr-benchmark\"><div class=\"cr-benchmark-row\"><strong>Open time</strong><div class=\"cr-benchmark-track\" style=\"--value:42%;--baseline:76%\"></div><span>0.42s</span></div><div class=\"cr-benchmark-row\" data-tone=\"positive\"><strong>Review</strong><div class=\"cr-benchmark-track\" style=\"--value:63%;--baseline:70%\"></div><span>6.3s</span></div></div>"
  },
  "data-distribution": {
    "title": "Distribution",
    "purpose": "Low, high, median.",
    "example": "<div class=\"cr-distribution\"><div class=\"cr-distribution-row\"><strong>Small docs</strong><div class=\"cr-distribution-track\" style=\"--low:12%;--high:48%;--median:28%\"><span class=\"cr-distribution-range\"></span></div></div><div class=\"cr-distribution-row\"><strong>Large docs</strong><div class=\"cr-distribution-track\" style=\"--low:38%;--high:92%;--median:64%\"><span class=\"cr-distribution-range\"></span></div></div></div>"
  },
  "data-bar-chart": {
    "title": "Bar chart",
    "purpose": "Labeled quantities.",
    "example": "<div class=\"cr-bar-chart\"><div class=\"cr-chart-row\"><strong>Current</strong><div class=\"cr-bar-track\"><div class=\"cr-bar-fill\" style=\"--value:86%\"></div></div><span>86</span></div><div class=\"cr-chart-row\" data-tone=\"warning\"><strong>Review</strong><div class=\"cr-bar-track\"><div class=\"cr-bar-fill\" style=\"--value:54%\"></div></div><span>54</span></div></div>"
  },
  "data-grouped-bars": {
    "title": "Grouped bars",
    "purpose": "Two series per category.",
    "example": "<div class=\"cr-grouped-bars\"><div class=\"cr-chart-row\"><strong>Docs</strong><div class=\"cr-bar-group\"><div class=\"cr-bar-track\"><div class=\"cr-bar-fill\" style=\"--value:82%\"></div></div><div class=\"cr-bar-track\"><div class=\"cr-bar-fill\" data-tone=\"warning\" style=\"--value:58%\"></div></div></div><span>82 / 58</span></div></div>"
  },
  "data-stacked-bar": {
    "title": "Stacked bar",
    "purpose": "Parts of a whole.",
    "example": "<div class=\"cr-stacked-bar\"><div class=\"cr-stacked-segment\" data-tone=\"positive\" style=\"--value:52%\">52%</div><div class=\"cr-stacked-segment\" style=\"--value:31%\">31%</div><div class=\"cr-stacked-segment\" data-tone=\"warning\" style=\"--value:17%\">17%</div></div>"
  },
  "data-diverging-bars": {
    "title": "Diverging bars",
    "purpose": "Opposing values.",
    "example": "<div class=\"cr-diverging-bars\"><div class=\"cr-diverging-row\"><div class=\"cr-diverging-side negative\"><span class=\"cr-diverging-fill\" data-tone=\"negative\" style=\"--value:28%\"></span></div><strong>Clarity</strong><div class=\"cr-diverging-side\"><span class=\"cr-diverging-fill\" data-tone=\"positive\" style=\"--value:76%\"></span></div></div></div>"
  },
  "data-lollipop-chart": {
    "title": "Lollipop chart",
    "purpose": "Sparse quantities.",
    "example": "<div class=\"cr-lollipop-chart\"><div class=\"cr-lollipop-row\"><strong>Explorer</strong><div class=\"cr-lollipop-track\" style=\"--value:88%\"></div><span>88</span></div><div class=\"cr-lollipop-row\"><strong>Review</strong><div class=\"cr-lollipop-track\" data-tone=\"positive\" style=\"--value:72%\"></div><span>72</span></div></div>"
  },
  "data-dot-plot": {
    "title": "Dot plot",
    "purpose": "Values on one axis.",
    "example": "<div class=\"cr-dot-plot\"><div class=\"cr-dot-row\"><strong>Open time</strong><div class=\"cr-dot-track\"><span class=\"cr-dot\" data-tone=\"positive\" style=\"--value:22%\"></span><span class=\"cr-dot\" data-tone=\"warning\" style=\"--value:63%\"></span></div></div></div>"
  },
  "data-histogram": {
    "title": "Histogram",
    "purpose": "Frequency by bin.",
    "example": "<div class=\"cr-histogram\"><span class=\"cr-histogram-bar\" style=\"--value:18%\"></span><span class=\"cr-histogram-bar\" style=\"--value:42%\"></span><span class=\"cr-histogram-bar\" style=\"--value:76%\"></span><span class=\"cr-histogram-bar\" style=\"--value:88%\"></span><span class=\"cr-histogram-bar\" style=\"--value:54%\"></span><span class=\"cr-histogram-bar\" style=\"--value:22%\"></span></div>"
  },
  "data-sparkline": {
    "title": "Sparkline",
    "purpose": "Compact trend.",
    "example": "<div class=\"cr-sparkline\"><span class=\"cr-sparkline-bar\" style=\"--value:32%\"></span><span class=\"cr-sparkline-bar\" style=\"--value:45%\"></span><span class=\"cr-sparkline-bar\" style=\"--value:58%\"></span><span class=\"cr-sparkline-bar\" style=\"--value:44%\"></span><span class=\"cr-sparkline-bar\" data-tone=\"positive\" style=\"--value:84%\"></span></div>"
  },
  "data-heatmap": {
    "title": "Heatmap",
    "purpose": "Repeated intensity.",
    "example": "<div class=\"cr-heatmap\" style=\"--columns:7\"><span class=\"cr-heatmap-cell\" style=\"--level:12%\">M</span><span class=\"cr-heatmap-cell\" style=\"--level:28%\">T</span><span class=\"cr-heatmap-cell\" style=\"--level:66%\">W</span><span class=\"cr-heatmap-cell\" style=\"--level:82%\">T</span><span class=\"cr-heatmap-cell\" style=\"--level:44%\">F</span><span class=\"cr-heatmap-cell\" style=\"--level:18%\">S</span><span class=\"cr-heatmap-cell\" style=\"--level:8%\">S</span></div>"
  },
  "data-waterfall": {
    "title": "Waterfall",
    "purpose": "Sequential contributions.",
    "example": "<div class=\"cr-waterfall\"><div class=\"cr-waterfall-bar\" style=\"--value:42%;--offset:0%\"><span>Start</span></div><div class=\"cr-waterfall-bar\" data-tone=\"positive\" style=\"--value:24%;--offset:42%\"><span>+24</span></div><div class=\"cr-waterfall-bar\" data-tone=\"negative\" style=\"--value:18%;--offset:48%\"><span>-18</span></div><div class=\"cr-waterfall-bar\" style=\"--value:48%;--offset:0%\"><span>Total</span></div></div>"
  },
  "data-timeline": {
    "title": "Timeline",
    "purpose": "Dated events.",
    "example": "<div class=\"cr-timeline\"><article class=\"cr-timeline-item\"><time>09:00</time><h3>Propose</h3><p>File enters review.</p></article><article class=\"cr-timeline-item\" data-tone=\"positive\"><time>09:18</time><h3>Accept</h3><p>Trust updates.</p></article></div>"
  },
  "data-roadmap": {
    "title": "Roadmap",
    "purpose": "Work across periods.",
    "example": "<div class=\"cr-roadmap\"><div class=\"cr-roadmap-grid\" style=\"--periods:3\"><span></span><span class=\"cr-roadmap-period\">Now</span><span class=\"cr-roadmap-period\">Next</span><span class=\"cr-roadmap-period\">Later</span><span class=\"cr-roadmap-label\">Review</span><div class=\"cr-roadmap-lane\"><span class=\"cr-roadmap-item\" style=\"--start:1;--span:2\">Shared trust</span></div></div></div>"
  },
  "data-swimlane": {
    "title": "Swimlane",
    "purpose": "Steps by owner.",
    "example": "<div class=\"cr-swimlane\"><div class=\"cr-swimlane-row\" style=\"--columns:3\"><strong>Agent</strong><div class=\"cr-swimlane-track\"><span class=\"cr-swimlane-item\" style=\"--start:1;--span:2\">Edit and open</span></div></div><div class=\"cr-swimlane-row\" style=\"--columns:3\"><strong>User</strong><div class=\"cr-swimlane-track\"><span class=\"cr-swimlane-item\" data-tone=\"positive\" style=\"--start:3;--span:1\">Approve</span></div></div></div>"
  },
  "data-flow": {
    "title": "Flow",
    "purpose": "Ordered process.",
    "example": "<div class=\"cr-flow\"><article class=\"cr-step\"><h3>Inspect</h3></article><article class=\"cr-step\"><h3>Edit</h3></article><article class=\"cr-step\"><h3>Review</h3></article><article class=\"cr-step\"><h3>Trust</h3></article></div>"
  },
  "data-cycle": {
    "title": "Cycle",
    "purpose": "Repeating process.",
    "example": "<div class=\"cr-cycle\"><article class=\"cr-cycle-step\">Observe</article><article class=\"cr-cycle-step\" data-tone=\"warning\">Review</article><article class=\"cr-cycle-step\" data-tone=\"positive\">Update</article><article class=\"cr-cycle-step\">Monitor</article></div>"
  },
  "data-funnel": {
    "title": "Funnel",
    "purpose": "Attrition by stage.",
    "example": "<div class=\"cr-funnel\"><div class=\"cr-funnel-step\" style=\"--width:100%\">30 files</div><div class=\"cr-funnel-step\" style=\"--width:76%\">24 allowed</div><div class=\"cr-funnel-step\" data-tone=\"positive\" style=\"--width:42%\">8 reviewed</div></div>"
  },
  "data-pyramid": {
    "title": "Pyramid",
    "purpose": "Ordered layers.",
    "example": "<div class=\"cr-pyramid\"><div class=\"cr-pyramid-step\" data-tone=\"positive\" style=\"--width:38%\">Decision</div><div class=\"cr-pyramid-step\" style=\"--width:66%\">Reviewed docs</div><div class=\"cr-pyramid-step\" data-tone=\"warning\" style=\"--width:100%\">Source truth</div></div>"
  },
  "data-tree": {
    "title": "Tree",
    "purpose": "Hierarchy.",
    "example": "<ul class=\"cr-tree\"><li><strong>Context Room</strong><ul><li>Docs<ul><li>Features</li><li>Config</li></ul></li><li>Source</li><li>Tests</li></ul></li></ul>"
  },
  "data-dependency-chain": {
    "title": "Dependency chain",
    "purpose": "Prerequisites.",
    "example": "<div class=\"cr-dependency-chain\"><article class=\"cr-dependency-node\">Source truth</article><article class=\"cr-dependency-node\" data-tone=\"warning\">Review</article><article class=\"cr-dependency-node\" data-tone=\"positive\">Agent context</article></div>"
  },
  "data-status-board": {
    "title": "Status board",
    "purpose": "Items by state.",
    "example": "<div class=\"cr-status-board\"><section class=\"cr-status-column\"><header><span>Proposed</span><span>2</span></header><div class=\"cr-status-item\">HTML patterns</div></section><section class=\"cr-status-column\" data-tone=\"warning\"><header><span>Review</span><span>1</span></header><div class=\"cr-status-item\">Visual catalog</div></section><section class=\"cr-status-column\" data-tone=\"positive\"><header><span>Trusted</span><span>2</span></header><div class=\"cr-status-item\">Shared paths</div></section></div>"
  },
  "system-landscape": {
    "title": "System landscape",
    "purpose": "What exists and who owns it?",
    "example": "<div class=\"cr-diagram cr-system-landscape\">\n    <div class=\"cr-diagram-boundary\" style=\"--col:5;--row:1;--span:8;--rows:8\">Owned Context Room boundary</div>\n    <details class=\"cr-diagram-node\" data-kind=\"external\" style=\"--col:1;--row:2;--span:3\">\n      <summary><strong>Human reviewer</strong><span>Decides what becomes trusted</span></summary>\n      <p>Only this actor can accept or reject proposed changes.</p>\n    </details>\n    <details class=\"cr-diagram-node\" data-kind=\"external\" style=\"--col:1;--row:5;--span:3\">\n      <summary><strong>Coding agent</strong><span>Inspects and proposes</span></summary>\n      <p>Uses the CLI to navigate and annotate without bypassing review.</p>\n    </details>\n    <article class=\"cr-diagram-node\" data-kind=\"external\" style=\"--col:1;--row:8;--span:3\"><strong>Team policy</strong><span>Defines review ownership and scope</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:6;--row:2;--span:3\"><strong>Review interface</strong><span>Shows files, previews, and decisions</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"store\" style=\"--col:10;--row:2;--span:2\"><strong>Session state</strong><span>Navigation and open view</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:6;--row:5;--span:3\"><strong>Review engine</strong><span>Builds the proposal against a trusted base</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:10;--row:5;--span:2\"><strong>File service</strong><span>Reads and writes allowed paths</span></article>\n    <details class=\"cr-diagram-node\" data-kind=\"store\" data-tone=\"positive\" style=\"--col:6;--row:8;--span:3\">\n      <summary><strong>Trust ledger</strong><span>Canonical path + review hash</span></summary>\n      <p>One accepted content hash can be shared across Context Rooms.</p>\n    </details>\n    <article class=\"cr-diagram-node\" style=\"--col:10;--row:8;--span:2\"><strong>Health guard</strong><span>Surfaces triggered context issues</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"external\" style=\"--col:14;--row:2;--span:3\"><strong>Project files</strong><span>Current source truth</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"external\" style=\"--col:14;--row:5;--span:3\"><strong>Git history</strong><span>Change provenance and rename identity</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"external\" style=\"--col:14;--row:8;--span:3\"><strong>Global preferences</strong><span>Shared appearance settings</span></article>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:4;--row:2;--span:2\"><span>reviews</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:4;--row:5;--span:2\"><span>opens via CLI</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:4;--row:8;--span:2\"><span>governs</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" style=\"--col:7;--row:3;--rows:2\"><span>proposes</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-tone=\"positive\" style=\"--col:7;--row:6;--rows:2\"><span>accept</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:12;--row:2;--span:2\"><span>reads</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:12;--row:5;--span:2\"><span>diffs</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:12;--row:8;--span:2\"><span>inherits</span></div>\n  </div>"
  },
  "causal-chain": {
    "title": "Causal chain",
    "purpose": "Why does this outcome happen?",
    "example": "<div class=\"cr-diagram cr-causal-chain-map\">\n    <div class=\"cr-diagram-group\" data-tone=\"negative\" style=\"--col:1;--row:1;--span:4;--rows:9\">Root causes</div>\n    <div class=\"cr-diagram-group\" data-tone=\"warning\" style=\"--col:6;--row:1;--span:5;--rows:9\">Mechanisms</div>\n    <div class=\"cr-diagram-group\" style=\"--col:12;--row:1;--span:5;--rows:9\">Observable effects</div>\n    <details class=\"cr-diagram-node\" data-tone=\"negative\" style=\"--col:1;--row:2;--span:4\"><summary><strong>Duplicate sources</strong><span>Several pages own the same claim</span></summary><p>Corrections update one copy while the others remain stale.</p></details>\n    <article class=\"cr-diagram-node\" data-tone=\"negative\" style=\"--col:1;--row:4;--span:4\"><strong>Unclear ownership</strong><span>No canonical location</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"negative\" style=\"--col:1;--row:6;--span:4\"><strong>Implicit verification</strong><span>Opening looks like approval</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"negative\" style=\"--col:1;--row:8;--span:4\"><strong>Metadata-only edits</strong><span>Noise looks like meaningful change</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:6;--row:2;--span:5\"><strong>Contradictory context</strong><span>The reader sees competing truths</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:6;--row:4;--span:5\"><strong>Weak trust signal</strong><span>Status no longer means reviewed</span></article>\n    <details class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:6;--row:6;--span:5\"><summary><strong>Review fatigue</strong><span>Repeated work lowers attention</span></summary><p>Important changes become harder to distinguish from metadata noise.</p></details>\n    <article class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:6;--row:8;--span:5\"><strong>Queue noise</strong><span>Low-value items occupy review order</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:12;--row:2;--span:5\"><strong>Wrong agent action</strong><span>Stale guidance drives implementation</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:12;--row:4;--span:5\"><strong>Repeated reviews</strong><span>The same file returns to the queue</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:12;--row:6;--span:5\"><strong>Slower iteration</strong><span>More time is spent rebuilding trust</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:12;--row:8;--span:5\"><strong>Missed important change</strong><span>Attention is spent on noise instead</span></article>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"negative\" style=\"--col:5;--row:2;--span:1\"><span>creates</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"negative\" style=\"--col:5;--row:4;--span:1\"><span>weakens</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"negative\" style=\"--col:5;--row:6;--span:1\"><span>causes</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"negative\" style=\"--col:5;--row:8;--span:1\"><span>adds</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:11;--row:2;--span:1\"><span>leads to</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:11;--row:4;--span:1\"><span>causes</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:11;--row:6;--span:1\"><span>slows</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:11;--row:8;--span:1\"><span>hides</span></div>\n    <aside class=\"cr-diagram-note\" data-tone=\"negative\" style=\"--col:12;--row:10;--span:5\">Reinforcing feedback: slow iteration encourages rushed corrections, which creates more duplicate sources.</aside>\n  </div>"
  },
  "branching-decision": {
    "title": "Branching decision",
    "purpose": "Which path should we choose?",
    "example": "<div class=\"cr-diagram cr-branching-decision\">\n    <details class=\"cr-diagram-node\" data-kind=\"decision\" style=\"--col:1;--row:5;--span:3\"><summary><strong>Does layout remove real cognitive work?</strong></summary><p>Count relationships, actors, branches, or boundaries that prose makes hard to retain.</p></details>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" style=\"--col:1;--row:9;--span:3\"><strong>Use Markdown</strong><span>Short prose or bullets</span></article>\n    <details class=\"cr-diagram-node\" data-kind=\"decision\" data-tone=\"warning\" style=\"--col:5;--row:5;--span:3\"><summary><strong>Are exact quantities the subject?</strong></summary><p>The numbers themselves must answer the reader's question.</p></details>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" data-tone=\"warning\" style=\"--col:5;--row:9;--span:3\"><strong>Use a data visual</strong><span>Chart, matrix, or scorecard</span></article>\n    <details class=\"cr-diagram-node\" data-kind=\"decision\" data-tone=\"positive\" style=\"--col:9;--row:5;--span:3\"><summary><strong>Which question must the map answer?</strong></summary><p>Choose the output by reasoning job, not visual preference.</p></details>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" data-tone=\"positive\" style=\"--col:14;--row:1;--span:3\"><strong>System landscape</strong><span>Parts, boundaries, exchanges</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" data-tone=\"positive\" style=\"--col:14;--row:3;--span:3\"><strong>Causal chain</strong><span>Causes, mechanisms, effects</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" data-tone=\"positive\" style=\"--col:14;--row:5;--span:3\"><strong>Branching decision</strong><span>Conditions and outcomes</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" data-tone=\"positive\" style=\"--col:14;--row:7;--span:3\"><strong>Actor sequence</strong><span>Order, ownership, handoffs</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"state\" data-tone=\"positive\" style=\"--col:14;--row:9;--span:3\"><strong>Reasoning map</strong><span>Claim, evidence, objection</span></article>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:4;--row:5;--span:1\"><span>yes</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-reverse=\"\" style=\"--col:2;--row:6;--rows:3\"><span>no</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:8;--row:5;--span:1\"><span>no</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-tone=\"warning\" style=\"--col:6;--row:6;--rows:3\"><span>yes</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-arrow=\"none\" data-tone=\"positive\" style=\"--col:12;--row:5;--span:2\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-arrow=\"none\" data-tone=\"positive\" style=\"--col:13;--row:1;--rows:9\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:13;--row:1;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:13;--row:3;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:13;--row:5;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:13;--row:7;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:13;--row:9;--span:1\"></div>\n  </div>"
  },
  "actor-sequence": {
    "title": "Actor sequence",
    "purpose": "Who acts, when, and where is the handoff?",
    "example": "<div class=\"cr-diagram cr-actor-sequence\">\n    <div class=\"cr-diagram-lane\" style=\"--col:1;--row:1;--span:16\">Agent</div>\n    <div class=\"cr-diagram-lane\" style=\"--col:1;--row:3;--span:16\">Context Room</div>\n    <div class=\"cr-diagram-lane\" style=\"--col:1;--row:5;--span:16\">Human</div>\n    <div class=\"cr-diagram-lane\" style=\"--col:1;--row:7;--span:16\">Project truth</div>\n    <article class=\"cr-diagram-node\" data-kind=\"store\" style=\"--col:3;--row:7;--span:2\"><strong>Current owner</strong><span>Canonical file</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:3;--row:1;--span:2\"><strong>1. Inspect truth</strong><span>Docs, code, config</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:6;--row:1;--span:2\"><strong>2. Edit owner</strong><span>Replace stale claim</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:9;--row:1;--span:2\"><strong>3. Request review</strong><span>Open via CLI</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"event\" style=\"--col:6;--row:3;--span:2\"><strong>Detect change</strong><span>Create queue item</span></article>\n    <details class=\"cr-diagram-node\" style=\"--col:9;--row:3;--span:2\"><summary><strong>Build proposal</strong><span>Trusted base + edit</span></summary><p>Only meaningful content changes enter the inline diff.</p></details>\n    <article class=\"cr-diagram-node\" style=\"--col:9;--row:5;--span:2\"><strong>4. Review</strong><span>Inspect proposal</span></article>\n    <details class=\"cr-diagram-node\" data-kind=\"decision\" data-tone=\"positive\" style=\"--col:12;--row:5;--span:2\"><summary><strong>5. Accept or reject</strong></summary><p>The decision updates the file or restores the trusted base.</p></details>\n    <article class=\"cr-diagram-node\" data-tone=\"positive\" style=\"--col:12;--row:7;--span:2\"><strong>Apply decision</strong><span>Write edit or restore base</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"store\" data-tone=\"positive\" style=\"--col:14;--row:3;--span:2\"><strong>Record trust</strong><span>After human decision</span></article>\n    <article class=\"cr-diagram-node\" data-kind=\"store\" style=\"--col:15;--row:7;--span:2\"><strong>Git history</strong><span>Preserve provenance</span></article>\n    <article class=\"cr-diagram-node\" style=\"--col:15;--row:5;--span:2\"><strong>6. Next review</strong><span>Continue queue</span></article>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:5;--row:1;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:8;--row:1;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" style=\"--col:7;--row:2;--rows:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" style=\"--col:10;--row:2;--rows:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" style=\"--col:10;--row:4;--rows:1\"><span>handoff</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:11;--row:5;--span:1\"></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-tone=\"positive\" style=\"--col:13;--row:6;--rows:1\"><span>decision</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-reverse=\"\" data-tone=\"positive\" style=\"--col:15;--row:4;--rows:1\"><span>trust</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" style=\"--col:14;--row:7;--span:1\"></div>\n  </div>"
  },
  "reasoning-map": {
    "title": "Reasoning map",
    "purpose": "What should we believe or decide?",
    "example": "<div class=\"cr-diagram cr-reasoning-map\">\n    <details class=\"cr-diagram-node\" data-role=\"claim\" style=\"--col:5;--row:1;--span:8\"><summary><strong>Claim</strong><span>HTML should visualize complex ideas, not decorate simple ones.</span></summary><p>The claim is useful only if the visual removes cognitive work that prose would leave to the reader.</p></details>\n    <article class=\"cr-diagram-node\" data-tone=\"positive\" style=\"--col:1;--row:2;--span:3\"><strong>Known fact</strong><span>Spatial grouping exposes several relationships at once.</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:14;--row:2;--span:3\"><strong>Open assumption</strong><span>Readers will explore rather than ignore the interaction.</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"positive\" style=\"--col:1;--row:5;--span:4\"><strong>Supporting evidence</strong><span>Five reusable models prevent one-off layout invention.</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"negative\" style=\"--col:14;--row:5;--span:3\"><strong>Strongest objection</strong><span>HTML adds source tokens and maintenance cost.</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:6;--row:5;--span:6\"><strong>Assessment</strong><span>Benefit depends on a real complexity threshold and reusable primitives.</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"positive\" style=\"--col:1;--row:9;--span:4\"><strong>Corroborating evidence</strong><span>Large maps remain bounded inside a scrollable viewport.</span></article>\n    <article class=\"cr-diagram-node\" data-tone=\"warning\" style=\"--col:14;--row:9;--span:3\"><strong>Constraint</strong><span>Meaning must remain accessible without scripts or hover.</span></article>\n    <details class=\"cr-diagram-node\" data-role=\"conclusion\" data-tone=\"positive\" style=\"--col:6;--row:9;--span:6\"><summary><strong>Conclusion</strong><span>Use one of five diagrams only above the threshold.</span></summary><p>Simple ideas stay in Markdown; exact quantities use the separate data catalog.</p></details>\n    <article class=\"cr-diagram-node\" data-tone=\"negative\" style=\"--col:14;--row:11;--span:3\"><strong>Residual risk</strong><span>An oversized map still needs splitting when crossings accumulate.</span></article>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-tone=\"warning\" style=\"--col:9;--row:2;--rows:3\"><span>test</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:5;--row:5;--span:1\"><span>supports</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-reverse=\"\" data-tone=\"negative\" style=\"--col:12;--row:5;--span:2\"><span>challenges</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-tone=\"positive\" style=\"--col:9;--row:6;--rows:3\"><span>therefore</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-tone=\"positive\" style=\"--col:5;--row:9;--span:1\"><span>confirms</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"h\" data-reverse=\"\" data-tone=\"warning\" style=\"--col:12;--row:9;--span:2\"><span>limits</span></div>\n    <div class=\"cr-diagram-edge\" data-dir=\"v\" data-tone=\"negative\" style=\"--col:15;--row:10;--rows:1\"><span>leaves</span></div>\n  </div>"
  }
});
