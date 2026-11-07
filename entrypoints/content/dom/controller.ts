import {
  detectIsForeignPage,
  sampleReadablePageText,
} from '../../../src/auto-translate/detector';
import {
  matchSiteRule,
  resolvePrimaryService,
} from '../../../src/storage';
import {
  STREAM_PORT_NAME,
  type ExtensionSettings,
  type PageTabState,
  type PageViewMode,
  type StreamPortClientMessage,
  type StreamPortServerMessage,
} from '../../../src/types';
import { consumeRuntimeLastError } from '../../../src/utils/runtime';
import {
  applySegmentColorMode,
  applyViewModeToSegment,
  ensureHostStyleSheet,
  isIgnoredSelfMutation,
  markSegmentError,
  mountSegmentWrapper,
  type RenderedSegmentHandle,
  updateSegmentTranslation,
  withViewportScrollAnchor,
} from './renderer';
import { BO_TRANS_TAG, BO_UI_HOST_TAG } from './rules';
import {
  discoverCandidateElements,
  extractTranslatableSegmentsFromElement,
  findHoverTargetElement,
  type ScanOptions,
} from './scanner';

export interface HoveredSegmentInfo {
  handle: RenderedSegmentHandle;
  rect: DOMRect;
  peekOriginalOnly: boolean;
}

export class PageTranslationController {
  private settings: ExtensionSettings;
  private mode: PageViewMode = 'original';
  private nextSegId = 1;

  private segments = new Map<number, RenderedSegmentHandle>();
  private hostToSegIds = new WeakMap<HTMLElement, number[]>();
  private observedHosts = new WeakSet<HTMLElement>();
  private dwellTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  /** In-page translation memory cache: `${serviceId}::${targetLang}::${serializedText}` */
  private translationCache = new Map<string, { text: string; serviceName: string }>();

  private pendingBatchQueue: RenderedSegmentHandle[] = [];
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBatchRequests = new Set<string>();
  private inFlightSegmentIds = new Set<number>();

  private port: chrome.runtime.Port | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;

  private stateListeners = new Set<(state: PageTabState) => void>();
  private hoverListeners = new Set<(info: HoveredSegmentInfo | null) => void>();

  private rafPendingUpdates = new Map<
    number,
    { text: string; status: 'streaming' | 'done'; serviceId: string; serviceName: string }
  >();
  private rafScheduled = false;

  private lastMouseClient = { x: 0, y: 0, target: null as EventTarget | null };
  private lastHoverToggledEl: HTMLElement | null = null;
  private hoveredSegId: number | null = null;

