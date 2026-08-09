#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "context-room";
const DEFAULT_PORT = 4317;
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return path.normalize(absolute);
  }
}

export function tokenizeCommand(command) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;

  for (const character of String(command || "")) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function flagValue(tokens, name) {
  const prefix = `--${name}=`;
  const inline = tokens.find((token) => token.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = tokens.indexOf(`--${name}`);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function contextRoomExecutableIndex(tokens) {
  if (!tokens.length) return -1;
  const executable = path.basename(tokens[0]);
  if (/^context-room(?:\.cmd)?$/i.test(executable)) return 0;
  if (!/^node(?:\.exe)?$/i.test(executable)) return -1;
  const scriptIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith("-"));
  return scriptIndex > 0 && /(?:^|\/)(?:context[-_]room)(?:\.mjs)?$/i.test(tokens[scriptIndex])
    ? scriptIndex
    : -1;
}

function contextRoomInvocationKind(tokens) {
  const executableIndex = contextRoomExecutableIndex(tokens);
  if (executableIndex < 0) return null;
  const invocation = tokens.slice(executableIndex + 1);
  if (invocation.some((token) => token === "--version" || token.startsWith("--version="))) return "legacy";
  if (!invocation.length) return "server";
  if (invocation.some((token) => token === "--help" || token === "--h" || token === "-h")) return null;

  const defaultServerOptions = new Set(["root", "title", "allow", "watch", "port"]);
  const serverCommands = new Set(["start", "setup"]);
  const nonServerCommands = new Set(["init", "doctor", "guard", "brief", "agent", "install-hook", "install-hooks", "update-all"]);
  const positionals = [];
  for (let index = 0; index < invocation.length; index += 1) {
    const token = invocation[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const option = token.slice(2);
    const equalsIndex = option.indexOf("=");
    const key = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
    if (!defaultServerOptions.has(key)) return null;
    if (equalsIndex === -1) {
      if (!invocation[index + 1] || invocation[index + 1].startsWith("--")) return null;
      index += 1;
    }
  }
  if (positionals.some((token) => serverCommands.has(token))) return "server";
  if (positionals.some((token) => nonServerCommands.has(token))) return null;
  if (!positionals.length) return "server";
  return invocation[0]?.startsWith("--") ? "implicit" : null;
}

export function contextRoomInstanceFromProcess({ pid, command, cwd }) {
  const tokens = tokenizeCommand(command);
  if (!contextRoomInvocationKind(tokens) || !cwd) return null;

  const rootValue = flagValue(tokens, "root") || ".";
  const portValue = flagValue(tokens, "port") || String(DEFAULT_PORT);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    pid: Number(pid),
    root: canonicalPath(path.resolve(cwd, rootValue)),
    port,
    command,
  };
}

export function isDevelopmentCheckout(root) {
  const packagePath = path.join(root, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return packageJson.name === PACKAGE_NAME
      && fs.existsSync(path.join(root, ".git"))
      && fs.existsSync(path.join(root, "bin", "context-room.mjs"))
      && fs.existsSync(path.join(root, "src", "context_room.mjs"));
  } catch {
    return false;
  }
}

export function selectRestartableInstances(instances, excludedRoots = []) {
  const exclusions = new Set(excludedRoots.map(canonicalPath));
  const restartable = new Map();
  const excluded = [];

  for (const instance of instances) {
    const normalizedInstance = { ...instance, root: canonicalPath(instance.root) };
    if (exclusions.has(normalizedInstance.root) || isDevelopmentCheckout(normalizedInstance.root)) {
      excluded.push(normalizedInstance);
      continue;
    }
    restartable.set(`${normalizedInstance.root}\0${normalizedInstance.port}`, normalizedInstance);
  }

  return { restartable: [...restartable.values()], excluded };
}

function processCwd(pid) {
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
    return cwdLine ? cwdLine.slice(1) : "";
  } catch {
    return "";
  }
}

