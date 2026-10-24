import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sign = path.join(root, 'scripts/sign-android-apk.sh');
const run = (args, env = {}) => spawnSync('bash', [sign, ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, ...env } });
const temporary = t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-android-contract-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
};

test('recovery build accepts an explicit keystore path and its own label', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /providers\.gradleProperty\('contextRoomLegacyKeystore'\)/);
  assert.match(gradle, /manifestPlaceholders = \[appLabel: legacyRecovery \? 'Lisière · récupération' : 'Context Room'\]/);
  assert.match(gradle, /legacyRecovery \? 'fr\.lisiere\.android' : 'app\.contextroom\.tablet'/);
  assert.match(read('android/app/src/main/AndroidManifest.xml'), /android:label="\$\{appLabel\}"/);
  // The preserved key is read only when a debug recovery build signs, never while configuring a release.
  assert.doesNotMatch(gradle, /legacyCode <= 0 \|\| !legacyKey/);
  assert.match(gradle, /validateSigningDebug[\s\S]{0,200}legacyRecovery && !legacyKey\.isFile\(\)/);
});

test('owner release keeps app.contextroom.tablet with an explicit version code', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /providers\.gradleProperty\('contextRoomVersionCode'\)\.orElse\('10'\)/);
  assert.match(gradle, /versionCode legacyRecovery \? legacyCode : releaseCode/);
  assert.match(gradle, /debug \{ applicationIdSuffix legacyRecovery \? '' : '\.preview'/);
  assert.doesNotMatch(gradle.match(/release \{[^}]*\}/)[0], /signingConfig/, 'the release artifact stays unsigned for the owner key');
});

test('sign-android-apk refuses relative paths, a key inside the repository and an existing output', t => {
  const base = temporary(t);
  const apk = path.join(base, 'in.apk'), key = path.join(base, 'k.keystore'), existing = path.join(base, 'out.apk');
  for (const file of [apk, key, existing]) fs.writeFileSync(file, 'x');
  const env = { ANDROID_HOME: path.join(base, 'no-sdk') };
  let result = run(['in.apk', key, path.join(base, 'new.apk')], env);
  assert.equal(result.status, 2); assert.match(result.stderr, /absolute paths/);
  result = run([apk, key, existing], env);
  assert.equal(result.status, 2); assert.match(result.stderr, /existing output/);
  result = run([apk, key, path.join(base, 'new.apk'), '--upgrade-from'], env);
  assert.equal(result.status, 2); assert.match(result.stderr, /Usage/);
  const inside = fs.mkdtempSync(path.join(root, 'cr-key-test-'));
  t.after(() => fs.rmSync(inside, { recursive: true, force: true }));
  const repoKey = path.join(inside, 'k.keystore'); fs.writeFileSync(repoKey, 'x');
  result = run([apk, repoKey, path.join(base, 'new.apk')], env);
  assert.equal(result.status, 2); assert.match(result.stderr, /inside the repository/);
  assert.equal(fs.existsSync(path.join(base, 'new.apk')), false);
});

test('check-android-artifact accepts an explicit package name', () => {
  const source = read('scripts/check-android-artifact.py');
  assert.match(source, /add_argument\('--package'/);
  assert.match(source, /expected_package = args\.package or \('fr\.lisiere\.android' if args\.upgrade_from else 'app\.contextroom\.tablet\.preview'\)/);
  const help = spawnSync('python3', ['-B', path.join(root, 'scripts/check-android-artifact.py'), '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(help.status, 0); assert.match(help.stdout, /--package/);
});
