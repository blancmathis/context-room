import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { qrMatrix, qrSvg } from '../src/qr_code.mjs';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/qr/matrices.json', import.meta.url), 'utf8'));
const rows = matrix => matrix.map(row => row.map(dark => dark ? '1' : '0').join(''));

test('matrices match qrcode 8.2 fixtures for versions 1, 5, 10, 17, 25', () => {
  assert.deepEqual(fixtures.map(item => item.version), [1, 5, 10, 17, 25]);
  for (const item of fixtures) for (const [mask, expected] of Object.entries(item.masks)) {
    const actual = rows(qrMatrix(item.text, { mask: Number(mask) }));
    assert.equal(actual.length, item.version * 4 + 17, `size of version ${item.version}`);
    assert.deepEqual(actual, expected, `version ${item.version} mask ${mask}`);
  }
});

test('format and version bits are valid', () => {
  const bch = (value, poly, bits) => { let rem = value; for (let i = 0; i < bits; i++) rem = (rem << 1) ^ ((rem >>> (bits - 1)) * poly); return rem & ((1 << bits) - 1); };
  for (const item of fixtures) {
    const m = qrMatrix(item.text), size = m.length;
    let format = 0; for (let i = 14; i >= 0; i--) format = (format << 1) | Number(i < 8 ? m[8][size - 1 - i] : m[size - 15 + i][8]);
    format ^= 0x5412;
    assert.equal(format >>> 10, (1 << 3) | (format >>> 10 & 7), 'level L');
    assert.equal(bch(format >>> 10, 0x537, 10), format & 0x3ff, 'format BCH');
    if (item.version >= 7) {
      let version = 0; for (let i = 17; i >= 0; i--) version = (version << 1) | Number(m[Math.floor(i / 3)][size - 11 + i % 3]);
      assert.equal(version >>> 12, item.version); assert.equal(bch(version >>> 12, 0x1f25, 12), version & 0xfff);
    }
    assert.equal(m[size - 8][8], true, 'fixed dark module');
  }
});

test('too long input is refused with qr_too_long', () => {
  assert.throws(() => qrMatrix('x'.repeat(2000)), { code: 'qr_too_long' });
  assert.ok(qrMatrix('x'.repeat(fixtures.at(-1).text.length)).length === 117);
});

test('SVG has a four-module quiet zone and escapes its label', () => {
  const svg = qrSvg('hello', { label: 'a "b" <c>' }), size = qrMatrix('hello').length + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /aria-label="a &quot;b&quot; &lt;c&gt;"/);
  assert.doesNotMatch(svg, /M[0-3] |M\d+ [0-3]h/);
});
