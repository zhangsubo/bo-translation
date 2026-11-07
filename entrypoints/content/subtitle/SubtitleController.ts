import { updateSettings } from '../../../src/storage';
import { consumeRuntimeLastError } from '../../../src/utils/runtime';
import { DomCaptionStabilizer } from '../../../src/subtitle/dom-companion';
import {
  formatSubtitleOffset,
  parseLocalSubtitleFile,
} from '../../../src/subtitle/local-parser';
import {
  SubtitleTimelineScheduler,
  type ScheduledBatchTask,
} from '../../../src/subtitle/scheduler';
import {
  alignDualSubtitleTracks,
  isTrackAlreadyTargetLang,
  parseBilibiliBccSubtitles,
  parseYouTubeTimedText,
} from '../../../src/subtitle/segmenter';
import {
  SUBTITLE_BRIDGE_SOURCE_ISO,
  SUBTITLE_BRIDGE_SOURCE_MAIN,
  type BilibiliSubtitleTrackInfo,
  type SubtitleCue,
  type SubtitleIsoCommandMessage,
  type SubtitleMainBridgeMessage,
  type VideoPlatform,
} from '../../../src/subtitle/types';
import {
  extractHtml5TextTrackCues,
  isMeaningfulHtml5Player,
  NativeFullscreenVttRenderer,
  rankCandidateVideos,
} from '../../../src/subtitle/video-detector';
import {
  STREAM_PORT_NAME,
  type ExtensionSettings,
  type StreamPortClientMessage,
  type StreamPortServerMessage,
  type SubtitleDisplayMode,
  type SubtitleDisplayOrder,
} from '../../../src/types';
import { BO_SUBTITLE_HOST_TAG } from '../dom/rules';

const SUBTITLE_STYLE_ID = 'bo-trans-subtitle-styles';

export function detectVideoPlatform(hostname: string): VideoPlatform | null {
  const clean = hostname.trim().toLowerCase();
  if (clean === 'youtube.com' || clean.endsWith('.youtube.com')) {
    return 'youtube';
  }
  if (clean === 'bilibili.com' || clean.endsWith('.bilibili.com')) {
    return 'bilibili';
  }
  return null;
}

export function extractYouTubeVideoId(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const v = u.searchParams.get('v');
    if (v) return v;
    const pathMatch = /^\/(?:embed|live|shorts|v)\/([a-zA-Z0-9_-]{6,})/.exec(
      u.pathname,
    );
    return pathMatch?.[1] ?? '';
  } catch {
    return '';
  }
}

export function extractVideoSessionKey(
  urlStr: string,
  platform: VideoPlatform,
): string {
  try {
    const u = new URL(urlStr);
    if (platform === 'youtube') {
      const vid = extractYouTubeVideoId(urlStr);
      return vid ? `yt:${vid}` : '';
    }
    if (platform === 'html5') {
      return `html5:${u.origin}${u.pathname}${u.search}`;
    }
    const path = u.pathname.replace(/\/+$/, '');
    if (
      !path.startsWith('/video/') &&
      !path.startsWith('/bangumi/play/') &&
      !path.startsWith('/list/')
    ) {
      return '';
    }
    const p = u.searchParams.get('p') ?? '1';
    const bvid = u.searchParams.get('bvid') ?? '';
    return `bili:${path}|p=${p}|bvid=${bvid}`;
  } catch {
    return '';
  }
}

