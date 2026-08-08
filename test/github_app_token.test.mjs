import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createGitHubInstallationToken, gitHubAppGitEnvironment } from "../src/github_app_token.mjs";

const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("gitHubAppGitEnvironment authenticates GitHub smart HTTP without prompting", () => {
  const environment = gitHubAppGitEnvironment("installation-token", { PATH: "/usr/bin" });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_CONFIG_COUNT, "1");
  assert.equal(environment.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  assert.match(environment.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);

  const credentials = Buffer.from(environment.GIT_CONFIG_VALUE_0.slice("Authorization: Basic ".length), "base64").toString("utf8");
  assert.equal(credentials, "x-access-token:installation-token");
});

test("gitHubAppGitEnvironment rejects missing or unsafe tokens", () => {
  assert.throws(() => gitHubAppGitEnvironment(""), /installation token is required/i);
  assert.throws(() => gitHubAppGitEnvironment("token\nheader"), /installation token is required/i);
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
