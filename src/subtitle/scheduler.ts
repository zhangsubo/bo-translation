import type { BatchTranslateItem } from '../types';
import type { SubtitleCue } from './types';

export interface ScheduledBatchTask {
  requestId: string;
  cueIds: number[];
  minStartMs: number;
  maxEndMs: number;
  contextBefore: string[];
  items: BatchTranslateItem[];
}

export interface TimelineSchedulerHandlers {
  dispatchBatch: (task: ScheduledBatchTask) => void;
  cancelBatch: (requestId: string) => void;
  onActiveCueUpdated: (cue: SubtitleCue | null) => void;
}

/**
 * Binary search O(log n) to locate the active cue for a given playback timestamp in ms.
 */
export function findCueIndexAtTime(
  cues: SubtitleCue[],
  timeMs: number,
): number {
  const len = cues.length;
  if (len === 0) return -1;

  const first = cues[0]!;
  const last = cues[len - 1]!;
  if (timeMs < first.startMs || timeMs > last.endMs) {
    return -1;
  }

  let lo = 0;
  let hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid]!;
    if (timeMs >= cue.startMs && timeMs <= cue.endMs) {
      return mid;
    }
    if (timeMs < cue.startMs) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return -1;
}

/**
 * Three-zone lookahead subtitle translation scheduler:
 * 1. Immediate Fast Window (t ~ t+15s): small batch (up to 4 cues) for sub-500ms first subtitle latency.
 * 2. Lookahead Window (t+15s ~ t+pretranslateSeconds): standard batch (up to 8 cues) with contextBefore.
 * 3. Seek Cancellation: cancels out-of-window batches immediately when user scrubs the timeline.
 */
export class SubtitleTimelineScheduler {
  private cues: SubtitleCue[] = [];
  private activeCueIdx = -1;
  private inFlightTasks = new Map<string, ScheduledBatchTask>();
  private reqCounter = 0;
  private pretranslateSeconds: number;
  private readonly maxConcurrentBatches: number;

  constructor(
    private readonly handlers: TimelineSchedulerHandlers,
    options?: { pretranslateSeconds?: number; maxConcurrentBatches?: number },
  ) {
    this.pretranslateSeconds = options?.pretranslateSeconds ?? 60;
    this.maxConcurrentBatches = options?.maxConcurrentBatches ?? 2;
  }

  setCues(cues: SubtitleCue[]): void {
    this.cancelAllInFlight();
    this.cues = cues;
    this.activeCueIdx = -1;
  }

  getCues(): SubtitleCue[] {
    return this.cues;
  }

  setPretranslateSeconds(seconds: number): void {
    this.pretranslateSeconds = Math.max(15, Math.min(180, seconds));
  }

  /**
   * Called on `video.timeupdate`. Updates active cue in O(log n) and schedules lookahead batches.
   */
  tick(currentTimeMs: number, schedulePrefetch = true): SubtitleCue | null {
    const idx = findCueIndexAtTime(this.cues, currentTimeMs);
    if (idx !== this.activeCueIdx) {
      this.activeCueIdx = idx;
      this.handlers.onActiveCueUpdated(idx >= 0 ? (this.cues[idx] ?? null) : null);
    }

    if (schedulePrefetch) {
      this.scheduleLookahead(currentTimeMs);
    }

    return idx >= 0 ? (this.cues[idx] ?? null) : null;
  }

  /**
   * Called on `video.seeked` (debounced). Cancels stale far-away batches and prioritizes new window.
   */
  onSeek(newTimeMs: number): void {
    const keepMin = newTimeMs - 10_000;
    const keepMax = newTimeMs + (this.pretranslateSeconds + 25) * 1000;

    for (const [reqId, task] of this.inFlightTasks.entries()) {
      const overlapsWindow = task.maxEndMs >= keepMin && task.minStartMs <= keepMax;
      if (!overlapsWindow) {
        this.handlers.cancelBatch(reqId);
        for (const id of task.cueIds) {
          const cue = this.cues[id];
          if (cue && (cue.status === 'pending' || cue.status === 'streaming')) {
            cue.status = 'idle';
          }
        }
        this.inFlightTasks.delete(reqId);
      }
    }

    this.activeCueIdx = -1;
    this.tick(newTimeMs, true);
  }

  applyItemDelta(requestId: string, cueId: number, text: string): void {
    if (!this.inFlightTasks.has(requestId)) return;
    const cue = this.cues[cueId];
    if (!cue) return;
    cue.translation = text;
    cue.status = 'streaming';
    if (cueId === this.activeCueIdx) {
      this.handlers.onActiveCueUpdated(cue);
    }
  }

