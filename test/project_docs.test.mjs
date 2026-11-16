import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { splitDocs, groupByFolder, byDate, filterDocs, folderOf } from '../src/ui/project-docs.mjs';
import { NOTEBOOK_WEB_ASSETS } from '../src/notebook_web_assets.mjs';

const files = [
  { path: 'docs/INSTALLATION.md', updatedAt: '2026-11-11T10:00:00.000Z', title: 'Installer Sillage' },
  { path: 'README.md', updatedAt: '2026-10-03T10:00:00.000Z', title: 'Sillage' },
  { path: 'docs/recherche/Pratiques.md', updatedAt: '2026-10-02T10:00:00.000Z', title: 'Études récentes' },
  { path: 'CONTEXT.md', updatedAt: '2026-11-12T10:00:00.000Z' },
  { path: 'docs/diagram.mmd', updatedAt: '2026-11-01T10:00:00.000Z' },
  { path: 'brand/palette.json', updatedAt: '2026-11-01T10:00:00.000Z' },
];

test('All docs keeps Markdown and text apart from the other files of the index', () => {
  const { docs, others } = splitDocs(files);
  assert.deepEqual(docs.map((doc) => doc.path), ['docs/INSTALLATION.md', 'README.md', 'docs/recherche/Pratiques.md', 'CONTEXT.md']);
  assert.deepEqual(others.map((doc) => doc.path), ['docs/diagram.mmd', 'brand/palette.json']);
});

test('All docs groups by folder with the root first, then sorts by date when asked', () => {
  const { docs } = splitDocs(files);
  assert.deepEqual(groupByFolder(docs).map(([folder, items]) => [folder, items.map((doc) => doc.path)]), [
    ['', ['CONTEXT.md', 'README.md']],
    ['docs', ['docs/INSTALLATION.md']],
    ['docs/recherche', ['docs/recherche/Pratiques.md']],
  ]);
  assert.deepEqual(byDate(docs).map((doc) => doc.path), ['CONTEXT.md', 'docs/INSTALLATION.md', 'README.md', 'docs/recherche/Pratiques.md']);
  assert.equal(folderOf('README.md'), '');
});

test('the filter of All docs puts a name that starts with the query first and reads the heading, without accents', () => {
  const { docs } = splitDocs(files);
  assert.equal(filterDocs(docs, 'install')[0].path, 'docs/INSTALLATION.md');
  // « sillage » is in two headings and in no name: both match, by name.
  assert.deepEqual(filterDocs(docs, 'sillage').map((doc) => doc.path), ['docs/INSTALLATION.md', 'README.md']);
  assert.deepEqual(filterDocs(docs, 'etudes').map((doc) => doc.path), ['docs/recherche/Pratiques.md']);
  assert.deepEqual(filterDocs(docs, 'recherche prat').map((doc) => doc.path), ['docs/recherche/Pratiques.md']);
  assert.deepEqual(filterDocs(docs, 'nothing-here'), []);
  assert.equal(filterDocs(docs, '  ').length, docs.length);
});

test('All docs is served from the fixed asset list and fetched by the project page on demand', () => {
  assert.equal(NOTEBOOK_WEB_ASSETS.get('/assets/ui/project-docs.mjs')?.file, 'ui/project-docs.mjs');
  const page = fs.readFileSync(new URL('../src/ui/project-page.mjs', import.meta.url), 'utf8');
  assert.match(page, /import\('\/assets\/ui\/project-docs\.mjs'\)/);
});
