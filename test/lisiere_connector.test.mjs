import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLisiereConnector } from "../src/lisiere_connector.mjs";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

test("the optional Lisière bridge isolates tablet files, preserves editable objects and binds the original revision", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-lisiere-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operations = ["project.register", "board.create", "board.read", "board.mutate", "board.render", "asset.put"];
  const calls = []; let currentRevision = 2;
  const connector = createLisiereConnector({ call: async (op, args) => {
    calls.push({ op, args });
    if (op === "capabilities") return { version: 1, operations: Object.fromEntries(operations.map((op) => [op, {}])) };
    if (op === "project.register") return { id: "isolated-project" };
    if (op === "board.create") return { id: args.id };
    if (op === "asset.put") return { id: "a".repeat(64) };
    if (op === "board.mutate") return { revision: 1 };
    if (op === "board.read") return { revision: currentRevision, objects: [{ type: "ink", points: [[1, 2], [3, 4]] }] };
    if (op === "board.render") return { data: PNG.toString("base64") };
    throw new Error(op);
  } });
  const source = { path: "docs/drawing.png", proposal: "proposal", revision: "exact" };
  const prepared = await connector.prepare(root, { source, bytes: PNG, title: "Drawing" });
  assert.equal(prepared.automaticTabletNavigation, false);
  assert.ok(calls.find((call) => call.op === "project.register").args.root.startsWith(path.join(fs.realpathSync(root), ".context-room/lisiere/sessions")));
  assert.equal(fs.existsSync(path.join(root, "docs/drawing.png")), false);
  const imported = await connector.read(root, prepared.id, source);
  assert.deepEqual(Buffer.from(imported.contentBase64, "base64"), PNG);
  assert.ok(fs.existsSync(path.join(imported.editableSource, "board-2.json")));
  assert.equal(calls.some((call) => call.op === "proposal.review"), false);
  await assert.rejects(connector.read(root, prepared.id, { ...source, revision: "newer" }), /different document revision/);
});

test("Lisière absence is reported without creating project state", async () => {
  const result = await createLisiereConnector({ call: async () => { throw new Error("offline"); } }).status();
  assert.equal(result.available, false);
});

test("Lisière subprocess transport accepts ordinary CLI JSON stdout", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-lisiere-transport-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = path.join(root, "cli.mjs");
  fs.writeFileSync(command, `#!${process.execPath}\nlet raw=''; if(process.argv[2]==='rpc') for await (const chunk of process.stdin) raw+=chunk; const args=raw?JSON.parse(raw):{}; const operation=process.argv[2]==='capabilities'?'capabilities':process.argv[3]; const operations=Object.fromEntries(${JSON.stringify(["project.register", "board.create", "board.read", "board.mutate", "board.render", "asset.put"])}.map(op=>[op,{}])); const result=operation==='capabilities'?{version:1,operations}:operation==='project.register'?{id:'project'}:operation==='board.create'?{id:args.id}:operation==='asset.put'?{id:'asset'}:operation==='board.read'?{revision:1,objects:[]}:operation==='board.render'?{data:${JSON.stringify(PNG.toString("base64"))}}:{revision:1}; console.log(JSON.stringify(result));`, {mode:0o700});
  const connector=createLisiereConnector({command});
  const source={path:'drawing.png',revision:'exact'};
  const prepared=await connector.prepare(root,{source,bytes:PNG,title:'Test'});
  assert.equal((await connector.read(root,prepared.id,source)).boardRevision,1);
});
