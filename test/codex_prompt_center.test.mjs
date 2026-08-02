import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import {
  CODEX_PROMPT_HIGH_CONTEXT_CONFIRM_TOKENS,
  CODEX_PROMPT_PUBLICATION_STATE_VERSION,
  CODEX_PROMPT_RESTART_MESSAGE,
  MAX_CODEX_PROMPT_BYTES,
  MAX_CODEX_PROMPT_ESTIMATED_TOKENS,
  MAX_CODEX_PROMPT_MANIFEST_BYTES,
  MAX_CODEX_PROMPT_REQUEST_BYTES,
  applyCodexPromptPatches,
  codexPromptDarwinIdentityHelperSourceForTest,
  computeCodexPromptCatalogRevision,
  createCodexPromptCenterProvider as createRawCodexPromptCenterProvider,
  createCodexPromptPatches,
  estimateCodexPromptTokens,
  normalizeCodexPromptCatalog,
  readCodexPromptRuntimeReceipts as readRawCodexPromptRuntimeReceipts,
  secureAtomicWritePromptState,
} from "../src/codex_prompt_center.mjs";
import {
  contextRoomWebAssetBundle,
  createMemoryServer,
  initializeContextRoomProject,
  renderAppHtml,
} from "../src/context_room.mjs";

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const FIXTURE_BOOT_SESSION_UUID = "01234567-89ab-cdef-8123-456789abcdef";

function fixtureProcessStartIdentity(pid) {
  return `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:${pid}:000000`;
}

function readCodexPromptRuntimeReceipts(options = {}) {
  return readRawCodexPromptRuntimeReceipts({
    ...options,
    getRuntimeProcessStartIdentity: options.getRuntimeProcessStartIdentity
      || fixtureProcessStartIdentity,
  });
}

function logicalCatalogRevision(catalog) {
  return computeCodexPromptCatalogRevision(catalog);
}

function strictCatalogTarget(rawTarget) {
  const officialText = Object.hasOwn(rawTarget, "officialText") ? rawTarget.officialText : null;
  const effectiveText = Object.hasOwn(rawTarget, "effectiveText") ? rawTarget.effectiveText : officialText;
  const editable = rawTarget.editable === true;
  return {
    id: rawTarget.id,
    label: rawTarget.label,
    kind: rawTarget.kind || "collaboration",
    editable,
    runtimeStatus: rawTarget.runtimeStatus || (editable ? "active" : "protected"),
    officialHash: Object.hasOwn(rawTarget, "officialHash")
      ? rawTarget.officialHash
      : typeof officialText === "string" ? hash(officialText) : null,
    officialText,
    effectiveHash: Object.hasOwn(rawTarget, "effectiveHash")
      ? rawTarget.effectiveHash
      : typeof effectiveText === "string" ? hash(effectiveText) : null,
    effectiveText,
    targetPattern: rawTarget.targetPattern ?? null,
    sourceTargetId: rawTarget.sourceTargetId ?? null,
    readOnlyReason: rawTarget.readOnlyReason ?? (editable ? null : "Read-only fixture."),
    overrideStrategy: Object.hasOwn(rawTarget, "overrideStrategy")
      ? rawTarget.overrideStrategy
      : editable ? (officialText === "" ? "replacement" : "patch") : null,
    overrideConflict: rawTarget.overrideConflict ?? null,
    source: rawTarget.source ?? "fixture",
    securityClass: rawTarget.securityClass ?? (editable ? "local_user_editable" : "dynamic_assembly"),
  };
}

function finalizeCatalog(rawCatalog) {
  const catalog = {
    schemaVersion: rawCatalog.schemaVersion,
    runtimeVersion: rawCatalog.runtimeVersion ?? "fixture",
    catalogRevision: "",
    groups: (rawCatalog.groups || []).map((group) => ({
      id: group.id,
      label: group.label,
      targets: (group.targets || []).map(strictCatalogTarget),
    })),
  };
  catalog.catalogRevision = logicalCatalogRevision(catalog);
  return catalog;
}

function createCodexPromptCenterProvider(options = {}) {
  return createRawCodexPromptCenterProvider({
    ...options,
    getRuntimeProcessStartIdentity: options.getRuntimeProcessStartIdentity
      || fixtureProcessStartIdentity,
    ...(options.catalog?.schemaVersion === 1
      ? { catalog: finalizeCatalog(options.catalog) }
      : {}),
  });
}

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.resolve("schemas", name), "utf8"));
}

function assertStrictSchemaShape(schema, value, label, { optionalKeys = [] } = {}) {
  assert.equal(schema.type, "object", `${label} must be an object schema`);
  assert.equal(schema.additionalProperties, false, `${label} must reject unknown fields`);
  const allowedKeys = new Set([...schema.required, ...optionalKeys]);
  assert.deepEqual(
    Object.keys(value).filter((key) => !allowedKeys.has(key)),
    [],
    `${label} fixture keys must be required or explicitly optional`,
  );
  assert.deepEqual(
    schema.required.filter((key) => !Object.hasOwn(value, key)),
    [],
    `${label} fixture must contain every required key`,
  );
}

function fixtureCatalog() {
  const editableOfficial = [
    "# Synthetic behavior",
    "",
    "Keep {{SYNTHETIC_TOKEN}} intact.",
    "Use the supplied synthetic evidence.",
    "",
  ].join("\n");
  const catalog = finalizeCatalog({
    schemaVersion: 1,
    runtimeVersion: "test-runtime",
    catalogRevision: "",
    groups: [
      {
        id: "synthetic-modes",
        label: "Synthetic modes",
        targets: [
          {
            id: "synthetic/mode/unknown-to-ui",
            label: "Unknown synthetic mode",
            kind: "collaboration",
            editable: true,
            runtimeStatus: "selectable",
            securityClass: "local_user_editable",
            source: "fixture",
            officialText: editableOfficial,
            effectiveText: editableOfficial,
            officialHash: hash(editableOfficial),
            targetPattern: null,
            sourceTargetId: null,
            readOnlyReason: null,
            overrideStrategy: "patch",
            overrideConflict: null,
          },
        ],
      },
      {
        id: "synthetic-contracts",
        label: "Synthetic contracts",
        targets: [
          {
            id: "synthetic/contract/read-only",
            label: "Read-only synthetic contract",
            kind: "protected",
            editable: false,
            runtimeStatus: "protected",
            readOnlyReason: "The synthetic output schema is fixed.",
            officialText: null,
            effectiveText: null,
            officialHash: null,
            effectiveHash: null,
            targetPattern: null,
            sourceTargetId: null,
            overrideStrategy: null,
            overrideConflict: null,
            source: "fixture",
            securityClass: "security_critical",
          },
        ],
      },
    ],
  });
  return catalog;
}

function makeStorage(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-codex-prompts-"));
  const storageRoot = path.join(base, "prompt-overrides");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return storageRoot;
}

