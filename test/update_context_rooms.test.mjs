import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextRoomInstanceFromProcess,
  discoverRunningInstances,
  isDevelopmentCheckout,
  parseUpdateArgs,
  restartInstance,
  resolveContextRoomInstance,
  selectRestartableInstances,
  tokenizeCommand,
  updateAllContextRooms,
} from "../scripts/update-context-rooms.mjs";

test("update command tokenizes quoted project paths", () => {
  assert.deepEqual(
    tokenizeCommand('node /opt/context-room.mjs start --root "/tmp/My Project" --port 4320'),
    ["node", "/opt/context-room.mjs", "start", "--root", "/tmp/My Project", "--port", "4320"],
  );
});

test("invalid update exclusions fail before update side effects", async () => {
  for (const argv of [
    ["--exclude"],
    ["--exclude", "--dry-run"],
    ["--exclude="],
    ["--exclude=--dry-run"],
  ]) {
    assert.throws(() => parseUpdateArgs(argv), /--exclude requires a path/);
    await assert.rejects(updateAllContextRooms(argv), /--exclude requires a path/);
  }
});

test("running Context Room processes expose their resolved root and port", () => {
  const instance = contextRoomInstanceFromProcess({
    pid: 42,
    cwd: "/tmp",
    command: "node /opt/context-room.mjs start --root project --port=4320",
  });

  assert.deepEqual(instance, {
    pid: 42,
    root: path.resolve("/tmp/project"),
    port: 4320,
    command: "node /opt/context-room.mjs start --root project --port=4320",
  });
  assert.equal(contextRoomInstanceFromProcess({
    pid: 44,
    cwd: "/tmp",
    command: "context-room setup --root project --port 4321",
  })?.port, 4321);
  assert.equal(contextRoomInstanceFromProcess({
    pid: 45,
    cwd: "/tmp/Project With Spaces",
    command: "node /opt/context-room --version",
  })?.root, path.resolve("/tmp/Project With Spaces"));
  assert.equal(contextRoomInstanceFromProcess({
    pid: 46,
    cwd: "/tmp",
    command: "context-room --root 'Project With Spaces'",
  })?.root, path.resolve("/tmp/Project With Spaces"));
  assert.equal(contextRoomInstanceFromProcess({ pid: 43, cwd: "/tmp", command: "/bin/bash node context-room.mjs start" }), null);
  assert.equal(contextRoomInstanceFromProcess({ pid: 47, cwd: "/tmp", command: "context-room doctor --root project" }), null);
  assert.equal(contextRoomInstanceFromProcess({
    pid: 48,
    cwd: "/tmp/context-room",
    command: "node --experimental-vm-modules /tmp/kernel.js --working-dir /tmp/context-room",
  }), null);
});

