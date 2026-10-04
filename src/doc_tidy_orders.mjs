// Deterministic tidy orders: each documentation finding becomes a short instruction
// for the user's own agent. Context Room calls no model; the agent works in a change
// and a human reviews it.

export const JOURNAL_PATH = "docs/records/journal/YYYY-MM.md";

export const TIDY_SKILLS = Object.freeze({
  split: `---
name: doc-split
description: Split a documentation file that is too large for one agent read into documents by topic, without losing or rewriting text. Use for a Context Room doc_too_large finding.
---

# Split a document

1. Work only inside a Context Room change (\`context-room changes begin\`).
2. Read the headings first. Group sections by topic; each new document stays under 100,000 characters.
3. Move each section unchanged into its new document. Do not reword while moving.
4. Keep the current state and a short summary in the original document. Link each part from it.
5. Fix relative links in moved text, and inbound links from other documents.
6. List each new document in docs/index.md with one line: \`- [Title](path): one-sentence summary\`.
7. Submit the change (\`context-room changes submit\`). The review shows only removed and rewritten blocks. Never accept or reject files yourself.
`,
  merge: `---
name: doc-merge
description: Merge duplicated blocks so each text lives in one document and others link to it. Use for a Context Room duplicate_block finding.
---

# Merge duplicates

1. Work only inside a Context Room change (\`context-room changes begin\`).
2. Keep the block in the document that owns the topic (the first copy unless it clearly belongs elsewhere).
3. If the copies differ, keep the most recent correct wording in the owner and say so in the change summary.
4. Replace each other copy with one sentence and a link to the owner's section.
5. Check that every link resolves (\`context-room docs tidy\`).
6. Submit the change (\`context-room changes submit\`). Never accept or reject files yourself.
`,
  archive: `---
name: doc-archive
description: Move a log out of a state document into monthly journal files and keep the current state. Use for a Context Room log_in_state_doc finding.
---

# Archive a log

1. Work only inside a Context Room change (\`context-room changes begin\`).
2. Find dated entries, progress notes and reports in the state document.
3. Move them unchanged to ${JOURNAL_PATH}, one file per month, oldest first. Journal files are history: they grow and are not loaded by default.
4. Rewrite the state document as the current state only: what is true now, what is next. Link to the journal.
5. List the journal folder in docs/index.md under History.
6. Submit the change (\`context-room changes submit\`). The review shows moved blocks folded. Never accept or reject files yourself.
`,
});

const SUBMIT = "context-room changes submit. A human reviews each file. Do not accept or reject anything.";

function steps(finding) {
  const { path: file, line, evidence } = finding;
  switch (finding.type) {
    case "doc_too_large":
      return { skill: "split", task: `Split ${file} by topic`, files: [file, "docs/index.md"], steps: [
        `Follow context-room docs tidy --skill split: cut ${file} by topic into documents under 100,000 characters.`,
        `Keep the current state and a summary in ${file}; link each part. Move text unchanged.`,
        "List each new document in docs/index.md with one line.",
      ], expected: `${file} and each part under 100,000 characters; no block lost; 0 dead links.` };
    case "doc_not_in_map":
      return { skill: "", task: `List ${file} in docs/index.md`, files: [file, "docs/index.md"], steps: [
        `Add one line for ${file} to docs/index.md: - [Title](link): one-sentence summary.`,
        `If ${file} does not belong in docs/, move it with context-room docs move instead.`,
      ], expected: `docs tidy no longer reports ${file} outside the map.` };
    case "dead_link":
      return { skill: "", task: `Fix a dead link in ${file}`, files: [file], steps: [
        `In ${file} line ${line}, point ${evidence} to the existing file or heading (find it with context-room docs search).`,
        "If the target is gone, remove the link and keep its text.",
      ], expected: `0 dead links in ${file}.` };
    case "duplicate_block": {
      const owner = String(evidence).replace(/:\d+$/, "");
      return { skill: "merge", task: `Merge blocks duplicated between ${file} and ${owner}`, files: [file, owner], steps: [
        `Follow context-room docs tidy --skill merge: keep the text in ${owner}.`,
        `Replace the copy in ${file} (from line ${line}) with a link to it.`,
      ], expected: `One copy; docs tidy reports no duplicate between ${file} and ${owner}.` };
    }
    case "log_in_state_doc":
      return { skill: "archive", task: `Move the log out of ${file}`, files: [file, JOURNAL_PATH, "docs/index.md"], steps: [
        `Follow context-room docs tidy --skill archive: move dated entries from ${file} unchanged to ${JOURNAL_PATH}, one file per month.`,
        `Rewrite ${file} as the current state only, with a link to the journal.`,
        "List the journal in docs/index.md under History.",
      ], expected: `${file} holds the current state; each moved entry is unchanged in the journal.` };
    case "missing_summary":
      return { skill: "", task: `Add a summary to ${file}`, files: [file], steps: [
        `Add two or three sentences at the top of ${file}: what it holds and who reads it. Change nothing else.`,
      ], expected: `docs tidy reports no missing summary for ${file}.` };
    default:
      return null;
  }
}

// One order per finding, at most 15 lines. The id is stable for the same finding.
export function tidyOrder(finding) {
  const plan = steps(finding);
  if (!plan) return null;
  const id = `${finding.type}:${finding.path}:${finding.line}`;
  const numbered = [`context-room changes begin "${plan.task}". Edit only inside the returned directory.`, ...plan.steps, SUBMIT]
    .map((step, index) => `${index + 1}. ${step}`);
  const lines = [
    `Tidy order ${id}`,
    `Finding: ${finding.message}`,
    `Rule: ${finding.rule}`,
    `Files: ${plan.files.join(", ")}`,
    "Steps:",
    ...numbered,
    `Expected: ${plan.expected}`,
  ];
  return { id, type: finding.type, path: finding.path, skill: plan.skill || null, files: plan.files, expected: plan.expected, text: lines.join("\n") };
}
