#!/usr/bin/env node
import { createHash, createPrivateKey, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLICATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validatedExternalFileIdentities = new Map();
const validatedExternalFileContents = new Map();
const validatedExternalFileDigests = [];

function lstatMaybe(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readValidatedExternalFile(file, encoding = null) {
  const bytes = validatedExternalFileContents.get(file);
  if (!bytes) throw new Error(`External file was not pinned during startup validation: ${file}`);
  return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name) {
  return String(process.env[name] || "").trim();
}

function secret(name, dataRoot) {
  const file = absoluteRegularFile(required(`${name}_FILE`), `${name}_FILE`, { maxBytes: 65_536, outsideRoot: dataRoot });
  const value = readValidatedExternalFile(file, "utf8").trim();
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error(`${name}_FILE must contain at least 32 bytes`);
  return value;
}

function assertDistinctSigningSecrets(secrets) {
  const entries = Object.entries(secrets).map(([name, value]) => [
    name,
    createHash("sha256").update(value, "utf8").digest(),
  ]);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (timingSafeEqual(entries[left][1], entries[right][1])) {
        throw new Error("CONTEXT_ROOM_HUMAN_SECRET_FILE, CONTEXT_ROOM_AGENT_SECRET_FILE, and CONTEXT_ROOM_HEALTH_SECRET_FILE must contain three distinct secrets");
      }
    }
  }
}

function requiredBuildRevision() {
  const configured = optional("CONTEXT_ROOM_BUILD_REVISION").toLowerCase();
  let baked = "";
  try {
    baked = fs.readFileSync(new URL("../.context-room-build-revision", import.meta.url), "utf8").trim().toLowerCase();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const revision = baked || configured;
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("CONTEXT_ROOM_BUILD_REVISION must be a complete 40-character Git SHA");
  }
  if (baked && configured && configured !== baked) {
    throw new Error("CONTEXT_ROOM_BUILD_REVISION does not match the revision baked into this image");
  }
  return revision;
}

function canonicalDnsHostname(value, name) {
  const hostname = String(value || "").trim();
  if (!hostname) throw new Error(`${name} is required`);
  if (hostname !== hostname.toLowerCase()
    || hostname.length > 253
    || hostname.endsWith(".")
    || hostname.includes(":")
    || isIP(hostname)
    || !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error(`${name} must be an exact lowercase DNS hostname without a scheme, credentials, path, query, fragment, or port`);
  }
  return hostname;
}

function bindHost(value) {
  const host = String(value || "0.0.0.0").trim();
  if (isIP(host)) return host;
  return canonicalDnsHostname(host, "CONTEXT_ROOM_HOST");
}

function listenPort(value) {
  const raw = String(value || "4317").trim();
  if (!/^\d+$/.test(raw)) throw new Error("CONTEXT_ROOM_PORT must be an integer between 1 and 65535");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CONTEXT_ROOM_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function normalizedProjectIds(values, source) {
  if (!Array.isArray(values) || !values.length) throw new Error(`${source} projectIds must be a non-empty array`);
  const seen = new Set();
  return values.map((value, index) => {
    if (typeof value !== "string") throw new Error(`${source} projectIds[${index}] must be a string`);
    const projectId = value.trim().toLowerCase();
    if (!projectId
      || projectId === "."
      || projectId === ".."
      || projectId.includes("..")
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
      throw new Error(`${source} projectIds[${index}] must use lowercase letters, numbers, and hyphens`);
    }
    if (["global", "skills", "instructions"].includes(projectId)) {
      throw new Error(`${source} projectIds[${index}] is reserved for a built-in proposal scope`);
    }
    if (seen.has(projectId)) throw new Error(`${source} contains duplicate projectId ${projectId}`);
    seen.add(projectId);
    return projectId;
  });
}

function normalizedSharedScopes(values = [], source) {
  if (!Array.isArray(values)) throw new Error(`${source} scopes must be an array`);
  const allowed = new Set(["global", "skills", "instructions", "projects"]);
  const seen = new Set();
  return values.map((value, index) => {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new Error(`${source} scopes[${index}] must be global, skills, instructions, or projects`);
    }
    if (seen.has(value)) throw new Error(`${source} contains duplicate scope ${value}`);
    seen.add(value);
    return value;
  });
}

function githubRepository(value, source) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("-") || /[\x00-\x20\x7f]/.test(raw)) {
    throw new Error(`${source} repository must be a canonical GitHub HTTPS or SSH remote`);
  }

  let transport = "";
  let owner = "";
  let name = "";
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(raw);
  if (scp) {
    transport = "ssh";
    [, owner, name] = scp;
  } else {
    const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(raw);
    if (https) {
      transport = "https";
      [, owner, name] = https;
    }
  }

  name = name.replace(/\.git$/i, "");
  if (!transport
    || !/^[a-z0-9._-]+$/i.test(owner)
    || !/^[a-z0-9._-]+$/i.test(name)
    || [owner, name].some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${source} repository must be a canonical GitHub HTTPS or SSH remote`);
  }

  const repositoryPath = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const identity = `github:${repositoryPath}`;
  return {
    repository: raw,
    identity,
    repositoryId: createHash("sha256").update(identity).digest("hex").slice(0, 24),
    transport,
    owner,
    name,
    httpsUrl: `https://github.com/${owner}/${name}.git`,
  };
}

