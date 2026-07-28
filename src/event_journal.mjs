import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { CLI_EVENT_SCHEMA_VERSION } from "./cli_contract.mjs";

const MAX_EVENTS = 10_000;
const ROTATE_AFTER_BYTES = 8 * 1024 * 1024;

function hubHome() {
  return process.env.CONTEXT_ROOM_HUB_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_HUB_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "hub");
}

export function contextRoomEventJournalPath() {
  return path.join(hubHome(), "events.jsonl");
}

function ensureJournalDirectory() {
  const directory = path.dirname(contextRoomEventJournalPath());
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}

function sanitizedEventValue(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizedEventValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["content", "text", "patch", "diff", "token", "secret"].includes(String(key).toLowerCase()))
      .slice(0, 100)
      .map(([key, item]) => [String(key).slice(0, 120), sanitizedEventValue(item, depth + 1)]));
  }
  return String(value).slice(0, 2_000);
}

function readJournalLines() {
  const file = contextRoomEventJournalPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function rotateJournalIfNeeded() {
  const file = contextRoomEventJournalPath();
  let stats;
  try { stats = fs.statSync(file); } catch { return; }
  if (stats.size < ROTATE_AFTER_BYTES) return;
  const lines = readJournalLines().slice(-MAX_EVENTS);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.join("\n") + (lines.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function appendContextRoomEvent(type, {
  projectId = "",
  locationId = "",
  sharedProjectId = "",
  sharedRepository = "",
  resource = null,
  data = null,
  occurredAt = new Date().toISOString(),
} = {}) {
  ensureJournalDirectory();
  rotateJournalIfNeeded();
  const event = {
    schemaVersion: CLI_EVENT_SCHEMA_VERSION,
    cursor: `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`,
    type: String(type || "context-room.updated").slice(0, 160),
    occurredAt: String(occurredAt || new Date().toISOString()),
    projectId: normalizedIdentity(projectId),
    locationId: normalizedIdentity(locationId, 1_000),
    sharedProjectId: normalizedIdentity(sharedProjectId),
    sharedRepository: normalizedIdentity(sharedRepository, 1_000),
    resource: sanitizedEventValue(resource),
    data: sanitizedEventValue(data),
  };
  const file = contextRoomEventJournalPath();
  fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return event;
}

function parseJournalEvents() {
  return readJournalLines().flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event?.cursor && event?.type ? [normalizeStoredEvent(event)] : [];
    } catch {
      return [];
    }
  });
}

