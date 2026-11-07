import { isNoiseSubtitleText } from './segmenter';

export interface DomCompanionCallbacks {
  onLiveCaptionChange: (originalText: string, cachedTranslation?: string) => void;
  onRequestTranslation: (
    originalText: string,
    contextBefore: string[],
  ) => void;
}

/**
 * Pure 0-extra-request DOM caption stabilizer & LRU cache for companion mode.
 * Coalesces rolling word-by-word ASR updates so we don't spam LLM requests on partial words.
 */
export class DomCaptionStabilizer {
  private readonly settleMs: number;
  private readonly maxWaitMs: number;
  private readonly cache = new Map<string, string>();
  private readonly recentHistory: string[] = [];

  private pendingText = '';
  private firstPendingAt = 0;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastEmittedOriginal = '';

  constructor(
    private readonly callbacks: DomCompanionCallbacks,
    options?: { settleMs?: number; maxWaitMs?: number },
  ) {
    this.settleMs = options?.settleMs ?? 240;
    this.maxWaitMs = options?.maxWaitMs ?? 1350;
  }

  observeRawText(rawText: string, nowMs = Date.now()): void {
    const cleaned = rawText.replace(/\s+/g, ' ').trim();
    if (!cleaned || isNoiseSubtitleText(cleaned)) {
      this.clearTimer();
      this.pendingText = '';
      if (this.lastEmittedOriginal !== '') {
        this.lastEmittedOriginal = '';
        this.callbacks.onLiveCaptionChange('');
      }
      return;
    }

    const cached = this.cache.get(cleaned);
    this.lastEmittedOriginal = cleaned;
    this.callbacks.onLiveCaptionChange(cleaned, cached);

    if (cached !== undefined) {
      this.clearTimer();
      this.pendingText = '';
      return;
    }

    // If completely identical to pending text, let current timer run
    if (cleaned === this.pendingText) return;

    const isPrefixGrowth =
      this.pendingText.length > 0 &&
      (cleaned.startsWith(this.pendingText) ||
        this.pendingText.startsWith(cleaned));

    if (!isPrefixGrowth && this.pendingText) {
      // Previous sentence finished immediately when player jumped to a brand-new sentence
      this.flushPending();
    }

    if (!this.pendingText) {
      this.firstPendingAt = nowMs;
    }
    this.pendingText = cleaned;

    if (nowMs - this.firstPendingAt >= this.maxWaitMs) {
      this.flushPending();
      return;
    }

    this.clearTimer();
    this.timerId = setTimeout(() => {
      this.flushPending();
    }, this.settleMs);
  }

  storeTranslation(originalText: string, translatedText: string): void {
    const key = originalText.replace(/\s+/g, ' ').trim();
    if (!key || !translatedText.trim()) return;

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= 400) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, translatedText.trim());

    if (this.lastEmittedOriginal === key) {
      this.callbacks.onLiveCaptionChange(key, translatedText.trim());
    }
  }

  getCached(originalText: string): string | undefined {
    return this.cache.get(originalText.replace(/\s+/g, ' ').trim());
  }

  reset(): void {
    this.clearTimer();
    this.pendingText = '';
    this.lastEmittedOriginal = '';
    this.recentHistory.length = 0;
  }

  private flushPending(): void {
    this.clearTimer();
    const target = this.pendingText;
    this.pendingText = '';
    this.firstPendingAt = 0;
    if (!target) return;

    if (this.cache.has(target)) {
      const cached = this.cache.get(target)!;
      if (this.lastEmittedOriginal === target) {
        this.callbacks.onLiveCaptionChange(target, cached);
      }
      return;
    }

    const contextBefore = this.recentHistory.slice(-2);
    if (this.recentHistory[this.recentHistory.length - 1] !== target) {
      this.recentHistory.push(target);
      if (this.recentHistory.length > 8) {
        this.recentHistory.shift();
      }
    }

    this.callbacks.onRequestTranslation(target, contextBefore);
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