function repositoriesFileEntries(file, dataRoot) {
  const safeFile = absoluteRegularFile(file, "CONTEXT_ROOM_SHARED_REPOSITORIES_FILE", { maxBytes: 1_048_576, outsideRoot: dataRoot });
  let parsed;
  try { parsed = JSON.parse(readValidatedExternalFile(safeFile, "utf8")); } catch (error) {
    throw new Error(`CONTEXT_ROOM_SHARED_REPOSITORIES_FILE is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("CONTEXT_ROOM_SHARED_REPOSITORIES_FILE must contain a non-empty JSON array");
  }
  return parsed.map((entry, index) => {
    const source = `CONTEXT_ROOM_SHARED_REPOSITORIES_FILE[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${source} must be an object`);
    const unknown = Object.keys(entry).filter((key) => !["repository", "projectIds", "scopes"].includes(key));
    if (unknown.length) throw new Error(`${source} has unsupported fields: ${unknown.join(", ")}`);
    return { source, repository: entry.repository, projectIds: entry.projectIds, scopes: entry.scopes };
  });
}

function sharedRepositoryConfiguration(dataRoot) {
  const entries = [];
  const file = optional("CONTEXT_ROOM_SHARED_REPOSITORIES_FILE");
  if (file) entries.push(...repositoriesFileEntries(file, dataRoot));

  const legacyRepository = optional("CONTEXT_ROOM_SHARED_REPOSITORY");
  const legacyProjectIds = optional("CONTEXT_ROOM_PROJECT_IDS");
  if (legacyRepository || legacyProjectIds) {
    if (!legacyRepository) throw new Error("CONTEXT_ROOM_SHARED_REPOSITORY is required when CONTEXT_ROOM_PROJECT_IDS is set");
    if (!legacyProjectIds) throw new Error("CONTEXT_ROOM_PROJECT_IDS is required when CONTEXT_ROOM_SHARED_REPOSITORY is set");
    entries.push({
      source: "legacy Shared configuration",
      repository: legacyRepository,
      projectIds: legacyProjectIds.split(","),
      scopes: [],
    });
  }
  if (!entries.length) {
    required("CONTEXT_ROOM_SHARED_REPOSITORY");
    throw new Error("CONTEXT_ROOM_PROJECT_IDS is required");
  }

  const repositoryIdentities = new Set();
  const repositoryIdIdentities = new Map();
  const projectIdentities = new Set();
  const configured = entries.map((entry) => {
    const repository = githubRepository(entry.repository, entry.source);
    const projectIds = normalizedProjectIds(entry.projectIds, entry.source);
    const scopes = normalizedSharedScopes(entry.scopes, entry.source);
    if (repositoryIdentities.has(repository.identity)) {
      throw new Error(`Duplicate Shared repository configuration: ${repository.identity}`);
    }
    repositoryIdentities.add(repository.identity);
    const previousIdentity = repositoryIdIdentities.get(repository.repositoryId);
    if (previousIdentity && previousIdentity !== repository.identity) {
      throw new Error(`Shared repository identity collision for ${repository.repositoryId}`);
    }
    repositoryIdIdentities.set(repository.repositoryId, repository.identity);
    for (const projectId of projectIds) {
      if (projectIdentities.has(projectId)) {
        throw new Error(`projectId ${projectId} is assigned to more than one Shared repository`);
      }
      projectIdentities.add(projectId);
    }
    return Object.freeze({
      repository: repository.repository,
      identity: repository.identity,
      repositoryId: repository.repositoryId,
      projectIds: Object.freeze(projectIds),
      scopes: Object.freeze(scopes),
    });
  });
  const repositoryIds = new Set(configured.map((entry) => entry.repositoryId));
  for (const entry of configured) {
    for (const projectId of entry.projectIds) {
      if (repositoryIds.has(projectId)) {
        throw new Error(`projectId ${projectId} collides with an opaque Shared repository identity`);
      }
    }
  }
  return Object.freeze(configured);
}

function pathIsWithinOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function protectedDataRoots(filesystemRoot) {
  const protectedPaths = new Set();
  const add = (value) => {
    if (!value || !path.isAbsolute(value)) return;
    const resolved = path.resolve(value);
    protectedPaths.add(resolved);
    try { protectedPaths.add(fs.realpathSync(resolved)); } catch {}
  };
  for (const name of [
    "Applications", "app", "bin", "boot", "dev", "etc", "home", "Library",
    "lib", "lib32", "lib64", "libx32", "media", "mnt", "opt", "private",
    "proc", "Program Files", "Program Files (x86)", "ProgramData", "root", "run",
    "sbin", "srv", "sys", "System", "tmp", "Users", "usr", "var", "Volumes", "Windows",
  ]) add(path.join(filesystemRoot, name));
  try {
    for (const name of fs.readdirSync(filesystemRoot)) {
      if (/^lib(?:[^/]*)$/i.test(name)) add(path.join(filesystemRoot, name));
    }
  } catch {}
  add(filesystemRoot);
  add(process.env.HOME || "");
  for (const name of [
    "SystemDrive", "SystemRoot", "windir", "ProgramFiles", "ProgramW6432",
    "ProgramFiles(x86)", "ProgramData", "USERPROFILE", "PUBLIC", "ALLUSERSPROFILE",
    "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
  ]) add(process.env[name] || "");
  try { add(os.homedir()); } catch {}
  try { add(os.userInfo().homedir); } catch {}
  try { add(os.tmpdir()); } catch {}
  add(process.cwd());
  add(APPLICATION_ROOT);
  return protectedPaths;
}

function assertDedicatedDataRoot(candidate, protectedPaths) {
  if (protectedPaths.has(candidate)) {
    throw new Error("CONTEXT_ROOM_DATA_ROOT must be a dedicated application data directory, not a filesystem, system, home, working, or application root");
  }
}

function anchoredPath(value, label, { allowMissing = false } = {}) {
  const resolved = path.resolve(value);
  const filesystemRoot = path.parse(resolved).root;
  const relative = path.relative(filesystemRoot, resolved);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = filesystemRoot;
  let finalStat = fs.lstatSync(filesystemRoot);
  const missing = [];
  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (error?.code !== "ENOENT" || !allowMissing) throw error;
      missing.push(...segments.slice(index));
      break;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symlinked path components`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`${label} must descend only through directories`);
    current = next;
    finalStat = stat;
  }
  const canonicalExisting = fs.realpathSync(current);
  if (canonicalExisting !== current) throw new Error(`${label} must use its exact canonical path without filesystem indirection`);
  return {
    resolved,
    anchored: missing.length ? path.join(canonicalExisting, ...missing) : canonicalExisting,
    existing: canonicalExisting,
    missing,
    stat: missing.length ? null : finalStat,
  };
}

function anchoredDataRoot(value) {
  const configured = String(value || "").trim();
  if (!configured) throw new Error("CONTEXT_ROOM_DATA_ROOT is required");
  if (!path.isAbsolute(configured) || /[\x00-\x1f\x7f]/.test(configured)) {
    throw new Error("CONTEXT_ROOM_DATA_ROOT must be an absolute path");
  }
  const resolved = path.resolve(configured);
  const filesystemRoot = path.parse(resolved).root;
  const protectedPaths = protectedDataRoots(filesystemRoot);
  assertDedicatedDataRoot(resolved, protectedPaths);
  const inspected = anchoredPath(resolved, "CONTEXT_ROOM_DATA_ROOT", { allowMissing: true });
  if (inspected.stat && !inspected.stat.isDirectory()) {
    throw new Error("CONTEXT_ROOM_DATA_ROOT must identify a directory");
  }
  assertDedicatedDataRoot(inspected.anchored, protectedPaths);
  return inspected.anchored;
}

function normalizedAdminSubjects(value) {
  const subjects = [...new Set(String(value || "").split(",").map((subject) => subject.trim()).filter(Boolean))];
  if (!subjects.length) throw new Error("CONTEXT_ROOM_ADMIN_SUBJECTS must contain at least one subject");
  if (subjects.some((subject) => subject.length > 256 || /[\x00-\x1f\x7f]/.test(subject))) {
    throw new Error("CONTEXT_ROOM_ADMIN_SUBJECTS contains an invalid subject");
  }
  return subjects;
}

function absoluteRegularFile(value, name, { maxBytes = 1_048_576, outsideRoot = "" } = {}) {
  const file = String(value || "").trim();
  if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) throw new Error(`${name} must be an absolute regular file`);
  const inspected = anchoredPath(file, name);
  const initial = inspected.stat;
  if (!initial?.isFile() || initial.nlink !== 1) throw new Error(`${name} must be a private regular file with exactly one link and no symlinked parents`);
  if (initial.size > maxBytes) throw new Error(`${name} is too large`);
  const real = inspected.anchored;
  if (outsideRoot && pathIsWithinOrEqual(outsideRoot, real)) {
    throw new Error(`${name} must be mounted outside CONTEXT_ROOM_DATA_ROOT`);
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(real, fs.constants.O_RDONLY | noFollow);
  let pinned;
  let final;
  let bytes;
  try {
    pinned = fs.fstatSync(descriptor);
    bytes = fs.readFileSync(descriptor);
    final = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!pinned.isFile()
    || pinned.nlink !== 1
    || pinned.dev !== initial.dev
    || pinned.ino !== initial.ino
    || pinned.size !== initial.size
    || final.dev !== pinned.dev
    || final.ino !== pinned.ino
    || final.nlink !== 1
    || final.size !== pinned.size
    || bytes.length !== final.size
    || bytes.length > maxBytes) {
    throw new Error(`${name} changed while it was being validated`);
  }
  const identity = `${final.dev}:${final.ino}`;
  const previousRole = validatedExternalFileIdentities.get(identity);
  if (previousRole && previousRole !== name) {
    throw new Error(`${name} must not reuse the same file as ${previousRole}`);
  }
  validatedExternalFileIdentities.set(identity, name);
  const digest = createHash("sha256").update(bytes).digest();
  for (const previous of validatedExternalFileDigests) {
    if (timingSafeEqual(previous.digest, digest)) {
      throw new Error(`${name} must not reuse the same bytes as ${previous.name}`);
    }
  }
  validatedExternalFileDigests.push({ name, digest });
  validatedExternalFileContents.set(real, bytes);
  return real;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function proposalSshConfiguration(sharedRepositories, dataRoot) {
  const keyValue = optional("CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE");
  const knownHostsValue = optional("CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE");
  const requiresSsh = sharedRepositories.some((entry) => entry.repository.startsWith("git@github.com:"));
  if (!keyValue && knownHostsValue) {
    throw new Error("CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE is required when CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE is set");
  }
  if (requiresSsh && !keyValue) {
    throw new Error("SSH Shared repositories require CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE and CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE");
  }
  if (!keyValue) return null;
  const keyFile = absoluteRegularFile(keyValue, "CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE", { maxBytes: 1_048_576, outsideRoot: dataRoot });
  const knownHostsFile = absoluteRegularFile(required("CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE"), "CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE", { maxBytes: 1_048_576, outsideRoot: dataRoot });
  if (!readValidatedExternalFile(keyFile, "utf8").trim()) throw new Error("CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE must not be empty");
  if (!readValidatedExternalFile(knownHostsFile, "utf8").trim()) throw new Error("CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE must not be empty");
  return { keyFile, knownHostsFile };
}

function githubAppConfiguration(dataRoot) {
  const privateKeyFile = optional("CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE");
  const appIdValue = optional("CONTEXT_ROOM_GITHUB_APP_ID");
  const installationIdValue = optional("CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID");
  if (!privateKeyFile) {
    if (appIdValue || installationIdValue) {
      throw new Error("CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE is required when GitHub App IDs are set");
    }
    return null;
  }
  const appId = required("CONTEXT_ROOM_GITHUB_APP_ID");
  const installationId = required("CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID");
  const maximumGithubId = (1n << 63n) - 1n;
  if (!/^[1-9]\d{0,18}$/.test(appId)
    || !/^[1-9]\d{0,18}$/.test(installationId)
    || BigInt(appId) > maximumGithubId
    || BigInt(installationId) > maximumGithubId) {
    throw new Error("CONTEXT_ROOM_GITHUB_APP_ID and CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID must be positive bounded decimal identifiers");
  }
  const safePrivateKeyFile = absoluteRegularFile(privateKeyFile, "CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE", { maxBytes: 1_048_576, outsideRoot: dataRoot });
  const privateKey = readValidatedExternalFile(safePrivateKeyFile, "utf8").replaceAll("\\n", "\n").trim();
  if (!privateKey.trim()) throw new Error("CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE must not be empty");
  let parsedPrivateKey;
  try { parsedPrivateKey = createPrivateKey(privateKey); } catch {
    throw new Error("CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE must contain a valid unencrypted RSA private key");
  }
  if (parsedPrivateKey.type !== "private" || parsedPrivateKey.asymmetricKeyType !== "rsa") {
    throw new Error("CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE must contain a valid unencrypted RSA private key");
  }
  return { appId, installationId, privateKey, authenticateSharedReads: true };
}

function sharedRegistryMigrationError(message) {
  return new Error(`${message}. Migrate projects/ and home/.context-room/shared/registry.json together as one operator-verified atomic change before remote startup`);
}

function hostedBootstrapPayload(sharedRepositories) {
  return {
    version: 1,
    repositories: sharedRepositories.map(({ repository, identity, repositoryId, projectIds, scopes }) => ({
      repository,
      identity,
      repositoryId,
      projectIds: [...projectIds],
      scopes: [...scopes],
    })),
  };
}

function hostedBootstrapMarkerPath(dataRoot) {
  return path.join(dataRoot, ".bootstrap-incomplete.json");
}

function validateHostedBootstrapMarker(dataRoot, sharedRepositories) {
  const markerFile = hostedBootstrapMarkerPath(dataRoot);
  if (!lstatMaybe(markerFile)) return null;
  const safeMarker = absoluteRegularFile(markerFile, "Hosted bootstrap recovery marker", { maxBytes: 1_048_576 });
  let marker;
  try { marker = JSON.parse(readValidatedExternalFile(safeMarker, "utf8")); } catch {
    throw new Error("Hosted bootstrap recovery marker is invalid; remote startup remains blocked before effects");
  }
  if (JSON.stringify(marker) !== JSON.stringify(hostedBootstrapPayload(sharedRepositories))) {
    throw new Error("Hosted bootstrap recovery marker does not match the exact current repository configuration; remote startup remains blocked before effects");
  }
  return safeMarker;
}

function validateHostedSharedRegistry(dataRoot, sharedRepositories, { allowMissingForRecovery = false } = {}) {
  const registryFile = path.join(dataRoot, "home", ".context-room", "shared", "registry.json");
  const expected = new Map(sharedRepositories.flatMap((entry) => entry.projectIds.map((projectId) => [projectId, {
    projectId,
    repository: entry.repository,
    repositoryIdentity: githubRepository(entry.repository, `Shared repository ${entry.repositoryId}`).identity,
    root: path.join(dataRoot, "projects", entry.repositoryId, projectId),
  }])));
  const existingProjects = [...expected.values()].filter((target) => lstatMaybe(target.root));
  if (!lstatMaybe(registryFile)) {
    if (existingProjects.length && !allowMissingForRecovery) {
      throw sharedRegistryMigrationError(`Hosted Shared registry is missing bindings for existing projects: ${existingProjects.map((target) => target.projectId).join(", ")}`);
    }
    return;
  }
  const safeRegistryFile = absoluteRegularFile(registryFile, "Hosted Shared registry", { maxBytes: 1_048_576 });
  let registry;
  try { registry = JSON.parse(readValidatedExternalFile(safeRegistryFile, "utf8")); } catch (error) {
    throw sharedRegistryMigrationError(`Hosted Shared registry is invalid JSON: ${error.message}`);
  }
  if (!registry
    || typeof registry !== "object"
    || Array.isArray(registry)
    || registry.version !== 1
    || !Array.isArray(registry.bindings)) {
    throw sharedRegistryMigrationError("Hosted Shared registry must use version 1 and contain a bindings array");
  }
  const seen = new Set();
  for (const [index, binding] of registry.bindings.entries()) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${index} is invalid`);
    }
    const projectId = String(binding.projectId || "");
    const target = expected.get(projectId);
    if (!target) throw sharedRegistryMigrationError(`Hosted Shared registry contains unexpected projectId ${projectId || "<empty>"}`);
    if (seen.has(projectId)) throw sharedRegistryMigrationError(`Hosted Shared registry contains duplicate bindings for ${projectId}`);
    seen.add(projectId);
    let bindingIdentity = "";
    try { bindingIdentity = githubRepository(binding.repository, `Hosted Shared registry binding ${projectId}`).identity; } catch {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} has an invalid repository`);
    }
    if (bindingIdentity !== target.repositoryIdentity) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} points to a different repository`);
    }
    if (String(binding.repository) !== target.repository) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} changes the exact repository address that keys persistent Shared state`);
    }
    if (binding.sourceRemote || binding.sourceRemotes || binding.sourceSubpath) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} uses a non-hosted source identity`);
    }
    if (!binding.sourceRoot || path.resolve(String(binding.sourceRoot)) !== target.root) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} has stale sourceRoot ${binding.sourceRoot || "<missing>"}`);
    }
    if (!lstatMaybe(target.root)) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} points to a missing project root`);
    }
    const projectRoots = binding.projectRoots === undefined ? [binding.sourceRoot] : binding.projectRoots;
    if (!Array.isArray(projectRoots)
      || projectRoots.length !== 1
      || path.resolve(String(projectRoots[0] || "")) !== target.root) {
      throw sharedRegistryMigrationError(`Hosted Shared registry binding ${projectId} has stale projectRoots`);
    }
  }
  const missingBindings = existingProjects.filter((target) => !seen.has(target.projectId));
  if (missingBindings.length) {
    throw sharedRegistryMigrationError(`Hosted Shared registry is missing bindings for existing projects: ${missingBindings.map((target) => target.projectId).join(", ")}`);
  }
}

function validateExistingDataLayout(dataRoot, sharedRepositories, { allowBootstrapRecovery = false } = {}) {
  if (!lstatMaybe(dataRoot)) return;
  const reservedDirectories = [
    ["home", "HOME"],
    ["hub", "CONTEXT_ROOM_HUB_HOME"],
    ["review-authority", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"],
    ["snapshots", "CONTEXT_ROOM_SNAPSHOT_HOME"],
    ["codex", "CODEX_HOME"],
    ["hermes", "HERMES_HOME"],
    ["projects", "Context Room projects root"],
    ["host", "Context Room host root"],
  ];
  for (const [relative, label] of reservedDirectories) {
    const directory = path.join(dataRoot, relative);
    const stat = lstatMaybe(directory);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must not be a symlink and must identify a directory`);
    }
    assertContained(dataRoot, fs.realpathSync(directory), label);
  }

  const contextStateRoot = path.join(dataRoot, "home", ".context-room");
  const sharedStateRoot = path.join(contextStateRoot, "shared");
  for (const [directory, label] of [[contextStateRoot, "Hosted HOME state"], [sharedStateRoot, "CONTEXT_ROOM_SHARED_HOME"]]) {
    const stat = lstatMaybe(directory);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw sharedRegistryMigrationError(`${label} is not a safe directory`);
    }
    assertContained(dataRoot, fs.realpathSync(directory), label);
  }
  const conflictingSharedRoot = path.join(dataRoot, "shared");
  if (lstatMaybe(conflictingSharedRoot)) {
    throw sharedRegistryMigrationError("Conflicting Shared state exists under shared/ while the gateway preserves home/.context-room/shared");
  }

  const gitConfig = path.join(dataRoot, "gitconfig-global-empty");
  const gitConfigStat = lstatMaybe(gitConfig);
  if (gitConfigStat) {
    const stat = gitConfigStat;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error("GIT_CONFIG_GLOBAL must be a private regular file with exactly one link");
    }
    assertContained(dataRoot, fs.realpathSync(gitConfig), "GIT_CONFIG_GLOBAL");
  }

  const projectsRoot = path.join(dataRoot, "projects");
  const configuredRepositories = new Map(sharedRepositories.map((entry) => [entry.repositoryId, entry]));
  if (lstatMaybe(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      if (!configuredRepositories.has(name)) {
        throw sharedRegistryMigrationError(`Context Room projects root contains unexpected entry projects/${name}`);
      }
    }
  }
  for (const entry of sharedRepositories) {
    const repositoryRoot = path.join(projectsRoot, entry.repositoryId);
    const repositoryStat = lstatMaybe(repositoryRoot);
    if (!repositoryStat) continue;
    if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) {
      throw new Error(`Shared repository ${entry.repositoryId} must not be a symlink and must identify a directory`);
    }
    assertContained(dataRoot, fs.realpathSync(repositoryRoot), `Shared repository ${entry.repositoryId}`);
    const allowedProjects = new Set(entry.projectIds);
    for (const name of fs.readdirSync(repositoryRoot)) {
      if (!allowedProjects.has(name)) {
        throw sharedRegistryMigrationError(`Shared repository ${entry.repositoryId} contains unexpected project ${name}`);
      }
    }
    for (const projectId of entry.projectIds) {
      const projectRoot = path.join(repositoryRoot, projectId);
      const projectStat = lstatMaybe(projectRoot);
      if (!projectStat) continue;
      if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
        throw new Error(`Shared project ${projectId} must not be a symlink and must identify a directory`);
      }
      assertContained(dataRoot, fs.realpathSync(projectRoot), `Shared project ${projectId}`);
    }
  }
  validateHostedSharedRegistry(dataRoot, sharedRepositories, { allowMissingForRecovery: allowBootstrapRecovery });
}

