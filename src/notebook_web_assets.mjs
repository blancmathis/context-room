/** Explicit public client modules, served by the existing guarded HTTP runtime. */
export const NOTEBOOK_WEB_ASSETS = new Map([
  ...['notebook_client', 'notebook_protocol', 'notebook_geometry', 'notebook_gestures', 'notebook_ink', 'notebook_render'].map(name => ['/assets/' + name + '.mjs', { file: name + '.mjs', type: 'text/javascript; charset=utf-8' }]),
  ...['notebook-canvas', 'notebook-editor', 'notebook-review', 'notebook-views', 'assistant', 'assistant-drafts', 'assistant-audio', 'assistant-observation', 'assistant-legacy', 'assistant-recordings', 'notebook-download', 'native-drawing', 'local-proposal-review', 'web-app', 'web-entry', 'notebook-offline', 'device-display'].map(name => ['/assets/ui/' + name + '.mjs', { file: 'ui/' + name + '.mjs', type: 'text/javascript; charset=utf-8' }]),
  ['/assets/ui/browser-session.js', { file: 'ui/browser-session.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/ui/web-app.css', { file: 'ui/web-app.css', type: 'text/css; charset=utf-8' }],
  ['/assets/ui/notebook.css', { file: 'ui/notebook.css', type: 'text/css; charset=utf-8' }],
  ['/assets/ui/assistant.css', { file: 'ui/assistant.css', type: 'text/css; charset=utf-8' }],
]);
