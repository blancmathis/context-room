import fs from 'node:fs';
import path from 'node:path';
import { readLisiereSnapshot, decodeLisiereObject, legacyError } from './lisiere_archive.mjs';
import { lisiereRecordSelector } from './lisiere_inventory.mjs';
import { retainLisiereRecoveryBytes } from './lisiere_migration.mjs';
import { AssistantSessions } from './assistant_sessions.mjs';
import { assistantStorageRoot } from './assistant_runtime.mjs';
import { canonicalNotebookRoot, notebookHash, stableNotebookJson, readNotebookBytes, readNotebookJson } from './notebook_io.mjs';

const check = (value, message) => { if (!value) throw legacyError(message); };
const jsonBytes = value => Buffer.from(stableNotebookJson(value) + '\n');
const cells = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
  typeof value === 'bigint' ? { integer: String(value) } : Buffer.isBuffer(value) ? { base64: value.toString('base64') } : value]));
const sequence = row => {
  check(typeof row.seq === 'bigint' || Number.isSafeInteger(row.seq), 'A retained event has an inexact sequence.');
  check(BigInt(row.seq) >= 0n, 'A retained event has an invalid sequence.'); return BigInt(row.seq);
};
function instant(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 8.64e12 ? new Date(value * 1000).toISOString() : null; }
const eventId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : null;
function portable(value, depth = 0) {
  check(depth <= 128, 'This historical context is too deeply nested. Its original snapshot remains complete.');
  if (typeof value === 'bigint') return { integer: String(value) };
  if (Array.isArray(value)) return value.map(item => portable(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, depth + 1)]));
  return value;
}

/** Original SQLite cells stay exact, including unknown event types and int64s.
 * The readable projection is separate from those immutable source records. */
