const PROFILE_VERSION = "2026-10-04";

export const CLAUDE_INSTRUCTION_MODES = Object.freeze(["claude-md", "claude-md-or-agents-md", "claude-md-and-agents-md", "managed-only"]);

const PROFILES = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    version: PROFILE_VERSION,
    instructions: Object.freeze({
      globalFiles: Object.freeze(["AGENTS.override.md", "AGENTS.md"]),
      projectFiles: Object.freeze(["AGENTS.override.md", "AGENTS.md"]),
      deviceRoot: "~/.codex",
      nativeTargets: Object.freeze(["AGENTS.override.md", "AGENTS.md"]),
      configuredTargets: "codex-project-doc-fallback-filenames",
      order: "global-then-root-to-folder",
      onePerDirectory: true,
      overrideFile: "AGENTS.override.md",
      precedence: "documented",
    }),
    skills: Object.freeze({
      global: Object.freeze(["~/.agents/skills"]),
      project: Object.freeze([".agents/skills"]),
      admin: Object.freeze(["/etc/codex/skills"]),
      discovery: "cwd-to-repository-root",
      precedence: "documented-discovery-order-only",
    }),
    configuration: Object.freeze(["~/.codex/config.toml", ".codex/config.toml"]),
    hooks: Object.freeze({
      sources: Object.freeze(["~/.codex/hooks.json", ".codex/hooks.json", "config.toml:inline-hooks"]),
      activation: "active-config-layers-and-feature-gate",
      precedence: "uncertain-unless-active-config-proven",
      contextEvents: Object.freeze(["SessionStart", "UserPromptSubmit"]),
    }),
    mcp: Object.freeze([
      Object.freeze({ path: "~/.codex/config.toml", format: "toml", key: "mcp_servers" }),
      Object.freeze({ path: ".codex/config.toml", format: "toml", key: "mcp_servers" }),
    ]),
    verified: Object.freeze({ through: "", on: PROFILE_VERSION, method: "documentation" }),
    evidence: Object.freeze([
      "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
      "https://learn.chatgpt.com/docs/build-skills",
      "https://learn.chatgpt.com/docs/config-file/config-reference",
      "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    ]),
  }),
  "claude-code": Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    version: PROFILE_VERSION,
    instructions: Object.freeze({
      globalFiles: Object.freeze(["CLAUDE.md"]),
      projectFiles: Object.freeze(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]),
      deviceRoot: "~/.claude",
      nativeTargets: Object.freeze(["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**/*.md"]),
      configuredTargets: "claude-memory-imports-and-rules",
      order: "managed-then-user-then-project-ancestors-with-nested-lazy-loading",
      onePerDirectory: false,
      overrideFile: "",
      concatenates: Object.freeze(["CLAUDE.md", "CLAUDE.local.md"]),
      precedence: "closer-sources-load-later-but-conflict-resolution-is-uncertain",
      rules: Object.freeze({ global: "~/.claude/rules", project: ".claude/rules", conditional: "paths-frontmatter" }),
      agentsFallback: Object.freeze({
        files: Object.freeze(["AGENTS.md", ".claude/AGENTS.md"]),
        blockedBy: Object.freeze(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]),
        since: "2.1.277",
        setting: 'pluginConfigs["agents-md@builtin"].options.instructionFiles',
        legacySetting: 'pluginConfigs["agents-md@builtin"].options.projectInstructions',
        defaultMode: "claude-md-or-agents-md",
        modes: CLAUDE_INSTRUCTION_MODES,
      }),
    }),
    skills: Object.freeze({ global: Object.freeze(["~/.claude/skills"]), project: Object.freeze([".claude/skills"]), discovery: "nested-ancestor-chain" }),
    configuration: Object.freeze(["~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"]),
    hooks: Object.freeze({
      sources: Object.freeze(["~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"]),
      contextEvents: Object.freeze(["SessionStart", "UserPromptSubmit"]),
    }),
    mcp: Object.freeze([
      Object.freeze({ path: "~/.claude.json", format: "json", key: "mcpServers", projectKey: "projects" }),
      Object.freeze({ path: ".mcp.json", format: "json", key: "mcpServers" }),
    ]),
    verified: Object.freeze({ through: "2.1.289", on: PROFILE_VERSION, method: "runtime-source" }),
    evidence: Object.freeze([
      "https://code.claude.com/docs/en/memory",
      "https://code.claude.com/docs/en/settings",
      "https://code.claude.com/docs/en/hooks",
      "https://code.claude.com/docs/en/skills",
      "https://code.claude.com/docs/en/mcp",
    ]),
  }),
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    version: PROFILE_VERSION,
    instructions: Object.freeze({
      globalFiles: Object.freeze(["AGENTS.md"]),
      projectFiles: Object.freeze(["AGENTS.md", "CLAUDE.md"]),
      deviceRoot: "~/.config/opencode",
      nativeTargets: Object.freeze(["AGENTS.md", "CLAUDE.md"]),
      configuredTargets: "opencode-instructions",
      order: "global-then-project-ancestors-first-matching-rule-file",
      onePerDirectory: true,
      overrideFile: "",
      precedence: "first-match-per-level-documented; conflicting-content-resolution-uncertain",
    }),
    skills: Object.freeze({
      global: Object.freeze(["~/.config/opencode/skills", "~/.claude/skills", "~/.agents/skills"]),
      project: Object.freeze([".opencode/skills", ".claude/skills", ".agents/skills"]),
      discovery: "cwd-to-git-worktree",
      precedence: "uncertain-on-duplicate-names-unless-runtime-reports-source",
    }),
    configuration: Object.freeze(["~/.config/opencode/opencode.json", "opencode.json", "opencode.jsonc", ".opencode"]),
    hooks: Object.freeze(["~/.config/opencode/plugins", ".opencode/plugins"]),
    mcp: Object.freeze([
      Object.freeze({ path: "~/.config/opencode/opencode.json", format: "json", key: "mcp" }),
      Object.freeze({ path: "opencode.json", format: "json", key: "mcp" }),
    ]),
    verified: Object.freeze({ through: "", on: PROFILE_VERSION, method: "documentation" }),
    evidence: Object.freeze([
      "https://opencode.ai/docs/rules/",
      "https://opencode.ai/docs/skills/",
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/plugins/",
      "https://opencode.ai/docs/mcp-servers/",
    ]),
  }),
});

