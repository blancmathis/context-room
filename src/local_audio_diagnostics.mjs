import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function localAudioConfiguration({ root, modelPath, whisper, speech } = {}) {
  root = path.resolve(root || process.env.CONTEXT_ROOM_ASSISTANT_HOME || path.join(os.homedir(), '.context-room', 'assistant'));
  return { root, modelPath: modelPath || process.env.CONTEXT_ROOM_WHISPER_MODEL || path.join(root, 'models', 'ggml-large-v3-turbo-q5_0.bin'),
    whisper: whisper || process.env.CONTEXT_ROOM_WHISPER_BIN || 'whisper-cli', speech: speech || '/usr/bin/say' };
}
function executable(command, searchPath) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return false;
  const candidates = path.isAbsolute(command) ? [command] : command.includes('/') || command.includes('\\') ? []
    : String(searchPath || '').split(path.delimiter).filter(folder => path.isAbsolute(folder)).map(folder => path.join(folder, command));
  return candidates.some(file => {
    try { if (!fs.statSync(file).isFile()) return false; fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
}

/** Read-only installation diagnostics. Never start Codex, whisper, speech, a
 * package manager or a download. Presence does not certify a model or an APK. */
export function inspectLocalAudio(options = {}) {
  const configuration = localAudioConfiguration(options), searchPath = options.searchPath ?? process.env.PATH, platform = options.platform || process.platform;
  const whisper = executable(configuration.whisper, searchPath), speech = platform === 'darwin' && executable(configuration.speech, searchPath);
  let model = false, modelReason = 'missing';
  try {
    const info = fs.lstatSync(configuration.modelPath);
    modelReason = !info.isFile() ? 'not-regular' : info.size === 0 ? 'empty' : 'present-not-inference-tested';
    if (info.isFile() && info.size > 0) { fs.accessSync(configuration.modelPath, fs.constants.R_OK); model = true; }
  } catch (error) { modelReason = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  const issues = [];
  if (!whisper) issues.push({ code: 'whisper-executable-missing', action: 'Install the local whisper.cpp CLI, or set CONTEXT_ROOM_WHISPER_BIN to its executable. No package is installed automatically.' });
  if (!model) issues.push({ code: 'whisper-model-unavailable', action: 'Place the chosen compatible Whisper model on this Mac and set CONTEXT_ROOM_WHISPER_MODEL to that regular readable file. No model is downloaded automatically.' });
  if (!speech) issues.push({ code: platform === 'darwin' ? 'speech-executable-missing' : 'speech-platform-unavailable', action: platform === 'darwin'
    ? 'Restore or explicitly configure the local macOS speech executable.' : 'Local speech playback generation requires macOS; no paid API is substituted.' });
  return { version: 1, localOnly: true, legacyRuntimeRequired: false, optional: true, model: { readable: model, state: modelReason, inferenceVerified: false },
    whisper: { executable: whisper }, speech: { executable: speech, platform }, transcriptionReadyForAttempt: whisper && model,
    synthesisReadyForAttempt: speech, acousticQualityVerified: false, issues };
}
