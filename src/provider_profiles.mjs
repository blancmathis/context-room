const PROFILE_VERSION = "2026-07-30";

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
    }),
    evidence: Object.freeze([
      "https://developers.openai.com/codex/guides/agents-md",
      "https://developers.openai.com/codex/skills",
      "https://developers.openai.com/codex/config-reference",
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
    }),
    skills: Object.freeze({ global: Object.freeze(["~/.claude/skills"]), project: Object.freeze([".claude/skills"]), discovery: "nested-ancestor-chain" }),
    configuration: Object.freeze(["~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"]),
    hooks: Object.freeze(["~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"]),
    evidence: Object.freeze([
      "https://docs.anthropic.com/en/docs/claude-code/memory",
      "https://docs.anthropic.com/en/docs/claude-code/settings",
      "https://docs.anthropic.com/en/docs/claude-code/hooks",
      "https://docs.anthropic.com/en/docs/claude-code/skills",
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
    evidence: Object.freeze([
      "https://opencode.ai/docs/rules/",
      "https://opencode.ai/docs/skills/",
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/plugins/",
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
