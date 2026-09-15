/** Save through the owner bridge on Android and the browser elsewhere. */
export function notebookDownload(bytes, filename, type = 'application/json') {
  if (globalThis.ContextRoomNativeOwner) return ContextRoomNativeOwner.saveFile(bytes, filename, type);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
