import { describe, expect, it, vi } from 'vitest';
import {
  detectVideoPlatform,
  extractVideoSessionKey,
  extractYouTubeVideoId,
} from '../entrypoints/content/subtitle/SubtitleController';
import { normalizeSettings } from '../src/storage';
import { DomCaptionStabilizer } from '../src/subtitle/dom-companion';
import {
  findCueIndexAtTime,
  SubtitleTimelineScheduler,
  type ScheduledBatchTask,
} from '../src/subtitle/scheduler';
import {
  alignDualSubtitleTracks,
  isTrackAlreadyTargetLang,
  parseBilibiliBccSubtitles,
  parseYouTubeTimedText,
} from '../src/subtitle/segmenter';
import type { SubtitleCue } from '../src/subtitle/types';
import { VersionTapUnlocker } from '../src/subtitle/unlock';

describe('Milestone 4: Video Subtitle Architecture & 20-Tap Hidden Unlock', () => {
  it('enforces 20-tap unlock state machine with 15-19 hint and >2.5s timeout reset', () => {
    const unlocker = new VersionTapUnlocker({
      requiredTaps: 20,
      resetTimeoutMs: 2500,
      hintThreshold: 15,
    });

    let now = 10_000;
    for (let i = 1; i <= 14; i++) {
      now += 180;
      const step = unlocker.tap(now);
      expect(step.state).toBe('counting');
      expect(step.count).toBe(i);
    }

    for (let i = 15; i <= 19; i++) {
      now += 180;
      const step = unlocker.tap(now);
      expect(step.state).toBe('hint');
      expect(step.remaining).toBe(20 - i);
    }

    // Timeout > 2500ms resets counter back to 1
    now += 3000;
    const afterPause = unlocker.tap(now);
    expect(afterPause.state).toBe('counting');
    expect(afterPause.count).toBe(1);

    // Complete remaining 19 taps to reach 20
    for (let i = 2; i <= 19; i++) {
      now += 120;
      unlocker.tap(now);
    }
    now += 120;
    const unlocked = unlocker.tap(now);
    expect(unlocked.state).toBe('ready');
    expect(unlocked.count).toBe(20);
    expect(unlocked.remaining).toBe(0);
  });

  it('enforces storage lock invariant: enableActiveTimelineFetch cannot be true when locked', () => {
    const locked = normalizeSettings({
      videoSubtitle: {
        advancedTimelineUnlocked: false,
        enableActiveTimelineFetch: true,
      } as never,
    });
    expect(locked.videoSubtitle.advancedTimelineUnlocked).toBe(false);
    expect(locked.videoSubtitle.enableActiveTimelineFetch).toBe(false);

    const unlocked = normalizeSettings({
      videoSubtitle: {
        advancedTimelineUnlocked: true,
        enableActiveTimelineFetch: true,
      } as never,
    });
    expect(unlocked.videoSubtitle.advancedTimelineUnlocked).toBe(true);
    expect(unlocked.videoSubtitle.enableActiveTimelineFetch).toBe(true);
  });

  it('parses YouTube human JSON3 and segments rolling ASR word tokens into natural sentences', () => {
    const humanJson3 = JSON.stringify({
      events: [
        { tStartMs: 500, dDurationMs: 1200, segs: [{ utf8: '[Music]' }] },
        {
          tStartMs: 2000,
          dDurationMs: 2500,
          segs: [{ utf8: 'Welcome back\nto the channel.' }],
        },
        {
          tStartMs: 4200,
          dDurationMs: 2200,
          segs: [{ utf8: 'Today we test subtitles.' }],
        },
      ],
    });
    const humanCues = parseYouTubeTimedText(humanJson3, '');
    expect(humanCues).toHaveLength(2);
    expect(humanCues[0]?.text).toBe('Welcome back to the channel.');
    // Clamped slight overlap with next cue startMs
    expect(humanCues[0]?.endMs).toBe(4200);
    expect(humanCues[1]?.text).toBe('Today we test subtitles.');

    const asrJson3 = JSON.stringify({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 3000,
          segs: [
            { utf8: 'First', tOffsetMs: 0 },
            { utf8: 'sentence', tOffsetMs: 300 },
            { utf8: 'ends.', tOffsetMs: 650 },
            { utf8: 'Second', tOffsetMs: 1500 },
            { utf8: 'clause', tOffsetMs: 1800 },
          ],
        },
        {
          tStartMs: 4000,
          dDurationMs: 1500,
          aAppend: 1,
          segs: [{ utf8: 'continues!', tOffsetMs: 100 }],
        },
      ],
    });

    const asrCues = parseYouTubeTimedText(asrJson3, 'asr');
    expect(asrCues.map((c) => c.text)).toEqual([
      'First sentence ends.',
      'Second clause continues!',
    ]);
  });

  it('parses Bilibili BCC subtitles, detects target language, and aligns dual subtitle tracks', () => {
    const enBcc = {
      body: [
        { from: 1.0, to: 3.5, content: 'Compilers optimize hot loops.' },
        { from: 4.0, to: 6.5, content: 'Memory layout matters.' },
      ],
    };
    const zhBcc = {
      body: [{ from: 1.1, to: 3.4, content: '编译器会优化热点循环。' }],
    };

    const enCues = parseBilibiliBccSubtitles(enBcc);
    const zhCues = parseBilibiliBccSubtitles(zhBcc);

    expect(
      isTrackAlreadyTargetLang('en-US', enCues.map((c) => c.text), 'zh-CN'),
    ).toBe(false);
    expect(
      isTrackAlreadyTargetLang('zh-CN', zhCues.map((c) => c.text), 'zh-CN'),
    ).toBe(true);

    const aligned = alignDualSubtitleTracks(enCues, zhCues);
    expect(aligned[0]?.status).toBe('done');
    expect(aligned[0]?.translation).toBe('编译器会优化热点循环。');
    // Second cue had no native Chinese match so it stays idle for LLM scheduler
    expect(aligned[1]?.status).toBe('idle');
    expect(aligned[1]?.translation).toBeUndefined();
  });

  it('coalesces rolling DOM captions in 0-request companion mode and hits LRU cache', () => {
    vi.useFakeTimers();
    try {
      const liveUpdates: Array<{ orig: string; cached?: string }> = [];
      const requests: Array<{ orig: string; ctx: string[] }> = [];

      const stabilizer = new DomCaptionStabilizer(
        {
          onLiveCaptionChange: (orig, cached) => {
            liveUpdates.push({ orig, cached });
          },
          onRequestTranslation: (orig, ctx) => {
            requests.push({ orig, ctx });
          },
        },
        { settleMs: 240, maxWaitMs: 1350 },
      );

      stabilizer.observeRawText('we', 100);
      vi.advanceTimersByTime(100);
      stabilizer.observeRawText('we are', 200);
      vi.advanceTimersByTime(100);
      stabilizer.observeRawText('we are live', 300);

      // Should not have fired LLM request yet while word-by-word prefix grows
      expect(requests).toHaveLength(0);

      vi.advanceTimersByTime(250);
      expect(requests).toEqual([{ orig: 'we are live', ctx: [] }]);

      stabilizer.storeTranslation('we are live', '我们正在直播');

      // Re-observing the same caption hits cache immediately with 0 extra requests
      stabilizer.observeRawText('we are live', 900);
      expect(requests).toHaveLength(1);
      expect(liveUpdates[liveUpdates.length - 1]).toEqual({
        orig: 'we are live',
        cached: '我们正在直播',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules urgent 4-cue fast batch + 8-cue lookahead batch and cancels stale batches on seek', () => {
    const cues: SubtitleCue[] = Array.from({ length: 20 }, (_, idx) => ({
      id: idx,
      startMs: idx * 4000,
      endMs: idx * 4000 + 3500,
      text: `Line ${idx}`,
      status: 'idle',
    }));

    expect(findCueIndexAtTime(cues, 8500)).toBe(2);
    expect(findCueIndexAtTime(cues, 3800)).toBe(-1);

    const dispatched: ScheduledBatchTask[] = [];
    const cancelled: string[] = [];
    let activeCue: SubtitleCue | null = null;

    const scheduler = new SubtitleTimelineScheduler(
      {
        dispatchBatch: (task) => dispatched.push(task),
        cancelBatch: (reqId) => cancelled.push(reqId),
        onActiveCueUpdated: (cue) => {
          activeCue = cue;
        },
      },
      { pretranslateSeconds: 60, maxConcurrentBatches: 2 },
    );

    scheduler.setCues(cues);
    scheduler.tick(1000, true);

    expect(activeCue).toMatchObject({ id: 0, text: 'Line 0' });
    // Batch 1: urgent fast window (4 cues: 0..3)
    // Batch 2: lookahead window (8 cues: 4..11) with contextBefore ['Line 2', 'Line 3']
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.cueIds).toEqual([0, 1, 2, 3]);
    expect(dispatched[1]?.cueIds).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(dispatched[1]?.contextBefore).toEqual(['Line 2', 'Line 3']);

    // Scrub far ahead to 72s (cue 18): both batches [0..15.5s] and [16s..47.5s] are outside [62s..157s]
    scheduler.onSeek(72_000);
    expect(cancelled).toHaveLength(2);
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2]?.cueIds).toEqual([18, 19]);
  });

  it('detects YouTube and Bilibili platforms and session keys accurately', () => {
    expect(detectVideoPlatform('www.youtube.com')).toBe('youtube');
    expect(detectVideoPlatform('www.bilibili.com')).toBe('bilibili');
    expect(detectVideoPlatform('developer.mozilla.org')).toBeNull();

    expect(
      extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s'),
    ).toBe('dQw4w9WgXcQ');
    expect(
      extractVideoSessionKey(
        'https://www.bilibili.com/video/BV1xx411c7mD/?p=2',
        'bilibili',
      ),
    ).toBe('bili:/video/BV1xx411c7mD|p=2|bvid=');
  });
});
