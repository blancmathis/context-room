#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { connectSharedContext, readSharedProjectConnection, syncSharedContext } from "../src/shared_context.mjs";
import { contextHubHostRoot, registerContextHubSharedRepository, unregisterContextHubProject, writeContextHubSnapshot } from "../src/context_hub.mjs";
import { contextHubUiState, createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(name) {
  const file = required(`${name}_FILE`);
  const value = fs.readFileSync(file, "utf8").trim();
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error(`${name}_FILE must contain at least 32 bytes`);
  return value;
}

if (process.env.CONTEXT_ROOM_REMOTE !== "1") throw new Error("Set CONTEXT_ROOM_REMOTE=1 to opt into the remote server");

const repository = required("CONTEXT_ROOM_SHARED_REPOSITORY");
const dataRoot = path.resolve(required("CONTEXT_ROOM_DATA_ROOT"));
const homeRoot = path.join(dataRoot, "home");
fs.mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
process.env.HOME = homeRoot;
const proposalSshKeyFile = String(process.env.CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE || "").trim();
if (proposalSshKeyFile) {
  const knownHostsFile = required("CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE");
  process.env.GIT_SSH_COMMAND = `ssh -i ${JSON.stringify(proposalSshKeyFile)} -o IdentitiesOnly=yes -o UserKnownHostsFile=${JSON.stringify(knownHostsFile)} -o StrictHostKeyChecking=yes`;
}
const projectIds = required("CONTEXT_ROOM_PROJECT_IDS").split(",").map((value) => value.trim()).filter(Boolean);
const projectRoots = {};
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
registerContextHubSharedRepository(repository);
for (const projectId of projectIds) {
  const root = path.join(dataRoot, "projects", projectId);
  fs.mkdirSync(root, { recursive: true });
  initializeContextRoomProject(root, { title: projectId });
  if (!readSharedProjectConnection(root)) connectSharedContext(root, { repository, projectId });
  syncSharedContext(root, { allowOffline: true });
  unregisterContextHubProject(root);
  projectRoots[projectId] = root;
}

const hostRoot = contextHubHostRoot();
fs.mkdirSync(hostRoot, { recursive: true });
initializeContextRoomProject(hostRoot, { title: "Peerlab Context Room", allowedPaths: [], watchAllow: [] });
const initialContextHub = contextHubUiState(hostRoot, { refreshShared: false, refreshGit: true, force: true });
writeContextHubSnapshot(initialContextHub, { generatedAt: initialContextHub.generatedAt });
const port = Number(process.env.CONTEXT_ROOM_PORT || 4317);
const host = String(process.env.CONTEXT_ROOM_HOST || "0.0.0.0");
const githubPrivateKeyFile = String(process.env.CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE || "").trim();
const githubApp = githubPrivateKeyFile ? {
  appId: required("CONTEXT_ROOM_GITHUB_APP_ID"),
  installationId: required("CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID"),
  privateKey: fs.readFileSync(githubPrivateKeyFile, "utf8"),
} : null;

const { server } = createMemoryServer({
  root: hostRoot,
  port,
  registerInHub: false,
  persistentDocumentGraphLayout: true,
  remoteAccess: {
    expectedHost: required("CONTEXT_ROOM_PUBLIC_HOST"),
    browserHost: String(process.env.CONTEXT_ROOM_BROWSER_HOST || process.env.CONTEXT_ROOM_PUBLIC_HOST || "").trim(),
    humanSecret: secret("CONTEXT_ROOM_HUMAN_SECRET"),
    agentSecret: secret("CONTEXT_ROOM_AGENT_SECRET"),
    issuer: String(process.env.CONTEXT_ROOM_IDENTITY_ISSUER || "context-room").trim(),
    healthSecret: secret("CONTEXT_ROOM_HEALTH_SECRET"),
    adminSubjects: required("CONTEXT_ROOM_ADMIN_SUBJECTS").split(",").map((value) => value.trim()).filter(Boolean),
    projectRoots,
    githubApp,
  },
});

server.listen(port, host, () => console.log(`Peerlab Context Room remote server listening on ${host}:${port}`));
const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