  applyItemDone(requestId: string, cueId: number, text: string): void {
    if (!this.inFlightTasks.has(requestId)) return;
    const cue = this.cues[cueId];
    if (!cue) return;
    cue.translation = text;
    cue.status = 'done';
    cue.error = undefined;
    if (cueId === this.activeCueIdx) {
      this.handlers.onActiveCueUpdated(cue);
    }
  }

  applyItemError(requestId: string, cueId: number, error: string): void {
    if (!this.inFlightTasks.has(requestId)) return;
    const cue = this.cues[cueId];
    if (!cue) return;
    cue.status = 'error';
    cue.error = error;
    if (cueId === this.activeCueIdx) {
      this.handlers.onActiveCueUpdated(cue);
    }
  }

  completeBatch(requestId: string, currentTimeMs?: number): void {
    const task = this.inFlightTasks.get(requestId);
    if (!task) return;
    this.inFlightTasks.delete(requestId);

    // Reset any cue that remained 'pending' without response so it can be retried if needed
    for (const id of task.cueIds) {
      const cue = this.cues[id];
      if (cue && cue.status === 'pending') {
        cue.status = 'error';
        cue.error = '未返回译文';
      }
    }

    if (typeof currentTimeMs === 'number') {
      this.scheduleLookahead(currentTimeMs);
    }
  }

  cancelAllInFlight(): void {
    for (const [reqId, task] of this.inFlightTasks.entries()) {
      this.handlers.cancelBatch(reqId);
      for (const id of task.cueIds) {
        const cue = this.cues[id];
        if (cue && (cue.status === 'pending' || cue.status === 'streaming')) {
          cue.status = 'idle';
        }
      }
    }
    this.inFlightTasks.clear();
  }

  private scheduleLookahead(currentTimeMs: number): void {
    if (this.cues.length === 0) return;
    if (this.inFlightTasks.size >= this.maxConcurrentBatches) return;

    const horizonEndMs = currentTimeMs + this.pretranslateSeconds * 1000;
    const fastHorizonEndMs = currentTimeMs + 15_000;

    // Binary search first cue whose endMs >= currentTimeMs
    let lo = 0;
    let hi = this.cues.length - 1;
    let startIdx = this.cues.length;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cues[mid]!.endMs >= currentTimeMs) {
        startIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    while (
      this.inFlightTasks.size < this.maxConcurrentBatches &&
      startIdx < this.cues.length
    ) {
      // Find first idle cue within horizon
      let batchFirstIdx = -1;
      for (let i = startIdx; i < this.cues.length; i++) {
        const c = this.cues[i]!;
        if (c.startMs > horizonEndMs) break;
        if (c.status === 'idle') {
          batchFirstIdx = i;
          break;
        }
      }

      if (batchFirstIdx === -1) break;

      const firstCue = this.cues[batchFirstIdx]!;
      const isUrgentFastWindow =
        this.inFlightTasks.size === 0 && firstCue.startMs <= fastHorizonEndMs;
      const maxBatchLen = isUrgentFastWindow ? 4 : 8;

      const batchCues: SubtitleCue[] = [];
      for (
        let i = batchFirstIdx;
        i < this.cues.length && batchCues.length < maxBatchLen;
        i++
      ) {
        const c = this.cues[i]!;
        if (c.startMs > horizonEndMs) break;
        if (c.status === 'idle') {
          c.status = 'pending';
          batchCues.push(c);
        } else if (batchCues.length > 0) {
          // Stop contiguous batch at already-translated or pending boundary
          break;
        }
      }

      if (batchCues.length === 0) break;

      const contextBefore: string[] = [];
      for (let k = Math.max(0, batchFirstIdx - 2); k < batchFirstIdx; k++) {
        const prevCue = this.cues[k];
        if (prevCue?.text) {
          contextBefore.push(prevCue.text);
        }
      }

      const requestId = `sub_req_${ ++this.reqCounter }_${ Date.now().toString(36) }`;
      const lastCue = batchCues[batchCues.length - 1]!;
      const task: ScheduledBatchTask = {
        requestId,
        cueIds: batchCues.map((c) => c.id),
        minStartMs: firstCue.startMs,
        maxEndMs: lastCue.endMs,
        contextBefore,
        items: batchCues.map((c) => ({
          id: c.id,
          text: c.text,
          plainText: c.text,
        })),
      };

      this.inFlightTasks.set(requestId, task);
      this.handlers.dispatchBatch(task);
      startIdx = lastCue.id + 1;
    }
  }
}