function writeHostedBootstrapMarker(dataRoot, sharedRepositories) {
  const markerFile = hostedBootstrapMarkerPath(dataRoot);
  const bytes = Buffer.from(`${JSON.stringify(hostedBootstrapPayload(sharedRepositories), null, 2)}\n`, "utf8");
  const existing = lstatMaybe(markerFile);
  if (existing) {
    const inspected = anchoredPath(markerFile, "Hosted bootstrap recovery marker");
    if (!inspected.stat?.isFile() || inspected.stat.nlink !== 1) {
      throw new Error("Hosted bootstrap recovery marker changed before startup recovery began");
    }
    assertContained(dataRoot, inspected.anchored, "Hosted bootstrap recovery marker");
    if (!timingSafeEqual(createHash("sha256").update(fs.readFileSync(inspected.anchored)).digest(), createHash("sha256").update(bytes).digest())) {
      throw new Error("Hosted bootstrap recovery marker changed before startup recovery began");
    }
    return Object.freeze({ file: inspected.anchored, dev: String(inspected.stat.dev), ino: String(inspected.stat.ino) });
  }
  const temporary = `${markerFile}.${process.pid}.${Date.now()}.tmp`;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, markerFile);
  fs.chmodSync(markerFile, 0o600);
  const installed = fs.lstatSync(markerFile);
  if (!installed.isFile() || installed.isSymbolicLink() || installed.nlink !== 1) {
    throw new Error("Hosted bootstrap recovery marker could not be installed safely");
  }
  return Object.freeze({ file: markerFile, dev: String(installed.dev), ino: String(installed.ino) });
}

