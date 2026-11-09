export interface RawPdfTextItem {
  str: string;
  dir?: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

export interface RawPdfTextStyle {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
  fontFamily?: string;
}

export interface RawPdfFontMeta {
  name?: string;
  fallbackName?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PdfFontCategory = 'serif' | 'sans-serif' | 'monospace';
export type PdfTextAlign = 'left' | 'center' | 'right' | 'justify';

export interface PdfTextBlock {
  id: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  maxHeightBudget: number;
  fontSize: number;
  lineHeightRatio: number;
  fontFamily: PdfFontCategory;
  isBold: boolean;
  isItalic: boolean;
  align: PdfTextAlign;
  firstLineIndent: number;
  lineRects: PdfRect[];
  translatable: boolean;
  fgColor?: string;
  bgColor?: string;
}

export interface PdfPageLayout {
  pageWidth: number;
  pageHeight: number;
  blocks: PdfTextBlock[];
  recognizedChars: number;
}

export interface TextRecognitionSummary {
  hasRecognizableText: boolean;
  recognizableChars: number;
  garbledRatio: number;
}

/**
 * Checks if a URL points to a PDF resource (local file or online URL, including ArXiv `/pdf/...`).
 */
export function isPdfUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'chrome-extension:' && u.pathname.endsWith('/pdf.html')) {
      return false;
    }
    const path = u.pathname.toLowerCase();
    if (path.endsWith('.pdf')) return true;
    if (/^\/pdf\/[^/]+$/i.test(path)) return true;
    if (path === '/pdf' && u.searchParams.has('id')) return true;
    return false;
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(rawUrl);
  }
}

/**
 * Detects whether the current browser tab document is Chrome's native PDF viewer wrapper.
 */
export function isBrowserPdfDocument(doc: Document, rawUrl: string): boolean {
  if (doc.contentType === 'application/pdf') return true;
  if (
    doc.querySelector(
      'body > embed[type="application/pdf"], embed#plugin[type="application/pdf"]',
    )
  ) {
    return true;
  }
  if (isPdfUrl(rawUrl) && !doc.querySelector('article, main, p, h1')) {
    return true;
  }
  return false;
}

function isGarbledCodePoint(cp: number): boolean {
  return (
    cp === 0xfffd ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd) ||
    (cp >= 0x00 && cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)
  );
}

/**
 * Evaluates whether sampled PDF page strings contain genuine extractable text
 * (filtering out pure scanned image PDFs and broken missing-ToUnicode PUA PDFs).
 */
export function analyzeRecognizableText(
  pageSamples: string[],
): TextRecognitionSummary {
  let recognizableChars = 0;
  let garbledChars = 0;

  for (const sample of pageSamples) {
    for (const ch of sample) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isGarbledCodePoint(cp)) {
        garbledChars++;
      } else if (/[\p{L}\p{N}]/u.test(ch)) {
        recognizableChars++;
      }
    }
  }

  const total = recognizableChars + garbledChars;
  const garbledRatio = total > 0 ? garbledChars / total : 0;
  const hasRecognizableText = recognizableChars >= 8 && garbledRatio <= 0.55;

  return {
    hasRecognizableText,
    recognizableChars,
    garbledRatio,
  };
}

function multiplyTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0]! * m2[0]! + m1[2]! * m2[1]!,
    m1[1]! * m2[0]! + m1[3]! * m2[1]!,
    m1[0]! * m2[2]! + m1[2]! * m2[3]!,
    m1[1]! * m2[2]! + m1[3]! * m2[3]!,
    m1[0]! * m2[4]! + m1[2]! * m2[5]! + m1[4]!,
    m1[1]! * m2[4]! + m1[3]! * m2[5]! + m1[5]!,
  ];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function isCjkChar(ch: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    ch,
  );
}

function classifyFontFamily(
  styleFamily = '',
  fontName = '',
  fallbackName = '',
): PdfFontCategory {
  const combined = `${ fontName } ${ fallbackName } ${ styleFamily }`.toLowerCase();
  if (
    /mono|courier|consolas|menlo|monaco|code|typewriter|cmtt|inconsolata|fira\s*code/.test(
      combined,
    )
  ) {
    return 'monospace';
  }
  if (
    /sans|arial|helvetica|calibri|verdana|tahoma|inter|roboto|segoe|pingfang|hei|gothic|cmss|avenir|optima|franklin/.test(
      combined,
    )
  ) {
    return 'sans-serif';
  }
  if (
    /serif|times|georgia|garamond|cambria|palatino|minion|caslon|cmr|cmbx|cmti|song|ming|baskerville/.test(
      combined,
    )
  ) {
    return 'serif';
  }
  return 'serif';
}

