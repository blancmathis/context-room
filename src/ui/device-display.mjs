/** One foreground display protocol for browser and APK. It never owns ink or review. */
export const sameDisplayTarget = (a, b) => a && b && ['projectId', 'resourceId', 'path', 'locationRevision'].every(key => a[key] === b[key]);
export class DeviceDisplay {
  constructor({ request, session, open, busy = () => false, active = () => true, changed = () => {}, clock = () => performance.now(), id = crypto.randomUUID() }) {
    Object.assign(this, { request, session, open, extraBusy: busy, active, changed, clock, id });
    this.mode = 'independent'; this.sequence = 0; this.generation = 0; this.humanEpoch = 0;
  }
  attach(editor) {
    this.editor = editor; this.mode = 'independent'; this.generation++; this.frame = null; this.viewReceipt = null;
    if (editor) {
      const rendered = editor.surface.onRendered;
      editor.surface.onRendered = (...args) => { rendered?.(...args); if (this.editor === editor) this.rendered(); };
    }
    this.changed(this.mode, 'Independent views.');
  }
  target() {
    const editor = this.editor;
    if (!editor?.dialog.isConnected || editor.dialog.dataset.saveState !== 'confirmed' || editor.browserDeviceId && editor.browserDeviceId !== this.session.device.id) return null;
    let fields; try { fields = JSON.parse(editor.scopeKey); } catch { return null; }
    if (!Array.isArray(fields) || fields.length !== 4 || fields[3]) return null;
    const binding = editor.binding();
    return { projectId: fields[2] || fields[1], resourceId: binding.resourceId, path: binding.path, locationRevision: binding.locationRevision, sceneRevision: binding.revision };
  }
  busy() { return !this.active() || this.extraBusy() || Boolean(this.editor && (!this.target() || this.editor.busy())); }
  setMode(mode) {
    if (!['independent', 'share', 'follow'].includes(mode)) throw new TypeError('Unknown display mode.');
    this.mode = mode; this.generation++; this.frame = null; this.viewReceipt = null;
    this.changed(mode, mode === 'follow' ? 'Waiting for the owner to share this exact notebook.' : mode === 'share' ? 'View shared · display not yet confirmed.' : 'Independent views.');
  }
  interaction() {
    this.humanEpoch++; this.generation++; this.frame = null;
    if (this.mode === 'follow') this.setMode('independent');
    if (this.command && (!this.receipt || this.receipt.status === 'deferred')) this.report('cancelled');
  }
  viewBody() {
    const target = this.target(), mode = target && this.active() ? this.mode : 'independent';
    const value = { mode, target: mode === 'independent' ? null : target, viewport: mode === 'share' ? this.editor.surface.viewportBounds() : null };
    const signature = JSON.stringify(value);
    if (signature !== this.signature) { this.signature = signature; this.sequence++; }
    return { ...value, sequence: this.sequence, receipt: mode === 'follow' ? this.viewReceipt : null };
  }
  report(status, target) {
    if (!this.command) return;
    this.receipt = { protocolVersion: 1, clientSessionId: this.id, operationId: this.command.operationId, status, ...(target ? { target } : {}) };
  }
  async tick() {
    if (this.closed || this.running || !this.active()) return;
    this.running = true;
    const receipt = this.receipt, generation = this.generation, body = receipt || { protocolVersion: 1, clientSessionId: this.id, busy: this.busy(), view: this.viewBody() };
    try {
      const data = await this.request(receipt ? 'receipt' : 'poll', body);
      if (this.closed) return;
      if (receipt) {
        if (this.receipt === receipt) this.receipt = null;
        if (receipt.status !== 'deferred' && this.command?.operationId === receipt.operationId) this.command = null;
        return;
      }
      if (data.protocolVersion !== 1 || data.serverId !== this.session.serverId || data.deviceId !== this.session.device.id || data.clientSessionId !== this.id) throw Object.assign(new Error('A different display session answered.'), { status: 409 });
      if (!this.active() || generation !== this.generation) return;
      await this.receiveCommand(data);
      if (generation === this.generation) this.receiveView(data.view, body.view);
    } catch (error) {
      this.frame = null; this.viewReceipt = null;
      if ([401, 403, 410].includes(error.status) || error.status === 409 && error.code !== 'device_navigation_stale') { this.command = null; this.receipt = null; this.setMode('independent'); this.closed = true; }
      this.changed(this.mode, error.message + ' No display is confirmed.');
    } finally { this.running = false; }
  }
  async receiveCommand(data) {
    const command = data.command;
    if (!command) { this.command = null; return; }
    if (command.action !== 'open' || command.clientSessionId !== this.id || !command.target) return;
    if (command.operationId !== this.command?.operationId) {
      this.command = command; this.opening = false; this.deferred = false;
      this.deadline = this.clock() + Math.max(0, Math.min(30_000, command.expiresAt - data.serverTime));
    }
    if (this.clock() >= this.deadline || this.receipt || this.opening) return;
    if (this.busy()) { if (!this.deferred) { this.deferred = true; this.report('deferred'); this.changed(this.mode, 'Opening requested · waiting for the gesture, draft or conversation to finish.'); } return; }
    this.opening = true; const epoch = this.humanEpoch, current = this.command;
    const unchanged = () => !this.closed && this.active() && this.command === current && this.humanEpoch === epoch && this.clock() < this.deadline && !this.extraBusy();
    try {
      if (this.editor) { await this.editor.close(); if (this.editor?.dialog.isConnected) throw new Error('Finish recovering the original notebook before opening another.'); }
      if (!unchanged()) { this.report('cancelled'); return; }
      const editor = await this.open(command.target, snapshot => unchanged() && snapshot?.resourceId === command.target.resourceId
        && snapshot.locator.path === command.target.path && snapshot.locator.revision === command.target.locationRevision && snapshot.revision >= command.target.sceneRevision);
      if (!editor || editor.error) throw new Error('The requested notebook could not be displayed.');
      if (this.editor !== editor) this.attach(editor);
      editor.surface.schedule(); // Receipt comes only from its actual render callback.
    } catch (error) { this.report(unchanged() ? 'unavailable' : 'cancelled'); this.changed(this.mode, error.message); }
  }
  receiveView(data, sent) {
    if (!data || sent.mode !== this.mode) return;
    if (this.mode === 'share') { this.changed(this.mode, data.receipt?.sequence === sent.sequence ? 'Current view displayed on the connected owner.' : 'View shared · display not yet confirmed.'); return; }
    const frame = data.frame, target = this.target();
    if (this.mode !== 'follow' || !frame || !sameDisplayTarget(target, frame.target) || this.busy()) { this.frame = null; return; }
    if (this.viewReceipt?.sessionId === frame.sessionId && this.viewReceipt.sequence === frame.sequence && JSON.stringify(this.viewReceipt.viewport) === JSON.stringify(this.editor.surface.viewportBounds())) return;
    const deadline = this.clock() + Math.max(0, Math.min(5000, frame.expiresAt - data.serverTime));
    if (deadline <= this.clock()) return;
    this.frame = { ...frame, deadline, generation: this.generation };
    if (!this.editor.surface.frameViewport(frame.viewport)) { this.frame = null; this.changed(this.mode, 'This view cannot be displayed at the current size.'); }
  }
  rendered() {
    if (this.closed || this.busy() || !this.editor?.surface.canvas.isConnected) return;
    const target = this.target();
    if (this.opening && this.command && !this.receipt && this.clock() < this.deadline && sameDisplayTarget(target, this.command.target) && target.sceneRevision >= this.command.target.sceneRevision) this.report('applied', target);
    if (this.mode === 'follow' && this.frame && this.clock() < this.frame.deadline && this.frame.generation === this.generation && sameDisplayTarget(target, this.frame.target)) {
      this.viewReceipt = { sessionId: this.frame.sessionId, sequence: this.frame.sequence, target, viewport: this.editor.surface.viewportBounds() };
      this.frame = null; this.changed(this.mode, 'Following the connected owner. A gesture or tool stops following.');
    }
  }
}

