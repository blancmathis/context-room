/** Native compatibility bridge UI: editable source stays in Context Room. */
export async function openNativeDrawing({ api, scopeKey, session }) {
  const { openNotebookEditor } = await import('/assets/ui/notebook-editor.mjs');
  return openNotebookEditor({ api, scopeKey, path: session.path, resourceId: session.resourceId,
    onConversation: async (source, display) => {
      const assistant = await import('/assets/ui/assistant.mjs');
      return assistant.openConversation({ api, scopeKey, source, ...display });
    } });
}

/** Rasterize the server's immutable, inert native scene at the original PNG
 * bounds. This is rendering saved user/agent objects, not agent generation. */
export async function nativeDrawingPng(snapshot) {
  if (!snapshot?.native || typeof snapshot.svg !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash || '')
      || ![snapshot.width, snapshot.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 4096)
      || snapshot.width * snapshot.height > 16_000_000) throw new Error('The exact bounded drawing snapshot is unavailable.');
  const url = URL.createObjectURL(new Blob([snapshot.svg], { type: 'image/svg+xml' })), image = new Image();
  try {
    image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = snapshot.width; canvas.height = snapshot.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('PNG rendering is unavailable. The editable snapshot remains retained.');
    context.drawImage(image, 0, 0, snapshot.width, snapshot.height);
    const result = canvas.toDataURL('image/png').split(',')[1];
    if (!result || result.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error('This PNG exceeds the correction size limit. Keep its complete editable notebook.');
    return result;
  } finally { URL.revokeObjectURL(url); }
}
