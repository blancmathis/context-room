let opened;
function database() {
  return opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('context-room-conversation-drafts', 3);
    request.onupgradeneeded = () => {
      for (const name of ['drafts', 'recordings', 'audioChunks', 'audioReleases']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opened = null; }; resolve(request.result); };
    request.onerror = () => { opened = null; reject(new Error('The local conversation draft could not be opened.')); };
  });
}
const key = (scope, id) => JSON.stringify([scope, id]);
// Earlier previews used both an empty target and the runtime's own project id
// for its original root. Preserve only that exact alias; other locations differ.
export function conversationScopeAliases(scope) {
  try {
    const parts = JSON.parse(scope);
    if (Array.isArray(parts) && parts.length === 4 && typeof parts[1] === 'string' && parts[1] && parts[2] === '') {
      const legacy = [...parts]; legacy[2] = parts[1]; return [scope, JSON.stringify(legacy)];
    }
  } catch { /* Older opaque scopes have no inferred alias. */ }
  return [scope];
}
export async function readDraft(scope, id) {
  const db = await database();
  for (const original of conversationScopeAliases(scope)) {
    const draft = await new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readonly'), request = transaction.objectStore('drafts').get(key(original, id));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('The saved conversation draft is unavailable.'));
    });
    if (draft) return { ...draft, recording: draft.recording ? { ...draft.recording, recordingScopeKey: draft.recording.recordingScopeKey || original } : null };
  }
  return { text: '', sendRequest: null, recording: null };
}
export async function writeDraft(scope, id, draft) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').put(draft, key(scope, id));
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(new Error('The draft has not been saved locally. Keep this conversation open and retry.'));
  });
}

// Raw microphone chunks are committed every half second, separately from the
// composer. A reload cannot erase them by saving an empty text draft.
export async function journalRecording(scope, conversationId, recordingId, sampleRate, chunks, offset, frames) {
  const db = await database(), prefix = [scope, conversationId, recordingId];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['recordings', 'audioChunks'], 'readwrite');
    const recordings = transaction.objectStore('recordings'), request = recordings.get(prefix);
    request.onsuccess = () => {
      const item = request.result || { recordingId, sampleRate, createdAt: Date.now(), chunks: 0, frames: 0 };
      if (item.chunks !== offset || item.sampleRate !== sampleRate) { transaction.abort(); return; }
      for (let index = 0; index < chunks.length; index++) transaction.objectStore('audioChunks').put(chunks[index], [...prefix, offset + index]);
      item.chunks += chunks.length; item.frames = frames; recordings.put(item, prefix);
    };
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(new Error('Recording stopped: new microphone audio could not be saved locally. Earlier chunks remain recoverable.'));
  });
}
export async function browserRecordings(scope, conversationId) {
  const db = await database();
  const records = [];
  for (const original of conversationScopeAliases(scope)) records.push(...await new Promise((resolve, reject) => {
    const request = db.transaction('recordings').objectStore('recordings').getAll(IDBKeyRange.bound([original, conversationId], [original, conversationId, []]));
    request.onsuccess = () => resolve(request.result.filter(item => item.frames > 0).map(item => ({ ...item, recordingScopeKey: original })));
    request.onerror = () => reject(new Error('Saved microphone recordings are unavailable.'));
  }));
  return records;
}
export async function readBrowserRecording(scope, conversationId, recordingId) {
  const db = await database(), prefix = [scope, conversationId, recordingId];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['recordings', 'audioChunks']), meta = transaction.objectStore('recordings').get(prefix);
    const data = transaction.objectStore('audioChunks').getAll(IDBKeyRange.bound(prefix, [...prefix, []]));
    transaction.oncomplete = () => {
      if (!meta.result || meta.result.chunks !== data.result.length) { reject(new Error('The original recording is incomplete. Its saved chunks were retained.')); return; }
      resolve({ ...meta.result, data: data.result });
    };
    transaction.onabort = transaction.onerror = () => reject(new Error('The original recording could not be read.'));
  });
}
export async function acknowledgeBrowserRecording(scope, conversationId, recordingId) {
  const db = await database(), prefix = [scope, conversationId, recordingId];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['recordings', 'audioChunks'], 'readwrite');
    transaction.objectStore('recordings').delete(prefix);
    transaction.objectStore('audioChunks').delete(IDBKeyRange.bound(prefix, [...prefix, []]));
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(new Error('The transcript is saved; its original recording remains available.'));
  });
}

export async function pendingAudioReleases(scope) {
  const db = await database();
  const records = [];
  for (const original of conversationScopeAliases(scope)) records.push(...await new Promise((resolve, reject) => {
    const request = db.transaction('audioReleases').objectStore('audioReleases').getAll(IDBKeyRange.bound([original], [original, []]));
    request.onsuccess = () => resolve(request.result.map(item => ({ ...item, releaseScopeKey: original }))); request.onerror = () => reject(new Error('The pending audio stop could not be read.'));
  }));
  return records;
}
export async function saveAudioRelease(scope, lease, complete = false) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('audioReleases', 'readwrite'), store = transaction.objectStore('audioReleases'), key = [scope, lease.clientId, lease.epoch];
    if (complete) store.delete(key); else store.put({ conversationId: lease.conversationId, clientId: lease.clientId, epoch: lease.epoch, expiresAt: lease.expiresAt }, key);
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(new Error('The microphone is stopped, but its pending Mac release could not be saved.'));
  });
}
