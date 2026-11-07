import type { SubtitleCue } from './types';

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function stripSubtitleMarkup(raw: string): string {
  const withoutAss = raw.replace(/\{\\[^}]*\}/g, '');
  // Unwrap WebVTT voice tags `<v Speaker>text</v>` -> `text` and strip other tags `<c.yellow>`, `<i>`, `<00:01.000>`
  const withoutTags = withoutAss
    .replace(/<v(?:\.[^>\s]+)*\s+[^>]*>/gi, '')
    .replace(/<\/?[a-zA-Z0-9._-]+(?:\s+[^>]*)?>/g, '')
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '');

  return decodeHtmlEntities(withoutTags)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Parses SRT/WebVTT timestamps (`00:01:02,340`, `01:02.340`, `1:02:03.5`) into milliseconds.
 */
export function parseSubtitleTimestampMs(raw: string): number | null {
  const clean = raw.trim();
  const match =
    /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(clean);
  if (!match) return null;

  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  const msStr = (match[4] ?? '0').padEnd(3, '0').slice(0, 3);
  const millis = Number.parseInt(msStr, 10);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }

  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
}

function parseTimingLine(
  line: string,
): { startMs: number; endMs: number } | null {
  const arrowIdx = line.indexOf('-->');
  if (arrowIdx < 0) return null;

  const left = line.slice(0, arrowIdx).trim();
  const rightTokens = line
    .slice(arrowIdx + 3)
    .trim()
    .split(/\s+/);
  const right = rightTokens[0] ?? '';

  const startMs = parseSubtitleTimestampMs(left);
  const endMs = parseSubtitleTimestampMs(right);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return null;
  }

  return { startMs, endMs };
}

/**
 * Parses a local `.srt` or `.vtt` subtitle file completely in memory into normalized `SubtitleCue[]`.
 */
export function parseLocalSubtitleFile(
  rawContent: string,
  _fileName?: string,
): SubtitleCue[] {
  const normalized = rawContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const rawCues: Array<{ startMs: number; endMs: number; text: string }> = [];
  let i = 0;

  // Skip optional WEBVTT header and metadata lines
  if (lines[0]?.trim().toUpperCase().startsWith('WEBVTT')) {
    i = 1;
    while (i < lines.length && lines[i]!.trim() !== '') {
      i++;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!.trim();

    if (!line) {
      i++;
      continue;
    }

    // Skip WebVTT NOTE / STYLE / REGION metadata blocks
    if (
      line.startsWith('NOTE') ||
      line === 'STYLE' ||
      line.startsWith('STYLE ') ||
      line === 'REGION' ||
      line.startsWith('REGION ')
    ) {
      i++;
      while (i < lines.length && lines[i]!.trim() !== '') {
        i++;
      }
      continue;
    }

    let timing = parseTimingLine(line);
    if (!timing && i + 1 < lines.length) {
      // Cue identifier or numeric SRT index line right before timing line
      const nextTiming = parseTimingLine(lines[i + 1]!.trim());
      if (nextTiming) {
        timing = nextTiming;
        i += 2;
      } else {
        i++;
        continue;
      }
    } else if (timing) {
      i++;
    } else {
      i++;
      continue;
    }

    const payloadLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      const curTrim = cur.trim();
      if (!curTrim) {
        i++;
        break;
      }
      // Guard against malformed files missing blank lines between cues
      if (parseTimingLine(curTrim)) {
        break;
      }
      if (
        /^\d+$/.test(curTrim) &&
        i + 1 < lines.length &&
        parseTimingLine(lines[i + 1]!.trim())
      ) {
        break;
      }
      payloadLines.push(cur);
      i++;
    }

    const cleanText = stripSubtitleMarkup(payloadLines.join('\n'));
    if (cleanText) {
      rawCues.push({
        startMs: timing.startMs,
        endMs: timing.endMs,
        text: cleanText,
      });
    }
  }

  rawCues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return rawCues.map((c, idx) => ({
    id: idx + 1,
    startMs: c.startMs,
    endMs: c.endMs,
    text: c.text,
    status: 'idle',
  }));
}

export function formatSubtitleOffset(offsetMs: number): string {
  if (!offsetMs) return '0.0s';
  const sec = (offsetMs / 1000).toFixed(1);
  return offsetMs > 0 ? `+${ sec }s` : `${ sec }s`;
}
