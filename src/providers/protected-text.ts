const OPAQUE_TOKEN_RE = /\{\{K?\d+\}\}/g;
const WRAPPER_TAG_RE = /<(\/?)(a\d+)>/gi;
const PROTECTED_SPLIT_RE = /(\{\{K?\d+\}\}|<\/?a\d+>|<br\s*\/?>)/gi;
const PROTECTED_EXACT_PART_RE = /^(?:\{\{K?\d+\}\}|<\/?a\d+>|<br\s*\/?>)$/i;

export function hasProtectedMarkers(text: string): boolean {
  OPAQUE_TOKEN_RE.lastIndex = 0;
  WRAPPER_TAG_RE.lastIndex = 0;
  return OPAQUE_TOKEN_RE.test(text) || WRAPPER_TAG_RE.test(text);
}

function countOccurrences(list: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of list) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

/**
 * Stage 1 Validator:
 * Ensures all opaque placeholders (`{{0}}`, `{{K0}}`) and inline wrapper tags (`<a0>...</a0>`)
 * from `sourceText` are preserved intact and balanced in `translatedText`, with no hallucinated tokens.
 */
export function validateProtectedTranslation(
  sourceText: string,
  translatedText: string,
): boolean {
  if (!translatedText || !translatedText.trim()) {
    return false;
  }

  if (!hasProtectedMarkers(sourceText)) {
    // Also reject if the model hallucinated stray {{0}} tokens that weren't in source
    OPAQUE_TOKEN_RE.lastIndex = 0;
    return !OPAQUE_TOKEN_RE.test(translatedText);
  }

  // 1. Validate opaque tokens ({{0}}, {{1}}, {{K0}}, ...)
  const srcOpaque = sourceText.match(OPAQUE_TOKEN_RE) ?? [];
  const outOpaque = translatedText.match(OPAQUE_TOKEN_RE) ?? [];

  const srcCounts = countOccurrences(srcOpaque);
  const outCounts = countOccurrences(outOpaque);

  // Reject any hallucinated opaque token not in source
  for (const token of outCounts.keys()) {
    if (!srcCounts.has(token)) {
      return false;
    }
  }
  // Every source opaque token must appear at least as many times as in source
  for (const [token, requiredCount] of srcCounts.entries()) {
    if ((outCounts.get(token) ?? 0) < requiredCount) {
      return false;
    }
  }

  // 2. Validate wrapper tag pairs (<a0>...</a0>)
  const srcOpenWrappers: string[] = [];
  let match: RegExpExecArray | null;
  WRAPPER_TAG_RE.lastIndex = 0;
  while ((match = WRAPPER_TAG_RE.exec(sourceText)) !== null) {
    const isClose = match[1] === '/';
    const tag = (match[2] ?? '').toLowerCase();
    if (!isClose && tag) {
      srcOpenWrappers.push(tag);
    }
  }

  if (srcOpenWrappers.length > 0) {
    const expectedSet = new Set(srcOpenWrappers);
    const stack: string[] = [];
    const closedSet = new Set<string>();

    WRAPPER_TAG_RE.lastIndex = 0;
    while ((match = WRAPPER_TAG_RE.exec(translatedText)) !== null) {
      const isClose = match[1] === '/';
      const tag = (match[2] ?? '').toLowerCase();
      if (!expectedSet.has(tag)) {
        // Hallucinated wrapper tag e.g. <a99>
        return false;
      }
      if (!isClose) {
        stack.push(tag);
      } else {
        const last = stack.pop();
        if (last !== tag) {
          // Mismatched or inverted nesting
          return false;
        }
        closedSet.add(tag);
      }
    }

    if (stack.length !== 0) {
      // Unclosed wrapper tag
      return false;
    }

    for (const reqTag of expectedSet) {
      if (!closedSet.has(reqTag)) {
        return false;
      }
    }
  }

  return true;
}

export interface ProseFragmentPlan {
  parts: string[];
  translatableIndices: number[];
  fragments: string[];
  redactedContext: string;
}

export function redactProtectedTokensForContext(sourceText: string): string {
  return sourceText
    .replace(OPAQUE_TOKEN_RE, '[CODE]')
    .replace(WRAPPER_TAG_RE, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stage 3 Splitter:
 * Splits a damaged rich-text segment around all protected tokens (`{{0}}`, `{{K0}}`, `<a0>`, `</a0>`, `<br>`)
 * so pure prose fragments can be translated without sending any placeholders to the model.
 */
export function splitIntoProseFragments(sourceText: string): ProseFragmentPlan {
  const parts = sourceText.split(PROTECTED_SPLIT_RE);
  const translatableIndices: number[] = [];
  const fragments: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (!part || PROTECTED_EXACT_PART_RE.test(part)) {
      continue;
    }
    // Only send fragments that actually contain at least one letter from any script
    if (!/\p{L}/u.test(part)) {
      continue;
    }
    translatableIndices.push(i);
    fragments.push(part.trim());
  }

  return {
    parts,
    translatableIndices,
    fragments,
    redactedContext: redactProtectedTokensForContext(sourceText),
  };
}

/**
 * Reassembles locally preserved protected markers with translated prose fragments,
 * preserving surrounding whitespace cleanly.
 */
export function reassembleProseFragments(
  plan: ProseFragmentPlan,
  translatedFragments: ReadonlyMap<number, string>,
): string {
  const nextParts = [...plan.parts];

  for (let fragIdx = 0; fragIdx < plan.translatableIndices.length; fragIdx++) {
    const partIndex = plan.translatableIndices[fragIdx]!;
    const originalPart = nextParts[partIndex] ?? '';
    const translated = translatedFragments.get(fragIdx)?.trim();
    if (!translated) {
      continue;
    }
    const leadingWs = /^\s*/u.exec(originalPart)?.[0] ?? '';
    const trailingWs = /\s*$/u.exec(originalPart)?.[0] ?? '';
    nextParts[partIndex] = `${ leadingWs }${ translated }${ trailingWs }`;
  }

  return nextParts.join('');
}
