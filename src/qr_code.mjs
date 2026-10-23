/** Small QR encoder: byte mode, error correction L, versions 1 to 25, no dependency.
 *  Verified against `qrcode` 8.2 fixtures (test/fixtures/qr). Public browser asset. */
const ECC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26];
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12];
export const QR_MAX_VERSION = 25;

function rawModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) { const align = Math.floor(version / 7) + 2; n -= (25 * align - 10) * align - 55; if (version >= 7) n -= 36; }
  return n;
}
const dataCodewords = version => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
const countBits = version => version < 10 ? 8 : 16;

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gfMul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;

function reedSolomon(data, degree) {
  const divisor = new Uint8Array(degree); divisor[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++) {
    for (let j = 0; j < degree; j++) { divisor[j] = gfMul(divisor[j], root); if (j + 1 < degree) divisor[j] ^= divisor[j + 1]; }
    root = gfMul(root, 2);
  }
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1); result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function interleave(data, version) {
  const blocks = BLOCKS[version], eccLength = ECC_PER_BLOCK[version], total = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - total % blocks, shortLength = Math.floor(total / blocks) - eccLength;
  const parts = []; let offset = 0;
  for (let i = 0; i < blocks; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1), chunk = data.slice(offset, offset + length); offset += length;
    parts.push({ chunk, ecc: reedSolomon(chunk, eccLength) });
  }
  const out = [];
  for (let i = 0; i <= shortLength; i++) for (const part of parts) if (i < part.chunk.length) out.push(part.chunk[i]);
  for (let i = 0; i < eccLength; i++) for (const part of parts) out.push(part.ecc[i]);
  return out;
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2, step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let p = version * 4 + 10; positions.length < count; p -= step) positions.splice(1, 0, p);
  return positions;
}

function formatBits(mask) {
  const data = (1 << 3) | mask; // level L = 01
  let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function versionBits(version) {
  let rem = version; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];

function penalty(m) {
  const size = m.length; let score = 0;
  const run = line => {
    let total = 0, length = 1;
    for (let i = 1; i <= line.length; i++) { if (i < line.length && line[i] === line[i - 1]) length++; else { if (length >= 5) total += length - 2; length = 1; } }
    const text = line.map(v => v ? 1 : 0).join('');
    for (const pattern of ['10111010000', '00001011101']) for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) total += 40;
    return total;
  };
  for (let y = 0; y < size; y++) score += run(m[y]);
  for (let x = 0; x < size; x++) score += run(m.map(row => row[x]));
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

/** Returns an array of rows of booleans (true = dark). Throws `qr_too_long` above version 25. */
export function qrMatrix(text, { mask } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  let version = 1;
  while (version <= QR_MAX_VERSION && 4 + countBits(version) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > QR_MAX_VERSION) throw Object.assign(new Error('Too long for a QR code.'), { code: 'qr_too_long' });
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(4, 4); push(bytes.length, countBits(version)); for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length)); while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const codewords = interleave(data, version), size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false)), reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = dark; reserved[y][x] = true; } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); }
  const align = alignmentPositions(version);
  for (const cy of align) for (const cx of align) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === align.at(-1)) || (cx === align.at(-1) && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = chosen => {
    const f = formatBits(chosen), bit = i => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i++) { const dark = ((v >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); }
  }
  const stream = []; for (const word of codewords) for (let i = 7; i >= 0; i--) stream.push((word >>> i) & 1);
  let at = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!reserved[y][x] && at < stream.length) modules[y][x] = stream[at++] === 1;
    }
  }
  const apply = chosen => {
    const copy = modules.map(row => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y][x] && MASKS[chosen](x, y)) copy[y][x] = !copy[y][x];
    const saved = modules.map(row => row.slice());
    for (let y = 0; y < size; y++) modules[y] = copy[y];
    drawFormat(chosen);
    const result = modules.map(row => row.slice());
    for (let y = 0; y < size; y++) modules[y] = saved[y];
    return result;
  };
  if (Number.isInteger(mask)) return apply(mask);
  let best = null, bestScore = Infinity;
  for (let candidate = 0; candidate < 8; candidate++) { const result = apply(candidate), score = penalty(result); if (score < bestScore) { best = result; bestScore = score; } }
  return best;
}

const escapeXml = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** SVG string with a 4-module white quiet zone. */
export function qrSvg(text, { label = 'QR code' } = {}) {
  const matrix = qrMatrix(text), size = matrix.length, total = size + 8;
  let path = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix[y][x]) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="${escapeXml(label)}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
