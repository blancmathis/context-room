import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendContextRoomEvent,
  contextRoomEventJournalPath,
  followContextRoomEvents,
  readContextRoomEvents,
} from "../src/event_journal.mjs";

function isolatedJournal(t) {
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-events-"));
  process.env.CONTEXT_ROOM_HUB_HOME = root;
  t.after(() => {
    if (previous == null) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("event identities and location/shared filters use structured fields", { concurrency: false }, (t) => {
  isolatedJournal(t);
  appendContextRoomEvent("review.decision", {
    projectId: " project-a ",
    locationId: " /worktrees/a ",
    sharedProjectId: " shared-a ",
    sharedRepository: " /shared/team.git ",
    data: { status: "accepted" },
  });
  appendContextRoomEvent("review.decision", {
    projectId: "project-a",
    locationId: "/worktrees/b",
    sharedProjectId: "shared-b",
    sharedRepository: "/shared/other.git",
    data: { status: "rejected" },
  });

  const byLocation = readContextRoomEvents({ locationId: "/worktrees/a" });
  assert.equal(byLocation.events.length, 1);
  assert.equal(byLocation.events[0].projectId, "project-a");
  assert.equal(byLocation.events[0].locationId, "/worktrees/a");
  assert.equal(byLocation.events[0].sharedProjectId, "shared-a");

  assert.equal(readContextRoomEvents({ shared: "shared-a" }).events.length, 1);
  assert.equal(readContextRoomEvents({ shared: "/shared/team.git" }).events.length, 1);
  assert.equal(readContextRoomEvents({ sharedProjectId: "shared-b" }).events[0].locationId, "/worktrees/b");
  assert.equal(readContextRoomEvents({ sharedRepository: "/shared/other.git" }).events[0].sharedProjectId, "shared-b");
});

test("terminal confirmation events persist the actor but never persist a challenge identifier", { concurrency: false }, (t) => {
  isolatedJournal(t);
  const event = appendContextRoomEvent("proposal.acceptance.confirmation_opened", {
    actor: " remote-human:mathis ",
    projectId: "project-a",
    data: {
      action: "accept",
      proposalHead: "a".repeat(40),
      challengeId: "opaque-top-level-challenge",
      nested: { challengeID: "opaque-nested-challenge" },
    },
  });

  assert.equal(event.actor, "remote-human:mathis");
  assert.equal(Object.hasOwn(event.data, "challengeId"), false);
  assert.equal(Object.hasOwn(event.data.nested, "challengeID"), false);

  const persisted = readContextRoomEvents({ types: "proposal.acceptance.*" }).events[0];
  assert.equal(persisted.actor, "remote-human:mathis");
  assert.equal(Object.hasOwn(persisted.data, "challengeId"), false);
  assert.equal(Object.hasOwn(persisted.data.nested, "challengeID"), false);

  const rawJournal = fs.readFileSync(contextRoomEventJournalPath(), "utf8");
  assert.doesNotMatch(rawJournal, /challengeid/i);
  assert.doesNotMatch(rawJournal, /opaque-(?:top-level|nested)-challenge/);
});

test("pagination advances from the last delivered event without gaps or duplicates", { concurrency: false }, (t) => {
  isolatedJournal(t);
  const written = Array.from({ length: 7 }, (_, index) => appendContextRoomEvent("review.decision", {
    projectId: "project-a",
    resource: { path: `docs/${index}.md` },
  }));

  const first = readContextRoomEvents({ types: "review.*", limit: 3 });
  assert.deepEqual(first.events.map((event) => event.cursor), written.slice(0, 3).map((event) => event.cursor));
  assert.equal(first.nextCursor, written[2].cursor);
  assert.equal(first.remaining, 4);

  const second = readContextRoomEvents({ since: first.nextCursor, types: "review.*", limit: 3 });
  assert.deepEqual(second.events.map((event) => event.cursor), written.slice(3, 6).map((event) => event.cursor));
  assert.equal(second.nextCursor, written[5].cursor);
  assert.equal(second.remaining, 1);

  const third = readContextRoomEvents({ since: second.nextCursor, types: "review.*", limit: 3 });
  assert.deepEqual(third.events.map((event) => event.cursor), [written[6].cursor]);
  assert.equal(third.nextCursor, written[6].cursor);
  assert.equal(third.remaining, 0);
});

test("review wildcard includes UI decisions and follow drains more than one thousand events", { concurrency: false }, async (t) => {
  isolatedJournal(t);
  const seed = appendContextRoomEvent("proposal.published", { projectId: "project-a" });
  const reviews = Array.from({ length: 1_205 }, (_, index) => ({
    schemaVersion: "context-room.event/1",
    cursor: `review-${String(index).padStart(4, "0")}`,
    type: index % 2 ? "review.changed" : "review.decision",
    occurredAt: new Date(index).toISOString(),
    projectId: "project-a",
    locationId: "/worktrees/a",
    sharedProjectId: "",
    sharedRepository: "",
    resource: { index },
    data: null,
  }));
  fs.appendFileSync(contextRoomEventJournalPath(), `${reviews.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const controller = new AbortController();
  const delivered = [];
  await followContextRoomEvents({
    since: seed.cursor,
    types: ["review.*"],
    projectId: "project-a",
    locationId: "/worktrees/a",
    signal: controller.signal,
    onEvent(event) {
      delivered.push(event.cursor);
      if (delivered.length === reviews.length) controller.abort();
    },
  });

  assert.equal(delivered.length, 1_205);
  assert.deepEqual(delivered, reviews.map((event) => event.cursor));
});
