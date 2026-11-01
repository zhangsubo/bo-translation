import type {
  PageViewMode,
  TranslationStylePreset,
} from '../../../src/types';
import { BO_TRANS_TAG, BO_UI_HOST_TAG } from './rules';
import { restoreRichTranslation, type SerializedNodeGroup } from './serializer';

const HOST_STYLE_ID = 'bo-trans-host-styles';

const ignoredMutationTargets = new WeakSet<Node>();

export function withIgnoredMutations<T>(target: Node, fn: () => T): T {
  ignoredMutationTargets.add(target);
  try {
    return fn();
  } finally {
    queueMicrotask(() => {
      ignoredMutationTargets.delete(target);
    });
  }
}

export function isIgnoredSelfMutation(record: MutationRecord): boolean {
  if (ignoredMutationTargets.has(record.target)) return true;
  if (
    record.target instanceof Element &&
    (record.target.closest(BO_TRANS_TAG) || record.target.closest(BO_UI_HOST_TAG))
  ) {
    return true;
  }

  const changedNodes = [
    ...Array.from(record.addedNodes),
    ...Array.from(record.removedNodes),
  ];
  if (
    changedNodes.length > 0 &&
    changedNodes.every(
      (n) =>
        n instanceof Element &&
        (n.tagName === BO_TRANS_TAG.toUpperCase() ||
          n.tagName === BO_UI_HOST_TAG.toUpperCase()),
    )
  ) {
    return true;
  }

  return false;
}

export function ensureHostStyleSheet(
  doc: Document = document,
  stylePreset: TranslationStylePreset = 'blockquote',
  fontScale = 0.96,
): void {
  const root = doc.documentElement;
  if (root) {
    root.setAttribute('data-bo-style', stylePreset);
    root.style.setProperty('--bo-font-scale', String(fontScale));
  }

  if (doc.getElementById(HOST_STYLE_ID)) return;

  const styleEl = doc.createElement('style');
  styleEl.id = HOST_STYLE_ID;
  styleEl.textContent = `
[data-bo-host="true"] {
  -webkit-line-clamp: unset !important;
  line-clamp: unset !important;
}

bo-trans.bo-trans-wrapper {
  font-family: inherit;
  font-weight: inherit;
  line-height: 1.65;
  letter-spacing: normal;
  text-transform: none;
  word-break: break-word;
}

bo-trans.bo-trans-wrapper[hidden] {
  display: none !important;
}

bo-trans .bo-trans-inner {
  font-size: calc(1em * var(--bo-font-scale, 0.96));
  transition: opacity 0.16s ease, filter 0.18s ease;
}

/* Style 1: Default Clean */
:root[data-bo-style="default"] bo-trans:not([data-short="true"]) .bo-trans-inner {
  display: inline-block;
  margin-top: 0.28em;
}

/* Style 2: Muted Secondary */
:root[data-bo-style="muted"] bo-trans .bo-trans-inner {
  display: inline-block;
  margin-top: 0.28em;
  opacity: 0.74;
}

/* Style 3: Blockquote Technical Doc (Default) */
:root[data-bo-style="blockquote"] bo-trans:not([data-short="true"]) .bo-trans-sep {
  display: none;
}
:root[data-bo-style="blockquote"] bo-trans:not([data-short="true"]) .bo-trans-inner {
  display: block;
  margin: 0.42em 0 0.25em 0;
  padding: 0.28em 0.68em;
  border-left: 3px solid rgba(59, 130, 246, 0.72);
  background: rgba(59, 130, 246, 0.055);
  border-radius: 0 6px 6px 0;
}
:root[data-bo-view="translated-only"][data-bo-style="blockquote"] bo-trans:not([data-short="true"]) .bo-trans-inner {
  margin: 0;
  padding: 0;
  border-left: none;
  background: transparent;
}

/* Style 4: Dashed Underline */
:root[data-bo-style="dashed"] bo-trans .bo-trans-inner {
  text-decoration: underline dashed rgba(59, 130, 246, 0.65);
  text-underline-offset: 0.3em;
  text-decoration-thickness: 1px;
}

/* Style 5: Soft Marker Highlight */
:root[data-bo-style="marker"] bo-trans .bo-trans-inner {
  background: linear-gradient(to top, rgba(250, 204, 21, 0.24) 38%, transparent 38%);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

/* Style 6: Blur Mask until Hover */
:root[data-bo-style="mask"] bo-trans[data-state="done"] .bo-trans-inner {
  filter: blur(5px);
  cursor: pointer;
}
:root[data-bo-style="mask"] bo-trans[data-state="done"]:hover .bo-trans-inner {
  filter: none;
}

/* Loading pulse */
bo-trans[data-state="loading"] .bo-trans-loading {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.55;
  font-size: 0.85em;
  user-select: none;
}
bo-trans .bo-trans-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  animation: bo-trans-pulse 1.1s infinite ease-in-out;
}
bo-trans .bo-trans-dot:nth-child(2) { animation-delay: 0.2s; }
bo-trans .bo-trans-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes bo-trans-pulse {
  0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
  40% { opacity: 0.9; transform: scale(1.1); }
}

/* Inline Retry Pill */
bo-trans .bo-trans-retry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 0.25em;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.25);
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
}
bo-trans .bo-trans-retry:hover {
  background: rgba(220, 38, 38, 0.14);
}
`;
  (doc.head || doc.documentElement).appendChild(styleEl);
}

