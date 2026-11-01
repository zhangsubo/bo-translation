import type { SiteRule, TargetLanguageCode } from '../../../src/types';
import {
  BO_TRANS_TAG,
  BO_UI_HOST_TAG,
  DEFAULT_IGNORE_SELECTOR,
  findBuiltinDomainRule,
  HARD_NON_CONTENT_TAGS,
  isKeepInlineElement,
  KNOWN_BLOCK_TAGS,
  KNOWN_INLINE_TAGS,
  shouldSkipTextSegment,
} from './rules';
import { type SerializedNodeGroup, serializeNodeGroup } from './serializer';

const displayBlockCache = new WeakMap<Element, boolean>();

const BLOCK_DISPLAY_VALUES = new Set([
  'block',
  'flex',
  'grid',
  'table',
  'table-row',
  'table-cell',
  'list-item',
  'flow-root',
]);

export function isBlockElement(el: Element): boolean {
  const tag = el.tagName;
  if (KNOWN_BLOCK_TAGS.has(tag)) return true;
  if (KNOWN_INLINE_TAGS.has(tag)) return false;

  const cached = displayBlockCache.get(tag ? el : el);
  if (cached !== undefined) return cached;

  let isBlock = false;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const display = window.getComputedStyle(el).display;
      isBlock = BLOCK_DISPLAY_VALUES.has(display);
    } catch {
      isBlock = false;
    }
  }
  displayBlockCache.set(el, isBlock);
  return isBlock;
}

export function buildCombinedIgnoreSelector(
  hostname: string,
  siteRule?: SiteRule,
): string {
  const builtin = findBuiltinDomainRule(hostname);
  const parts = [DEFAULT_IGNORE_SELECTOR];
  if (builtin?.extraIgnoreSelector) {
    parts.push(builtin.extraIgnoreSelector);
  }
  if (siteRule?.excludeSelectors?.trim()) {
    parts.push(siteRule.excludeSelectors.trim());
  }
  return parts.join(', ');
}

export function isIgnoredElement(
  el: Element,
  combinedIgnoreSelector: string,
): boolean {
  if (HARD_NON_CONTENT_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute('hidden')) return true;

  try {
    if (el.matches(combinedIgnoreSelector)) return true;
  } catch {
    // Fallback to default selector if user custom exclude selector has invalid syntax
    try {
      if (el.matches(DEFAULT_IGNORE_SELECTOR)) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

function hasDirectNonEmptyText(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim().length > 0) {
      return true;
    }
  }
  return false;
}

export interface DiscoveredSegment {
  hostEl: HTMLElement;
  nodes: ChildNode[];
  serialized: SerializedNodeGroup;
  isShortInline: boolean;
}

export interface ScanOptions {
  hostname: string;
  siteRule?: SiteRule;
  targetLang?: TargetLanguageCode;
}

/**
 * Discover candidate block elements within `root` using site rules or stack-based autoScan.
 */
export function discoverCandidateElements(
  root: Element | Document,
  options: ScanOptions,
): HTMLElement[] {
  const ignoreSelector = buildCombinedIgnoreSelector(
    options.hostname,
    options.siteRule,
  );
  const builtin = findBuiltinDomainRule(options.hostname);

  const explicitSelectors =
    options.siteRule?.customSelectors?.trim() ||
    (builtin && !builtin.autoScan ? builtin.selectors : undefined);

  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  const pushCandidate = (el: Element) => {
    if (!(el instanceof HTMLElement)) return;
    if (seen.has(el)) return;
    if (isIgnoredElement(el, ignoreSelector)) return;
    if (el.closest(ignoreSelector)) return;
    seen.add(el);
    candidates.push(el);
  };

  if (explicitSelectors) {
    try {
      if (root instanceof HTMLElement && root.matches(explicitSelectors)) {
        pushCandidate(root);
      }
      const matched = root.querySelectorAll(explicitSelectors);
      for (const el of Array.from(matched)) {
        pushCandidate(el);
      }
      return candidates;
    } catch {
      // Fall through to autoScan if selector is malformed
    }
  }

  // Determine scan roots
  let scanRoots: Element[] = [];
  if (root instanceof Document) {
    if (builtin?.rootsSelector) {
      const matchedRoots = Array.from(root.querySelectorAll(builtin.rootsSelector));
      scanRoots = matchedRoots.length > 0 ? matchedRoots : root.body ? [root.body] : [];
    } else if (root.body) {
      scanRoots = [root.body];
    }
  } else {
    scanRoots = [root];
  }

  // Explicit stack traversal (reverse push to preserve natural document order)
  const stack: Element[] = [...scanRoots].reverse();

  while (stack.length > 0) {
    const el = stack.pop()!;
    if (!(el instanceof HTMLElement)) continue;
    if (isIgnoredElement(el, ignoreSelector)) continue;
    if (isKeepInlineElement(el)) continue;

    const directText = hasDirectNonEmptyText(el);
    const children = Array.from(el.children).filter(
      (child) =>
        !HARD_NON_CONTENT_TAGS.has(child.tagName) &&
        child.tagName !== BO_TRANS_TAG.toUpperCase() &&
        child.tagName !== BO_UI_HOST_TAG.toUpperCase() &&
        !isIgnoredElement(child, ignoreSelector),
    );

    // Unwrap trivial single-child wrapper containers
    const firstChild = children[0];
    if (
      !directText &&
      children.length === 1 &&
      firstChild &&
      isBlockElement(firstChild) &&
      !isKeepInlineElement(firstChild)
    ) {
      stack.push(firstChild);
      continue;
    }

    const blockChildren = children.filter(
      (child) => isBlockElement(child) && !isKeepInlineElement(child),
    );
    const hasBlockChild = blockChildren.length > 0;
    const inlineContentChildren = children.filter(
      (child) => !isBlockElement(child) || isKeepInlineElement(child),
    );

    if ((directText || !hasBlockChild) && (directText || inlineContentChildren.length > 0)) {
      pushCandidate(el);
    }

    if (hasBlockChild) {
      for (let i = blockChildren.length - 1; i >= 0; i--) {
        const bc = blockChildren[i];
        if (bc) stack.push(bc);
      }
    }
  }

  return candidates;
}

/**
 * Split a candidate block element into contiguous inline runs (`nodeGroups`) so mixed blocks
 * such as `<li>Intro text<ul><li>Sub item</li></ul></li>` translate cleanly without clobbering children.
 */
export function extractTranslatableSegmentsFromElement(
  hostEl: HTMLElement,
  options: ScanOptions,
): DiscoveredSegment[] {
  const ignoreSelector = buildCombinedIgnoreSelector(
    options.hostname,
    options.siteRule,
  );
  const targetLang = options.targetLang ?? 'zh-CN';

  const groups: ChildNode[][] = [];
  let currentGroup: ChildNode[] = [];

  const flushGroup = () => {
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  };

  for (const child of Array.from(hostEl.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) continue;

    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName;

      // Skip already-injected translation nodes without breaking tracking, or break at them
      if (tag === BO_TRANS_TAG.toUpperCase() || tag === BO_UI_HOST_TAG.toUpperCase()) {
        flushGroup();
        continue;
      }

      if (HARD_NON_CONTENT_TAGS.has(tag)) {
        flushGroup();
        continue;
      }

      // Keep-inline elements (`<code>`, `a:has(code)`, `.katex`) stay inside the inline run!
      if (isKeepInlineElement(el)) {
        currentGroup.push(child);
        continue;
      }

      if (isIgnoredElement(el, ignoreSelector) || isBlockElement(el)) {
        flushGroup();
        continue;
      }
    }

    currentGroup.push(child);
  }
  flushGroup();

  const segments: DiscoveredSegment[] = [];

  for (const nodes of groups) {
    // Check if the node right after the last node in `nodes` is ALREADY a `<bo-trans>`!
    const lastNode = nodes[nodes.length - 1];
    if (!lastNode) continue;
    const nextSib = lastNode.nextSibling;
    if (
      nextSib &&
      nextSib.nodeType === Node.ELEMENT_NODE &&
      (nextSib as Element).tagName === BO_TRANS_TAG.toUpperCase()
    ) {
      continue;
    }

    const serialized = serializeNodeGroup(nodes);
    if (
      shouldSkipTextSegment(
        serialized.translatablePlainText,
        hostEl.tagName,
        targetLang,
      )
    ) {
      continue;
    }

    const isInteractiveHost =
      hostEl.tagName === 'A' ||
      hostEl.tagName === 'BUTTON' ||
      hostEl.tagName === 'SPAN' ||
      hostEl.tagName === 'LABEL';
    const isShortInline =
      isInteractiveHost && serialized.fullPlainText.length <= 24;

    segments.push({
      hostEl,
      nodes,
      serialized,
      isShortInline,
    });
  }

  return segments;
}