test("discovery verifies default and legacy server invocations while ignoring transient probes", async (t) => {
  const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "Context Room Default "));
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "Context Room Legacy "));
  t.after(() => fs.rmSync(defaultRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(legacyRoot, { recursive: true, force: true }));
  const cwdRequests = [];

  const discovery = await discoverRunningInstances({
    listProcesses: () => [
      `  70 node /opt/context-room --root "${defaultRoot}"`,
      "  71 node /opt/context-room --version",
      "  72 node /opt/context-room --version",
      "  73 node /opt/context-room doctor --root ignored",
      "  74 node /opt/context-room --version",
      `  75 node /opt/context-room --root "${defaultRoot}" --port 4322 start`,
      `  76 node /opt/context-room --root ${defaultRoot} --port 4324`,
      "  77 node /opt/context-room --root /tmp doctor",
      "  78 node --experimental-vm-modules /tmp/kernel.js --working-dir /tmp/context-room",
    ].join("\n"),
    cwdForPid: (pid) => {
      cwdRequests.push(pid);
      return pid === 71 ? "/tmp/legacy launch directory" : "/tmp";
    },
    listeningPortsForPid: (pid) => ({
      70: [4317],
      71: [4320],
      72: [],
      74: [9229],
      75: [4322],
      76: [4324],
    }[pid] || []),
    fetchImpl: async (url) => {
      const port = Number(new URL(url).port);
      if (port === 4317) return { ok: true, json: async () => ({ ok: true, root: defaultRoot }) };
      if (port === 4320) return { ok: true, json: async () => ({ ok: true, root: legacyRoot }) };
      if (port === 4322) return { ok: true, json: async () => ({ ok: true, root: defaultRoot }) };
      if (port === 4324) return { ok: true, json: async () => ({ ok: true, root: defaultRoot }) };
      return { ok: true, json: async () => ({ debugger: true }) };
    },
  });

  assert.deepEqual(discovery.unresolved, [{
    pid: 74,
    command: "node /opt/context-room --version",
    reason: "no observed listener returned valid Context Room health",
  }]);
  assert.deepEqual(discovery.verified, [
    {
      pid: 70,
      root: fs.realpathSync(defaultRoot),
      port: 4317,
      command: `node /opt/context-room --root "${defaultRoot}"`,
    },
    {
      pid: 71,
      root: fs.realpathSync(legacyRoot),
      port: 4320,
      command: "node /opt/context-room --version",
    },
    {
      pid: 75,
      root: fs.realpathSync(defaultRoot),
      port: 4322,
      command: `node /opt/context-room --root "${defaultRoot}" --port 4322 start`,
    },
    {
      pid: 76,
      root: fs.realpathSync(defaultRoot),
      port: 4324,
      command: `node /opt/context-room --root ${defaultRoot} --port 4324`,
    },
  ]);
  assert.deepEqual(cwdRequests, [70, 71, 74, 75, 76]);
});

test("implicit-port discovery probes every listener and trusts Context Room health", async () => {
  const healthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-health-root-"));
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    const port = Number(new URL(url).port);
    if (port === 4321) {
      return { ok: true, json: async () => ({ ok: true, root: healthRoot }) };
    }
    if (port === 9229) {
      return { ok: true, json: async () => ({ debugger: true }) };
    }
    throw new Error("Listener closed");
  };

  const instance = await resolveContextRoomInstance({
    pid: 42,
    root: "/incorrect/root parsed from ps",
    port: 4317,
    command: "node --inspect=0 /opt/context-room.mjs setup --root /incorrect/root",
  }, {
    listeningPorts: [9229, 4321, 50000],
    fetchImpl,
  });

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:9229/api/health",
    "http://127.0.0.1:4321/api/health",
    "http://127.0.0.1:50000/api/health",
  ]);
  assert.deepEqual(instance, {
    pid: 42,
    root: fs.realpathSync(healthRoot),
    port: 4321,
    command: "node --inspect=0 /opt/context-room.mjs setup --root /incorrect/root",
  });
});

test("explicit-port discovery probes only the declared listener and rejects a mismatch", async () => {
  const healthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-explicit-root-"));
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return { ok: true, json: async () => ({ ok: true, root: healthRoot }) };
  };
  const processInstance = {
    pid: 43,
    root: "/parsed/root",
    port: 4322,
    command: "context-room start --root /parsed/root --port 4322",
  };

  assert.equal(await resolveContextRoomInstance(processInstance, {
    listeningPorts: [9229, 4321],
    explicitPort: true,
    fetchImpl,
  }), null);
  assert.equal(await resolveContextRoomInstance(processInstance, {
    listeningPorts: [],
    explicitPort: true,
    fetchImpl,
  }), null);
  assert.deepEqual(requestedUrls, []);

  assert.deepEqual(await resolveContextRoomInstance(processInstance, {
    listeningPorts: [9229, 4322],
    explicitPort: true,
    fetchImpl,
  }), {
    ...processInstance,
    root: fs.realpathSync(healthRoot),
  });
  assert.deepEqual(requestedUrls, ["http://127.0.0.1:4322/api/health"]);
});