export interface RenderedSegmentHandle {
  id: number;
  hostEl: HTMLElement;
  sourceNodes: ChildNode[];
  serialized: SerializedNodeGroup;
  isShortInline: boolean;
  wrapperEl: HTMLElement;
  sepEl: HTMLElement;
  innerEl: HTMLElement;
  backupTemplate: HTMLTemplateElement;
  state: 'idle' | 'loading' | 'streaming' | 'done' | 'error';
  translatedRaw: string;
  serviceId?: string;
  serviceName?: string;
  isOriginalStashed: boolean;
  manualHoverVisible?: boolean;
}

export function mountSegmentWrapper(params: {
  id: number;
  hostEl: HTMLElement;
  sourceNodes: ChildNode[];
  serialized: SerializedNodeGroup;
  isShortInline: boolean;
  targetLang: string;
  onRetryClick: (id: number) => void;
}): RenderedSegmentHandle {
  const { id, hostEl, sourceNodes, serialized, isShortInline, targetLang, onRetryClick } =
    params;
  const doc = hostEl.ownerDocument;

  const wrapperEl = doc.createElement(BO_TRANS_TAG);
  wrapperEl.className = 'bo-trans-wrapper notranslate';
  wrapperEl.setAttribute('translate', 'no');
  wrapperEl.setAttribute('data-bo-seg-id', String(id));
  wrapperEl.setAttribute('data-state', 'loading');
  if (isShortInline) {
    wrapperEl.setAttribute('data-short', 'true');
  }

  const sepEl = isShortInline
    ? doc.createElement('span')
    : doc.createElement('br');
  sepEl.className = 'bo-trans-sep';
  if (isShortInline) {
    sepEl.textContent = ' ';
  }

  const innerEl = doc.createElement('font');
  innerEl.className = 'bo-trans-inner';
  innerEl.setAttribute('lang', targetLang);
  innerEl.innerHTML =
    '<span class="bo-trans-loading"><span class="bo-trans-dot"></span><span class="bo-trans-dot"></span><span class="bo-trans-dot"></span></span>';

  const backupTemplate = doc.createElement('template');
  backupTemplate.className = 'bo-trans-backup';

  wrapperEl.append(sepEl, innerEl, backupTemplate);

  wrapperEl.addEventListener('click', (e) => {
    const retryTarget = (e.target as Element | null)?.closest('.bo-trans-retry');
    if (retryTarget) {
      e.preventDefault();
      e.stopPropagation();
      onRetryClick(id);
    }
  });

  const lastNode = sourceNodes[sourceNodes.length - 1];
  withIgnoredMutations(hostEl, () => {
    hostEl.setAttribute('data-bo-host', 'true');
    if (lastNode && lastNode.parentNode === hostEl) {
      lastNode.after(wrapperEl);
    } else {
      hostEl.appendChild(wrapperEl);
    }
  });

  return {
    id,
    hostEl,
    sourceNodes,
    serialized,
    isShortInline,
    wrapperEl,
    sepEl,
    innerEl,
    backupTemplate,
    state: 'loading',
    translatedRaw: '',
    isOriginalStashed: false,
  };
}

