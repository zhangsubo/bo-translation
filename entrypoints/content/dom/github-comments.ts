import type { TargetLanguageCode } from '../../../src/types';
import { BO_TRANS_TAG, shouldSkipTextSegment } from './rules';

export interface CodeCommentMeta {
  leadingWs: string;
  prefix: string;
  body: string;
  suffix: string;
}

const DIRECTIVE_OR_PRAGMA_RE =
  /^(?:#!|eslint\b|tslint\b|prettier-ignore\b|stylelint\b|biome-ignore\b|oxlint\b|nolint\b|noinspection\b|pragma\b|region\b|endregion\b|sourceMappingURL=|@ts-(?:ignore|expect-error|nocheck|check)\b|type:\s*ignore\b|noqa\b|coverage:\s*ignore|istanbul\s+ignore|c8\s+ignore|v8\s+ignore|vitest-environment\b|jest-environment\b|go:generate\b|clippy::|allow\(|deny\(|warn\(|SPDX-License-Identifier:)/i;

const COMMENTED_CODE_START_RE =
  /^(?:const|let|var|function|import|export|return|if\s*\(|else\s*\{|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|catch\s*\(|console\.\w+\(|await\s+[\w.]+\(|def\s+\w+\s*\(|from\s+[\w.]+\s+import\b|package\s+[\w.]+|#include\s*[<"])/;

export function isGitHubCodeHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase();
  return (
    clean === 'github.com' ||
    clean.endsWith('.github.com') ||
    clean === 'gist.github.com'
  );
}

export function isLikelyCommentedOutCode(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  if (DIRECTIVE_OR_PRAGMA_RE.test(trimmed)) return true;
  if (/^@[a-zA-Z-]+$/.test(trimmed)) return true; // bare @override / @public
  if (/^[-=*_/#~]{3,}$/.test(trimmed)) return true; // visual divider comment

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

/**
 * Parses a syntax-highlighted comment node's raw text into delimiter prefix, prose body, and closing suffix.
 * Supports `//`, `///`, `//!`, `#`, `--`, `;`, `/* ... * /`, `* ...`, and `<!-- ... -->`.
 */
export function parseCodeCommentText(
  rawText: string,
  targetLang: TargetLanguageCode = 'zh-CN',
): CodeCommentMeta | null {
  if (!rawText || rawText.includes('\n')) {
    // Multi-line block comments in a single span: preserve only single-line or clean per-line comments
    // so vertical row count in GitHub's code viewer never changes.
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
  if (isLikelyCommentedOutCode(body)) return null;
  if (shouldSkipTextSegment(body, 'SPAN', targetLang)) return null;

  return {
    leadingWs,
    prefix,
    body,
    suffix,
  };
}

/**
 * Finds top-level `.pl-c` syntax-highlighted comment spans inside GitHub code / diff / Gist views.
 */
export function discoverGitHubCommentElements(
  root: Element | Document,
): HTMLElement[] {
  const results: HTMLElement[] = [];
  const selector =
    '.blob-code .pl-c, .blob-code-inner .pl-c, .react-code-text .pl-c, .react-file-line .pl-c, pre .pl-c, .highlight .pl-c';

  try {
    if (
      root instanceof HTMLElement &&
      root.classList.contains('pl-c') &&
      !root.parentElement?.closest('.pl-c')
    ) {
      results.push(root);
      return results;
    }

    const matched = root.querySelectorAll<HTMLElement>(selector);
    for (const el of Array.from(matched)) {
      // Skip nested `.pl-c` delimiter spans inside an outer `.pl-c`
      if (el.parentElement?.closest('.pl-c')) continue;
      // Skip if already translated
      if (el.querySelector(BO_TRANS_TAG)) continue;
      results.push(el);
    }
  } catch {
    // ignore selector errors
  }

  return results;
}
