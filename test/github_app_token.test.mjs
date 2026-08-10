import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  assertFreshGitHubAppCredential,
  createGitHubInstallationToken,
  withGitHubAppGitCredential,
} from "../src/github_app_token.mjs";

const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("withGitHubAppGitCredential brokers one repository credential without argv, env, or filesystem persistence", () => {
  const token = "installation-token";
  const basicHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
  let cacheRoot = "";
  const filled = withGitHubAppGitCredential({
    token,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, "https://github.com/example/context-room.git", ({ gitArguments, environment, cacheRoot: root, socketPath }) => {
    cacheRoot = root;
    assert.equal(Object.values(environment).some((value) => [token, basicHeader].some((secret) => String(value).includes(secret))), false);
    assert.equal(gitArguments.some((value) => [token, basicHeader].some((secret) => String(value).includes(secret))), false);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
    assert.equal(gitArguments.includes("credential.helper="), true);
    assert.equal(gitArguments.includes("credential.https://github.com.useHttpPath=true"), true);
    assert.equal(gitArguments.includes("http.extraHeader="), true);
    assert.match(gitArguments.find((value) => String(value).includes(" credential-cache ")), /^credential\.helper=!'.*git' credential-cache .*--timeout=7\b/);
    const exact = execFileSync("git", [...gitArguments, "credential", "fill"], {
      env: environment,
      input: "protocol=https\nhost=github.com\npath=example/context-room.git\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const crossRepository = (() => {
      try {
        execFileSync("git", [...gitArguments, "credential", "fill"], {
          env: environment,
          input: "protocol=https\nhost=github.com\npath=example/other.git\n\n",
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return null;
      } catch (error) {
        return error;
      }
    })();
    assert.notEqual(crossRepository, null);
    assert.equal(String(crossRepository.stdout || "").includes(token), false);
    assert.equal(String(crossRepository.stderr || "").includes(token), false);
    return exact;
  }, {
    timeoutMs: 2_000,
    baseEnvironment: {
      PATH: process.env.PATH,
      GIT_TRACE: "1",
      GIT_CURL_VERBOSE: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: basicHeader,
    },
  });
  assert.match(filled, /username=x-access-token/);
  assert.match(filled, /password=installation-token/);
  assert.equal(fs.existsSync(cacheRoot), false);
});

test("withGitHubAppGitCredential rejects invalid secrets and non-exact GitHub HTTPS targets", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  for (const token of ["", "token\nheader"]) {
    assert.throws(
      () => withGitHubAppGitCredential({ token, expiresAt: future }, "https://github.com/example/repo.git", () => {}),
      (error) => error?.code === "github-app-credential-invalid",
    );
  }
  for (const repository of ["http://github.com/example/repo.git", "https://example.com/example/repo.git", "https://token@github.com/example/repo.git"]) {
    assert.throws(
      () => withGitHubAppGitCredential({ token: "safe-token", expiresAt: future }, repository, () => {}),
      /repository is invalid/i,
    );
  }
});

test("withGitHubAppGitCredential fails closed when its private cache cannot be removed", () => {
  const originalRemove = fs.rmSync;
  let cacheRoot = "";
  try {
    assert.throws(() => withGitHubAppGitCredential({
      token: "cleanup-failure-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "https://github.com/example/context-room.git", ({ cacheRoot: root }) => {
      cacheRoot = root;
      fs.rmSync = () => { throw new Error("injected cleanup failure"); };
      return "network result must not escape before cleanup";
    }, { timeoutMs: 2_000 }), (error) => (
      error?.code === "github-app-credential-broker-cleanup-failed"
      && error?.retryable === true
      && !error.message.includes("cleanup-failure-token")
    ));
  } finally {
    fs.rmSync = originalRemove;
    if (cacheRoot) originalRemove(cacheRoot, { recursive: true, force: true });
  }
});

test("assertFreshGitHubAppCredential rejects expired, near-expiry, and incomplete credentials", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.deepEqual(assertFreshGitHubAppCredential({
    token: "request-scoped-token",
    expiresAt: "2030-01-01T00:01:00Z",
  }, { now }), {
    token: "request-scoped-token",
    expiresAt: "2030-01-01T00:01:00Z",
  });
  for (const credential of [
    { token: "request-scoped-token", expiresAt: "2029-12-31T23:59:59Z" },
    { token: "request-scoped-token", expiresAt: "2030-01-01T00:00:00.500Z" },
    { token: "request-scoped-token", expiresAt: "not-a-date" },
  ]) {
    assert.throws(
      () => assertFreshGitHubAppCredential(credential, { now }),
      (error) => error?.code === "github-app-token-expired" && error?.retryable === true,
    );
  }
  assert.throws(
    () => assertFreshGitHubAppCredential({ token: "", expiresAt: "2030-01-01T00:01:00Z" }, { now }),
    (error) => error?.code === "github-app-credential-invalid",
  );
});

test("createGitHubInstallationToken sends the exact GitHub App request scoped to one repository", async () => {
  const requests = [];
  const expiresAt = "2026-08-07T12:34:56Z";
  const result = await createGitHubInstallationToken({
    appId: "123456",
    privateKey: testPrivateKey,
    installationId: "987654",
    repository: "context-room",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: "installation-access-token", expires_at: expiresAt }),
      };
    },
  });

  assert.deepEqual(result, { token: "installation-access-token", expiresAt });
  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url, "https://api.github.com/app/installations/987654/access_tokens");
  assert.equal(options.method, "POST");
  assert.deepEqual(options.headers, {
    accept: "application/vnd.github+json",
    authorization: options.headers.authorization,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  });
  assert.match(options.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(JSON.parse(options.body), {
    repositories: ["context-room"],
    permissions: { contents: "write" },
  });

  const jwt = options.headers.authorization.slice("Bearer ".length);
  const [encodedHeader, encodedPayload] = jwt.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "123456");
  assert.equal(payload.exp - payload.iat, 570);
  assert.ok(payload.iat <= Math.floor(Date.now() / 1000));
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test("createGitHubInstallationToken rejects HTTP failures and successful responses without a token", async (t) => {
  for (const scenario of [
    {
      name: "GitHub rejects the installation request",
      response: { ok: false, status: 403, json: async () => ({ message: "Forbidden" }) },
      status: 403,
    },
    {
      name: "GitHub returns an invalid success payload",
      response: { ok: true, status: 201, json: async () => ({ expires_at: "2026-08-07T12:34:56Z" }) },
      status: 201,
    },
    {
      name: "GitHub returns a non-JSON server failure",
      response: { ok: false, status: 502, json: async () => { throw new Error("not json"); } },
      status: 502,
    },
  ]) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        createGitHubInstallationToken({
          appId: "123456",
          privateKey: testPrivateKey,
          installationId: "987654",
          repository: "context-room",
          fetchImpl: async () => scenario.response,
        }),
        new RegExp(`installation token request failed \\(${scenario.status}\\)`, "i"),
      );
    });
  }
});
