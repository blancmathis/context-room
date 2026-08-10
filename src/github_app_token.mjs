import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS = 15_000;
export const MINIMUM_GITHUB_APP_TOKEN_VALIDITY_MS = 1_000;

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function githubCredentialTarget(repository) {
  let parsed;
  try { parsed = new URL(String(repository || "").trim()); } catch {
    throw new Error("GitHub App credential repository is invalid");
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/.test(parsed.pathname)) {
    throw new Error("GitHub App credential repository is invalid");
  }
  return {
    protocol: "https",
    host: "github.com",
    path: parsed.pathname.slice(1),
  };
}

function credentialInput(target, token = null) {
  const lines = [
    `protocol=${target.protocol}`,
    `host=${target.host}`,
    `path=${target.path}`,
    "username=x-access-token",
  ];
  if (!token) return Buffer.from(`${lines.join("\n")}\n\n`, "utf8");
  return Buffer.concat([
    Buffer.from(`${lines.join("\n")}\npassword=`, "utf8"),
    token,
    Buffer.from("\n\n", "utf8"),
  ]);
}

function privateCredentialCacheRoot() {
  const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const root = fs.mkdtempSync(path.join(temporaryRoot, "cr-gh-"));
  fs.chmodSync(root, 0o700);
  return root;
}

function credentialGitProgram() {
  for (const candidate of ["/usr/bin/git", "/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error("A trusted Git executable is required for the GitHub App credential broker");
}

function posixShellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function privateGitEnvironment(baseEnvironment) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (/^(?:GIT_TRACE(?:_|$)|GIT_CURL_VERBOSE$|GIT_SSL_NO_VERIFY$|GCM_TRACE$|GIT_CONFIG_COUNT$|GIT_CONFIG_(?:KEY|VALUE)_\d+$|GIT_CONFIG_PARAMETERS$|GIT_EXEC_PATH$|GIT_ASKPASS$|SSH_ASKPASS$)/.test(key)) {
      delete environment[key];
    }
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  const falseProgram = ["/usr/bin/false", "/bin/false"].find((candidate) => fs.existsSync(candidate));
  if (falseProgram) {
    environment.GIT_ASKPASS = falseProgram;
    environment.SSH_ASKPASS = falseProgram;
  }
  return environment;
}

function waitForSocketRemoval(socketPath, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(socketPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return !fs.existsSync(socketPath);
}

/**
 * Run one Git operation with a repository-scoped installation credential.
 *
 * The secret is delivered only through `git credential approve` stdin. The
 * network Git process receives a non-secret credential-cache socket path in
 * argv and asks Git's private in-memory daemon for the credential. The token is
 * never placed in argv, the environment, Git configuration, or a regular file.
 */
export function withGitHubAppGitCredential(
  credential,
  repository,
  callback,
  {
    baseEnvironment = process.env,
    timeoutMs = DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS,
  } = {},
) {
  if (typeof callback !== "function") throw new TypeError("GitHub App Git credential callback is required");
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS;
  const fresh = assertFreshGitHubAppCredential(credential, {
    minimumValidityMs: Math.max(MINIMUM_GITHUB_APP_TOKEN_VALIDITY_MS, Math.min(boundedTimeoutMs, 30_000)),
  });
  const target = githubCredentialTarget(repository);
  const gitProgram = credentialGitProgram();
  const cacheRoot = privateCredentialCacheRoot();
  const emptyHooksRoot = path.join(cacheRoot, "hooks");
  fs.mkdirSync(emptyHooksRoot, { mode: 0o700 });
  const socketPath = path.join(cacheRoot, "cache.sock");
  if (Buffer.byteLength(socketPath, "utf8") > 90) {
    try { fs.rmSync(cacheRoot, { recursive: true, force: true }); } catch {}
    throw new Error("GitHub App credential cache socket path is too long");
  }
  const remainingSeconds = Math.max(1, Math.ceil((Date.parse(fresh.expiresAt) - Date.now()) / 1_000));
  const budgetSeconds = Math.max(1, Math.ceil((boundedTimeoutMs + 5_000) / 1_000));
  const helper = `!${posixShellQuote(gitProgram)} credential-cache --timeout=${Math.min(remainingSeconds, budgetSeconds)} --socket=${posixShellQuote(socketPath)} "$@"`;
  const gitArguments = [
    "-c", "credential.helper=",
    "-c", `credential.helper=${helper}`,
    "-c", "credential.https://github.com.useHttpPath=true",
    "-c", "credential.username=x-access-token",
    "-c", "credential.interactive=false",
    "-c", "core.askPass=",
    "-c", `core.hooksPath=${emptyHooksRoot}`,
    "-c", "http.extraHeader=",
    "-c", "http.https://github.com/.extraHeader=",
    "-c", "http.sslVerify=true",
    "-c", "http.followRedirects=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "submodule.recurse=false",
    "-c", "push.recurseSubmodules=no",
  ];
  const environment = privateGitEnvironment(baseEnvironment);
  const token = Buffer.from(fresh.token, "utf8");
  const approve = credentialInput(target, token);
  token.fill(0);
  let result;
  let operationError = null;
  let brokerMayHaveStarted = false;
  try {
    try {
      execFileSync(gitProgram, [...gitArguments, "credential", "approve"], {
        env: environment,
        input: approve,
        encoding: null,
        stdio: ["pipe", "ignore", "pipe"],
        timeout: boundedTimeoutMs,
        killSignal: "SIGTERM",
      });
      brokerMayHaveStarted = true;
    } catch (cause) {
      const error = new Error("GitHub App credential cache could not start");
      error.code = "github-app-credential-broker-unavailable";
      error.cause = cause;
      throw error;
    }
    if (!fs.existsSync(socketPath) || !fs.lstatSync(socketPath).isSocket()) {
      throw new Error("GitHub App credential cache did not create its private socket");
    }
    fs.chmodSync(socketPath, 0o600);
    result = callback({ gitArguments, environment, cacheRoot, socketPath });
    if (result && typeof result.then === "function") {
      throw new TypeError("GitHub App Git credential callback must be synchronous");
    }
  } catch (error) {
    operationError = error;
  } finally {
    approve.fill(0);
  }
  const cleanupFailures = [];
  if (brokerMayHaveStarted || fs.existsSync(socketPath)) {
    const reject = credentialInput(target);
    try {
      execFileSync(gitProgram, [...gitArguments, "credential", "reject"], {
        env: environment,
        input: reject,
        encoding: null,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: Math.min(5_000, boundedTimeoutMs),
        killSignal: "SIGTERM",
      });
    } catch (error) {
      cleanupFailures.push(error);
    } finally {
      reject.fill(0);
    }
    try {
      execFileSync(gitProgram, ["credential-cache", `--socket=${socketPath}`, "exit"], {
        env: environment,
        encoding: null,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: Math.min(5_000, boundedTimeoutMs),
        killSignal: "SIGTERM",
      });
    } catch (error) {
      if (fs.existsSync(socketPath)) cleanupFailures.push(error);
    }
    if (!waitForSocketRemoval(socketPath)) cleanupFailures.push(new Error("credential cache socket remained active"));
  }
  try { fs.rmSync(cacheRoot, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  if (fs.existsSync(cacheRoot)) cleanupFailures.push(new Error("credential cache directory remained on disk"));
  if (cleanupFailures.length) {
    const error = new Error("GitHub App credential cache cleanup failed");
    error.code = "github-app-credential-broker-cleanup-failed";
    error.retryable = true;
    error.cause = operationError || cleanupFailures[0];
    throw error;
  }
  if (operationError) throw operationError;
  return result;
}

export function assertFreshGitHubAppCredential(
  credential,
  {
    now = Date.now(),
    minimumValidityMs = MINIMUM_GITHUB_APP_TOKEN_VALIDITY_MS,
  } = {},
) {
  const token = String(credential?.token || "").trim();
  const expiresAt = String(credential?.expiresAt || "").trim();
  const expiresAtMs = Date.parse(expiresAt);
  const requiredValidityMs = Number.isFinite(Number(minimumValidityMs)) && Number(minimumValidityMs) >= 0
    ? Math.floor(Number(minimumValidityMs))
    : MINIMUM_GITHUB_APP_TOKEN_VALIDITY_MS;
  if (!token || /[\r\n\0]/.test(token)) {
    const error = new Error("GitHub App installation credential is invalid");
    error.code = "github-app-credential-invalid";
    throw error;
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Number(now) + requiredValidityMs) {
    const error = new Error("GitHub App installation token expired before the Git operation started");
    error.code = "github-app-token-expired";
    error.retryable = true;
    throw error;
  }
  return { token, expiresAt };
}

export function createGitHubAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const issuer = String(appId || "").trim();
  const key = String(privateKey || "").replaceAll("\\n", "\n").trim();
  if (!/^[0-9]+$/.test(issuer) || !key.includes("PRIVATE KEY")) throw new Error("GitHub App id and private key are required");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 30, exp: now + 540, iss: issuer });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(key, "base64url");
  return `${unsigned}.${signature}`;
}

function normalizedTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
}

