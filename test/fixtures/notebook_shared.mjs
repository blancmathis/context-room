import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeSharedRepository, connectSharedContext } from '../../src/shared_context.mjs';

export const notebookFixtureGit = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function removeNotebookSharedFixture(base) {
  const visit = directory => {
    if (!fs.lstatSync(directory).isDirectory()) return;
    fs.chmodSync(directory, 0o700);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory() && !item.isSymbolicLink()) visit(path.join(directory, item.name));
  };
  visit(base); fs.rmSync(base, { recursive: true, force: true });
}

/** An owned local bare remote with no accepted skills, destinations or personal data. */
export function addNotebookSharedFixture(root, base) {
  const remote = path.join(base, 'shared.git'), seed = path.join(base, 'shared-seed');
  notebookFixtureGit(base, ['init', '--bare', '--initial-branch=main', remote]);
  notebookFixtureGit(base, ['clone', remote, seed]);
  notebookFixtureGit(seed, ['config', 'user.name', 'Synthetic reviewer']);
  notebookFixtureGit(seed, ['config', 'user.email', 'reviewer@local.invalid']);
  notebookFixtureGit(seed, ['config', 'commit.gpgsign', 'false']);
  initializeSharedRepository(seed, { name: 'Synthetic Shared' });
  fs.writeFileSync(path.join(seed, 'projects.json'), JSON.stringify({ version: 1, projects: [
    { id: 'drawing', title: 'Drawing project' }, { id: 'other', title: 'Other project' },
  ] }));
  for (const id of ['drawing', 'other']) {
    fs.mkdirSync(path.join(seed, 'projects', id, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'projects', id, 'docs', 'README.md'), '# Synthetic accepted context\n');
  }
  notebookFixtureGit(seed, ['add', '.']); notebookFixtureGit(seed, ['commit', '-m', 'Synthetic accepted baseline']);
  notebookFixtureGit(seed, ['push', 'origin', 'main']);
  connectSharedContext(root, { repository: remote, projectId: 'drawing' });
  return { remote, seed };
}