export function readLisiereConversation(snapshot, selector) {
  check(typeof selector === 'string' && /^[a-f0-9]{64}$/.test(selector), 'Choose an exact conversation selector from the recovery inventory.');
  const archive = readLisiereSnapshot(snapshot);
  check(archive.manifest.kind === 'mac-workspace', 'Conversation recovery needs the canonical Mac snapshot.');
  const matches = [];
  for (const row of archive.rows('conversations')) if (lisiereRecordSelector('conversations', row) === selector) {
    matches.push(row); check(matches.length === 1, 'The selected original conversation is duplicated.');
  }
  check(matches.length === 1, 'The selected original conversation is absent or duplicated.');
  const conversation = matches[0];
  check(typeof conversation.id === 'string' && conversation.id.length > 0 && conversation.id.length <= 160
    && typeof conversation.thread === 'string' && conversation.thread.length > 0 && conversation.thread.length <= 160
    && (conversation.project == null || typeof conversation.project === 'string' && conversation.project.length <= 160)
    && (conversation.title == null || typeof conversation.title === 'string' && conversation.title.length <= 8192), 'The original conversation identity is malformed.');
  const selected = (table, predicate) => {
    const result = []; let bytes = 0;
    for (const row of archive.rows(table)) if (predicate(row)) {
      bytes += jsonBytes(cells(row)).length;
      check(result.length < 100000 && bytes <= 24 * 1024 * 1024, 'This conversation exceeds the bounded recovery size. Its original snapshot remains complete.'); result.push(row);
    }
    return result;
  };
  const projects = selected('projects', row => row.id === conversation.project), bindings = selected('native_bindings', row => row.id === conversation.id);
  check(bindings.length <= 1 && bindings.every(row => row.thread === conversation.thread), 'The original Desktop binding has a different task identity.');
  const events = selected('messages', row => row.conversation === conversation.id).sort((a, b) => sequence(a) < sequence(b) ? -1 : sequence(a) > sequence(b) ? 1 : 0);
  check(new Set(events.map(row => String(sequence(row)))).size === events.length, 'The original event sequence is duplicated.');
  const requests = selected('native_requests', row => row.conversation === conversation.id), messages = [], replies = new Map();
  let lastUser = null, currentTurn = null;
  const record = (row, role, text, extra = {}) => {
    const value = { role, text, originalSeq: String(row.seq ?? row.id), at: instant(row.time), ...extra }; messages.push(value); return value;
  };
  for (const row of events) {
    let data;
    try { data = decodeLisiereObject(row.data); }
    catch { record(row, 'record', 'This historical event could not be decoded. Its exact original data is retained in the export.', { kind: String(row.kind).slice(0, 160), completion: 'unparsed' }); continue; }
    if (row.kind === 'user' && typeof data.text === 'string') {
      lastUser = record(row, 'user', data.text, { ...(data.context == null ? {} : { context: portable(data.context) }), completion: 'recorded-send-intent' });
    } else if (row.kind === 'turn/started') {
      currentTurn = eventId(data.turn?.id); if (lastUser) { lastUser.turnId = currentTurn; lastUser = null; }
    } else if (row.kind === 'item/agentMessage/delta' || row.kind === 'item/completed' && data.item?.type === 'agentMessage') {
      const turnId = eventId(data.turnId) || currentTurn, itemId = eventId(data.itemId) || eventId(data.item?.id);
      const key = turnId && itemId ? JSON.stringify([turnId, itemId]) : `unkeyed:${row.seq}`;
      let reply = replies.get(key);
      if (!reply) { reply = record(row, 'assistant', '', { turnId, itemId: itemId || null, completion: 'partial' }); replies.set(key, reply); }
      if (row.kind === 'item/agentMessage/delta' && typeof data.delta === 'string') {
        // Late deltas cannot overwrite a recorded complete item.
        if (reply.completion !== 'item-completed') reply.text += data.delta;
      } else if (typeof data.item?.text === 'string') { reply.text = data.item.text; reply.completion = 'item-completed'; }
    } else if (row.kind === 'item/completed' && data.item?.type === 'userMessage') {
      const turnId = eventId(data.turnId) || currentTurn;
      if (!messages.some(message => message.role === 'user' && message.turnId === turnId)) {
        const text = (Array.isArray(data.item.content) ? data.item.content : []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
        record(row, 'user', text, { turnId, completion: 'recorded-item' });
      }
    } else if (row.kind === 'turn/completed') {
      const turnId = eventId(data.turn?.id) || currentTurn, status = eventId(data.turn?.status) || 'unknown';
      for (const message of messages) if (message.turnId === turnId) message.turnStatus = status;
      record(row, 'record', `Recorded turn status: ${String(status).slice(0, 100)}`, { kind: 'turn/completed', turnId, completion: 'historical-status' });
      currentTurn = null;
    } else if (row.kind === 'error' || row.kind === 'approval' || row.kind === 'approval/resolved') {
      record(row, 'record', 'Historical ' + row.kind + ': ' + stableNotebookJson(portable(data)), { kind: row.kind, completion: 'historical-record' });
    }
  }
  for (const row of requests) {
    check(eventId(row.id), 'An original request has a malformed identity.');
    if (typeof row.text !== 'string') continue;
    let context;
    try { if (row.context != null) context = decodeLisiereObject(row.context); } catch { /* Exact undecodable context remains in original records. */ }
    record(row, 'user', row.text, { requestId: row.id, completion: 'delivery-unconfirmed', ...(context ? { context: portable(context) } : {}) });
  }
  const history = { version: 1, original: { conversation: cells(conversation), projects: projects.map(cells), bindings: bindings.map(cells),
    events: events.map(cells), requests: requests.map(cells) }, messages };
  const bytes = jsonBytes(history);
  check(bytes.length <= 30 * 1024 * 1024, 'This conversation exceeds the bounded recovery size. No original history was discarded.');
  return { bytes, hash: notebookHash(bytes), sourceRevision: archive.manifest.revision, originalConversationId: conversation.id,
    originalThreadId: conversation.thread, title: conversation.title || 'Recovered conversation', transport: bindings.length ? 'desktop' : 'dedicated',
    messageCount: messages.length, recordCount: events.length + requests.length };
}

function privateDestination(root, project) {
  check(typeof root === 'string' && path.resolve(root) === root, 'Choose an absolute private conversation store.');
  let ancestor = root; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  check(fs.realpathSync(ancestor) === ancestor, 'The conversation store must use its exact original location.');
  check(root !== project && !root.startsWith(project + path.sep), 'Keep recovered history outside the project and public repository.');
  if (ancestor === root) {
    canonicalNotebookRoot(root); const stats = fs.statSync(root);
    check(!(stats.mode & 0o077) && (!process.getuid || stats.uid === process.getuid()), 'Recovered conversations need a private directory owned by this account.');
  }
}

/** Explicitly link an immutable legacy archive. Import never resumes a task;
 * only a later new message can create a new, narrowly scoped Context Room task. */
export function migrateLisiereConversationHistory(root, options, { storageRoot = assistantStorageRoot(), resolveSource, sourceForPath } = {}) {
  const rootIdentity = canonicalNotebookRoot(root);
  privateDestination(storageRoot, root);
  const retained = readLisiereConversation(options.snapshot, options.selector), { bytes, ...metadata } = retained;
  const digest = notebookHash({ rootIdentity, root, storageRoot, history: metadata.hash, path: options.path });
  const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const existing = fs.existsSync(storageRoot) ? readNotebookJson(storageRoot, `conversations/${requestId}.json`) : null;
  check(!existing || existing.legacy?.hash === retained.hash && existing.origin?.root === root && existing.origin?.rootIdentity === rootIdentity
    && existing.origin?.source?.path === options.path, 'The retained conversation binding has another source.');
  const source = existing ? existing.origin.source : resolveSource(root, sourceForPath(root, options.path), { sessionId: requestId, creating: true }).source;
  resolveSource(root, source, { sessionId: requestId });
  const configuration = readNotebookBytes(root, '.context-room/config.json', 8 * 1024 * 1024);
  const configHash = configuration === null ? null : notebookHash(configuration);
  const legacy = existing?.legacy || metadata;
  const revision = notebookHash({ rootIdentity, storageRoot, requestId, source, legacy, configHash, sourceRevision: retained.sourceRevision });
  const summary = { kind: 'lisiere-conversation-import', revision, sourceRevision: retained.sourceRevision, selector: options.selector,
    conversationId: requestId, path: options.path, messageCount: metadata.messageCount, recordCount: metadata.recordCount,
    originalConversationId: metadata.originalConversationId, originalThreadId: metadata.originalThreadId, transport: metadata.transport,
    accepted: false, effect: 'retained-history-with-explicit-new-scoped-continuation' };
  if (!options.apply) return { ...summary, applied: false };
  check(options.expectedRevision === revision, 'The history, linked source or permissions changed after preview. Use its exact revision.');
  privateDestination(storageRoot, root);
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const service = new AssistantSessions({ root: storageRoot, resolveSource, providerFactory: () => { throw new Error('Recovery never starts an agent'); } });
  try {
    const current = readNotebookBytes(root, '.context-room/config.json', 8 * 1024 * 1024);
    check(canonicalNotebookRoot(root) === rootIdentity && (current === null ? null : notebookHash(current)) === configHash, 'The linked project or permissions changed during recovery.');
    const conversation = service.importRetainedConversation(root, { requestId, source, legacy, archiveBytes: bytes });
    retainLisiereRecoveryBytes(storageRoot, `legacy-history-sources/${requestId}/${retained.sourceRevision}.json`, jsonBytes({ sourceRevision: retained.sourceRevision, selector: options.selector, historyHash: metadata.hash }));
    return { ...summary, applied: true, replayed: Boolean(existing), threadId: conversation.threadId, legacyTaskChanged: false };
  } finally { void service.close(); }
}
