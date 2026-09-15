/** Explicit, source-only preview sharing. Reload/background never starts it again. */
export class LiveSourcePreview {
  constructor({ api, identity, capture, visible, onState, onError }) {
    Object.assign(this, { api, identity, capture, visible, onState, onError });
    this.generation = 0; this.stream = null; this.remote = null; this.closed = false; this.busy = false;
    this.background = () => { if (document.visibilityState !== 'visible') void this.stop().catch(onError); };
    document.addEventListener('visibilitychange', this.background);
    this.nativeBackground = event => { if (event.detail !== true) void this.stop().catch(onError); };
    window.addEventListener('context-room-native-active', this.nativeBackground);
    this.unload = () => { void this.stop().catch(onError); };
    window.addEventListener('pagehide', this.unload);
    this.emit();
  }
  emit() { this.onState({ ...this.remote, ...this.stream, active: Boolean(this.stream), elsewhere: !this.stream && Boolean(this.remote?.active), busy: this.busy }); }
  async request(route, body, keepalive = false) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    try { return await this.api('/api/assistant' + route, body === undefined ? { signal: controller.signal } : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, keepalive,
    }); } finally { clearTimeout(timer); }
  }
  async refresh() {
    const generation = this.generation, { conversationId } = this.identity();
    const remote = await this.request('/conversations/' + conversationId + '/observation');
    if (generation !== this.generation || this.closed) return;
    this.remote = remote; this.emit();
  }
  async start(takeover = false) {
    if (this.closed || this.stream || this.busy || !this.visible()) return;
    const identity = this.identity(), generation = ++this.generation, previousEpoch = this.remote?.epoch;
    this.busy = true; this.emit();
    try {
      const remote = await this.request('/conversations/' + identity.conversationId + '/observation');
      if (generation !== this.generation || this.closed) return;
      this.remote = remote;
      if (remote.active && (!takeover || remote.epoch !== previousEpoch)) throw new Error('Another surface is sharing this source. Choose Take over source sharing to replace it.');
      const stream = await this.request('/observation/controller', { ...identity, action: 'start', ...(remote.active ? { takeover: true, epoch: remote.epoch } : {}) });
      const owned = { ...identity, ...stream, sequence: 0 };
      if (generation !== this.generation || this.closed) {
        await this.request('/observation/controller', { ...identity, epoch: stream.epoch, action: 'stop' }, true); return;
      }
      this.stream = owned; this.remote = null;
      await this.pulse();
    } finally { if (generation === this.generation) { this.busy = false; this.emit(); } }
  }
  async pulse() {
    const owned = this.stream, generation = this.generation;
    if (!owned || this.closed) return;
    if (!this.visible()) { await this.stop(); return; }
    try {
      const frame = await this.capture();
      if (generation !== this.generation || this.stream !== owned || this.closed) return;
      if (frame === undefined) { await this.stop(); return; }
      const identity = { conversationId: owned.conversationId, clientId: owned.clientId, epoch: owned.epoch, sequence: ++owned.sequence };
      const result = await this.request(frame ? '/observation/frame' : '/observation/controller', frame ? { ...identity, frame } : { ...identity, action: 'pause' });
      if (generation !== this.generation || this.stream !== owned || this.closed) return;
      Object.assign(owned, result); this.emit();
      this.timer = setTimeout(() => { void this.pulse().catch(this.onError); }, 750);
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      await this.stop().catch(this.onError); this.onError(error);
    }
  }
  async stop() {
    const owned = this.stream;
    this.generation++; this.stream = null; this.remote = null; this.busy = false; clearTimeout(this.timer); this.emit();
    if (owned) await this.request('/observation/controller', { conversationId: owned.conversationId, clientId: owned.clientId, epoch: owned.epoch, action: 'stop' }, true);
  }
  async dispose() {
    this.closed = true; document.removeEventListener('visibilitychange', this.background); window.removeEventListener('context-room-native-active', this.nativeBackground); window.removeEventListener('pagehide', this.unload); await this.stop();
  }
}

export function notebookViewportPreview(surface, scene) {
  const canvas = surface.canvas;
  if (surface.closed || !canvas.isConnected) return undefined;
  if (!canvas.clientWidth || !canvas.clientHeight) return null;
  surface.draw();
  const output = document.createElement('canvas'), scale = Math.min(1, 1024 / canvas.width, 1024 / canvas.height);
  output.width = Math.max(1, Math.round(canvas.width * scale)); output.height = Math.max(1, Math.round(canvas.height * scale));
  output.getContext('2d').drawImage(canvas, 0, 0, output.width, output.height);
  let image = output.toDataURL('image/png');
  if (image.length > 1_398_130) image = output.toDataURL('image/jpeg', .8);
  return { resourceId: scene.resourceId, locationRevision: scene.locator.revision, revision: scene.revision,
    viewport: surface.viewportBounds(), selection: [...surface.selection].slice(0, 64), image };
}

export function documentDraftPreview(text, baseHash, selection = null) {
  const offset = Math.max(0, Math.min(text.length - 20000, (selection?.start || 0) - 10000));
  return { text: text.slice(offset, offset + 20000), baseHash, offset, totalLength: text.length, selection };
}
