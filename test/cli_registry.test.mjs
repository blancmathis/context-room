import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_COMMAND_REGISTRY,
  CLI_CAPABILITY_SECTIONS,
  CLI_PRIMARY_COMMANDS,
  CLI_PROFILE_COMMANDS,
  UI_CLI_PARITY_MATRIX,
  cliCapabilitiesFromRegistry,
  cliCommandArgumentNames,
  getCliCommand,
  listCliCommands,
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

test("registry exposes three primary commands without exposing human review decisions", () => {
  const paths = CLI_COMMAND_REGISTRY.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(Object.fromEntries(Object.entries(CLI_PROFILE_COMMANDS).map(([profile, commands]) => [profile, commands.length])), {
    worker: 1,
    editing: 2,
    admin: 21,
    expert: 12,
  });
  assert.deepEqual(listCliCommands({ installedOnly: true, include: "canonical" }).map((entry) => entry.path).sort(), [...new Set([...CLI_PRIMARY_COMMANDS, ...Object.values(CLI_PROFILE_COMMANDS).flat()])].sort());
  assert.equal(paths.some((path) => /(?:accept|reject|verify)/i.test(path)), false);
  assert.equal(getCliCommand("agent help").lifecycle, "removed");
  assert.equal(getCliCommand("agent instructions").lifecycle, "removed");
  assert.equal(getCliCommand("context graph").exposure, "internal");
  assert.equal(getCliCommand("guard").exposure, "internal");
  assert.equal(getCliCommand("project search").replacement, "project list --query");
  assert.equal(getCliCommand("settings apply").replacement, "settings set --apply");
  assert.equal(getCliCommand("shared propose").replacement, "edit");
  assert.equal(getCliCommand("shared publish").exposure, "internal");
  assert.equal(getCliCommand("docs publish").exposure, "internal");
  assert.equal(getCliCommand("install-hooks").replacement, "hooks sync");
  assert.ok(UI_CLI_PARITY_MATRIX.some((row) => row.classification === "human-decision-ui-only" && row.cli === null));

  const sectionCommands = Object.values(CLI_CAPABILITY_SECTIONS).flatMap((section) => section.commands);
  assert.equal(new Set(sectionCommands).size, sectionCommands.length);
  assert.deepEqual(sectionCommands.sort(), Object.values(CLI_PROFILE_COMMANDS).flat().filter((path) => !CLI_PRIMARY_COMMANDS.includes(path)).sort());
  for (const path of sectionCommands) assert.ok(getCliCommand(path).section, `${path} has no capability section`);
});

test("canonical commands expose unambiguous arguments", () => {
  for (const entry of listCliCommands({ installedOnly: true, include: "canonical" })) {
    const names = cliCommandArgumentNames(entry);
    assert.equal(new Set(names).size, names.length, `${entry.path} has duplicate arguments`);
  }
  for (const path of ["shared sync", "shared status"]) {
    const names = cliCommandArgumentNames(path);
    assert.ok(names.includes("--project"), path);
    assert.ok(names.includes("--location"), path);
  }
  assert.ok(cliCommandArgumentNames("shared connect").includes("--shared-project"));
  assert.ok(cliCommandArgumentNames("context ask").includes("--shared-project"));
});

test("shared-only selectors survive primary editing and agent prepare migration", () => {
  const sharedOnlySelectors = ["--repository", "--shared-project"];
  for (const path of ["edit", "agent prepare", "context bundle"]) {
    const names = cliCommandArgumentNames(path);
    for (const selector of sharedOnlySelectors) assert.ok(names.includes(selector), `${path} is missing ${selector}`);
  }
  assert.equal(getCliCommand("agent prepare").replacement, "context bundle");
});

test("capabilities expose the advanced catalog without choosing an operation", () => {
  const catalog = cliCapabilitiesFromRegistry({ version: "test" });
  assert.equal(catalog.schemaVersion, "context-room.cli/2");
  assert.equal(catalog.contractAudience, "ai-agent");
  assert.equal(catalog.profile, undefined);
  assert.equal(catalog.view, "sections");
  assert.deepEqual(catalog.primaryCommands.map((entry) => entry.path), ["ask", "edit"]);
  assert.deepEqual(catalog.sections.map((entry) => entry.id), ["documentation", "context", "review", "shared", "workspace", "configuration"]);
  assert.equal(catalog.humanDecisionPolicy.confirmationsRequired, 2);
  assert.match(catalog.humanDecisionPolicy.instruction, /second separate, unambiguous yes/i);
  assert.equal(Object.hasOwn(catalog, "commands"), false);

  const editing = cliCapabilitiesFromRegistry({ version: "test", profile: "editing" });
  assert.deepEqual(editing.commands.map((entry) => entry.path), ["ask", "edit"]);
  assert.equal(editing.humanDecisionPolicy.confirmationsRequired, 2);

  const admin = cliCapabilitiesFromRegistry({ version: "test", profile: "admin" });
  const expert = cliCapabilitiesFromRegistry({ version: "test", profile: "expert" });
  assert.equal(admin.commands.length, 21);
  assert.equal(expert.commands.length, 12);

  const standard = cliCapabilitiesFromRegistry({ version: "test", profile: "admin", detail: "standard" });
  assert.deepEqual(standard.outputFormats, ["human", "json"]);

  const expanded = cliCapabilitiesFromRegistry({ version: "test", expand: true, detail: "full" });
  assert.equal(expanded.view, "expanded");
  assert.equal(expanded.commands.some((entry) => entry.path === "agent prepare" && entry.replacement === "context bundle"), true);
  assert.equal(expanded.commands.some((entry) => entry.path === "context graph" && entry.exposure === "internal"), true);
  assert.equal(expanded.commands.find((entry) => entry.path === "agent handoff").handlerKey, "agent.handoff");

  const exact = cliCapabilitiesFromRegistry({ version: "test", command: "watch set" });
  assert.equal(exact.view, "command");
  assert.equal(exact.detail, "standard");
  assert.deepEqual(exact.commands.map((entry) => entry.path), ["watch set"]);
  assert.equal(cliCommandArgumentNames(exact.commands[0]).includes("--apply"), false);
  assert.match(exact.commands[0].usage, /^context-room watch set/);
  assert.equal(exact.commands[0].authority, "local-reversible");

  const docs = cliCapabilitiesFromRegistry({ version: "test", namespace: "docs" });
  assert.equal(docs.view, "namespace");
  assert.deepEqual(docs.commands.map((entry) => entry.path), ["docs search", "docs inspect"]);

  const review = cliCapabilitiesFromRegistry({ version: "test", namespace: "review" });
  assert.equal(review.view, "section");
  assert.deepEqual(review.commands.map((entry) => entry.path), CLI_CAPABILITY_SECTIONS.review.commands);

  assert.throws(() => cliCapabilitiesFromRegistry({ version: "test", command: "docs publish" }), /Unknown capability command/);
  assert.equal(cliCapabilitiesFromRegistry({ version: "test", command: "docs publish", expand: true }).commands[0].path, "docs publish");
  assert.equal(cliCapabilitiesFromRegistry({ version: "test", command: "shared skills assign" }).commands[0].path, "shared skills assign");
});

