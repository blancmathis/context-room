export const DOCUMENTATION_MAP_START = "<!-- context-room:docs-map -->";
export const DOCUMENTATION_MAP_END = "<!-- /context-room:docs-map -->";

// Replace the map block in place, or append it when the text has none.
export function withDocumentationMapBlock(text = "", block = "") {
  const source = String(text);
  const start = source.indexOf(DOCUMENTATION_MAP_START);
  const end = start === -1 ? -1 : source.indexOf(DOCUMENTATION_MAP_END, start);
  if (end !== -1) return source.slice(0, start) + block.trim() + source.slice(end + DOCUMENTATION_MAP_END.length);
  return (source.trimEnd() ? source.trimEnd() + "\n\n" : "") + block.trim() + "\n";
}
