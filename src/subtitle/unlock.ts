export interface TapStepResult {
  count: number;
  remaining: number;
  state: 'counting' | 'hint' | 'ready';
}

export class VersionTapUnlocker {
  private count = 0;
  private lastTapAt = 0;
  private readonly requiredTaps: number;
  private readonly resetTimeoutMs: number;
  private readonly hintThreshold: number;

  constructor(options?: {
    requiredTaps?: number;
    resetTimeoutMs?: number;
    hintThreshold?: number;
  }) {
    this.requiredTaps = options?.requiredTaps ?? 20;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? 2500;
    this.hintThreshold = options?.hintThreshold ?? 15;
  }

  tap(nowMs = Date.now()): TapStepResult {
    if (this.lastTapAt > 0 && nowMs - this.lastTapAt > this.resetTimeoutMs) {
      this.count = 0;
    }
    this.lastTapAt = nowMs;
    this.count += 1;

    if (this.count >= this.requiredTaps) {
      const reached = this.count;
      this.count = 0;
      this.lastTapAt = 0;
      return {
        count: reached,
        remaining: 0,
        state: 'ready',
      };
    }

    const remaining = this.requiredTaps - this.count;
    return {
      count: this.count,
      remaining,
      state: this.count >= this.hintThreshold ? 'hint' : 'counting',
    };
  }

  reset(): void {
    this.count = 0;
    this.lastTapAt = 0;
  }
}
