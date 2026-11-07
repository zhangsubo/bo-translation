import type { TargetLanguageCode } from '../types';
import type { BilibiliBccItem, SubtitleCue } from './types';

interface WordToken {
  text: string;
  startMs: number;
  endMs: number;
}

const NOISE_CUE_RE =
  /^(\[?\s*(music|applause|laughter|silence|cheering|音乐|掌声|笑声)\s*\]?|[♪♫♬\s]+)$/i;

const TERMINAL_PUNCT_RE = /[.?!。？！…]+["')\]]*$/;
const CLAUSE_PUNCT_RE = /[,;:—–，；：]+$/;
const CLAUSE_BREAK_WORDS = new Set([
  'but',
  'because',
  'although',
  'though',
  'however',
  'therefore',
  'whereas',
  'while',
  'which',
]);

function decodeBasicEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanCueText(raw: string): string {
  return decodeBasicEntities(raw)
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isNoiseSubtitleText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return NOISE_CUE_RE.test(trimmed);
}

/**
 * Checks whether a subtitle track or sample cue text is already in the user's target language.
 */
export function isTrackAlreadyTargetLang(
  trackLang: string,
  sampleTexts: string[],
  targetLang: TargetLanguageCode,
): boolean {
  const normTrack = trackLang.trim().toLowerCase();
  const normTarget = targetLang.trim().toLowerCase();

  if (normTrack) {
    if (normTarget === 'zh-cn') {
      if (
        normTrack === 'zh' ||
        normTrack === 'zh-cn' ||
        normTrack === 'zh-hans' ||
        normTrack === 'ai-zh'
      ) {
        return true;
      }
    } else if (normTarget === 'zh-tw') {
      if (normTrack === 'zh-tw' || normTrack === 'zh-hant' || normTrack === 'zh-hk') {
        return true;
      }
    } else if (normTrack === normTarget || normTrack.startsWith(`${ normTarget }-`) || normTrack === `ai-${ normTarget }`) {
      return true;
    }
  }

  const joined = sampleTexts.slice(0, 12).join(' ').replace(/\s+/g, '');
  if (joined.length < 10) return false;

  if (normTarget.startsWith('zh')) {
    const hanMatches = joined.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const kanaMatches = joined.match(/[\u3040-\u30ff]/g)?.length ?? 0;
    return kanaMatches === 0 && hanMatches / joined.length > 0.45;
  }

  if (normTarget === 'en') {
    const asciiLetters = joined.match(/[a-zA-Z]/g)?.length ?? 0;
    return asciiLetters / joined.length > 0.78;
  }

  return false;
}

interface YtJson3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface YtJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  wWinId?: number;
  segs?: YtJson3Seg[];
}

/**
 * Heuristic sentence breaker for word-level YouTube ASR tokens.
 */
export function segmentWordTokensToCues(
  tokens: WordToken[],
  options?: {
    pauseGapMs?: number;
    softWordLimit?: number;
    hardWordLimit?: number;
    maxDurationMs?: number;
  },
): SubtitleCue[] {
  const pauseGapMs = options?.pauseGapMs ?? 600;
  const softWordLimit = options?.softWordLimit ?? 11;
  const hardWordLimit = options?.hardWordLimit ?? 18;
  const maxDurationMs = options?.maxDurationMs ?? 7500;

  const cues: SubtitleCue[] = [];
  let bucket: WordToken[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const joined = bucket
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+([,.?!:;])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    bucket = [];
    if (!joined || isNoiseSubtitleText(joined)) return;

    cues.push({
      id: cues.length,
      startMs: first.startMs,
      endMs: Math.max(first.startMs + 400, last.endMs),
      text: joined,
      status: 'idle',
    });
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const prev = bucket[bucket.length - 1];

    if (prev && tok.startMs - prev.endMs >= pauseGapMs) {
      flushBucket();
    }

    const bucketFirst = bucket[0];
    if (
      bucketFirst &&
      bucket.length >= softWordLimit &&
      CLAUSE_BREAK_WORDS.has(tok.text.toLowerCase())
    ) {
      flushBucket();
    }

    bucket.push(tok);

    const activeFirst = bucket[0]!;
    const durationSoFar = tok.endMs - activeFirst.startMs;

    if (
      TERMINAL_PUNCT_RE.test(tok.text) ||
      bucket.length >= hardWordLimit ||
      durationSoFar >= maxDurationMs ||
      (bucket.length >= softWordLimit && CLAUSE_PUNCT_RE.test(tok.text))
    ) {
      flushBucket();
    }
  }

  flushBucket();

  // Clamp any slight overlap with the next cue's startMs
  for (let i = 0; i < cues.length - 1; i++) {
    const curr = cues[i]!;
    const next = cues[i + 1]!;
    if (curr.endMs > next.startMs) {
      curr.endMs = next.startMs;
    }
  }

  return cues;
}

