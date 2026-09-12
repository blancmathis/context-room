import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
const execute = promisify(execFile);
const REQUIRED = ["project.register", "board.create", "board.read", "board.mutate", "board.render", "asset.put"];

export function createLisiereConnector({ command = process.env.CONTEXT_ROOM_LISIERE_CLI || "lisiere", call } = {}) {
  const rpc = call || (async (operation, args = {}) => {
    const child = execFile(command, ["rpc", operation, "-"], { timeout: 30_000, maxBuffer: 30 * 1024 * 1024, encoding: "buffer" }, () => {});
    const chunks = [], errors = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk))); child.stderr.on("data", (chunk) => errors.push(chunk));
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        try {
          if (code !== 0) throw new Error("Lisière is unavailable or rejected the operation. Check its local companion.");
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (value.ok === false) throw new Error(value.error?.message || "Lisière rejected the operation.");
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(args));
    return result;
  });
  return {
    async status() {
      try {
        const capabilities = call ? await rpc("capabilities") : JSON.parse((await execute(command, ["capabilities"], { timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout);
        const operations = capabilities.operations || {};
        const missing = REQUIRED.filter((op) => !Object.hasOwn(operations, op));
        return { available: !missing.length, missing, protocol: capabilities.version, automaticTabletNavigation: false };
      } catch { return { available: false, reason: "Install and start the optional local Lisière companion.", automaticTabletNavigation: false }; }
    },
    async prepare(root, { source, bytes, title }) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("The Lisière drawing bridge requires a PNG image.");
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 4096 || height > 4096) throw new Error("The Lisière preview supports PNG drawings up to 4096 pixels per side. The source was preserved.");
      const status = await this.status(); if (!status.available) throw new Error(status.reason || "Lisière lacks the required drawing operations.");
      const id = randomUUID(), directory = safeSessionDirectory(root, id, true);
      const workspace = path.join(directory, "workspace"); fs.mkdirSync(workspace);
      const session = { id, source, title, boardId: id, directory, width, height, createdAt: new Date().toISOString(), state: "preparing" };
      saveSession(directory, session);
      fs.writeFileSync(path.join(workspace, "source.png"), bytes, { flag: "wx" });
      const project = await rpc("project.register", { root: workspace, name: `Context Room · ${title}` });
      const board = await rpc("board.create", { id, title, project: project.id, directory: "", anchor: { path: "source.png", contextRoom: source } });
      const asset = await rpc("asset.put", { data: bytes.toString("base64") });
      await rpc("board.mutate", { board: board.id, operationId: `${id}:background`, operations: [{ id: `${id}:image`, expectedRevision: 0, value: { type: "image", assetId: asset.id, x: 0, y: 0, w: width, h: height } }] });
      Object.assign(session, { projectId: project.id, state: "ready" }); saveSession(directory, session);
      return { id, boardId: id, title, projectId: project.id, state: "ready", automaticTabletNavigation: false,
        instruction: `In Lisière on your tablet, open the project “Context Room · ${title}” and its drawing. Return here to import the saved drawing.` };
    },
    async read(root, id, source) {
      const directory = safeSessionDirectory(root, id), session = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
      if (session.state !== "ready" || JSON.stringify(session.source) !== JSON.stringify(source)) throw new Error("This drawing belongs to a different document revision.");
      const before = await rpc("board.read", { board: session.boardId });
      const rendered = await rpc("board.render", { board: session.boardId, format: "png", bounds: [0, 0, session.width, session.height] });
      const after = await rpc("board.read", { board: session.boardId });
      if (!Number.isSafeInteger(after.revision) || after.revision < 0) throw new Error("Invalid board revision returned by Lisière.");
      if (before.revision !== after.revision) throw new Error("The drawing changed while importing. Retry after the next saved stroke.");
      const bytes = Buffer.from(rendered.data, "base64");
      if (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Lisière did not return a valid bounded PNG.");
      // Preserve the editable board as well as the imported preview.
      fs.writeFileSync(path.join(directory, `board-${after.revision}.json`), JSON.stringify(after));
      fs.writeFileSync(path.join(directory, `preview-${after.revision}.png`), bytes);
      return { contentBase64: bytes.toString("base64"), boardRevision: after.revision, editableBoardId: session.boardId, editableSource: directory };
    },
  };
}

function safeSessionDirectory(root, id, create = false) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid Lisière session.");
  let directory = fs.realpathSync(root);
  for (const part of [".context-room", "lisiere", "sessions", id]) {
    directory = path.join(directory, part);
    if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    const stats = fs.lstatSync(directory); if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Unsafe Lisière session directory.");
  }
  const manifest = path.join(directory, "session.json");
  if (fs.existsSync(manifest) && fs.lstatSync(manifest).isSymbolicLink()) throw new Error("Unsafe Lisière session manifest.");
  return directory;
}
function saveSession(directory, session) {
  const temporary = path.join(directory, randomUUID() + ".tmp"); fs.writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, path.join(directory, "session.json"));
}
