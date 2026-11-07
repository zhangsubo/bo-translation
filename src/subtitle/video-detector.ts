import { stripSubtitleMarkup } from './local-parser';
import type { SubtitleCue } from './types';

export const BO_FULLSCREEN_TRACK_LABEL = 'Bo Translation';

const AD_VIDEO_SELECTOR = [
  '.ad-showing',
  '.ad-interrupting',
  '.ytp-ad-player-overlay',
  '[data-ad-player]',
  '.ima-ad-container',
  '[class*="ad-player"]',
].join(', ');

function getVideoDimensions(video: HTMLVideoElement): {
  width: number;
  height: number;
  rect: DOMRect | null;
} {
  let rect: DOMRect | null = null;
  try {
    rect = video.getBoundingClientRect();
  } catch {
    rect = null;
  }

  const attrW = Number.parseFloat(video.getAttribute('width') ?? '');
  const attrH = Number.parseFloat(video.getAttribute('height') ?? '');
  const styleW = Number.parseFloat(video.style.width || '');
  const styleH = Number.parseFloat(video.style.height || '');

  const width =
    (rect && rect.width > 0 ? rect.width : 0) ||
    video.clientWidth ||
    video.videoWidth ||
    (Number.isFinite(styleW) ? styleW : 0) ||
    (Number.isFinite(attrW) ? attrW : 0);

  const height =
    (rect && rect.height > 0 ? rect.height : 0) ||
    video.clientHeight ||
    video.videoHeight ||
    (Number.isFinite(styleH) ? styleH : 0) ||
    (Number.isFinite(attrH) ? attrH : 0);

  return { width, height, rect };
}

