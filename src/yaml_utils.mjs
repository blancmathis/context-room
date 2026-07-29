export function stringifyYaml(value, indent = 0) {
  return Object.entries(value || {}).map(([key, item]) => yamlLine(key, item, indent)).join("");
}

function yamlLine(key, value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) return `${pad}${key}: [${value.map(yamlScalar).join(", ")}]\n`;
  if (value && typeof value === "object") return `${pad}${key}:\n${stringifyYaml(value, indent + 2)}`;
  return `${pad}${key}: ${yamlScalar(value)}\n`;
}

export function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value ?? "");
  if (!text || /[:#\[\]{},&*?|>'"%@`\n]|^[-?]|\s$|^\s/.test(text)) return JSON.stringify(text);
  return text;
}

export function parseSimpleYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = String(source || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    const listMatch = raw.trim().match(/^-\s+(.+)$/);
    if (listMatch) {
      while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
      const parent = stack.at(-1).value;
      if (!Array.isArray(parent)) throw new Error(`Unsupported YAML list: ${raw}`);
      parent.push(parseYamlScalar(listMatch[1]));
      continue;
    }
    const match = raw.trim().match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) throw new Error(`Unsupported YAML: ${raw}`);
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    const key = match[1];
    const rest = match[2] ?? "";
    if (rest === "") {
      const nextLine = lines.slice(lineIndex + 1).find((line) => line.trim() && !line.trim().startsWith("#"));
      const nextIndent = nextLine ? nextLine.match(/^ */)[0].length : -1;
      parent[key] = nextLine && nextIndent > indent && /^\s*-\s+/.test(nextLine) ? [] : {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseYamlScalar(rest);
    }
  }
  return root;
}

function parseYamlScalar(raw) {
  const text = String(raw || "").trim();
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineArray(inner).map(parseYamlScalar);
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
}

function splitInlineArray(text) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}
