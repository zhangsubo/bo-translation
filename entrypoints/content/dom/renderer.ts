import {
  getEffectiveBackgroundColor,
  resolveAdaptiveTranslationColor,
} from '../../../src/dom-style/adaptive-contrast';
import type {
  PageViewMode,
  TranslationColorMode,
  TranslationStylePreset,
} from '../../../src/types';
import type { CodeCommentMeta } from './github-comments';
import { BO_SUBTITLE_HOST_TAG, BO_TRANS_TAG, BO_UI_HOST_TAG } from './rules';
import { restoreRichTranslation, type SerializedNodeGroup } from './serializer';
import {
  linkSiblingTypography,
  shouldMountWrapperAsSibling,
} from './typography-sync';

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
    (record.target.closest(BO_TRANS_TAG) ||
      record.target.closest(BO_UI_HOST_TAG) ||
      record.target.closest(BO_SUBTITLE_HOST_TAG))
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
          n.tagName === BO_UI_HOST_TAG.toUpperCase() ||
          n.tagName === BO_SUBTITLE_HOST_TAG.toUpperCase()),
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
  colorMode: TranslationColorMode = 'adaptive',
): void {
  const root = doc.documentElement;
  if (root) {
    root.setAttribute('data-bo-style', stylePreset);
    root.setAttribute('data-bo-color-mode', colorMode);
    root.style.setProperty('--bo-font-scale', String(fontScale));
  }

  if (doc.getElementById(HOST_STYLE_ID)) return;

  const styleEl = doc.createElement('style');
  styleEl.id = HOST_STYLE_ID;
  styleEl.textContent = `
[data-bo-host="true"]:not([data-bo-sibling-host="true"]) {
  -webkit-line-clamp: unset !important;
  line-clamp: unset !important;
}

[data-bo-stashed-host="true"] {
  display: none !important;
}

bo-trans.bo-trans-wrapper {
  font-family: inherit;
  font-weight: inherit;
  line-height: 1.65;
  letter-spacing: normal;
  text-transform: none;
  word-break: break-word;
}

bo-trans.bo-trans-wrapper[data-bo-sibling="true"] {
  display: block;
  margin-top: 0.28em;
}

bo-trans.bo-trans-wrapper[hidden] {
  display: none !important;
}

bo-trans .bo-trans-inner {
  font-size: calc(1em * var(--bo-font-scale, 0.96));
  transition: opacity 0.16s ease, filter 0.18s ease, color 0.16s ease;
}

:root[data-bo-color-mode="adaptive"][data-bo-view="bilingual"] bo-trans .bo-trans-inner,
:root[data-bo-color-mode="adaptive"][data-bo-view="original"] bo-trans .bo-trans-inner {
  color: var(--bo-adaptive-color, inherit);
}

/* GitHub inline code comment preservation (zero vertical line shift) */
bo-trans.bo-trans-wrapper[data-code-comment="true"] {
  display: inline !important;
  line-height: inherit !important;
}
bo-trans.bo-trans-wrapper[data-code-comment="true"] .bo-trans-sep {
  display: inline !important;
  opacity: 0.55;
  font-style: normal;
}
bo-trans.bo-trans-wrapper[data-code-comment="true"] .bo-trans-sep[hidden] {
  display: none !important;
}
bo-trans.bo-trans-wrapper[data-code-comment="true"] .bo-trans-inner {
  display: inline !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
  font-size: 0.96em;
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
  mountedAsSibling: boolean;
  codeCommentMeta?: CodeCommentMeta;
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

function cleanCodeCommentTranslation(
  raw: string,
  meta: CodeCommentMeta,
): string {
  let clean = raw.trim().replace(/\s*\r?\n\s*/g, ' ');
  if (meta.prefix && clean.startsWith(meta.prefix)) {
    clean = clean.slice(meta.prefix.length).trimStart();
  }
  const trimmedSuffix = meta.suffix.trim();
  if (trimmedSuffix && clean.endsWith(trimmedSuffix)) {
    clean = clean.slice(0, -trimmedSuffix.length).trimEnd();
  }
  return clean;
}

function syncCodeCommentDisplay(
  handle: RenderedSegmentHandle,
  pageMode: PageViewMode,
): void {
  const meta = handle.codeCommentMeta;
  if (!meta) return;
  if (handle.state !== 'done' && handle.state !== 'streaming') return;
  const clean = cleanCodeCommentTranslation(handle.translatedRaw, meta);
  if (!clean) return;

  const formatted =
    pageMode === 'translated-only' && handle.isOriginalStashed
      ? `${ meta.leadingWs }${ meta.prefix } ${ clean }${ meta.suffix }`
      : clean;

  if (handle.innerEl.textContent !== formatted) {
    withIgnoredMutations(handle.hostEl, () => {
      handle.innerEl.textContent = formatted;
    });
  }
}

export function applySegmentColorMode(
  handle: RenderedSegmentHandle,
  colorMode: TranslationColorMode = 'adaptive',
): void {
  if (colorMode === 'inherit') {
    handle.wrapperEl.style.removeProperty('--bo-adaptive-color');
    return;
  }
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return;
  }
  try {
    const sourceColor = window.getComputedStyle(handle.hostEl).color;
    const bgColor = getEffectiveBackgroundColor(handle.hostEl);
    const resolved = resolveAdaptiveTranslationColor(
      sourceColor,
      bgColor,
      colorMode,
    );
    if (resolved) {
      handle.wrapperEl.style.setProperty('--bo-adaptive-color', resolved);
    } else {
      handle.wrapperEl.style.removeProperty('--bo-adaptive-color');
    }
  } catch {
    handle.wrapperEl.style.removeProperty('--bo-adaptive-color');
  }
}

export function mountSegmentWrapper(params: {
  id: number;
  hostEl: HTMLElement;
  sourceNodes: ChildNode[];
  serialized: SerializedNodeGroup;
  isShortInline: boolean;
  targetLang: string;
  colorMode?: TranslationColorMode;
  codeCommentMeta?: CodeCommentMeta;
  onRetryClick: (id: number) => void;
}): RenderedSegmentHandle {
  const {
    id,
    hostEl,
    sourceNodes,
    serialized,
    isShortInline,
    targetLang,
    colorMode = 'adaptive',
    codeCommentMeta,
    onRetryClick,
  } = params;
  const doc = hostEl.ownerDocument;

  const mountedAsSibling =
    !codeCommentMeta && shouldMountWrapperAsSibling(hostEl, isShortInline);

  const wrapperEl = doc.createElement(BO_TRANS_TAG);
  wrapperEl.className = 'bo-trans-wrapper notranslate';
  wrapperEl.setAttribute('translate', 'no');
  wrapperEl.setAttribute('data-bo-seg-id', String(id));
  wrapperEl.setAttribute('data-state', 'loading');
  if (isShortInline || codeCommentMeta) {
    wrapperEl.setAttribute('data-short', 'true');
  }
  if (mountedAsSibling) {
    wrapperEl.setAttribute('data-bo-sibling', 'true');
  }
  if (codeCommentMeta) {
    wrapperEl.setAttribute('data-code-comment', 'true');
  }

  const sepEl =
    isShortInline || codeCommentMeta
      ? doc.createElement('span')
      : doc.createElement('br');
  sepEl.className = 'bo-trans-sep';
  if (codeCommentMeta) {
    sepEl.textContent = '  · ';
  } else if (isShortInline) {
    sepEl.textContent = ' ';
  }
  if (mountedAsSibling) {
    sepEl.hidden = true;
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
  if (mountedAsSibling) {
    const mutationRoot = hostEl.parentElement ?? hostEl;
    withIgnoredMutations(mutationRoot, () => {
      hostEl.setAttribute('data-bo-host', 'true');
      hostEl.setAttribute('data-bo-sibling-host', 'true');
      hostEl.after(wrapperEl);
    });
    linkSiblingTypography(wrapperEl, hostEl);
  } else {
    withIgnoredMutations(hostEl, () => {
      hostEl.setAttribute('data-bo-host', 'true');
      if (lastNode && lastNode.parentNode === hostEl) {
        lastNode.after(wrapperEl);
      } else {
        hostEl.appendChild(wrapperEl);
      }
    });
  }

  const handle: RenderedSegmentHandle = {
    id,
    hostEl,
    sourceNodes,
    serialized,
    isShortInline: Boolean(isShortInline || codeCommentMeta),
    mountedAsSibling,
    codeCommentMeta,
    wrapperEl,
    sepEl,
    innerEl,
    backupTemplate,
    state: 'loading',
    translatedRaw: '',
    isOriginalStashed: false,
  };

  applySegmentColorMode(handle, colorMode);
  return handle;
}

export function stashOriginalNodes(handle: RenderedSegmentHandle): void {
  if (handle.isOriginalStashed) return;
  if (handle.state !== 'done' && !handle.translatedRaw.trim()) return;

  if (handle.mountedAsSibling) {
    const mutationRoot = handle.hostEl.parentElement ?? handle.hostEl;
    withIgnoredMutations(mutationRoot, () => {
      handle.hostEl.setAttribute('data-bo-stashed-host', 'true');
      handle.isOriginalStashed = true;
    });
    return;
  }

  withIgnoredMutations(handle.hostEl, () => {
    for (const node of handle.sourceNodes) {
      if (node.parentNode === handle.hostEl) {
        handle.backupTemplate.content.appendChild(node);
      }
    }
    handle.sepEl.textContent = '';
    handle.sepEl.hidden = true;
    handle.isOriginalStashed = true;
  });
}

export function restoreOriginalNodes(handle: RenderedSegmentHandle): void {
  if (!handle.isOriginalStashed) return;

  if (handle.mountedAsSibling) {
    const mutationRoot = handle.hostEl.parentElement ?? handle.hostEl;
    withIgnoredMutations(mutationRoot, () => {
      handle.hostEl.removeAttribute('data-bo-stashed-host');
      handle.isOriginalStashed = false;
    });
    return;
  }

  withIgnoredMutations(handle.hostEl, () => {
    if (handle.wrapperEl.parentNode === handle.hostEl) {
      handle.wrapperEl.before(handle.backupTemplate.content);
    } else {
      handle.hostEl.prepend(handle.backupTemplate.content);
    }
    if (handle.codeCommentMeta) {
      handle.sepEl.textContent = '  · ';
    } else if (handle.isShortInline) {
      handle.sepEl.textContent = ' ';
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
    syncCodeCommentDisplay(handle, 'original');
    const mutationRoot = handle.mountedAsSibling
      ? handle.hostEl.parentElement ?? handle.hostEl
      : handle.hostEl;
    withIgnoredMutations(mutationRoot, () => {
      handle.wrapperEl.hidden = !handle.manualHoverVisible;
    });
    return;
  }

  const mutationRoot = handle.mountedAsSibling
    ? handle.hostEl.parentElement ?? handle.hostEl
    : handle.hostEl;
  withIgnoredMutations(mutationRoot, () => {
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

  syncCodeCommentDisplay(handle, pageMode);
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

  const mutationRoot = handle.mountedAsSibling
    ? handle.hostEl.parentElement ?? handle.hostEl
    : handle.hostEl;

  if (handle.codeCommentMeta) {
    const clean = cleanCodeCommentTranslation(rawTranslated, handle.codeCommentMeta);
    withIgnoredMutations(mutationRoot, () => {
      handle.wrapperEl.setAttribute('data-state', status);
      if (serviceMeta?.serviceName) {
        handle.wrapperEl.setAttribute('data-bo-service', serviceMeta.serviceName);
      }
      handle.innerEl.textContent = clean;
    });
    applyViewModeToSegment(handle, pageMode);
    return;
  }

  const richHtml = restoreRichTranslation(rawTranslated, handle.serialized);

  withIgnoredMutations(mutationRoot, () => {
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

  const mutationRoot = handle.mountedAsSibling
    ? handle.hostEl.parentElement ?? handle.hostEl
    : handle.hostEl;

  withIgnoredMutations(mutationRoot, () => {
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
