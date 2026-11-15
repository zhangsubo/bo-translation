import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ReplicaBlockOverlay } from '../entrypoints/pdf/App';
import {
  analyzeRecognizableText,
  clampBlockBudgetsWithBackgroundObstacles,
  extractPageLayoutBlocks,
  isPdfUrl,
  sampleBlockColorsFromCanvases,
  type PdfTextBlock,
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

  it('clamps maxHeightBudget before non-background figures in text-free canvas', () => {
    const w = 200;
    const h = 300;
    const bgArr = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const off = i * 4;
      bgArr[off] = 255;
      bgArr[off + 1] = 255;
      bgArr[off + 2] = 255;
      bgArr[off + 3] = 255;
    }

    // Paint a non-background diagram rectangle at y=140..220, x=30..170
    for (let py = 140; py < 220; py++) {
      for (let px = 30; px < 170; px++) {
        const off = (py * w + px) * 4;
        bgArr[off] = 40;
        bgArr[off + 1] = 80;
        bgArr[off + 2] = 140;
      }
    }

    const blockAboveFigure: PdfTextBlock = {
      id: 1,
      text: 'Paragraph right above figure.',
      x: 30,
      y: 40,
      width: 140,
      height: 40,
      maxHeightBudget: 240,
      fontSize: 10,
      lineHeightRatio: 1.3,
      fontFamily: 'serif',
      isBold: false,
      isItalic: false,
      align: 'left',
      firstLineIndent: 0,
      lineRects: [{ x: 30, y: 40, width: 140, height: 40 }],
      translatable: true,
      bgColor: 'rgb(255, 255, 255)',
    };

    const blockInWhiteSpace: PdfTextBlock = {
      ...blockAboveFigure,
      id: 2,
      y: 230,
      height: 25,
      maxHeightBudget: 60,
      lineRects: [{ x: 30, y: 230, width: 140, height: 25 }],
    };

    const bgData = {
      data: bgArr,
      width: w,
      height: h,
      colorSpace: 'srgb',
    } as ImageData;

    expect(
      clampBlockBudgetsWithBackgroundObstacles([blockAboveFigure], bgData, 1),
    ).toBe(true);
    expect(blockAboveFigure.maxHeightBudget).toBeLessThan(100);
    expect(blockAboveFigure.maxHeightBudget).toBeGreaterThanOrEqual(40);

    expect(
      clampBlockBudgetsWithBackgroundObstacles([blockInWhiteSpace], bgData, 1),
    ).toBe(false);
    expect(blockInWhiteSpace.maxHeightBudget).toBe(60);
  });

  it('skips monospace code blocks by default, unlocks them when skipCodeBlocks=false, tolerates all-mono pages, and orders short centered Abstract first', () => {
    const viewportTransform = [1, 0, 0, -1, 0, 800];
    const items: RawPdfTextItem[] = [
      // Short centered "Abstract" spanning header (width=60, centered at 300 on 600px page)
      {
        str: 'Abstract',
        transform: [14, 0, 0, 14, 270, 740],
        width: 60,
        height: 14,
        fontName: 'F_Title',
      },
      // Left column prose
      {
        str: 'We analyze the attention mechanism in detail.',
        transform: [10, 0, 0, 10, 50, 690],
        width: 210,
        height: 10,
        fontName: 'F_Body',
      },
      // Left column multi-line monospace code block
      {
        str: 'def forward(self, x):',
        transform: [9.5, 0, 0, 9.5, 50, 640],
        width: 150,
        height: 9.5,
        fontName: 'F_Mono',
      },
      {
        str: 'return self.proj(x)',
        transform: [9.5, 0, 0, 9.5, 50, 628],
        width: 140,
        height: 9.5,
        fontName: 'F_Mono',
      },
      // Right column prose
      {
        str: 'Results confirm steady accuracy gains.',
        transform: [10, 0, 0, 10, 330, 690],
        width: 200,
        height: 10,
        fontName: 'F_Body',
      },
    ];

    const styles = {
      F_Title: { fontFamily: 'serif', ascent: 0.85, descent: -0.2 },
      F_Body: { fontFamily: 'serif', ascent: 0.85, descent: -0.2 },
      F_Mono: { fontFamily: 'monospace', ascent: 0.85, descent: -0.2 },
    };

    const skippedLayout = extractPageLayoutBlocks({
      items,
      styles,
      viewportTransform,
      viewportScale: 1,
      pageWidth: 600,
      pageHeight: 800,
      skipCodeBlocks: true,
      resolveFontMeta: (fn) =>
        fn === 'F_Mono' ? { name: 'CourierNew' } : undefined,
    });

    expect(skippedLayout.blocks).toHaveLength(4);
    expect(skippedLayout.blocks[0]!.text).toBe('Abstract');
    const monoBlockSkipped = skippedLayout.blocks.find((b) =>
      b.text.includes('def forward'),
    )!;
    expect(monoBlockSkipped.isCodeBlock).toBe(true);
    expect(monoBlockSkipped.translatable).toBe(false);

    const unlockedLayout = extractPageLayoutBlocks({
      items,
      styles,
      viewportTransform,
      viewportScale: 1,
      pageWidth: 600,
      pageHeight: 800,
      skipCodeBlocks: false,
      resolveFontMeta: (fn) =>
        fn === 'F_Mono' ? { name: 'CourierNew' } : undefined,
    });
    const monoBlockUnlocked = unlockedLayout.blocks.find((b) =>
      b.text.includes('def forward'),
    )!;
    expect(monoBlockUnlocked.isCodeBlock).toBe(true);
    expect(monoBlockUnlocked.translatable).toBe(true);

    // All-monospace document (e.g., RFC prose) keeps natural prose translatable
    const rfcLayout = extractPageLayoutBlocks({
      items: [
        {
          str: 'This document specifies an internet standards track protocol',
          transform: [10, 0, 0, 10, 60, 700],
          width: 420,
          height: 10,
          fontName: 'F_Mono',
        },
        {
          str: 'for the Internet community and requests discussion for improvements.',
          transform: [10, 0, 0, 10, 60, 686],
          width: 440,
          height: 10,
          fontName: 'F_Mono',
        },
      ],
      styles: { F_Mono: { fontFamily: 'monospace', ascent: 0.85, descent: -0.2 } },
      viewportTransform,
      viewportScale: 1,
      pageWidth: 600,
      pageHeight: 800,
      skipCodeBlocks: true,
    });
    expect(rfcLayout.blocks).toHaveLength(1);
    expect(rfcLayout.blocks[0]!.isCodeBlock).toBe(false);
    expect(rfcLayout.blocks[0]!.translatable).toBe(true);
  });

  it('preserves original source text alongside retry prompt when ReplicaBlockOverlay enters error state', async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onRetranslate = vi.fn();

    const block: PdfTextBlock = {
      id: 7,
      text: 'Original paragraph preserved on translation failure.',
      x: 40,
      y: 100,
      width: 240,
      height: 32,
      maxHeightBudget: 50,
      fontSize: 10,
      lineHeightRatio: 1.3,
      fontFamily: 'serif',
      isBold: false,
      isItalic: false,
      align: 'left',
      firstLineIndent: 0,
      lineRects: [
        { x: 40, y: 100, width: 240, height: 14 },
        { x: 40, y: 116, width: 180, height: 14 },
      ],
      translatable: true,
    };

    await act(async () => {
      root.render(
        React.createElement(ReplicaBlockOverlay, {
          block,
          pageWidth: 600,
          pageHeight: 800,
          cssScale: 1,
          state: { status: 'error', text: '', error: '429 Too Many Requests' },
          isHovered: false,
          onHoverChange: () => {},
          onRetranslate,
        }),
      );
    });

    expect(container.textContent).toContain(
      'Original paragraph preserved on translation failure.',
    );
    expect(container.textContent).toContain('译文获取失败（已保留原文）· 点击重试');

    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    expect(onRetranslate).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
