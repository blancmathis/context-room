import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFileBase } from '../src/ui/file-names.mjs';

test('a title keeps its commas, apostrophes and single spaces', () => {
  assert.equal(safeFileBase('Note · 27 Oct, 01:51'), 'Note · 27 Oct, 01-51');
  assert.equal(safeFileBase("Mathis's plan (draft), v2"), "Mathis's plan (draft), v2");
});

test('separators and Windows-forbidden characters become dashes', () => {
  assert.equal(safeFileBase('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(safeFileBase('line\none\u0000two'), 'line-one-two');
});

test('bidi and zero-width controls are removed', () => {
  assert.equal(safeFileBase('report‮gpj.exe'), 'reportgpj.exe');
  assert.equal(safeFileBase('a​b⁦c﻿'), 'abc');
});

test('Windows device names are not used bare', () => {
  for (const name of ['CON', 'nul', 'Aux', 'COM1', 'lpt9', 'con.txt']) assert.equal(safeFileBase(name), '_' + name);
  assert.equal(safeFileBase('console'), 'console');
});

test('no trailing space, dot or dash after the 80-character cut', () => {
  const cut = safeFileBase('x'.repeat(79) + ' . tail');
  assert.equal(cut, 'x'.repeat(79));
  assert.ok([...safeFileBase('é'.repeat(200))].length <= 80);
  assert.equal(safeFileBase('...'), '');
  assert.equal(safeFileBase('  ', 'Notebook'), 'Notebook');
});
