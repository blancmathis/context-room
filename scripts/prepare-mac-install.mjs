#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacInstallation, verifyMacInstallation, macLaunchAgent } from '../src/mac_installation.mjs';
const args = Object.create(null);
try {
  for (let n = 2; n < process.argv.length; n++) {
    const flag = process.argv[n];
    if (!['--source', '--output', '--node', '--whisper', '--model', '--port', '--revision', '--apply', '--verify', '--launch-plist', '--home'].includes(flag) || Object.hasOwn(args, flag)) throw new Error('Unknown or duplicated installation option: ' + flag);
    args[flag] = ['--apply', '--verify', '--launch-plist'].includes(flag) ? true : process.argv[++n];
    if (args[flag] === undefined) throw new Error('Missing option value: ' + flag);
  }
  let result;
  if (args['--verify'] || args['--launch-plist']) {
    if (args['--apply']) throw new Error('Verification and launch-plist rendering cannot apply an installation.');
    result = verifyMacInstallation(args['--output'], args['--revision']);
    if (args['--launch-plist']) {
      process.stdout.write(macLaunchAgent({ runtime: path.join(args['--output'], 'runtime'), nodePath: result.nodePath, home: args['--home'], whisperPath: result.whisperPath, modelPath: result.modelPath, port: result.port }));
      process.exit(0);
    }
  } else result = prepareMacInstallation(args['--source'] || path.resolve(fileURLToPath(new URL('..', import.meta.url))), {
    output: args['--output'], nodePath: args['--node'], whisperPath: args['--whisper'] ?? null, modelPath: args['--model'] ?? null, port: args['--port'] === undefined ? 4317 : Number(args['--port']),
    apply: Boolean(args['--apply']), expectedRevision: args['--revision'],
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
