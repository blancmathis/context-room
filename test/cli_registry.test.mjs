import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_COMMAND_REGISTRY,
  UI_CLI_PARITY_MATRIX,
  cliCapabilitiesFromRegistry,
  cliCommandArgumentNames,
  getCliCommand,
  renderCliCompletionFromRegistry,
  renderCliHelpFromRegistry,
  validateCliParity,
} from "../src/cli_registry.mjs";
import {
  CLI_COMMANDS,
  cliCapabilities,
  renderCliCompletion,
  renderCliHelp,
} from "../src/cli_contract.mjs";

test("registry describes current and accepted Context Engine commands without review decisions", () => {
  const paths = CLI_COMMAND_REGISTRY.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const expected of [
    "context effective",
    "context graph",
    "context trace",
    "context impact",
    "context snapshot",
    "context diff",
    "proposal context-impact",
    "settings get",
    "settings explain",
    "settings plan",
    "settings apply",
  ]) assert.ok(getCliCommand(expected), expected);
  assert.equal(paths.some((path) => /(?:accept|reject|verify)/i.test(path)), false);
  for (const removed of [
    "resolve",
    "agent environment",
    "agent explain",
    "agent queue",
    "agent review-queue",
    "brief",
    "docs capabilities",
    "review follow",
    "events",
    "hub start",
    "hub status",
    "agent navigate",
    "shared connect",
    "shared list",
    "shared proposal-create",
    "shared proposal-push",
    "install-hook",
  ]) assert.equal(getCliCommand(removed), null, removed);
  assert.ok(UI_CLI_PARITY_MATRIX.some((row) => row.classification === "human-decision-ui-only" && row.cli === null));
});

test("capabilities expose installed Context Engine commands and preserve complete metadata", () => {
  const capabilities = cliCapabilitiesFromRegistry({ version: "test" });
  assert.equal(capabilities.schemaVersion, "context-room.cli/1");
  assert.equal(capabilities.registrySchemaVersion, "context-room.cli-registry/2");
  assert.equal(capabilities.contractAudience, "ai-agent");
  assert.equal(capabilities.commands.some((entry) => entry.path === "context effective"), true);
  assert.equal(capabilities.commands.some((entry) => entry.path === "agent environment"), false);
  const command = capabilities.commands.find((entry) => entry.path === "agent handoff");
  assert.equal(command.mutates, true);
  assert.equal(command.protocol, "preview-apply");
  assert.equal(command.handlerKey, "agent.handoff");
  assert.ok(cliCommandArgumentNames(command).includes("--apply"));
  assert.equal(command.authority, "shared-proposal");

  const selected = cliCapabilitiesFromRegistry({ installedPaths: ["context effective", "settings apply"] });
  assert.deepEqual(selected.commands.map((entry) => entry.path), ["context effective", "settings apply"]);
});

test("capabilities remain a static inventory without automatic command selection", () => {
  const capabilities = cliCapabilitiesFromRegistry({ version: "test" });
  assert.equal(Object.hasOwn(capabilities, "discovery"), false);
  assert.equal(Object.hasOwn(capabilities, "selected"), false);
  assert.equal(capabilities.commands.some((entry) => Object.hasOwn(entry, "intents")), false);
});

test("help and completions are generated from the same installed registry projection", () => {
  const help = renderCliHelpFromRegistry();
  assert.match(help, /context-room agent prepare/);
  assert.match(help, /context-room agent state/);
  assert.match(help, /context-room context effective/);
  assert.doesNotMatch(help, /^\s{4}agent state/m);
  for (const shell of ["zsh", "bash", "fish"]) {
    const completion = renderCliCompletionFromRegistry(shell);
    assert.match(completion, /context-room/);
    assert.match(completion, /agent/);
    assert.match(completion, /--project|['"]project['"]/);
  }
});

test("legacy cli_contract exports delegate to the registry projection", () => {
  assert.equal(CLI_COMMANDS, CLI_COMMAND_REGISTRY);
  assert.deepEqual(cliCapabilities({ version: "test" }).commands, cliCapabilitiesFromRegistry({ version: "test" }).commands);
  assert.equal(renderCliHelp(), renderCliHelpFromRegistry());
  for (const shell of ["zsh", "bash", "fish"]) {
    assert.equal(renderCliCompletion(shell), renderCliCompletionFromRegistry(shell));
  }
});

test("installed Context Engine mutation contracts are explicit and human review remains unavailable", () => {
  const mutations = new Map([
    ["settings plan", false],
    ["settings apply", true],
    ["shared skills assign", true],
    ["shared skills unassign", true],
    ["shared skills import", true],
    ["shared skills link", true],
    ["shared skills unlink", true],
    ["shared skills reconcile", true],
    ["shared skills override", true],
  ]);
  for (const [path, mutates] of mutations) {
    const entry = getCliCommand(path);
    assert.equal(entry.lifecycle, "current", path);
    assert.equal(entry.mutates, mutates, path);
  }
  for (const path of [
    "context effective",
    "context graph",
    "context trace",
    "context impact",
    "context snapshot",
    "context diff",
    "proposal context-impact",
    "doctor explain",
    "doctor plan",
  ]) {
    const entry = getCliCommand(path);
    assert.equal(entry.lifecycle, "current", path);
    assert.equal(entry.mutates, false, path);
  }
});

test("parity validator accepts aligned evidence", () => {
  const result = validateCliParity({
    dispatcherCommands: [
      { path: "agent prepare", mutates: false, arguments: ["--task", "--project"] },
      { path: "agent handoff", mutates: true, arguments: ["--task", "--apply"] },
    ],
    capabilityCommands: ["agent prepare", "agent handoff"],
    completionCommands: ["agent prepare", "agent handoff"],
    documentedArguments: { "agent prepare": ["--task", "--format"] },
    documentationExamples: ["context-room agent prepare --task test", "$ context-room agent handoff --task test"],
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("parity validator reports dispatcher, capability, argument, completion, mutation, and documentation drift", () => {
  const result = validateCliParity({
    dispatcherCommands: [
      { path: "agent prepare", mutates: true, arguments: ["--invented"] },
      { path: "invented command", mutates: false },
    ],
    capabilityCommands: ["agent prepare", "context graph", "invented capability"],
    completionCommands: [],
    documentedArguments: {
      "agent prepare": ["--fictional"],
      "missing command": ["--root"],
    },
    documentationExamples: ["context-room gone forever --root ."],
  });
  const codes = new Set(result.errors.map((error) => error.code));
  assert.equal(result.ok, false);
  for (const code of [
    "dispatcher-command-unregistered",
    "dispatcher-command-missing-completion",
    "dispatcher-mutation-mismatch",
    "dispatcher-argument-unregistered",
    "capability-command-not-dispatched",
    "capability-command-unregistered",
    "documented-argument-not-accepted",
    "documented-command-unregistered",
    "documentation-example-obsolete",
  ]) assert.ok(codes.has(code), code);
});