function clearHostedBootstrapMarker(marker, dataRoot) {
  const inspected = anchoredPath(marker.file, "Hosted bootstrap recovery marker");
  if (!inspected.stat?.isFile()
    || inspected.stat.nlink !== 1
    || String(inspected.stat.dev) !== marker.dev
    || String(inspected.stat.ino) !== marker.ino) {
    throw new Error("Hosted bootstrap recovery marker changed before startup completed");
  }
  assertContained(dataRoot, inspected.anchored, "Hosted bootstrap recovery marker");
  fs.unlinkSync(inspected.anchored);
}

function writeHostedSharedRegistry(dataRoot, sharedRepositories, attestProjectCapability) {
  if (typeof attestProjectCapability !== "function") throw new Error("Hosted Shared registry requires exact project capability attestation");
  const registryFile = path.join(dataRoot, "home", ".context-room", "shared", "registry.json");
  const bindings = sharedRepositories.flatMap((entry) => entry.projectIds.map((projectId) => {
    const sourceRoot = path.join(dataRoot, "projects", entry.repositoryId, projectId);
    const capability = attestProjectCapability(sourceRoot);
    return {
      repository: entry.repository,
      repositoryIdentity: entry.identity,
      projectId,
      sourceRoot,
      projectRoots: [sourceRoot],
      capabilityVersion: 1,
      projectCapabilities: [capability],
    };
  }));
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, bindings }, null, 2)}\n`, "utf8");
  const temporary = `${registryFile}.${process.pid}.${Date.now()}.tmp`;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, registryFile);
  fs.chmodSync(registryFile, 0o600);
  return registryFile;
}

function assertHostedProjectBinding(root, entry, projectId, connection) {
  if (!connection
    || connection.repository !== entry.repository
    || githubRepository(connection.repository, `Shared project ${projectId}`).identity !== entry.identity
    || connection.projectId !== projectId
    || path.resolve(connection.projectRoot || "") !== root) {
    throw new Error(`Shared project ${projectId} did not establish its exact hosted repository binding`);
  }
  const configFile = path.join(root, ".context-room", "config.json");
  let sharedContext;
  try { sharedContext = JSON.parse(fs.readFileSync(configFile, "utf8")).sharedContext; } catch {}
  if (!sharedContext
    || sharedContext.repository !== entry.repository
    || githubRepository(sharedContext.repository, `Shared project ${projectId} configuration`).identity !== entry.identity
    || sharedContext.projectId !== projectId) {
    throw new Error(`Shared project ${projectId} did not materialize its exact hosted Shared configuration`);
  }
}

function readConfiguration(buildRevision) {
  if (process.env.CONTEXT_ROOM_REMOTE !== "1") throw new Error("Set CONTEXT_ROOM_REMOTE=1 to opt into the remote server");
  const dataRoot = anchoredDataRoot(required("CONTEXT_ROOM_DATA_ROOT"));
  const sharedRepositories = sharedRepositoryConfiguration(dataRoot);
  const publicHost = canonicalDnsHostname(required("CONTEXT_ROOM_PUBLIC_HOST"), "CONTEXT_ROOM_PUBLIC_HOST");
  const browserHostValue = optional("CONTEXT_ROOM_BROWSER_HOST");
  const browserHost = browserHostValue
    ? canonicalDnsHostname(browserHostValue, "CONTEXT_ROOM_BROWSER_HOST")
    : publicHost;
  const issuer = String(process.env.CONTEXT_ROOM_IDENTITY_ISSUER || "context-room").trim();
  if (!issuer || issuer.length > 160 || /[\x00-\x1f\x7f]/.test(issuer)) {
    throw new Error("CONTEXT_ROOM_IDENTITY_ISSUER is invalid");
  }
  const signingSecrets = {
    humanSecret: secret("CONTEXT_ROOM_HUMAN_SECRET", dataRoot),
    agentSecret: secret("CONTEXT_ROOM_AGENT_SECRET", dataRoot),
    healthSecret: secret("CONTEXT_ROOM_HEALTH_SECRET", dataRoot),
  };
  assertDistinctSigningSecrets(signingSecrets);
  const configuration = {
    buildRevision,
    sharedRepositories,
    dataRoot,
    publicHost,
    browserHost,
    ...signingSecrets,
    adminSubjects: Object.freeze(normalizedAdminSubjects(required("CONTEXT_ROOM_ADMIN_SUBJECTS"))),
    issuer,
    proposalSsh: proposalSshConfiguration(sharedRepositories, dataRoot),
    githubApp: githubAppConfiguration(dataRoot),
    port: listenPort(process.env.CONTEXT_ROOM_PORT),
    host: bindHost(process.env.CONTEXT_ROOM_HOST),
  };
  const bootstrapMarker = validateHostedBootstrapMarker(dataRoot, sharedRepositories);
  validateExistingDataLayout(dataRoot, sharedRepositories, { allowBootstrapRecovery: Boolean(bootstrapMarker) });
  return Object.freeze({ ...configuration, bootstrapRecovery: Boolean(bootstrapMarker) });
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain beneath CONTEXT_ROOM_DATA_ROOT`);
  }
}