export function isAdOrDecorativeTinyVideo(video: HTMLVideoElement): boolean {
  if (!video.isConnected) return true;

  try {
    if (video.closest(AD_VIDEO_SELECTOR)) return true;
  } catch {
    // ignore
  }

  const label = `${ video.getAttribute('title') ?? '' } ${ video.getAttribute('aria-label') ?? '' }`;
  if (/\badvertisement\b|广告/i.test(label)) {
    return true;
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(video);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        Number.parseFloat(cs.opacity || '1') === 0
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  const { width, height } = getVideoDimensions(video);
  if (width < 160 || height < 90) {
    return true;
  }

  return false;
}

/**
 * Ranks all `<video>` elements in `root` by area, viewport visibility, playback state, and track availability,
 * filtering out ad overlays and tiny `< 160x90` preview videos.
 */
export function rankCandidateVideos(
  root: ParentNode = document,
): HTMLVideoElement | null {
  const videos = Array.from(root.querySelectorAll('video'));
  if (videos.length === 0) return null;

  let bestVideo: HTMLVideoElement | null = null;
  let bestScore = -1;

  const vpW = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vpH = typeof window !== 'undefined' ? window.innerHeight : 0;

  for (const video of videos) {
    if (isAdOrDecorativeTinyVideo(video)) continue;

    const { width, height, rect } = getVideoDimensions(video);
    const area = width * height;
    if (area <= 0) continue;

    let visibilityRatio = 1;
    if (rect && rect.width > 0 && rect.height > 0 && vpW > 0 && vpH > 0) {
      const overlapX = Math.max(
        0,
        Math.min(rect.right, vpW) - Math.max(rect.left, 0),
      );
      const overlapY = Math.max(
        0,
        Math.min(rect.bottom, vpH) - Math.max(rect.top, 0),
      );
      visibilityRatio = (overlapX * overlapY) / (rect.width * rect.height);
      if (visibilityRatio < 0.05) {
        visibilityRatio = 0.05;
      }
    }

    const isPlaying = !video.paused && !video.ended;
    const hasTracksOrControls =
      video.controls ||
      (video.textTracks?.length ?? 0) > 0 ||
      video.querySelector('track') !== null;

    const score =
      area *
      visibilityRatio *
      (isPlaying ? 1.65 : 1) *
      (hasTracksOrControls ? 1.35 : 1);

    if (score > bestScore) {
      bestScore = score;
      bestVideo = video;
    }
  }

  return bestVideo;
}

/**
 * Distinguishes real interactive HTML5 video players from silent decorative hero background videos.
 */
export function isMeaningfulHtml5Player(video: HTMLVideoElement): boolean {
  if (isAdOrDecorativeTinyVideo(video)) return false;

  const hasNativeTracks =
    Array.from(video.textTracks ?? []).some(
      (t) => t.label !== BO_FULLSCREEN_TRACK_LABEL,
    ) || video.querySelector('track') !== null;

  // Silent looping background hero banner with no controls and no tracks -> skip
  if (video.loop && video.muted && !video.controls && !hasNativeTracks) {
    return false;
  }

  if (video.controls || hasNativeTracks) {
    return true;
  }

  return Boolean(
    video.closest(
      '.video-js, .plyr, .jwplayer, .dplayer, .artplayer-app, [data-player], [class*="video-player"], [class*="player-container"]',
    ),
  );
}

/**
 * Extracts cues from standard HTML5 `video.textTracks` (`<track kind="subtitles|captions">`).
 */
export function extractHtml5TextTrackCues(
  video: HTMLVideoElement,
): { lang: string; cues: SubtitleCue[] } | null {
  const trackList = video.textTracks;
  if (!trackList || trackList.length === 0) return null;

  const candidates: TextTrack[] = [];
  for (let i = 0; i < trackList.length; i++) {
    const track = trackList[i];
    if (!track) continue;
    if (track.label === BO_FULLSCREEN_TRACK_LABEL) continue;
    if (
      track.kind &&
      track.kind !== 'subtitles' &&
      track.kind !== 'captions'
    ) {
      continue;
    }
    candidates.push(track);
  }

  if (candidates.length === 0) return null;

  // Prefer 'showing', then 'hidden'; if a track is 'disabled', switch to 'hidden' so browser loads its cues
  candidates.sort((a, b) => {
    const rank = (m: TextTrackMode) =>
      m === 'showing' ? 0 : m === 'hidden' ? 1 : 2;
    return rank(a.mode) - rank(b.mode);
  });

  for (const track of candidates) {
    if (track.mode === 'disabled') {
      try {
        track.mode = 'hidden';
      } catch {
        // ignore
      }
    }
    const cueList = track.cues;
    if (!cueList || cueList.length === 0) continue;

    const extracted: SubtitleCue[] = [];
    for (let j = 0; j < cueList.length; j++) {
      const rawCue = cueList[j] as TextTrackCue & { text?: string };
      if (!rawCue) continue;
      const text = stripSubtitleMarkup(rawCue.text ?? '');
      if (!text) continue;
      const startMs = Math.max(0, Math.round(rawCue.startTime * 1000));
      const endMs = Math.max(startMs + 200, Math.round(rawCue.endTime * 1000));
      extracted.push({
        id: extracted.length + 1,
        startMs,
        endMs,
        text,
        status: 'idle',
      });
    }

    if (extracted.length > 0) {
      return {
        lang: track.language || '',
        cues: extracted,
      };
    }
  }

  return null;
}

function createVttCueInstance(
  startSec: number,
  endSec: number,
  text: string,
): TextTrackCue {
  if (typeof VTTCue === 'function') {
    return new VTTCue(startSec, endSec, text);
  }
  return {
    startTime: startSec,
    endTime: endSec,
    text,
    id: '',
    pauseOnExit: false,
    track: null,
     onenter: null,
    onexit: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as TextTrackCue;
}

/**
 * Fallback subtitle renderer for bare `<video>` native fullscreen (`document.fullscreenElement === video`),
 * where custom DOM overlays outside `<video>` are hidden behind the browser's top-layer.
 */
export class NativeFullscreenVttRenderer {
  private managedTracks = new WeakMap<HTMLVideoElement, TextTrack>();
  private mutedNativeTracks = new WeakMap<HTMLVideoElement, Set<TextTrack>>();
  private lastRenderedSignature = new WeakMap<HTMLVideoElement, string>();
  private activeVideo: HTMLVideoElement | null = null;

  isNativeVideoFullscreen(video: HTMLVideoElement | null): boolean {
    if (!video) return false;
    const doc = video.ownerDocument as Document & {
      webkitFullscreenElement?: Element | null;
    };
    const fsEl = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    return fsEl === video;
  }

  syncCue(
    video: HTMLVideoElement,
    cue: { startMs: number; endMs: number; text: string } | null,
    targetLang: string,
  ): void {
    if (this.activeVideo && this.activeVideo !== video) {
      this.deactivate(this.activeVideo);
    }
    this.activeVideo = video;

    // Mute duplicate native 'showing' tracks while our fullscreen track is active
    if (video.textTracks) {
      let mutedSet = this.mutedNativeTracks.get(video);
      if (!mutedSet) {
        mutedSet = new Set<TextTrack>();
        this.mutedNativeTracks.set(video, mutedSet);
      }
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (
          t &&
          t.label !== BO_FULLSCREEN_TRACK_LABEL &&
          t.mode === 'showing'
        ) {
          t.mode = 'hidden';
          mutedSet.add(t);
        }
      }
    }

    let track = this.managedTracks.get(video);
    if (!track && typeof video.addTextTrack === 'function') {
      track = video.addTextTrack(
        'subtitles',
        BO_FULLSCREEN_TRACK_LABEL,
        targetLang,
      );
      this.managedTracks.set(video, track);
    }
    if (!track) return;

    if (track.mode !== 'showing') {
      track.mode = 'showing';
    }

    const sig = cue ? `${ cue.startMs }:${ cue.endMs }:${ cue.text }` : '';
    if (this.lastRenderedSignature.get(video) === sig) {
      return;
    }
    this.lastRenderedSignature.set(video, sig);

    this.clearTrackCues(track);

    if (cue && cue.text.trim()) {
      const startSec = Math.max(0, cue.startMs / 1000);
      const endSec = Math.max(startSec + 0.25, cue.endMs / 1000);
      try {
        track.addCue(createVttCueInstance(startSec, endSec, cue.text));
      } catch {
        // ignore cue insertion errors
      }
    }
  }

  deactivate(video?: HTMLVideoElement | null): void {
    const target = video ?? this.activeVideo;
    if (!target) return;

    const track = this.managedTracks.get(target);
    if (track) {
      this.clearTrackCues(track);
      try {
        track.mode = 'disabled';
      } catch {
        // ignore
      }
    }
    this.lastRenderedSignature.delete(target);

    const mutedSet = this.mutedNativeTracks.get(target);
    if (mutedSet) {
      for (const nativeTrack of mutedSet) {
        try {
          nativeTrack.mode = 'showing';
        } catch {
          // ignore
        }
      }
      mutedSet.clear();
    }

    if (this.activeVideo === target) {
      this.activeVideo = null;
    }
  }

  private clearTrackCues(track: TextTrack): void {
    if (!track.cues) return;
    for (let i = track.cues.length - 1; i >= 0; i--) {
      const existing = track.cues[i];
      if (existing) {
        try {
          track.removeCue(existing);
        } catch {
          // ignore
        }
      }
    }
  }
}
