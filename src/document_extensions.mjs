export const DOCUMENT_EXTENSION_SDK_VERSION = "context-room.document-extensions/1";

function normalizedExtensions(values = []) {
  return [...new Set((values || []).map((value) => String(value).trim().toLowerCase().replace(/^\./, "")).filter(Boolean))];
}

function assertDeclarativeDefinition(definition, kind, { allowFunctions = false } = {}) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new TypeError(`${kind} definition must be an object`);
  if (!definition.id || typeof definition.id !== "string") throw new TypeError(`${kind} definition requires an id`);
  if (!allowFunctions && Object.values(definition).some((value) => typeof value === "function")) throw new TypeError(`${kind} definitions from project or shared sources must be declarative`);
}

export class DocumentExtensionRegistry {
  constructor() {
    this.renderers = new Map();
    this.linkExtractors = new Map();
    this.viewers = new Map();
    this.healthRules = new Map();
    this.safeComponents = new Map();
  }

  registerRenderer(definition, { origin = "local", enabled = false } = {}) {
    assertDeclarativeDefinition(definition, "renderer");
    const executable = Boolean(definition.module || definition.command);
    if (executable && origin !== "local") throw new Error("Executable renderers can only be installed locally");
    const record = {
      schemaVersion: DOCUMENT_EXTENSION_SDK_VERSION,
      ...definition,
      formats: normalizedExtensions(definition.formats),
      capabilities: [...new Set(definition.capabilities || [])],
      origin,
      enabled: executable ? Boolean(enabled) : true,
      executable,
    };
    this.renderers.set(record.id, record);
    return record;
  }

  registerLinkExtractor(definition, options = {}) {
    assertDeclarativeDefinition(definition, "link extractor", { allowFunctions: options.origin === "local" });
    const executable = typeof definition.extract === "function";
    if (executable && options.origin !== "local") throw new Error("Executable link extractors can only be installed locally");
    const record = { schemaVersion: DOCUMENT_EXTENSION_SDK_VERSION, ...definition, origin: options.origin || "local", enabled: executable ? Boolean(options.enabled) : true };
    this.linkExtractors.set(record.id, record);
    return record;
  }

  registerViewer(definition, options = {}) {
    assertDeclarativeDefinition(definition, "viewer");
    const record = { schemaVersion: DOCUMENT_EXTENSION_SDK_VERSION, ...definition, formats: normalizedExtensions(definition.formats), origin: options.origin || "local" };
    this.viewers.set(record.id, record);
    return record;
  }

  rendererFor(filePath = "") {
    const extension = String(filePath).split(".").pop()?.toLowerCase() || "";
    return [...this.renderers.values()].find((renderer) => renderer.enabled && renderer.formats.includes(extension)) || null;
  }

  capabilities() {
    return {
      schemaVersion: DOCUMENT_EXTENSION_SDK_VERSION,
      renderers: [...this.renderers.values()],
      linkExtractors: [...this.linkExtractors.values()].map(({ extract: _extract, ...definition }) => definition),
      viewers: [...this.viewers.values()],
      healthRules: [...this.healthRules.values()],
      safeComponents: [...this.safeComponents.values()],
    };
  }
}

export function createDefaultDocumentExtensionRegistry() {
  const registry = new DocumentExtensionRegistry();
  registry.registerRenderer({
    id: "mermaid",
    title: "Mermaid",
    formats: ["mmd", "mermaid"],
    capabilities: ["render", "source", "split", "zoom", "links"],
    security: { network: false, scripts: false, externalLinks: false },
  }, { origin: "builtin", enabled: true });
  for (const [id, formats] of [["plantuml", ["puml", "plantuml"]], ["graphviz", ["dot", "gv"]], ["drawio", ["drawio"]]]) {
    registry.registerRenderer({ id, title: id === "graphviz" ? "Graphviz" : id === "drawio" ? "draw.io" : "PlantUML", formats, capabilities: ["source-fallback"], unavailable: true }, { origin: "builtin" });
  }
  return registry;
}