/**
 * Determines whether an extracted block contains natural prose/headings worth translating
 * rather than standalone math equations, page numbers, citations, or URLs.
 */
export function isTranslatablePdfText(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;

  if (/^(https?:\/\/|www\.|doi:|arxiv:|mailto:)\S+$/i.test(text)) {
    return false;
  }

  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  if (cjkCount >= 2) return true;

  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 2) return false;

  // Reject pure reference markers like "[12]", "(3a)", "Fig." numbers, or page counters
  if (/^[\[(]?\d+[a-z]?[\])]?\.?$/i.test(text)) return false;

  // Check math / formula density: display equations have many math symbols & single-letter tokens
  const multiLetterWords = text.match(/\p{L}{3,}/gu) ?? [];
  const twoLetterWords = text.match(/\b\p{L}{2}\b/gu) ?? [];
  const mathSymbols = (
    text.match(/[=+−×÷∑∏∫∂∇√∞≈≠≤≥∈∉⊂⊆∪∩∀∃⇒⇔±·∗^_{}|\\<>]/gu) ?? []
  ).length;

  if (multiLetterWords.length === 0 && twoLetterWords.length < 2) {
    return false;
  }
  if (mathSymbols >= 3 && multiLetterWords.length <= 1) {
    return false;
  }
  if (mathSymbols > letters.length * 0.35 && multiLetterWords.length < 3) {
    return false;
  }

  return true;
}

interface PositionedRun {
  str: string;
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  baseline: number;
  fontSize: number;
  fontFamily: PdfFontCategory;
  isBold: boolean;
  isItalic: boolean;
}

interface VisualLine {
  text: string;
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  baseline: number;
  fontSize: number;
  fontFamily: PdfFontCategory;
  isBold: boolean;
  isItalic: boolean;
}

function joinLineStrings(prev: string, next: string): string {
  const trimmedPrev = prev.trimEnd();
  const trimmedNext = next.trimStart();
  if (!trimmedPrev) return trimmedNext;
  if (!trimmedNext) return trimmedPrev;

  // De-hyphenate soft line-wrapped English words (e.g. "trans-\nformer" -> "transformer")
  if (/[a-z]{2,}-$/i.test(trimmedPrev) && /^[a-z]/i.test(trimmedNext)) {
    // Keep hyphen for common capitalized prefixes like "Self-attention" or "Pre-trained"
    const stemMatch = trimmedPrev.match(/([A-Za-z]+)-$/);
    const stem = stemMatch?.[1]?.toLowerCase() ?? '';
    const keepHyphenPrefixes = new Set([
      'self',
      'non',
      'pre',
      'post',
      'multi',
      'cross',
      'co',
      'sub',
      'inter',
      'intra',
      'semi',
      'anti',
      'high',
      'low',
      'real',
      'zero',
      'few',
      'one',
      'two',
      'fine',
      'open',
      'end',
    ]);
    if (!keepHyphenPrefixes.has(stem) && /^[a-z]/.test(trimmedNext)) {
      return `${ trimmedPrev.slice(0, -1) }${ trimmedNext }`;
    }
    return `${ trimmedPrev }${ trimmedNext }`;
  }

  const lastCh = trimmedPrev[trimmedPrev.length - 1]!;
  const firstCh = trimmedNext[0]!;
  if (isCjkChar(lastCh) && isCjkChar(firstCh)) {
    return `${ trimmedPrev }${ trimmedNext }`;
  }
  return `${ trimmedPrev } ${ trimmedNext }`;
}