function writePromptLockFixture(storageRoot, {
  pid = process.pid,
  token = "a".repeat(32),
  processStartedAtUnixMs = 0,
} = {}) {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(storageRoot, 0o700);
  const lockPath = path.join(storageRoot, ".context-room-write.lock");
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid, token, processStartedAtUnixMs })}\n`,
    { mode: 0o600 },
  );
  return lockPath;
}

function writeRuntimeFixture(storageRoot, {
  pid,
  publicationGeneration = null,
  processStartIdentity = fixtureProcessStartIdentity(pid),
  catalog = fixtureCatalog(),
  loadedAtUnixMs = pid,
  runtimeVersion = null,
  manifestRevision = 0,
  manifestHash = null,
  activeOverrides = [],
  receiptOverrides = {},
} = {}) {
  const runtimePath = path.join(storageRoot, "runtime");
  const publicationStatePath = path.join(storageRoot, ".publication-state.json");
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(storageRoot, 0o700);
  fs.mkdirSync(runtimePath, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimePath, 0o700);
  const runtimeCatalog = finalizeCatalog(catalog);
  const snapshotBytes = `${JSON.stringify(runtimeCatalog, null, 2)}\n`;
  const catalogHash = hash(snapshotBytes);
  const catalogFile = `${pid}.${catalogHash.slice("sha256:".length)}.catalog.json`;
  const publicationState = fs.existsSync(publicationStatePath)
    ? JSON.parse(fs.readFileSync(publicationStatePath, "utf8"))
    : {
        schemaVersion: CODEX_PROMPT_PUBLICATION_STATE_VERSION,
        nextGeneration: 1,
        globalOwnerGeneration: 0,
        runtimeRegistryGenerations: {},
        runtimeOwnerGenerations: {},
      };
  const pidKey = String(pid);
  if (!Object.hasOwn(publicationState.runtimeRegistryGenerations, pidKey)) {
    publicationState.runtimeRegistryGenerations[pidKey] = publicationState.nextGeneration;
    publicationState.nextGeneration += 1;
  }
  const resolvedPublicationGeneration = publicationGeneration ?? publicationState.nextGeneration;
  publicationState.nextGeneration = Math.max(
    publicationState.nextGeneration,
    resolvedPublicationGeneration + 1,
  );
  publicationState.runtimeOwnerGenerations[pidKey] = resolvedPublicationGeneration;
  secureAtomicWritePromptState(path.join(runtimePath, catalogFile), runtimeCatalog);
  const receipt = {
    schemaVersion: 2,
    pid,
    publicationGeneration: resolvedPublicationGeneration,
    processStartIdentity,
    loadedAtUnixMs,
    runtimeVersion: runtimeVersion ?? runtimeCatalog.runtimeVersion,
    manifestRevision,
    manifestHash,
    catalogFile,
    catalogHash,
    catalogRevision: runtimeCatalog.catalogRevision,
    activeOverrides,
    ...receiptOverrides,
  };
  secureAtomicWritePromptState(path.join(runtimePath, `${pid}.json`), receipt);
  secureAtomicWritePromptState(publicationStatePath, publicationState);
  return { runtimePath, catalogFile, catalogHash, receipt, catalog: runtimeCatalog };
}

function readPublicationStateFixture(storageRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(storageRoot, ".publication-state.json"), "utf8"),
  );
}

function writePublicationStateFixture(storageRoot, state) {
  secureAtomicWritePromptState(path.join(storageRoot, ".publication-state.json"), state);
}

function providerFixture(t, options = {}) {
  const storageRoot = makeStorage(t);
  return {
    storageRoot,
    provider: createCodexPromptCenterProvider({
      storageRoot,
      catalog: fixtureCatalog(),
      isPidAlive: options.isPidAlive || (() => false),
      isRuntimeProcess: options.isRuntimeProcess || (() => true),
      getRuntimeProcessStartUnixMs: options.getRuntimeProcessStartUnixMs || (() => 0),
      getProcessStartUnixMs: options.getProcessStartUnixMs || (() => 0),
      now: () => new Date("2030-01-02T03:04:05.000Z"),
    }),
  };
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-codex-prompt-project-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), "# Synthetic project\n");
  initializeContextRoomProject(root, { title: "Synthetic project", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function rawHttpRequest(origin, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function inlineAppScript() {
  const match = renderAppHtml().match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "expected the Context Room inline app script");
  return match[1];
}

test("Prompt Center discovers groups and target ids without UI-known mode names", (t) => {
  const { provider } = providerFixture(t);
  const summary = provider.readSummary();
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.groups[0].targets[0].id, "synthetic/mode/unknown-to-ui");
  assert.equal(summary.summary.targets, 2);
  assert.equal(summary.summary.editable, 1);
  assert.equal(summary.restartMessage, CODEX_PROMPT_RESTART_MESSAGE);
});

test("durable JSON schemas match the strict Rust catalog, manifest, publication state, and receipt shapes", (t) => {
  const catalogSchema = readSchema("codex-prompt-catalog-v1.schema.json");
  const overridesSchema = readSchema("codex-prompt-overrides-v1.schema.json");
  const publicationStateSchema = readSchema("codex-prompt-publication-state-v2.schema.json");
  const receiptSchema = readSchema("codex-prompt-runtime-receipt-v2.schema.json");
  const official = "Synthetic official prompt.\n";
  const catalogTarget = {
    id: "collaboration/default",
    label: "Default",
    kind: "collaboration",
    editable: true,
    runtimeStatus: "selectable",
    officialHash: hash(official),
    officialText: official,
    effectiveHash: hash(official),
    effectiveText: official,
    targetPattern: null,
    sourceTargetId: null,
    readOnlyReason: null,
    overrideStrategy: "patch",
    overrideConflict: null,
    source: "codex-rs/collaboration-mode-templates/templates",
    securityClass: "local_user_editable",
  };
  const catalogGroup = {
    id: "collaboration",
    label: "Collaboration modes",
    targets: [catalogTarget],
  };
  const catalog = {
    schemaVersion: 1,
    runtimeVersion: "fixture",
    catalogRevision: hash("catalog revision"),
    groups: [catalogGroup],
  };
  assertStrictSchemaShape(catalogSchema, catalog, "catalog");
  assertStrictSchemaShape(catalogSchema.$defs.group, catalogGroup, "catalog group");
  assertStrictSchemaShape(catalogSchema.$defs.target, catalogTarget, "catalog target");
  assert.equal(catalogSchema.properties.schemaVersion.const, 1);
  assert.match(catalog.catalogRevision, new RegExp(catalogSchema.$defs.hash.pattern));
  assert.deepEqual(catalogSchema.$defs.target.properties.kind.enum, [
    "model_base",
    "developer",
    "compact",
    "collaboration",
    "protected",
    "server_owned",
  ]);
  assert.deepEqual(catalogSchema.$defs.target.properties.runtimeStatus.enum, [
    "active",
    "available_local_only",
    "bundled",
    "cached",
    "catalogued",
    "configured",
    "selectable",
    "dormant",
    "override_conflict",
    "pattern",
    "shadowed_by_explicit_config",
    "shadowed_by_session_history",
    "personality_dependent",
    "protected",
    "server_owned",
  ]);
  assert.deepEqual(catalogSchema.$defs.target.properties.securityClass.enum, [
    "local_user_editable",
    "dormant",
    "advanced_pattern",
    "config_shadowed",
    "session_history",
    "dynamic_assembly",
    "enforcement_coupled",
    "security_critical",
    "contract_coupled",
    "state_assembled",
    "protocol_coupled",
    "privacy_sensitive",
    "dynamic_capability",
    "authority_sensitive",
    "runtime_generated",
    "lifecycle_managed",
    "history_semantics",
    "executable_contract",
    "configurable_elsewhere",
    "client_owned",
    "server_owned",
  ]);
  assert.deepEqual(catalogSchema.$defs.overrideConflict.properties.code.enum, [
    "official_hash_mismatch",
    "strategy_mismatch",
    "patch_anchor_mismatch",
    "effective_prompt_too_large",
    "target_became_personality_dependent",
  ]);

  const manifestOverride = {
    targetId: catalogTarget.id,
    officialHash: catalogTarget.officialHash,
    patches: [{ before: "official", after: "verified", expectedMatches: 1 }],
    replacement: null,
  };
  const manifest = { schemaVersion: 1, revision: 1, overrides: [manifestOverride] };
  assertStrictSchemaShape(overridesSchema, manifest, "override manifest");
  assert.equal(overridesSchema.properties.revision.maximum, Number.MAX_SAFE_INTEGER);
  assertStrictSchemaShape(
    overridesSchema.$defs.override,
    manifestOverride,
    "override entry",
    { optionalKeys: ["officialHash"] },
  );
  assertStrictSchemaShape(overridesSchema.$defs.patch, manifestOverride.patches[0], "override patch");

  const storageRoot = makeStorage(t);
  const written = writeRuntimeFixture(storageRoot, { pid: 901 });
  const publicationState = JSON.parse(
    fs.readFileSync(path.join(storageRoot, ".publication-state.json"), "utf8"),
  );
  assertStrictSchemaShape(publicationStateSchema, publicationState, "publication state");
  assert.deepEqual(Object.keys(publicationState), [
    "schemaVersion",
    "nextGeneration",
    "globalOwnerGeneration",
    "runtimeRegistryGenerations",
    "runtimeOwnerGenerations",
  ]);
  assert.equal(
    publicationStateSchema.properties.schemaVersion.const,
    CODEX_PROMPT_PUBLICATION_STATE_VERSION,
  );
  assert.equal(publicationStateSchema.properties.nextGeneration.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(
    publicationStateSchema.properties.globalOwnerGeneration.maximum,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    publicationStateSchema.properties.runtimeRegistryGenerations.additionalProperties.minimum,
    1,
  );
  assert.equal(
    publicationStateSchema.properties.runtimeOwnerGenerations.additionalProperties.minimum,
    1,
  );
  assert.equal(
    publicationState.runtimeRegistryGenerations["901"],
    1,
  );
  assert.equal(publicationState.runtimeOwnerGenerations["901"], written.receipt.publicationGeneration);
  assert.ok(
    publicationState.runtimeRegistryGenerations["901"]
      <= publicationState.runtimeOwnerGenerations["901"],
  );
  assert.ok(written.receipt.publicationGeneration < publicationState.nextGeneration);
  assertStrictSchemaShape(receiptSchema, written.receipt, "runtime receipt");
  assert.equal(receiptSchema.properties.schemaVersion.const, 2);
  assert.equal(receiptSchema.properties.pid.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(receiptSchema.properties.publicationGeneration.maximum, Number.MAX_SAFE_INTEGER);
  assert.match(
    written.receipt.processStartIdentity,
    new RegExp(receiptSchema.properties.processStartIdentity.pattern),
  );
  assert.equal(receiptSchema.properties.loadedAtUnixMs.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(receiptSchema.properties.manifestRevision.maximum, Number.MAX_SAFE_INTEGER);
  assert.match(written.receipt.catalogFile, new RegExp(receiptSchema.properties.catalogFile.pattern));
  const activeOverride = {
    targetId: "collaboration/default",
    sourceTargetId: "collaboration/default",
    effectiveHash: hash(official),
  };
  assertStrictSchemaShape(receiptSchema.$defs.activeOverride, activeOverride, "active override");
});

test("catalog revisions match Rust typed serialization and ignore JSON property order only", () => {
  const official = 'Café "quoted"\\path\n雪\n';
  const golden = finalizeCatalog({
    schemaVersion: 1,
    runtimeVersion: "golden-β",
    groups: [{
      id: "unicode",
      label: "Unicode ✨",
      targets: [{
        id: "collaboration/default",
        label: "Default “quoted”",
        kind: "collaboration",
        editable: true,
        runtimeStatus: "active",
        officialHash: hash(official),
        officialText: official,
        effectiveHash: hash(official),
        effectiveText: official,
        targetPattern: null,
        sourceTargetId: null,
        readOnlyReason: null,
        overrideStrategy: "patch",
        overrideConflict: null,
        source: "fixture\\source",
        securityClass: "local_user_editable",
      }],
    }],
  });
  assert.equal(
    golden.catalogRevision,
    "sha256:b93983a15186ba329c354dde8491c629937aba967243d0c9702f2c0606351cb0",
    "golden generated by Rust serde_json::to_vec over the typed PromptCatalog",
  );

  const target = golden.groups[0].targets[0];
  const reordered = {
    groups: [{
      targets: [{
        securityClass: target.securityClass,
        source: target.source,
        overrideConflict: target.overrideConflict,
        overrideStrategy: target.overrideStrategy,
        readOnlyReason: target.readOnlyReason,
        sourceTargetId: target.sourceTargetId,
        targetPattern: target.targetPattern,
        effectiveText: target.effectiveText,
        effectiveHash: target.effectiveHash,
        officialText: target.officialText,
        officialHash: target.officialHash,
        runtimeStatus: target.runtimeStatus,
        editable: target.editable,
        kind: target.kind,
        label: target.label,
        id: target.id,
      }],
      label: golden.groups[0].label,
      id: golden.groups[0].id,
    }],
    catalogRevision: golden.catalogRevision,
    runtimeVersion: golden.runtimeVersion,
    schemaVersion: golden.schemaVersion,
  };
  assert.equal(normalizeCodexPromptCatalog(reordered).catalogRevision, golden.catalogRevision);

  const unknownField = structuredClone(golden);
  unknownField.groups[0].targets[0].unexpected = true;
  assert.throws(
    () => normalizeCodexPromptCatalog(unknownField),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );

  const missingNullable = structuredClone(golden);
  delete missingNullable.groups[0].targets[0].readOnlyReason;
  assert.throws(
    () => normalizeCodexPromptCatalog(missingNullable),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );

  const missingConflictField = structuredClone(golden);
  delete missingConflictField.groups[0].targets[0].overrideConflict;
  assert.throws(
    () => normalizeCodexPromptCatalog(missingConflictField),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );

  const emptySourceTarget = structuredClone(golden);
  emptySourceTarget.groups[0].targets[0].sourceTargetId = "";
  emptySourceTarget.catalogRevision = logicalCatalogRevision(emptySourceTarget);
  assert.throws(
    () => normalizeCodexPromptCatalog(emptySourceTarget),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );

  const invalidUnicode = structuredClone(golden);
  invalidUnicode.groups[0].targets[0].officialText = "\ud800";
  assert.throws(
    () => normalizeCodexPromptCatalog(invalidUnicode),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );

  const forgedRevision = structuredClone(golden);
  forgedRevision.groups[0].label = "Changed without updating the revision";
  assert.throws(
    () => normalizeCodexPromptCatalog(forgedRevision),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );
});

test("catalog, manifest, and receipt readers reject unknown enums and implicit type coercion", (t) => {
  for (const mutate of [
    (target) => { target.kind = "synthetic"; },
    (target) => { target.runtimeStatus = "made_up"; },
    (target) => { target.securityClass = "made_up"; },
    (target) => {
      target.runtimeStatus = "override_conflict";
      target.sourceTargetId = null;
      target.effectiveText = target.officialText;
      target.effectiveHash = target.officialHash;
      target.overrideConflict = {
        code: "made_up",
        message: "Unknown conflict.",
        sourceTargetId: target.id,
      };
    },
  ]) {
    const catalog = fixtureCatalog();
    mutate(catalog.groups[0].targets[0]);
    assert.throws(
      () => createRawCodexPromptCenterProvider({
        storageRoot: makeStorage(t),
        catalog,
      }).readSummary(),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
    );
  }

  const manifestCases = [
    {
      schemaVersion: "1",
      revision: 0,
      overrides: [],
    },
    {
      schemaVersion: 1,
      revision: "0",
      overrides: [],
    },
    {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: "synthetic/mode/unknown-to-ui",
        officialHash: fixtureCatalog().groups[0].targets[0].officialHash,
        patches: [{ before: "Synthetic", after: "Verified", expectedMatches: 1 }],
      }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: "model/base/*",
        officialHash: hash("Wildcard baseline."),
        patches: [{ before: "Wildcard", after: "Changed", expectedMatches: 1 }],
        replacement: null,
      }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: "model/base/*",
        officialHash: null,
        patches: [],
        replacement: "Unsafe wildcard replacement.\n",
      }],
    },
  ];
  for (const manifest of manifestCases) {
    const storageRoot = makeStorage(t);
    secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), manifest);
    assert.throws(
      () => createCodexPromptCenterProvider({ storageRoot, catalog: fixtureCatalog() }).readSummary(),
      (error) => (
        error.statusCode === 503
        && ["codex_prompt_protocol_unsupported", "codex_prompt_override_invalid"].includes(error.code)
      ),
    );
  }

  const omittedWildcardHashRoot = makeStorage(t);
  secureAtomicWritePromptState(path.join(omittedWildcardHashRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: "model/base/*",
      patches: [{ before: "Wildcard", after: "Changed", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  assert.equal(
    createCodexPromptCenterProvider({
      storageRoot: omittedWildcardHashRoot,
      catalog: fixtureCatalog(),
    }).readSummary().summary.overrides,
    1,
  );

  const invalidUnicodeRoot = makeStorage(t);
  const invalidUnicodePath = path.join(invalidUnicodeRoot, "overrides.json");
  assert.throws(
    () => secureAtomicWritePromptState(invalidUnicodePath, {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: "synthetic/mode/unknown-to-ui",
        officialHash: fixtureCatalog().groups[0].targets[0].officialHash,
        patches: [{ before: "Synthetic", after: "\udfff", expectedMatches: 1 }],
        replacement: null,
      }],
    }),
    (error) => error.statusCode === 422 && error.code === "codex_prompt_invalid_unicode",
  );
  assert.equal(fs.existsSync(invalidUnicodePath), false);

  for (const mutate of [
    (receipt) => { delete receipt.publicationGeneration; },
    (receipt) => { receipt.publicationGeneration = 0; },
    (receipt) => { receipt.publicationGeneration = Number.MAX_SAFE_INTEGER + 1; },
    (receipt) => { delete receipt.processStartIdentity; },
    (receipt) => { receipt.processStartIdentity = "darwin-proc-bsdinfo-v1:NOT-A-UUID:919:1"; },
    (receipt) => {
      receipt.processStartIdentity = (
        `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:0:000001`
      );
    },
    (receipt) => { receipt.processStartIdentity = 919; },
    (receipt) => { receipt.loadedAtUnixMs = String(receipt.loadedAtUnixMs); },
    (receipt) => { receipt.runtimeVersion = 145; },
    (receipt) => { receipt.manifestRevision = String(receipt.manifestRevision); },
    (receipt) => { receipt.pid = Number.MAX_SAFE_INTEGER + 1; },
    (receipt) => { receipt.loadedAtUnixMs = Number.MAX_SAFE_INTEGER + 1; },
    (receipt) => { receipt.manifestRevision = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const storageRoot = makeStorage(t);
    const written = writeRuntimeFixture(storageRoot, { pid: 919 });
    const malformed = structuredClone(written.receipt);
    mutate(malformed);
    secureAtomicWritePromptState(path.join(written.runtimePath, "919.json"), malformed);
    assert.throws(
      () => readCodexPromptRuntimeReceipts({
        storageRoot,
        isPidAlive: (pid) => pid === 919,
        isRuntimeProcess: () => true,
        getRuntimeProcessStartUnixMs: () => 0,
      }),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_receipt_invalid",
    );
  }
});

test("exact overlays support replacement, insertion, and deletion", () => {
  const official = "alpha\nbeta\ngamma\n";
  for (const effective of [
    "alpha\nchanged\ngamma\n",
    "alpha\ninserted\nbeta\ngamma\n",
    "alpha\ngamma\n",
  ]) {
    const patches = createCodexPromptPatches(official, effective);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].expectedMatches, 1);
    assert.equal(applyCodexPromptPatches(official, patches), effective);
  }
  const repeatedOfficial = "same\ncontext one\nsame\ncontext two\n";
  const repeatedEffective = "same\ncontext one\nchanged\ncontext two\n";
  const contextual = createCodexPromptPatches(repeatedOfficial, repeatedEffective);
  assert.equal(contextual[0].expectedMatches, 1);
  assert.equal(applyCodexPromptPatches(repeatedOfficial, contextual), repeatedEffective);

  const newlineOnly = createCodexPromptPatches("\n\n\n", "\na");
  assert.equal(applyCodexPromptPatches("\n\n\n", newlineOnly), "\na");
});

test("an absent or ambiguous exact anchor fails with a conflict", () => {
  assert.throws(
    () => applyCodexPromptPatches("one\ntwo\n", [{ before: "missing", after: "value", expectedMatches: 1 }]),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_override_conflict",
  );
  assert.throws(
    () => applyCodexPromptPatches("repeat repeat", [{ before: "repeat", after: "value", expectedMatches: 1 }]),
    (error) => error.statusCode === 409 && error.details.actualMatches === 2,
  );
});

test("save validates hashes, revisions, permissions, and restart state", (t) => {
  const { storageRoot, provider } = providerFixture(t);
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const effective = target.official.replace("Use the supplied synthetic evidence.", "Use only verified synthetic evidence.");
  const saved = provider.writeOverride({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: target.overrideHash,
    effective,
  });
  assert.equal(saved.effective, effective);
  assert.equal(saved.status, "pending_next_launch");
  assert.equal(saved.restartMessage, "Quit Codex completely (⌘Q on macOS), reopen it, then create a new task.");
  const statePath = path.join(storageRoot, "overrides.json");
  assert.equal(fs.statSync(storageRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  const backupPath = path.join(storageRoot, "last-known-good.json");
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")), {
    schemaVersion: 1,
    revision: 0,
    overrides: [],
  });
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.overrides[0].targetId, target.id);
  assert.equal(state.overrides[0].replacement, null);
  assert.equal(state.overrides[0].patches[0].expectedMatches, 1);
  assert.equal(JSON.stringify(state).includes(target.official), false);
  assert.deepEqual(Object.keys(state).sort(), ["overrides", "revision", "schemaVersion"]);
  assert.deepEqual(
    Object.keys(state.overrides[0]).sort(),
    ["officialHash", "patches", "replacement", "targetId"],
    "the persisted manifest must round-trip through Rust deny_unknown_fields",
  );
});

test("manifest revision overflow is rejected before backup or replacement", (t) => {
  const saveStorageRoot = makeStorage(t);
  const maxRevisionState = {
    schemaVersion: 1,
    revision: Number.MAX_SAFE_INTEGER,
    overrides: [],
  };
  secureAtomicWritePromptState(path.join(saveStorageRoot, "overrides.json"), maxRevisionState);
  const originalManifestBytes = fs.readFileSync(path.join(saveStorageRoot, "overrides.json"));
  const saveProvider = createCodexPromptCenterProvider({
    storageRoot: saveStorageRoot,
    catalog: fixtureCatalog(),
  });
  const target = saveProvider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => saveProvider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_manifest_revision_exhausted",
  );
  assert.deepEqual(fs.readFileSync(path.join(saveStorageRoot, "overrides.json")), originalManifestBytes);
  assert.equal(fs.existsSync(path.join(saveStorageRoot, "last-known-good.json")), false);

  const restoreStorageRoot = makeStorage(t);
  const official = fixtureCatalog().groups[0].targets[0].officialText;
  secureAtomicWritePromptState(path.join(restoreStorageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: Number.MAX_SAFE_INTEGER,
    overrides: [{
      targetId: "synthetic/mode/unknown-to-ui",
      officialHash: hash(official),
      patches: [{ before: "supplied", after: "verified", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  const restoreManifestBytes = fs.readFileSync(path.join(restoreStorageRoot, "overrides.json"));
  const restoreProvider = createCodexPromptCenterProvider({
    storageRoot: restoreStorageRoot,
    catalog: fixtureCatalog(),
  });
  const overridden = restoreProvider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => restoreProvider.deleteOverride({
      targetId: overridden.id,
      catalogRevision: overridden.catalogRevision,
      officialHash: overridden.officialHash,
      overrideHash: overridden.overrideHash,
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_manifest_revision_exhausted",
  );
  assert.deepEqual(fs.readFileSync(path.join(restoreStorageRoot, "overrides.json")), restoreManifestBytes);
  assert.equal(fs.existsSync(path.join(restoreStorageRoot, "last-known-good.json")), false);
});

test("saving a prompt above 1000 estimated tokens requires an explicit boolean acknowledgement", (t) => {
  const { provider } = providerFixture(t);
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const effective = `${target.official}\n${"x".repeat(4_100)}`;
  const payload = {
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: target.overrideHash,
    effective,
  };
  assert.ok(estimateCodexPromptTokens(effective) > CODEX_PROMPT_HIGH_CONTEXT_CONFIRM_TOKENS);
  for (const acknowledgeHighContext of [undefined, false]) {
    const attempted = acknowledgeHighContext === undefined
      ? payload
      : { ...payload, acknowledgeHighContext };
    assert.throws(
      () => provider.writeOverride(attempted),
      (error) => error.statusCode === 422 && error.code === "codex_prompt_high_context_ack_required",
    );
  }
  assert.throws(
    () => provider.writeOverride({ ...payload, acknowledgeHighContext: "yes" }),
    (error) => error.statusCode === 422 && error.code === "codex_prompt_high_context_ack_invalid",
  );
  const saved = provider.writeOverride({ ...payload, acknowledgeHighContext: true });
  assert.equal(saved.effective, effective);
});

test("read-only targets and stale writes are rejected", (t) => {
  const { provider } = providerFixture(t);
  const readOnly = provider.readTarget("synthetic/contract/read-only");
  assert.throws(
    () => provider.writeOverride({
      targetId: readOnly.id,
      catalogRevision: readOnly.catalogRevision,
      officialHash: readOnly.officialHash,
      overrideHash: "",
      effective: "Changed.\n",
    }),
    (error) => error.statusCode === 403 && error.code === "codex_prompt_read_only",
  );

  const editable = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => provider.validateDraft({
      targetId: editable.id,
      catalogRevision: "stale",
      officialHash: editable.officialHash,
      overrideHash: "",
      effective: editable.effective,
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_catalog_stale",
  );
  assert.throws(
    () => provider.validateDraft({
      targetId: editable.id,
      catalogRevision: editable.catalogRevision,
      officialHash: hash("different"),
      overrideHash: "",
      effective: editable.effective,
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_official_stale",
  );
});

test("catalog editability rejects untrusted authority metadata", (t) => {
  for (const mutate of [
    (target) => { target.securityClass = "security_critical"; },
    (target) => { target.runtimeStatus = "protected"; },
  ]) {
    const catalog = fixtureCatalog();
    const target = catalog.groups[0].targets[0];
    mutate(target);
    const storageRoot = makeStorage(t);
    const provider = createCodexPromptCenterProvider({ storageRoot, catalog });
    assert.throws(
      () => provider.readTarget(target.id),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
    );
  }
});

test("catalog authority classes, effective content, and editable strategy fail closed", (t) => {
  const validProtected = createCodexPromptCenterProvider({
    storageRoot: makeStorage(t),
    catalog: fixtureCatalog(),
  }).readTarget("synthetic/contract/read-only");
  assert.equal(validProtected.kind, "protected");
  assert.equal(validProtected.editable, false);
  assert.equal(validProtected.official, null);
  assert.equal(validProtected.effective, null);

  const clientOwnedCatalog = fixtureCatalog();
  const clientOwnedTarget = clientOwnedCatalog.groups[1].targets[0];
  clientOwnedTarget.id = "protected/client/tui_init";
  clientOwnedTarget.label = "TUI /init command prompt";
  clientOwnedTarget.securityClass = "client_owned";
  const clientOwned = createCodexPromptCenterProvider({
    storageRoot: makeStorage(t),
    catalog: clientOwnedCatalog,
  }).readTarget(clientOwnedTarget.id);
  assert.equal(clientOwned.kind, "protected");
  assert.equal(clientOwned.editable, false);
  assert.equal(clientOwned.securityClass, "client_owned");

  const serverOwnedCatalog = fixtureCatalog();
  serverOwnedCatalog.groups[1].targets[0] = strictCatalogTarget({
    id: "synthetic/server/owned",
    label: "Server-owned prompt",
    kind: "server_owned",
    editable: false,
    runtimeStatus: "server_owned",
    officialHash: null,
    officialText: null,
    effectiveHash: null,
    effectiveText: null,
    targetPattern: null,
    sourceTargetId: null,
    readOnlyReason: "The service owns this prompt.",
    overrideStrategy: null,
    overrideConflict: null,
    source: "fixture",
    securityClass: "server_owned",
  });
  const validServerOwned = createCodexPromptCenterProvider({
    storageRoot: makeStorage(t),
    catalog: serverOwnedCatalog,
  }).readTarget("synthetic/server/owned");
  assert.equal(validServerOwned.kind, "server_owned");
  assert.equal(validServerOwned.editable, false);
  assert.equal(validServerOwned.effective, null);

  const malformedCatalogs = [
    () => {
      const catalog = fixtureCatalog();
      catalog.groups[0].targets[0].effectiveText = null;
      catalog.groups[0].targets[0].effectiveHash = null;
      return catalog;
    },
    () => {
      const catalog = fixtureCatalog();
      catalog.groups[0].targets[0].effectiveText = null;
      return catalog;
    },
    () => {
      const catalog = fixtureCatalog();
      catalog.groups[0].targets[0].overrideStrategy = null;
      return catalog;
    },
    () => {
      const catalog = fixtureCatalog();
      catalog.groups[0].targets[0].overrideStrategy = "replacement";
      return catalog;
    },
    () => {
      const catalog = fixtureCatalog();
      catalog.groups[0].targets[0].readOnlyReason = "Editable targets cannot publish a read-only reason.";
      return catalog;
    },
    () => {
      const catalog = fixtureCatalog();
      const target = catalog.groups[0].targets[0];
      target.effectiveText = target.officialText.replace("supplied", "unproven");
      target.effectiveHash = hash(target.effectiveText);
      target.sourceTargetId = null;
      return catalog;
    },
    () => {
      const catalog = fixtureCatalog();
      const target = catalog.groups[1].targets[0];
      target.officialText = "Hidden protected prompt.\n";
      target.officialHash = hash(target.officialText);
      target.effectiveText = target.officialText;
      target.effectiveHash = target.officialHash;
      return catalog;
    },
    () => {
      const catalog = structuredClone(serverOwnedCatalog);
      catalog.groups[1].targets[0].editable = true;
      return catalog;
    },
  ];
  for (const createMalformedCatalog of malformedCatalogs) {
    const provider = createCodexPromptCenterProvider({
      storageRoot: makeStorage(t),
      catalog: createMalformedCatalog(),
    });
    assert.throws(
      () => provider.readSummary(),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
    );
  }

  const emptyOfficial = fixtureCatalog();
  const emptyTarget = emptyOfficial.groups[0].targets[0];
  emptyTarget.officialText = "";
  emptyTarget.officialHash = hash("");
  emptyTarget.effectiveText = "";
  emptyTarget.effectiveHash = hash("");
  emptyTarget.overrideStrategy = "patch";
  assert.throws(
    () => createCodexPromptCenterProvider({
      storageRoot: makeStorage(t),
      catalog: emptyOfficial,
    }).readSummary(),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );
});

test("catalog authority discriminators are bidirectional and model pattern metadata is exact", () => {
  const catalogFor = (target) => finalizeCatalog({
    schemaVersion: 1,
    runtimeVersion: "authority-fixture",
    groups: [{ id: "authority", label: "Authority", targets: [target] }],
  });
  const expectRejected = (target, mutate, label) => {
    const catalog = catalogFor(target);
    mutate(catalog.groups[0].targets[0]);
    catalog.catalogRevision = logicalCatalogRevision(catalog);
    assert.throws(
      () => normalizeCodexPromptCatalog(catalog),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
      label,
    );
  };
  const official = "Authority prompt.\n";
  const dormant = {
    id: "collaboration/dormant",
    label: "Dormant",
    kind: "collaboration",
    editable: false,
    runtimeStatus: "dormant",
    officialText: official,
    effectiveText: official,
    sourceTargetId: null,
    readOnlyReason: "This mode is dormant.",
    overrideStrategy: null,
    overrideConflict: null,
    source: "fixture",
    securityClass: "dormant",
  };
  const configShadow = {
    id: "developer/configured",
    label: "Configured developer prompt",
    kind: "developer",
    editable: false,
    runtimeStatus: "shadowed_by_explicit_config",
    officialText: official,
    effectiveText: "Configured prompt.\n",
    targetPattern: null,
    sourceTargetId: null,
    readOnlyReason: "Explicit configuration owns this prompt.",
    overrideStrategy: null,
    overrideConflict: null,
    source: "fixture",
    securityClass: "config_shadowed",
  };
  const sessionHistory = {
    id: "model/base/history",
    label: "Historical model prompt",
    kind: "model_base",
    editable: false,
    runtimeStatus: "shadowed_by_session_history",
    officialText: official,
    effectiveText: "Historical prompt.\n",
    targetPattern: null,
    sourceTargetId: null,
    readOnlyReason: "Session history owns this prompt.",
    overrideStrategy: null,
    overrideConflict: null,
    source: "fixture",
    securityClass: "session_history",
  };
  const personality = {
    id: "model/base/personality",
    label: "Personality prompt",
    kind: "model_base",
    editable: false,
    runtimeStatus: "personality_dependent",
    officialText: official,
    effectiveText: "Assembled personality prompt.\n",
    targetPattern: null,
    sourceTargetId: null,
    readOnlyReason: "This target is assembled dynamically.",
    overrideStrategy: null,
    overrideConflict: null,
    source: "fixture",
    securityClass: "dynamic_assembly",
  };
  const pattern = {
    id: "model/base/*",
    label: "All models",
    kind: "model_base",
    editable: false,
    runtimeStatus: "pattern",
    officialHash: null,
    officialText: null,
    effectiveHash: null,
    effectiveText: null,
    targetPattern: "model/base/{modelSlug}",
    sourceTargetId: null,
    readOnlyReason: "This wildcard applies to every model-specific base prompt.",
    overrideStrategy: null,
    overrideConflict: null,
    source: "fixture",
    securityClass: "advanced_pattern",
  };

  for (const [target, mutate, label] of [
    [dormant, (item) => { item.runtimeStatus = "selectable"; }, "dormant class with selectable status"],
    [configShadow, (item) => { item.runtimeStatus = "configured"; }, "config class with configured status"],
    [sessionHistory, (item) => { item.runtimeStatus = "cached"; }, "history class with cached status"],
    [personality, (item) => { item.runtimeStatus = "cached"; }, "dynamic class with cached status"],
    [pattern, (item) => { item.runtimeStatus = "catalogued"; }, "pattern class with catalogued status"],
    [pattern, (item) => { item.securityClass = "dynamic_assembly"; }, "pattern status with dynamic class"],
  ]) {
    expectRejected(target, mutate, label);
  }

  for (const sourceTargetId of [null, "model/base/*"]) {
    const validPattern = structuredClone(pattern);
    validPattern.sourceTargetId = sourceTargetId;
    assert.equal(
      normalizeCodexPromptCatalog(catalogFor(validPattern)).groups[0].targets[0].runtimeStatus,
      "pattern",
    );
  }

  for (const [mutate, label] of [
    [(item) => { item.id = "model/base/other"; }, "id"],
    [(item) => { item.kind = "collaboration"; }, "kind"],
    [(item) => {
      item.officialText = official;
      item.officialHash = hash(official);
    }, "content"],
    [(item) => { item.targetPattern = "model/base/*"; }, "target pattern"],
    [(item) => { item.sourceTargetId = "model/base/other"; }, "source"],
    [(item) => { item.readOnlyReason = ""; }, "reason"],
    [(item) => { item.overrideStrategy = "patch"; }, "strategy"],
  ]) {
    expectRejected(pattern, mutate, `invalid pattern ${label}`);
  }
});

test("dormant collaboration modes stay visible and read-only", (t) => {
  const storageRoot = makeStorage(t);
  const official = "Dormant collaboration instructions.\n";
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: {
      schemaVersion: 1,
      runtimeVersion: "fixture",
      catalogRevision: hash("dormant catalog"),
      groups: [{
        id: "collaboration",
        label: "Collaboration modes",
        targets: [{
          id: "collaboration/pair_programming",
          label: "Pair Programming",
          kind: "collaboration",
          editable: false,
          runtimeStatus: "dormant",
          officialText: official,
          officialHash: hash(official),
          effectiveText: official,
          effectiveHash: hash(official),
          targetPattern: null,
          sourceTargetId: null,
          readOnlyReason: "This mode is catalogued but not selectable by the current product surface.",
          overrideStrategy: null,
          overrideConflict: null,
          source: "fixture",
          securityClass: "dormant",
        }],
      }],
    },
  });
  const summaryTarget = provider.readSummary().groups[0].targets[0];
  assert.equal(summaryTarget.runtimeStatus, "dormant");
  assert.equal(summaryTarget.editable, false);
  const detail = provider.readTarget(summaryTarget.id);
  assert.equal(detail.status, "not_running");
  assert.match(detail.readOnlyReason, /not selectable/);
});

test("runtime override conflicts remain editable and preserve Rust conflict metadata", (t) => {
  const storageRoot = makeStorage(t);
  const catalog = fixtureCatalog();
  const target = catalog.groups[0].targets[0];
  target.runtimeStatus = "override_conflict";
  target.sourceTargetId = null;
  target.effectiveText = target.officialText;
  target.effectiveHash = target.officialHash;
  target.overrideConflict = {
    code: "patch_anchor_mismatch",
    message: "Synthetic runtime patch anchor mismatch.",
    sourceTargetId: target.id,
  };
  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: target.id,
      officialHash: target.officialHash,
      patches: [{ before: "missing anchor", after: "replacement", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog });
  const conflicted = provider.readTarget(target.id);
  assert.equal(conflicted.status, "conflict");
  assert.equal(conflicted.editable, true);
  assert.deepEqual(conflicted.conflict, target.overrideConflict);
  assert.equal(conflicted.effective, target.officialText);

  const saved = provider.writeOverride({
    targetId: conflicted.id,
    catalogRevision: conflicted.catalogRevision,
    officialHash: conflicted.officialHash,
    overrideHash: conflicted.overrideHash,
    effective: conflicted.official.replace("supplied", "verified"),
  });
  assert.equal(saved.conflict, null);
  assert.equal(saved.status, "pending_next_launch");
  assert.equal(saved.editable, true);
});

test("session-history prompt targets remain visible with their runtime-effective text and stay read-only", (t) => {
  const storageRoot = makeStorage(t);
  const official = "Bundled model base prompt.\n";
  const effective = "Session-history model base prompt.\n";
  const catalog = finalizeCatalog({
    schemaVersion: 1,
    runtimeVersion: "fixture",
    groups: [{
      id: "model-base",
      label: "Model base prompts",
      targets: [{
        id: "model/base/session-history",
        label: "Session-history model",
        kind: "model_base",
        editable: false,
        runtimeStatus: "shadowed_by_session_history",
        officialText: official,
        officialHash: hash(official),
        effectiveText: effective,
        effectiveHash: hash(effective),
        targetPattern: null,
        sourceTargetId: null,
        readOnlyReason: "The active session history owns this assembled prompt.",
        overrideStrategy: null,
        overrideConflict: null,
        source: "fixture",
        securityClass: "session_history",
      }],
    }],
  });
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog });
  const detail = provider.readTarget("model/base/session-history");
  assert.equal(detail.editable, false);
  assert.equal(detail.runtimeStatus, "shadowed_by_session_history");
  assert.equal(detail.securityClass, "session_history");
  assert.equal(detail.effective, effective);
  assert.equal(detail.effectiveHash, hash(effective));
  assert.throws(
    () => provider.writeOverride({
      targetId: detail.id,
      catalogRevision: detail.catalogRevision,
      officialHash: detail.officialHash,
      overrideHash: detail.overrideHash,
      effective: "Changed.\n",
    }),
    (error) => error.statusCode === 403 && error.code === "codex_prompt_read_only",
  );
});

test("a target that became personality-dependent exposes a read-only conflict whose stale override can be restored", (t) => {
  const storageRoot = makeStorage(t);
  const official = "Personality-assembled model base prompt.\n";
  const targetId = "model/base/personality-dependent";
  const catalog = finalizeCatalog({
    schemaVersion: 1,
    runtimeVersion: "fixture",
    groups: [{
      id: "model-base",
      label: "Model base prompts",
      targets: [{
        id: targetId,
        label: "Personality-dependent model",
        kind: "model_base",
        editable: false,
        runtimeStatus: "override_conflict",
        officialText: official,
        officialHash: hash(official),
        effectiveText: official,
        effectiveHash: hash(official),
        targetPattern: null,
        sourceTargetId: null,
        readOnlyReason: "This target is now assembled from the selected personality.",
        overrideStrategy: null,
        overrideConflict: {
          code: "target_became_personality_dependent",
          message: "The saved override predates personality-dependent assembly.",
          sourceTargetId: targetId,
        },
        source: "fixture",
        securityClass: "dynamic_assembly",
      }],
    }],
  });
  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId,
      officialHash: hash(official),
      patches: [{ before: "Personality-assembled", after: "Previously overridden", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog,
    getProcessStartUnixMs: () => 0,
  });
  const detail = provider.readTarget(targetId);
  assert.equal(detail.editable, false);
  assert.equal(detail.status, "conflict");
  assert.equal(detail.effective, official);
  assert.equal(detail.conflict.code, "target_became_personality_dependent");
  assert.match(detail.overrideHash, /^sha256:/);
  assert.throws(
    () => provider.writeOverride({
      targetId: detail.id,
      catalogRevision: detail.catalogRevision,
      officialHash: detail.officialHash,
      overrideHash: detail.overrideHash,
      effective: "Changed.\n",
    }),
    (error) => error.statusCode === 403 && error.code === "codex_prompt_read_only",
  );
  const restored = provider.deleteOverride({
    targetId: detail.id,
    catalogRevision: detail.catalogRevision,
    officialHash: detail.officialHash,
    overrideHash: detail.overrideHash,
  });
  assert.equal(restored.overrideHash, "");
  assert.equal(restored.editable, false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(storageRoot, "overrides.json"), "utf8")).overrides,
    [],
  );
});

test("a cross-process write lock prevents concurrent manifest replacement and clears dead owners", async (t) => {
  const storageRoot = makeStorage(t);
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(storageRoot, ".context-room-write.lock");
  const lockOwner = spawn(process.execPath, [
    "-e",
    [
      'const fs = require("node:fs");',
      "const lockPath = process.argv[1];",
      "fs.mkdirSync(lockPath, { mode: 0o700 });",
      'fs.writeFileSync(`${lockPath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "b".repeat(32), processStartedAtUnixMs: 0 })}\\n`, { mode: 0o600 });',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    lockPath,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => {
    if (lockOwner.exitCode === null) lockOwner.kill();
  });
  await once(lockOwner.stdout, "data");
  const liveOwnerProvider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    getProcessStartUnixMs: () => 0,
  });
  const target = liveOwnerProvider.readTarget("synthetic/mode/unknown-to-ui");
  const payload = {
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: "",
    effective: target.effective.replace("supplied", "verified"),
  };
  assert.throws(
    () => liveOwnerProvider.writeOverride(payload),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
  );
  const exited = once(lockOwner, "exit");
  lockOwner.kill();
  await exited;
  const deadOwnerProvider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    getProcessStartUnixMs: () => 0,
  });
  assert.equal(deadOwnerProvider.writeOverride(payload).id, target.id);
  assert.equal(fs.existsSync(lockPath), false);
});

test("an old write lock owned by a live PID is never evicted by age", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot);
  const staleTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    isRuntimeProcess: () => false,
    getProcessStartUnixMs: () => 0,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
  );
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token, "a".repeat(32));
});

test("a legacy null-start lock stays live when the PID predates its owner record", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: process.pid,
    token: "1".repeat(32),
    processStartedAtUnixMs: null,
  });
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(ownerPath, ownerTime, ownerTime);
  fs.utimesSync(lockPath, ownerTime, ownerTime);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => ownerTime.getTime() - 60_000,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(ownerPath, "utf8")).token,
    "1".repeat(32),
  );
});

test("a fresh null-start lock keeps its grace period when a live PID appears reused", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: process.pid,
    token: "3".repeat(32),
    processStartedAtUnixMs: null,
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => Date.now() + 60_000,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token,
    "3".repeat(32),
  );
});

test("an old live lock stays blocking when its process start cannot be verified", (t) => {
  const unverifiableStarts = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["throwing", () => { throw new Error("process start unavailable"); }],
    ["negative", () => -1],
    ["fractional", () => 1.5],
    ["not-a-number", () => Number.NaN],
    ["unsafe", () => Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, getProcessStartUnixMs] of unverifiableStarts) {
    for (const recordedProcessStart of [null, 100]) {
      const caseLabel = `${label}/${String(recordedProcessStart)}`;
      const storageRoot = makeStorage(t);
      const lockPath = writePromptLockFixture(storageRoot, {
        pid: process.pid,
        token: "5".repeat(32),
        processStartedAtUnixMs: recordedProcessStart,
      });
      const ownerPath = path.join(lockPath, "owner.json");
      const oldOwnerTime = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(ownerPath, oldOwnerTime, oldOwnerTime);
      fs.utimesSync(lockPath, oldOwnerTime, oldOwnerTime);
      const provider = createCodexPromptCenterProvider({
        storageRoot,
        catalog: fixtureCatalog(),
        isPidAlive: (pid) => pid === process.pid,
        getProcessStartUnixMs,
      });
      const target = provider.readTarget("synthetic/mode/unknown-to-ui");
      assert.throws(
        () => provider.writeOverride({
          targetId: target.id,
          catalogRevision: target.catalogRevision,
          officialHash: target.officialHash,
          overrideHash: target.overrideHash,
          effective: target.effective.replace("supplied", "verified"),
        }),
        (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
        caseLabel,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(ownerPath, "utf8")).token,
        "5".repeat(32),
        caseLabel,
      );
    }
  }
});

test("a legacy null-start lock is reclaimed after verified PID reuse", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: process.pid,
    token: "2".repeat(32),
    processStartedAtUnixMs: null,
  });
  const ownerPath = path.join(lockPath, "owner.json");
  const oldOwnerTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(ownerPath, oldOwnerTime, oldOwnerTime);
  fs.utimesSync(lockPath, oldOwnerTime, oldOwnerTime);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => oldOwnerTime.getTime() + 60_000,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const saved = provider.writeOverride({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: target.overrideHash,
    effective: target.effective.replace("supplied", "verified"),
  });
  assert.equal(saved.id, target.id);
  assert.equal(fs.existsSync(lockPath), false);
});

test("a live reclaim claim prevents a second stale-lock reclaimer", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: 999_999,
    token: "3".repeat(32),
    processStartedAtUnixMs: 0,
  });
  fs.writeFileSync(
    path.join(lockPath, ".reclaim"),
    `${JSON.stringify({
      pid: process.pid,
      token: "4".repeat(32),
      processStartedAtUnixMs: 0,
    })}\n`,
    { mode: 0o600 },
  );
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => 0,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
  );
  assert.equal(fs.existsSync(path.join(lockPath, ".reclaim")), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token,
    "3".repeat(32),
  );
});

test("an old live reclaim claim stays blocking when its process start cannot be verified", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: 999_999,
    token: "7".repeat(32),
    processStartedAtUnixMs: 0,
  });
  const reclaimPath = path.join(lockPath, ".reclaim");
  fs.writeFileSync(
    reclaimPath,
    `${JSON.stringify({
      pid: process.pid,
      token: "8".repeat(32),
      processStartedAtUnixMs: null,
    })}\n`,
    { mode: 0o600 },
  );
  const oldReclaimTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(reclaimPath, oldReclaimTime, oldReclaimTime);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => { throw new Error("process start unavailable"); },
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.throws(
    () => provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(reclaimPath, "utf8")).token,
    "8".repeat(32),
  );
});

test("a reused live PID cannot keep a stale write-lock generation", (t) => {
  const storageRoot = makeStorage(t);
  const staleToken = "f".repeat(32);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: process.pid,
    token: staleToken,
    processStartedAtUnixMs: 100,
  });
  const staleTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => 200,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const saved = provider.writeOverride({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: target.overrideHash,
    effective: target.effective.replace("supplied", "verified"),
  });
  assert.equal(saved.id, target.id);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(storageRoot).filter((entry) => entry.includes(".stale.")),
    [],
  );
});

test("a delayed stale-lock reclaimer cannot remove a successor generation", (t) => {
  const storageRoot = makeStorage(t);
  const staleToken = "c".repeat(32);
  const successorToken = "d".repeat(32);
  const lockPath = writePromptLockFixture(storageRoot, { pid: 999_999, token: staleToken });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === process.pid,
    getProcessStartUnixMs: () => 0,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const originalOpenSync = fs.openSync;
  const parkedPath = path.join(storageRoot, ".context-room-write.lock.parked-stale");
  let interleaved = false;
  fs.openSync = function openReclaimAfterSuccessor(candidate, ...rest) {
    if (
      !interleaved
      && candidate === path.join(lockPath, ".reclaim")
    ) {
      interleaved = true;
      fs.renameSync(lockPath, parkedPath);
      writePromptLockFixture(storageRoot, { pid: process.pid, token: successorToken });
    }
    return originalOpenSync.call(fs, candidate, ...rest);
  };
  try {
    assert.throws(
      () => provider.writeOverride({
        targetId: target.id,
        catalogRevision: target.catalogRevision,
        officialHash: target.officialHash,
        overrideHash: target.overrideHash,
        effective: target.effective.replace("supplied", "verified"),
      }),
      (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(interleaved, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token,
    successorToken,
  );
  assert.equal(fs.existsSync(path.join(lockPath, ".reclaim")), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(parkedPath, "owner.json"), "utf8")).token,
    staleToken,
  );
});

test("failed lock initialization cannot remove an interleaved successor generation", (t) => {
  const storageRoot = makeStorage(t);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const lockPath = path.join(storageRoot, ".context-room-write.lock");
  const parkedPath = path.join(storageRoot, ".context-room-write.lock.parked-partial");
  const successorToken = "9".repeat(32);
  const originalRenameSync = fs.renameSync;
  let interleaved = false;
  fs.renameSync = function failOwnerPublicationAfterSuccessor(source, destination) {
    if (
      !interleaved
      && path.dirname(source) === lockPath
      && path.basename(source).startsWith("owner.json.tmp.")
      && destination === path.join(lockPath, "owner.json")
    ) {
      interleaved = true;
      originalRenameSync.call(fs, lockPath, parkedPath);
      writePromptLockFixture(storageRoot, {
        pid: process.pid,
        token: successorToken,
      });
    }
    return originalRenameSync.call(fs, source, destination);
  };
  try {
    assert.throws(
      () => provider.writeOverride({
        targetId: target.id,
        catalogRevision: target.catalogRevision,
        officialHash: target.officialHash,
        overrideHash: target.overrideHash,
        effective: target.effective.replace("supplied", "verified"),
      }),
      (error) => error.code === "ENOENT",
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(interleaved, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token,
    successorToken,
  );
  assert.equal(fs.statSync(parkedPath).isDirectory(), true);
  assert.equal(
    fs.readdirSync(parkedPath).filter((entry) => entry.startsWith("owner.json.tmp.")).length,
    1,
  );
});

test("owner publication stays invisible until fsync and a failed generation remains reclaimable", (t) => {
  const storageRoot = makeStorage(t);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: () => false,
    getProcessStartUnixMs: () => 0,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const lockPath = path.join(storageRoot, ".context-room-write.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerDescriptors = new Set();
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  fs.openSync = function trackOwnerTemporary(candidate, ...rest) {
    const descriptor = originalOpenSync.call(fs, candidate, ...rest);
    if (
      typeof candidate === "string"
      && path.dirname(candidate) === lockPath
      && path.basename(candidate).startsWith("owner.json.tmp.")
    ) {
      ownerDescriptors.add(descriptor);
    }
    return descriptor;
  };
  fs.fsyncSync = function failPreparedOwnerFsync(descriptor) {
    if (ownerDescriptors.has(descriptor)) {
      ownerDescriptors.delete(descriptor);
      assert.equal(fs.existsSync(ownerPath), false);
      const error = new Error("simulated owner fsync failure");
      error.code = "EIO";
      throw error;
    }
    return originalFsyncSync.call(fs, descriptor);
  };
  try {
    assert.throws(
      () => provider.writeOverride({
        targetId: target.id,
        catalogRevision: target.catalogRevision,
        officialHash: target.officialHash,
        overrideHash: target.overrideHash,
        effective: target.effective.replace("supplied", "verified"),
      }),
      (error) => error.code === "EIO",
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(fs.existsSync(ownerPath), false);
  assert.deepEqual(
    fs.readdirSync(lockPath).filter((entry) => entry.startsWith("owner.json.tmp.")),
    [],
  );
  const staleTime = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);
  const saved = provider.writeOverride({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: target.overrideHash,
    effective: target.effective.replace("supplied", "verified"),
  });
  assert.equal(saved.id, target.id);
  assert.equal(fs.existsSync(lockPath), false);
});

test("reclaim publication stays invisible through fsync and close failures without blocking retry", (t) => {
  for (const failurePhase of ["fsync", "close"]) {
    const storageRoot = makeStorage(t);
    const lockPath = writePromptLockFixture(storageRoot, {
      pid: 999_999,
      token: failurePhase === "fsync" ? "a".repeat(32) : "b".repeat(32),
    });
    const reclaimPath = path.join(lockPath, ".reclaim");
    const provider = createCodexPromptCenterProvider({
      storageRoot,
      catalog: fixtureCatalog(),
      isPidAlive: () => false,
      getProcessStartUnixMs: () => 0,
    });
    const target = provider.readTarget("synthetic/mode/unknown-to-ui");
    const reclaimDescriptors = new Set();
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalCloseSync = fs.closeSync;
    let injected = false;
    fs.openSync = function trackReclaimTemporary(candidate, ...rest) {
      const descriptor = originalOpenSync.call(fs, candidate, ...rest);
      if (
        typeof candidate === "string"
        && path.dirname(candidate) === lockPath
        && path.basename(candidate).startsWith(".reclaim.tmp.")
      ) {
        reclaimDescriptors.add(descriptor);
      }
      return descriptor;
    };
    fs.fsyncSync = function failPreparedReclaimFsync(descriptor) {
      if (!injected && failurePhase === "fsync" && reclaimDescriptors.has(descriptor)) {
        injected = true;
        assert.equal(fs.existsSync(reclaimPath), false);
        const error = new Error("simulated reclaim fsync failure");
        error.code = "EIO";
        throw error;
      }
      return originalFsyncSync.call(fs, descriptor);
    };
    fs.closeSync = function failPreparedReclaimClose(descriptor) {
      if (!injected && failurePhase === "close" && reclaimDescriptors.has(descriptor)) {
        injected = true;
        assert.equal(fs.existsSync(reclaimPath), false);
        originalCloseSync.call(fs, descriptor);
        const error = new Error("simulated reclaim close failure");
        error.code = "EIO";
        throw error;
      }
      return originalCloseSync.call(fs, descriptor);
    };
    try {
      assert.throws(
        () => provider.writeOverride({
          targetId: target.id,
          catalogRevision: target.catalogRevision,
          officialHash: target.officialHash,
          overrideHash: target.overrideHash,
          effective: target.effective.replace("supplied", "verified"),
        }),
        (error) => error.code === "EIO",
        failurePhase,
      );
    } finally {
      fs.openSync = originalOpenSync;
      fs.fsyncSync = originalFsyncSync;
      fs.closeSync = originalCloseSync;
    }
    assert.equal(injected, true, failurePhase);
    assert.equal(fs.existsSync(reclaimPath), false, failurePhase);
    assert.deepEqual(
      fs.readdirSync(lockPath).filter((entry) => entry.startsWith(".reclaim.tmp.")),
      [],
      failurePhase,
    );
    const saved = provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    });
    assert.equal(saved.id, target.id, failurePhase);
    assert.equal(fs.existsSync(lockPath), false, failurePhase);
  }
});

test("atomic stale-lock retirement preserves an empty successor directory", (t) => {
  const storageRoot = makeStorage(t);
  const lockPath = writePromptLockFixture(storageRoot, {
    pid: 999_999,
    token: "6".repeat(32),
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: () => false,
    getProcessStartUnixMs: () => 0,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const originalRenameSync = fs.renameSync;
  let interleaved = false;
  fs.renameSync = function createSuccessorAfterRetirement(source, destination) {
    const result = originalRenameSync.call(fs, source, destination);
    if (
      !interleaved
      && source === lockPath
      && destination.startsWith(`${lockPath}.retired.`)
    ) {
      interleaved = true;
      fs.mkdirSync(lockPath, { mode: 0o700 });
    }
    return result;
  };
  try {
    assert.throws(
      () => provider.writeOverride({
        targetId: target.id,
        catalogRevision: target.catalogRevision,
        officialHash: target.officialHash,
        overrideHash: target.overrideHash,
        effective: target.effective.replace("supplied", "verified"),
      }),
      (error) => error.statusCode === 409 && error.code === "codex_prompt_write_in_progress",
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(interleaved, true);
  assert.equal(fs.statSync(lockPath).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(lockPath), []);
  assert.deepEqual(
    fs.readdirSync(storageRoot).filter((entry) => entry.includes(".retired.")),
    [],
  );
});

test("write-lock release keeps a replacement generation and reports a warning", (t) => {
  const storageRoot = makeStorage(t);
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog: fixtureCatalog() });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const lockPath = path.join(storageRoot, ".context-room-write.lock");
  const parkedPath = path.join(storageRoot, ".context-room-write.lock.parked-generation");
  const successorToken = "e".repeat(32);
  const overridesPath = path.join(storageRoot, "overrides.json");
  const originalRenameSync = fs.renameSync;
  let swapped = false;
  fs.renameSync = function renameAndSwapGeneration(source, destination) {
    const result = originalRenameSync.call(fs, source, destination);
    if (!swapped && destination === overridesPath) {
      swapped = true;
      originalRenameSync.call(fs, lockPath, parkedPath);
      writePromptLockFixture(storageRoot, { pid: process.pid, token: successorToken });
    }
    return result;
  };
  let saved;
  try {
    saved = provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(swapped, true);
  assert.match(saved.commitWarning, /write lock changed generation/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token,
    successorToken,
  );
  assert.equal(JSON.parse(fs.readFileSync(overridesPath, "utf8")).revision, 1);
});

test("atomic write-lock release preserves an empty successor directory", (t) => {
  const storageRoot = makeStorage(t);
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog: fixtureCatalog() });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const lockPath = path.join(storageRoot, ".context-room-write.lock");
  const originalRenameSync = fs.renameSync;
  let interleaved = false;
  fs.renameSync = function createSuccessorAfterRetirement(source, destination) {
    const result = originalRenameSync.call(fs, source, destination);
    if (
      !interleaved
      && source === lockPath
      && destination.startsWith(`${lockPath}.retired.`)
    ) {
      interleaved = true;
      fs.mkdirSync(lockPath, { mode: 0o700 });
    }
    return result;
  };
  let saved;
  try {
    saved = provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(saved.id, target.id);
  assert.equal(interleaved, true);
  assert.equal(fs.statSync(lockPath).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(lockPath), []);
  assert.deepEqual(
    fs.readdirSync(storageRoot).filter((entry) => entry.includes(".retired.")),
    [],
  );
});

test("restore official uses optimistic concurrency and removes the override", (t) => {
  const { storageRoot, provider } = providerFixture(t);
  const original = provider.readTarget("synthetic/mode/unknown-to-ui");
  const saved = provider.writeOverride({
    targetId: original.id,
    catalogRevision: original.catalogRevision,
    officialHash: original.officialHash,
    overrideHash: original.overrideHash,
    effective: original.effective.replace("supplied", "verified"),
  });
  assert.throws(
    () => provider.deleteOverride({
      targetId: original.id,
      catalogRevision: saved.catalogRevision,
      officialHash: saved.officialHash,
      overrideHash: "sha256:stale",
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_override_stale",
  );
  const savedManifest = JSON.parse(fs.readFileSync(path.join(storageRoot, "overrides.json"), "utf8"));
  const restored = provider.deleteOverride({
    targetId: original.id,
    catalogRevision: saved.catalogRevision,
    officialHash: saved.officialHash,
    overrideHash: saved.overrideHash,
  });
  assert.equal(restored.effective, restored.official);
  assert.equal(restored.overrideHash, "");
  const backup = JSON.parse(fs.readFileSync(path.join(storageRoot, "last-known-good.json"), "utf8"));
  assert.deepEqual(backup, savedManifest);
  assert.equal(JSON.stringify(backup).includes("overrideHash"), false);
});

test("catalog strategy chooses replacement for an empty baseline and patches for a non-empty baseline", (t) => {
  const storageRoot = makeStorage(t);
  const emptyHash = hash("");
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: {
      schemaVersion: 1,
      runtimeVersion: "fixture",
      catalogRevision: "developer-fixture",
      groups: [{
        id: "developer",
        label: "Developer",
        targets: [{
          id: "developer/global",
          label: "Global developer instructions",
          kind: "developer",
          editable: true,
          runtimeStatus: "active",
          securityClass: "local_user_editable",
          officialText: "",
          officialHash: emptyHash,
          effectiveText: "",
          effectiveHash: emptyHash,
          overrideStrategy: "replacement",
        }],
      }],
    },
  });
  const target = provider.readTarget("developer/global");
  const saved = provider.writeOverride({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: "",
    effective: "Synthetic global developer instructions.\n",
  });
  assert.equal(saved.replacement, "Synthetic global developer instructions.\n");
  assert.deepEqual(saved.patches, []);
  const state = JSON.parse(fs.readFileSync(path.join(storageRoot, "overrides.json"), "utf8"));
  assert.equal(state.overrides[0].replacement, "Synthetic global developer instructions.\n");

  const patchStorageRoot = makeStorage(t);
  const official = "Configured developer baseline.\n";
  const patchProvider = createCodexPromptCenterProvider({
    storageRoot: patchStorageRoot,
    catalog: {
      schemaVersion: 1,
      runtimeVersion: "fixture",
      catalogRevision: "developer-patch-fixture",
      groups: [{
        id: "developer",
        label: "Developer",
        targets: [{
          id: "synthetic/developer",
          label: "Configured developer instructions",
          kind: "developer",
          editable: true,
          runtimeStatus: "active",
          securityClass: "local_user_editable",
          officialText: official,
          officialHash: hash(official),
          effectiveText: official,
          effectiveHash: hash(official),
          overrideStrategy: "patch",
        }],
      }],
    },
  });
  const patchTarget = patchProvider.readTarget("synthetic/developer");
  const patched = patchProvider.writeOverride({
    targetId: patchTarget.id,
    catalogRevision: patchTarget.catalogRevision,
    officialHash: patchTarget.officialHash,
    overrideHash: "",
    effective: "Configured developer baseline, edited.\n",
  });
  assert.equal(patched.replacement, null);
  assert.equal(patched.patches.length, 1);
});

test("runtime receipts ignore dead legacy files and detect mixed target hashes across snapshot revisions", (t) => {
  const { storageRoot } = providerFixture(t);
  const catalogOne = fixtureCatalog();
  const targetOne = catalogOne.groups[0].targets[0];
  targetOne.effectiveText = targetOne.officialText.replace("supplied", "first");
  targetOne.effectiveHash = hash(targetOne.effectiveText);
  targetOne.sourceTargetId = targetOne.id;
  catalogOne.catalogRevision = hash("catalog one");
  const first = writeRuntimeFixture(storageRoot, {
    pid: 101,
    loadedAtUnixMs: 1,
    catalog: catalogOne,
    manifestRevision: 1,
    manifestHash: hash("fixture-one"),
    activeOverrides: [{
      targetId: targetOne.id,
      sourceTargetId: targetOne.id,
      effectiveHash: targetOne.effectiveHash,
    }],
  });
  const catalogTwo = fixtureCatalog();
  const targetTwo = catalogTwo.groups[0].targets[0];
  targetTwo.effectiveText = targetTwo.officialText.replace("supplied", "second");
  targetTwo.effectiveHash = hash(targetTwo.effectiveText);
  targetTwo.sourceTargetId = targetTwo.id;
  catalogTwo.catalogRevision = hash("catalog two");
  writeRuntimeFixture(storageRoot, {
    pid: 202,
    loadedAtUnixMs: 2,
    catalog: catalogTwo,
    manifestRevision: 1,
    manifestHash: hash("fixture-two"),
    activeOverrides: [{
      targetId: targetTwo.id,
      sourceTargetId: targetTwo.id,
      effectiveHash: targetTwo.effectiveHash,
    }],
  });
  secureAtomicWritePromptState(path.join(first.runtimePath, "303.json"), {
    schemaVersion: 99,
    pid: 303,
    activeOverrides: [],
  });
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 101,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  assert.deepEqual(receipts.map((receipt) => receipt.pid), [101]);
  assert.equal(fs.readFileSync(path.join(first.runtimePath, "101.json"), "utf8").includes("Synthetic behavior"), false);

  const mixedProvider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 101 || pid === 202,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const mixed = mixedProvider.readTarget("synthetic/mode/unknown-to-ui");
  assert.equal(mixed.status, "mixed_versions");
  assert.equal(mixed.statusLabel, "Mixed runtime-loaded state");
  assert.equal(mixed.restartRequired, true);
});

test("different live catalog, manifest, and runtime revisions do not create a false per-target mix", (t) => {
  const storageRoot = makeStorage(t);
  const firstCatalog = fixtureCatalog();
  firstCatalog.runtimeVersion = "snapshot-one";
  const secondCatalog = fixtureCatalog();
  secondCatalog.runtimeVersion = "snapshot-two";
  writeRuntimeFixture(storageRoot, {
    pid: 111,
    catalog: firstCatalog,
    manifestRevision: 1,
    manifestHash: hash("manifest one"),
  });
  writeRuntimeFixture(storageRoot, {
    pid: 222,
    catalog: secondCatalog,
    manifestRevision: 2,
    manifestHash: hash("manifest two"),
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 111 || pid === 222,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const detail = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.equal(detail.status, "official_loaded");
  assert.equal(detail.loaded, detail.official);
  assert.equal(detail.liveProcesses, 2);
  assert.equal(detail.runtimeCatalogCurrent, false);
  assert.equal(detail.runtimeManifestCurrent, false);
});

test("read-only shadowed targets use the catalog effective snapshot", (t) => {
  const storageRoot = makeStorage(t);
  const catalog = fixtureCatalog();
  const target = catalog.groups[0].targets[0];
  const loadedText = "Synthetic explicit configuration.\n";
  target.kind = "model_base";
  target.editable = false;
  target.runtimeStatus = "shadowed_by_explicit_config";
  target.securityClass = "config_shadowed";
  target.readOnlyReason = "Explicit Codex configuration owns this target.";
  target.overrideStrategy = null;
  target.sourceTargetId = null;
  target.effectiveText = loadedText;
  target.effectiveHash = hash(loadedText);
  writeRuntimeFixture(storageRoot, {
    pid: 303,
    loadedAtUnixMs: 3,
    catalog,
    manifestRevision: 0,
    manifestHash: null,
    activeOverrides: [],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog,
    isPidAlive: (pid) => pid === 303,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const detail = provider.readTarget(target.id);
  assert.equal(detail.effective, loadedText);
  assert.equal(detail.loaded, loadedText);
  assert.equal(detail.status, "effective_loaded");
});

test("a read-only target whose loaded prompt differs keeps authority metadata and restart guidance", (t) => {
  const storageRoot = makeStorage(t);
  const currentCatalog = fixtureCatalog();
  const currentTarget = currentCatalog.groups[0].targets[0];
  currentTarget.kind = "model_base";
  currentTarget.editable = false;
  currentTarget.runtimeStatus = "shadowed_by_explicit_config";
  currentTarget.securityClass = "config_shadowed";
  currentTarget.readOnlyReason = "Explicit Codex configuration owns this target.";
  currentTarget.overrideStrategy = null;
  currentTarget.sourceTargetId = null;
  currentTarget.effectiveText = "Current explicit configuration.\n";
  currentTarget.effectiveHash = hash(currentTarget.effectiveText);

  const loadedCatalog = structuredClone(currentCatalog);
  const loadedTarget = loadedCatalog.groups[0].targets[0];
  loadedTarget.effectiveText = "Previously loaded explicit configuration.\n";
  loadedTarget.effectiveHash = hash(loadedTarget.effectiveText);
  writeRuntimeFixture(storageRoot, {
    pid: 304,
    loadedAtUnixMs: 4,
    catalog: loadedCatalog,
    manifestRevision: 0,
    manifestHash: null,
    activeOverrides: [],
  });

  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: currentCatalog,
    isPidAlive: (pid) => pid === 304,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const detail = provider.readTarget(currentTarget.id);
  assert.equal(detail.editable, false);
  assert.equal(detail.readOnlyReason, "Explicit Codex configuration owns this target.");
  assert.equal(detail.status, "loaded_differs");
  assert.equal(detail.statusLabel, "Loaded prompt differs");
  assert.equal(detail.restartRequired, true);
  assert.equal(detail.restartMessage, CODEX_PROMPT_RESTART_MESSAGE);
});

test("an editable catalog snapshot from a removed override stays runtime loaded but desired returns to official", (t) => {
  const storageRoot = makeStorage(t);
  const catalog = fixtureCatalog();
  const target = catalog.groups[0].targets[0];
  const loadedText = target.officialText.replace("supplied", "runtime-loaded");
  target.effectiveText = loadedText;
  target.effectiveHash = hash(loadedText);
  target.sourceTargetId = target.id;
  const runtimeCatalog = structuredClone(catalog);
  writeRuntimeFixture(storageRoot, {
    pid: 303,
    loadedAtUnixMs: 3,
    catalog: runtimeCatalog,
    manifestRevision: 1,
    manifestHash: hash("removed manifest"),
    activeOverrides: [{
      targetId: target.id,
      sourceTargetId: target.id,
      effectiveHash: hash(loadedText),
    }],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog,
    isPidAlive: (pid) => pid === 303,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const detail = provider.readTarget(target.id);
  assert.equal(detail.effective, target.officialText);
  assert.equal(detail.loaded, loadedText);
  assert.equal(detail.status, "restart_required");
});

test("wildcard provenance never substitutes for exact concrete receipt hashes", (t) => {
  const storageRoot = makeStorage(t);
  const one = "Model one official.\n";
  const two = "Model two official.\n";
  const oneLoaded = "Model one wildcard result.\n";
  const twoLoaded = "Model two wildcard result.\n";
  const catalog = {
    schemaVersion: 1,
    runtimeVersion: "fixture",
    catalogRevision: hash("wildcard catalog"),
    groups: [{
      id: "model",
      label: "Models",
      targets: [
        {
          id: "model/base/*",
          label: "All models",
          kind: "model_base",
          editable: false,
          runtimeStatus: "pattern",
          officialHash: null,
          officialText: null,
          effectiveHash: null,
          effectiveText: null,
          targetPattern: "model/base/{modelSlug}",
          sourceTargetId: "model/base/*",
          readOnlyReason: "This wildcard applies to every model-specific base prompt.",
          overrideStrategy: null,
          overrideConflict: null,
          source: "fixture",
          securityClass: "advanced_pattern",
        },
        {
          id: "model/base/one",
          label: "One",
          kind: "model_base",
          editable: true,
          runtimeStatus: "active",
          securityClass: "local_user_editable",
          officialHash: hash(one),
          officialText: one,
          effectiveHash: hash(oneLoaded),
          effectiveText: oneLoaded,
          sourceTargetId: "model/base/*",
        },
        {
          id: "model/base/two",
          label: "Two",
          kind: "model_base",
          editable: true,
          runtimeStatus: "active",
          securityClass: "local_user_editable",
          officialHash: hash(two),
          officialText: two,
          effectiveHash: hash(twoLoaded),
          effectiveText: twoLoaded,
          sourceTargetId: "model/base/*",
        },
      ],
    }],
  };
  writeRuntimeFixture(storageRoot, {
    pid: 404,
    loadedAtUnixMs: 4,
    catalog,
    manifestRevision: 0,
    manifestHash: null,
    activeOverrides: [
      { targetId: "model/base/one", sourceTargetId: "model/base/*", effectiveHash: hash(oneLoaded) },
      { targetId: "model/base/two", sourceTargetId: "model/base/*", effectiveHash: hash(twoLoaded) },
    ],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog,
    isPidAlive: (pid) => pid === 404,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  assert.equal(provider.readTarget("model/base/one").loaded, oneLoaded);
  assert.equal(provider.readTarget("model/base/two").loaded, twoLoaded);
  const pattern = provider.readTarget("model/base/*");
  assert.equal(pattern.status, "pattern");
  assert.equal(pattern.effective, null);
  assert.equal(pattern.loaded, null);
});

test("a wildcard manifest never overrides a read-only shadowed model", (t) => {
  const storageRoot = makeStorage(t);
  const official = "Model official.\n";
  const configured = "Explicit configured model prompt.\n";
  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: "model/base/*",
      officialHash: null,
      patches: [{ before: "Model", after: "Wildcard", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: {
      schemaVersion: 1,
      runtimeVersion: "fixture",
      catalogRevision: "shadowed-model",
      groups: [{
        id: "model",
        label: "Models",
        targets: [
          {
            id: "model/base/*",
            label: "All models",
            kind: "model_base",
            editable: false,
            runtimeStatus: "pattern",
            officialText: null,
            officialHash: null,
            effectiveText: null,
            effectiveHash: null,
            targetPattern: "model/base/{modelSlug}",
            sourceTargetId: null,
            readOnlyReason: "This wildcard applies to every model-specific base prompt.",
            overrideStrategy: null,
            overrideConflict: null,
            source: "fixture",
            securityClass: "advanced_pattern",
          },
          {
            id: "model/base/shadowed",
            label: "Shadowed",
            kind: "model_base",
            editable: false,
            runtimeStatus: "shadowed_by_explicit_config",
            officialText: official,
            officialHash: hash(official),
            effectiveText: configured,
            effectiveHash: hash(configured),
            sourceTargetId: null,
            readOnlyReason: "An explicit model instructions config has higher priority.",
            overrideStrategy: null,
            overrideConflict: null,
            securityClass: "config_shadowed",
          },
        ],
      }],
    },
  });
  const detail = provider.readTarget("model/base/shadowed");
  assert.equal(detail.effective, configured);
  assert.equal(detail.overrideHash, "");
  assert.equal(detail.overrideInherited, false);
});

test("a new wildcard manifest applies to editable concrete models while the pattern stays metadata", (t) => {
  const storageRoot = makeStorage(t);
  const official = "Model official.\n";
  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: "model/base/*",
      officialHash: null,
      patches: [{ before: "Model", after: "Wildcard", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: {
      schemaVersion: 1,
      runtimeVersion: "fixture",
      catalogRevision: "pre-restart-wildcard",
      groups: [{
        id: "model",
        label: "Models",
        targets: [
          {
            id: "model/base/*",
            label: "All models",
            kind: "model_base",
            editable: false,
            runtimeStatus: "pattern",
            officialText: null,
            officialHash: null,
            effectiveText: null,
            effectiveHash: null,
            targetPattern: "model/base/{modelSlug}",
            sourceTargetId: null,
            readOnlyReason: "This wildcard applies to every model-specific base prompt.",
            overrideStrategy: null,
            overrideConflict: null,
            source: "fixture",
            securityClass: "advanced_pattern",
          },
          {
            id: "model/base/editable",
            label: "Editable",
            kind: "model_base",
            editable: true,
            runtimeStatus: "cached",
            securityClass: "local_user_editable",
            officialText: official,
            officialHash: hash(official),
            effectiveText: official,
            effectiveHash: hash(official),
            sourceTargetId: null,
            overrideStrategy: "patch",
          },
        ],
      }],
    },
  });
  const concrete = provider.readTarget("model/base/editable");
  assert.equal(concrete.effective, "Wildcard official.\n");
  assert.equal(concrete.overrideInherited, true);
  assert.equal(concrete.status, "pending_next_launch");

  const neutralized = provider.writeOverride({
    targetId: concrete.id,
    catalogRevision: concrete.catalogRevision,
    officialHash: concrete.officialHash,
    overrideHash: concrete.overrideHash,
    effective: concrete.official,
  });
  assert.equal(neutralized.effective, official);
  assert.equal(neutralized.overrideInherited, false);
  assert.equal(neutralized.overrideSourceTargetId, concrete.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(storageRoot, "overrides.json"), "utf8"));
  assert.deepEqual(
    manifest.overrides.map((override) => override.targetId),
    ["model/base/*", "model/base/editable"],
  );
  assert.deepEqual(manifest.overrides[1], {
    targetId: "model/base/editable",
    officialHash: hash(official),
    patches: [{ before: official, after: official, expectedMatches: 1 }],
    replacement: null,
  });

  const pattern = provider.readTarget("model/base/*");
  assert.equal(pattern.status, "pattern");
  assert.equal(pattern.conflict, null);
  assert.notEqual(pattern.overrideHash, "");
});

test("an older immutable catalog snapshot can prove the same target hash without a false mismatch", (t) => {
  const storageRoot = makeStorage(t);
  const runtimeCatalog = fixtureCatalog();
  runtimeCatalog.catalogRevision = hash("older runtime catalog");
  runtimeCatalog.groups = [runtimeCatalog.groups[0]];
  writeRuntimeFixture(storageRoot, {
    pid: 505,
    loadedAtUnixMs: 5,
    catalog: runtimeCatalog,
    manifestRevision: 0,
    manifestHash: null,
    activeOverrides: [],
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 505,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const detail = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.equal(detail.status, "official_loaded");
  assert.equal(detail.loaded, detail.official);
  assert.equal(detail.runtimeCatalogCurrent, false);
  const globalOnly = provider.readTarget("synthetic/contract/read-only");
  assert.equal(globalOnly.status, "catalogued");
  assert.equal(globalOnly.loaded, null);
});

test("receipt v2 strictly binds catalogFile to its PID and raw snapshot hash", (t) => {
  const storageRoot = makeStorage(t);
  const written = writeRuntimeFixture(storageRoot, { pid: 515 });
  secureAtomicWritePromptState(path.join(written.runtimePath, "515.json"), {
    ...written.receipt,
    catalogFile: `../${written.catalogFile}`,
  });
  assert.throws(
    () => readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: (pid) => pid === 515,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    }),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_receipt_invalid",
  );
});

test("receipt v2 runtimeVersion must equal its immutable catalog snapshot", (t) => {
  const storageRoot = makeStorage(t);
  const written = writeRuntimeFixture(storageRoot, { pid: 514 });
  secureAtomicWritePromptState(path.join(written.runtimePath, "514.json"), {
    ...written.receipt,
    runtimeVersion: "different-runtime",
  });
  assert.throws(
    () => readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: (pid) => pid === 514,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    }),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_receipt_invalid",
  );
});

test("receipt v2 binds the exact Darwin process generation before and after snapshot verification", (t) => {
  const mismatchedRoot = makeStorage(t);
  writeRuntimeFixture(mismatchedRoot, {
    pid: 735,
    processStartIdentity: `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:100:000001`,
  });
  let mismatchedSnapshotReads = 0;
  const mismatched = readCodexPromptRuntimeReceipts({
    storageRoot: mismatchedRoot,
    isPidAlive: (pid) => pid === 735,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    getRuntimeProcessStartIdentity: () => (
      `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:100:000002`
    ),
    beforeRuntimeSnapshotRead: () => { mismatchedSnapshotReads += 1; },
  });
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].identityVerified, false);
  assert.equal(mismatched[0].catalog, null);
  assert.equal(mismatchedSnapshotReads, 0);

  const racedRoot = makeStorage(t);
  const processStartIdentity = `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:200:000003`;
  writeRuntimeFixture(racedRoot, {
    pid: 736,
    processStartIdentity,
  });
  const identities = [
    processStartIdentity,
    `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:200:000004`,
  ];
  let identityReads = 0;
  const raced = readCodexPromptRuntimeReceipts({
    storageRoot: racedRoot,
    isPidAlive: (pid) => pid === 736,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    getRuntimeProcessStartIdentity: () => identities[Math.min(identityReads++, identities.length - 1)],
  });
  assert.equal(identityReads, 2);
  assert.equal(raced.length, 1);
  assert.equal(raced[0].identityVerified, false);
  assert.equal(raced[0].catalog, null);

  let unavailableSnapshotReads = 0;
  const unavailable = readCodexPromptRuntimeReceipts({
    storageRoot: racedRoot,
    isPidAlive: (pid) => pid === 736,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    getRuntimeProcessStartIdentity: () => null,
    beforeRuntimeSnapshotRead: () => { unavailableSnapshotReads += 1; },
  });
  assert.equal(unavailable[0].identityVerified, false);
  assert.equal(unavailableSnapshotReads, 0);
});

test("Darwin process identity helper rejects unsafe sizes and invalid process fields", {
  skip: process.platform !== "darwin",
}, () => {
  const harness = String.raw`
