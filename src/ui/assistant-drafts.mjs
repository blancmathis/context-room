let opened;
function database() {
  return opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('context-room-conversation-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opened = null; }; resolve(request.result); };
    request.onerror = () => { opened = null; reject(new Error('The local conversation draft could not be opened.')); };
  });
}
const key = (scope, id) => JSON.stringify([scope, id]);
export async function readDraft(scope, id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readonly'), request = transaction.objectStore('drafts').get(key(scope, id));
    request.onsuccess = () => resolve(request.result || { text: '', sendRequest: null, recording: null });
    request.onerror = () => reject(new Error('The saved conversation draft is unavailable.'));
  });
}
export async function writeDraft(scope, id, draft) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').put(draft, key(scope, id));
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(new Error('The draft has not been saved locally. Keep this conversation open and retry.'));
  });
}