  /** Smart foreign-page auto-translation state machine */
  private lastRouteKey = '';
  private userRestoredRouteKey: string | null = null;
  private checkedNonForeignRouteKey: string | null = null;
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initialSettings: ExtensionSettings) {
    this.settings = initialSettings;
  }

  private getRouteKey(): string {
    return `${ window.location.origin }${ window.location.pathname }${ window.location.search }${ window.location.hash }`;
  }

  private getScanOptions(): ScanOptions {
    return {
      hostname: window.location.hostname,
      siteRule: matchSiteRule(window.location.hostname, this.settings.siteRules),
      targetLang: this.settings.targetLang,
      enableGithubComments: this.settings.enableGithubCommentTranslation,
    };
  }

  init(): void {
    this.lastRouteKey = this.getRouteKey();
    ensureHostStyleSheet(
      document,
      this.settings.stylePreset,
      this.settings.fontScale,
      this.settings.colorMode,
    );
    document.documentElement.setAttribute('data-bo-view', this.mode);

    this.setupIntersectionObserver();
    this.setupMutationObserver();
    this.setupHoverAndHoldListeners();
    this.setupAutoTranslateListeners();

    // Schedule initial domain rule & smart foreign-page check after hydration settles
    this.scheduleAutoTranslationCheck(280);
  }

  updateSettings(next: ExtensionSettings): void {
    const prevStyle = this.settings.stylePreset;
    const prevScale = this.settings.fontScale;
    const prevColorMode = this.settings.colorMode;
    const prevGithubComments = this.settings.enableGithubCommentTranslation;
    const prevAutoTranslate = this.settings.autoTranslateForeignPages;
    const prevSiteRules = this.settings.siteRules;
    this.settings = next;

    if (
      prevStyle !== next.stylePreset ||
      prevScale !== next.fontScale ||
      prevColorMode !== next.colorMode
    ) {
      ensureHostStyleSheet(
        document,
        next.stylePreset,
        next.fontScale,
        next.colorMode,
      );
      if (prevColorMode !== next.colorMode) {
        for (const handle of this.segments.values()) {
          applySegmentColorMode(handle, next.colorMode);
        }
      }
    }

    if (prevGithubComments !== next.enableGithubCommentTranslation) {
      if (!next.enableGithubCommentTranslation) {
        for (const handle of this.segments.values()) {
          if (handle.codeCommentMeta) {
            handle.manualHoverVisible = false;
            applyViewModeToSegment(handle, 'original');
          }
        }
      } else if (this.mode !== 'original') {
        this.scanAndObserveRoot(document);
      }
    }

    const matchedRule = matchSiteRule(window.location.hostname, next.siteRules);
    if (matchedRule?.action === 'never-translate' && this.mode !== 'original') {
      this.setMode('original', { source: 'auto' });
      return;
    }

    if (
      prevAutoTranslate !== next.autoTranslateForeignPages ||
      prevSiteRules !== next.siteRules
    ) {
      this.checkedNonForeignRouteKey = null;
      this.scheduleAutoTranslationCheck(60);
    }
  }

  private setupAutoTranslateListeners(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden' && this.mode === 'original') {
        this.scheduleAutoTranslationCheck(120);
      }
    });

    const onRouteEvent = () => {
      const nextKey = this.getRouteKey();
      if (nextKey !== this.lastRouteKey) {
        this.lastRouteKey = nextKey;
        this.userRestoredRouteKey = null;
        this.checkedNonForeignRouteKey = null;
        if (this.mode === 'original') {
          this.scheduleAutoTranslationCheck(260);
        }
      }
    };

    window.addEventListener('popstate', onRouteEvent);
    window.addEventListener('hashchange', onRouteEvent);

    // Proactively close open extension Port before page enters BFCache
    window.addEventListener('pagehide', () => {
      if (this.port) {
        const activePort = this.port;
        this.port = null;
        this.activeBatchRequests.clear();
        this.inFlightSegmentIds.clear();
        try {
          activePort.disconnect();
        } catch {
          // ignore already closed port
        }
        this.emitState();
      }
    });

    // Resume any interrupted in-flight segments when restored from BFCache
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || this.mode === 'original') return;
      for (const handle of this.segments.values()) {
        if (handle.state === 'loading' || handle.state === 'streaming') {
          this.enqueueSegmentForBatch(handle);
        }
      }
    });
  }

  private scheduleAutoTranslationCheck(delayMs = 260): void {
    if (this.autoCheckTimer) {
      clearTimeout(this.autoCheckTimer);
    }
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null;
      void this.evaluateAutoTranslation();
    }, delayMs);
  }

  private isDocumentHidden(): boolean {
    return document.visibilityState === 'hidden';
  }

  /**
   * Non-intrusive smart foreign-page & site-rule auto-translation evaluator:
   * - Respects `never-translate` site rule
   * - Defers execution while `document.visibilityState === 'hidden'` (lazy start on tab focus)
   * - Latches per-URL when user explicitly restores `'original'` so DOM mutations never override user choice
   */
  async evaluateAutoTranslation(): Promise<boolean> {
    const routeKey = this.getRouteKey();
    if (this.lastRouteKey && this.lastRouteKey !== routeKey) {
      this.userRestoredRouteKey = null;
      this.checkedNonForeignRouteKey = null;
    }
    this.lastRouteKey = routeKey;

    const matchedRule = matchSiteRule(
      window.location.hostname,
      this.settings.siteRules,
    );
    if (matchedRule?.action === 'never-translate') {
      return false;
    }

    if (this.isDocumentHidden()) {
      return false;
    }

    if (this.userRestoredRouteKey === routeKey) {
      return false;
    }

    if (this.mode !== 'original') {
      return false;
    }

    if (matchedRule?.action === 'always-bilingual') {
      this.setMode('bilingual', { source: 'auto' });
      return true;
    }
    if (matchedRule?.action === 'always-translated-only') {
      this.setMode('translated-only', { source: 'auto' });
      return true;
    }

    if (!this.settings.autoTranslateForeignPages) {
      return false;
    }

    if (this.checkedNonForeignRouteKey === routeKey) {
      return false;
    }

    const sampleText = sampleReadablePageText(document);
    if (sampleText.length < 40) {
      return false;
    }

    const isForeign = await detectIsForeignPage({
      sampleText,
      htmlLang: document.documentElement.lang || '',
      targetLang: this.settings.targetLang,
    });

    // Re-check invariants after async language detection
    if (
      this.mode !== 'original' ||
      this.getRouteKey() !== routeKey ||
      this.userRestoredRouteKey === routeKey ||
      this.isDocumentHidden() ||
      matchSiteRule(window.location.hostname, this.settings.siteRules)?.action ===
        'never-translate'
    ) {
      return false;
    }

    if (isForeign) {
      this.setMode('bilingual', { source: 'auto' });
      return true;
    }

    if (sampleText.length >= 280) {
      this.checkedNonForeignRouteKey = routeKey;
    }
    return false;
  }

  getSettings(): ExtensionSettings {
    return this.settings;
  }

  getMode(): PageViewMode {
    return this.mode;
  }

  getState(): PageTabState {
    let translatedCount = 0;
    for (const seg of this.segments.values()) {
      if (seg.state === 'done') translatedCount++;
    }
    return {
      mode: this.mode,
      hostname: window.location.hostname,
      translatedCount,
      inFlightCount: this.inFlightSegmentIds.size,
    };
  }

  subscribeState(fn: (state: PageTabState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.getState());
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  subscribeHoveredSegment(
    fn: (info: HoveredSegmentInfo | null) => void,
  ): () => void {
    this.hoverListeners.add(fn);
    return () => {
      this.hoverListeners.delete(fn);
    };
  }

  private emitState(): void {
    const snapshot = this.getState();
    for (const fn of this.stateListeners) {
      fn(snapshot);
    }
  }

  private emitHover(info: HoveredSegmentInfo | null): void {
    for (const fn of this.hoverListeners) {
      fn(info);
    }
  }

  toggleBilingual(): PageViewMode {
    const next: PageViewMode =
      this.mode === 'original' ? 'bilingual' : 'original';
    this.setMode(next, { source: 'user' });
    return next;
  }

  toggleTranslatedOnly(): PageViewMode {
    const next: PageViewMode =
      this.mode === 'translated-only' ? 'bilingual' : 'translated-only';
    this.setMode(next, { source: 'user' });
    return next;
  }

  setMode(
    nextMode: PageViewMode,
    options?: { source?: 'user' | 'auto' },
  ): void {
    const source = options?.source ?? 'user';
    if (nextMode === 'original' && source === 'user' && this.mode !== 'original') {
      this.userRestoredRouteKey = this.getRouteKey();
    } else if (nextMode !== 'original' && source === 'user') {
      this.userRestoredRouteKey = null;
    }

    if (this.mode === nextMode) return;
    this.mode = nextMode;
    document.documentElement.setAttribute('data-bo-view', nextMode);

    if (nextMode === 'original') {
      this.cancelAllInFlight();
      for (const timer of this.dwellTimers.values()) {
        clearTimeout(timer);
      }
      this.dwellTimers.clear();
      this.observedHosts = new WeakSet<HTMLElement>();
      this.intersectionObserver?.disconnect();

      for (const handle of this.segments.values()) {
        handle.manualHoverVisible = false;
        applyViewModeToSegment(handle, 'original');
      }
      this.emitHover(null);
      this.emitState();
      return;
    }

    // Switching to 'bilingual' or 'translated-only'
    ensureHostStyleSheet(
      document,
      this.settings.stylePreset,
      this.settings.fontScale,
      this.settings.colorMode,
    );

    for (const handle of this.segments.values()) {
      if (
        handle.codeCommentMeta &&
        !this.settings.enableGithubCommentTranslation
      ) {
        continue;
      }
      applyViewModeToSegment(handle, nextMode);
      // Re-enqueue segments that were cancelled while still loading
      if (handle.state === 'loading' && !this.inFlightSegmentIds.has(handle.id)) {
        this.enqueueSegmentForBatch(handle);
      }
    }

    this.scanAndObserveRoot(document);
    this.emitState();
  }

  retranslateSegment(segId: number, overrideServiceId?: string): void {
    const handle = this.segments.get(segId);
    if (!handle) return;

    handle.state = 'loading';
    handle.translatedRaw = '';
    handle.wrapperEl.setAttribute('data-state', 'loading');
    handle.innerEl.innerHTML =
      '<span class="bo-trans-loading"><span class="bo-trans-dot"></span><span class="bo-trans-dot"></span><span class="bo-trans-dot"></span></span>';
    applyViewModeToSegment(handle, this.mode);

    this.sendBatchImmediate([handle], overrideServiceId, true);
  }

  retranslateHoveredSegment(): boolean {
    if (this.hoveredSegId !== null && this.segments.has(this.hoveredSegId)) {
      this.retranslateSegment(this.hoveredSegId);
      return true;
    }
    const targetEl = findHoverTargetElement(
      this.lastMouseClient.target,
      this.getScanOptions(),
    );
    if (!targetEl) return false;
    const ids = this.hostToSegIds.get(targetEl);
    if (ids && ids.length > 0) {
      for (const id of ids) {
        this.retranslateSegment(id);
      }
      return true;
    }
    return false;
  }

  toggleSingleHostElement(hostEl: HTMLElement): void {
    const existingIds = this.hostToSegIds.get(hostEl);
    if (existingIds && existingIds.length > 0) {
      const handles = existingIds
        .map((id) => this.segments.get(id))
        .filter((h): h is RenderedSegmentHandle => Boolean(h));

      if (this.mode === 'original') {
        const anyVisible = handles.some((h) => !h.wrapperEl.hidden);
        for (const h of handles) {
          h.manualHoverVisible = !anyVisible;
          applyViewModeToSegment(h, 'original');
          if (h.manualHoverVisible && h.state === 'loading' && !this.inFlightSegmentIds.has(h.id)) {
            this.sendBatchImmediate([h]);
          }
        }
        this.emitState();
        return;
      }
    }

    // Mount and translate immediately
    const created = this.mountSegmentsForElement(hostEl, true);
    if (created.length > 0) {
      this.sendBatchImmediate(created);
    }
  }

  private setupIntersectionObserver(): void {
    if (typeof IntersectionObserver === 'undefined') return;

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (this.mode === 'original') return;

        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            if (!this.dwellTimers.has(el)) {
              const timer = setTimeout(() => {
                this.dwellTimers.delete(el);
                if (this.mode === 'original') return;
                this.intersectionObserver?.unobserve(el);
                const created = this.mountSegmentsForElement(el, false);
                for (const handle of created) {
                  this.enqueueSegmentForBatch(handle);
                }
              }, 150);
              this.dwellTimers.set(el, timer);
            }
          } else {
            const existingTimer = this.dwellTimers.get(el);
            if (existingTimer) {
              clearTimeout(existingTimer);
              this.dwellTimers.delete(el);
            }
          }
        }
      },
      {
        rootMargin: '500px 0px 500px 0px',
        threshold: 0.01,
      },
    );
  }

  private setupMutationObserver(): void {
    if (typeof MutationObserver === 'undefined') return;

    const pendingRoots = new Set<HTMLElement>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    this.mutationObserver = new MutationObserver((records) => {
      const currentRoute = this.getRouteKey();
      if (currentRoute !== this.lastRouteKey) {
        this.lastRouteKey = currentRoute;
        this.userRestoredRouteKey = null;
        this.checkedNonForeignRouteKey = null;
      }

      if (this.mode === 'original') {
        if (
          this.settings.autoTranslateForeignPages &&
          this.userRestoredRouteKey !== currentRoute &&
          this.checkedNonForeignRouteKey !== currentRoute &&
          document.visibilityState !== 'hidden'
        ) {
          this.scheduleAutoTranslationCheck(360);
        }
        return;
      }

      for (const rec of records) {
        if (isIgnoredSelfMutation(rec)) continue;
        for (const added of Array.from(rec.addedNodes)) {
          if (added instanceof HTMLElement) {
            if (
              added.tagName !== BO_TRANS_TAG.toUpperCase() &&
              added.tagName !== BO_UI_HOST_TAG.toUpperCase()
            ) {
              pendingRoots.add(added);
            }
          }
        }
      }

      if (pendingRoots.size > 0 && !debounceTimer) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (this.mode === 'original') {
            pendingRoots.clear();
            return;
          }
          const roots = Array.from(pendingRoots);
          pendingRoots.clear();
          for (const root of roots) {
            if (root.isConnected) {
              this.scanAndObserveRoot(root);
            }
          }
        }, 200);
      }
    });

    if (document.body) {
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }

  private scanAndObserveRoot(root: Element | Document): void {
    const candidates = discoverCandidateElements(root, this.getScanOptions());

    for (const el of candidates) {
      if (this.observedHosts.has(el)) continue;
      this.observedHosts.add(el);
      if (this.intersectionObserver) {
        this.intersectionObserver.observe(el);
      } else {
        // Fallback when IntersectionObserver is unavailable (e.g. unit test DOM)
        const created = this.mountSegmentsForElement(el, false);
        for (const handle of created) {
          this.enqueueSegmentForBatch(handle);
        }
      }
    }
  }

  private mountSegmentsForElement(
    hostEl: HTMLElement,
    manualHover: boolean,
  ): RenderedSegmentHandle[] {
    const discovered = extractTranslatableSegmentsFromElement(
      hostEl,
      this.getScanOptions(),
    );

    if (discovered.length === 0) return [];

    const primaryService = resolvePrimaryService(this.settings);
    const createdHandles: RenderedSegmentHandle[] = [];
    const existingIds = this.hostToSegIds.get(hostEl) ?? [];

    for (const seg of discovered) {
      const id = this.nextSegId++;
      const handle = mountSegmentWrapper({
        id,
        hostEl: seg.hostEl,
        sourceNodes: seg.nodes,
        serialized: seg.serialized,
        isShortInline: seg.isShortInline,
        targetLang: this.settings.targetLang,
        colorMode: this.settings.colorMode,
        codeCommentMeta: seg.codeCommentMeta,
        onRetryClick: (retryId) => this.retranslateSegment(retryId),
      });
      handle.manualHoverVisible = manualHover;

      this.segments.set(id, handle);
      existingIds.push(id);

      // Check in-page cache first
      const cacheKey = this.makeCacheKey(
        primaryService.id,
        seg.serialized.serializedText,
      );
      const cached = this.translationCache.get(cacheKey);
      if (cached) {
        updateSegmentTranslation(
          handle,
          cached.text,
          'done',
          this.mode,
          { serviceId: primaryService.id, serviceName: cached.serviceName },
        );
      } else {
        applyViewModeToSegment(handle, this.mode);
        createdHandles.push(handle);
      }
    }

    this.hostToSegIds.set(hostEl, existingIds);
    this.emitState();
    return createdHandles;
  }

  private makeCacheKey(serviceId: string, serializedText: string): string {
    return `${ serviceId }::${ this.settings.targetLang }::${ serializedText }`;
  }

  private enqueueSegmentForBatch(handle: RenderedSegmentHandle): void {
    const primaryService = resolvePrimaryService(this.settings);
    const cacheKey = this.makeCacheKey(
      primaryService.id,
      handle.serialized.serializedText,
    );
    const cached = this.translationCache.get(cacheKey);
    if (cached) {
      updateSegmentTranslation(handle, cached.text, 'done', this.mode, {
        serviceId: primaryService.id,
        serviceName: cached.serviceName,
      });
      this.emitState();
      return;
    }

    if (this.inFlightSegmentIds.has(handle.id)) return;
    this.pendingBatchQueue.push(handle);

    const maxBatch = Math.max(1, primaryService.batchSize || 6);
    if (this.pendingBatchQueue.length >= maxBatch) {
      this.flushBatchQueue();
      return;
    }

    if (!this.batchFlushTimer) {
      this.batchFlushTimer = setTimeout(() => {
        this.batchFlushTimer = null;
        this.flushBatchQueue();
      }, 110);
    }
  }

  private flushBatchQueue(): void {
    if (this.pendingBatchQueue.length === 0) return;
    const primaryService = resolvePrimaryService(this.settings);
    const maxBatch = Math.max(1, primaryService.batchSize || 6);
    const maxChars = 3600;

    while (this.pendingBatchQueue.length > 0) {
      const batch: RenderedSegmentHandle[] = [];
      let charCount = 0;

      while (
        this.pendingBatchQueue.length > 0 &&
        batch.length < maxBatch
      ) {
        const next = this.pendingBatchQueue[0];
        if (!next) break;
        const nextLen = next.serialized.serializedText.length;
        if (batch.length > 0 && charCount + nextLen > maxChars) {
          break;
        }
        batch.push(this.pendingBatchQueue.shift()!);
        charCount += nextLen;
      }

      if (batch.length > 0) {
        this.sendBatchImmediate(batch);
      }
    }
  }

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;

    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    this.port = port;

    port.onMessage.addListener((msg: StreamPortServerMessage) => {
      this.handlePortMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      this.port = null;
      this.activeBatchRequests.clear();
      this.inFlightSegmentIds.clear();
      this.emitState();
    });

    return port;
  }

  private sendBatchImmediate(
    handles: RenderedSegmentHandle[],
    overrideServiceId?: string,
    bypassCache = false,
  ): void {
    if (handles.length === 0) return;

    const serviceId =
      overrideServiceId ?? resolvePrimaryService(this.settings).id;

    const toRequest: RenderedSegmentHandle[] = [];
    for (const h of handles) {
      if (!bypassCache) {
        const cached = this.translationCache.get(
          this.makeCacheKey(serviceId, h.serialized.serializedText),
        );
        if (cached) {
          updateSegmentTranslation(h, cached.text, 'done', this.mode, {
            serviceId,
            serviceName: cached.serviceName,
          });
          continue;
        }
      }
      this.inFlightSegmentIds.add(h.id);
      toRequest.push(h);
    }

    if (toRequest.length === 0) {
      this.emitState();
      return;
    }

    const requestId = `batch_${ Date.now() }_${ Math.random().toString(36).slice(2, 7) }`;
    this.activeBatchRequests.add(requestId);
    this.emitState();

    const payload: StreamPortClientMessage = {
      type: 'TRANSLATE_BATCH',
      requestId,
      serviceId: overrideServiceId,
      docTitle: document.title,
      sourceLang: this.settings.sourceLang,
      targetLang: this.settings.targetLang,
      items: toRequest.map((h) => ({
        id: h.id,
        text: h.serialized.serializedText,
        plainText: h.serialized.fullPlainText,
      })),
    };

    try {
      this.ensurePort().postMessage(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '连接后台翻译服务失败';
      for (const h of toRequest) {
        this.inFlightSegmentIds.delete(h.id);
        markSegmentError(h, msg);
      }
      this.activeBatchRequests.delete(requestId);
      this.emitState();
    }
  }

  private handlePortMessage(msg: StreamPortServerMessage): void {
    if (msg.type === 'ITEM_DELTA' || msg.type === 'ITEM_DONE') {
      const handle = this.segments.get(msg.id);
      if (!handle) return;

      if (msg.type === 'ITEM_DONE') {
        this.inFlightSegmentIds.delete(msg.id);
        this.translationCache.set(
          this.makeCacheKey(msg.serviceId, handle.serialized.serializedText),
          { text: msg.fullText, serviceName: msg.serviceName },
        );
      }

      this.rafPendingUpdates.set(msg.id, {
        text: msg.fullText,
        status: msg.type === 'ITEM_DONE' ? 'done' : 'streaming',
        serviceId: msg.serviceId,
        serviceName: msg.serviceName,
      });
      this.scheduleRafFlush();

      if (msg.type === 'ITEM_DONE') {
        this.emitState();
      }
      return;
    }

    if (msg.type === 'ITEM_ERROR') {
      this.inFlightSegmentIds.delete(msg.id);
      const handle = this.segments.get(msg.id);
      if (handle) {
        markSegmentError(handle, msg.error);
      }
      this.emitState();
      return;
    }

    if (msg.type === 'BATCH_COMPLETE') {
      this.activeBatchRequests.delete(msg.requestId);
      this.emitState();
    }
  }

  private scheduleRafFlush(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;

    const flush = () => {
      this.rafScheduled = false;
      if (this.rafPendingUpdates.size === 0) return;

      const entries = Array.from(this.rafPendingUpdates.entries());
      this.rafPendingUpdates.clear();

      withViewportScrollAnchor(() => {
        for (const [id, data] of entries) {
          const handle = this.segments.get(id);
          if (!handle) continue;
          updateSegmentTranslation(
            handle,
            data.text,
            data.status,
            this.mode,
            { serviceId: data.serviceId, serviceName: data.serviceName },
          );
        }
      });
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      flush();
    }
  }

  private cancelAllInFlight(): void {
    if (this.batchFlushTimer) {
      clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = null;
    }
    this.pendingBatchQueue = [];
    this.rafPendingUpdates.clear();

    if (this.port) {
      for (const reqId of this.activeBatchRequests) {
        try {
          this.port.postMessage({
            type: 'CANCEL_REQUEST',
            requestId: reqId,
          } satisfies StreamPortClientMessage);
        } catch {
          // ignore
        }
      }
    }
    this.activeBatchRequests.clear();
    this.inFlightSegmentIds.clear();
  }

  private isHoverModifierPressed(e: MouseEvent | KeyboardEvent): boolean {
    const mod = this.settings.shortcuts.hoverModifier;
    if (mod === 'None') return false;
    if (mod === 'Alt') return e.altKey && !e.ctrlKey && !e.metaKey;
    if (mod === 'Control') return e.ctrlKey && !e.altKey && !e.metaKey;
    if (mod === 'Shift') return e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (mod === 'Meta') return e.metaKey && !e.altKey && !e.ctrlKey;
    return false;
  }

  private setupHoverAndHoldListeners(): void {
    let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;

    document.addEventListener(
      'mousemove',
      (e) => {
        this.lastMouseClient = { x: e.clientX, y: e.clientY, target: e.target };

        const targetNode = e.target as Node | null;
        if (
          targetNode instanceof Element &&
          targetNode.closest(BO_UI_HOST_TAG)
        ) {
          if (hoverHideTimer) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = null;
          }
          return;
        }

        // Check if hovering over an existing `<bo-trans>` wrapper for ParagraphToolbar / Peek Original
        const wrapper =
          targetNode instanceof Element
            ? targetNode.closest(BO_TRANS_TAG)
            : targetNode?.parentElement?.closest(BO_TRANS_TAG);

        if (wrapper instanceof HTMLElement && !wrapper.hidden) {
          const segId = Number(wrapper.getAttribute('data-bo-seg-id'));
          const handle = this.segments.get(segId);
          if (handle && handle.state === 'done') {
            if (hoverHideTimer) {
              clearTimeout(hoverHideTimer);
              hoverHideTimer = null;
            }
            this.hoveredSegId = segId;
            this.emitHover({
              handle,
              rect: wrapper.getBoundingClientRect(),
              peekOriginalOnly:
                this.mode === 'translated-only' && this.isHoverModifierPressed(e),
            });
          }
        } else if (this.hoveredSegId !== null && !hoverHideTimer) {
          hoverHideTimer = setTimeout(() => {
            hoverHideTimer = null;
            this.hoveredSegId = null;
            this.emitHover(null);
          }, 260);
        }

        // Modifier + Hover trigger in original mode
        if (this.mode === 'original' && this.isHoverModifierPressed(e)) {
          const candidate = findHoverTargetElement(
            e.target,
            this.getScanOptions(),
          );
          if (candidate && candidate !== this.lastHoverToggledEl) {
            this.lastHoverToggledEl = candidate;
            this.toggleSingleHostElement(candidate);
          } else if (!candidate) {
            this.lastHoverToggledEl = null;
          }
        } else {
          this.lastHoverToggledEl = null;
        }
      },
      { passive: true },
    );

    // Pressing the hover modifier while mouse is stationary over a paragraph
    document.addEventListener('keydown', (e) => {
      const mod = this.settings.shortcuts.hoverModifier;
      if (mod === 'None' || e.repeat) return;
      if (e.key !== mod) return;
      // Ignore if typing in input/textarea
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return;
      }

      if (this.mode === 'translated-only' && this.hoveredSegId !== null) {
        const handle = this.segments.get(this.hoveredSegId);
        if (handle) {
          this.emitHover({
            handle,
            rect: handle.wrapperEl.getBoundingClientRect(),
            peekOriginalOnly: true,
          });
        }
        return;
      }

      if (this.mode === 'original' && this.lastMouseClient.target) {
        const candidate = findHoverTargetElement(
          this.lastMouseClient.target,
          this.getScanOptions(),
        );
        if (candidate && candidate !== this.lastHoverToggledEl) {
          this.lastHoverToggledEl = candidate;
          this.toggleSingleHostElement(candidate);
        }
      }
    });

    // Optional Mouse Left-Button 600ms Hold Trigger
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let downPos = { x: 0, y: 0 };
    let suppressNextClick = false;

    document.addEventListener(
      'mousedown',
      (e) => {
        if (!this.settings.shortcuts.enableMouseHoldHover) return;
        if (e.button !== 0 || this.mode !== 'original') return;
        const target = e.target as HTMLElement | null;
        if (
          !target ||
          target.closest(BO_UI_HOST_TAG) ||
          target.closest('input, textarea, select, [contenteditable="true"]')
        ) {
          return;
        }

        downPos = { x: e.clientX, y: e.clientY };
        holdTimer = setTimeout(() => {
          holdTimer = null;
          if ((window.getSelection()?.toString() ?? '').trim().length > 0) return;
          const candidate = findHoverTargetElement(
            target,
            this.getScanOptions(),
          );
          if (candidate) {
            if (candidate.closest('a, button')) {
              suppressNextClick = true;
            }
            this.toggleSingleHostElement(candidate);
          }
        }, 600);
      },
      { passive: true },
    );

    document.addEventListener(
      'mousemove',
      (e) => {
        if (!holdTimer) return;
        const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
        if (dist > 6) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      },
      { passive: true },
    );

    document.addEventListener(
      'mouseup',
      () => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      },
      { passive: true },
    );

    document.addEventListener(
      'click',
      (e) => {
        if (suppressNextClick) {
          suppressNextClick = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }
}
