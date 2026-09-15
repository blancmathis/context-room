/** Explicit view sharing is transient. It never changes the notebook or its review. */
export class NotebookViewLink {
  constructor({ request, surface, target, busy, changed }) {
    Object.assign(this, { request, surface, target, busy, changed });
    this.mode = 'independent'; this.sequence = 0; this.sessionId = crypto.randomUUID(); this.generation = 0;
    this.timer = setInterval(() => void this.tick(), 1200);
    this.describe();
  }
  describe(text = '') { this.changed({ mode: this.mode, device: this.device, text }); }
  async select(device, projectId, mode) {
    if (this.device && this.device.id !== device.id) {
      await this.release(); this.sessionId = crypto.randomUUID(); this.nativeSessionId = null; this.sequence = 0; this.signature = null;
    }
    this.device = device; this.projectId = projectId; this.mode = mode; this.generation++; this.receipt = null; this.pending = null; this.sentIndependent = false;
    this.describe(mode === 'share' ? 'View sharing requested. The tablet must choose Follow Mac.' : 'Waiting for the tablet to share its view.');
    void this.tick();
  }
  interaction() { if (this.mode === 'follow') { this.mode = 'independent'; this.generation++; this.pending = null; this.receipt = null; this.describe('Following stopped. You control this view.'); void this.tick(); } }
  async release() {
    this.mode = 'independent'; this.generation++; this.pending = null; this.receipt = null;
    if (this.device) {
      const body = this.body();
      try { await this.request('/api/devices/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch { /* The remote lease expires without a heartbeat. */ }
    }
    this.describe('Independent views.');
  }
  body() {
    const target = this.target(this.projectId), usable = target && document.visibilityState === 'visible';
    const mode = usable ? this.mode : 'independent';
    const content = { mode, target: mode === 'independent' ? null : target, viewport: mode === 'share' ? this.surface.viewportBounds() : null };
    const signature = JSON.stringify(content);
    if (signature !== this.signature) { this.signature = signature; this.sequence++; }
    return { ...content, sessionId: this.sessionId, sequence: this.sequence, nativeSessionId: this.nativeSessionId,
      deviceId: this.device.id, receipt: mode === 'follow' ? this.receipt : null };
  }
  async tick() {
    if (this.closed || this.running || !this.device || this.mode === 'independent' && this.sentIndependent) return;
    const body = this.body(), generation = this.generation;
    this.running = true;
    try {
      const data = await this.request('/api/devices/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (this.closed || generation !== this.generation) return;
      this.nativeSessionId = data.nativeSessionId; this.sentIndependent = body.mode === 'independent';
      if (this.mode === 'share') this.describe(data.receipt?.sessionId === this.sessionId && data.receipt.sequence === body.sequence ? 'Current view displayed on ' + this.device.label + '.' : 'View shared · display not yet confirmed.');
      if (this.mode !== 'follow') return;
      const frame = data.frame, target = this.target(this.projectId);
      if (!frame || !target || this.busy() || document.visibilityState !== 'visible'
        || !['projectId', 'resourceId', 'path', 'locationRevision'].every(key => frame.target?.[key] === target[key])) {
        this.pending = null; this.describe('Waiting for a shared view of this exact notebook.'); return;
      }
      if (this.receipt?.sessionId === frame.sessionId && this.receipt.sequence === frame.sequence
        && JSON.stringify(this.receipt.viewport) === JSON.stringify(this.surface.viewportBounds())) return;
      this.pending = { ...frame, deadline: performance.now() + Math.max(0, Math.min(5000, frame.expiresAt - data.serverTime)), generation };
      if (!this.surface.frameViewport(frame.viewport)) { this.pending = null; this.describe('This view cannot be displayed at the current size.'); }
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.pending = null; this.receipt = null;
      if ([401, 403, 409, 410].includes(error.status)) { this.mode = 'independent'; this.generation++; }
      this.describe(error.message + ' View display is not confirmed.');
    } finally { this.running = false; }
  }
  rendered() {
    const frame = this.pending, target = this.target(this.projectId);
    if (!frame || this.closed || this.mode !== 'follow' || frame.generation !== this.generation || performance.now() >= frame.deadline
      || this.busy() || document.visibilityState !== 'visible' || !this.surface.canvas.isConnected
      || !target || !['projectId', 'resourceId', 'path', 'locationRevision'].every(key => frame.target[key] === target[key])) return;
    this.receipt = { sessionId: frame.sessionId, sequence: frame.sequence, target, viewport: this.surface.viewportBounds() };
    this.pending = null; this.describe('Following ' + this.device.label + '. Draw or use a tool to stop.');
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.release(); }
}
