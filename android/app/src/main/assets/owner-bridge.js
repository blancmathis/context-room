/* Transport only. Project, document and review behavior comes from the Mac UI. */
(() => {
  'use strict';
  if (window !== window.top || !window.ContextRoomOwnerTransport) return;
  const pending = new Map(), streams = new Set();
  const pausedReads = new Set();
  let active = true;
  const MAX_BYTES = 30 * 1024 * 1024;
  const origin = document.querySelector('meta[name="context-room-native-origin"]').content;
  function localURL(value) {
    const url = new URL(value, location.href);
    if (![location.origin, origin].includes(url.origin)) throw new TypeError('This request is outside the connected Context Room.');
    return url.pathname + url.search;
  }
  function encode(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  function decode(value) { return Uint8Array.from(atob(value || ''), c => c.charCodeAt(0)); }
  function rpc(action, value, signal, timeout = 20_000) {
    if (!active && action === 'request' && ['GET', 'HEAD'].includes(value.method)) {
      if (pausedReads.size >= 32) return Promise.reject(new Error('The paused owner workspace is busy.'));
      return new Promise((resolve, reject) => {
        const resume = () => { pausedReads.delete(resume); signal?.removeEventListener('abort', abort); resolve(rpc(action, value, signal, timeout)); };
        const abort = () => { pausedReads.delete(resume); signal?.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
        if (signal?.aborted) { abort(); return; }
        pausedReads.add(resume); signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      if (!active) { reject(new Error('The owner workspace is paused. Return to it before continuing.')); return; }
      if (pending.size >= 32) { reject(new Error('The owner connection is busy.')); return; }
      const id = crypto.randomUUID();
      function finish(error, result) { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); error ? reject(error) : resolve(result); }
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = timeout ? setTimeout(() => finish(new Error('The connection timed out. Check the result before repeating a change.')), timeout) : null;
      pending.set(id, finish); signal?.addEventListener('abort', abort, { once: true });
      ContextRoomOwnerTransport.postMessage(JSON.stringify({ id, action, value }));
    });
  }
  ContextRoomOwnerTransport.onmessage = message => {
    const response = JSON.parse(message.data), finish = pending.get(response.id);
    if (finish) finish(response.error ? new Error(response.error) : null, response.result);
  };
  window.fetch = async (input, options) => {
    const request = new Request(input instanceof Request ? input : new URL(input, location.href), options);
    const bytes = ['GET', 'HEAD'].includes(request.method) ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('This request is too large.');
    const response = await rpc('request', { version: 1, method: request.method, path: localURL(request.url),
      headers: Object.fromEntries(request.headers), body: encode(bytes) }, request.signal);
    const result = new Response([204, 205, 304].includes(response.status) || request.method === 'HEAD' ? null : decode(response.body), { status: response.status, headers: response.headers });
    Object.defineProperty(result, 'url', { value: new URL(localURL(request.url), location.origin).href });
    return result;
  };
  class OwnerEvents extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    CONNECTING = 0; OPEN = 1; CLOSED = 2;
    readyState = 0; cursor = 0; busy = false; timer = null;
    constructor(url) { super(); this.url = new URL(url, location.href).href; this.withCredentials = false; localURL(this.url); streams.add(this); this.poll(); }
    emit(type, event) { this.dispatchEvent(event); this['on' + type]?.(event); }
    async poll() {
      clearTimeout(this.timer);
      if (this.readyState === 2 || this.busy || document.hidden || !active) return;
      this.busy = true;
      try {
        const url = new URL(this.url);
        if (this.cursor) url.searchParams.set('since', String(this.cursor));
        const response = await rpc('events', { version: 1, method: 'GET', path: localURL(url), headers: {}, body: '' });
        if (this.readyState === 2) return;
        if (response.status !== 200) throw new Error('Runtime events are unavailable.');
        if (this.readyState !== 1) { this.readyState = 1; this.emit('open', new Event('open')); this.readyDelivered = false; }
        const source = new TextDecoder().decode(decode(response.body));
        for (const block of source.split('\n\n')) {
          let type = 'message', id = '', data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            if (line.startsWith('id:')) id = line.slice(3).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          const text = data.join('\n');
          if (type === 'ready') {
            const ready = JSON.parse(text); this.cursor = Math.max(this.cursor, ready.cursor || 0);
            if (this.readyDelivered) continue; this.readyDelivered = true;
          }
          if (/^\d+$/.test(id)) this.cursor = Math.max(this.cursor, Number(id));
          this.emit(type, new MessageEvent(type, { data: text, lastEventId: id, origin: location.origin }));
        }
      } catch {
        if (this.readyState !== 2) { this.readyState = 0; this.emit('error', new Event('error')); }
      } finally {
        this.busy = false;
        if (this.readyState !== 2) this.timer = setTimeout(() => this.poll(), this.readyState === 1 ? 1000 : 3000);
      }
    }
    close() { this.readyState = 2; clearTimeout(this.timer); streams.delete(this); }
  }
  window.EventSource = OwnerEvents;
  window.addEventListener('context-room-native-active', event => { active = event.detail === true; if (active) { for (const resume of [...pausedReads]) resume(); for (const stream of streams) stream.poll(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const stream of streams) stream.poll(); });
  window.addEventListener('pagehide', () => { for (const stream of streams) stream.close(); });
  window.ContextRoomNativeOwner = Object.freeze({
    openNotebook: item => rpc('notebook.open', item),
    async chooseImages() {
      const result = await rpc('file.choose-images', {}, null, 0);
      return result.files.map(file => new File([decode(file.body)], file.name, { type: file.type }));
    },
    async saveFile(bytes, filename, type) {
      const data = new Uint8Array(await new Blob([bytes]).arrayBuffer());
      if (data.length > MAX_BYTES) throw new Error('This export is too large.');
      const result = await rpc('file.save', { filename, type, body: encode(data) }, null, 0);
      if (!result.saved) throw new Error('Export cancelled. The notebook and local work remain available.');
      return result;
    }
  });
  // The complete owner UI has one retained workspace on a tablet. New workspace
  // links navigate that surface with the normal browser history.
  window.open = url => { location.href = localURL(url); return null; };
})();
