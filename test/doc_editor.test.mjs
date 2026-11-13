import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceColumnForRendered } from '../src/ui/doc-editor.mjs';

// R2: a tap on the rendered doc puts the caret at the same place in the Markdown source.
test('a tap after a long relative link lands after the link, not inside its path', () => {
  const source = '[a](docs/architecture/decisions/very-long-name-of-a-file.md) voir';
  assert.equal(sourceColumnForRendered('a vo', source), source.indexOf('voir') + 2);
});

test('a tap passes over hidden Markdown marks', () => {
  assert.equal(sourceColumnForRendered('Prérequis : Python 3', 'Prérequis : **Python 3.11** ou plus'), 'Prérequis : **Python 3'.length);
  assert.equal(sourceColumnForRendered('Install', '## Install it'), '## Install'.length);
  assert.equal(sourceColumnForRendered('see a', 'see `a` and [b](x.md)'), 'see `a'.length);
});