test("discovery reports every recognized process it cannot verify", async () => {
  const discovery = await discoverRunningInstances({
    listProcesses: () => [
      "  51 node /opt/context-room.mjs start --root alpha",
      "  52 node /opt/context-room.mjs setup --root beta --port 4322",
      "  53 unrelated-worker start",
    ].join("\n"),
    cwdForPid: (pid) => (pid === 51 ? "" : "/tmp"),
    listeningPortsForPid: () => [],
    fetchImpl: async () => { throw new Error("must not fetch without a listener"); },
  });

  assert.deepEqual(discovery.verified, []);
  assert.deepEqual(discovery.unresolved, [
    {
      pid: 51,
      command: "node /opt/context-room.mjs start --root alpha",
      reason: "could not determine the process working directory",
    },
    {
      pid: 52,
      command: "node /opt/context-room.mjs setup --root beta --port 4322",
      reason: "declared port 4322 is not owned by PID 52",
    },
  ]);
});

test("legacy listener-inspection failures remain fail-closed", async () => {
  const discovery = await discoverRunningInstances({
    listProcesses: () => "  55 node /opt/context-room --version",
    cwdForPid: () => "/tmp",
    listeningPortsForPid: () => { throw new Error("lsof unavailable"); },
  });

  assert.deepEqual(discovery.verified, []);
  assert.deepEqual(discovery.unresolved, [{
    pid: 55,
    command: "node /opt/context-room --version",
    reason: "could not inspect the process TCP listeners",
  }]);
});

test("unresolved discovery aborts update-all before npm or restart side effects", async () => {
  const calls = [];
  const dependencies = {
    discoverRunningInstances: async () => ({
      verified: [{ pid: 60, root: "/tmp/verified", port: 4320, command: "context-room start" }],
      unresolved: [{ pid: 61, command: "context-room start", reason: "health verification failed" }],
    }),
    latestVersion: () => { calls.push("latest"); return "9.9.9"; },
    installLatestGlobal: () => { calls.push("install"); },
    globalCliPath: () => { calls.push("cli"); return "/tmp/context-room"; },
    restartInstance: async () => { calls.push("restart"); },
  };

  await assert.rejects(
    updateAllContextRooms([], dependencies),
    /discovery is unresolved: PID 61: health verification failed/,
  );
  assert.deepEqual(calls, []);
});

test("restart revalidates PID ownership and health root immediately before SIGTERM", async (t) => {
  const expectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-restart-expected-"));
  const replacementRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-restart-other-"));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-restart-logs-"));
  t.after(() => fs.rmSync(expectedRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(replacementRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let killed = false;

  await assert.rejects(restartInstance({
    pid: 8123,
    root: expectedRoot,
    port: 4325,
    command: "context-room start",
  }, process.execPath, logDir, {
    listeningPortsForPid: () => [4325],
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, root: replacementRoot }) }),
    killProcess: () => { killed = true; },
  }), /now serves a different project root/);

  assert.equal(killed, false);
});

test("development checkouts and explicit paths are excluded from restarts", () => {
  const developmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-development-"));
  fs.mkdirSync(path.join(developmentRoot, ".git"));
  fs.mkdirSync(path.join(developmentRoot, "bin"));
  fs.mkdirSync(path.join(developmentRoot, "src"));
  fs.writeFileSync(path.join(developmentRoot, "package.json"), JSON.stringify({ name: "context-room" }));
  fs.writeFileSync(path.join(developmentRoot, "bin", "context-room.mjs"), "");
  fs.writeFileSync(path.join(developmentRoot, "src", "context_room.mjs"), "");

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-project-"));
  const ignoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-ignored-"));
  const instances = [
    { pid: 1, root: developmentRoot, port: 4319 },
    { pid: 2, root: projectRoot, port: 4317 },
    { pid: 3, root: ignoredRoot, port: 4318 },
  ];

  assert.equal(isDevelopmentCheckout(developmentRoot), true);
  const selected = selectRestartableInstances(instances, [ignoredRoot]);
  assert.deepEqual(selected.restartable, [{ ...instances[1], root: fs.realpathSync(projectRoot) }]);
  assert.deepEqual(selected.excluded, [
    { ...instances[0], root: fs.realpathSync(developmentRoot) },
    { ...instances[2], root: fs.realpathSync(ignoredRoot) },
  ]);
});