function ensurePrivateDirectory(directory, dataRoot, label, { root = false } = {}) {
  const target = root ? anchoredDataRoot(directory) : directory;
  if (!root) assertContained(dataRoot, target, label);
  const existingStat = lstatMaybe(target);
  if (existingStat) {
    const stat = existingStat;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must not be a symlink and must identify a directory`);
  } else {
    fs.mkdirSync(target, { recursive: root, mode: 0o700 });
  }
  const real = fs.realpathSync(target);
  if (root) {
    if (anchoredDataRoot(target) !== real) throw new Error(`${label} changed while it was being anchored`);
  } else {
    assertContained(dataRoot, real, label);
  }
  fs.chmodSync(real, 0o700);
  return real;
}

function ensureEmptyPrivateFile(file, dataRoot, label) {
  assertContained(dataRoot, file, label);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const existingStat = lstatMaybe(file);
  const existed = Boolean(existingStat);
  if (existingStat) {
    const stat = existingStat;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${label} must be a private regular file with exactly one link`);
    }
  }
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | noFollow | (existed ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL),
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${label} must be a private regular file with exactly one link`);
    fs.ftruncateSync(descriptor, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const finalStat = fs.lstatSync(file);
  if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.nlink !== 1) {
    throw new Error(`${label} must be a private regular file with exactly one link`);
  }
  const real = fs.realpathSync(file);
  assertContained(dataRoot, real, label);
  fs.chmodSync(real, 0o600);
  return real;
}

if (process.env.CONTEXT_ROOM_REMOTE !== "1") throw new Error("Set CONTEXT_ROOM_REMOTE=1 to opt into the remote server");
const instanceBuildRevision = requiredBuildRevision();
const instanceDataRoot = anchoredDataRoot(required("CONTEXT_ROOM_DATA_ROOT"));
process.env.CONTEXT_ROOM_DATA_ROOT = instanceDataRoot;
process.env.HOME = path.join(instanceDataRoot, "home");
process.env.CONTEXT_ROOM_HUB_HOME = path.join(instanceDataRoot, "hub");
process.env.CONTEXT_ROOM_SHARED_HOME = path.join(instanceDataRoot, "home", ".context-room", "shared");
process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = path.join(instanceDataRoot, "review-authority");
process.env.CONTEXT_ROOM_SNAPSHOT_HOME = path.join(instanceDataRoot, "snapshots");
process.env.CODEX_HOME = path.join(instanceDataRoot, "codex");
process.env.HERMES_HOME = path.join(instanceDataRoot, "hermes");
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_") || ["SSH_AUTH_SOCK", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"].includes(name)) delete process.env[name];
}
process.env.GIT_CONFIG_GLOBAL = path.join(instanceDataRoot, "gitconfig-global-empty");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
const { acquireFilesystemLock } = await import("../src/filesystem_lock.mjs");
const acquireHostedInstanceLease = (root) => {
  const lockPath = path.join(root, ".context-room-instance.lock");
  const existing = lstatMaybe(lockPath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new Error("Hosted Context Room instance lock must be a private regular file with exactly one link");
  }
  return acquireFilesystemLock(lockPath, {
    timeoutMs: 5_000,
    staleMs: 1_000,
    busyMessage: "Hosted Context Room data root is already owned by another live process",
    busyCode: "hosted_context_room_instance_busy",
    requireProcessIdentity: true,
    secureSidecars: true,
  });
};
let hostedInstanceLease = lstatMaybe(instanceDataRoot) ? acquireHostedInstanceLease(instanceDataRoot) : null;
if (hostedInstanceLease) process.once("exit", () => hostedInstanceLease.release());
const configuration = readConfiguration(instanceBuildRevision);
const {
  assertFreshGitHubAppCredential,
  createGitHubInstallationToken,
} = await import("../src/github_app_token.mjs");
const bootstrapSharedCredentials = new Map();
const anonymousSharedReadRepositories = new Set();
if (configuration.githubApp) {
  await Promise.all(configuration.sharedRepositories.map(async (entry) => {
    const target = githubRepository(entry.repository, `Shared repository ${entry.repositoryId}`);
    if (target.transport !== "https") return;
    const installation = await createGitHubInstallationToken({
      ...configuration.githubApp,
      repository: target.name,
    });
    const credential = assertFreshGitHubAppCredential(installation, {
      minimumValidityMs: 31_000,
    });
    bootstrapSharedCredentials.set(entry.repository, {
      url: target.httpsUrl,
      token: credential.token,
      expiresAt: credential.expiresAt,
      timeoutMs: 30_000,
    });
  }));
} else {
  for (const entry of configuration.sharedRepositories) {
    const target = githubRepository(entry.repository, `Shared repository ${entry.repositoryId}`);
    if (target.transport !== "https") continue;
    try {
      execFileSync("git", ["ls-remote", "--heads", entry.repository], {
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 15_000,
        killSignal: "SIGTERM",
      });
      anonymousSharedReadRepositories.add(entry.repository);
    } catch {
      throw new Error("A Hosted HTTPS Shared repository that is not anonymously readable requires a configured GitHub App before startup can create application state");
    }
  }
}
const dataRoot = ensurePrivateDirectory(configuration.dataRoot, configuration.dataRoot, "CONTEXT_ROOM_DATA_ROOT", { root: true });
if (!hostedInstanceLease) {
  hostedInstanceLease = acquireHostedInstanceLease(dataRoot);
  process.once("exit", () => hostedInstanceLease.release());
}
const homeRoot = ensurePrivateDirectory(path.join(dataRoot, "home"), dataRoot, "HOME");
const hubHome = ensurePrivateDirectory(path.join(dataRoot, "hub"), dataRoot, "CONTEXT_ROOM_HUB_HOME");
const homeContextRoot = ensurePrivateDirectory(path.join(homeRoot, ".context-room"), dataRoot, "Hosted HOME state");
const sharedHome = ensurePrivateDirectory(path.join(homeContextRoot, "shared"), dataRoot, "CONTEXT_ROOM_SHARED_HOME");
const reviewAuthorityHome = ensurePrivateDirectory(path.join(dataRoot, "review-authority"), dataRoot, "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME");
const snapshotHome = ensurePrivateDirectory(path.join(dataRoot, "snapshots"), dataRoot, "CONTEXT_ROOM_SNAPSHOT_HOME");
const codexHome = ensurePrivateDirectory(path.join(dataRoot, "codex"), dataRoot, "CODEX_HOME");
const hermesHome = ensurePrivateDirectory(path.join(dataRoot, "hermes"), dataRoot, "HERMES_HOME");
const projectsRoot = ensurePrivateDirectory(path.join(dataRoot, "projects"), dataRoot, "Context Room projects root");
const hostRoot = ensurePrivateDirectory(path.join(dataRoot, "host"), dataRoot, "Context Room host root");
const gitConfigGlobal = ensureEmptyPrivateFile(path.join(dataRoot, "gitconfig-global-empty"), dataRoot, "GIT_CONFIG_GLOBAL");

process.env.CONTEXT_ROOM_BUILD_REVISION = configuration.buildRevision;
process.env.CONTEXT_ROOM_DATA_ROOT = dataRoot;
process.env.HOME = homeRoot;
process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = reviewAuthorityHome;
process.env.CONTEXT_ROOM_SNAPSHOT_HOME = snapshotHome;
process.env.CODEX_HOME = codexHome;
process.env.HERMES_HOME = hermesHome;
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_") || ["SSH_AUTH_SOCK", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"].includes(name)) delete process.env[name];
}
process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
if (configuration.proposalSsh) {
  process.env.GIT_SSH_COMMAND = [
    "ssh",
    "-i", shellQuote(configuration.proposalSsh.keyFile),
    "-o", "BatchMode=yes",
    "-o", "IdentityAgent=none",
    "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${shellQuote(configuration.proposalSsh.knownHostsFile)}`,
    "-o", "StrictHostKeyChecking=yes",
  ].join(" ");
}

