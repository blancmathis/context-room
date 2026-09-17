let registrationPromise, registrationError, installPrompt, currentNotebook, displayController = null, displayStarting = false;
/** VisualViewport covers keyboard resizing without a browser-specific meta
 * directive. Pinch zoom must keep its own viewport and must not resize ink. */
export function keyboardViewport(viewport, layoutHeight) {
  if (!viewport || !Number.isFinite(layoutHeight) || layoutHeight <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0
    || !Number.isFinite(viewport.offsetTop) || viewport.offsetTop < 0
    || !Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) > 0.01
    || viewport.height >= layoutHeight - 1) return null;
  const top = Math.min(viewport.offsetTop, Math.max(0, layoutHeight - viewport.height));
  return { height: viewport.height, top, bottom: Math.max(0, layoutHeight - top - viewport.height) };
}
export function trackKeyboardViewport(host = window) {
  const viewport = host.visualViewport, root = host.document.documentElement;
  if (!viewport) return () => {};
  const update = () => {
    const visible = keyboardViewport(viewport, host.innerHeight);
    if (visible) {
      root.dataset.contextRoomKeyboardViewport = '';
      for (const [name, value] of Object.entries(visible)) root.style.setProperty('--context-room-visible-' + name, value + 'px');
    } else {
      delete root.dataset.contextRoomKeyboardViewport;
      for (const name of ['height', 'top', 'bottom']) root.style.removeProperty('--context-room-visible-' + name);
    }
  };
  viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update); host.addEventListener('resize', update);
  update();
  return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); host.removeEventListener('resize', update); };
}
/** Cache installation can fail. Never call that offline-ready or wait forever. */
export function waitForApplicationCache(registration, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const watched = new Set(); let timer, complete = false;
    const finish = error => {
      if (complete) return; complete = true; clearTimeout(timer);
      registration.removeEventListener('updatefound', check);
      for (const worker of watched) worker.removeEventListener('statechange', check);
      error ? reject(error) : resolve(registration);
    };
    const check = () => {
      if (registration.active?.state === 'activated') { finish(); return; }
      const worker = registration.installing || registration.waiting || registration.active;
      if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener('statechange', check); }
      if (worker?.state === 'redundant' || !worker && [...watched].some(item => item.state === 'redundant')) finish(new Error('Application caching failed. Stay connected and retry; local ink is retained.'));
    };
    registration.addEventListener('updatefound', check);
    timer = setTimeout(() => finish(new Error('Application caching is not confirmed. Stay connected and check again before closing offline.')), timeoutMs);
    check();
  });
}
export function prepareWebApp() {
  const profile = document.documentElement.dataset.contextRoomRuntimeProfile;
  if (profile && profile !== 'local') return Promise.resolve(null);
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator) || globalThis.ContextRoomNativeOwner) return Promise.resolve(null);
  return registrationPromise ||= navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
    .then(registration => waitForApplicationCache(registration)).catch(error => { registrationError = error; registrationPromise = null; throw error; });
}
export async function showWebAppSettings() {
  if (!document.querySelector('link[data-web-app-style]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/assets/ui/web-app.css'; link.dataset.webAppStyle = ''; document.head.append(link);
  }
  const dialog = document.createElement('dialog'); dialog.className = 'web-app-dialog'; dialog.setAttribute('aria-label', 'Install and offline notebooks');
  const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; dialog.append(el); return el; };
  add('h2', 'Context Room on this device');
  const status = add('p', 'Preparing the application cache…'); status.setAttribute('role', 'status');
  add('p', 'Only the application is cached by the service worker. Working notebooks use the existing local journal. Hub, agent and review require the connected Mac.');
  const install = add('button', 'Install Context Room'); install.type = 'button'; install.disabled = !installPrompt;
  install.addEventListener('click', async () => {
    if (!installPrompt) return;
    try { await prepareWebApp(); await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; install.disabled = true; }
    catch (error) { status.textContent = 'Offline application not ready: ' + error.message; }
  });
  add('p', 'The browser’s Install app / Add to Home screen menu is also available when supported.');
  const protect = add('button', 'Request persistent local storage'); protect.type = 'button';
  protect.addEventListener('click', async () => {
    try { status.textContent = await navigator.storage?.persist?.() ? 'Persistent local storage granted. Keep exports as backups.' : 'The browser did not grant persistence. Keep recovery exports; clearing site data removes local-only work.'; }
    catch (error) { status.textContent = error.message; }
  });
  const check = add('button', 'Check application update'); check.type = 'button';
  const show = registration => {
    status.textContent = registration?.waiting ? 'Update ready. Finish saving, close ALL Context Room windows on this origin, then reopen. No forced reload; local gestures are retained.'
      : registration ? 'Application cached for offline reopening. Locally saved ink and confirmation by the Mac are separate states.'
      : globalThis.ContextRoomNativeOwner ? 'This native workspace uses packaged application bytes and its pinned transport. Use a trusted HTTPS browser connection for PWA installation.' : 'Offline installation requires a supported browser and a trusted secure local-runtime connection.';
  };
  check.addEventListener('click', async () => { try { const registration = await prepareWebApp(); await registration?.update(); show(registration); } catch (error) { status.textContent = 'Offline application not ready: ' + error.message; } });
  if (globalThis.ContextRoomNativeOwner) {
    for (const [label, action] of [['Connection settings', 'openConnectionSettings'], ['Recover legacy native journals', 'recoverLegacyNotebooks']]) {
      const control = add('button', label); control.type = 'button';
      control.addEventListener('click', async () => {
        const editor = currentNotebook;
        if (editor?.dialog.isConnected) { await editor.close(); if (editor.dialog.isConnected) return; }
        dialog.close(); await ContextRoomNativeOwner[action]?.();
      });
    }
  }
  add('h3', 'Notebooks saved on this device');
  const list = document.createElement('div'); dialog.append(list);
  add('p', 'Updates never clear notebook storage. Revocation blocks Mac requests, not recovery of bytes already saved on this device. Do not clear site data before exporting unsynchronized work.');
  const close = add('button', 'Close offline settings'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  try { const { appendCachedNotebooks } = await import('./notebook-offline.mjs'); await appendCachedNotebooks(list); }
  catch (error) { list.textContent = error.message; }
  prepareWebApp().then(show).catch(error => { status.textContent = 'Offline application not ready: ' + error.message; });
  return dialog;
}
if (typeof window !== 'undefined' && window === window.top) {
  trackKeyboardViewport();
  const display = async () => {
    if (document.hidden || globalThis.ContextRoomNativeOwner?.active === false || displayController || displayStarting || !globalThis.ContextRoomNativeOwner?.navigation && !document.querySelector('meta[name="context-room-browser-device"]')?.content && !currentNotebook?.browserDeviceId) return;
    displayStarting = true;
    try { const { startDeviceDisplay } = await import('./device-display.mjs'); displayController = await startDeviceDisplay({ currentEditor: () => currentNotebook }); if (document.hidden || globalThis.ContextRoomNativeOwner?.active === false) { displayController?.stop?.(); displayController = null; } } catch { /* Offline ink remains independent; retry on reconnect. */ }
    finally { displayStarting = false; }
  };
  document.addEventListener('context-room-notebook-opened', event => { currentNotebook = event.detail; void display(); });
  document.addEventListener('context-room-notebook-closed', event => { if (currentNotebook?.dialog === event.detail.dialog) currentNotebook = null; });
  const stopDisplay = () => { displayController?.stop?.(); displayController = null; };
  window.addEventListener('context-room-native-active', event => { if (event.detail === true) void display(); else stopDisplay(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopDisplay(); else void display(); });
  window.addEventListener('online', () => void display());
  void display();
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
  document.addEventListener('click', event => { if (event.target.closest('[data-web-app-settings]')) void showWebAppSettings(); });
  const start = () => { void prepareWebApp().catch(() => {}); };
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
}