function startsNewSemanticItem(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^([•●▪◦▪▸►\-–—*]|\(\d+\)|\(\w\)|\d{1,2}[.)]\s|[A-Z]\.\s)/.test(t)) {
    return true;
  }
  if (
    /^(Abstract|Introduction|Conclusion|Conclusions|References|Acknowledgments|Acknowledgements|Appendix|Figure\s+\d+|Fig\.\s*\d+|Table\s+\d+|Algorithm\s+\d+)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

interface ActiveParagraph {
  lines: VisualLine[];
  x: number;
  y: number;
  right: number;
  bottom: number;
  bodyLeftX: number;
  firstLineIndent: number;
  fontSizeSum: number;
  baselineSteps: number[];
  boldChars: number;
  italicChars: number;
  totalChars: number;
  familyCounts: Record<PdfFontCategory, number>;
}

function sortBlocksInReadingOrder(
  blocks: PdfTextBlock[],
  pageWidth: number,
): PdfTextBlock[] {
  if (blocks.length <= 1) return blocks;

  const sortedByY = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const isSpanning = (b: PdfTextBlock) =>
    b.width > pageWidth * 0.56 ||
    (b.x < pageWidth * 0.42 && b.x + b.width > pageWidth * 0.58);

  const result: PdfTextBlock[] = [];
  let bucket: PdfTextBlock[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    if (bucket.length === 1) {
      result.push(bucket[0]!);
      bucket = [];
      return;
    }

    // Group horizontally overlapping blocks into columns, then read columns left-to-right
    const columns: Array<{ minX: number; maxX: number; items: PdfTextBlock[] }> = [];
    for (const blk of bucket) {
      const blkRight = blk.x + blk.width;
      const col = columns.find((c) => {
        const overlap = Math.min(c.maxX, blkRight) - Math.max(c.minX, blk.x);
        const minW = Math.min(c.maxX - c.minX, blk.width);
        return overlap > Math.max(8, minW * 0.25);
      });
      if (col) {
        col.minX = Math.min(col.minX, blk.x);
        col.maxX = Math.max(col.maxX, blkRight);
        col.items.push(blk);
      } else {
        columns.push({ minX: blk.x, maxX: blkRight, items: [blk] });
      }
    }

    columns.sort((a, b) => a.minX - b.minX);
    for (const col of columns) {
      col.items.sort((a, b) => a.y - b.y || a.x - b.x);
      result.push(...col.items);
    }
    bucket = [];
  };

  for (const blk of sortedByY) {
    if (isSpanning(blk)) {
      flushBucket();
      result.push(blk);
    } else {
      bucket.push(blk);
    }
  }
  flushBucket();

  return result;
}

/**
 * Reconstructs structured, styled paragraphs (`PdfTextBlock[]`) from PDF.js `getTextContent` items.
 */
export function extractPageLayoutBlocks(params: {
  items: RawPdfTextItem[];
  styles: Record<string, RawPdfTextStyle>;
  viewportTransform: number[];
  viewportScale: number;
  pageWidth: number;
  pageHeight: number;
  resolveFontMeta?: (fontName: string) => RawPdfFontMeta | undefined;
}): PdfPageLayout {
  const {
    items,
    styles,
    viewportTransform,
    viewportScale,
    pageWidth,
    pageHeight,
    resolveFontMeta,
  } = params;

  const runs: PositionedRun[] = [];
  let recognizedChars = 0;

  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const rawStr = item.str;
    if (!rawStr.trim()) continue;

    for (const ch of rawStr) {
      const cp = ch.codePointAt(0) ?? 0;
      if (!isGarbledCodePoint(cp) && /[\p{L}\p{N}]/u.test(ch)) {
        recognizedChars++;
      }
    }

    const style = styles[item.fontName];
    if (style?.vertical) continue;

    const tx = multiplyTransform(viewportTransform, item.transform);
    const angle = Math.atan2(tx[1]!, tx[0]!);
    // Skip rotated margin stamps / diagonal watermarks
    if (Math.abs(angle) > 0.26) continue;

    const fontSize =
      Math.hypot(tx[2]!, tx[3]!) || Math.hypot(tx[0]!, tx[1]!) || 10;
    if (fontSize < 3.5 || fontSize > 180) continue;

    const ascent = clamp(style?.ascent ?? 0.84, 0.68, 0.96);
    const descent = clamp(Math.abs(style?.descent ?? 0.22), 0.12, 0.36);

    const x = tx[4]!;
    const baseline = tx[5]!;
    const y = baseline - fontSize * ascent;
    const rawScaledWidth = (item.width || 0) * viewportScale;
    const width =
      rawScaledWidth > 0
        ? Math.max(fontSize * 0.25, rawScaledWidth)
        : Math.max(fontSize * 0.4, rawStr.trim().length * fontSize * 0.55);
    const height = fontSize * (ascent + descent);

    if (
      x + width < 0 ||
      x > pageWidth + 4 ||
      y + height < 0 ||
      y > pageHeight + 4
    ) {
      continue;
    }

    const fontMeta = resolveFontMeta?.(item.fontName);
    const rawFontLabel = `${ fontMeta?.name ?? '' } ${ fontMeta?.fallbackName ?? '' } ${ item.fontName }`;
    const fontFamily = classifyFontFamily(
      style?.fontFamily,
      fontMeta?.name ?? item.fontName,
      fontMeta?.fallbackName,
    );
    const isBold = Boolean(
      fontMeta?.bold ||
        fontMeta?.black ||
        /bold|black|heavy|demi|semibold|medi|cmbx|-b\b/i.test(rawFontLabel),
    );
    const isItalic = Boolean(
      fontMeta?.italic ||
        /italic|oblique|slanted|cmsl|cmti|-i\b/i.test(rawFontLabel) ||
        Math.abs(tx[2]! / fontSize) > 0.14,
    );

    runs.push({
      str: rawStr,
      x,
      y,
      right: x + width,
      bottom: y + height,
      width,
      height,
      baseline,
      fontSize,
      fontFamily,
      isBold,
      isItalic,
    });
  }

  if (runs.length === 0) {
    return { pageWidth, pageHeight, blocks: [], recognizedChars };
  }

  // Step 1: Group horizontal runs into baseline bands, then split across column/table gutters
  runs.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const bands: PositionedRun[][] = [];

  for (const run of runs) {
    const lastBand = bands[bands.length - 1];
    if (lastBand) {
      const ref = lastBand[lastBand.length - 1]!;
      const tol = Math.min(run.fontSize, ref.fontSize) * 0.42;
      if (Math.abs(run.baseline - ref.baseline) <= tol) {
        lastBand.push(run);
        continue;
      }
    }
    bands.push([run]);
  }

  const visualLines: VisualLine[] = [];

  for (const band of bands) {
    band.sort((a, b) => a.x - b.x);
    let current: VisualLine | null = null;
    let prevRun: PositionedRun | null = null;

    for (const run of band) {
      if (!current || !prevRun) {
        current = {
          text: run.str.trim(),
          x: run.x,
          y: run.y,
          right: run.right,
          bottom: run.bottom,
          width: run.width,
          height: run.height,
          baseline: run.baseline,
          fontSize: run.fontSize,
          fontFamily: run.fontFamily,
          isBold: run.isBold,
          isItalic: run.isItalic,
        };
        prevRun = run;
        continue;
      }

      // Deduplicate fake-bold double-struck PDF strings shifted by fraction of a point
      if (
        run.str.trim() === prevRun.str.trim() &&
        Math.abs(run.x - prevRun.x) <= run.fontSize * 0.22
      ) {
        current.isBold = true;
        current.right = Math.max(current.right, run.right);
        current.width = current.right - current.x;
        prevRun = run;
        continue;
      }

      const avgFs = (current.fontSize + run.fontSize) * 0.5;
      const gap = run.x - current.right;
      const gutterLimit = Math.max(avgFs * 1.65, 18);

      if (gap > gutterLimit) {
        visualLines.push(current);
        current = {
          text: run.str.trim(),
          x: run.x,
          y: run.y,
          right: run.right,
          bottom: run.bottom,
          width: run.width,
          height: run.height,
          baseline: run.baseline,
          fontSize: run.fontSize,
          fontFamily: run.fontFamily,
          isBold: run.isBold,
          isItalic: run.isItalic,
        };
      } else {
        const prevText = current.text;
        const nextText = run.str.trim();
        if (nextText) {
          const lastCh = prevText[prevText.length - 1] ?? '';
          const firstCh = nextText[0] ?? '';
          const needSpace =
            gap > avgFs * 0.14 &&
            !prevText.endsWith(' ') &&
            !prevText.endsWith('-') &&
            !(isCjkChar(lastCh) && isCjkChar(firstCh));
          current.text = needSpace
            ? `${ prevText } ${ nextText }`
            : `${ prevText }${ nextText }`;
        }
        const prevChars = Math.max(1, prevText.length);
        const nextChars = Math.max(1, nextText.length);
        current.fontSize =
          (current.fontSize * prevChars + run.fontSize * nextChars) /
          (prevChars + nextChars);
        current.x = Math.min(current.x, run.x);
        current.y = Math.min(current.y, run.y);
        current.right = Math.max(current.right, run.right);
        current.bottom = Math.max(current.bottom, run.bottom);
        current.width = current.right - current.x;
        current.height = current.bottom - current.y;
      }
      prevRun = run;
    }

    if (current && current.text.trim()) {
      visualLines.push(current);
    }
  }

  // Step 2: Estimate page body font size so headings get distinct visual weight
  const fontSizesSorted = visualLines
    .map((l) => l.fontSize)
    .sort((a, b) => a - b);
  const medianBodyFontSize =
    fontSizesSorted[Math.floor(fontSizesSorted.length * 0.45)] ?? 10;

  // Step 3: Sweep lines top-to-bottom and attach to active column paragraphs
  visualLines.sort((a, b) => a.y - b.y || a.x - b.x);
  const openParagraphs: ActiveParagraph[] = [];
  const finishedParagraphs: ActiveParagraph[] = [];

  for (const line of visualLines) {
    // Retire paragraphs too far above current line to ever merge
    for (let i = openParagraphs.length - 1; i >= 0; i--) {
      const p = openParagraphs[i]!;
      const last = p.lines[p.lines.length - 1]!;
      if (line.baseline - last.baseline > Math.max(last.fontSize, line.fontSize) * 1.85) {
        finishedParagraphs.push(p);
        openParagraphs.splice(i, 1);
      }
    }

    let bestMatch: ActiveParagraph | null = null;
    if (!startsNewSemanticItem(line.text)) {
      for (const p of openParagraphs) {
        const last = p.lines[p.lines.length - 1]!;
        const pAvgFs = p.fontSizeSum / p.lines.length;
        const dy = line.baseline - last.baseline;

        if (dy < Math.min(pAvgFs, line.fontSize) * 0.72) continue;
        if (dy > Math.max(pAvgFs, line.fontSize) * 1.72) continue;

        if (p.baselineSteps.length >= 1) {
          const avgStep =
            p.baselineSteps.reduce((s, v) => s + v, 0) / p.baselineSteps.length;
          if (dy > avgStep * 1.38) continue;
        }

        if (Math.abs(line.fontSize - pAvgFs) > Math.max(1.3, pAvgFs * 0.12)) {
          continue;
        }
        if (line.isBold !== last.isBold) continue;

        // Check horizontal overlap in same column
        const overlap = Math.min(p.right, line.right) - Math.max(p.x, line.x);
        if (overlap <= Math.min(p.right - p.x, line.width) * 0.25) continue;

        const pCenter = (p.x + p.right) * 0.5;
        const lCenter = (line.x + line.right) * 0.5;
        const isCenteredPair =
          Math.abs(pCenter - lCenter) <= pAvgFs * 1.1 &&
          Math.abs(line.x - p.bodyLeftX) > pAvgFs * 0.6;

        const isLeftAligned = Math.abs(line.x - p.bodyLeftX) <= pAvgFs * 1.3;
        const isFirstLineIndent =
          p.lines.length === 1 &&
          p.x > line.x + pAvgFs * 0.45 &&
          p.x <= line.x + pAvgFs * 3.4 &&
          Math.abs(p.right - line.right) <= pAvgFs * 3.5;

        if (!isLeftAligned && !isFirstLineIndent && !isCenteredPair) continue;

        // If previous line ended well short of paragraph right margin, paragraph already ended
        const expectedRight = Math.max(p.right, line.right);
        if (
          !isCenteredPair &&
          last.right < expectedRight - pAvgFs * 2.8 &&
          last.width < line.width * 0.78
        ) {
          continue;
        }

        bestMatch = p;
        break;
      }
    }

    const lineLen = Math.max(1, line.text.length);
    if (bestMatch) {
      const prevLast = bestMatch.lines[bestMatch.lines.length - 1]!;
      bestMatch.baselineSteps.push(line.baseline - prevLast.baseline);
      if (bestMatch.lines.length === 1 && bestMatch.x > line.x + line.fontSize * 0.45) {
        bestMatch.firstLineIndent = bestMatch.x - line.x;
        bestMatch.bodyLeftX = line.x;
      }
      bestMatch.lines.push(line);
      bestMatch.x = Math.min(bestMatch.x, line.x);
      bestMatch.y = Math.min(bestMatch.y, line.y);
      bestMatch.right = Math.max(bestMatch.right, line.right);
      bestMatch.bottom = Math.max(bestMatch.bottom, line.bottom);
      bestMatch.fontSizeSum += line.fontSize;
      if (line.isBold) bestMatch.boldChars += lineLen;
      if (line.isItalic) bestMatch.italicChars += lineLen;
      bestMatch.totalChars += lineLen;
      bestMatch.familyCounts[line.fontFamily] += lineLen;
    } else {
      openParagraphs.push({
        lines: [line],
        x: line.x,
        y: line.y,
        right: line.right,
        bottom: line.bottom,
        bodyLeftX: line.x,
        firstLineIndent: 0,
        fontSizeSum: line.fontSize,
        baselineSteps: [],
        boldChars: line.isBold ? lineLen : 0,
        italicChars: line.isItalic ? lineLen : 0,
        totalChars: lineLen,
        familyCounts: {
          serif: line.fontFamily === 'serif' ? lineLen : 0,
          'sans-serif': line.fontFamily === 'sans-serif' ? lineLen : 0,
          monospace: line.fontFamily === 'monospace' ? lineLen : 0,
        },
      });
    }
  }

  finishedParagraphs.push(...openParagraphs);

  // Step 4: Finalize PdfTextBlock objects with typography & alignment
  const rawBlocks: PdfTextBlock[] = finishedParagraphs.map((p, idx) => {
    const text = p.lines.reduce(
      (acc, l) => (acc ? joinLineStrings(acc, l.text) : l.text),
      '',
    );
    const fontSize = p.fontSizeSum / p.lines.length;
    const avgStep =
      p.baselineSteps.length > 0
        ? p.baselineSteps.reduce((s, v) => s + v, 0) / p.baselineSteps.length
        : fontSize * 1.26;
    const lineHeightRatio = clamp(avgStep / fontSize, 1.14, 1.65);

    const dominantFamily = (
      Object.entries(p.familyCounts) as Array<[PdfFontCategory, number]>
    ).sort((a, b) => b[1] - a[1])[0]![0];

    const isHeadingScale =
      fontSize >= medianBodyFontSize * 1.22 && p.lines.length <= 3;
    const isBold = p.boldChars >= p.totalChars * 0.5 || isHeadingScale;
    const isItalic = p.italicChars >= p.totalChars * 0.5;

    const width = p.right - p.x;
    const height = p.bottom - p.y;

    let align: PdfTextAlign = 'left';
    if (p.lines.length === 1) {
      const center = p.x + width * 0.5;
      if (
        Math.abs(center - pageWidth * 0.5) <= pageWidth * 0.055 &&
        width < pageWidth * 0.8
      ) {
        align = 'center';
      }
    } else {
      const centers = p.lines.map((l) => (l.x + l.right) * 0.5);
      const avgCenter = centers.reduce((s, v) => s + v, 0) / centers.length;
      const maxCenterDev = Math.max(
        ...centers.map((c) => Math.abs(c - avgCenter)),
      );
      const leftSpread =
        Math.max(...p.lines.map((l) => l.x)) -
        Math.min(...p.lines.map((l) => l.x));
      const hasSymmetricShrink = p.lines.some(
        (l) =>
          l.x > p.x + fontSize * 0.5 && l.right < p.right - fontSize * 0.5,
      );
      if (
        hasSymmetricShrink &&
        maxCenterDev <= fontSize * 0.85 &&
        leftSpread > fontSize * 0.7
      ) {
        align = 'center';
      } else if (p.lines.length >= 3) {
        const bodyLines = p.lines.slice(0, -1);
        const rightSpread =
          Math.max(...bodyLines.map((l) => l.right)) -
          Math.min(...bodyLines.map((l) => l.right));
        if (rightSpread <= fontSize * 0.95) {
          align = 'justify';
        }
      }
    }

    return {
      id: idx + 1,
      text,
      x: p.x,
      y: p.y,
      width,
      height,
      maxHeightBudget: height,
      fontSize,
      lineHeightRatio,
      fontFamily: dominantFamily,
      isBold,
      isItalic,
      align,
      firstLineIndent: align === 'center' ? 0 : p.firstLineIndent,
      lineRects: p.lines.map((l) => ({
        x: l.x,
        y: l.y,
        width: l.width,
        height: l.height,
      })),
      translatable: isTranslatablePdfText(text),
    };
  });

  const ordered = sortBlocksInReadingOrder(rawBlocks, pageWidth).map(
    (b, idx) => ({
      ...b,
      id: idx + 1,
    }),
  );

  // Step 5: Compute vertical height budget before colliding with the next block below
  for (const blk of ordered) {
    let nearestBelowY = pageHeight - 8;
    const blkRight = blk.x + blk.width;
    for (const other of ordered) {
      if (other.id === blk.id) continue;
      if (other.y < blk.y + blk.height * 0.55) continue;
      const otherRight = other.x + other.width;
      const overlap = Math.min(blkRight, otherRight) - Math.max(blk.x, other.x);
      if (overlap > Math.min(blk.width, other.width) * 0.15) {
        if (other.y < nearestBelowY) {
          nearestBelowY = other.y;
        }
      }
    }
    blk.maxHeightBudget = Math.max(blk.height, nearestBelowY - blk.y - 2);
  }

  return {
    pageWidth,
    pageHeight,
    blocks: ordered,
    recognizedChars,
  };
}