function normalizedIdentity(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeStoredEvent(event) {
  return {
    ...event,
    projectId: normalizedIdentity(event.projectId),
    locationId: normalizedIdentity(event.locationId, 1_000),
    sharedProjectId: normalizedIdentity(event.sharedProjectId),
    sharedRepository: normalizedIdentity(event.sharedRepository, 1_000),
  };
}

function normalizedTypeFilters(types) {
  return (Array.isArray(types) ? types : String(types || "").split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function eventTypeMatches(type, filters) {
  if (!filters.length) return true;
  return filters.some((filter) => (
    filter === type
    || (filter.endsWith("*") && type.startsWith(filter.slice(0, -1)))
  ));
}

export function readContextRoomEvents({
  since = "",
  types = [],
  projectId = "",
  locationId = "",
  shared = "",
  sharedProjectId = "",
  sharedRepository = "",
  limit = 200,
} = {}) {
  const events = parseJournalEvents();
  const typeFilters = normalizedTypeFilters(types);
  const normalizedProjectId = normalizedIdentity(projectId);
  const normalizedLocationId = normalizedIdentity(locationId, 1_000);
  const normalizedSharedProjectId = normalizedIdentity(sharedProjectId || shared);
  const normalizedSharedRepository = normalizedIdentity(sharedRepository || shared, 1_000);
  let cursorExpired = false;
  let start = 0;
  if (since && since !== "now") {
    const index = events.findIndex((event) => event.cursor === since);
    if (index === -1 && events.length) cursorExpired = true;
    else if (index >= 0) start = index + 1;
  } else if (since === "now") {
    start = events.length;
  }
  const filtered = events.slice(start).filter((event) => (
    eventTypeMatches(event.type, typeFilters)
    && (!normalizedProjectId || event.projectId === normalizedProjectId)
    && (!normalizedLocationId || event.locationId === normalizedLocationId)
    && (!(normalizedSharedProjectId || normalizedSharedRepository)
      || event.sharedProjectId === normalizedSharedProjectId
      || event.sharedRepository === normalizedSharedRepository)
  ));
  const safeLimit = Math.max(1, Math.min(1_000, Number(limit) || 200));
  const delivered = filtered.slice(0, safeLimit);
  return {
    cursorExpired,
    firstCursor: events[0]?.cursor || "",
    lastCursor: events.at(-1)?.cursor || "",
    nextCursor: delivered.at(-1)?.cursor || (since && since !== "now" ? String(since) : ""),
    events: delivered,
    remaining: Math.max(0, filtered.length - safeLimit),
  };
}

export function contextRoomCursorExpiredEvent(batch = {}) {
  return {
    schemaVersion: CLI_EVENT_SCHEMA_VERSION,
    cursor: String(batch.lastCursor || batch.firstCursor || "cursor-expired"),
    type: "cursor-expired",
    occurredAt: new Date().toISOString(),
    projectId: "",
    locationId: "",
    sharedProjectId: "",
    sharedRepository: "",
    resource: { firstCursor: batch.firstCursor || "", lastCursor: batch.lastCursor || "" },
    data: { snapshotRequired: true },
  };
}

export function contextRoomStreamReadyEvent({ cursor = "", projectId = "", locationId = "", shared = "", types = [] } = {}) {
  return {
    schemaVersion: CLI_EVENT_SCHEMA_VERSION,
    cursor: String(cursor || "stream-ready"),
    type: "stream-ready",
    occurredAt: new Date().toISOString(),
    projectId: normalizedIdentity(projectId),
    locationId: normalizedIdentity(locationId, 1_000),
    sharedProjectId: normalizedIdentity(shared),
    sharedRepository: normalizedIdentity(shared, 1_000),
    resource: { types: Array.isArray(types) ? types : [] },
    data: { following: true },
  };
}

export async function followContextRoomEvents({
  since = "now",
  types = [],
  projectId = "",
  locationId = "",
  shared = "",
  sharedProjectId = "",
  sharedRepository = "",
  signal = null,
  onEvent,
  onCursorExpired = null,
} = {}) {
  if (typeof onEvent !== "function") throw new Error("onEvent is required");
  ensureJournalDirectory();
  let cursor = String(since || "now");
  const deliver = () => {
    while (true) {
      const batch = readContextRoomEvents({
        since: cursor,
        types,
        projectId,
        locationId,
        shared,
        sharedProjectId,
        sharedRepository,
        limit: 1_000,
      });
      if (batch.cursorExpired) {
        onCursorExpired?.(batch);
        cursor = batch.lastCursor || "now";
        return;
      }
      for (const event of batch.events) {
        cursor = event.cursor;
        onEvent(event);
      }
      if (!batch.remaining || !batch.events.length) return;
    }
  };
  deliver();
  if (signal?.aborted) return;
  await new Promise((resolve) => {
    const directory = path.dirname(contextRoomEventJournalPath());
    let debounce = null;
    const watcher = fs.watch(directory, { persistent: true }, (_event, filename) => {
      if (filename && filename !== path.basename(contextRoomEventJournalPath())) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(deliver, 25);
    });
    const close = () => {
      if (debounce) clearTimeout(debounce);
      watcher.close();
      resolve();
    };
    if (signal) signal.addEventListener("abort", close, { once: true });
  });
}