export function scanTranslatableSegments(
  root: Element | Document,
  options: ScanOptions,
): DiscoveredSegment[] {
  const candidates = discoverCandidateElements(root, options);
  const allSegments: DiscoveredSegment[] = [];
  for (const el of candidates) {
    allSegments.push(...extractTranslatableSegmentsFromElement(el, options));
  }
  return allSegments;
}

/**
 * Walk upward from a hovered DOM target to find the nearest meaningful translatable block.
 */
export function findHoverTargetElement(
  startTarget: EventTarget | null,
  options: ScanOptions,
): HTMLElement | null {
  if (!(startTarget instanceof Node)) return null;
  let el: HTMLElement | null =
    startTarget instanceof HTMLElement ? startTarget : startTarget.parentElement;

  const ignoreSelector = buildCombinedIgnoreSelector(
    options.hostname,
    options.siteRule,
  );

  // If hovering inside an existing `<bo-trans>`, return its parent host element!
  const existingWrapper = el?.closest(BO_TRANS_TAG);
  if (existingWrapper?.parentElement) {
    return existingWrapper.parentElement;
  }

  while (el && el !== document.body && el !== document.documentElement) {
    if (el.closest(BO_UI_HOST_TAG)) return null;
    if (isIgnoredElement(el, ignoreSelector) && !isKeepInlineElement(el)) {
      return null;
    }

    if (
      isBlockElement(el) ||
      el.tagName === 'A' ||
      el.tagName === 'P' ||
      el.tagName === 'LI' ||
      el.tagName === 'TD' ||
      el.tagName === 'TH' ||
      /^H[1-6]$/.test(el.tagName)
    ) {
      // Check if it already has a `<bo-trans>` child or has translatable segments
      if (el.querySelector(`:scope > ${ BO_TRANS_TAG }`)) {
        return el;
      }
      const segs = extractTranslatableSegmentsFromElement(el, options);
      if (segs.length > 0) {
        return el;
      }
    }

    el = el.parentElement;
  }

  return null;
}