function medianChannel(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)]!;
}

/**
 * Samples exact foreground ink color and underlying background color of a block
 * by diffing the full rendered PDF canvas against the text-free `bgOnly` canvas.
 */
export function sampleBlockColorsFromCanvases(
  fullData: ImageData,
  bgOnlyData: ImageData,
  lineRects: PdfRect[],
  canvasScale: number,
): { fgColor: string; bgColor: string } {
  const w = fullData.width;
  const h = fullData.height;
  const fullPx = fullData.data;
  const bgPx = bgOnlyData.data;

  const bgR: number[] = [];
  const bgG: number[] = [];
  const bgB: number[] = [];
  const fgR: number[] = [];
  const fgG: number[] = [];
  const fgB: number[] = [];

  for (const rect of lineRects) {
    const x0 = clamp(Math.floor(rect.x * canvasScale), 0, w - 1);
    const y0 = clamp(Math.floor(rect.y * canvasScale), 0, h - 1);
    const x1 = clamp(Math.ceil((rect.x + rect.width) * canvasScale), 0, w - 1);
    const y1 = clamp(Math.ceil((rect.y + rect.height) * canvasScale), 0, h - 1);

    const stepX = Math.max(1, Math.floor((x1 - x0) / 28));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 8));

    for (let py = y0; py <= y1; py += stepY) {
      for (let px = x0; px <= x1; px += stepX) {
        const off = (py * w + px) * 4;
        const br = bgPx[off]!;
        const bg = bgPx[off + 1]!;
        const bb = bgPx[off + 2]!;
        bgR.push(br);
        bgG.push(bg);
        bgB.push(bb);

        const fr = fullPx[off]!;
        const fg = fullPx[off + 1]!;
        const fb = fullPx[off + 2]!;
        const diff = Math.abs(fr - br) + Math.abs(fg - bg) + Math.abs(fb - bb);
        if (diff > 65) {
          fgR.push(fr);
          fgG.push(fg);
          fgB.push(fb);
        }
      }
    }
  }

  const rBg = medianChannel(bgR, 255);
  const gBg = medianChannel(bgG, 255);
  const bBg = medianChannel(bgB, 255);

  const bgLum = 0.299 * rBg + 0.587 * gBg + 0.114 * bBg;
  const fallbackFg = bgLum < 128 ? 248 : 20;

  const rFg = medianChannel(fgR, fallbackFg);
  const gFg = medianChannel(fgG, fallbackFg);
  const bFg = medianChannel(fgB, fallbackFg);

  return {
    fgColor: `rgb(${ rFg }, ${ gFg }, ${ bFg })`,
    bgColor: `rgb(${ rBg }, ${ gBg }, ${ bBg })`,
  };
}
