import type { TargetLanguageCode } from '../../../src/types';
import { BO_TRANS_TAG, shouldSkipTextSegment } from './rules';

export interface CodeCommentMeta {
  leadingWs: string;
  prefix: string;
  body: string;
  suffix: string;
}

const DIRECTIVE_OR_PRAGMA_RE =
  /^(?:#!|eslint\b|tslint\b|prettier-ignore\b|stylelint\b|biome-ignore\b|oxlint\b|nolint\b|noinspection\b|#?\s*pragma\b|region\b|endregion\b|sourceMappingURL=|@ts-(?:ignore|expect-error|nocheck|check)\b|type:\s*ignore\b|noqa\b|coverage:\s*ignore|istanbul\s+ignore|c8\s+ignore|v8\s+ignore|vitest-environment\b|jest-environment\b|go:(?:generate|build|embed|noinline|nosplit|norace|linkname|uintptrescapes|wasmimport|cgo_\w+)\b|\+build\b|line\s+\S+:\d+$|clippy::|allow\(|deny\(|warn\(|#\[(?:allow|deny|warn|cfg|derive)\b|SPDX-License-Identifier:|fallthrough\b|falls?\s+through\b|-\*-\s*coding[:=]|coding[:=]\s*[-\w.]+|frozen_string_literal:|(?:vi|vim|ex):\s*(?:set\b|\S*=)|swiftlint:|checkstyle:|formatter:(?:off|on)\b|nullable\s+(?:enable|disable|restore)\b|@suppress\b|lint:)/i;

const COMMENTED_CODE_START_RE =
  /^(?:(?:const|let|var)\s+(?:[\w$]+\s*[=:;]|[{[])|function\s*(?:\*|\w+\s*\(|\()|import\s+(?:['"(]|[\w*{},\s]+from\s*['"]|[\w.*]+(?:\s+as\s+\w+)?\s*;?$)|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|interface\b|type\b|enum\b|async\b|\{|\*)|return(?:\s*;|\s+[\w$.]+\s*\(|\s*[{[\d'"`]|[^a-zA-Z\n]*;|.*[;{}()=+\-*/<>!&|])|if\s*\(|else\s*\{|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|catch\s*\(|console\.\w+\(|await\s+[\w.]+\(|def\s+\w+\s*\(|from\s+[\w.]+\s+import\b|package\s+[\w.]+|#include\s*[<"]|[\w$]+(?:\.[\w$]+)+\s*\([^)]*\)\s*;?$)/;

const LIVE_CODE_EDITOR_SELECTOR =
  '.monaco-editor, .cm-editor, .CodeMirror, #ace-editor, [contenteditable="true"]';

const CODE_COMMENT_CLASS_SELECTOR =
  '.pl-c, .token.comment, .hljs-comment, .c1, .cm, .cs';

const CODE_COMMENT_QUERY_SELECTOR = [
  '.blob-code .pl-c',
  '.blob-code-inner .pl-c',
  '.react-code-text .pl-c',
  '.react-file-line .pl-c',
  'pre .pl-c',
  '.highlight .pl-c',
  'pre .token.comment',
  '.prism-code .token.comment',
  'div[class^="codeBlockLines"] .token.comment',
  'pre .hljs-comment',
  '.highlight .hljs-comment',
  'pre .c1, pre .cm, pre .cs',
  '.highlight .c1, .highlight .cm, .highlight .cs',
].join(', ');

const SHIKI_COMMENT_SPAN_SELECTOR =
  'pre.shiki .line > span, [data-rehype-pretty-code-figure] [data-line] > span, [data-rehype-pretty-code-fragment] [data-line] > span, .vp-code .line > span';

export function isGitHubCodeHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase();
  return (
    clean === 'github.com' ||
    clean.endsWith('.github.com') ||
    clean === 'gist.github.com'
  );
}

function isDirectiveOrDivider(trimmed: string): boolean {
  if (!trimmed) return true;
  if (DIRECTIVE_OR_PRAGMA_RE.test(trimmed)) return true;
  if (/^@[a-zA-Z-]+$/.test(trimmed)) return true; // bare @override / @public
  if (/^[-=*_/#~]{3,}$/.test(trimmed)) return true; // visual divider comment
  return false;
}

function isHeuristicCodeLine(trimmed: string): boolean {
  if (COMMENTED_CODE_START_RE.test(trimmed)) {
    return true;
  }

  // High density of code punctuation with semicolon/brace ending and few natural words
  if (/[;{]$/.test(trimmed) && /[=(){}[\]]/.test(trimmed)) {
    const naturalWords = trimmed.match(/\b[a-zA-Z]{3,}\b/g) ?? [];
    if (naturalWords.length < 5) {
      return true;
    }
  }

  return false;
}

export function isLikelyCommentedOutCode(body: string): boolean {
  const trimmed = body.trim();
  return isDirectiveOrDivider(trimmed) || isHeuristicCodeLine(trimmed);
}

/**
 * Parses a syntax-highlighted comment node's raw text into delimiter prefix, prose body, and closing suffix.
 * Supports `//`, `///`, `//!`, `#`, `--`, `;`, `/* ... * /`, `* ...`, and `<!-- ... -->`.
 */
export function parseCodeCommentText(
  rawText: string,
  targetLang: TargetLanguageCode = 'zh-CN',
  options?: { skipCodeLikeComments?: boolean },
): CodeCommentMeta | null {
  if (!rawText || rawText.includes('\n')) {
    // Multi-line block comments in a single span: preserve only single-line or clean per-line comments
    // so vertical row count in code viewers never changes.
    const lines = rawText.split(/\r?\n/);
    if (lines.length > 1) {
      return null;
    }
  }

  const leadingMatch = /^(\s*)/.exec(rawText);
  const leadingWs = leadingMatch?.[1] ?? '';
  let rest = rawText.slice(leadingWs.length);
  if (!rest) return null;

  let prefix = '';
  let suffix = '';

  if (rest.startsWith('<!--')) {
    prefix = '<!--';
    rest = rest.slice(4);
    const endMatch = /(\s*-->\s*)$/.exec(rest);
    if (endMatch?.[1]) {
      suffix = endMatch[1];
      rest = rest.slice(0, -suffix.length);
    }
  } else if (rest.startsWith('/**') && !rest.startsWith('/***/')) {
    prefix = '/**';
    rest = rest.slice(3);
    const endMatch = /(\s*\*\/\s*)$/.exec(rest);
    if (endMatch?.[1]) {
      suffix = endMatch[1];
      rest = rest.slice(0, -suffix.length);
    }
  } else if (rest.startsWith('/*')) {
    prefix = '/*';
    rest = rest.slice(2);
    const endMatch = /(\s*\*\/\s*)$/.exec(rest);
    if (endMatch?.[1]) {
      suffix = endMatch[1];
      rest = rest.slice(0, -suffix.length);
    }
  } else {
    const linePrefixMatch = /^(?:\/\/[!\/]?|--|#|;|\*(?!\/))/.exec(rest);
    if (!linePrefixMatch) {
      return null;
    }
    prefix = linePrefixMatch[0];
    rest = rest.slice(prefix.length);
  }

  const body = rest.trim();
  if (!body || body.length < 3) return null;
  if (isDirectiveOrDivider(body)) return null;
  if ((options?.skipCodeLikeComments ?? true) && isHeuristicCodeLine(body)) {
    return null;
  }
  if (shouldSkipTextSegment(body, 'SPAN', targetLang)) return null;

  return {
    leadingWs,
    prefix,
    body,
    suffix,
  };
}

/**
 * Checks whether an element is a syntax-highlighted single-line comment span outside live editors.
 */
export function isCodeCommentElement(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest(LIVE_CODE_EDITOR_SELECTOR)) return false;
  try {
    if (el.matches(CODE_COMMENT_CLASS_SELECTOR)) {
      return !el.parentElement?.closest(CODE_COMMENT_CLASS_SELECTOR);
    }
    if (
      el.matches(SHIKI_COMMENT_SPAN_SELECTOR) &&
      el.children.length === 0 &&
      /^\s*(?:\/\/|\/\*|<!--|#\s)/.test(el.textContent ?? '')
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Finds top-level syntax-highlighted comment spans inside GitHub code / diff / Gist views
 * as well as Prism, Highlight.js, Pygments, and Shiki documentation code blocks.
 */
export function discoverGitHubCommentElements(
  root: Element | Document,
): HTMLElement[] {
  const results: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  const tryPush = (el: Element) => {
    if (!isCodeCommentElement(el)) return;
    if (seen.has(el)) return;
    if (el.querySelector(BO_TRANS_TAG)) return;
    if ((el.textContent ?? '').includes('\n')) return;
    seen.add(el);
    results.push(el);
  };

  try {
    if (root instanceof HTMLElement && isCodeCommentElement(root)) {
      tryPush(root);
      return results;
    }

    for (const el of Array.from(
      root.querySelectorAll(CODE_COMMENT_QUERY_SELECTOR),
    )) {
      tryPush(el);
    }
    for (const el of Array.from(
      root.querySelectorAll(SHIKI_COMMENT_SPAN_SELECTOR),
    )) {
      tryPush(el);
    }
  } catch {
    // ignore selector errors
  }

  return results;
}