const [
  { DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS, attestSharedProjectCapability, readSharedProjectConnection, syncSharedContext },
  { createMemoryServer, initializeContextRoomProject },
] = await Promise.all([
  import("../src/shared_context.mjs"),
  import("../src/context_room.mjs"),
]);

const bootstrapMarker = writeHostedBootstrapMarker(dataRoot, configuration.sharedRepositories);

const projectPlans = [];
for (const entry of configuration.sharedRepositories) {
  const repositoryRoot = path.join(projectsRoot, entry.repositoryId);
  for (const projectId of entry.projectIds) {
    const root = path.join(repositoryRoot, projectId);
    const existing = lstatMaybe(root) ? readSharedProjectConnection(root) : null;
    if (existing && (
      existing.repository !== entry.repository
      || githubRepository(existing.repository, `Shared project ${projectId}`).identity !== entry.identity
      || existing.projectId !== projectId
    )) {
      throw new Error(`Shared project ${projectId} has an unexpected existing repository binding`);
    }
    projectPlans.push({ entry, projectId, repositoryRoot, root, existing });
  }
}

const repositoryRoots = new Map();
for (const entry of configuration.sharedRepositories) {
  repositoryRoots.set(entry.repositoryId, ensurePrivateDirectory(
    path.join(projectsRoot, entry.repositoryId),
    dataRoot,
    `Shared repository ${entry.repositoryId}`,
  ));
}
const projectRoots = {};
for (const plan of projectPlans) {
  const { entry, projectId } = plan;
  const root = ensurePrivateDirectory(
    path.join(repositoryRoots.get(entry.repositoryId), projectId),
    dataRoot,
    `Shared project ${projectId}`,
  );
  initializeContextRoomProject(root, { title: projectId });
  projectRoots[projectId] = root;
}

