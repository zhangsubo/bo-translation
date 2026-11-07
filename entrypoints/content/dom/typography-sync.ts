const TYPOGRAPHY_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-align',
] as const;

const BOX_ALIGNMENT_PROPS = [
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
] as const;

const STRUCTURAL_PARENT_TAGS = new Set([
  'TR',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TABLE',
  'UL',
  'OL',
  'DL',
  'SELECT',
]);

const siblingSourceMap = new Map<HTMLElement, HTMLElement>();
const observedSources = new Set<HTMLElement>();
let resizeObserver: ResizeObserver | null = null;
let rafId: number | null = null;
let listenersBound = false;

/**
 * Detects when `hostEl` uses `-webkit-line-clamp`, `overflow: hidden` + `nowrap`/`ellipsis`,
 * or a tight fixed `max-height` that would clip an appended child `<bo-trans>` inside `hostEl`.
 * In those cases, inserting `<bo-trans>` as an adjacent sibling preserves full readability.
 */
export function shouldMountWrapperAsSibling(
  hostEl: HTMLElement,
  isShortInline: boolean,
): boolean {
  if (isShortInline) return false;
  const parent = hostEl.parentElement;
  if (!parent || STRUCTURAL_PARENT_TAGS.has(parent.tagName)) {
    return false;
  }

  // Explicit inline or utility classes common on modern blog cards (Tailwind `line-clamp-*`, `truncate`)
  const cls = typeof hostEl.className === 'string' ? hostEl.className : '';
  const hasClampClass = /\b(?:line-clamp-[1-9]|truncate)\b/.test(cls);

  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return hasClampClass;
  }

  try {
    const cs = window.getComputedStyle(hostEl);
    const overflowY = cs.overflowY || cs.overflow || '';
    const overflowX = cs.overflowX || cs.overflow || '';
    const isClipped =
      overflowY === 'hidden' ||
      overflowY === 'clip' ||
      overflowX === 'hidden' ||
      overflowX === 'clip';

    const webkitClamp =
      cs.getPropertyValue('-webkit-line-clamp') ||
      cs.getPropertyValue('line-clamp') ||
      '';
    if (
      webkitClamp &&
      webkitClamp !== 'none' &&
      webkitClamp !== 'unset' &&
      Number.parseInt(webkitClamp, 10) > 0
    ) {
      return true;
    }

    if (hasClampClass) {
      return true;
    }

    if (isClipped) {
      if (cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis') {
        return true;
      }
      const maxH = cs.maxHeight;
      if (maxH && maxH.endsWith('px')) {
        const px = Number.parseFloat(maxH);
        if (Number.isFinite(px) && px > 0 && px <= 140) {
          return true;
        }
      }
    }
  } catch {
    return hasClampClass;
  }

  return false;
}

export function syncComputedTypographyOnce(
  wrapperEl: HTMLElement,
  sourceEl: HTMLElement,
): void {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return;
  }
  try {
    const cs = window.getComputedStyle(sourceEl);
    for (const prop of TYPOGRAPHY_PROPS) {
      const val = cs.getPropertyValue(prop);
      if (val) {
        wrapperEl.style.setProperty(prop, val);
      }
    }
    for (const prop of BOX_ALIGNMENT_PROPS) {
      const val = cs.getPropertyValue(prop);
      if (val && val !== '0px') {
        wrapperEl.style.setProperty(prop, val);
      }
    }
  } catch {
    // ignore detached elements
  }
}

function scheduleRefresh(): void {
  if (rafId !== null) return;
  const run = () => {
    rafId = null;
    for (const [wrapper, source] of siblingSourceMap.entries()) {
      if (!wrapper.isConnected || !source.isConnected) {
        siblingSourceMap.delete(wrapper);
        continue;
      }
      syncComputedTypographyOnce(wrapper, source);
    }
    if (siblingSourceMap.size === 0) {
      clearAllSiblingTypography();
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(run);
  } else {
    run();
  }
}

export function linkSiblingTypography(
  wrapperEl: HTMLElement,
  sourceEl: HTMLElement,
): void {
  siblingSourceMap.set(wrapperEl, sourceEl);
  syncComputedTypographyOnce(wrapperEl, sourceEl);

  if (typeof window !== 'undefined' && !listenersBound) {
    listenersBound = true;
    window.addEventListener('resize', scheduleRefresh, { passive: true });
    document.fonts?.addEventListener?.('loadingdone', scheduleRefresh);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleRefresh());
    }
  }

  if (resizeObserver && !observedSources.has(sourceEl)) {
    observedSources.add(sourceEl);
    resizeObserver.observe(sourceEl);
  }
}

export function unlinkSiblingTypography(wrapperEl: HTMLElement): void {
  siblingSourceMap.delete(wrapperEl);
}

export function clearAllSiblingTypography(): void {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId);
  }
  rafId = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (typeof window !== 'undefined' && listenersBound) {
    window.removeEventListener('resize', scheduleRefresh);
    document.fonts?.removeEventListener?.('loadingdone', scheduleRefresh);
    listenersBound = false;
  }
  siblingSourceMap.clear();
  observedSources.clear();
}