/** Web Locks ensure only one window owns navigation; other windows still edit independently. */
export async function startDeviceDisplay({ currentEditor = () => null } = {}) {
  const sessionResponse = await fetch('/browser/session', { cache: 'no-store', credentials: 'same-origin' });
  if (!sessionResponse.ok) return false;
  const session = await sessionResponse.json();
  if (!session.serverId || !session.device?.id || !navigator.locks || document.hidden || globalThis.ContextRoomNativeOwner?.active === false) return false;
  let release, reportStarted;
  const started = new Promise(resolve => { reportStarted = resolve; });
  const lifetime = new Promise(resolve => { release = resolve; });
  window.addEventListener('pagehide', release, { once: true });
  void navigator.locks.request('context-room-display:' + session.device.id, { ifAvailable: true }, async lock => {
    if (!lock || document.hidden || globalThis.ContextRoomNativeOwner?.active === false) { reportStarted(false); return; }
    const controller = new AbortController();
    let select, status;
    const display = new DeviceDisplay({ session,
      active: () => !document.hidden && globalThis.ContextRoomNativeOwner?.active !== false,
      busy: () => Boolean(globalThis.contextRoomDeviceNavigationBusy?.() || document.querySelector('.assistant-panel:not([hidden])') || document.activeElement?.matches('input, textarea, select') || [...document.querySelectorAll('dialog[open]')].some(d => !d.classList.contains('notebook-dialog'))),
      changed: (mode, text) => { if (select) select.value = mode; if (status) status.textContent = text; },
      request: async (action, body) => {
        if (globalThis.ContextRoomNativeOwner?.navigation) {
          const response = await ContextRoomNativeOwner.navigation(action, body);
          if (response.status !== 200) throw Object.assign(new Error(response.body.error || 'The display is unavailable.'), { status: response.status, code: response.body.code });
          return response.body;
        }
        const response = await fetch('/browser/navigation/' + action, { method: 'POST', signal: controller.signal, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-context-room-browser-device': session.device.id }, body: JSON.stringify(body) });
        const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code }); return result;
      },
      open: (target, beforePresent) => typeof globalThis.openSharedDrawingTarget === 'function'
        ? globalThis.openSharedDrawingTarget(target, beforePresent)
        : globalThis.openContextRoomNotebook(target.path, { projectId: target.projectId, resourceId: target.resourceId, beforePresent }),
    });
    const attach = editor => {
      display.attach(editor); if (!editor) return;
      editor.dialog.querySelector('.notebook-device-display')?.remove();
      const controls = document.createElement('label'); controls.className = 'notebook-device-display'; controls.textContent = 'Device view';
      select = document.createElement('select'); select.setAttribute('aria-label', 'Device view mode');
      for (const [mode, title] of [['independent', 'Independent views'], ['share', 'Share this view'], ['follow', 'Follow the connected owner']]) select.add(new Option(title, mode));
      status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = 'Independent views.';
      controls.append(select, status); editor.dialog.querySelector('.notebook-state').append(controls);
      select.addEventListener('change', async () => { const mode = select.value; await editor.releaseView?.(); display.setMode(mode); select.blur(); void display.tick(); });
    };
    document.addEventListener('context-room-notebook-opened', event => attach(event.detail), { signal: controller.signal });
    document.addEventListener('context-room-notebook-closed', event => { if (display.editor?.dialog === event.detail.dialog) attach(null); }, { signal: controller.signal });
    for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, () => display.interaction(), { capture: true, passive: true, signal: controller.signal });
    attach(currentEditor());
    const timer = setInterval(() => void display.tick(), 1000); void display.tick();
    reportStarted({ stop: release });
    await lifetime; display.closed = true; clearInterval(timer); controller.abort();
    display.editor?.dialog.querySelector('.notebook-device-display')?.remove();
    window.removeEventListener('pagehide', release);
  }).catch(() => { reportStarted(false); });
  return started;
}