/**
 * Parses YouTube timedtext response (supports JSON3 and XML/SRV3 fallback).
 */
export function parseYouTubeTimedText(
  rawBody: string,
  kind = '',
): SubtitleCue[] {
  const trimmed = rawBody.trim();
  if (!trimmed) return [];

  // 1. JSON3 format
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { events?: YtJson3Event[] };
      const events = Array.isArray(parsed.events) ? parsed.events : [];
      if (events.length === 0) return [];

      const hasRollingAsr =
        kind === 'asr' ||
        events.some(
          (ev) =>
            ev.aAppend === 1 ||
            (Array.isArray(ev.segs) &&
              ev.segs.length > 1 &&
              ev.segs.some((s) => (s.tOffsetMs ?? 0) > 0)),
        );

      if (hasRollingAsr) {
        const wordTokens: WordToken[] = [];
        for (let i = 0; i < events.length; i++) {
          const ev = events[i]!;
          if (typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) {
            continue;
          }
          const baseStart = ev.tStartMs;
          const evEnd = baseStart + (ev.dDurationMs ?? 2000);

          for (let j = 0; j < ev.segs.length; j++) {
            const seg = ev.segs[j]!;
            const rawWord = (seg.utf8 ?? '').replace(/\r?\n/g, ' ').trim();
            if (!rawWord) continue;
            const startMs = baseStart + (seg.tOffsetMs ?? 0);
            const nextSeg = ev.segs[j + 1];
            const endMs = nextSeg
              ? baseStart + (nextSeg.tOffsetMs ?? 0)
              : Math.min(evEnd, startMs + 900);

            for (const part of rawWord.split(/\s+/)) {
              if (!part) continue;
              wordTokens.push({
                text: decodeBasicEntities(part),
                startMs,
                endMs: Math.max(startMs + 120, endMs),
              });
            }
          }
        }
        return segmentWordTokensToCues(wordTokens);
      }

      // Human-curated cue events
      const cues: SubtitleCue[] = [];
      for (const ev of events) {
        if (typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) {
          continue;
        }
        const text = cleanCueText(ev.segs.map((s) => s.utf8 ?? '').join(''));
        if (!text || isNoiseSubtitleText(text)) continue;
        const startMs = ev.tStartMs;
        const endMs = startMs + Math.max(400, ev.dDurationMs ?? 2000);
        cues.push({
          id: cues.length,
          startMs,
          endMs,
          text,
          status: 'idle',
        });
      }
      for (let i = 0; i < cues.length - 1; i++) {
        const curr = cues[i]!;
        const next = cues[i + 1]!;
        if (curr.endMs > next.startMs) curr.endMs = next.startMs;
      }
      return cues;
    } catch {
      return [];
    }
  }

  // 2. XML (<transcript><text start="1.2" dur="3.4"> or SRV3 <p t="1200" d="3400">)
  if (trimmed.startsWith('<')) {
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(trimmed, 'text/xml');
      const pNodes = Array.from(xml.querySelectorAll('p[t]'));
      const cues: SubtitleCue[] = [];

      if (pNodes.length > 0) {
        for (const p of pNodes) {
          const startMs = Number(p.getAttribute('t') ?? '0');
          const durMs = Number(p.getAttribute('d') ?? '2000');
          const text = cleanCueText(p.textContent ?? '');
          if (!text || isNoiseSubtitleText(text)) continue;
          cues.push({
            id: cues.length,
            startMs,
            endMs: startMs + Math.max(400, durMs),
            text,
            status: 'idle',
          });
        }
      } else {
        const textNodes = Array.from(xml.querySelectorAll('text[start]'));
        for (const tNode of textNodes) {
          const startMs = Math.round(Number(tNode.getAttribute('start') ?? '0') * 1000);
          const durMs = Math.round(Number(tNode.getAttribute('dur') ?? '2') * 1000);
          const text = cleanCueText(tNode.textContent ?? '');
          if (!text || isNoiseSubtitleText(text)) continue;
          cues.push({
            id: cues.length,
            startMs,
            endMs: startMs + Math.max(400, durMs),
            text,
            status: 'idle',
          });
        }
      }

      for (let i = 0; i < cues.length - 1; i++) {
        const curr = cues[i]!;
        const next = cues[i + 1]!;
        if (curr.endMs > next.startMs) curr.endMs = next.startMs;
      }
      return cues;
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Parses Bilibili BCC JSON format `{ body: [{ from, to, content }] }`.
 */
export function parseBilibiliBccSubtitles(rawJsonOrObj: string | { body?: BilibiliBccItem[] }): SubtitleCue[] {
  let body: BilibiliBccItem[] = [];
  if (typeof rawJsonOrObj === 'string') {
    try {
      const parsed = JSON.parse(rawJsonOrObj) as { body?: BilibiliBccItem[] };
      body = Array.isArray(parsed.body) ? parsed.body : [];
    } catch {
      return [];
    }
  } else if (Array.isArray(rawJsonOrObj.body)) {
    body = rawJsonOrObj.body;
  }

  const cues: SubtitleCue[] = [];
  for (const item of body) {
    if (typeof item.from !== 'number' || typeof item.to !== 'number') continue;
    const text = cleanCueText(item.content ?? '');
    if (!text || isNoiseSubtitleText(text)) continue;
    const startMs = Math.round(item.from * 1000);
    const endMs = Math.max(startMs + 300, Math.round(item.to * 1000));
    cues.push({
      id: cues.length,
      startMs,
      endMs,
      text,
      status: 'idle',
    });
  }
  return cues;
}

/**
 * Aligns a native target-language track onto a foreign-language subtitle track using temporal overlap.
 */
export function alignDualSubtitleTracks(
  sourceCues: SubtitleCue[],
  targetCues: SubtitleCue[],
): SubtitleCue[] {
  if (targetCues.length === 0) return sourceCues;

  let targetPtr = 0;
  return sourceCues.map((src) => {
    while (
      targetPtr < targetCues.length &&
      targetCues[targetPtr]!.endMs <= src.startMs
    ) {
      targetPtr++;
    }

    const matchedParts: string[] = [];
    for (let j = targetPtr; j < targetCues.length; j++) {
      const tgt = targetCues[j]!;
      if (tgt.startMs >= src.endMs) break;

      const overlapStart = Math.max(src.startMs, tgt.startMs);
      const overlapEnd = Math.min(src.endMs, tgt.endMs);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const minDur = Math.max(1, Math.min(src.endMs - src.startMs, tgt.endMs - tgt.startMs));

      if (overlap / minDur >= 0.4) {
        matchedParts.push(tgt.text);
      }
    }

    if (matchedParts.length === 0) {
      return src;
    }

    return {
      ...src,
      translation: matchedParts.join(' '),
      status: 'done',
    };
  });
}