export const CONTEXT_PROVIDER_PROFILE_VERSION = PROFILE_VERSION;

export function listContextProviderProfiles() {
  return Object.values(PROFILES);
}

export function contextProviderProfile(provider) {
  const id = String(provider || "").trim().toLowerCase();
  const profile = PROFILES[id];
  if (!profile) throw new Error(`Unsupported context provider: ${provider || "(empty)"}`);
  return profile;
}

export function isContextProvider(provider) {
  return Boolean(PROFILES[String(provider || "").trim().toLowerCase()]);
}

/** Compare dotted numeric versions; an empty or malformed version is unknown (null). */
export function compareProviderVersions(left, right) {
  const parse = (value) => /^\d+(?:\.\d+)*$/.test(String(value || "")) ? String(value).split(".").map(Number) : null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/**
 * Resolve the Claude Code agents-md mode the way the built-in plugin does:
 * instructionFiles wins unless it is absent or default and the legacy
 * projectInstructions option is set.
 */
export function claudeInstructionMode(options = {}) {
  const legacyModes = { none: "managed-only", claude: "claude-md", "agents-fallback": "claude-md-or-agents-md", both: "claude-md-and-agents-md" };
  const fallback = PROFILES["claude-code"].instructions.agentsFallback.defaultMode;
  const mode = CLAUDE_INSTRUCTION_MODES.find((item) => item === options.instructionFiles) || fallback;
  const legacy = options.projectInstructions === undefined ? undefined : (typeof options.projectInstructions === "string" && legacyModes[options.projectInstructions]) || "claude-md";
  return legacy !== undefined && mode === fallback ? legacy : mode;
}