import sys

scope = {"__name__": "codex_prompt_identity_test"}
exec(sys.stdin.read(), scope)
ctypes = scope["ctypes"]
canonical_boot_session_uuid = scope["canonical_boot_session_uuid"]
read_boot_session_uuid = scope["read_boot_session_uuid"]
validate_process_info = scope["validate_process_info"]
ProcBsdInfo = scope["ProcBsdInfo"]

def rejected(callback):
    try:
        callback()
    except SystemExit as error:
        assert error.code == 1
        return
    raise AssertionError("expected helper rejection")

class SysctlCall:
    def __init__(self, first_size, second_size=None, payload=None):
        self.first_size = first_size
        self.second_size = first_size if second_size is None else second_size
        self.payload = payload
        self.calls = 0

    def __call__(self, _name, old_value, size_pointer, _new_value, _new_size):
        size = ctypes.cast(size_pointer, ctypes.POINTER(ctypes.c_size_t))
        self.calls += 1
        if old_value is None:
            size.contents.value = self.first_size
            return 0
        if self.payload is not None:
            ctypes.memmove(old_value, self.payload, min(len(self.payload), self.first_size))
        size.contents.value = self.second_size
        return 0

class FakeLibc:
    def __init__(self, call):
        self.sysctlbyname = call

def forbidden_buffer(_size):
    raise AssertionError("buffer allocated for an invalid boot session size")