writeHostedSharedRegistry(dataRoot, configuration.sharedRepositories, attestSharedProjectCapability);
try {
  for (const entry of configuration.sharedRepositories) {
    const firstProjectId = entry.projectIds[0];
    const push = bootstrapSharedCredentials.get(entry.repository) || null;
    syncSharedContext(projectRoots[firstProjectId], {
      allowOffline: true,
      ...(push ? { push, timeoutMs: push.timeoutMs } : {}),
    });
  }
} finally {
  bootstrapSharedCredentials.clear();
}
for (const plan of projectPlans) {
  assertHostedProjectBinding(
    plan.root,
    plan.entry,
    plan.projectId,
    readSharedProjectConnection(plan.root),
  );
}

initializeContextRoomProject(hostRoot, { title: "Peerlab Context Room", allowedPaths: [], watchAllow: [] });

const { server } = createMemoryServer({
  root: hostRoot,
  port: configuration.port,
  registerInHub: false,
  persistentDocumentGraphLayout: true,
  remoteAccess: {
    expectedHost: configuration.publicHost,
    browserHost: configuration.browserHost,
    humanSecret: configuration.humanSecret,
    agentSecret: configuration.agentSecret,
    issuer: configuration.issuer,
    healthSecret: configuration.healthSecret,
    adminSubjects: configuration.adminSubjects,
    projectRoots,
    sharedRepositories: configuration.sharedRepositories.map(({ repository, projectIds, scopes }) => ({ repository, projectIds, scopes })),
    anonymousSharedReadRepositories: [...anonymousSharedReadRepositories],
    githubApp: configuration.githubApp,
  },
});

clearHostedBootstrapMarker(bootstrapMarker, dataRoot);

server.listen(configuration.port, configuration.host, () => {
  console.log(`Peerlab Context Room remote server listening on ${configuration.host}:${configuration.port}`);
});
const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
