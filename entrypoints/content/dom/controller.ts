import { STREAM_PORT_NAME } from '../../background';
import {
  matchSiteRule,
  resolvePrimaryService,
} from '../../../src/storage';
import type {
  ExtensionSettings,
  PageTabState,
  PageViewMode,
  StreamPortClientMessage,
  StreamPortServerMessage,
} from '../../../src/types';
import {
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

  constructor(initialSettings: ExtensionSettings) {
    this.settings = initialSettings;
  }

  init(): void {
    ensureHostStyleSheet(
      document,
      this.settings.stylePreset,
      this.settings.fontScale,
    );
    document.documentElement.setAttribute('data-bo-view', this.mode);

    this.setupIntersectionObserver();
    this.setupMutationObserver();
    this.setupHoverAndHoldListeners();

    // Apply initial domain site rule after hydration settles
    const matchedRule = matchSiteRule(
      window.location.hostname,
      this.settings.siteRules,
    );
    if (matchedRule?.action === 'always-bilingual') {
      setTimeout(() => this.setMode('bilingual'), 280);
    } else if (matchedRule?.action === 'always-translated-only') {
      setTimeout(() => this.setMode('translated-only'), 280);
    }
  }

  updateSettings(next: ExtensionSettings): void {
    const prevStyle = this.settings.stylePreset;
    const prevScale = this.settings.fontScale;
    this.settings = next;

    if (prevStyle !== next.stylePreset || prevScale !== next.fontScale) {
      ensureHostStyleSheet(document, next.stylePreset, next.fontScale);
    }
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
    this.setMode(next);
    return next;
  }

  toggleTranslatedOnly(): PageViewMode {
    const next: PageViewMode =
      this.mode === 'translated-only' ? 'bilingual' : 'translated-only';
    this.setMode(next);
    return next;
  }

  setMode(nextMode: PageViewMode): void {
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
    );

    for (const handle of this.segments.values()) {
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
    const targetEl = findHoverTargetElement(this.lastMouseClient.target, {
      hostname: window.location.hostname,
      siteRule: matchSiteRule(window.location.hostname, this.settings.siteRules),
      targetLang: this.settings.targetLang,
    });
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
      if (this.mode === 'original') return;

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
    const siteRule = matchSiteRule(
      window.location.hostname,
      this.settings.siteRules,
    );
    const candidates = discoverCandidateElements(root, {
      hostname: window.location.hostname,
      siteRule,
      targetLang: this.settings.targetLang,
    });

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
    const siteRule = matchSiteRule(
      window.location.hostname,
      this.settings.siteRules,
    );
    const discovered = extractTranslatableSegmentsFromElement(hostEl, {
      hostname: window.location.hostname,
      siteRule,
      targetLang: this.settings.targetLang,
    });

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
          const candidate = findHoverTargetElement(e.target, {
            hostname: window.location.hostname,
            siteRule: matchSiteRule(
              window.location.hostname,
              this.settings.siteRules,
            ),
            targetLang: this.settings.targetLang,
          });
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
        const candidate = findHoverTargetElement(this.lastMouseClient.target, {
          hostname: window.location.hostname,
          siteRule: matchSiteRule(
            window.location.hostname,
            this.settings.siteRules,
          ),
          targetLang: this.settings.targetLang,
        });
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
          const candidate = findHoverTargetElement(target, {
            hostname: window.location.hostname,
            siteRule: matchSiteRule(
              window.location.hostname,
              this.settings.siteRules,
            ),
            targetLang: this.settings.targetLang,
          });
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
