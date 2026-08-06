import assert from "node:assert/strict";
import test from "node:test";
import { gitHubAppGitEnvironment } from "../src/github_app_token.mjs";

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