for invalid_size in (0, 129):
    rejected(lambda size=invalid_size: read_boot_session_uuid(
        FakeLibc(SysctlCall(size)),
        forbidden_buffer,
    ))

rejected(lambda: read_boot_session_uuid(FakeLibc(SysctlCall(37, 0))))
rejected(lambda: read_boot_session_uuid(FakeLibc(SysctlCall(37, 38))))

uppercase_uuid = b"01234567-89AB-CDEF-8123-456789ABCDEF"
payload = uppercase_uuid + b"\0"
assert read_boot_session_uuid(
    FakeLibc(SysctlCall(len(payload), len(payload), payload)),
) == "01234567-89ab-cdef-8123-456789abcdef"
for invalid_uuid in (
    b"\xff",
    b"{01234567-89ab-cdef-8123-456789abcdef}",
    b"0123456789abcdef8123456789abcdef",
):
    rejected(lambda value=invalid_uuid: canonical_boot_session_uuid(value))

def process_info(pid=42, sec=100, usec=5):
    info = ProcBsdInfo()
    info.pbi_pid = pid
    info.pbi_start_tvsec = sec
    info.pbi_start_tvusec = usec
    return info

expected_size = ctypes.sizeof(ProcBsdInfo())
assert validate_process_info(
    42,
    expected_size,
    expected_size,
    process_info(),
) == (100, 5)
rejected(lambda: validate_process_info(42, expected_size - 1, expected_size, process_info()))
rejected(lambda: validate_process_info(42, expected_size, expected_size, process_info(pid=43)))
rejected(lambda: validate_process_info(42, expected_size, expected_size, process_info(sec=0)))
rejected(lambda: validate_process_info(42, expected_size, expected_size, process_info(usec=1000000)))
`;
  execFileSync("/usr/bin/python3", ["-c", harness], {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    input: codexPromptDarwinIdentityHelperSourceForTest(),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 1_000,
  });
});

test("Darwin process identity helper never resolves python3 through PATH", {
  skip: process.platform !== "darwin",
}, (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: process.pid });
  const hostilePath = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hostile-path-"));
  const sentinel = path.join(hostilePath, "executed");
  const hostilePython = path.join(hostilePath, "python3");
  fs.writeFileSync(
    hostilePython,
    `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(sentinel)}\nexit 0\n`,
    { mode: 0o700 },
  );
  t.after(() => fs.rmSync(hostilePath, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = hostilePath;
    const receipts = readRawCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: (pid) => pid === process.pid,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].identityVerified, false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  assert.equal(fs.existsSync(sentinel), false);
});

test("runtime publication state fails closed when absent, insecure, malformed, or not owned by the receipt", (t) => {
  const scenarios = [
    {
      name: "absent",
      mutate(storageRoot) {
        fs.unlinkSync(path.join(storageRoot, ".publication-state.json"));
      },
    },
    {
      name: "invalid JSON",
      mutate(storageRoot) {
        fs.writeFileSync(path.join(storageRoot, ".publication-state.json"), "{not-json\n");
      },
    },
    {
      name: "unknown field",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.unexpected = true;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "unsupported schema",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.schemaVersion = 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "unsafe next generation",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.nextGeneration = Number.MAX_SAFE_INTEGER + 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "global owner not below next generation",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.globalOwnerGeneration = state.nextGeneration;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "missing runtime registry owner",
      mutate(storageRoot, pid) {
        const state = readPublicationStateFixture(storageRoot);
        delete state.runtimeRegistryGenerations[String(pid)];
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "registry and owner PID sets differ",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeRegistryGenerations["920"] = 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "zero runtime registry generation",
      mutate(storageRoot, pid) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeRegistryGenerations[String(pid)] = 0;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "registry generation above owner generation",
      mutate(storageRoot, pid) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeRegistryGenerations[String(pid)]
          = state.runtimeOwnerGenerations[String(pid)] + 1;
        state.nextGeneration = state.runtimeRegistryGenerations[String(pid)] + 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "missing runtime owner",
      mutate(storageRoot, pid) {
        const state = readPublicationStateFixture(storageRoot);
        delete state.runtimeOwnerGenerations[String(pid)];
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "different runtime owner",
      mutate(storageRoot, pid) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeOwnerGenerations[String(pid)]
          = state.runtimeRegistryGenerations[String(pid)];
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "runtime owner not below next generation",
      mutate(storageRoot, pid) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeOwnerGenerations[String(pid)] = state.nextGeneration;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "non-canonical PID key",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeRegistryGenerations["0919"] = 1;
        state.runtimeOwnerGenerations["0919"] = 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "zero PID key",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeRegistryGenerations["0"] = 1;
        state.runtimeOwnerGenerations["0"] = 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "PID key above u32",
      mutate(storageRoot) {
        const state = readPublicationStateFixture(storageRoot);
        state.runtimeRegistryGenerations["4294967296"] = 1;
        state.runtimeOwnerGenerations["4294967296"] = 1;
        writePublicationStateFixture(storageRoot, state);
      },
    },
    {
      name: "wrong mode",
      mutate(storageRoot) {
        fs.chmodSync(path.join(storageRoot, ".publication-state.json"), 0o644);
      },
    },
    {
      name: "symbolic link",
      mutate(storageRoot) {
        const statePath = path.join(storageRoot, ".publication-state.json");
        const targetPath = path.join(storageRoot, "publication-state-target.json");
        fs.renameSync(statePath, targetPath);
        fs.symlinkSync(targetPath, statePath);
      },
    },
    {
      name: "over one MiB",
      mutate(storageRoot) {
        fs.writeFileSync(
          path.join(storageRoot, ".publication-state.json"),
          Buffer.alloc(1_048_577, 0x20),
          { mode: 0o600 },
        );
      },
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const storageRoot = makeStorage(t);
    const pid = 920 + index;
    writeRuntimeFixture(storageRoot, { pid });
    scenario.mutate(storageRoot, pid);
    let snapshotReads = 0;
    const receipts = readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: (candidate) => candidate === pid,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
      beforeRuntimeSnapshotRead: () => { snapshotReads += 1; },
    });
    assert.equal(receipts.length, 1, scenario.name);
    assert.equal(receipts[0].identityVerified, false, scenario.name);
    assert.equal(receipts[0].catalog, null, scenario.name);
    assert.equal(snapshotReads, 0, scenario.name);
  }
});

test("receipt v2 rejects malformed active override records instead of trusting snapshot fallback", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, {
    pid: 516,
    activeOverrides: [{
      targetId: "synthetic/mode/unknown-to-ui",
      sourceTargetId: "synthetic/mode/unknown-to-ui",
      effectiveHash: null,
    }],
  });
  assert.throws(
    () => readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: (pid) => pid === 516,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    }),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_receipt_invalid",
  );
});

test("receipt v2 activeOverrides exactly matches the ordered snapshot-derived set", (t) => {
  const catalog = fixtureCatalog();
  const editable = catalog.groups[0].targets[0];
  editable.effectiveText = editable.officialText.replace("supplied", "runtime-loaded");
  editable.effectiveHash = hash(editable.effectiveText);
  editable.sourceTargetId = editable.id;
  const secondOfficial = "Second editable prompt.\n";
  const second = strictCatalogTarget({
    id: "synthetic/mode/second",
    label: "Second synthetic mode",
    kind: "collaboration",
    editable: true,
    runtimeStatus: "selectable",
    officialText: secondOfficial,
    effectiveText: secondOfficial.replace("editable", "runtime-loaded"),
    sourceTargetId: "synthetic/mode/*",
    readOnlyReason: null,
    overrideStrategy: "patch",
    source: "fixture",
    securityClass: "local_user_editable",
  });
  catalog.groups[0].targets.push(second);
  catalog.groups[0].targets.unshift(strictCatalogTarget({
    id: "model/base/*",
    label: "All models",
    kind: "model_base",
    editable: false,
    runtimeStatus: "pattern",
    officialHash: null,
    officialText: null,
    effectiveHash: null,
    effectiveText: null,
    targetPattern: "model/base/{modelSlug}",
    sourceTargetId: "model/base/*",
    readOnlyReason: "Pattern metadata.",
    overrideStrategy: null,
    source: "fixture",
    securityClass: "advanced_pattern",
  }));
  const expected = [
    {
      targetId: editable.id,
      sourceTargetId: editable.id,
      effectiveHash: editable.effectiveHash,
    },
    {
      targetId: second.id,
      sourceTargetId: second.sourceTargetId,
      effectiveHash: second.effectiveHash,
    },
  ];

  const validStorageRoot = makeStorage(t);
  writeRuntimeFixture(validStorageRoot, { pid: 518, catalog, activeOverrides: expected });
  const valid = readCodexPromptRuntimeReceipts({
    storageRoot: validStorageRoot,
    isPidAlive: (pid) => pid === 518,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  assert.deepEqual(valid[0].activeOverrides, expected);
  assert.equal(
    valid[0].activeOverrides.some((item) => item.targetId === "model/base/*"),
    false,
    "a wildcard with provenance but no effective hash is excluded exactly like Rust",
  );

  const variants = [
    { name: "missing", active: expected.slice(0, 1) },
    {
      name: "extra",
      active: [...expected, {
        targetId: "synthetic/extra",
        sourceTargetId: "synthetic/extra",
        effectiveHash: hash("extra"),
      }],
    },
    { name: "reordered", active: [...expected].reverse() },
    {
      name: "wrong target",
      active: [{ ...expected[0], targetId: "synthetic/wrong" }, expected[1]],
    },
    {
      name: "wrong source",
      active: [{ ...expected[0], sourceTargetId: "synthetic/wrong" }, expected[1]],
    },
    {
      name: "wrong hash",
      active: [{ ...expected[0], effectiveHash: hash("wrong") }, expected[1]],
    },
  ];
  for (const [index, variant] of variants.entries()) {
    const storageRoot = makeStorage(t);
    const pid = 530 + index;
    writeRuntimeFixture(storageRoot, { pid, catalog, activeOverrides: variant.active });
    assert.throws(
      () => readCodexPromptRuntimeReceipts({
        storageRoot,
        isPidAlive: (candidate) => candidate === pid,
        isRuntimeProcess: () => true,
        getRuntimeProcessStartUnixMs: () => 0,
      }),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_receipt_invalid",
      variant.name,
    );
  }
});

test("receipt v2 retries once when snapshot rotation replaces the receipt mid-read", (t) => {
  const storageRoot = makeStorage(t);
  const initialCatalog = fixtureCatalog();
  initialCatalog.runtimeVersion = "before-rotation";
  writeRuntimeFixture(storageRoot, {
    pid: 517,
    catalog: initialCatalog,
    runtimeVersion: "before-rotation",
  });
  let rotated = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 517,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead({ catalogFile }) {
      if (rotated) return;
      rotated = true;
      const nextCatalog = fixtureCatalog();
      nextCatalog.runtimeVersion = "after-rotation";
      const next = writeRuntimeFixture(storageRoot, {
        pid: 517,
        catalog: nextCatalog,
        runtimeVersion: "after-rotation",
      });
      assert.notEqual(next.catalogFile, catalogFile);
    },
  });
  assert.equal(rotated, true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].catalog.codexVersion, "after-rotation");
  assert.equal(receipts[0].codexVersion, "after-rotation");
  assert.equal(
    receipts[0].publicationGeneration,
    readPublicationStateFixture(storageRoot).runtimeOwnerGenerations["517"],
  );
});

test("receipt v2 accepts unrelated publication-state churn while its owner generation stays stable", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 520 });
  let snapshotReads = 0;
  let rotated = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 520,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead() {
      snapshotReads += 1;
      if (rotated) return;
      rotated = true;
      const state = readPublicationStateFixture(storageRoot);
      const nextGlobalOwner = state.nextGeneration;
      const nextUnrelatedOwner = nextGlobalOwner + 1;
      state.nextGeneration = nextUnrelatedOwner + 1;
      state.globalOwnerGeneration = nextGlobalOwner;
      state.runtimeRegistryGenerations["999999"] = nextUnrelatedOwner;
      state.runtimeOwnerGenerations["999999"] = nextUnrelatedOwner;
      writePublicationStateFixture(storageRoot, state);
    },
  });
  assert.equal(snapshotReads, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].identityVerified, true);
  assert.ok(receipts[0].catalog);
});

test("receipt v2 accepts unrelated owner-vector churn between its two final state reads", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 533 });
  writeRuntimeFixture(storageRoot, { pid: 534 });
  const finalReceiptReads = [];
  let churned = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 533 || pid === 534,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeBatchReceiptRead({ pid, batchAttempt }) {
      finalReceiptReads.push([batchAttempt, pid]);
      if (churned) return;
      churned = true;
      const state = readPublicationStateFixture(storageRoot);
      const nextGlobalOwner = state.nextGeneration;
      const nextUnrelatedOwner = nextGlobalOwner + 1;
      state.nextGeneration = nextUnrelatedOwner + 1;
      state.globalOwnerGeneration = nextGlobalOwner;
      state.runtimeRegistryGenerations["999998"] = nextUnrelatedOwner;
      state.runtimeOwnerGenerations["999998"] = nextUnrelatedOwner;
      writePublicationStateFixture(storageRoot, state);
    },
  });
  assert.equal(churned, true);
  assert.deepEqual(finalReceiptReads, [[0, 533], [0, 534]]);
  assert.deepEqual(receipts.map((receipt) => receipt.identityVerified), [true, true]);
});

test("receipt v2 fails closed when a relevant final owner changes on both batch attempts", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 535 });
  writeRuntimeFixture(storageRoot, { pid: 536 });
  const mutatedAttempts = new Set();
  const mutations = [];
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 535 || pid === 536,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeBatchReceiptRead({ pid, batchAttempt }) {
      if (mutatedAttempts.has(batchAttempt)) return;
      mutatedAttempts.add(batchAttempt);
      mutations.push([batchAttempt, pid]);
      const state = readPublicationStateFixture(storageRoot);
      const tombstoneGeneration = state.nextGeneration;
      state.nextGeneration += 1;
      state.runtimeOwnerGenerations[String(pid)] = tombstoneGeneration;
      writePublicationStateFixture(storageRoot, state);
    },
  });
  assert.deepEqual(mutations, [[0, 535], [1, 536]]);
  assert.deepEqual(receipts.map((receipt) => receipt.pid), [535, 536]);
  for (const receipt of receipts) {
    assert.equal(receipt.identityVerified, false);
    assert.equal(receipt.catalog, null);
  }
  assert.match(receipts[0].catalogError.message, /not owned by the current publication generation/);
  assert.match(receipts[1].catalogError.message, /consistent batch/);
});

test("receipt v2 retries the whole batch when runtime A republishes while runtime B is validated", (t) => {
  const storageRoot = makeStorage(t);
  const initialCatalogA = fixtureCatalog();
  initialCatalogA.runtimeVersion = "runtime-a-before";
  writeRuntimeFixture(storageRoot, {
    pid: 522,
    catalog: initialCatalogA,
    runtimeVersion: initialCatalogA.runtimeVersion,
  });
  writeRuntimeFixture(storageRoot, { pid: 523 });
  const snapshotReads = new Map();
  let republishedA = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 522 || pid === 523,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead({ pid }) {
      snapshotReads.set(pid, (snapshotReads.get(pid) || 0) + 1);
      if (pid !== 523 || republishedA) return;
      republishedA = true;
      const nextCatalogA = fixtureCatalog();
      nextCatalogA.runtimeVersion = "runtime-a-after";
      writeRuntimeFixture(storageRoot, {
        pid: 522,
        catalog: nextCatalogA,
        runtimeVersion: nextCatalogA.runtimeVersion,
      });
    },
  });
  assert.equal(republishedA, true);
  assert.deepEqual(
    receipts.map((receipt) => [receipt.pid, receipt.identityVerified, receipt.codexVersion]),
    [
      [522, true, "runtime-a-after"],
      [523, true, fixtureCatalog().runtimeVersion],
    ],
  );
  assert.deepEqual([...snapshotReads.entries()], [[522, 2], [523, 2]]);
  assert.equal(
    receipts[0].publicationGeneration,
    readPublicationStateFixture(storageRoot).runtimeOwnerGenerations["522"],
  );
});

test("receipt v2 fails the whole batch closed when runtime A changes during B on both attempts", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 524 });
  writeRuntimeFixture(storageRoot, { pid: 525 });
  let publications = 0;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 524 || pid === 525,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead({ pid }) {
      if (pid !== 525) return;
      publications += 1;
      const nextCatalogA = fixtureCatalog();
      nextCatalogA.runtimeVersion = `runtime-a-rotation-${publications}`;
      writeRuntimeFixture(storageRoot, {
        pid: 524,
        catalog: nextCatalogA,
        runtimeVersion: nextCatalogA.runtimeVersion,
      });
    },
  });
  assert.equal(publications, 2);
  assert.deepEqual(receipts.map((receipt) => receipt.pid), [524, 525]);
  for (const receipt of receipts) {
    assert.equal(receipt.identityVerified, false);
    assert.equal(receipt.catalog, null);
    assert.match(receipt.catalogError.message, /consistent batch/);
  }
});

test("receipt v2 rereads runtime A byte-exactly when its receipt changes during B without an owner change", (t) => {
  const storageRoot = makeStorage(t);
  const writtenA = writeRuntimeFixture(storageRoot, { pid: 526 });
  writeRuntimeFixture(storageRoot, { pid: 527 });
  const snapshotReads = new Map();
  let rewroteA = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 526 || pid === 527,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead({ pid }) {
      snapshotReads.set(pid, (snapshotReads.get(pid) || 0) + 1);
      if (pid !== 527 || rewroteA) return;
      rewroteA = true;
      const receiptPath = path.join(writtenA.runtimePath, "526.json");
      const changedReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      changedReceipt.loadedAtUnixMs += 1;
      secureAtomicWritePromptState(receiptPath, changedReceipt);
    },
  });
  assert.equal(rewroteA, true);
  assert.deepEqual([...snapshotReads.entries()], [[526, 2], [527, 2]]);
  assert.deepEqual(receipts.map((receipt) => receipt.identityVerified), [true, true]);
  assert.equal(receipts[0].loadedAtUnixMs, writtenA.receipt.loadedAtUnixMs + 1);
  assert.equal(receipts[0].publicationGeneration, writtenA.receipt.publicationGeneration);
});

test("receipt v2 retries the batch and rejects runtime A after its PID identity changes during B", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 528 });
  writeRuntimeFixture(storageRoot, { pid: 529 });
  const initialIdentityA = fixtureProcessStartIdentity(528);
  const replacementIdentityA = (
    `darwin-proc-bsdinfo-v1:${FIXTURE_BOOT_SESSION_UUID}:999:000001`
  );
  let currentIdentityA = initialIdentityA;
  let reusedA = false;
  const snapshotReads = new Map();
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 528 || pid === 529,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    getRuntimeProcessStartIdentity(pid) {
      return pid === 528 ? currentIdentityA : fixtureProcessStartIdentity(pid);
    },
    beforeRuntimeSnapshotRead({ pid }) {
      snapshotReads.set(pid, (snapshotReads.get(pid) || 0) + 1);
      if (pid !== 529 || reusedA) return;
      reusedA = true;
      currentIdentityA = replacementIdentityA;
    },
  });
  assert.equal(reusedA, true);
  assert.deepEqual(receipts.map((receipt) => receipt.pid), [528, 529]);
  assert.equal(receipts[0].identityVerified, false);
  assert.equal(receipts[0].catalog, null);
  assert.match(receipts[0].catalogError.message, /another process generation/);
  assert.equal(receipts[1].identityVerified, true);
  assert.ok(receipts[1].catalog);
  assert.deepEqual([...snapshotReads.entries()], [[528, 1], [529, 2]]);
});

test("receipt v2 retries when the represented runtime process set changes during the batch", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 530 });
  writeRuntimeFixture(storageRoot, { pid: 531 });
  const snapshotReads = new Map();
  let addedRuntime = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 530 || pid === 531 || pid === 532,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead({ pid }) {
      snapshotReads.set(pid, (snapshotReads.get(pid) || 0) + 1);
      if (pid !== 531 || addedRuntime) return;
      addedRuntime = true;
      writeRuntimeFixture(storageRoot, { pid: 532 });
    },
  });
  assert.equal(addedRuntime, true);
  assert.deepEqual(receipts.map((receipt) => receipt.pid), [530, 531, 532]);
  assert.deepEqual(receipts.map((receipt) => receipt.identityVerified), [true, true, true]);
  assert.deepEqual([...snapshotReads.entries()], [[530, 2], [531, 2], [532, 1]]);
});

test("receipt v2 retries when a represented runtime process disappears during final batch verification", (t) => {
  const storageRoot = makeStorage(t);
  writeRuntimeFixture(storageRoot, { pid: 537 });
  writeRuntimeFixture(storageRoot, { pid: 538 });
  let runtimeAAlive = true;
  let disappearedA = false;
  const snapshotReads = new Map();
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive(pid) {
      if (pid === 537) return runtimeAAlive;
      return pid === 538;
    },
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead({ pid }) {
      snapshotReads.set(pid, (snapshotReads.get(pid) || 0) + 1);
    },
    beforeRuntimeBatchReceiptRead({ pid, batchAttempt }) {
      if (batchAttempt !== 0 || pid !== 538 || disappearedA) return;
      disappearedA = true;
      runtimeAAlive = false;
    },
  });
  assert.equal(disappearedA, true);
  assert.deepEqual(receipts.map((receipt) => receipt.pid), [538]);
  assert.equal(receipts[0].identityVerified, true);
  assert.deepEqual([...snapshotReads.entries()], [[537, 1], [538, 2]]);
});

test("a publication tombstone makes an in-flight old receipt unverified", (t) => {
  const storageRoot = makeStorage(t);
  const written = writeRuntimeFixture(storageRoot, { pid: 521 });
  let tombstoned = false;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 521,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead() {
      if (tombstoned) return;
      tombstoned = true;
      const state = readPublicationStateFixture(storageRoot);
      const tombstoneGeneration = state.nextGeneration;
      state.nextGeneration += 1;
      state.runtimeOwnerGenerations["521"] = tombstoneGeneration;
      writePublicationStateFixture(storageRoot, state);
      fs.unlinkSync(path.join(written.runtimePath, "521.json"));
    },
  });
  assert.equal(tombstoned, true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].identityVerified, false);
  assert.equal(receipts[0].catalog, null);
  assert.match(receipts[0].catalogError.message, /removed while its publication was being verified/);
});

test("receipt v2 becomes unverified when the receipt changes on both bounded snapshot reads", (t) => {
  const storageRoot = makeStorage(t);
  const initialCatalog = fixtureCatalog();
  initialCatalog.runtimeVersion = "rotation-zero";
  writeRuntimeFixture(storageRoot, {
    pid: 519,
    catalog: initialCatalog,
    runtimeVersion: initialCatalog.runtimeVersion,
  });
  let rotations = 0;
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 519,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
    beforeRuntimeSnapshotRead() {
      rotations += 1;
      const nextCatalog = fixtureCatalog();
      nextCatalog.runtimeVersion = `rotation-${rotations}`;
      writeRuntimeFixture(storageRoot, {
        pid: 519,
        catalog: nextCatalog,
        runtimeVersion: nextCatalog.runtimeVersion,
      });
    },
  });
  assert.equal(rotations, 2);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].identityVerified, false);
  assert.equal(receipts[0].catalog, null);
  assert.match(receipts[0].catalogError.message, /changed repeatedly/);
});

test("a missing, insecure, or mismatched runtime catalog snapshot yields unverified per-target state", (t) => {
  const cases = [
    {
      name: "missing",
      mutate({ runtimePath, catalogFile }) {
        fs.unlinkSync(path.join(runtimePath, catalogFile));
      },
    },
    {
      name: "wrong mode",
      mutate({ runtimePath, catalogFile }) {
        fs.chmodSync(path.join(runtimePath, catalogFile), 0o644);
      },
    },
    {
      name: "tampered bytes",
      mutate({ runtimePath, catalogFile }) {
        fs.appendFileSync(path.join(runtimePath, catalogFile), " ");
      },
    },
    {
      name: "symlink",
      mutate({ runtimePath, catalogFile }) {
        const sourcePath = path.join(runtimePath, "snapshot-source.json");
        secureAtomicWritePromptState(sourcePath, fixtureCatalog());
        fs.unlinkSync(path.join(runtimePath, catalogFile));
        fs.symlinkSync(sourcePath, path.join(runtimePath, catalogFile));
      },
    },
    {
      name: "revision mismatch",
      mutate({ runtimePath, receipt }) {
        secureAtomicWritePromptState(path.join(runtimePath, `${receipt.pid}.json`), {
          ...receipt,
          catalogRevision: hash("different logical revision"),
        });
      },
    },
    {
      name: "invalid logical revision with a matching raw hash",
      mutate({ runtimePath, catalogFile, receipt }) {
        const snapshot = JSON.parse(fs.readFileSync(path.join(runtimePath, catalogFile), "utf8"));
        snapshot.groups[0].label = "Tampered group label";
        const snapshotBytes = `${JSON.stringify(snapshot, null, 2)}\n`;
        const catalogHash = hash(snapshotBytes);
        const nextCatalogFile = `${receipt.pid}.${catalogHash.slice("sha256:".length)}.catalog.json`;
        secureAtomicWritePromptState(path.join(runtimePath, nextCatalogFile), snapshot);
        secureAtomicWritePromptState(path.join(runtimePath, `${receipt.pid}.json`), {
          ...receipt,
          catalogFile: nextCatalogFile,
          catalogHash,
        });
      },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const storageRoot = makeStorage(t);
    const pid = 520 + index;
    const written = writeRuntimeFixture(storageRoot, { pid });
    scenario.mutate(written);
    const receipts = readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: (candidate) => candidate === pid,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    });
    assert.equal(receipts.length, 1, scenario.name);
    assert.equal(receipts[0].catalog, null, scenario.name);
    assert.equal(Boolean(receipts[0].catalogError), true, scenario.name);
    const provider = createCodexPromptCenterProvider({
      storageRoot,
      catalog: fixtureCatalog(),
      isPidAlive: (candidate) => candidate === pid,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    });
    assert.equal(provider.readTarget("synthetic/mode/unknown-to-ui").status, "unverified_runtime", scenario.name);
  }
});

test("PID reuse cannot make a stale Codex receipt count as runtime loaded", (t) => {
  const storageRoot = makeStorage(t);
  const processStartedAtUnixMs = Date.now();
  const written = writeRuntimeFixture(storageRoot, {
    pid: 818,
    loadedAtUnixMs: processStartedAtUnixMs - 10_000,
  });
  const staleTime = new Date(processStartedAtUnixMs - 10_000);
  fs.utimesSync(path.join(written.runtimePath, "818.json"), staleTime, staleTime);
  fs.utimesSync(path.join(written.runtimePath, written.catalogFile), staleTime, staleTime);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 818,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => processStartedAtUnixMs,
  });
  const detail = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.equal(detail.status, "unverified_runtime");
  assert.equal(detail.loaded, null);

  const oneSecondStaleStorageRoot = makeStorage(t);
  const oneSecondStale = writeRuntimeFixture(oneSecondStaleStorageRoot, {
    pid: 819,
    loadedAtUnixMs: processStartedAtUnixMs - 1_000,
  });
  const oneSecondStaleTime = new Date(processStartedAtUnixMs - 1_000);
  fs.utimesSync(path.join(oneSecondStale.runtimePath, "819.json"), oneSecondStaleTime, oneSecondStaleTime);
  fs.utimesSync(
    path.join(oneSecondStale.runtimePath, oneSecondStale.catalogFile),
    oneSecondStaleTime,
    oneSecondStaleTime,
  );
  const oneSecondStaleProvider = createCodexPromptCenterProvider({
    storageRoot: oneSecondStaleStorageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 819,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => processStartedAtUnixMs,
  });
  assert.equal(oneSecondStaleProvider.readTarget("synthetic/mode/unknown-to-ui").status, "unverified_runtime");
});

test("receipt and snapshot freshness use the same opened inode as their bytes", (t) => {
  const processStartedAtUnixMs = Date.now();
  const staleTime = new Date(processStartedAtUnixMs - 10_000);

  const receiptRoot = makeStorage(t);
  const receiptFixture = writeRuntimeFixture(receiptRoot, {
    pid: 820,
    loadedAtUnixMs: processStartedAtUnixMs,
  });
  const receiptPath = path.join(receiptFixture.runtimePath, "820.json");
  const staleReceiptPath = path.join(receiptFixture.runtimePath, "stale-receipt.json");
  const parkedReceiptPath = path.join(receiptFixture.runtimePath, "fresh-receipt.json");
  fs.copyFileSync(receiptPath, staleReceiptPath);
  fs.chmodSync(staleReceiptPath, 0o600);
  fs.utimesSync(staleReceiptPath, staleTime, staleTime);

  const originalOpenSync = fs.openSync;
  let receiptSwapped = false;
  fs.openSync = function swapReceiptBeforeOpen(candidate, ...rest) {
    if (!receiptSwapped && candidate === receiptPath) {
      receiptSwapped = true;
      fs.renameSync(receiptPath, parkedReceiptPath);
      fs.renameSync(staleReceiptPath, receiptPath);
    }
    return originalOpenSync.call(fs, candidate, ...rest);
  };
  let receiptRecords;
  try {
    receiptRecords = readCodexPromptRuntimeReceipts({
      storageRoot: receiptRoot,
      isPidAlive: (pid) => pid === 820,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => processStartedAtUnixMs,
    });
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(receiptSwapped, true);
  assert.equal(receiptRecords[0].identityVerified, false);
  assert.match(receiptRecords[0].catalogError.message, /predates the current process start/);

  const snapshotRoot = makeStorage(t);
  const snapshotFixture = writeRuntimeFixture(snapshotRoot, {
    pid: 821,
    loadedAtUnixMs: processStartedAtUnixMs,
  });
  const snapshotPath = path.join(snapshotFixture.runtimePath, snapshotFixture.catalogFile);
  const staleSnapshotPath = path.join(snapshotFixture.runtimePath, "stale-snapshot.json");
  const parkedSnapshotPath = path.join(snapshotFixture.runtimePath, "fresh-snapshot.json");
  fs.copyFileSync(snapshotPath, staleSnapshotPath);
  fs.chmodSync(staleSnapshotPath, 0o600);
  fs.utimesSync(staleSnapshotPath, staleTime, staleTime);

  let snapshotSwapped = false;
  fs.openSync = function swapSnapshotBeforeOpen(candidate, ...rest) {
    if (!snapshotSwapped && candidate === snapshotPath) {
      snapshotSwapped = true;
      fs.renameSync(snapshotPath, parkedSnapshotPath);
      fs.renameSync(staleSnapshotPath, snapshotPath);
    }
    return originalOpenSync.call(fs, candidate, ...rest);
  };
  let snapshotRecords;
  try {
    snapshotRecords = readCodexPromptRuntimeReceipts({
      storageRoot: snapshotRoot,
      isPidAlive: (pid) => pid === 821,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => processStartedAtUnixMs,
    });
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(snapshotSwapped, true);
  assert.equal(snapshotRecords[0].identityVerified, true);
  assert.equal(snapshotRecords[0].catalog, null);
  assert.equal(snapshotRecords[0].catalogError.code, "codex_prompt_runtime_catalog_stale");
});

test("a receipt owned by a reused non-Codex PID is ignored before schema validation", (t) => {
  const storageRoot = makeStorage(t);
  const runtimePath = path.join(storageRoot, "runtime");
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimePath, { mode: 0o700 });
  secureAtomicWritePromptState(path.join(runtimePath, "808.json"), {
    schemaVersion: 99,
    pid: 808,
  });
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 808,
    isRuntimeProcess: () => false,
  });
  assert.deepEqual(readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive: (pid) => pid === 808,
    isRuntimeProcess: () => false,
  }), []);
  const detail = provider.readTarget("synthetic/mode/unknown-to-ui");
  assert.equal(detail.status, "not_running");
  assert.equal(detail.runtimeIdentityVerified, null);
  assert.equal(detail.loaded, null);
});

test("a stale global manifest does not require restart for an unchanged target with the desired loaded hash", (t) => {
  const storageRoot = makeStorage(t);
  const catalog = fixtureCatalog();
  const unchangedOfficial = "Unchanged independent prompt.\n";
  catalog.groups[0].targets.push(strictCatalogTarget({
    id: "synthetic/mode/unchanged",
    label: "Unchanged synthetic mode",
    kind: "collaboration",
    editable: true,
    runtimeStatus: "selectable",
    officialText: unchangedOfficial,
    effectiveText: unchangedOfficial,
    readOnlyReason: null,
    overrideStrategy: "patch",
    source: "fixture",
    securityClass: "local_user_editable",
  }));
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog,
    isPidAlive: (pid) => pid === 606,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const edited = provider.readTarget("synthetic/mode/unknown-to-ui");
  provider.writeOverride({
    targetId: edited.id,
    catalogRevision: edited.catalogRevision,
    officialHash: edited.officialHash,
    overrideHash: edited.overrideHash,
    effective: edited.effective.replace("supplied", "verified"),
  });
  writeRuntimeFixture(storageRoot, {
    pid: 606,
    loadedAtUnixMs: 6,
    catalog,
    manifestRevision: 0,
    manifestHash: null,
    activeOverrides: [],
  });
  const unchanged = provider.readTarget("synthetic/mode/unchanged");
  assert.equal(unchanged.status, "official_loaded");
  assert.equal(unchanged.restartRequired, false);
  assert.equal(unchanged.runtimeManifestCurrent, false);
});

test("a committed save or restore stays successful when runtime publication proof is unverified", (t) => {
  const storageRoot = makeStorage(t);
  const provider = createCodexPromptCenterProvider({
    storageRoot,
    catalog: fixtureCatalog(),
    isPidAlive: (pid) => pid === 707,
    isRuntimeProcess: () => true,
    getRuntimeProcessStartUnixMs: () => 0,
  });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const runtimePath = path.join(storageRoot, "runtime");
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(storageRoot, 0o700);
  fs.mkdirSync(runtimePath, { recursive: true, mode: 0o700 });
  secureAtomicWritePromptState(path.join(runtimePath, "707.json"), {
    schemaVersion: 99,
    pid: 707,
    loadedAtUnixMs: 7,
    activeOverrides: [],
  });
  const saved = provider.writeOverride({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: target.overrideHash,
    effective: target.effective.replace("supplied", "verified"),
  });
  assert.equal(Object.hasOwn(saved, "commitWarning"), false);
  assert.equal(saved.status, "unverified_runtime");
  assert.equal(saved.runtimeIdentityVerified, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storageRoot, "overrides.json"), "utf8")).overrides.length, 1);

  const restored = provider.deleteOverride({
    targetId: saved.id,
    catalogRevision: saved.catalogRevision,
    officialHash: saved.officialHash,
    overrideHash: saved.overrideHash,
  });
  assert.equal(Object.hasOwn(restored, "commitWarning"), false);
  assert.equal(restored.status, "unverified_runtime");
  assert.equal(restored.runtimeIdentityVerified, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storageRoot, "overrides.json"), "utf8")).overrides.length, 0);
});

test("prompt storage refuses symlinked roots and receipt files", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-codex-prompts-symlink-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const realRoot = path.join(base, "real");
  const linkedRoot = path.join(base, "linked");
  fs.mkdirSync(realRoot, { mode: 0o700 });
  fs.symlinkSync(realRoot, linkedRoot, "dir");
  assert.throws(
    () => secureAtomicWritePromptState(path.join(linkedRoot, "overrides.json"), { schemaVersion: 1 }),
    (error) => error.code === "codex_prompt_symlink_refused",
  );

  const deepRealRoot = path.join(base, "deep-real");
  const deepLinkedAncestor = path.join(base, "deep-linked");
  fs.mkdirSync(deepRealRoot, { mode: 0o700 });
  fs.symlinkSync(deepRealRoot, deepLinkedAncestor, "dir");
  const deeplyNestedStorage = path.join(
    deepLinkedAncestor,
    "one",
    "two",
    "three",
    "four",
    "prompt-overrides",
  );
  assert.throws(
    () => secureAtomicWritePromptState(path.join(deeplyNestedStorage, "overrides.json"), { schemaVersion: 1 }),
    (error) => error.code === "codex_prompt_symlink_refused",
  );
  assert.equal(fs.existsSync(path.join(deepRealRoot, "one")), false);

  const runtimePath = path.join(realRoot, "runtime");
  fs.mkdirSync(runtimePath, { mode: 0o700 });
  fs.writeFileSync(path.join(base, "receipt.json"), "{}\n");
  fs.symlinkSync(path.join(base, "receipt.json"), path.join(runtimePath, "606.json"));
  assert.throws(
    () => readCodexPromptRuntimeReceipts({
      storageRoot: realRoot,
      isPidAlive: (pid) => pid === 606,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    }),
    (error) => error.code === "codex_prompt_receipt_invalid",
  );
});

test("prompt data readers reject invalid UTF-8 and stay bound to one opened inode", (t) => {
  const invalidRoot = makeStorage(t);
  fs.mkdirSync(invalidRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(invalidRoot, "catalog.json"),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    { mode: 0o600 },
  );
  assert.throws(
    () => createCodexPromptCenterProvider({ storageRoot: invalidRoot }).readSummary(),
    (error) => (
      error.statusCode === 503
      && error.code === "codex_prompt_data_invalid"
      && /valid UTF-8/.test(error.message)
    ),
  );

  const stableRoot = makeStorage(t);
  const catalogPath = path.join(stableRoot, "catalog.json");
  const parkedPath = path.join(stableRoot, "catalog.opened.json");
  secureAtomicWritePromptState(catalogPath, fixtureCatalog());
  const originalFstatSync = fs.fstatSync;
  let swapped = false;
  fs.fstatSync = function fstatAfterPathSwap(descriptor, ...rest) {
    const stat = originalFstatSync.call(fs, descriptor, ...rest);
    if (!swapped) {
      swapped = true;
      fs.renameSync(catalogPath, parkedPath);
      fs.symlinkSync(parkedPath, catalogPath);
    }
    return stat;
  };
  try {
    const summary = createCodexPromptCenterProvider({ storageRoot: stableRoot }).readSummary();
    assert.equal(summary.codexVersion, "test-runtime");
  } finally {
    fs.fstatSync = originalFstatSync;
  }
  assert.equal(swapped, true);
  assert.equal(fs.lstatSync(catalogPath).isSymbolicLink(), true);
});

test("prompt storage reads require private 0700 directories and 0600 persisted files", (t) => {
  const insecureRoot = makeStorage(t);
  fs.mkdirSync(path.join(insecureRoot, "runtime"), { recursive: true, mode: 0o700 });
  fs.chmodSync(insecureRoot, 0o755);
  assert.throws(
    () => readCodexPromptRuntimeReceipts({ storageRoot: insecureRoot }),
    (error) => error.code === "codex_prompt_storage_permissions_invalid",
  );

  const insecureRuntimeRoot = makeStorage(t);
  fs.mkdirSync(insecureRuntimeRoot, { recursive: true, mode: 0o700 });
  const insecureRuntime = path.join(insecureRuntimeRoot, "runtime");
  fs.mkdirSync(insecureRuntime, { mode: 0o700 });
  fs.chmodSync(insecureRuntime, 0o755);
  assert.throws(
    () => readCodexPromptRuntimeReceipts({ storageRoot: insecureRuntimeRoot }),
    (error) => error.code === "codex_prompt_storage_permissions_invalid",
  );

  const insecureCatalogRoot = makeStorage(t);
  secureAtomicWritePromptState(path.join(insecureCatalogRoot, "catalog.json"), fixtureCatalog());
  fs.chmodSync(path.join(insecureCatalogRoot, "catalog.json"), 0o644);
  assert.throws(
    () => createCodexPromptCenterProvider({ storageRoot: insecureCatalogRoot }).readSummary(),
    (error) => error.code === "codex_prompt_storage_permissions_invalid",
  );

  const insecureOverridesRoot = makeStorage(t);
  secureAtomicWritePromptState(path.join(insecureOverridesRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 0,
    overrides: [],
  });
  fs.chmodSync(path.join(insecureOverridesRoot, "overrides.json"), 0o644);
  assert.throws(
    () => createCodexPromptCenterProvider({
      storageRoot: insecureOverridesRoot,
      catalog: fixtureCatalog(),
    }).readSummary(),
    (error) => error.code === "codex_prompt_storage_permissions_invalid",
  );

  const insecureReceiptRoot = makeStorage(t);
  const written = writeRuntimeFixture(insecureReceiptRoot, { pid: 607 });
  fs.chmodSync(path.join(written.runtimePath, "607.json"), 0o644);
  assert.throws(
    () => readCodexPromptRuntimeReceipts({
      storageRoot: insecureReceiptRoot,
      isPidAlive: (pid) => pid === 607,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    }),
    (error) => error.code === "codex_prompt_receipt_invalid",
  );
});

test("unsupported protocol and prompts over the 28 KiB runtime limit are rejected", (t) => {
  assert.equal(MAX_CODEX_PROMPT_BYTES, 28 * 1024);
  assert.equal(MAX_CODEX_PROMPT_ESTIMATED_TOKENS, 8_192);
  assert.equal(CODEX_PROMPT_HIGH_CONTEXT_CONFIRM_TOKENS, 1_000);
  assert.equal(estimateCodexPromptTokens("éé"), 1);
  const storageRoot = makeStorage(t);
  assert.throws(
    () => createCodexPromptCenterProvider({
      storageRoot,
      catalog: { schemaVersion: 99, groups: [] },
    }).readSummary(),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_protocol_unsupported",
  );
  assert.throws(
    () => createCodexPromptCenterProvider({
      storageRoot,
      catalog: {
        schemaVersion: 1,
        groups: [{
          id: "invalid",
          label: "Invalid",
          targets: [{
            id: "invalid/editable",
            label: "Invalid editable",
            editable: true,
            runtimeStatus: "active",
            securityClass: "local_user_editable",
            officialText: "Published without a hash.",
            officialHash: null,
            effectiveText: "Published without a hash.",
            effectiveHash: hash("Published without a hash."),
          }],
        }],
      },
    }).readSummary(),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_invalid_catalog",
  );
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog: fixtureCatalog() });
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const requiredToken = "{{SYNTHETIC_TOKEN}}";
  const maxSizedPrompt = requiredToken + "x".repeat(MAX_CODEX_PROMPT_BYTES - requiredToken.length);
  const validation = provider.validateDraft({
    targetId: target.id,
    catalogRevision: target.catalogRevision,
    officialHash: target.officialHash,
    overrideHash: "",
    effective: maxSizedPrompt,
  });
  assert.equal(validation.bytes, MAX_CODEX_PROMPT_BYTES);
  assert.equal(validation.estimatedTokens, Math.ceil(MAX_CODEX_PROMPT_BYTES / 4));
  assert.equal(validation.maxEstimatedTokens, MAX_CODEX_PROMPT_ESTIMATED_TOKENS);
  assert.throws(
    () => provider.validateDraft({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: "",
      effective: "x".repeat(MAX_CODEX_PROMPT_BYTES + 1),
    }),
    (error) => error.statusCode === 413 && error.code === "codex_prompt_too_large",
  );

  writeRuntimeFixture(storageRoot, {
    pid: 404,
    receiptOverrides: { schemaVersion: 99 },
  });
  assert.throws(
    () => readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive: () => true,
      isRuntimeProcess: () => true,
      getRuntimeProcessStartUnixMs: () => 0,
    }),
    (error) => error.statusCode === 503 && error.code === "codex_prompt_protocol_unsupported",
  );
});

test("prompt text remains byte-exact and manifests match the strict Rust shape", (t) => {
  const storageRoot = makeStorage(t);
  const official = "first\r\nsecond\r\n";
  const catalog = {
    schemaVersion: 1,
    runtimeVersion: "fixture",
    catalogRevision: "crlf-fixture",
    groups: [{
      id: "exact",
      label: "Exact",
      targets: [{
        id: "synthetic/exact",
        label: "Exact prompt",
        kind: "developer",
        editable: true,
        runtimeStatus: "active",
        securityClass: "local_user_editable",
        officialText: official,
        officialHash: hash(official),
        effectiveText: official,
        effectiveHash: hash(official),
        overrideStrategy: "patch",
      }],
    }],
  };
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog });
  const target = provider.readTarget("synthetic/exact");
  assert.equal(target.official, official);
  assert.equal(target.officialHash, hash(official));

  const invalidStates = [
    {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: target.id,
        officialHash: target.officialHash,
        patches: [{ before: "first", after: "changed", expectedMatches: 2 }],
        replacement: null,
      }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: target.id,
        officialHash: target.officialHash,
        patches: [{ before: "first", after: "changed", expectedMatches: 1 }],
        replacement: "also replacement",
      }],
    },
    {
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: target.id,
        officialHash: target.officialHash,
        patches: [{ before: "first", after: "changed", expectedMatches: 1 }],
        replacement: null,
        unsupported: true,
      }],
    },
    ...[
      { before: "first", expectedMatches: 1 },
      { before: 1, after: "changed", expectedMatches: 1 },
      { before: "first", after: 1, expectedMatches: 1 },
      { before: "first", after: "changed", expectedMatches: "1" },
      { before: "first", after: "changed", expectedMatches: 1.5 },
    ].map((patch) => ({
      schemaVersion: 1,
      revision: 1,
      overrides: [{
        targetId: target.id,
        officialHash: target.officialHash,
        patches: [patch],
        replacement: null,
      }],
    })),
  ];
  for (const state of invalidStates) {
    secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), state);
    assert.throws(
      () => provider.readSummary(),
      (error) => error.statusCode === 503 && error.code === "codex_prompt_override_invalid",
    );
  }

  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: "synthetic/absent",
      officialHash: hash("Absent.\n"),
      patches: [{ before: "Absent", after: "Changed", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  const orphanedSummary = provider.readSummary();
  const orphanedGroup = orphanedSummary.groups.find((group) => group.id === "orphaned-overrides");
  assert.equal(orphanedGroup.targets.length, 1);
  assert.equal(orphanedGroup.targets[0].status, "conflict");
  const orphaned = provider.readTarget("synthetic/absent");
  assert.equal(orphaned.conflict.code, "codex_prompt_override_target_unknown");
  assert.notEqual(orphaned.overrideHash, "");
  assert.throws(
    () => provider.validateDraft({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: "",
      effective: target.effective,
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_manifest_conflict",
  );
  const removedOrphan = provider.deleteOverride({
    targetId: orphaned.id,
    catalogRevision: orphaned.catalogRevision,
    officialHash: orphaned.officialHash,
    overrideHash: orphaned.overrideHash,
  });
  assert.equal(removedOrphan.overrideHash, "");
  assert.equal(provider.readSummary().groups.some((group) => group.id === "orphaned-overrides"), false);

  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: target.id,
      officialHash: target.officialHash,
      patches: [],
      replacement: "Wrong strategy.\r\n",
    }],
  });
  const incompatibleSummary = provider.readSummary();
  assert.equal(incompatibleSummary.summary.conflicts, 1);
  const incompatible = provider.readTarget(target.id);
  assert.equal(incompatible.status, "conflict");
  assert.equal(incompatible.conflict.code, "codex_prompt_override_strategy_changed");
  assert.throws(
    () => provider.validateDraft({
      targetId: target.id,
      catalogRevision: incompatible.catalogRevision,
      officialHash: incompatible.officialHash,
      overrideHash: incompatible.overrideHash,
      effective: incompatible.official,
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_manifest_conflict",
  );
  assert.equal(provider.deleteOverride({
    targetId: incompatible.id,
    catalogRevision: incompatible.catalogRevision,
    officialHash: incompatible.officialHash,
    overrideHash: incompatible.overrideHash,
  }).overrideHash, "");
});

test("an exact override shadowed by a later read-only catalog target remains removable", (t) => {
  const storageRoot = makeStorage(t);
  const catalog = fixtureCatalog();
  const source = catalog.groups[0].targets[0];
  const unrelated = {
    ...structuredClone(source),
    id: "synthetic/mode/unrelated",
    label: "Unrelated editable mode",
  };
  catalog.groups[0].targets.push(unrelated);
  secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), {
    schemaVersion: 1,
    revision: 1,
    overrides: [{
      targetId: source.id,
      officialHash: source.officialHash,
      patches: [{ before: "supplied", after: "verified", expectedMatches: 1 }],
      replacement: null,
    }],
  });
  source.kind = "developer";
  source.editable = false;
  source.runtimeStatus = "shadowed_by_explicit_config";
  source.readOnlyReason = "Explicit configuration shadows this target.";
  source.securityClass = "config_shadowed";
  source.sourceTargetId = null;
  source.overrideStrategy = null;
  source.overrideConflict = null;
  source.effectiveText = "Explicit configuration.\n";
  source.effectiveHash = hash(source.effectiveText);
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog });
  const detail = provider.readTarget(source.id);
  assert.equal(detail.status, "conflict");
  assert.equal(detail.conflict.code, "codex_prompt_override_target_read_only");
  assert.equal(detail.editable, false);
  assert.equal(detail.effective, source.effectiveText);
  assert.notEqual(detail.overrideHash, "");
  assert.equal(provider.readSummary().summary.conflicts, 1);

  const unrelatedDetail = provider.readTarget(unrelated.id);
  assert.throws(
    () => provider.validateDraft({
      targetId: unrelatedDetail.id,
      catalogRevision: unrelatedDetail.catalogRevision,
      officialHash: unrelatedDetail.officialHash,
      overrideHash: unrelatedDetail.overrideHash,
      effective: unrelatedDetail.effective,
    }),
    (error) => error.statusCode === 409 && error.code === "codex_prompt_manifest_conflict",
  );

  const restored = provider.deleteOverride({
    targetId: detail.id,
    catalogRevision: detail.catalogRevision,
    officialHash: detail.officialHash,
    overrideHash: detail.overrideHash,
  });
  assert.equal(restored.overrideHash, "");
  assert.equal(provider.readSummary().summary.conflicts, 0);
});

test("atomic prompt writes clean temporary files after pre-rename failures", (t) => {
  const scenarios = [
    {
      name: "write",
      method: "writeFileSync",
      patch(original) {
        return function failWrite() {
          throw new Error("synthetic write failure");
        };
      },
    },
    {
      name: "fsync",
      method: "fsyncSync",
      patch(original) {
        return function failFsync() {
          throw new Error("synthetic fsync failure");
        };
      },
    },
    {
      name: "close",
      method: "closeSync",
      patch(original) {
        return function closeThenFail(...args) {
          original.apply(fs, args);
          throw new Error("synthetic close failure");
        };
      },
    },
  ];
  for (const scenario of scenarios) {
    const storageRoot = makeStorage(t);
    const targetPath = path.join(storageRoot, "state.json");
    secureAtomicWritePromptState(targetPath, { version: "old" });
    const original = fs[scenario.method];
    fs[scenario.method] = scenario.patch(original);
    try {
      assert.throws(
        () => secureAtomicWritePromptState(targetPath, { version: "new" }),
        new RegExp(`synthetic ${scenario.name} failure`),
      );
    } finally {
      fs[scenario.method] = original;
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), { version: "old" });
    assert.deepEqual(
      fs.readdirSync(storageRoot).filter((name) => name.endsWith(".tmp")),
      [],
      scenario.name,
    );
  }
});

test("post-rename atomic finalization failures keep the committed state and return warnings", (t) => {
  const scenarios = [
    {
      name: "permission",
      method: "chmodSync",
      patch(original, targetPath) {
        return function failTargetChmod(candidate, ...rest) {
          if (candidate === targetPath) throw new Error("synthetic chmod failure");
          return original.call(fs, candidate, ...rest);
        };
      },
    },
    {
      name: "directory durability",
      method: "fsyncSync",
      patch(original) {
        let calls = 0;
        return function failSecondFsync(...args) {
          calls += 1;
          if (calls === 2) throw new Error("synthetic directory fsync failure");
          return original.apply(fs, args);
        };
      },
    },
    {
      name: "directory handle",
      method: "closeSync",
      patch(original) {
        let calls = 0;
        return function failSecondClose(...args) {
          calls += 1;
          const result = original.apply(fs, args);
          if (calls === 2) throw new Error("synthetic directory close failure");
          return result;
        };
      },
    },
  ];
  for (const scenario of scenarios) {
    const storageRoot = makeStorage(t);
    const targetPath = path.join(storageRoot, "state.json");
    const original = fs[scenario.method];
    fs[scenario.method] = scenario.patch(original, targetPath);
    let result;
    try {
      result = secureAtomicWritePromptState(targetPath, { version: "committed" });
    } finally {
      fs[scenario.method] = original;
    }
    assert.equal(result.committed, true, scenario.name);
    assert.match(result.commitWarning, /committed/, scenario.name);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), { version: "committed" });
    assert.deepEqual(fs.readdirSync(storageRoot).filter((name) => name.endsWith(".tmp")), []);
  }
});

test("save and restore surface post-rename warnings without reclassifying committed state", (t) => {
  const { storageRoot, provider } = providerFixture(t);
  const target = provider.readTarget("synthetic/mode/unknown-to-ui");
  const overridesPath = path.join(storageRoot, "overrides.json");
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = function failManifestChmod(candidate, ...rest) {
    if (candidate === overridesPath) throw new Error("synthetic manifest chmod failure");
    return originalChmodSync.call(fs, candidate, ...rest);
  };
  let saved;
  try {
    saved = provider.writeOverride({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    });
  } finally {
    fs.chmodSync = originalChmodSync;
  }
  assert.match(saved.commitWarning, /permission finalization failed/);
  assert.equal(JSON.parse(fs.readFileSync(overridesPath, "utf8")).revision, 1);

  fs.chmodSync = function failManifestChmod(candidate, ...rest) {
    if (candidate === overridesPath) throw new Error("synthetic manifest chmod failure");
    return originalChmodSync.call(fs, candidate, ...rest);
  };
  let restored;
  try {
    restored = provider.deleteOverride({
      targetId: saved.id,
      catalogRevision: saved.catalogRevision,
      officialHash: saved.officialHash,
      overrideHash: saved.overrideHash,
    });
  } finally {
    fs.chmodSync = originalChmodSync;
  }
  assert.match(restored.commitWarning, /permission finalization failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(overridesPath, "utf8")).overrides, []);
});

test("atomic prompt state refuses an aggregate manifest over 16 MiB", (t) => {
  const storageRoot = makeStorage(t);
  const chunks = Array.from({
    length: Math.ceil(MAX_CODEX_PROMPT_MANIFEST_BYTES / MAX_CODEX_PROMPT_BYTES) + 1,
  }, () => "x".repeat(MAX_CODEX_PROMPT_BYTES));
  assert.throws(
    () => secureAtomicWritePromptState(path.join(storageRoot, "overrides.json"), { chunks }),
    (error) => (
      error.statusCode === 413
      && error.code === "codex_prompt_manifest_too_large"
      && error.details.maxBytes === MAX_CODEX_PROMPT_MANIFEST_BYTES
    ),
  );
  assert.equal(fs.existsSync(path.join(storageRoot, "overrides.json")), false);
});

test("Prompt Center refresh replaces clean drafts while preserving unsaved drafts", async () => {
  const script = inlineAppScript();
  const source = script.slice(
    script.indexOf("function reconcileCodexPromptCaches"),
    script.indexOf("async function saveCodexPromptOverride"),
  );
  const state = {
    contextHubView: "codex-prompts",
    codexPrompts: {
      groups: [{
        id: "synthetic",
        label: "Synthetic",
        targets: [{ id: "synthetic/a" }, { id: "synthetic/b" }],
      }],
    },
    codexPromptSelection: "synthetic/a",
    codexPromptDetails: new Map([
      ["synthetic/a", { id: "synthetic/a", effective: "old clean" }],
      ["synthetic/b", { id: "synthetic/b", effective: "old dirty baseline" }],
    ]),
    codexPromptDrafts: new Map([
      ["synthetic/a", "old clean"],
      ["synthetic/b", "unsaved user edit"],
    ]),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPromptRequest: 0,
  };
  const apiCalls = [];
  const loadCodexPromptCenter = Function(
    "state",
    "codexPromptTargets",
    "renderCodexPromptWorkspace",
    "renderSharedProposalWorkspace",
    "api",
    `${source}; return loadCodexPromptCenter;`,
  )(
    state,
    () => (state.codexPrompts?.groups || []).flatMap((group) => group.targets || []),
    () => {},
    () => {},
    async (pathname) => {
      apiCalls.push(pathname);
      if (pathname === "/api/codex-prompts/refresh") {
        return {
          groups: [{
            id: "synthetic",
            label: "Synthetic",
            targets: [{ id: "synthetic/a" }, { id: "synthetic/b" }],
          }],
        };
      }
      if (pathname === "/api/codex-prompts/target?id=synthetic%2Fa") {
        return { id: "synthetic/a", effective: "fresh clean" };
      }
      throw new Error(`Unexpected API call: ${pathname}`);
    },
  );

  assert.equal(await loadCodexPromptCenter({ refresh: true }), true);
  assert.deepEqual(apiCalls, [
    "/api/codex-prompts/refresh",
    "/api/codex-prompts/target?id=synthetic%2Fa",
  ]);
  assert.equal(state.codexPromptDetails.get("synthetic/a").effective, "fresh clean");
  assert.equal(state.codexPromptDrafts.get("synthetic/a"), "fresh clean");
  assert.equal(state.codexPromptDetails.has("synthetic/b"), false);
  assert.equal(state.codexPromptDrafts.get("synthetic/b"), "unsaved user edit");

  state.codexPromptsBusy = true;
  assert.equal(await loadCodexPromptCenter({ refresh: true }), false);
});

test("Prompt Center UI keeps committed save and restore success when summary refresh fails", async () => {
  const script = inlineAppScript();
  const reconcileSource = script.slice(
    script.indexOf("function reconcileCodexPromptCaches"),
    script.indexOf("async function selectCodexPromptTarget"),
  );
  const source = script.slice(
    script.indexOf("async function saveCodexPromptOverride"),
    script.indexOf("function setSharedProposalWorkspaceOpen"),
  );
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSelection: "synthetic/target",
    codexPromptDetails: new Map([
      ["synthetic/target", {
        id: "synthetic/target",
        catalogRevision: "catalog",
        officialHash: "official",
        overrideHash: "",
        effective: "before",
      }],
      ["synthetic/clean-dependent", {
        id: "synthetic/clean-dependent",
        effective: "clean before mutation",
      }],
      ["synthetic/dirty-dependent", {
        id: "synthetic/dirty-dependent",
        effective: "dirty before mutation",
      }],
    ]),
    codexPromptDrafts: new Map([
      ["synthetic/target", "after"],
      ["synthetic/clean-dependent", "clean before mutation"],
      ["synthetic/dirty-dependent", "unsaved dependent edit"],
    ]),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPrompts: { summary: {} },
  };
  const calls = [];
  let confirmResult = true;
  let selectCalls = 0;
  const harness = Function(
    "state",
    "api",
    "codexPromptDraftMetrics",
    "renderCodexPromptDraft",
    "renderCodexPromptWorkspace",
    "selectCodexPromptTarget",
    "CODEX_PROMPT_HIGH_CONTEXT_TOKENS",
    "window",
    `${reconcileSource}
    ${source}
    return { saveCodexPromptOverride, restoreOfficialCodexPrompt };`,
  )(
    state,
    async (pathname, options = {}) => {
      calls.push({ pathname, method: options.method || "GET", body: options.body || "" });
      if (pathname === "/api/codex-prompts/validate") return { valid: true };
      if (pathname === "/api/codex-prompts/override" && options.method === "POST") {
        const body = JSON.parse(options.body);
        assert.equal(body.acknowledgeHighContext, false);
        return {
          ...state.codexPromptDetails.get("synthetic/target"),
          overrideHash: "override-1",
          effective: body.effective,
          restartMessage: "Quit Codex completely (⌘Q on macOS), reopen it, then create a new task.",
        };
      }
      if (pathname === "/api/codex-prompts/override" && options.method === "DELETE") {
        return {
          ...state.codexPromptDetails.get("synthetic/target"),
          overrideHash: "",
          effective: "official",
          restartMessage: "Quit Codex completely (⌘Q on macOS), reopen it, then create a new task.",
        };
      }
      if (pathname === "/api/codex-prompts") {
        const error = new Error("summary GET failed");
        error.status = 409;
        throw error;
      }
      throw new Error(`Unexpected API call: ${pathname}`);
    },
    () => ({ bytes: 5, estimatedTokens: 2 }),
    () => {},
    () => {},
    async () => { selectCalls += 1; },
    1_000,
    { confirm: () => confirmResult },
  );

  await harness.saveCodexPromptOverride();
  assert.equal(state.codexPromptDetails.get("synthetic/target").overrideHash, "override-1");
  assert.equal(state.codexPromptDrafts.get("synthetic/target"), "after");
  assert.equal(state.codexPromptDetails.has("synthetic/clean-dependent"), false);
  assert.equal(state.codexPromptDrafts.has("synthetic/clean-dependent"), false);
  assert.equal(state.codexPromptDetails.has("synthetic/dirty-dependent"), false);
  assert.equal(state.codexPromptDrafts.get("synthetic/dirty-dependent"), "unsaved dependent edit");
  assert.match(state.codexPromptActionStatus, /Quit Codex completely/);
  assert.match(state.codexPromptActionStatus, /summary GET failed/);
  assert.equal(selectCalls, 0, "the secondary GET must not trigger the mutation-conflict reload path");

  confirmResult = false;
  const deleteCallsBeforeCancel = calls.filter((call) => call.method === "DELETE").length;
  await harness.restoreOfficialCodexPrompt();
  assert.equal(
    calls.filter((call) => call.method === "DELETE").length,
    deleteCallsBeforeCancel,
    "Restore official always confirms even when the draft equals the saved effective prompt",
  );

  confirmResult = true;
  await harness.restoreOfficialCodexPrompt();
  assert.equal(state.codexPromptDetails.get("synthetic/target").overrideHash, "");
  assert.equal(state.codexPromptDrafts.get("synthetic/target"), "official");
  assert.match(state.codexPromptActionStatus, /Quit Codex completely/);
  assert.match(state.codexPromptActionStatus, /summary GET failed/);
  assert.equal(selectCalls, 0);
});

test("Prompt Center mutations do not repaint after the user leaves the prompt view", async () => {
  const script = inlineAppScript();
  const reconcileSource = script.slice(
    script.indexOf("function reconcileCodexPromptCaches"),
    script.indexOf("async function selectCodexPromptTarget"),
  );
  const source = script.slice(
    script.indexOf("async function saveCodexPromptOverride"),
    script.indexOf("function setSharedProposalWorkspaceOpen"),
  );
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSelection: "synthetic/target",
    codexPromptDetails: new Map([[
      "synthetic/target",
      {
        id: "synthetic/target",
        catalogRevision: "catalog",
        officialHash: "official",
        overrideHash: "",
        effective: "before",
      },
    ]]),
    codexPromptDrafts: new Map([["synthetic/target", "after"]]),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPrompts: { summary: {} },
  };
  let workspaceRenders = 0;
  let selectCalls = 0;
  let refreshCalls = 0;
  let pendingMutation = null;
  const nextMutation = () => {
    let resolve;
    let reject;
    let started;
    const startedPromise = new Promise((done) => { started = done; });
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    pendingMutation = { promise, resolve, reject, started, startedPromise };
    return pendingMutation;
  };
  const harness = Function(
    "state",
    "api",
    "codexPromptDraftMetrics",
    "renderCodexPromptDraft",
    "renderCodexPromptWorkspace",
    "selectCodexPromptTarget",
    "loadCodexPromptCenter",
    "CODEX_PROMPT_HIGH_CONTEXT_TOKENS",
    "window",
    `${reconcileSource}
    ${source}
    return { saveCodexPromptOverride, restoreOfficialCodexPrompt };`,
  )(
    state,
    async (pathname, options = {}) => {
      if (pathname === "/api/codex-prompts/validate") return { valid: true };
      if (pathname === "/api/codex-prompts/override") {
        pendingMutation.started(options.method);
        return pendingMutation.promise;
      }
      if (pathname === "/api/codex-prompts") return { summary: { targets: 1 } };
      throw new Error(`Unexpected API call: ${pathname}`);
    },
    () => ({ bytes: 5, estimatedTokens: 2 }),
    () => {},
    () => { workspaceRenders += 1; },
    async () => { selectCalls += 1; },
    async () => { refreshCalls += 1; return true; },
    1_000,
    { confirm: () => true },
  );

  const saveMutation = nextMutation();
  const saving = harness.saveCodexPromptOverride();
  assert.equal(await saveMutation.startedPromise, "POST");
  state.contextHubView = "home";
  saveMutation.resolve({
    ...state.codexPromptDetails.get("synthetic/target"),
    overrideHash: "override-1",
    effective: "after",
    restartMessage: CODEX_PROMPT_RESTART_MESSAGE,
  });
  await saving;
  assert.equal(workspaceRenders, 0);
  assert.equal(selectCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(state.codexPromptsBusy, false);

  state.contextHubView = "codex-prompts";
  state.codexPromptDetails.set("synthetic/target", {
    ...state.codexPromptDetails.get("synthetic/target"),
    overrideHash: "override-1",
  });
  const restoreMutation = nextMutation();
  const restoring = harness.restoreOfficialCodexPrompt();
  assert.equal(await restoreMutation.startedPromise, "DELETE");
  state.contextHubView = "project-manager";
  restoreMutation.reject(new Error("Synthetic restore failure"));
  await restoring;
  assert.equal(workspaceRenders, 0);
  assert.equal(selectCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(state.codexPromptsBusy, false);
  assert.match(state.codexPromptActionStatus, /Synthetic restore failure/);
});

test("Prompt Center keeps a newer selection when an older target save returns a conflict", async () => {
  const script = inlineAppScript();
  const reconcileSource = script.slice(
    script.indexOf("function reconcileCodexPromptCaches"),
    script.indexOf("async function selectCodexPromptTarget"),
  );
  const saveSource = script.slice(
    script.indexOf("async function saveCodexPromptOverride"),
    script.indexOf("async function restoreOfficialCodexPrompt"),
  );
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSelection: "synthetic/a",
    codexPromptDetails: new Map([
      ["synthetic/a", {
        id: "synthetic/a",
        catalogRevision: "catalog",
        officialHash: "official-a",
        overrideHash: "",
        effective: "before a",
      }],
      ["synthetic/b", {
        id: "synthetic/b",
        catalogRevision: "catalog",
        officialHash: "official-b",
        overrideHash: "",
        effective: "before b",
      }],
    ]),
    codexPromptDrafts: new Map([
      ["synthetic/a", "after a"],
      ["synthetic/b", "before b"],
    ]),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
  };
  const refreshSelections = [];
  let selectCalls = 0;
  const saveCodexPromptOverride = Function(
    "state",
    "api",
    "codexPromptDraftMetrics",
    "renderCodexPromptDraft",
    "renderCodexPromptWorkspace",
    "selectCodexPromptTarget",
    "loadCodexPromptCenter",
    "CODEX_PROMPT_HIGH_CONTEXT_TOKENS",
    "window",
    `${reconcileSource}
    ${saveSource}
    return saveCodexPromptOverride;`,
  )(
    state,
    async (pathname) => {
      if (pathname === "/api/codex-prompts/validate") {
        state.codexPromptSelection = "synthetic/b";
        return { valid: true };
      }
      if (pathname === "/api/codex-prompts/override") {
        const error = new Error("The prompt changed in another editor.");
        error.status = 409;
        throw error;
      }
      throw new Error(`Unexpected API call: ${pathname}`);
    },
    () => ({ bytes: 7, estimatedTokens: 2 }),
    () => {},
    () => {},
    async () => { selectCalls += 1; },
    async ({ refresh }) => {
      assert.equal(refresh, true);
      refreshSelections.push(state.codexPromptSelection);
      return true;
    },
    1_000,
    { confirm: () => true },
  );

  await saveCodexPromptOverride();
  assert.equal(state.codexPromptSelection, "synthetic/b");
  assert.deepEqual(refreshSelections, ["synthetic/b"]);
  assert.equal(selectCalls, 0);
  assert.equal(state.codexPromptActionTargetId, "synthetic/a");
  assert.match(state.codexPromptActionStatus, /changed in another editor/);
  assert.equal(state.codexPromptDetails.size, 0);
});

test("Prompt Center queues a selection made while another target detail is loading", async () => {
  const script = inlineAppScript();
  const source = script.slice(
    script.indexOf("async function selectCodexPromptTarget"),
    script.indexOf("async function loadCodexPromptCenter"),
  );
  const targets = [
    { id: "synthetic/a" },
    { id: "synthetic/b" },
  ];
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSelection: "",
    codexPromptDetails: new Map(),
    codexPromptDrafts: new Map(),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPromptRequest: 0,
  };
  let resolveFirst;
  const firstDetail = new Promise((resolve) => { resolveFirst = resolve; });
  const requested = [];
  const selectCodexPromptTarget = Function(
    "state",
    "codexPromptTargets",
    "renderCodexPromptWorkspace",
    "api",
    `${source}; return selectCodexPromptTarget;`,
  )(
    state,
    () => targets,
    () => {},
    async (pathname) => {
      const id = new URL(pathname, "http://localhost").searchParams.get("id");
      requested.push(id);
      if (id === "synthetic/a") return firstDetail;
      return { id, effective: `effective ${id}` };
    },
  );

  const loadingFirst = selectCodexPromptTarget("synthetic/a");
  await Promise.resolve();
  await selectCodexPromptTarget("synthetic/b");
  assert.equal(state.codexPromptSelection, "synthetic/b");
  resolveFirst({ id: "synthetic/a", effective: "effective synthetic/a" });
  await loadingFirst;
  assert.deepEqual(requested, ["synthetic/a", "synthetic/b"]);
  assert.equal(state.codexPromptDetails.has("synthetic/b"), true);
  assert.equal(state.codexPromptDrafts.get("synthetic/b"), "effective synthetic/b");
});

test("Prompt Center ignores a stale target failure after the newer selection succeeds", async () => {
  const script = inlineAppScript();
  const source = script.slice(
    script.indexOf("async function selectCodexPromptTarget"),
    script.indexOf("async function loadCodexPromptCenter"),
  );
  const targets = [{ id: "synthetic/a" }, { id: "synthetic/b" }];
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSelection: "",
    codexPromptDetails: new Map(),
    codexPromptDrafts: new Map(),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPromptRequest: 0,
  };
  let rejectFirst;
  const firstDetail = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const requested = [];
  const selectCodexPromptTarget = Function(
    "state",
    "codexPromptTargets",
    "renderCodexPromptWorkspace",
    "api",
    `${source}; return selectCodexPromptTarget;`,
  )(
    state,
    () => targets,
    () => {},
    async (pathname) => {
      const id = new URL(pathname, "http://localhost").searchParams.get("id");
      requested.push(id);
      if (id === "synthetic/a") return firstDetail;
      return { id, effective: `effective ${id}` };
    },
  );

  const loadingFirst = selectCodexPromptTarget("synthetic/a");
  await Promise.resolve();
  await selectCodexPromptTarget("synthetic/b");
  rejectFirst(new Error("stale target A failed"));
  await loadingFirst;
  assert.deepEqual(requested, ["synthetic/a", "synthetic/b"]);
  assert.equal(state.codexPromptSelection, "synthetic/b");
  assert.equal(state.codexPromptsError, "");
  assert.equal(state.codexPromptsErrorScope, "");
  assert.equal(state.codexPromptDetails.get("synthetic/b").effective, "effective synthetic/b");
});

test("Prompt Center target requests do not repaint after leaving the view", async () => {
  const script = inlineAppScript();
  const source = script.slice(
    script.indexOf("async function selectCodexPromptTarget"),
    script.indexOf("async function loadCodexPromptCenter"),
  );
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSelection: "",
    codexPromptDetails: new Map(),
    codexPromptDrafts: new Map(),
    codexPromptsBusy: false,
    codexPromptsError: "",
    codexPromptsErrorScope: "",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPromptRequest: 0,
  };
  let resolveDetail;
  const pendingDetail = new Promise((resolve) => { resolveDetail = resolve; });
  let renders = 0;
  const selectCodexPromptTarget = Function(
    "state",
    "codexPromptTargets",
    "renderCodexPromptWorkspace",
    "api",
    `${source}; return selectCodexPromptTarget;`,
  )(
    state,
    () => [{ id: "synthetic/a" }],
    () => { renders += 1; },
    async () => pendingDetail,
  );

  const loading = selectCodexPromptTarget("synthetic/a");
  await Promise.resolve();
  const rendersBeforeLeaving = renders;
  state.contextHubView = "home";
  resolveDetail({ id: "synthetic/a", effective: "loaded after leaving" });
  await loading;
  assert.equal(renders, rendersBeforeLeaving);
  assert.equal(state.codexPromptsError, "");
  assert.equal(state.codexPromptDetails.get("synthetic/a").effective, "loaded after leaving");
});

test("Prompt Center search preserves catalog errors and clears only target errors", () => {
  const script = inlineAppScript();
  const source = script.slice(
    script.indexOf('el("sharedProposalSearch")?.addEventListener'),
    script.indexOf('el("contextHubSourceFilter")?.addEventListener'),
  );
  let handler = null;
  const state = {
    contextHubView: "codex-prompts",
    codexPromptSearch: "",
    codexPromptsError: "Catalog unavailable",
    codexPromptsErrorScope: "catalog",
    codexPromptActionStatus: "",
    codexPromptActionTargetId: "",
    codexPromptSelection: "",
    codexPromptDetails: new Map(),
  };
  Function(
    "state",
    "el",
    "renderSharedProposalWorkspace",
    "selectCodexPromptTarget",
    "renderCodexPromptWorkspace",
    source,
  )(
    state,
    () => ({
      addEventListener(_eventName, listener) {
        handler = listener;
      },
    }),
    () => {},
    async () => {},
    () => {},
  );
  assert.equal(typeof handler, "function");
  handler({ target: { value: "first" } });
  assert.equal(state.codexPromptsError, "Catalog unavailable");
  assert.equal(state.codexPromptsErrorScope, "catalog");

  state.codexPromptsError = "Target unavailable";
  state.codexPromptsErrorScope = "target:synthetic/a";
  handler({ target: { value: "second" } });
  assert.equal(state.codexPromptsError, "");
  assert.equal(state.codexPromptsErrorScope, "");
});

test("Prompt Center read-only detail keeps authority reason alongside runtime diagnostics", () => {
  const script = inlineAppScript();
  const source = script.slice(
    script.indexOf("function renderCodexPromptDetail"),
    script.indexOf("function renderCodexPromptWorkspace"),
  );
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: false,
        textContent: "",
        value: "",
        readOnly: false,
        disabled: false,
        dataset: {},
      });
    }
    return elements.get(id);
  };
  const detail = {
    id: "synthetic/read-only",
    label: "Read-only prompt",
    description: "",
    kind: "model_base",
    source: "fixture",
    role: "",
    runtimeStatus: "shadowed_by_explicit_config",
    status: "unverified_runtime",
    statusLabel: "Runtime-loaded state unavailable",
    editable: false,
    readOnlyReason: "Explicit Codex configuration owns this target.",
    conflict: null,
    officialContentAvailable: true,
    official: "Official.\n",
    effective: "Configured.\n",
    loaded: null,
    loadedHash: "",
    loadedHashes: [],
    runtimeIdentityVerified: false,
    runtimeManifestCurrent: true,
    runtimeCatalogCurrent: true,
    overrideHash: "",
    overrideInherited: false,
    restartRequired: false,
    restartMessage: CODEX_PROMPT_RESTART_MESSAGE,
  };
  const state = {
    codexPromptSelection: detail.id,
    codexPromptDetails: new Map([[detail.id, detail]]),
    codexPromptsBusy: false,
    codexPromptsError: "",
  };
  const render = Function(
    "state",
    "el",
    "renderCodexPromptDraft",
    `${source}; return renderCodexPromptDetail;`,
  )(state, el, () => {});

  render();
  assert.match(el("codexPromptNotice").textContent, /Explicit Codex configuration owns this target/);
  assert.match(el("codexPromptNotice").textContent, /could not be bound/);

  detail.status = "mixed_versions";
  detail.statusLabel = "Mixed runtime-loaded state";
  detail.runtimeIdentityVerified = true;
  detail.restartRequired = true;
  detail.loadedHashes = [hash("first"), hash("second")];
  render();
  assert.match(el("codexPromptNotice").textContent, /Explicit Codex configuration owns this target/);
  assert.match(el("codexPromptNotice").textContent, /Different loaded prompt versions/);
  assert.match(el("codexPromptLoaded").value, /Different loaded prompt versions/);

  detail.status = "loaded_differs";
  detail.statusLabel = "Loaded prompt differs";
  detail.loaded = "Previously loaded.\n";
  render();
  assert.match(el("codexPromptNotice").textContent, /Explicit Codex configuration owns this target/);
  assert.match(el("codexPromptNotice").textContent, /loaded a different prompt/);
  assert.match(el("codexPromptNotice").textContent, /Quit Codex completely/);
});

test("Prompt Center API exposes six generic routes through an injectable provider", async (t) => {
  const root = makeProject(t);
  const calls = [];
  const payload = {
    schemaVersion: 1,
    catalogRevision: "fixture",
    groups: [],
    summary: { targets: 0 },
  };
  const codexPromptCenter = {
    readSummary() {
      calls.push(["summary"]);
      return payload;
    },
    readTarget(id) {
      calls.push(["target", id]);
      return { id, official: "Synthetic official.", effective: "Synthetic effective." };
    },
    validateDraft(body) {
      calls.push(["validate", body.targetId]);
      return { valid: true };
    },
    writeOverride(body) {
      calls.push(["write", body.targetId, body.acknowledgeHighContext]);
      return { id: body.targetId, effective: body.effective };
    },
    deleteOverride(body) {
      calls.push(["delete", body.targetId]);
      return { id: body.targetId, effective: "Synthetic official." };
    },
    refresh() {
      calls.push(["refresh"]);
      return payload;
    },
  };
  const room = createMemoryServer({ root, codexPromptCenter });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;

  const html = await (await fetch(origin + "/")).text();
  const source = `${html}\n${contextRoomWebAssetBundle().js}`;
  assert.match(source, /\{ id: "advanced-extensions", label: "Advanced extensions", scope: "Device" \}/);
  assert.match(source, /id="openCodexPromptCenter"/);
  assert.match(source, /Official · read-only/);
  assert.match(source, /id="codexPromptEffectiveLabel">Effective after restart</);
  assert.match(source, /Runtime loaded · read-only/);
  assert.match(source, /id="codexPromptDraftMetrics"/);
  assert.match(source, /const CODEX_PROMPT_MAX_BYTES = 28672;/);
  assert.match(source, /const CODEX_PROMPT_MAX_ESTIMATED_TOKENS = 8192;/);
  assert.match(source, /const CODEX_PROMPT_HIGH_CONTEXT_TOKENS = 1000;/);
  assert.match(source, /It will consume substantial context whenever this prompt is used\. Save it\?/);
  assert.match(source, /acknowledgeHighContext,/);
  assert.match(source, /Conflict · editable/);
  assert.match(source, /Different loaded prompt versions/);
  assert.match(source, /const canEdit = detail\.editable && detail\.officialContentAvailable !== false;/);
  assert.match(source, /draft === detail\.effective && !detail\.overrideInherited/);
  assert.match(source, /state\.codexPromptActionTargetId === detail\.id/);
  assert.match(source, /if \(!state\.codexPromptDrafts\.has\(targetId\)\)/);
  assert.match(source, /function reconcileCodexPromptCaches/);
  assert.match(source, /draft !== \(previousDetail\.effective \?\? ""\)/);
  assert.match(source, /state\.codexPromptsErrorScope = "";/);
  assert.match(source, /state\.codexPromptActionTargetId = "";/);
  assert.match(source, /if \(!codexPromptTargets\(\)\.some\(\(target\) => target\.id === targetId\)\) return;/);
  assert.match(source, /if \(state\.codexPromptsBusy\) return;/);
  assert.match(source, /Restore the official prompt and discard your unsaved draft\?/);
  assert.deepEqual(calls, [], "rendering the app must not eagerly load prompts");

  assert.equal((await fetch(origin + "/api/codex-prompts")).status, 200);
  assert.equal((await fetch(origin + "/api/codex-prompts/target?id=synthetic%2Funknown")).status, 200);

  const mutation = (pathname, method, body = {}) => fetch(origin + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: JSON.stringify(body),
  });
  assert.equal((await mutation("/api/codex-prompts/validate", "POST", { targetId: "synthetic/unknown" })).status, 200);
  assert.equal((await mutation("/api/codex-prompts/override", "POST", {
    targetId: "synthetic/unknown",
    effective: "Synthetic.",
    acknowledgeHighContext: true,
  })).status, 200);
  assert.equal((await mutation("/api/codex-prompts/override", "DELETE", { targetId: "synthetic/unknown" })).status, 200);
  assert.equal((await mutation("/api/codex-prompts/refresh", "POST")).status, 200);
  for (const invalidBody of [null, [], 0, false]) {
    assert.equal(
      (await mutation("/api/codex-prompts/refresh", "POST", invalidBody)).status,
      400,
    );
  }
  assert.deepEqual(calls.map((call) => call[0]), ["summary", "target", "validate", "write", "delete", "refresh"]);
  assert.equal(calls.find((call) => call[0] === "write")[2], true);
});

test("Prompt Center rejects rebinding, cross-site origins, and missing mutation nonces", async (t) => {
  const root = makeProject(t);
  let writes = 0;
  const room = createMemoryServer({
    root,
    codexPromptCenter: {
      readSummary: () => ({}),
      readTarget: () => ({}),
      validateDraft: () => ({}),
      writeOverride: () => {
        writes += 1;
        return {};
      },
      deleteOverride: () => ({}),
      refresh: () => ({}),
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;

  const hostilePage = await rawHttpRequest(origin, "/", {
    headers: { host: "attacker.example" },
  });
  assert.equal(hostilePage.status, 403);
  assert.equal(hostilePage.json().code, "context_room_untrusted_host");

  const hostileGet = await rawHttpRequest(origin, "/api/codex-prompts", {
    headers: { host: "attacker.example" },
  });
  assert.equal(hostileGet.status, 403);
  assert.equal(hostileGet.json().code, "codex_prompt_untrusted_origin");

  const hostilePost = await rawHttpRequest(origin, "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      host: "attacker.example",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: "{}",
  });
  assert.equal(hostilePost.status, 403);
  assert.equal(writes, 0);

  const hostileOrigin = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      origin: "http://attacker.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: "{}",
  });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(writes, 0);

  for (const nonce of ["", "wrong-nonce"]) {
    const response = await fetch(origin + "/api/codex-prompts/override", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-context-room-project": room.projectId,
        ...(nonce ? { "x-context-room-prompt-nonce": nonce } : {}),
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "codex_prompt_nonce_required");
  }
  assert.equal(writes, 0);

  const missingIdentity = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: JSON.stringify({ targetId: "synthetic" }),
  });
  assert.equal(missingIdentity.status, 409);
  assert.equal((await missingIdentity.json()).code, "context_room_project_identity_required");
  assert.equal(writes, 0);

  const headerlessMissingIdentity = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: JSON.stringify({ targetId: "synthetic" }),
  });
  assert.equal(headerlessMissingIdentity.status, 409);
  assert.equal((await headerlessMissingIdentity.json()).code, "context_room_project_identity_required");
  assert.equal(writes, 0);

  const invalidJson = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: '{"effective":',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).code, "request_json_invalid");
  assert.equal(writes, 0);

  for (const body of ["null", "[]", '"text"', "42", "true"]) {
    const nonObjectJson = await fetch(origin + "/api/codex-prompts/override", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-context-room-project": room.projectId,
        "x-context-room-prompt-nonce": room.promptMutationNonce,
      },
      body,
    });
    assert.equal(nonObjectJson.status, 400);
    assert.equal((await nonObjectJson.json()).code, "request_json_object_required");
  }
  assert.equal(writes, 0);

  const invalidUtf8 = await rawHttpRequest(origin, "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  });
  assert.equal(invalidUtf8.status, 400);
  assert.equal(invalidUtf8.json().code, "request_json_invalid");
  assert.equal(writes, 0);

  const exactLimit = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: JSON.stringify({ effective: "x".repeat(MAX_CODEX_PROMPT_BYTES) }),
  });
  assert.equal(exactLimit.status, 200);
  assert.equal(writes, 1);

  const tooLarge = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: JSON.stringify({ effective: "x".repeat(MAX_CODEX_PROMPT_REQUEST_BYTES + 1) }),
  });
  assert.equal(tooLarge.status, 413);
  const tooLargePayload = await tooLarge.json();
  assert.equal(tooLargePayload.code, "request_body_too_large");
  assert.doesNotMatch(tooLargePayload.error, /0 MiB/);
  assert.match(tooLargePayload.error, /KiB/);
  assert.equal(writes, 1);
});

test("real Prompt Center writes stay outside project configuration", async (t) => {
  const root = makeProject(t);
  const storageRoot = makeStorage(t);
  const provider = createCodexPromptCenterProvider({ storageRoot, catalog: fixtureCatalog() });
  const room = createMemoryServer({ root, codexPromptCenter: provider });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const target = await (await fetch(origin + "/api/codex-prompts/target?id=synthetic%2Fmode%2Funknown-to-ui")).json();
  const response = await fetch(origin + "/api/codex-prompts/override", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-prompt-nonce": room.promptMutationNonce,
    },
    body: JSON.stringify({
      targetId: target.id,
      catalogRevision: target.catalogRevision,
      officialHash: target.officialHash,
      overrideHash: target.overrideHash,
      effective: target.effective.replace("supplied", "verified"),
    }),
  });
  assert.equal(response.status, 200);
  const projectConfig = fs.readFileSync(path.join(root, ".context-room", "config.json"), "utf8");
  assert.equal(projectConfig.includes("synthetic/mode/unknown-to-ui"), false);
  assert.equal(fs.existsSync(path.join(storageRoot, "overrides.json")), true);
});
