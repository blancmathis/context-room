import { failNotebook } from './notebook_protocol.mjs';
export const NOTEBOOK_IMAGE_PIXELS = 16_000_000;
/** Header-only dimensions before decoding. Never execute an asset or trust its declared MIME alone. */
export function notebookImageSize(bytes, mimeType) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (at, count) => String.fromCharCode(...data.subarray(at, at + count));
  let width, height;
  if (mimeType === 'image/png' && data.length >= 33 && text(12, 4) === 'IHDR' && view.getUint32(8) === 13 && [137,80,78,71,13,10,26,10].every((v,i)=>data[i]===v)) { width = view.getUint32(16); height = view.getUint32(20); }
  else if (mimeType === 'image/jpeg' && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++]; if ([0xd9,0xda].includes(marker)) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > data.length) break;
      const size = view.getUint16(offset); if (size < 2 || offset + size > data.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 8) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; }
      offset += size;
    }
  } else if (mimeType === 'image/webp' && data.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && view.getUint32(4, true) + 8 === data.length) {
    const type = text(12, 4), size = view.getUint32(16, true);
    if (size + 20 <= data.length && type === 'VP8X' && size === 10) { width = 1 + data[24] + (data[25] << 8) + (data[26] << 16); height = 1 + data[27] + (data[28] << 8) + (data[29] << 16); }
    else if (size + 20 <= data.length && type === 'VP8L' && size >= 5 && data[20] === 0x2f) { const bits = view.getUint32(21, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    else if (size + 20 <= data.length && type === 'VP8 ' && size >= 10 && data[23] === 0x9d && data[24] === 1 && data[25] === 0x2a) { width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff; }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) failNotebook('notebook_asset', 'The raster image has an invalid or unsupported size header. Keep the original for recovery.');
  if (width * height > NOTEBOOK_IMAGE_PIXELS) failNotebook('notebook_image_size', 'The image exceeds the 16 million pixel rendering limit. The original is unchanged.');
  return { width, height };
}
