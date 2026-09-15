/** Monotonic per-send milestones; never prompt, source, credential or image data.
 * Provider-boundary waits include IPC/scheduling; they are not model inference.
 * Tool work is a sum and may overlap. Do not subtract it to infer provider time.
 */
const STAGES = new Set(['sourceAuthorized', 'queued', 'providerReady', 'threadReady', 'contextReady', 'dispatch',
  'turnStarted', 'firstProviderText', 'firstToolCall', 'firstMutation', 'firstDrawSegment', 'firstSavedText', 'terminal']);
export class AssistantTiming {
  constructor({ now = () => performance.now(), providerState = 'cold' } = {}) {
    this.now = now; this.started = now(); this.providerState = providerState; this.milestones = {}; this.toolWorkSumMs = 0;
  }
  mark(stage) {
    if (!STAGES.has(stage)) throw new Error('Unknown assistant timing milestone.');
    if (!Object.hasOwn(this.milestones, stage)) this.milestones[stage] = Math.max(0, this.now() - this.started);
  }
  addTool(ms) { if (Number.isFinite(ms) && ms >= 0) this.toolWorkSumMs += ms; }
  snapshot() {
    return { version: 1, clock: 'monotonic-elapsed-ms', providerState: this.providerState,
      milestones: { ...this.milestones }, toolWorkSumMs: this.toolWorkSumMs,
      inferenceTimeMeasured: false, displayTimeMeasured: false };
  }
}
