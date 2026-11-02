import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestNotebookDestination } from '../src/doc_move.mjs';

const only = (...folders) => rel => folders.some(folder => rel.startsWith(folder));

test('the suggested notebook destination stays docs/ when the project allows it', () => {
  assert.equal(suggestNotebookDestination({ fileName: 'Idea.crnb', allowedPaths: ['docs/', 'Carnets/'], canWrite: only('docs/', 'Carnets/') }), 'docs/Idea.crnb');
});

test('the suggested notebook destination moves to the first allowed folder a project really offers', () => {
  assert.equal(suggestNotebookDestination({ fileName: 'Idea.crnb', allowedPaths: ['Carnets/'], canWrite: only('Carnets/') }), 'Carnets/Idea.crnb');
  assert.equal(suggestNotebookDestination({ fileName: 'Idea.crnb', allowedPaths: ['notes/sub/', 'README.md', '~/x/', '/abs/', '../up/'], canWrite: only('notes/sub/') }), 'notes/sub/Idea.crnb');
});

test('the suggested notebook destination falls back to docs/ when nothing is writable', () => {
  assert.equal(suggestNotebookDestination({ fileName: 'Idea.crnb', allowedPaths: ['Carnets/'], canWrite: () => false }), 'docs/Idea.crnb');
  assert.equal(suggestNotebookDestination({ fileName: 'Idea.crnb', canWrite: () => { throw new Error('x'); } }), 'docs/Idea.crnb');
});
