/* Session binding, not authentication. The credential is an HttpOnly cookie. */
(() => {
  const device = document.querySelector('meta[name="context-room-browser-device"]')?.content;
  if (!device || window !== window.top) return;
  const original = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const request = new Request(input instanceof Request ? input : new URL(input, location.href), options);
    const url = new URL(request.url);
    if (url.origin === location.origin && !['GET', 'HEAD'].includes(request.method)) {
      const headers = new Headers(request.headers);
      if (!headers.has('x-context-room-browser-device')) headers.set('x-context-room-browser-device', device);
      return original(new Request(request, { headers }));
    }
    return original(request);
  };
})();