function normalizeUrlPathname(rawUrl: string): string {
  try {
    const full = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    return new URL(full, 'https://aisubtitle.hdslb.com').pathname;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

function cloneCues(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.map((c) => ({ ...c }));
}

export function ensureSubtitleStyleSheet(doc: Document = document): void {
  if (doc.getElementById(SUBTITLE_STYLE_ID)) return;

  const styleEl = doc.createElement('style');
  styleEl.id = SUBTITLE_STYLE_ID;
  styleEl.textContent = `
/* Hide native captions visually while keeping DOM updates alive for 0-request companion mode */
.bo-sub-hide-native .ytp-caption-window-container,
.bo-sub-hide-native .bpx-player-subtitle-wrap,
.bo-sub-hide-native .bilibili-player-video-subtitle {
  opacity: 0 !important;
  pointer-events: none !important;
}

bo-subtitle-overlay {
  position: absolute;
  inset: 0;
  z-index: 68;
  pointer-events: none;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  user-select: text;
  -webkit-user-select: text;
}

bo-subtitle-overlay[data-hidden="true"] {
  display: none !important;
}

bo-subtitle-overlay .bo-sub-stage {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--bo-sub-bottom, 9%);
  max-width: min(86%, 920px);
  width: max-content;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transition: bottom 0.16s ease-out;
}

bo-subtitle-overlay[data-ctrl-visible="true"] .bo-sub-stage {
  bottom: max(var(--bo-sub-bottom, 9%), 68px);
}

bo-subtitle-overlay[data-dragging="true"] .bo-sub-stage {
  transition: none !important;
}

bo-subtitle-overlay .bo-sub-cue-box {
  pointer-events: auto;
  position: relative;
  padding: 7px 15px 8px 15px;
  border-radius: 10px;
  background: rgba(12, 15, 22, var(--bo-sub-bg-alpha, 0.72));
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.36);
  border: 1px solid rgba(255, 255, 255, 0.09);
  text-align: center;
  line-height: 1.44;
  color: #f8fafc;
  max-width: 100%;
  word-break: break-word;
}

bo-subtitle-overlay .bo-sub-drag-handle {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 30px;
  height: 5px;
  border-radius: 999px;
  cursor: ns-resize;
  opacity: 0;
  transition: opacity 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

bo-subtitle-overlay .bo-sub-drag-handle::after {
  content: "";
  width: 20px;
  height: 2.5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.45);
}

bo-subtitle-overlay .bo-sub-cue-box:hover .bo-sub-drag-handle {
  opacity: 1;
}

bo-subtitle-overlay .bo-sub-line-orig {
  margin: 0;
  font-size: calc(clamp(14px, 1.85vw, 21px) * var(--bo-sub-font-scale, 1));
  font-weight: 500;
  color: rgba(241, 245, 249, 0.94);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  cursor: text;
}

bo-subtitle-overlay .bo-sub-line-trans {
  margin: 3px 0 0 0;
  font-size: calc(clamp(15px, 2.05vw, 23px) * var(--bo-sub-font-scale, 1));
  font-weight: 600;
  color: #fde047;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
  transition: filter 0.18s ease, opacity 0.16s ease;
  cursor: text;
}

bo-subtitle-overlay[data-order="translation-first"] .bo-sub-line-trans {
  margin: 0 0 3px 0;
}

bo-subtitle-overlay .bo-sub-line-trans[data-streaming="true"] {
  opacity: 0.88;
}

bo-subtitle-overlay[data-blur-trans="true"] .bo-sub-line-trans {
  filter: blur(6px);
}

bo-subtitle-overlay[data-blur-trans="true"] .bo-sub-cue-box:hover .bo-sub-line-trans {
  filter: none;
}

bo-subtitle-overlay .bo-sub-hint-pill {
  pointer-events: auto;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.82);
  border: 1px solid rgba(148, 163, 184, 0.28);
  color: #e2e8f0;
  font-size: 12.5px;
  line-height: 1.35;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
}

/* Player Control Bar Button */
.bo-sub-ctrl-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  vertical-align: top;
  margin: 0 4px;
  user-select: none;
  position: relative;
  z-index: 12;
}

.bo-sub-ctrl-pill {
  display: inline-flex;
  align-items: center;
  height: 26px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #ffffff;
  overflow: hidden;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.bo-sub-ctrl-pill:hover {
  background: rgba(255, 255, 255, 0.24);
}

.bo-sub-ctrl-pill[data-active="true"] {
  background: rgba(37, 99, 235, 0.88);
  border-color: rgba(96, 165, 250, 0.8);
}

.bo-sub-ctrl-pill[data-active="true"]:hover {
  background: rgba(29, 78, 216, 0.95);
}

.bo-sub-toggle-btn,
.bo-sub-caret-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  height: 100%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  font-family: inherit;
}

.bo-sub-caret-btn {
  padding: 0 5px;
  border-left: 1px solid rgba(255, 255, 255, 0.18);
  font-size: 10px;
  opacity: 0.88;
}

.bo-sub-caret-btn:hover {
  background: rgba(0, 0, 0, 0.16);
  opacity: 1;
}

/* Quick Settings Popover inside Overlay */
bo-subtitle-overlay .bo-sub-menu-panel {
  pointer-events: auto;
  position: absolute;
  width: 268px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.95);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(148, 163, 184, 0.24);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.52);
  color: #f1f5f9;
  font-size: 12.5px;
  z-index: 88;
  user-select: none;
}

bo-subtitle-overlay .bo-sub-menu-panel[hidden] {
  display: none !important;
}

bo-subtitle-overlay .bo-sub-menu-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
}

bo-subtitle-overlay .bo-sub-menu-title {
  font-weight: 600;
  font-size: 13px;
  color: #f8fafc;
}

bo-subtitle-overlay .bo-sub-status-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.2);
  color: #93c5fd;
  border: 1px solid rgba(59, 130, 246, 0.35);
}

bo-subtitle-overlay .bo-sub-menu-sec {
  margin-bottom: 9px;
}

bo-subtitle-overlay .bo-sub-menu-lbl {
  display: block;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 5px;
}

bo-subtitle-overlay .bo-sub-seg-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  background: rgba(30, 41, 59, 0.8);
  padding: 3px;
  border-radius: 7px;
}

bo-subtitle-overlay .bo-sub-seg-row[data-cols="2"] {
  grid-template-columns: repeat(2, 1fr);
}

bo-subtitle-overlay .bo-sub-seg-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: #cbd5e1;
  font-size: 11.5px;
  padding: 4px 2px;
  border-radius: 5px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.12s ease, color 0.12s ease;
}

bo-subtitle-overlay .bo-sub-seg-btn:hover {
  color: #ffffff;
}

bo-subtitle-overlay .bo-sub-seg-btn[data-selected="true"] {
  background: #2563eb;
  color: #ffffff;
  font-weight: 600;
}

bo-subtitle-overlay .bo-sub-select {
  width: 100%;
  background: rgba(30, 41, 59, 0.9);
  color: #f1f5f9;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  outline: none;
}

bo-subtitle-overlay .bo-sub-chk-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  cursor: pointer;
  color: #e2e8f0;
  font-size: 12px;
}

bo-subtitle-overlay .bo-sub-chk-row input[type="checkbox"] {
  accent-color: #2563eb;
  width: 14px;
  height: 14px;
  cursor: pointer;
}

/* Local .srt/.vtt mount & +-0.5s timeline offset controls */
bo-subtitle-overlay .bo-sub-action-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

bo-subtitle-overlay .bo-sub-action-btn {
  appearance: none;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(30, 41, 59, 0.9);
  color: #e2e8f0;
  font-size: 11.5px;
  font-weight: 500;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  flex: 1;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background 0.12s ease, border-color 0.12s ease;
}

bo-subtitle-overlay .bo-sub-action-btn:hover {
  background: rgba(51, 65, 85, 0.95);
  border-color: rgba(96, 165, 250, 0.55);
  color: #ffffff;
}

bo-subtitle-overlay .bo-sub-action-btn[data-danger="true"] {
  flex: 0 0 auto;
  color: #fca5a5;
  border-color: rgba(248, 113, 113, 0.32);
}

bo-subtitle-overlay .bo-sub-offset-row {
  display: grid;
  grid-template-columns: 1fr 1.1fr 1fr;
  gap: 5px;
}

bo-subtitle-overlay .bo-sub-offset-val {
  appearance: none;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.75);
  color: #93c5fd;
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 4px 4px;
  border-radius: 6px;
  cursor: pointer;
  text-align: center;
}

/* Generic HTML5 player floating top-right subtitle pill */
.bo-sub-ctrl-wrap.bo-sub-floating-ctrl {
  position: absolute;
  top: 12px;
  right: 12px;
  height: auto;
  margin: 0;
  z-index: 75;
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: auto;
}

[data-bo-html5-player="true"]:hover .bo-sub-ctrl-wrap.bo-sub-floating-ctrl,
.bo-sub-ctrl-wrap.bo-sub-floating-ctrl[data-menu-open="true"],
.bo-sub-ctrl-wrap.bo-sub-floating-ctrl:focus-within {
  opacity: 0.95;
}
`;

  (doc.head ?? doc.documentElement).appendChild(styleEl);
}

export class SubtitleController {
  private readonly platform: VideoPlatform;
  private settings: ExtensionSettings;
  private mode: SubtitleDisplayMode;
  private lastActiveMode: Exclude<SubtitleDisplayMode, 'off'> = 'bilingual';

  private port: chrome.runtime.Port | null = null;
  private readonly scheduler: SubtitleTimelineScheduler;
  private readonly domStabilizer: DomCaptionStabilizer;
  private readonly fullscreenVtt = new NativeFullscreenVttRenderer();

  private currentSessionKey = '';
  private timelineSource:
    | 'none'
    | 'passive-mirror'
    | 'active-prefetch'
    | 'html5-track'
    | 'local-file' = 'none';
  private activePrefetchRequestedKey = '';

  // Mirrored / HTML5 / Local raw tracks per video session
  private ytForeignCues: SubtitleCue[] | null = null;
  private ytTargetCues: SubtitleCue[] | null = null;
  private biliMetaCid = '';
  private biliTracks: BilibiliSubtitleTrackInfo[] = [];
  private biliForeignCues: SubtitleCue[] | null = null;
  private biliTargetCues: SubtitleCue[] | null = null;
  private html5ForeignCues: SubtitleCue[] | null = null;
  private html5TargetCues: SubtitleCue[] | null = null;
  private localImportedCues: SubtitleCue[] | null = null;
  private localImportedName = '';
  private subtitleOffsetMs = 0;

  // Active cue / companion display state
  private activeTimelineCue: SubtitleCue | null = null;
  private companionOriginal = '';
  private companionTranslated = '';
  private companionStreaming = false;
  private companionInFlight = new Map<string, string>(); // requestId -> originalText
  private companionReqSeq = 0;

  // Player DOM references
  private playerContainer: HTMLElement | null = null;
  private overlayMountTarget: HTMLElement | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private controlsRightEl: HTMLElement | null = null;

  private overlayHost: HTMLElement | null = null;
  private stageEl: HTMLDivElement | null = null;
  private cueBoxEl: HTMLDivElement | null = null;
  private hintPillEl: HTMLDivElement | null = null;
  private menuPanelEl: HTMLDivElement | null = null;
  private ctrlWrapEl: HTMLDivElement | null = null;
  private toggleBtnEl: HTMLButtonElement | null = null;
  private pillEl: HTMLDivElement | null = null;
  private fileInputEl: HTMLInputElement | null = null;

  private menuOpen = false;
  private autoPausedByHover = false;
  private isCueHovered = false;
  private isDraggingPosition = false;
  private activatedAtMs = 0;

  private captionMutationObserver: MutationObserver | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initialSettings: ExtensionSettings) {
    const detected = detectVideoPlatform(window.location.hostname);
    this.platform = detected ?? 'html5';
    this.settings = initialSettings;
    this.mode =
      detected && initialSettings.videoSubtitle.enabledByDefault
        ? 'bilingual'
        : 'off';

    this.scheduler = new SubtitleTimelineScheduler(
      {
        dispatchBatch: (task) => this.dispatchTimelineBatch(task),
        cancelBatch: (requestId) => this.postPortMessage({ type: 'CANCEL_REQUEST', requestId }),
        onActiveCueUpdated: (cue) => {
          this.activeTimelineCue = cue;
          this.renderOverlay();
        },
      },
      {
        pretranslateSeconds: initialSettings.videoSubtitle.pretranslateSeconds,
        maxConcurrentBatches: 2,
      },
    );

    this.domStabilizer = new DomCaptionStabilizer({
      onLiveCaptionChange: (orig, cachedTrans) => {
        this.companionOriginal = orig;
        if (!orig) {
          this.companionTranslated = '';
          this.companionStreaming = false;
        } else if (cachedTrans !== undefined) {
          this.companionTranslated = cachedTrans;
          this.companionStreaming = false;
        } else if (
          isTrackAlreadyTargetLang('', [orig], this.settings.targetLang)
        ) {
          this.companionTranslated = orig;
          this.companionStreaming = false;
        }
        this.renderOverlay();
      },
      onRequestTranslation: (orig, contextBefore) => {
        if (this.mode === 'off' || this.mode === 'original-only') return;
        if (this.scheduler.getCues().length > 0) return;
        if (isTrackAlreadyTargetLang('', [orig], this.settings.targetLang)) {
          this.domStabilizer.storeTranslation(orig, orig);
          return;
        }
        this.dispatchCompanionTranslation(orig, contextBefore);
      },
    });
  }

  init(): void {
    if (this.platform !== 'html5') {
      ensureSubtitleStyleSheet(document);
    }
    window.addEventListener('message', this.handleWindowMessage);
    window.addEventListener('yt-navigate-finish', this.handleRouteCheck);
    window.addEventListener('popstate', this.handleRouteCheck);
    document.addEventListener('pointerdown', this.handleGlobalPointerDown, true);
    document.addEventListener('selectionchange', this.handleSelectionChange);
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    document.addEventListener(
      'webkitfullscreenchange',
      this.handleFullscreenChange,
    );
    window.addEventListener('pagehide', () => {
      if (this.port) {
        const activePort = this.port;
        this.port = null;
        this.companionInFlight.clear();
        try {
          activePort.disconnect();
        } catch {
          // ignore already closed port
        }
      }
    });

    this.handleRouteCheck();
    this.syncPlayerDom();

    if (this.platform === 'youtube' || this.platform === 'bilibili') {
      // Replay any early responses mirrored at document_start with zero extra network calls
      this.postCommandToMain({
        source: SUBTITLE_BRIDGE_SOURCE_ISO,
        type: 'SYNC_MIRROR_CACHE',
      });
    }

    this.pollTimer = setInterval(() => {
      if (
        this.platform === 'html5' &&
        document.getElementsByTagName('video').length === 0
      ) {
        return;
      }
      this.handleRouteCheck();
      this.syncPlayerDom();
      this.renderOverlay();
    }, 900);
  }

  updateSettings(next: ExtensionSettings): void {
    const prevServiceId = this.settings.videoSubtitle.subtitleServiceId;
    const prevTargetLang = this.settings.targetLang;
    const prevPreferNative = this.settings.videoSubtitle.preferNativeBilingual;
    const prevActiveFetch =
      this.settings.videoSubtitle.advancedTimelineUnlocked &&
      this.settings.videoSubtitle.enableActiveTimelineFetch;

    this.settings = next;
    this.scheduler.setPretranslateSeconds(next.videoSubtitle.pretranslateSeconds);

    const nextActiveFetch =
      next.videoSubtitle.advancedTimelineUnlocked &&
      next.videoSubtitle.enableActiveTimelineFetch;

    if (prevPreferNative !== next.videoSubtitle.preferNativeBilingual) {
      this.rebuildEffectiveTimeline();
    } else if (
      prevServiceId !== next.videoSubtitle.subtitleServiceId ||
      prevTargetLang !== next.targetLang
    ) {
      this.domStabilizer.reset();
      if (this.scheduler.getCues().length > 0) {
        this.rebuildEffectiveTimeline();
      }
    }

    if (!prevActiveFetch && nextActiveFetch && this.mode !== 'off') {
      this.maybeTriggerUnlockedActiveTimelineLoad();
    }

    this.renderMenuPanel();
    this.renderOverlay();
  }

  private ensurePort(): chrome.runtime.Port | null {
    if (this.port) return this.port;
    try {
      const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
      port.onMessage.addListener((msg: StreamPortServerMessage) => {
        this.handlePortMessage(msg);
      });
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        this.port = null;
      });
      this.port = port;
      return port;
    } catch {
      this.port = null;
      return null;
    }
  }

  private postPortMessage(msg: StreamPortClientMessage): void {
    const port = this.ensurePort();
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch {
      this.port = null;
    }
  }

  private handlePortMessage(msg: StreamPortServerMessage): void {
    if (!msg || typeof msg !== 'object') return;

    // 1. Check if this belongs to DOM companion mode
    if ('requestId' in msg && this.companionInFlight.has(msg.requestId)) {
      const origText = this.companionInFlight.get(msg.requestId)!;
      if (msg.type === 'ITEM_DELTA') {
        if (this.companionOriginal === origText) {
          this.companionTranslated = msg.fullText;
          this.companionStreaming = true;
          this.renderOverlay();
        }
        return;
      }
      if (msg.type === 'ITEM_DONE') {
        this.companionStreaming = false;
        this.domStabilizer.storeTranslation(origText, msg.fullText);
        this.renderOverlay();
        return;
      }
      if (msg.type === 'ITEM_ERROR') {
        if (this.companionOriginal === origText) {
          this.companionStreaming = false;
          this.companionTranslated = `⚠️ ${msg.error}`;
          this.renderOverlay();
        }
        return;
      }
      if (msg.type === 'BATCH_COMPLETE') {
        this.companionInFlight.delete(msg.requestId);
        return;
      }
    }

    // 2. Forward to Timeline Scheduler
    if (msg.type === 'ITEM_DELTA') {
      this.scheduler.applyItemDelta(msg.requestId, msg.id, msg.fullText);
    } else if (msg.type === 'ITEM_DONE') {
      this.scheduler.applyItemDone(msg.requestId, msg.id, msg.fullText);
    } else if (msg.type === 'ITEM_ERROR') {
      this.scheduler.applyItemError(msg.requestId, msg.id, msg.error);
    } else if (msg.type === 'BATCH_COMPLETE') {
      this.scheduler.completeBatch(
        msg.requestId,
        this.shouldScheduleTranslation() ? this.getVideoTimeMs() : undefined,
      );
    }
  }

  private dispatchTimelineBatch(task: ScheduledBatchTask): void {
    const serviceOverride = this.settings.videoSubtitle.subtitleServiceId;
    this.postPortMessage({
      type: 'TRANSLATE_BATCH',
      requestId: task.requestId,
      serviceId:
        serviceOverride && serviceOverride !== 'follow-primary'
          ? serviceOverride
          : undefined,
      docTitle: document.title,
      sourceLang: this.settings.sourceLang,
      targetLang: this.settings.targetLang,
      isSubtitle: true,
      contextBefore: task.contextBefore,
      items: task.items,
    });
  }

  private dispatchCompanionTranslation(
    origText: string,
    contextBefore: string[],
  ): void {
    // Bound concurrent companion requests to 2
    while (this.companionInFlight.size >= 2) {
      const oldestReqId = this.companionInFlight.keys().next().value;
      if (!oldestReqId) break;
      this.postPortMessage({ type: 'CANCEL_REQUEST', requestId: oldestReqId });
      this.companionInFlight.delete(oldestReqId);
    }

    const requestId = `sub_comp_${++this.companionReqSeq}_${Date.now().toString(36)}`;
    this.companionInFlight.set(requestId, origText);
    this.companionStreaming = true;
    this.renderOverlay();

    const serviceOverride = this.settings.videoSubtitle.subtitleServiceId;
    this.postPortMessage({
      type: 'TRANSLATE_BATCH',
      requestId,
      serviceId:
        serviceOverride && serviceOverride !== 'follow-primary'
          ? serviceOverride
          : undefined,
      docTitle: document.title,
      sourceLang: this.settings.sourceLang,
      targetLang: this.settings.targetLang,
      isSubtitle: true,
      contextBefore,
      items: [{ id: 0, text: origText, plainText: origText }],
    });
  }

  private postCommandToMain(cmd: SubtitleIsoCommandMessage): void {
    window.postMessage(cmd, '*');
  }

  private maybeTriggerUnlockedActiveTimelineLoad(): void {
    if (
      (this.platform !== 'youtube' && this.platform !== 'bilibili') ||
      !this.currentSessionKey
    ) {
      return;
    }
    if (this.mode === 'off') return;
    if (this.localImportedCues && this.localImportedCues.length > 0) return;
    // STRICT COMPLIANCE GATE: NEVER send active load command unless BOTH unlocked (20 taps) AND enabled
    if (
      !this.settings.videoSubtitle.advancedTimelineUnlocked ||
      !this.settings.videoSubtitle.enableActiveTimelineFetch
    ) {
      return;
    }
    if (this.scheduler.getCues().length > 0) return;
    if (this.activePrefetchRequestedKey === this.currentSessionKey) return;

    this.activePrefetchRequestedKey = this.currentSessionKey;
    this.timelineSource = 'active-prefetch';

    if (this.platform === 'youtube') {
      this.postCommandToMain({
        source: SUBTITLE_BRIDGE_SOURCE_ISO,
        type: 'YT_ACTIVE_LOAD_TIMELINE',
        targetLang: this.settings.targetLang,
      });
    } else {
      this.postCommandToMain({
        source: SUBTITLE_BRIDGE_SOURCE_ISO,
        type: 'BILI_ACTIVE_LOAD_TIMELINE',
        preferNativeBilingual: this.settings.videoSubtitle.preferNativeBilingual,
        targetLang: this.settings.targetLang,
      });
    }
  }

  private readonly handleWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const msg = event.data as SubtitleMainBridgeMessage | undefined;
    if (!msg || msg.source !== SUBTITLE_BRIDGE_SOURCE_MAIN) return;

    if (msg.type === 'YT_TIMEDTEXT_MIRROR' && this.platform === 'youtube') {
      const currentVid = extractYouTubeVideoId(window.location.href);
      if (!currentVid || msg.videoId !== currentVid) return;

      const parsed = parseYouTubeTimedText(msg.body, msg.kind);
      if (parsed.length === 0) return;

      const sampleTexts = parsed.slice(0, 12).map((c) => c.text);
      const isAlreadyTarget = isTrackAlreadyTargetLang(
        msg.lang,
        sampleTexts,
        this.settings.targetLang,
      );

      if (isAlreadyTarget) {
        this.ytTargetCues = parsed;
      } else {
        this.ytForeignCues = parsed;
      }

      if (this.timelineSource === 'none') {
        this.timelineSource = 'passive-mirror';
      }
      this.rebuildEffectiveTimeline();
      return;
    }

    if (msg.type === 'BILI_PLAYER_META_MIRROR' && this.platform === 'bilibili') {
      if (msg.cid && this.biliMetaCid && msg.cid !== this.biliMetaCid) {
        // Switched multi-part episode cid cleanly
        this.biliForeignCues = null;
        this.biliTargetCues = null;
        if (!this.localImportedCues) {
          this.scheduler.setCues([]);
        }
      }
      this.biliMetaCid = msg.cid;
      this.biliTracks = msg.subtitles;
      return;
    }

    if (msg.type === 'BILI_BCC_MIRROR' && this.platform === 'bilibili') {
      const parsed = parseBilibiliBccSubtitles(msg.body);
      if (parsed.length === 0) return;

      const mirrorPath = normalizeUrlPathname(msg.url);
      const matchedTrack = this.biliTracks.find(
        (t) => normalizeUrlPathname(t.subtitle_url) === mirrorPath,
      );
      const sampleTexts = parsed.slice(0, 12).map((c) => c.text);
      const isAlreadyTarget = isTrackAlreadyTargetLang(
        matchedTrack?.lan ?? '',
        sampleTexts,
        this.settings.targetLang,
      );

      if (isAlreadyTarget) {
        this.biliTargetCues = parsed;
      } else {
        this.biliForeignCues = parsed;
      }

      if (this.timelineSource === 'none') {
        this.timelineSource = 'passive-mirror';
      }
      this.rebuildEffectiveTimeline();
    }
  };

  loadLocalSubtitleContent(rawContent: string, fileName = 'local.srt'): number {
    const parsed = parseLocalSubtitleFile(rawContent, fileName);
    if (parsed.length === 0) {
      return 0;
    }
    this.localImportedCues = parsed;
    this.localImportedName = fileName;
    this.subtitleOffsetMs = 0;
    this.timelineSource = 'local-file';

    if (this.mode === 'off') {
      this.setMode('bilingual');
    }
    this.rebuildEffectiveTimeline();
    return parsed.length;
  }

  clearLocalSubtitle(): void {
    this.localImportedCues = null;
    this.localImportedName = '';
    this.subtitleOffsetMs = 0;

    if (this.platform === 'html5') {
      this.timelineSource =
        this.html5ForeignCues || this.html5TargetCues ? 'html5-track' : 'none';
    } else if (
      this.ytForeignCues ||
      this.ytTargetCues ||
      this.biliForeignCues ||
      this.biliTargetCues
    ) {
      this.timelineSource = 'passive-mirror';
    } else {
      this.timelineSource = 'none';
    }

    this.rebuildEffectiveTimeline();
  }

  adjustSubtitleOffset(deltaMs: number): void {
    this.subtitleOffsetMs = Math.max(
      -30_000,
      Math.min(30_000, this.subtitleOffsetMs + deltaMs),
    );
    if (this.scheduler.getCues().length > 0 && this.mode !== 'off') {
      this.scheduler.tick(
        this.getVideoTimeMs(),
        this.shouldScheduleTranslation(),
      );
    }
    this.renderMenuPanel();
    this.renderOverlay();
  }

  resetSubtitleOffset(): void {
    this.subtitleOffsetMs = 0;
    if (this.scheduler.getCues().length > 0 && this.mode !== 'off') {
      this.scheduler.tick(
        this.getVideoTimeMs(),
        this.shouldScheduleTranslation(),
      );
    }
    this.renderMenuPanel();
    this.renderOverlay();
  }

  getSubtitleOffsetMs(): number {
    return this.subtitleOffsetMs;
  }

  private rebuildEffectiveTimeline(): void {
    let effective: SubtitleCue[] = [];

    if (this.localImportedCues && this.localImportedCues.length > 0) {
      this.timelineSource = 'local-file';
      const sampleTexts = this.localImportedCues
        .slice(0, 12)
        .map((c) => c.text);
      const alreadyTarget = isTrackAlreadyTargetLang(
        '',
        sampleTexts,
        this.settings.targetLang,
      );
      effective = alreadyTarget
        ? this.localImportedCues.map((c) => ({
            ...c,
            translation: c.text,
            status: 'done',
          }))
        : cloneCues(this.localImportedCues);
    } else {
      const foreign =
        this.platform === 'youtube'
          ? this.ytForeignCues
          : this.platform === 'bilibili'
            ? this.biliForeignCues
            : this.html5ForeignCues;
      const target =
        this.platform === 'youtube'
          ? this.ytTargetCues
          : this.platform === 'bilibili'
            ? this.biliTargetCues
            : this.html5TargetCues;

      if (foreign && foreign.length > 0) {
        const base = cloneCues(foreign);
        if (
          target &&
          target.length > 0 &&
          this.settings.videoSubtitle.preferNativeBilingual
        ) {
          effective = alignDualSubtitleTracks(base, target);
        } else {
          effective = base;
        }
      } else if (target && target.length > 0) {
        // Video only has native target-language captions — render directly with 0 LLM calls
        effective = target.map((c) => ({
          ...c,
          translation: c.text,
          status: 'done',
        }));
      }
    }

    this.scheduler.setCues(effective);
    if (effective.length > 0 && this.mode !== 'off') {
      this.scheduler.tick(
        this.getVideoTimeMs(),
        this.shouldScheduleTranslation(),
      );
    }
    this.renderMenuPanel();
    this.renderOverlay();
  }

  private readonly handleRouteCheck = (): void => {
    const nextKey = extractVideoSessionKey(window.location.href, this.platform);
    if (nextKey === this.currentSessionKey) return;

    this.currentSessionKey = nextKey;
    this.resetSessionState();

    if (nextKey && this.mode !== 'off') {
      this.activatedAtMs = Date.now();
      this.maybeTriggerUnlockedActiveTimelineLoad();
    }
  };

  private resetSessionState(): void {
    this.scheduler.setCues([]);
    this.domStabilizer.reset();
    this.fullscreenVtt.deactivate(this.videoEl);
    for (const reqId of this.companionInFlight.keys()) {
      this.postPortMessage({ type: 'CANCEL_REQUEST', requestId: reqId });
    }
    this.companionInFlight.clear();

    this.timelineSource = 'none';
    this.activePrefetchRequestedKey = '';
    this.ytForeignCues = null;
    this.ytTargetCues = null;
    this.biliMetaCid = '';
    this.biliTracks = [];
    this.biliForeignCues = null;
    this.biliTargetCues = null;
    this.html5ForeignCues = null;
    this.html5TargetCues = null;
    this.localImportedCues = null;
    this.localImportedName = '';
    this.subtitleOffsetMs = 0;
    this.activeTimelineCue = null;
    this.companionOriginal = '';
    this.companionTranslated = '';
    this.companionStreaming = false;
    this.autoPausedByHover = false;
    this.menuOpen = false;
    this.renderOverlay();
  }

  private syncHtml5TextTracks(): void {
    if (!this.videoEl || this.localImportedCues) return;
    if (
      this.platform !== 'html5' &&
      (this.ytForeignCues ||
        this.ytTargetCues ||
        this.biliForeignCues ||
        this.biliTargetCues)
    ) {
      return;
    }

    const extracted = extractHtml5TextTrackCues(this.videoEl);
    if (!extracted || extracted.cues.length === 0) return;

    const currentCount =
      (this.html5ForeignCues?.length ?? 0) + (this.html5TargetCues?.length ?? 0);
    if (currentCount === extracted.cues.length) {
      return;
    }

    const sampleTexts = extracted.cues.slice(0, 12).map((c) => c.text);
    const isAlreadyTarget = isTrackAlreadyTargetLang(
      extracted.lang,
      sampleTexts,
      this.settings.targetLang,
    );

    if (isAlreadyTarget) {
      this.html5TargetCues = extracted.cues;
      this.html5ForeignCues = null;
    } else {
      this.html5ForeignCues = extracted.cues;
      this.html5TargetCues = null;
    }

    if (this.timelineSource === 'none') {
      this.timelineSource = 'html5-track';
    }
    this.rebuildEffectiveTimeline();
  }

  private syncPlayerDom(): void {
    let nextPlayer: HTMLElement | null = null;
    let nextMountTarget: HTMLElement | null = null;
    let nextVideo: HTMLVideoElement | null = null;
    let nextControlsRight: HTMLElement | null = null;

    if (this.platform === 'youtube') {
      nextPlayer = document.querySelector<HTMLElement>(
        '#movie_player.html5-video-player, .html5-video-player',
      );
      if (!nextPlayer) return;
      nextMountTarget = nextPlayer;
      nextVideo =
        rankCandidateVideos(nextPlayer) ??
        nextPlayer.querySelector<HTMLVideoElement>(
          'video.html5-main-video, video',
        );
      nextControlsRight =
        nextPlayer.querySelector<HTMLElement>('.ytp-right-controls');
    } else if (this.platform === 'bilibili') {
      nextPlayer = document.querySelector<HTMLElement>(
        '.bpx-player-container, #bilibili-player',
      );
      if (!nextPlayer) return;
      nextMountTarget =
        nextPlayer.querySelector<HTMLElement>('.bpx-player-video-area') ??
        nextPlayer;
      nextVideo =
        rankCandidateVideos(nextPlayer) ??
        nextPlayer.querySelector<HTMLVideoElement>(
          '.bpx-player-video-wrap video, video',
        );
      nextControlsRight = nextPlayer.querySelector<HTMLElement>(
        '.bpx-player-control-bottom-right, .squirtle-controller-wrap-right',
      );
    } else {
      const ranked = rankCandidateVideos(document);
      if (!ranked || !isMeaningfulHtml5Player(ranked)) return;

      const container =
        ranked.closest<HTMLElement>(
          '.video-js, .plyr, .jwplayer, .dplayer, .artplayer-app, [data-player], [class*="video-player"], [class*="player-container"]',
        ) ?? ranked.parentElement;

      if (
        !container ||
        container === document.body ||
        container === document.documentElement
      ) {
        return;
      }

      ensureSubtitleStyleSheet(document);
      container.setAttribute('data-bo-html5-player', 'true');
      if (
        typeof window !== 'undefined' &&
        typeof window.getComputedStyle === 'function'
      ) {
        try {
          if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
          }
        } catch {
          // ignore
        }
      }

      nextPlayer = container;
      nextMountTarget = container;
      nextVideo = ranked;
      nextControlsRight = null;
    }

    if (nextPlayer !== this.playerContainer) {
      this.detachCaptionObserver();
      this.playerContainer = nextPlayer;
      if (this.platform !== 'html5') {
        this.attachCaptionObserver(nextPlayer);
      }
    }

    if (nextVideo !== this.videoEl) {
      this.fullscreenVtt.deactivate(this.videoEl);
      this.unbindVideoListeners();
      this.videoEl = nextVideo;
      this.bindVideoListeners();
    }

    if (this.platform === 'html5' && this.videoEl) {
      this.syncHtml5TextTracks();
    }

    if (
      nextMountTarget !== this.overlayMountTarget ||
      !this.overlayHost ||
      !this.overlayHost.isConnected
    ) {
      this.overlayMountTarget = nextMountTarget;
      this.mountOverlayDom(nextMountTarget);
    }

    if (nextControlsRight) {
      if (
        nextControlsRight !== this.controlsRightEl ||
        !this.ctrlWrapEl ||
        !this.ctrlWrapEl.isConnected
      ) {
        this.controlsRightEl = nextControlsRight;
        this.mountControlBarButton(nextControlsRight, false);
      }
    } else if (
      this.platform === 'html5' &&
      nextMountTarget &&
      (!this.ctrlWrapEl || !this.ctrlWrapEl.isConnected)
    ) {
      this.controlsRightEl = nextMountTarget;
      this.mountControlBarButton(nextMountTarget, true);
    }

    this.syncNativeCaptionVisibility();
  }

  private readonly handleTextTracksChange = (): void => {
    this.syncHtml5TextTracks();
  };

  private readonly handleFullscreenChange = (): void => {
    if (!this.fullscreenVtt.isNativeVideoFullscreen(this.videoEl)) {
      this.fullscreenVtt.deactivate(this.videoEl);
    }
    this.renderOverlay();
  };

  private bindVideoListeners(): void {
    if (!this.videoEl) return;
    this.videoEl.addEventListener('timeupdate', this.handleVideoTimeUpdate);
    this.videoEl.addEventListener('seeked', this.handleVideoSeeked);
    this.videoEl.addEventListener('play', this.handleVideoManualPlay);
    this.videoEl.addEventListener('loadedmetadata', this.handleTextTracksChange);
    this.videoEl.textTracks?.addEventListener?.(
      'change',
      this.handleTextTracksChange,
    );
    this.videoEl.textTracks?.addEventListener?.(
      'addtrack',
      this.handleTextTracksChange,
    );
  }

  private unbindVideoListeners(): void {
    if (!this.videoEl) return;
    this.videoEl.removeEventListener('timeupdate', this.handleVideoTimeUpdate);
    this.videoEl.removeEventListener('seeked', this.handleVideoSeeked);
    this.videoEl.removeEventListener('play', this.handleVideoManualPlay);
    this.videoEl.removeEventListener(
      'loadedmetadata',
      this.handleTextTracksChange,
    );
    this.videoEl.textTracks?.removeEventListener?.(
      'change',
      this.handleTextTracksChange,
    );
    this.videoEl.textTracks?.removeEventListener?.(
      'addtrack',
      this.handleTextTracksChange,
    );
  }

  private readonly handleVideoTimeUpdate = (): void => {
    if (this.platform === 'html5' && !this.localImportedCues && !this.html5ForeignCues && !this.html5TargetCues) {
      this.syncHtml5TextTracks();
    }
    if (this.mode === 'off' || this.isAdPlaying()) return;
    if (this.scheduler.getCues().length > 0) {
      this.scheduler.tick(
        this.getVideoTimeMs(),
        this.shouldScheduleTranslation(),
      );
    }
  };

  private readonly handleVideoSeeked = (): void => {
    if (this.mode === 'off' || this.isAdPlaying()) return;
    if (this.scheduler.getCues().length === 0) return;

    if (this.seekDebounceTimer !== null) {
      clearTimeout(this.seekDebounceTimer);
    }
    this.seekDebounceTimer = setTimeout(() => {
      this.seekDebounceTimer = null;
      if (this.mode !== 'off' && !this.isAdPlaying()) {
        this.scheduler.onSeek(this.getVideoTimeMs());
      }
    }, 180);
  };

  private readonly handleVideoManualPlay = (): void => {
    if (!this.isCueHovered) {
      this.autoPausedByHover = false;
    }
  };

  private attachCaptionObserver(container: HTMLElement): void {
    this.captionMutationObserver = new MutationObserver((records) => {
      if (this.mode === 'off') return;
      if (this.scheduler.getCues().length > 0) return;
      if (this.isAdPlaying()) return;

      // Ignore our own overlay / control button mutations
      const hasExternalMutation = records.some((rec) => {
        if (!(rec.target instanceof Element)) return true;
        return (
          !rec.target.closest(BO_SUBTITLE_HOST_TAG) &&
          !rec.target.closest('.bo-sub-ctrl-wrap')
        );
      });
      if (!hasExternalMutation) return;

      this.sampleNativeDomCaption();
    });

    this.captionMutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private detachCaptionObserver(): void {
    if (this.captionMutationObserver) {
      this.captionMutationObserver.disconnect();
      this.captionMutationObserver = null;
    }
  }

  private sampleNativeDomCaption(): void {
    if (!this.playerContainer || this.platform === 'html5') return;

    let rawText = '';
    if (this.platform === 'youtube') {
      const segs = this.playerContainer.querySelectorAll<HTMLElement>(
        '.ytp-caption-window-container .ytp-caption-segment',
      );
      if (segs.length > 0) {
        rawText = Array.from(segs)
          .map((s) => s.textContent ?? '')
          .join(' ');
      }
    } else {
      const nodes = this.playerContainer.querySelectorAll<HTMLElement>(
        '.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle .subtitle-item-text',
      );
      if (nodes.length > 0) {
        rawText = Array.from(nodes)
          .map((n) => n.textContent ?? '')
          .join(' ');
      }
    }

    this.domStabilizer.observeRawText(rawText);
  }

  private mountOverlayDom(mountTarget: HTMLElement): void {
    if (this.overlayHost && this.overlayHost.parentElement === mountTarget) {
      return;
    }

    for (const stale of Array.from(
      mountTarget.querySelectorAll(BO_SUBTITLE_HOST_TAG),
    )) {
      stale.remove();
    }

    const host = document.createElement(BO_SUBTITLE_HOST_TAG);
    host.className = 'notranslate';
    host.setAttribute('translate', 'no');

    const stage = document.createElement('div');
    stage.className = 'bo-sub-stage';

    const cueBox = document.createElement('div');
    cueBox.className = 'bo-sub-cue-box';
    cueBox.setAttribute('data-bo-subtitle-cue', 'true');
    cueBox.hidden = true;

    const dragHandle = document.createElement('div');
    dragHandle.className = 'bo-sub-drag-handle';
    dragHandle.title = '上下拖拽调整字幕高度';
    dragHandle.addEventListener('pointerdown', this.handleDragStart);

    const origLine = document.createElement('p');
    origLine.className = 'bo-sub-line-orig';
    origLine.setAttribute('data-bo-subtitle-orig', 'true');

    const transLine = document.createElement('p');
    transLine.className = 'bo-sub-line-trans';
    transLine.setAttribute('data-bo-subtitle-trans', 'true');

    cueBox.append(dragHandle, origLine, transLine);
    cueBox.addEventListener('pointerenter', this.handleCuePointerEnter);
    cueBox.addEventListener('pointerleave', this.handleCuePointerLeave);
    // Prevent player click-to-toggle-play when selecting words inside subtitle box
    cueBox.addEventListener('click', (e) => e.stopPropagation());
    cueBox.addEventListener('dblclick', (e) => e.stopPropagation());

    const hintPill = document.createElement('div');
    hintPill.className = 'bo-sub-hint-pill';
    hintPill.hidden = true;

    stage.append(cueBox, hintPill);

    const menuPanel = document.createElement('div');
    menuPanel.className = 'bo-sub-menu-panel';
    menuPanel.hidden = true;
    menuPanel.addEventListener('click', (e) => e.stopPropagation());
    menuPanel.addEventListener('dblclick', (e) => e.stopPropagation());

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.srt,.vtt';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then((content) => {
        this.loadLocalSubtitleContent(content, file.name);
        fileInput.value = '';
      });
    });

    host.append(stage, menuPanel, fileInput);
    mountTarget.appendChild(host);

    this.overlayHost = host;
    this.stageEl = stage;
    this.cueBoxEl = cueBox;
    this.hintPillEl = hintPill;
    this.menuPanelEl = menuPanel;
    this.fileInputEl = fileInput;

    this.renderMenuPanel();
    this.renderOverlay();
  }

  private mountControlBarButton(
    controlsContainer: HTMLElement,
    floatingTopRight = false,
  ): void {
    for (const stale of Array.from(
      controlsContainer.querySelectorAll('.bo-sub-ctrl-wrap'),
    )) {
      stale.remove();
    }

    const wrap = document.createElement('div');
    wrap.className = floatingTopRight
      ? 'bo-sub-ctrl-wrap bo-sub-floating-ctrl notranslate'
      : 'bo-sub-ctrl-wrap notranslate';
    wrap.setAttribute('translate', 'no');

    const pill = document.createElement('div');
    pill.className = 'bo-sub-ctrl-pill';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'bo-sub-toggle-btn';
    toggleBtn.title = '开启/关闭视频双语字幕 (Bo Translation)';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSubtitles();
    });

    const caretBtn = document.createElement('button');
    caretBtn.type = 'button';
    caretBtn.className = 'bo-sub-caret-btn';
    caretBtn.textContent = '▾';
    caretBtn.title = '视频字幕设置 / 挂载本地字幕';
    caretBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.menuOpen = !this.menuOpen;
      wrap.setAttribute('data-menu-open', this.menuOpen ? 'true' : 'false');
      this.renderMenuPanel();
      this.renderOverlay();
    });

    pill.append(toggleBtn, caretBtn);
    wrap.appendChild(pill);
    if (floatingTopRight) {
      controlsContainer.appendChild(wrap);
    } else {
      controlsContainer.insertBefore(wrap, controlsContainer.firstChild);
    }

    this.ctrlWrapEl = wrap;
    this.pillEl = pill;
    this.toggleBtnEl = toggleBtn;
    this.updateControlButtonVisual();
  }

  private toggleSubtitles(): void {
    if (this.mode === 'off') {
      this.setMode(this.lastActiveMode);
    } else {
      this.setMode('off');
    }
  }

  private setMode(nextMode: SubtitleDisplayMode): void {
    if (nextMode !== 'off') {
      this.lastActiveMode = nextMode;
    }
    this.mode = nextMode;

    if (nextMode === 'off') {
      this.fullscreenVtt.deactivate(this.videoEl);
      this.scheduler.cancelAllInFlight();
      for (const reqId of this.companionInFlight.keys()) {
        this.postPortMessage({ type: 'CANCEL_REQUEST', requestId: reqId });
      }
      this.companionInFlight.clear();
      this.tryResumeAutoPausedVideo();
    } else {
      this.activatedAtMs = Date.now();
      if (this.platform === 'html5') {
        this.syncHtml5TextTracks();
      }
      this.maybeTriggerUnlockedActiveTimelineLoad();
      if (this.scheduler.getCues().length > 0) {
        this.scheduler.tick(
          this.getVideoTimeMs(),
          this.shouldScheduleTranslation(),
        );
      } else {
        this.sampleNativeDomCaption();
      }
    }

    this.syncNativeCaptionVisibility();
    this.updateControlButtonVisual();
    this.renderMenuPanel();
    this.renderOverlay();
  }

  private syncNativeCaptionVisibility(): void {
    if (!this.playerContainer) return;
    if (this.mode !== 'off' && !this.isAdPlaying()) {
      this.playerContainer.classList.add('bo-sub-hide-native');
    } else {
      this.playerContainer.classList.remove('bo-sub-hide-native');
    }
  }

  private updateControlButtonVisual(): void {
    if (!this.toggleBtnEl || !this.pillEl) return;
    const isActive = this.mode !== 'off';
    this.pillEl.setAttribute('data-active', isActive ? 'true' : 'false');
    const labelMap: Record<SubtitleDisplayMode, string> = {
      off: '双语',
      bilingual: '双语',
      'translated-only': '仅译',
      'original-only': '原文',
    };
    this.toggleBtnEl.textContent = labelMap[this.mode];
  }

  private renderMenuPanel(): void {
    if (!this.menuPanelEl) return;
    this.ctrlWrapEl?.setAttribute(
      'data-menu-open',
      this.menuOpen ? 'true' : 'false',
    );
    this.menuPanelEl.hidden = !this.menuOpen;
    if (!this.menuOpen) return;

    const isFloatingTop =
      this.ctrlWrapEl?.classList.contains('bo-sub-floating-ctrl') ?? false;

    if (isFloatingTop) {
      this.menuPanelEl.style.top = '44px';
      this.menuPanelEl.style.right = '12px';
      this.menuPanelEl.style.bottom = 'auto';
    } else if (this.overlayHost && this.ctrlWrapEl) {
      this.menuPanelEl.style.top = 'auto';
      const hostRect = this.overlayHost.getBoundingClientRect();
      const btnRect = this.ctrlWrapEl.getBoundingClientRect();
      if (hostRect.width > 0 && btnRect.width > 0) {
        const rightPx = Math.max(
          12,
          Math.min(hostRect.width - 280, hostRect.right - btnRect.right),
        );
        const bottomPx = Math.max(54, hostRect.bottom - btnRect.top + 10);
        this.menuPanelEl.style.right = `${Math.round(rightPx)}px`;
        this.menuPanelEl.style.bottom = `${Math.round(bottomPx)}px`;
      }
    }

    const cueCount = this.scheduler.getCues().length;
    const hasCues = cueCount > 0;
    const statusText = hasCues
      ? this.timelineSource === 'local-file'
        ? `本地字幕 (${cueCount} 句)`
        : this.timelineSource === 'html5-track'
          ? `HTML5 轨道 (${cueCount} 句)`
          : this.timelineSource === 'active-prefetch'
            ? `时间轴预译 (${cueCount} 句)`
            : `镜像时间轴 (${cueCount} 句)`
      : '0 请求伴随模式';

    const vs = this.settings.videoSubtitle;
    const enabledServices = this.settings.services.filter((s) => s.enabled);

    this.menuPanelEl.innerHTML = '';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'bo-sub-menu-hdr';
    const title = document.createElement('span');
    title.className = 'bo-sub-menu-title';
    title.textContent = '视频双语字幕';
    const badge = document.createElement('span');
    badge.className = 'bo-sub-status-badge';
    badge.textContent = statusText;
    hdr.append(title, badge);
    this.menuPanelEl.appendChild(hdr);

    // Display Mode Segmented Control
    const modeSec = document.createElement('div');
    modeSec.className = 'bo-sub-menu-sec';
    const modeLbl = document.createElement('span');
    modeLbl.className = 'bo-sub-menu-lbl';
    modeLbl.textContent = '字幕模式';
    const modeRow = document.createElement('div');
    modeRow.className = 'bo-sub-seg-row';
    const modes: Array<{ value: SubtitleDisplayMode; label: string }> = [
      { value: 'off', label: '关闭' },
      { value: 'bilingual', label: '双语' },
      { value: 'translated-only', label: '仅译文' },
      { value: 'original-only', label: '仅原文' },
    ];
    for (const item of modes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bo-sub-seg-btn';
      b.textContent = item.label;
      b.setAttribute('data-selected', this.mode === item.value ? 'true' : 'false');
      b.addEventListener('click', () => this.setMode(item.value));
      modeRow.appendChild(b);
    }
    modeSec.append(modeLbl, modeRow);
    this.menuPanelEl.appendChild(modeSec);

    // Order Segmented Control
    const orderSec = document.createElement('div');
    orderSec.className = 'bo-sub-menu-sec';
    const orderLbl = document.createElement('span');
    orderLbl.className = 'bo-sub-menu-lbl';
    orderLbl.textContent = '双语上下顺序';
    const orderRow = document.createElement('div');
    orderRow.className = 'bo-sub-seg-row';
    orderRow.setAttribute('data-cols', '2');
    const orders: Array<{ value: SubtitleDisplayOrder; label: string }> = [
      { value: 'original-first', label: '原文在上' },
      { value: 'translation-first', label: '译文在上' },
    ];
    for (const item of orders) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bo-sub-seg-btn';
      b.textContent = item.label;
      b.setAttribute(
        'data-selected',
        vs.displayOrder === item.value ? 'true' : 'false',
      );
      b.addEventListener('click', () => {
        void updateSettings((prev) => ({
          ...prev,
          videoSubtitle: { ...prev.videoSubtitle, displayOrder: item.value },
        }));
      });
      orderRow.appendChild(b);
    }
    orderSec.append(orderLbl, orderRow);
    this.menuPanelEl.appendChild(orderSec);

    // Local .srt / .vtt File Import
    const localSec = document.createElement('div');
    localSec.className = 'bo-sub-menu-sec';
    const localLbl = document.createElement('span');
    localLbl.className = 'bo-sub-menu-lbl';
    localLbl.textContent = '本地外挂字幕 (.srt / .vtt)';
    const localRow = document.createElement('div');
    localRow.className = 'bo-sub-action-row';

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'bo-sub-action-btn';
    importBtn.textContent = this.localImportedName
      ? `📄 ${this.localImportedName}`
      : '挂载本地 .srt / .vtt 字幕';
    importBtn.title = this.localImportedName || '选择本地字幕文件直接挂载并翻译';
    importBtn.addEventListener('click', () => {
      this.fileInputEl?.click();
    });
    localRow.appendChild(importBtn);

    if (this.localImportedCues) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'bo-sub-action-btn';
      clearBtn.setAttribute('data-danger', 'true');
      clearBtn.textContent = '卸载';
      clearBtn.addEventListener('click', () => this.clearLocalSubtitle());
      localRow.appendChild(clearBtn);
    }
    localSec.append(localLbl, localRow);
    this.menuPanelEl.appendChild(localSec);

    // +-0.5s Zero-Retranslation Timeline Offset Adjustment
    if (hasCues) {
      const offsetSec = document.createElement('div');
      offsetSec.className = 'bo-sub-menu-sec';
      const offsetLbl = document.createElement('span');
      offsetLbl.className = 'bo-sub-menu-lbl';
      offsetLbl.textContent = '时间轴同步微调（免重译即时生效）';
      const offsetRow = document.createElement('div');
      offsetRow.className = 'bo-sub-offset-row';

      const minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'bo-sub-action-btn';
      minusBtn.textContent = '-0.5s 提前';
      minusBtn.addEventListener('click', () => this.adjustSubtitleOffset(-500));

      const resetValBtn = document.createElement('button');
      resetValBtn.type = 'button';
      resetValBtn.className = 'bo-sub-offset-val';
      resetValBtn.title = '点击重置为 0.0s';
      resetValBtn.textContent = formatSubtitleOffset(this.subtitleOffsetMs);
      resetValBtn.addEventListener('click', () => this.resetSubtitleOffset());

      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'bo-sub-action-btn';
      plusBtn.textContent = '+0.5s 延后';
      plusBtn.addEventListener('click', () => this.adjustSubtitleOffset(500));

      offsetRow.append(minusBtn, resetValBtn, plusBtn);
      offsetSec.append(offsetLbl, offsetRow);
      this.menuPanelEl.appendChild(offsetSec);
    }

    // Subtitle Translation Service Select
    const svcSec = document.createElement('div');
    svcSec.className = 'bo-sub-menu-sec';
    const svcLbl = document.createElement('span');
    svcLbl.className = 'bo-sub-menu-lbl';
    svcLbl.textContent = '字幕翻译服务';
    const select = document.createElement('select');
    select.className = 'bo-sub-select';

    const optFollow = document.createElement('option');
    optFollow.value = 'follow-primary';
    optFollow.textContent = '跟随主翻译服务';
    select.appendChild(optFollow);

    for (const s of enabledServices) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.model || '默认'})`;
      select.appendChild(opt);
    }
    select.value = vs.subtitleServiceId || 'follow-primary';
    select.addEventListener('change', () => {
      const val = select.value;
      void updateSettings((prev) => ({
        ...prev,
        videoSubtitle: { ...prev.videoSubtitle, subtitleServiceId: val },
      }));
    });
    svcSec.append(svcLbl, select);
    this.menuPanelEl.appendChild(svcSec);

    // Checkboxes
    const toggles: Array<{
      label: string;
      checked: boolean;
      onChange: (checked: boolean) => void;
    }> = [
      {
        label: '鼠标悬停字幕自动暂停',
        checked: vs.pauseOnHover,
        onChange: (checked) => {
          void updateSettings((prev) => ({
            ...prev,
            videoSubtitle: { ...prev.videoSubtitle, pauseOnHover: checked },
          }));
        },
      },
      {
        label: '模糊译文（悬停显影练听力）',
        checked: vs.blurTranslation,
        onChange: (checked) => {
          void updateSettings((prev) => ({
            ...prev,
            videoSubtitle: { ...prev.videoSubtitle, blurTranslation: checked },
          }));
        },
      },
      {
        label: '打开视频默认开启双语字幕',
        checked: vs.enabledByDefault,
        onChange: (checked) => {
          void updateSettings((prev) => ({
            ...prev,
            videoSubtitle: { ...prev.videoSubtitle, enabledByDefault: checked },
          }));
        },
      },
    ];

    for (const t of toggles) {
      const row = document.createElement('label');
      row.className = 'bo-sub-chk-row';
      const span = document.createElement('span');
      span.textContent = t.label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = t.checked;
      input.addEventListener('change', () => t.onChange(input.checked));
      row.append(span, input);
      this.menuPanelEl.appendChild(row);
    }
  }

  private renderOverlay(): void {
    if (!this.overlayHost || !this.cueBoxEl || !this.hintPillEl) return;

    this.syncNativeCaptionVisibility();

    const adPlaying = this.isAdPlaying();
    if ((this.mode === 'off' && !this.menuOpen) || adPlaying) {
      this.fullscreenVtt.deactivate(this.videoEl);
      this.overlayHost.setAttribute('data-hidden', 'true');
      return;
    }
    this.overlayHost.removeAttribute('data-hidden');

    const vs = this.settings.videoSubtitle;
    this.overlayHost.style.setProperty(
      '--bo-sub-bottom',
      `${(vs.bottomRatio * 100).toFixed(1)}%`,
    );
    this.overlayHost.style.setProperty(
      '--bo-sub-font-scale',
      String(vs.fontScale),
    );
    this.overlayHost.style.setProperty(
      '--bo-sub-bg-alpha',
      String(vs.backgroundOpacity),
    );
    this.overlayHost.setAttribute('data-order', vs.displayOrder);
    this.overlayHost.setAttribute(
      'data-blur-trans',
      vs.blurTranslation ? 'true' : 'false',
    );
    this.overlayHost.setAttribute(
      'data-ctrl-visible',
      this.isControlBarVisible() ? 'true' : 'false',
    );

    if (this.mode === 'off') {
      this.fullscreenVtt.deactivate(this.videoEl);
      this.cueBoxEl.hidden = true;
      this.hintPillEl.hidden = true;
      return;
    }

    // Determine active original & translated text from Timeline or Companion mode
    let origText = '';
    let transText = '';
    let isStreaming = false;

    if (this.scheduler.getCues().length > 0) {
      const cue = this.activeTimelineCue;
      if (cue) {
        origText = cue.text;
        if (cue.status === 'done' || cue.status === 'streaming') {
          transText = cue.translation ?? '';
          isStreaming = cue.status === 'streaming';
        } else if (cue.status === 'pending') {
          transText = '···';
          isStreaming = true;
        } else if (cue.status === 'error') {
          transText = cue.error ? `⚠️ ${cue.error}` : '';
        }
      }
    } else {
      origText = this.companionOriginal;
      transText = this.companionTranslated;
      isStreaming = this.companionStreaming;
      if (origText && !transText && isStreaming) {
        transText = '···';
      }
    }

    const identicalTarget =
      transText.trim().length > 0 && transText.trim() === origText.trim();

    const showOrig =
      this.mode === 'original-only' ||
      (this.mode === 'bilingual' && !identicalTarget) ||
      (this.mode === 'translated-only' && !transText);
    const showTrans =
      this.mode === 'translated-only' || this.mode === 'bilingual';

    // Native `<video>` element fullscreen fallback via VTTCue
    const isBareVideoFs = this.fullscreenVtt.isNativeVideoFullscreen(
      this.videoEl,
    );
    if (isBareVideoFs && this.videoEl) {
      const lines: string[] = [];
      if (vs.displayOrder === 'translation-first') {
        if (showTrans && transText) lines.push(transText);
        if (showOrig && origText) lines.push(origText);
      } else {
        if (showOrig && origText) lines.push(origText);
        if (showTrans && transText) lines.push(transText);
      }
      const combined = lines.join('\n').trim();
      const rawNowMs = Math.max(
        0,
        Math.round((this.videoEl.currentTime || 0) * 1000),
      );
      const startMs = this.activeTimelineCue
        ? Math.max(0, this.activeTimelineCue.startMs + this.subtitleOffsetMs)
        : Math.max(0, rawNowMs - 150);
      const endMs = this.activeTimelineCue
        ? Math.max(
            startMs + 300,
            this.activeTimelineCue.endMs + this.subtitleOffsetMs,
          )
        : rawNowMs + 4500;

      this.fullscreenVtt.syncCue(
        this.videoEl,
        combined ? { startMs, endMs, text: combined } : null,
        this.settings.targetLang,
      );
    } else {
      this.fullscreenVtt.deactivate(this.videoEl);
    }

    const origLine = this.cueBoxEl.querySelector<HTMLParagraphElement>(
      '[data-bo-subtitle-orig]',
    );
    const transLine = this.cueBoxEl.querySelector<HTMLParagraphElement>(
      '[data-bo-subtitle-trans]',
    );

    if (!origText || !origLine || !transLine) {
      this.cueBoxEl.hidden = true;
      this.updateCompanionHintPill();
      return;
    }

    this.hintPillEl.hidden = true;
    this.cueBoxEl.hidden = isBareVideoFs;

    // Ensure DOM order matches displayOrder while keeping dragHandle first
    const dragHandle = this.cueBoxEl.querySelector('.bo-sub-drag-handle');
    if (vs.displayOrder === 'translation-first') {
      if (origLine.previousElementSibling !== transLine) {
        this.cueBoxEl.append(transLine, origLine);
        if (dragHandle) this.cueBoxEl.prepend(dragHandle);
      }
    } else if (transLine.previousElementSibling !== origLine) {
      this.cueBoxEl.append(origLine, transLine);
      if (dragHandle) this.cueBoxEl.prepend(dragHandle);
    }

    origLine.textContent = origText;
    origLine.hidden = !showOrig;

    transLine.textContent = transText;
    transLine.hidden = !showTrans || !transText;
    transLine.setAttribute('data-streaming', isStreaming ? 'true' : 'false');
  }

  private updateCompanionHintPill(): void {
    if (!this.hintPillEl || !this.playerContainer) return;
    if (this.scheduler.getCues().length > 0 || this.companionOriginal) {
      this.hintPillEl.hidden = true;
      return;
    }

    const elapsed = Date.now() - this.activatedAtMs;
    if (elapsed < 800 || elapsed > 9000) {
      this.hintPillEl.hidden = true;
      return;
    }

    const activeFetchOn =
      this.settings.videoSubtitle.advancedTimelineUnlocked &&
      this.settings.videoSubtitle.enableActiveTimelineFetch;
    if (activeFetchOn) {
      this.hintPillEl.hidden = true;
      return;
    }

    if (this.platform === 'youtube') {
      const ccBtn = this.playerContainer.querySelector<HTMLElement>(
        '.ytp-subtitles-button',
      );
      if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
        this.hintPillEl.textContent =
          '伴随模式已开启 · 请点击右下角播放器自带「字幕 (CC)」提供字幕源';
        this.hintPillEl.hidden = false;
        return;
      }
    } else if (this.platform === 'bilibili') {
      this.hintPillEl.textContent =
        '伴随模式已开启 · 请开启播放器自带「字幕」提供字幕源';
      this.hintPillEl.hidden = false;
      return;
    } else if (this.platform === 'html5') {
      this.hintPillEl.textContent =
        '未检测到内置字幕轨 · 可点击右上角「▾」挂载本地 .srt / .vtt 字幕';
      this.hintPillEl.hidden = false;
      return;
    }

    this.hintPillEl.hidden = true;
  }

  private readonly handleCuePointerEnter = (): void => {
    this.isCueHovered = true;
    if (!this.settings.videoSubtitle.pauseOnHover) return;
    if (this.videoEl && !this.videoEl.paused && !this.videoEl.ended) {
      this.videoEl.pause();
      this.autoPausedByHover = true;
    }
  };

  private readonly handleCuePointerLeave = (): void => {
    this.isCueHovered = false;
    if (!this.autoPausedByHover) return;
    if (this.hasActiveSubtitleSelection()) return;
    this.tryResumeAutoPausedVideo();
  };

  private readonly handleSelectionChange = (): void => {
    if (!this.autoPausedByHover || this.isCueHovered) return;
    if (!this.hasActiveSubtitleSelection()) {
      this.tryResumeAutoPausedVideo();
    }
  };

  private hasActiveSubtitleSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
    const anchor = sel.anchorNode;
    if (!anchor || !this.overlayHost) return false;
    return this.overlayHost.contains(anchor);
  }

  private tryResumeAutoPausedVideo(): void {
    if (!this.autoPausedByHover) return;
    this.autoPausedByHover = false;
    if (this.videoEl && this.videoEl.paused && !this.videoEl.ended) {
      void this.videoEl.play().catch(() => {});
    }
  }

  private readonly handleDragStart = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.overlayHost) return;

    this.isDraggingPosition = true;
    this.overlayHost.setAttribute('data-dragging', 'true');
    const hostRect = this.overlayHost.getBoundingClientRect();
    const startY = e.clientY;
    const startRatio = this.settings.videoSubtitle.bottomRatio;
    let latestRatio = startRatio;

    const onMove = (ev: PointerEvent) => {
      if (hostRect.height <= 0) return;
      const deltaY = startY - ev.clientY;
      latestRatio = Math.max(
        0.03,
        Math.min(0.65, startRatio + deltaY / hostRect.height),
      );
      this.overlayHost?.style.setProperty(
        '--bo-sub-bottom',
        `${(latestRatio * 100).toFixed(1)}%`,
      );
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      this.isDraggingPosition = false;
      this.overlayHost?.removeAttribute('data-dragging');
      void updateSettings((prev) => ({
        ...prev,
        videoSubtitle: { ...prev.videoSubtitle, bottomRatio: latestRatio },
      }));
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  };

  private readonly handleGlobalPointerDown = (e: PointerEvent): void => {
    if (!this.menuOpen) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (
      this.menuPanelEl?.contains(target) ||
      this.ctrlWrapEl?.contains(target)
    ) {
      return;
    }
    this.menuOpen = false;
    this.renderMenuPanel();
    this.renderOverlay();
  };

  private getVideoTimeMs(): number {
    if (!this.videoEl || Number.isNaN(this.videoEl.currentTime)) return 0;
    const rawMs = Math.round(this.videoEl.currentTime * 1000);
    return Math.max(0, rawMs - this.subtitleOffsetMs);
  }

  private shouldScheduleTranslation(): boolean {
    return this.mode === 'bilingual' || this.mode === 'translated-only';
  }

  private isAdPlaying(): boolean {
    if (!this.playerContainer || this.platform !== 'youtube') return false;
    return (
      this.playerContainer.classList.contains('ad-showing') ||
      this.playerContainer.classList.contains('ad-interrupting') ||
      Boolean(
        this.playerContainer.querySelector(
          '.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout',
        ),
      )
    );
  }

  private isControlBarVisible(): boolean {
    if (!this.playerContainer || this.isDraggingPosition) return false;
    if (this.platform === 'youtube') {
      return !this.playerContainer.classList.contains('ytp-autohide');
    }
    if (this.platform === 'bilibili') {
      return (
        this.playerContainer.classList.contains('bpx-state-show-controller') ||
        this.menuOpen
      );
    }
    return false;
  }
}
