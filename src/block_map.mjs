import crypto from "node:crypto";

const TEXT_PATH = /\.(?:md|mdx|markdown|txt)$/i;

function fingerprint(text) {
  const normalized = text.split("\n").map((line) => line.trimEnd()).join("\n").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// Markdown blocks: a heading alone, a fenced code block whole, anything else split on
// blank lines. Lines are 1-based in the source text.
export function markdownBlocks(text = "") {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let current = null, fence = null;
  const flush = () => { if (current) blocks.push(current); current = null; };
  lines.forEach((line, index) => {
    if (fence) {
      current.lines.push(line);
      if (fence.test(line)) { fence = null; flush(); }
      return;
    }
    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      flush();
      fence = new RegExp(`^\\s{0,3}\\${opening[1][0]}{${opening[1].length},}\\s*$`);
      current = { line: index + 1, lines: [line] };
      return;
    }
    if (!line.trim()) { flush(); return; }
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) { flush(); blocks.push({ line: index + 1, lines: [line] }); return; }
    current ||= { line: index + 1, lines: [] };
    current.lines.push(line);
  });
  flush();
  return blocks.map((block) => {
    const blockText = block.lines.join("\n");
    return { line: block.line, text: blockText, fingerprint: fingerprint(blockText) };
  });
}

// Compare every block of a proposal before and after, across all its text files. A block
// found again in the same file is unchanged; found in another file, it moved unchanged.
// What is left is removed (before only) or new or rewritten (after only). A matching
// fingerprint explains a move; it accepts nothing.
export function proposalBlockMap(files = []) {
  const compared = files.filter((file) => TEXT_PATH.test(file.path)
    && !String(file.before ?? "").includes("\0") && !String(file.after ?? "").includes("\0"));
  const remaining = new Map();
  for (const file of compared) {
    for (const block of markdownBlocks(file.before ?? "")) {
      if (!remaining.has(block.fingerprint)) remaining.set(block.fingerprint, []);
      remaining.get(block.fingerprint).push({ ...block, path: file.path });
    }
  }
  const results = compared.map((file) => ({ path: file.path, kind: file.kind, after: markdownBlocks(file.after ?? ""), unchanged: 0, movedFrom: new Map(), added: [], removed: [] }));
  const matched = new Set();
  for (const result of results) {
    result.after.forEach((block, index) => {
      const candidates = remaining.get(block.fingerprint) || [];
      const same = candidates.findIndex((candidate) => candidate.path === result.path);
      if (same < 0) return;
      candidates.splice(same, 1);
      result.unchanged += 1;
      matched.add(`${result.path}\0${index}`);
    });
  }
  for (const result of results) {
    result.after.forEach((block, index) => {
      if (matched.has(`${result.path}\0${index}`)) return;
      const source = (remaining.get(block.fingerprint) || []).shift();
      if (source) result.movedFrom.set(source.path, (result.movedFrom.get(source.path) || 0) + 1);
      else result.added.push({ line: block.line, text: block.text });
    });
  }
  const byPath = new Map(results.map((result) => [result.path, result]));
  for (const left of remaining.values()) {
    for (const block of left) byPath.get(block.path).removed.push({ line: block.line, text: block.text });
  }
  const output = results.map(({ after, movedFrom, ...result }) => ({
    ...result,
    removed: result.removed.sort((left, right) => left.line - right.line),
    moved: [...movedFrom].map(([from, blocks]) => ({ from, blocks })).sort((left, right) => left.from.localeCompare(right.from)),
  }));
  const sum = (pick) => output.reduce((total, result) => total + pick(result), 0);
  return {
    schemaVersion: "context-room.block-map/1",
    summary: {
      unchanged: sum((result) => result.unchanged),
      moved: sum((result) => result.moved.reduce((total, entry) => total + entry.blocks, 0)),
      added: sum((result) => result.added.length),
      removed: sum((result) => result.removed.length),
    },
    files: output,
    notCompared: files.filter((file) => !compared.includes(file)).map((file) => file.path),
  };
}
