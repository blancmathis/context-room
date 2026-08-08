import { createSign } from "node:crypto";

export const DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS = 15_000;

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function gitHubAppGitEnvironment(token, baseEnvironment = process.env) {
  const installationToken = String(token || "").trim();
  if (!installationToken || /[\r\n\0]/.test(installationToken)) {
    throw new Error("GitHub App installation token is required");
  }
  const credentials = Buffer.from(`x-access-token:${installationToken}`, "utf8").toString("base64");
  return {
    ...baseEnvironment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  };
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
