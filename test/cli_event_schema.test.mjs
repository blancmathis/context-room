import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { appendContextRoomEvent } from "../src/event_journal.mjs";

test("proposal acceptance events with string or object actors satisfy the CLI event schema", { concurrency: false }, (t) => {
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-event-schema-"));
  process.env.CONTEXT_ROOM_HUB_HOME = root;
  t.after(() => {
    if (previous == null) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/cli-event.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: false,
    formats: { "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/ },
  }).compile(schema);
  const stringActorEvent = appendContextRoomEvent("proposal.acceptance.confirmed", {
    actor: "remote-human:mathis",
    projectId: "project-a",
    sharedProjectId: "project-a",
    sharedRepository: "/shared/context.git",
    resource: { proposal: "proposal/project-a/example", proposalHead: "a".repeat(40) },
    data: { action: "accept", authorityId: "authority-a" },
  });
  const objectActorEvent = appendContextRoomEvent("proposal.completed", {
    actor: {
      sub: "mathis",
      email: "mathis@example.test",
      kind: "human",
      challengeId: "must-not-reach-the-event",
    },
    projectId: "project-a",
    sharedProjectId: "project-a",
    sharedRepository: "/shared/context.git",
    resource: { proposal: "proposal/project-a/example", proposalHead: "a".repeat(40) },
    data: { action: "accept", authorityId: "authority-a" },
  });

  assert.equal(validate(stringActorEvent), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate(objectActorEvent), true, JSON.stringify(validate.errors, null, 2));
  assert.deepEqual(objectActorEvent.actor, {
    sub: "mathis",
    email: "mathis@example.test",
    kind: "human",
  });

  assert.equal(validate({ ...stringActorEvent, unexpected: true }), false);
  assert.equal(validate.errors?.some((error) => error.keyword === "additionalProperties"), true);
});