function githubAppTokenTimeoutError(timeoutMs, cause = null) {
  const error = new Error(`GitHub App installation token request timed out after ${timeoutMs} ms`);
  error.code = "github-app-token-timeout";
  error.retryable = true;
  if (cause) error.cause = cause;
  return error;
}

function combineAbortSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length < 2) return { signal: active[0], cleanup: () => {} };
  const controller = new AbortController();
  const listeners = [];
  for (const source of active) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const abort = () => controller.abort(source.reason);
    source.addEventListener("abort", abort, { once: true });
    listeners.push([source, abort]);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [source, abort] of listeners) source.removeEventListener("abort", abort);
    },
  };
}

export async function createGitHubInstallationToken({
  appId,
  privateKey,
  installationId,
  repository,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS,
  signal = null,
}) {
  const jwt = createGitHubAppJwt({ appId, privateKey });
  const requestTimeoutMs = normalizedTimeoutMs(timeoutMs);
  const timeoutController = requestTimeoutMs ? new AbortController() : null;
  const combinedSignal = combineAbortSignals([signal, timeoutController?.signal]);
  let timedOut = false;
  const timer = requestTimeoutMs ? setTimeout(() => {
    timedOut = true;
    timeoutController.abort(githubAppTokenTimeoutError(requestTimeoutMs));
  }, requestTimeoutMs) : null;
  try {
    const response = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(String(installationId || ""))}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ repositories: [String(repository || "")], permissions: { contents: "write" } }),
      ...(combinedSignal.signal ? { signal: combinedSignal.signal } : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) throw new Error(`GitHub App installation token request failed (${response.status})`);
    return { token: body.token, expiresAt: body.expires_at || "" };
  } catch (error) {
    if (timedOut) throw githubAppTokenTimeoutError(requestTimeoutMs, error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    combinedSignal.cleanup();
  }
}