function processListeningPorts(pid) {
  try {
    const output = execFileSync("lsof", ["-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
    return [...new Set(output.split("\n").map((line) => {
      const match = line.match(/^n(?:[^:]+|\[[^\]]+\]):(\d+)$/);
      return match ? Number(match[1]) : null;
    }).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
  } catch (error) {
    if (error?.status === 1 && !String(error.stderr || "").trim()) return [];
    throw error;
  }
}

async function verifiedInstanceFromHealth(instance, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${instance.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    if (!response.ok || !health.ok || !health.root) return null;
    return { ...instance, root: canonicalPath(health.root) };
  } catch {
    return null;
  }
}

export async function resolveContextRoomInstance(instance, {
  listeningPorts = [],
  explicitPort = false,
  fetchImpl = fetch,
} = {}) {
  return (await resolveContextRoomCandidate(instance, { listeningPorts, explicitPort, fetchImpl })).verified;
}

export async function resolveContextRoomCandidate(instance, {
  listeningPorts = [],
  explicitPort = false,
  fetchImpl = fetch,
} = {}) {
  const ports = [...new Set(listeningPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
  if (explicitPort) {
    if (!ports.includes(instance.port)) {
      return { verified: null, reason: `declared port ${instance.port} is not owned by PID ${instance.pid}` };
    }
    const verified = await verifiedInstanceFromHealth(instance, fetchImpl);
    return verified
      ? { verified, reason: "" }
      : { verified: null, reason: `declared port ${instance.port} did not return valid Context Room health` };
  }

  if (!ports.length) return { verified: null, reason: `PID ${instance.pid} has no observed TCP listeners` };
  const verified = (await Promise.all(ports.map((port) => (
    verifiedInstanceFromHealth({ ...instance, port }, fetchImpl)
  )))).filter(Boolean);
  if (!verified.length) return { verified: null, reason: "no observed listener returned valid Context Room health" };
  if (verified.length > 1) return { verified: null, reason: "multiple listeners returned valid Context Room health" };
  return { verified: verified[0], reason: "" };
}

export async function discoverRunningInstances({
  listProcesses = () => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
  cwdForPid = processCwd,
  listeningPortsForPid = processListeningPorts,
  fetchImpl = fetch,
} = {}) {
  const output = listProcesses();
  const resolutions = [];
  const unresolved = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    const tokens = tokenizeCommand(match[2]);
    const invocationKind = contextRoomInvocationKind(tokens);
    if (!invocationKind) continue;
    let listeningPorts;
    if (invocationKind === "legacy" || invocationKind === "implicit") {
      try {
        listeningPorts = listeningPortsForPid(pid);
      } catch {
        unresolved.push({ pid, command, reason: "could not inspect the process TCP listeners" });
        continue;
      }
      if (!listeningPorts.length) continue;
    }
    let cwd;
    try {
      cwd = cwdForPid(pid);
    } catch {
      cwd = "";
    }
    if (!cwd) {
      unresolved.push({ pid, command, reason: "could not determine the process working directory" });
      continue;
    }
    const instance = contextRoomInstanceFromProcess({
      pid,
      command,
      cwd,
    });
    if (!instance) {
      unresolved.push({ pid, command, reason: "could not resolve the process root or port" });
      continue;
    }
    if (!listeningPorts) {
      try {
        listeningPorts = listeningPortsForPid(instance.pid);
      } catch {
        unresolved.push({ pid, command, reason: "could not inspect the process TCP listeners" });
        continue;
      }
    }
    resolutions.push(resolveContextRoomCandidate(instance, {
      listeningPorts,
      explicitPort: flagValue(tokens, "port") !== undefined,
      fetchImpl,
    }).then((resolution) => ({ pid, command, invocationKind, ...resolution })));
  }
  const verified = [];
  for (const resolution of await Promise.all(resolutions)) {
    if (resolution.verified) verified.push(resolution.verified);
    else unresolved.push({ pid: resolution.pid, command: resolution.command, reason: resolution.reason });
  }
  return { verified, unresolved };
}

export function parseUpdateArgs(argv) {
  const options = { dryRun: false, noRestart: false, excludes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--no-restart") options.noRestart = true;
    else if (argument === "--exclude") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--exclude requires a path");
      options.excludes.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--exclude=")) {
      const excludePath = argument.slice("--exclude=".length);
      if (!excludePath || excludePath.startsWith("--")) throw new Error("--exclude requires a path");
      options.excludes.push(excludePath);
    }
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function latestVersion() {
  const output = execFileSync("npm", ["view", PACKAGE_NAME, "version", "--json"], { encoding: "utf8" });
  return JSON.parse(output);
}

function installLatestGlobal(version) {
  execFileSync("npm", ["install", "--global", `${PACKAGE_NAME}@${version}`], { stdio: "inherit" });
}

function globalCliPath() {
  const prefix = execFileSync("npm", ["prefix", "--global"], { encoding: "utf8" }).trim();
  return path.join(prefix, "bin", process.platform === "win32" ? "context-room.cmd" : "context-room");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process ${pid} did not stop after ${timeoutMs}ms`);
}

async function waitForHealth(instance, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = await response.json();
      if (response.ok && health.ok && canonicalPath(health.root) === instance.root) return;
      lastError = new Error(`Unexpected health response on port ${instance.port}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Context Room on port ${instance.port} did not become healthy: ${lastError?.message || "timeout"}`);
}

export async function revalidateRestartTarget(instance, {
  listeningPortsForPid = processListeningPorts,
  fetchImpl = fetch,
} = {}) {
  let listeningPorts;
  try {
    listeningPorts = listeningPortsForPid(instance.pid);
  } catch {
    throw new Error(`Refusing to stop PID ${instance.pid}: its listeners could not be revalidated`);
  }
  if (!listeningPorts.includes(instance.port)) {
    throw new Error(`Refusing to stop PID ${instance.pid}: it no longer owns port ${instance.port}`);
  }
  const verified = await verifiedInstanceFromHealth(instance, fetchImpl);
  if (!verified) {
    throw new Error(`Refusing to stop PID ${instance.pid}: port ${instance.port} no longer returns Context Room health`);
  }
  if (canonicalPath(verified.root) !== canonicalPath(instance.root)) {
    throw new Error(`Refusing to stop PID ${instance.pid}: port ${instance.port} now serves a different project root`);
  }
  return verified;
}

export async function restartInstance(instance, cliPath, logDir, dependencies = {}) {
  try {
    fs.accessSync(cliPath, fs.constants.X_OK);
  } catch {
    throw new Error(`Replacement Context Room CLI is not executable: ${cliPath}`);
  }
  await revalidateRestartTarget(instance, dependencies);
  const killProcess = dependencies.killProcess || process.kill;
  killProcess(instance.pid, "SIGTERM");
  await waitForExit(instance.pid);

  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `context-room-${instance.port}.log`);
  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawn(cliPath, ["start", "--root", instance.root, "--port", String(instance.port)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  await waitForHealth(instance);
  return logPath;
}

function printUsage() {
  console.log(`Update every running Context Room to the latest npm release.\n\nUsage:\n  context-room update-all [--dry-run] [--no-restart] [--exclude /path]\n\nThe Context Room development checkout is always excluded.`);
}

export async function updateAllContextRooms(argv = [], dependencies = {}) {
  const options = parseUpdateArgs(argv);
  if (options.help) {
    printUsage();
    return { version: "", restarted: [], excluded: [] };
  }

  const discover = dependencies.discoverRunningInstances || discoverRunningInstances;
  const getLatestVersion = dependencies.latestVersion || latestVersion;
  const installGlobal = dependencies.installLatestGlobal || installLatestGlobal;
  const getGlobalCliPath = dependencies.globalCliPath || globalCliPath;
  const restart = dependencies.restartInstance || restartInstance;
  const discovery = await discover();
  if (discovery.unresolved.length) {
    const details = discovery.unresolved.map((candidate) => `PID ${candidate.pid}: ${candidate.reason}`).join("; ");
    throw new Error(`Cannot safely update Context Rooms because discovery is unresolved: ${details}`);
  }
  const excludedRoots = [SCRIPT_ROOT, ...options.excludes];
  const { restartable, excluded } = selectRestartableInstances(discovery.verified, excludedRoots);
  const version = getLatestVersion();

  console.log(`Latest npm release: ${PACKAGE_NAME}@${version}`);
  for (const instance of excluded) console.log(`Excluded development room: ${instance.root} (port ${instance.port})`);
  for (const instance of restartable) console.log(`Will update: ${instance.root} (port ${instance.port}, pid ${instance.pid})`);
  if (!restartable.length) console.log("No non-development Context Room is currently running.");

  if (options.dryRun) {
    console.log("Dry run: no installation or process was changed.");
    return { version, restarted: [], excluded };
  }

  console.log(`Installing ${PACKAGE_NAME}@${version} globally...`);
  installGlobal(version);
  if (options.noRestart) {
    console.log("Global CLI updated; running rooms were left unchanged.");
    return { version, restarted: [], excluded };
  }

  const cliPath = getGlobalCliPath();
  const logDir = path.join(os.homedir(), ".context-room", "logs");
  const restarted = [];
  for (const instance of restartable) {
    const logPath = await restart(instance, cliPath, logDir);
    restarted.push(instance);
    console.log(`Updated: ${instance.root} -> http://127.0.0.1:${instance.port} (log: ${logPath})`);
  }
  console.log(`Done: ${restarted.length} room(s) restarted on ${PACKAGE_NAME}@${version}.`);
  return { version, restarted, excluded };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  updateAllContextRooms(process.argv.slice(2)).catch((error) => {
    console.error(`Context Room update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
