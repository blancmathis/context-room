import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

const cli = new URL("../bin/context-room.mjs", import.meta.url);

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli.pathname, ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("context-room ui uses the generic remote bearer transport", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/agent/ui/workspaces")) res.end(JSON.stringify({ workspaces: [{ workspaceId: "workspace-remote" }], generatedAt: "now" }));
    else res.end(JSON.stringify({ status: "commanded", workspace: { workspaceId: "workspace-remote" }, command: { id: "command-one" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    CONTEXT_ROOM_REMOTE_URL: `http://127.0.0.1:${server.address().port}`,
    CONTEXT_ROOM_REMOTE_TOKEN: "remote-one-use-token",
    CODEX_THREAD_ID: "",
  };

  const listed = await runCli(["ui", "list", "--all", "--project", "hicharlie", "--format", "json"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /workspace-remote/);

  const opened = await runCli([
    "ui", "open", "--workspace", "workspace-remote", "--project", "hicharlie", "--proposal", "proposal/hicharlie/chat", "--file", "projects/hicharlie/docs/PRODUCT.md", "--view", "proposal", "--settings", "project", "--search", "priority", "--filter", "docs/", "--heading", "Purpose", "--format", "json",
  ], env);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /command-one/);

  assert.equal(requests[0].authorization, "Bearer remote-one-use-token");
  assert.match(requests[0].url, /all=1/);
  assert.match(requests[0].url, /project=hicharlie/);
  assert.equal(requests[1].authorization, "Bearer remote-one-use-token");
  assert.deepEqual(requests[1].body, {
    workspace: "workspace-remote",
    recent: false,
    label: "",
    navigation: {
      view: "proposal",
      project: "hicharlie",
      proposal: "proposal/hicharlie/chat",
      file: "projects/hicharlie/docs/PRODUCT.md",
      settingsSection: "project",
      search: "priority",
      filters: ["docs/"],
      target: { heading: "Purpose" },
    },
  });

  const implicitSession = await runCli(["ui", "open", "--project", "hicharlie", "--view", "home", "--format", "json"], {
    ...env,
    CODEX_THREAD_ID: "thread-current",
  });
  assert.equal(implicitSession.status, 0, implicitSession.stderr);
  assert.equal(Object.hasOwn(requests[2].body, "session"), false);
  assert.equal(Object.hasOwn(requests[2].body.navigation, "target"), false);

  const explicitSession = await runCli(["ui", "open", "--project", "hicharlie", "--session", "thread-explicit", "--view", "home", "--format", "json"], env);
  assert.equal(explicitSession.status, 0, explicitSession.stderr);
  assert.equal(requests[3].body.session, "thread-explicit");
});