test("capabilities remain a static inventory without automatic command selection", () => {
  const capabilities = cliCapabilitiesFromRegistry({ version: "test" });
  assert.equal(Object.hasOwn(capabilities, "discovery"), false);
  assert.equal(Object.hasOwn(capabilities, "selected"), false);
  assert.equal(capabilities.sections.some((entry) => Object.hasOwn(entry, "intents")), false);
});

test("help exposes only ask, edit, and capabilities at the root", () => {
  const help = renderCliHelpFromRegistry();
  assert.match(help, /context-room ask <research-brief>/);
  assert.doesNotMatch(help, /context-room ask <task>/);
  assert.match(help, /context-room edit <action> \[value\]/);
  assert.match(help, /context-room capabilities/);
  assert.doesNotMatch(help, /context-room docs edit/);
  assert.doesNotMatch(help, /context-room docs publish/);
  assert.doesNotMatch(help, /context-room shared propose/);
  assert.match(help, /--help --all/);

  const allHelp = renderCliHelpFromRegistry({ all: true });
  for (const command of ["edit", "project show", "shared assign", "context effective", "hub status"]) assert.match(allHelp, new RegExp(`context-room ${command.replace(" ", "\\s+")}`));
  for (const hidden of ["agent prepare", "shared propose", "settings apply", "context graph"]) assert.doesNotMatch(allHelp, new RegExp(`context-room ${hidden.replace(" ", "\\s+")}`));

  const docsHelp = renderCliHelpFromRegistry({ namespace: "docs" });
  assert.match(docsHelp, /context-room docs inspect/);
  assert.doesNotMatch(docsHelp, /context-room docs edit/);
  assert.doesNotMatch(docsHelp, /context-room docs publish/);
  assert.doesNotMatch(docsHelp, /context-room docs metadata/);

  for (const shell of ["zsh", "bash", "fish"]) {
    const completion = renderCliCompletionFromRegistry(shell);
    assert.match(completion, /context-room/);
    assert.match(completion, /project/);
    assert.doesNotMatch(completion, /agent prepare|agent\.prepare/);
  }
});

test("legacy cli_contract exports delegate to the registry projection", () => {
  assert.equal(CLI_COMMANDS, CLI_COMMAND_REGISTRY);
  assert.deepEqual(cliCapabilities({ version: "test" }), cliCapabilitiesFromRegistry({ version: "test" }));
  assert.equal(renderCliHelp(), renderCliHelpFromRegistry());
  for (const shell of ["zsh", "bash", "fish"]) assert.equal(renderCliCompletion(shell), renderCliCompletionFromRegistry(shell));
});

test("canonical effects use direct, dry-run, or same-path protected apply", () => {
  const effects = new Map([
    ["ask", "none"],
    ["ui open", "ephemeral"],
    ["project register", "reversible-local"],
    ["edit", "proposal-only"],
    ["watch set", "reversible-local"],
    ["settings set", "protected"],
  ]);
  for (const [path, effect] of effects) assert.equal(getCliCommand(path).effect, effect, path);
  assert.equal(getCliCommand("watch set").arguments.some((argument) => argument.name === "--plan"), false);
  assert.equal(getCliCommand("settings set").arguments.some((argument) => argument.name === "--plan"), false);
  assert.equal(getCliCommand("docs publish").humanDecision, "file-review-remains-human");
});

test("parity validator accepts aligned evidence", () => {
  const result = validateCliParity({
    dispatcherCommands: [
      { path: "docs edit", mutates: true, arguments: ["--task", "--project"] },
      { path: "docs publish", mutates: true, arguments: ["--change"] },
    ],
    capabilityCommands: ["docs edit", "docs publish"],
    completionCommands: ["docs edit", "docs publish"],
    documentedArguments: { "docs edit": ["--task", "--project", "--format"] },
    documentationExamples: ["context-room docs edit --task test", "$ context-room docs publish --change change-1"],
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
    documentedArguments: { "agent prepare": ["--fictional"], "missing command": ["--root"] },
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