export function stashOriginalNodes(handle: RenderedSegmentHandle): void {
  if (handle.isOriginalStashed) return;
  if (handle.state !== 'done' && !handle.translatedRaw.trim()) return;

  withIgnoredMutations(handle.hostEl, () => {
    for (const node of handle.sourceNodes) {
      if (node.parentNode === handle.hostEl) {
        handle.backupTemplate.content.appendChild(node);
      }
    }
    handle.sepEl.hidden = true;
    handle.isOriginalStashed = true;
  });
}

export function restoreOriginalNodes(handle: RenderedSegmentHandle): void {
  if (!handle.isOriginalStashed) return;

  withIgnoredMutations(handle.hostEl, () => {
    if (handle.wrapperEl.parentNode === handle.hostEl) {
      handle.wrapperEl.before(handle.backupTemplate.content);
    } else {
      handle.hostEl.prepend(handle.backupTemplate.content);
    }
    handle.sepEl.hidden = false;
    handle.isOriginalStashed = false;
  });
}

export function applyViewModeToSegment(
  handle: RenderedSegmentHandle,
  pageMode: PageViewMode,
): void {
  if (pageMode === 'original') {
    restoreOriginalNodes(handle);
    withIgnoredMutations(handle.hostEl, () => {
      handle.wrapperEl.hidden = !handle.manualHoverVisible;
    });
    return;
  }

  withIgnoredMutations(handle.hostEl, () => {
    handle.wrapperEl.hidden = false;
  });

  if (pageMode === 'translated-only') {
    if (handle.state === 'done' || (handle.state === 'streaming' && handle.translatedRaw.trim())) {
      stashOriginalNodes(handle);
    } else {
      restoreOriginalNodes(handle);
    }
  } else {
    restoreOriginalNodes(handle);
  }
}

export function updateSegmentTranslation(
  handle: RenderedSegmentHandle,
  rawTranslated: string,
  status: 'streaming' | 'done',
  pageMode: PageViewMode,
  serviceMeta?: { serviceId: string; serviceName: string },
): void {
  handle.translatedRaw = rawTranslated;
  handle.state = status;
  if (serviceMeta) {
    handle.serviceId = serviceMeta.serviceId;
    handle.serviceName = serviceMeta.serviceName;
  }

  const richHtml = restoreRichTranslation(rawTranslated, handle.serialized);

  withIgnoredMutations(handle.hostEl, () => {
    handle.wrapperEl.setAttribute('data-state', status);
    if (serviceMeta?.serviceName) {
      handle.wrapperEl.setAttribute('data-bo-service', serviceMeta.serviceName);
    }
    handle.innerEl.innerHTML = richHtml;
  });

  applyViewModeToSegment(handle, pageMode);
}

export function markSegmentError(
  handle: RenderedSegmentHandle,
  errorMessage: string,
): void {
  handle.state = 'error';
  restoreOriginalNodes(handle);

  const safeMsg = errorMessage
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  withIgnoredMutations(handle.hostEl, () => {
    handle.wrapperEl.setAttribute('data-state', 'error');
    handle.innerEl.innerHTML = `<span class="bo-trans-retry" title="${ safeMsg }">⚠ 翻译失败 · 点击重试</span>`;
  });
}

/**
 * Compensate scroll position when above-the-fold DOM expansion pushes the user's reading line down.
 */
export function withViewportScrollAnchor(fn: () => void): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    fn();
    return;
  }

  let anchorEl: Element | null = null;
  let beforeTop = 0;

  try {
    const probeX = Math.min(window.innerWidth * 0.45, 480);
    const probeY = Math.min(120, window.innerHeight * 0.25);
    if (typeof document.elementFromPoint === 'function' && probeX > 0 && probeY > 0) {
      const hit = document.elementFromPoint(probeX, probeY);
      if (hit && !hit.closest(BO_UI_HOST_TAG)) {
        anchorEl = hit.closest('[data-bo-host="true"]') ?? hit;
        beforeTop = anchorEl.getBoundingClientRect().top;
      }
    }
  } catch {
    anchorEl = null;
  }

  fn();

  if (anchorEl && anchorEl.isConnected) {
    const afterTop = anchorEl.getBoundingClientRect().top;
    const delta = afterTop - beforeTop;
    if (Math.abs(delta) > 1 && window.scrollY > 20) {
      window.scrollBy(0, delta);
    }
  }
}
