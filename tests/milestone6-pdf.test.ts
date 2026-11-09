import { describe, expect, it } from 'vitest';
import {
  analyzeRecognizableText,
  extractPageLayoutBlocks,
  isPdfUrl,
  sampleBlockColorsFromCanvases,
  type RawPdfTextItem,
} from '../src/pdf/layout';

describe('PDF Text Recognition & Layout Style Reconstruction', () => {
  it('detects recognizable text vs scanned empty or garbled PUA PDFs', () => {
    expect(analyzeRecognizableText(['', '   ']).hasRecognizableText).toBe(false);

    const garbled = analyzeRecognizableText([
      '\uE001\uE002\uE003\uE004\uFFFD\uE005\uE006\uE007\uE008\uE009',
    ]);
    expect(garbled.hasRecognizableText).toBe(false);
    expect(garbled.garbledRatio).toBeGreaterThan(0.8);

    const valid = analyzeRecognizableText([
      '',
      'Attention Is All You Need. The dominant sequence transduction models...',
    ]);
    expect(valid.hasRecognizableText).toBe(true);
    expect(valid.recognizableChars).toBeGreaterThan(40);
  });

  it('recognizes standard PDF URLs and ArXiv / OpenReview PDF endpoints', () => {
    expect(isPdfUrl('https://example.com/docs/manual.pdf')).toBe(true);
    expect(isPdfUrl('https://arxiv.org/pdf/1706.03762')).toBe(true);
    expect(isPdfUrl('https://openreview.net/pdf?id=abc123')).toBe(true);
    expect(
      isPdfUrl('chrome-extension://abcdefghijklmnop/pdf.html?url=foo.pdf'),
    ).toBe(false);
    expect(isPdfUrl('https://news.ycombinator.com/item?id=1')).toBe(false);
  });

  it('reconstructs centered title, two-column de-hyphenated paragraphs, and skips math formulas', () => {
    // Standard PDF unrotated viewport transform for 600x800 page: [1, 0, 0, -1, 0, 800]
    const viewportTransform = [1, 0, 0, -1, 0, 800];
    const items: RawPdfTextItem[] = [
      // Centered bold title near top (PDF y = 730 -> top-down baseline = 70)
      {
        str: 'Deep Layout Translation',
        transform: [18, 0, 0, 18, 190, 730],
        width: 220,
        height: 18,
        fontName: 'F_Title',
      },
      // Left column paragraph with first-line indent and soft hyphen wrap
      {
        str: 'We introduce a trans-',
        transform: [10, 0, 0, 10, 62, 660],
        width: 198,
        height: 10,
        fontName: 'F_Body',
      },
      {
        str: 'former architecture for documents.',
        transform: [10, 0, 0, 10, 50, 647],
        width: 195,
        height: 10,
        fontName: 'F_Body',
      },
      // Right column paragraph on the exact same baselines (must NOT merge across gutter!)
      {
        str: 'Experiments demonstrate strong',
        transform: [10, 0, 0, 10, 320, 660],
        width: 210,
        height: 10,
        fontName: 'F_Sans',
      },
      {
        str: 'accuracy across benchmarks.',
        transform: [10, 0, 0, 10, 320, 647],
        width: 180,
        height: 10,
        fontName: 'F_Sans',
      },
      // Display math formula in left column (should stay untranslated)
      {
        str: 'x_i = ∑_{j=1}^n α_{ij} + β_0 ≥ 0',
        transform: [10, 0, 0, 10, 80, 600],
        width: 140,
        height: 10,
        fontName: 'F_Math',
      },
    ];

    const layout = extractPageLayoutBlocks({
      items,
      styles: {
        F_Title: { fontFamily: 'serif', ascent: 0.85, descent: -0.2 },
        F_Body: { fontFamily: 'serif', ascent: 0.85, descent: -0.2 },
        F_Sans: { fontFamily: 'sans-serif', ascent: 0.85, descent: -0.2 },
        F_Math: { fontFamily: 'serif', ascent: 0.85, descent: -0.2 },
      },
      viewportTransform,
      viewportScale: 1,
      pageWidth: 600,
      pageHeight: 800,
      resolveFontMeta: (fn) =>
        fn === 'F_Title' ? { name: 'TimesNewRoman-Bold', bold: true } : undefined,
    });

    expect(layout.blocks).toHaveLength(4);

    const [title, leftPara, mathEq, rightPara] = layout.blocks;
    expect(title!.text).toBe('Deep Layout Translation');
    expect(title!.isBold).toBe(true);
    expect(title!.align).toBe('center');
    expect(title!.translatable).toBe(true);

    // Soft hyphen joined cleanly + first-line indent preserved
    expect(leftPara!.text).toBe(
      'We introduce a transformer architecture for documents.',
    );
    expect(leftPara!.firstLineIndent).toBeCloseTo(12, 1);
    expect(leftPara!.fontFamily).toBe('serif');
    expect(leftPara!.translatable).toBe(true);

    // Math formula kept in left column order but marked non-translatable
    expect(mathEq!.translatable).toBe(false);

    // Right column stays separate and preserves sans-serif style
    expect(rightPara!.text).toBe(
      'Experiments demonstrate strong accuracy across benchmarks.',
    );
    expect(rightPara!.fontFamily).toBe('sans-serif');
    expect(rightPara!.translatable).toBe(true);
  });

  it('samples exact foreground ink and background colors by diffing full vs text-free canvases', () => {
    const w = 20;
    const h = 10;
    const bgArr = new Uint8ClampedArray(w * h * 4);
    const fullArr = new Uint8ClampedArray(w * h * 4);

    // Dark slide banner background rgb(24, 36, 58) with white ink rgb(250, 252, 255)
    for (let i = 0; i < w * h; i++) {
      const off = i * 4;
      bgArr[off] = 24;
      bgArr[off + 1] = 36;
      bgArr[off + 2] = 58;
      bgArr[off + 3] = 255;

      const isGlyphPixel = i % 3 === 0;
      fullArr[off] = isGlyphPixel ? 250 : 24;
      fullArr[off + 1] = isGlyphPixel ? 252 : 36;
      fullArr[off + 2] = isGlyphPixel ? 255 : 58;
      fullArr[off + 3] = 255;
    }

    const sampled = sampleBlockColorsFromCanvases(
      { data: fullArr, width: w, height: h, colorSpace: 'srgb' } as ImageData,
      { data: bgArr, width: w, height: h, colorSpace: 'srgb' } as ImageData,
      [{ x: 1, y: 1, width: 18, height: 8 }],
      1,
    );

    expect(sampled.bgColor).toBe('rgb(24, 36, 58)');
    expect(sampled.fgColor).toBe('rgb(250, 252, 255)');
  });
});
