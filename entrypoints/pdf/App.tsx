import '../content/style.css';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Columns2,
  FileText,
  FileUp,
  FolderOpen,
  Languages,
  Link2,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import {
  inferLanguageFromUnicodeScripts,
  isSameTargetLanguageFamily,
} from '../../src/auto-translate/detector';
import {
  analyzeRecognizableText,
  extractPageLayoutBlocks,
  type PdfFontCategory,
  type PdfPageLayout,
  type PdfTextBlock,
  type RawPdfFontMeta,
  type RawPdfTextItem,
  type RawPdfTextStyle,
  sampleBlockColorsFromCanvases,
  type TextRecognitionSummary,
} from '../../src/pdf/layout';
import { isEditableTarget, matchesShortcut } from '../../src/shortcuts';
import { LANGUAGE_OPTIONS, resolvePrimaryService } from '../../src/storage';
import { useSettings } from '../../src/storage/useSettings';
import {
  STREAM_PORT_NAME,
  type BatchTranslateItem,
  type ExtensionSettings,
  type StreamPortClientMessage,
  type StreamPortServerMessage,
  type TargetLanguageCode,
} from '../../src/types';
import { consumeRuntimeLastError } from '../../src/utils/runtime';
import { SelectionPopover } from '../content/components/SelectionPopover';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const TEXT_SHOW_OPS = new Set<number>([
  pdfjsLib.OPS.showText,
  pdfjsLib.OPS.showSpacedText,
  pdfjsLib.OPS.nextLineShowText,
  pdfjsLib.OPS.nextLineSetSpacingShowText,
]);

type PdfLayoutMode = 'replica' | 'flow';

interface BlockTranslationState {
  status: 'idle' | 'loading' | 'streaming' | 'done' | 'error';
  text: string;
  error?: string;
  serviceName?: string;
}

const FONT_STACK_MAP: Record<PdfFontCategory, string> = {
  serif:
    'Georgia, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, serif',
  'sans-serif':
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
  monospace:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
};

function extractFileNameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const seg = decodeURIComponent(
      u.pathname.split('/').filter(Boolean).pop() ?? '',
    );
    if (seg) return seg.endsWith('.pdf') ? seg : `${ seg }.pdf`;
  } catch {
    // ignore invalid url
  }
  return 'document.pdf';
}

function isRenderingCancelled(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'RenderingCancelledException' ||
      err.message.includes('Rendering cancelled'))
  );
}

function isPasswordError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: string }).name === 'PasswordException' ||
      String((err as { message?: string }).message ?? '')
        .toLowerCase()
        .includes('password'))
  );
}

interface ReplicaBlockOverlayProps {
  block: PdfTextBlock;
  pageWidth: number;
  pageHeight: number;
  cssScale: number;
  state: BlockTranslationState | undefined;
  isHovered: boolean;
  onHoverChange: (hovered: boolean) => void;
  onRetranslate: () => void;
}

const ReplicaBlockOverlay: React.FC<ReplicaBlockOverlayProps> = ({
  block,
  pageWidth,
  pageHeight,
  cssScale,
  state,
  isHovered,
  onHoverChange,
  onRetranslate,
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [compressed, setCompressed] = useState(false);

  const baseFontPx = Math.max(8.5, block.fontSize * cssScale);
  const maxBudgetPx = Math.max(
    block.height * cssScale * 1.04,
    block.maxHeightBudget * cssScale,
  );
  const displayText = state?.text || '';
  const status = state?.status ?? 'idle';

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !displayText) {
      setCompressed(false);
      return;
    }

    if (isHovered && compressed) {
      el.style.fontSize = `${ Math.max(11, baseFontPx).toFixed(2) }px`;
      el.style.lineHeight = String(
        Math.max(1.28, Math.min(1.5, block.lineHeightRatio)),
      );
      return;
    }

    let fontPx = baseFontPx;
    let lh = Math.max(1.18, Math.min(1.52, block.lineHeightRatio));
    el.style.fontSize = `${ fontPx.toFixed(2) }px`;
    el.style.lineHeight = String(lh);

    if (el.scrollHeight > maxBudgetPx + 2) {
      const firstRatio = Math.max(
        0.64,
        Math.sqrt(maxBudgetPx / Math.max(1, el.scrollHeight)) * 0.96,
      );
      fontPx = Math.max(7.5, baseFontPx * firstRatio);
      lh = Math.max(1.14, lh * 0.92);
      el.style.fontSize = `${ fontPx.toFixed(2) }px`;
      el.style.lineHeight = String(lh);

      if (el.scrollHeight > maxBudgetPx + 2 && fontPx > 7.5) {
        const secondRatio = Math.max(
          0.62,
          (maxBudgetPx / Math.max(1, el.scrollHeight)) * (fontPx / baseFontPx),
        );
        fontPx = Math.max(7.5, baseFontPx * secondRatio);
        el.style.fontSize = `${ fontPx.toFixed(2) }px`;
      }
      setCompressed(fontPx < baseFontPx * 0.86 || el.scrollHeight > maxBudgetPx + 4);
    } else {
      setCompressed(false);
    }
  }, [
    displayText,
    baseFontPx,
    maxBudgetPx,
    block.lineHeightRatio,
    block.width,
    isHovered,
    compressed,
  ]);

  const leftPct = (block.x / pageWidth) * 100;
  const topPct = (block.y / pageHeight) * 100;
  const widthPct = (block.width / pageWidth) * 100;
  const minHeightPct = (block.height / pageHeight) * 100;

  const indentEm =
    block.firstLineIndent > 0
      ? `${ (block.firstLineIndent / Math.max(1, block.fontSize)).toFixed(2) }em`
      : undefined;

  return (
    <div
      ref={boxRef}
      data-pdf-block-id={block.id}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      style={{
        position: 'absolute',
        left: `${ leftPct.toFixed(3) }%`,
        top: `${ topPct.toFixed(3) }%`,
        width: `${ widthPct.toFixed(3) }%`,
        minHeight: `${ minHeightPct.toFixed(3) }%`,
        maxHeight:
          isHovered && compressed ? 'none' : `${ (maxBudgetPx + 3).toFixed(1) }px`,
        overflow: isHovered ? 'visible' : 'hidden',
        fontFamily: FONT_STACK_MAP[block.fontFamily],
        fontSize: `${ baseFontPx.toFixed(2) }px`,
        lineHeight: block.lineHeightRatio,
        fontWeight: block.isBold ? 700 : 400,
        fontStyle: block.isItalic ? 'italic' : 'normal',
        textAlign: block.align,
        textIndent: indentEm,
        color: block.fgColor ?? 'rgb(20, 24, 33)',
        backgroundColor: isHovered
          ? (block.bgColor ?? 'rgb(255, 255, 255)')
          : 'transparent',
        zIndex: isHovered ? 30 : 2,
        padding: isHovered && compressed ? '3px 5px' : 0,
        margin: isHovered && compressed ? '-3px -5px' : 0,
        borderRadius: '3px',
        boxShadow: isHovered
          ? '0 0 0 1px rgba(37, 99, 235, 0.42), 0 6px 18px -4px rgba(15, 23, 42, 0.16)'
          : 'none',
        transition: 'box-shadow 140ms cubic-bezier(0.25, 1, 0.5, 1)',
        wordBreak: 'break-word',
      }}
    >
      {status === 'error' ? (
        <button
          type="button"
          onClick={onRetranslate}
          className="inline-flex items-center gap-1 rounded bg-red-50/95 px-1.5 py-0.5 text-[11px] font-normal text-red-700 ring-1 ring-red-200 hover:bg-red-100"
          style={{ textIndent: 0 }}
        >
          <RotateCcw size={10} />
          <span>翻译失败 · 点击重试</span>
        </button>
      ) : displayText ? (
        <>
          <span>{displayText}</span>
          {isHovered && status === 'done' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetranslate();
              }}
              title="重新翻译此段"
              style={{ textIndent: 0 }}
              className="absolute -top-5 right-0 inline-flex items-center gap-0.5 rounded bg-slate-900/90 px-1.5 py-0.5 font-sans text-[10px] font-medium text-white shadow-xs hover:bg-blue-600"
            >
              <RefreshCw size={9} />
              <span>重译</span>
            </button>
          )}
        </>
      ) : (
        <div
          className="flex flex-col gap-1 py-0.5 opacity-55"
          aria-label="正在翻译段落"
        >
          <div className="h-2.5 w-11/12 animate-pulse rounded-xs bg-slate-400/35" />
          {block.lineRects.length > 1 && (
            <div className="h-2.5 w-3/4 animate-pulse rounded-xs bg-slate-400/30" />
          )}
        </div>
      )}
    </div>
  );
};

interface PdfPageRowProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  defaultPageSize: { width: number; height: number };
  targetPaneWidth: number;
  layoutMode: PdfLayoutMode;
  canTranslate: boolean;
  forceActivate: boolean;
  pageTranslations: Record<number, BlockTranslationState>;
  cachedLayout: PdfPageLayout | undefined;
  onLayoutReady: (pageNumber: number, layout: PdfPageLayout) => void;
  onRequestPageTranslate: (pageNumber: number, blocks: PdfTextBlock[]) => void;
  onRetranslateBlock: (pageNumber: number, block: PdfTextBlock) => void;
  onPageVisible: (pageNumber: number) => void;
}

const PdfPageRow: React.FC<PdfPageRowProps> = ({
  pdfDoc,
  pageNumber,
  defaultPageSize,
  targetPaneWidth,
  layoutMode,
  canTranslate,
  forceActivate,
  pageTranslations,
  cachedLayout,
  onLayoutReady,
  onRequestPageTranslate,
  onRetranslateBlock,
  onPageVisible,
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const leftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rightCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [layout, setLayout] = useState<PdfPageLayout | null>(
    cachedLayout ?? null,
  );
  const [hoveredBlockId, setHoveredBlockId] = useState<number | null>(null);
  const [renderedOk, setRenderedOk] = useState(false);

  const active = nearViewport || forceActivate;

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;

    const nearObs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNearViewport(true);
        }
      },
      { rootMargin: '750px 0px' },
    );

    const visObs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.35) {
            onPageVisible(pageNumber);
          }
        }
      },
      { threshold: [0.35, 0.65] },
    );

    nearObs.observe(el);
    visObs.observe(el);
    return () => {
      nearObs.disconnect();
      visObs.disconnect();
    };
  }, [pageNumber, onPageVisible]);

  const pageWidth = layout?.pageWidth ?? defaultPageSize.width;
  const pageHeight = layout?.pageHeight ?? defaultPageSize.height;
  const cssScale = targetPaneWidth / Math.max(1, pageWidth);
  const targetPaneHeight = Math.round(pageHeight * cssScale);

  // Quantize raster scale so minor window resizes reuse crisp bitmap smoothly
  const rasterBucket = useMemo(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.2);
    const raw = cssScale * dpr;
    return Math.min(2.6, Math.max(1.25, Math.round(raw * 4) / 4));
  }, [cssScale]);

  useEffect(() => {
    if (!active) return;
    const leftCanvas = leftCanvasRef.current;
    if (!leftCanvas) return;

    let cancelled = false;
    let mainRenderTask: RenderTask | null = null;
    let bgRenderTask: RenderTask | null = null;

    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const normViewport = page.getViewport({ scale: 1 });
        const hiViewport = page.getViewport({ scale: rasterBucket });

        leftCanvas.width = Math.floor(hiViewport.width);
        leftCanvas.height = Math.floor(hiViewport.height);

        mainRenderTask = page.render({
          canvas: leftCanvas,
          viewport: hiViewport,
        });
        await mainRenderTask.promise;
        if (cancelled) return;

        let resolvedLayout = cachedLayout;
        if (!resolvedLayout) {
          const textContent = await page.getTextContent();
          if (cancelled) return;

          resolvedLayout = extractPageLayoutBlocks({
            items: textContent.items.filter(
              (it): it is Extract<typeof it, { str: string }> => 'str' in it,
            ),
            styles: textContent.styles as Record<string, RawPdfTextStyle>,
            viewportTransform: normViewport.transform,
            viewportScale: normViewport.scale,
            pageWidth: normViewport.width,
            pageHeight: normViewport.height,
            resolveFontMeta: (fontName: string): RawPdfFontMeta | undefined => {
              try {
                if (page.commonObjs.has(fontName)) {
                  return page.commonObjs.get(fontName) as RawPdfFontMeta;
                }
              } catch {
                // ignore unresolved font meta
              }
              return undefined;
            },
          });
        }

        // Render text-free background canvas to preserve exact figures, tables, gradients & equations
        const rightCanvas = rightCanvasRef.current;
        const translatableBlocks = resolvedLayout.blocks.filter(
          (b) => b.translatable,
        );

        if (rightCanvas && canTranslate) {
          rightCanvas.width = leftCanvas.width;
          rightCanvas.height = leftCanvas.height;
          const rightCtx = rightCanvas.getContext('2d');
          const leftCtx = leftCanvas.getContext('2d');

          if (rightCtx && leftCtx) {
            rightCtx.drawImage(leftCanvas, 0, 0);

            if (translatableBlocks.length > 0) {
              const bgCanvas = document.createElement('canvas');
              bgCanvas.width = leftCanvas.width;
              bgCanvas.height = leftCanvas.height;

              bgRenderTask = page.render({
                canvas: bgCanvas,
                viewport: hiViewport,
                operationsFilter: (idx, opList) =>
                  !TEXT_SHOW_OPS.has(opList.fnArray[idx]!),
              });
              await bgRenderTask.promise;
              if (cancelled) return;

              const bgCtx = bgCanvas.getContext('2d');
              if (bgCtx) {
                const fullImg = leftCtx.getImageData(
                  0,
                  0,
                  leftCanvas.width,
                  leftCanvas.height,
                );
                const bgImg = bgCtx.getImageData(
                  0,
                  0,
                  bgCanvas.width,
                  bgCanvas.height,
                );

                let colorsUpdated = false;
                for (const blk of translatableBlocks) {
                  if (!blk.fgColor || !blk.bgColor) {
                    const sampled = sampleBlockColorsFromCanvases(
                      fullImg,
                      bgImg,
                      blk.lineRects,
                      rasterBucket,
                    );
                    blk.fgColor = sampled.fgColor;
                    blk.bgColor = sampled.bgColor;
                    colorsUpdated = true;
                  }

                  const pad = Math.ceil(1.6 * rasterBucket);
                  for (const lr of blk.lineRects) {
                    const sx = Math.max(
                      0,
                      Math.floor(lr.x * rasterBucket) - pad,
                    );
                    const sy = Math.max(
                      0,
                      Math.floor(lr.y * rasterBucket) - pad,
                    );
                    const sw = Math.min(
                      bgCanvas.width - sx,
                      Math.ceil(lr.width * rasterBucket) + pad * 2,
                    );
                    const sh = Math.min(
                      bgCanvas.height - sy,
                      Math.ceil(lr.height * rasterBucket) + pad * 2,
                    );
                    if (sw > 0 && sh > 0) {
                      rightCtx.drawImage(
                        bgCanvas,
                        sx,
                        sy,
                        sw,
                        sh,
                        sx,
                        sy,
                        sw,
                        sh,
                      );
                    }
                  }
                }

                if (colorsUpdated) {
                  resolvedLayout = {
                    ...resolvedLayout,
                    blocks: [...resolvedLayout.blocks],
                  };
                }
              }
            }
          }
        }

        setLayout(resolvedLayout);
        onLayoutReady(pageNumber, resolvedLayout);
        setRenderedOk(true);

        if (canTranslate && translatableBlocks.length > 0) {
          onRequestPageTranslate(pageNumber, translatableBlocks);
        }
      } catch (err) {
        if (!isRenderingCancelled(err)) {
          console.warn(`[Bo PDF] Page ${ pageNumber } render warning:`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      mainRenderTask?.cancel();
      bgRenderTask?.cancel();
    };
  }, [
    active,
    pdfDoc,
    pageNumber,
    rasterBucket,
    canTranslate,
    cachedLayout,
    onLayoutReady,
    onRequestPageTranslate,
  ]);

  const translatableBlocks = useMemo(
    () => (layout?.blocks ?? []).filter((b) => b.translatable),
    [layout],
  );

  const medianFontSize = useMemo(() => {
    if (translatableBlocks.length === 0) return 10.5;
    const sorted = translatableBlocks
      .map((b) => b.fontSize)
      .sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.45)] ?? 10.5;
  }, [translatableBlocks]);

  return (
    <div
      ref={rowRef}
      id={`pdf-page-${ pageNumber }`}
      className="mx-auto flex w-fit items-start gap-4"
    >
      {/* Left: Original PDF Page */}
      <div
        className="relative shrink-0 overflow-hidden rounded-xs bg-white shadow-[0_2px_12px_-2px_rgba(15,23,42,0.14),0_0_0_1px_rgba(15,23,42,0.08)]"
        style={{
          width: `${ targetPaneWidth }px`,
          height: `${ targetPaneHeight }px`,
        }}
      >
        <canvas
          ref={leftCanvasRef}
          className="block h-full w-full select-none"
        />

        {!renderedOk && (
          <div className="absolute inset-0 flex flex-col gap-3 bg-white p-8">
            <div className="h-5 w-2/5 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
          </div>
        )}

        {/* Selectable original text + synchronized hover highlight */}
        {renderedOk &&
          translatableBlocks.map((blk) => {
            const isHov = hoveredBlockId === blk.id;
            return (
              <div
                key={blk.id}
                data-bo-pdf-orig="true"
                onMouseEnter={() => setHoveredBlockId(blk.id)}
                onMouseLeave={() => setHoveredBlockId(null)}
                style={{
                  position: 'absolute',
                  left: `${ ((blk.x / pageWidth) * 100).toFixed(3) }%`,
                  top: `${ ((blk.y / pageHeight) * 100).toFixed(3) }%`,
                  width: `${ ((blk.width / pageWidth) * 100).toFixed(3) }%`,
                  height: `${ ((blk.height / pageHeight) * 100).toFixed(3) }%`,
                  fontSize: `${ (blk.fontSize * cssScale).toFixed(2) }px`,
                  lineHeight: blk.lineHeightRatio,
                  color: 'transparent',
                  backgroundColor: isHov
                    ? 'rgba(37, 99, 235, 0.08)'
                    : 'transparent',
                  boxShadow: isHov
                    ? '0 0 0 1px rgba(37, 99, 235, 0.38)'
                    : 'none',
                  borderRadius: '2px',
                  overflow: 'hidden',
                  cursor: 'text',
                }}
              >
                {blk.text}
              </div>
            );
          })}

        <span className="pointer-events-none absolute right-2.5 bottom-2 rounded bg-slate-900/65 px-1.5 py-0.5 font-mono text-[10px] text-white/95">
          原文 {pageNumber}
        </span>
      </div>

      {/* Right: Style-Imitating Translated PDF Page */}
      {canTranslate && (
        <div
          className="relative shrink-0 rounded-xs bg-white text-slate-900 shadow-[0_2px_12px_-2px_rgba(15,23,42,0.14),0_0_0_1px_rgba(15,23,42,0.08)]"
          style={{
            width: `${ targetPaneWidth }px`,
            minHeight: `${ targetPaneHeight }px`,
            height:
              layoutMode === 'replica' ? `${ targetPaneHeight }px` : 'auto',
          }}
        >
          {/* Replica background canvas (kept mounted and hidden in flow mode so mode toggle is instant) */}
          <canvas
            ref={rightCanvasRef}
            className="block h-full w-full select-none"
            style={{ display: layoutMode === 'replica' ? 'block' : 'none' }}
          />

          {!renderedOk && (
            <div className="absolute inset-0 flex flex-col gap-3 bg-white p-8">
              <div className="h-5 w-1/2 animate-pulse rounded bg-slate-200" />
              <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
              <div className="h-3 w-10/12 animate-pulse rounded bg-slate-100" />
            </div>
          )}

          {renderedOk &&
            layoutMode === 'replica' &&
            translatableBlocks.map((blk) => (
              <ReplicaBlockOverlay
                key={blk.id}
                block={blk}
                pageWidth={pageWidth}
                pageHeight={pageHeight}
                cssScale={cssScale}
                state={pageTranslations[blk.id]}
                isHovered={hoveredBlockId === blk.id}
                onHoverChange={(h) => setHoveredBlockId(h ? blk.id : null)}
                onRetranslate={() => onRetranslateBlock(pageNumber, blk)}
              />
            ))}

          {renderedOk && layoutMode === 'flow' && (
            <div className="flex flex-col gap-3.5 px-9 py-8">
              {translatableBlocks.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  本页无可翻译段落
                </div>
              ) : (
                translatableBlocks.map((blk) => {
                  const st = pageTranslations[blk.id];
                  const scaleRatio = Math.min(
                    1.85,
                    Math.max(0.82, blk.fontSize / medianFontSize),
                  );
                  const isHov = hoveredBlockId === blk.id;
                  return (
                    <div
                      key={blk.id}
                      onMouseEnter={() => setHoveredBlockId(blk.id)}
                      onMouseLeave={() => setHoveredBlockId(null)}
                      style={{
                        fontFamily: FONT_STACK_MAP[blk.fontFamily],
                        fontSize: `${ (14.5 * scaleRatio).toFixed(1) }px`,
                        fontWeight: blk.isBold ? 700 : 400,
                        fontStyle: blk.isItalic ? 'italic' : 'normal',
                        textAlign: blk.align === 'center' ? 'center' : 'left',
                        textIndent:
                          blk.firstLineIndent > 0 && blk.align !== 'center'
                            ? '2em'
                            : undefined,
                        lineHeight: 1.68,
                      }}
                      className={`group relative rounded px-2 py-1 transition ${
                        isHov ? 'bg-blue-50/80 ring-1 ring-blue-500/30' : ''
                      }`}
                    >
                      {st?.status === 'error' ? (
                        <button
                          type="button"
                          onClick={() => onRetranslateBlock(pageNumber, blk)}
                          className="inline-flex items-center gap-1 rounded bg-red-50 px-2 py-0.5 font-sans text-xs text-red-700 ring-1 ring-red-200"
                        >
                          <RotateCcw size={11} />
                          <span>翻译失败 · 点击重试</span>
                        </button>
                      ) : st?.text ? (
                        <>
                          <span>{st.text}</span>
                          <button
                            type="button"
                            onClick={() => onRetranslateBlock(pageNumber, blk)}
                            title="重新翻译此段"
                            className="invisible absolute top-1 right-1 inline-flex items-center gap-0.5 rounded bg-slate-800 px-1.5 py-0.5 font-sans text-[10px] font-medium text-white group-hover:visible hover:bg-blue-600"
                          >
                            <RefreshCw size={9} />
                            <span>重译</span>
                          </button>
                        </>
                      ) : (
                        <div className="flex flex-col gap-1.5 py-1">
                          <div className="h-3 w-11/12 animate-pulse rounded bg-slate-200" />
                          <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          <span className="pointer-events-none absolute right-2.5 bottom-2 z-20 rounded bg-blue-950/70 px-1.5 py-0.5 font-mono text-[10px] text-white/95">
            译文 {pageNumber}
          </span>
        </div>
      )}
    </div>
  );
};

export const App: React.FC = () => {
  const { settings, loading: settingsLoading, patchSettings } = useSettings();

  const [sourceState, setSourceState] = useState<
    'idle' | 'loading' | 'password' | 'error' | 'ready'
  >('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [isLocalFileBlocked, setIsLocalFileBlocked] = useState(false);

  const [fileName, setFileName] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordIncorrect, setPasswordIncorrect] = useState(false);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [defaultPageSize, setDefaultPageSize] = useState({
    width: 595,
    height: 842,
  });
  const [recognition, setRecognition] = useState<TextRecognitionSummary | null>(
    null,
  );

  const [layoutMode, setLayoutMode] = useState<PdfLayoutMode>('replica');
  const [zoomValue, setZoomValue] = useState<'fit' | number>('fit');
  const [translateAllActive, setTranslateAllActive] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [lookupSignal, setLookupSignal] = useState(0);
  const [inFlightCount, setInFlightCount] = useState(0);

  // translations[pageNumber][blockId]
  const [translations, setTranslations] = useState<
    Record<number, Record<number, BlockTranslationState>>
  >({});

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rawBytesRef = useRef<Uint8Array | null>(null);
  const layoutCacheRef = useRef<Map<number, PdfPageLayout>>(new Map());
  const requestedPagesRef = useRef<Set<string>>(new Set());
  const translationMemoryRef = useRef<
    Map<string, { text: string; serviceName: string }>
  >(new Map());

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const nextItemIdRef = useRef(1);
  const itemRouteMapRef = useRef<
    Map<
      number,
      {
        pageNumber: number;
        blockId: number;
        cacheKey: string;
      }
    >
  >(new Map());
  const activeRequestIdsRef = useRef<Set<string>>(new Set());
  const settingsRef = useRef<ExtensionSettings>(settings);
  settingsRef.current = settings;

  const [containerWidth, setContainerWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 200) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sourceState]);

  const cancelAllInFlight = useCallback(() => {
    const port = portRef.current;
    if (port) {
      for (const reqId of activeRequestIdsRef.current) {
        try {
          const msg: StreamPortClientMessage = {
            type: 'CANCEL_REQUEST',
            requestId: reqId,
          };
          port.postMessage(msg);
        } catch {
          // ignore closed port
        }
      }
    }
    activeRequestIdsRef.current.clear();
    itemRouteMapRef.current.clear();
    setInFlightCount(0);
  }, []);

  const ensurePort = useCallback((): chrome.runtime.Port => {
    if (portRef.current) return portRef.current;

    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    portRef.current = port;

    let rafId: number | null = null;
    const pendingPatches = new Map<
      string,
      { pageNumber: number; blockId: number; state: BlockTranslationState }
    >();

    const flushPatches = () => {
      rafId = null;
      if (pendingPatches.size === 0) return;
      const entries = Array.from(pendingPatches.values());
      pendingPatches.clear();

      setTranslations((prev) => {
        const next = { ...prev };
        for (const item of entries) {
          next[item.pageNumber] = {
            ...(next[item.pageNumber] ?? {}),
            [item.blockId]: item.state,
          };
        }
        return next;
      });
    };

    const schedulePatch = (
      pageNumber: number,
      blockId: number,
      state: BlockTranslationState,
    ) => {
      pendingPatches.set(`${ pageNumber }:${ blockId }`, {
        pageNumber,
        blockId,
        state,
      });
      if (rafId === null) {
        rafId = requestAnimationFrame(flushPatches);
      }
    };

    port.onMessage.addListener((msg: StreamPortServerMessage) => {
      if (msg.type === 'BATCH_COMPLETE') {
        activeRequestIdsRef.current.delete(msg.requestId);
        setInFlightCount(activeRequestIdsRef.current.size);
        return;
      }
      if (
        msg.type !== 'ITEM_DELTA' &&
        msg.type !== 'ITEM_DONE' &&
        msg.type !== 'ITEM_ERROR'
      ) {
        return;
      }

      const route = itemRouteMapRef.current.get(msg.id);
      if (!route) return;

      if (msg.type === 'ITEM_DELTA') {
        schedulePatch(route.pageNumber, route.blockId, {
          status: 'streaming',
          text: msg.fullText,
          serviceName: msg.serviceName,
        });
      } else if (msg.type === 'ITEM_DONE') {
        itemRouteMapRef.current.delete(msg.id);
        translationMemoryRef.current.set(route.cacheKey, {
          text: msg.fullText,
          serviceName: msg.serviceName,
        });
        schedulePatch(route.pageNumber, route.blockId, {
          status: 'done',
          text: msg.fullText,
          serviceName: msg.serviceName,
        });
      } else if (msg.type === 'ITEM_ERROR') {
        itemRouteMapRef.current.delete(msg.id);
        schedulePatch(route.pageNumber, route.blockId, {
          status: 'error',
          text: '',
          error: msg.error,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      portRef.current = null;
      activeRequestIdsRef.current.clear();
      setInFlightCount(0);
    });

    return port;
  }, []);

  useEffect(() => {
    return () => {
      cancelAllInFlight();
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [cancelAllInFlight]);

  const dispatchBlocksTranslation = useCallback(
    (
      pageNumber: number,
      blocks: PdfTextBlock[],
      options: { bypassCache?: boolean } = {},
    ) => {
      const curSettings = settingsRef.current;
      const activeService = resolvePrimaryService(curSettings);
      const targetLang = curSettings.targetLang;

      const batchItems: BatchTranslateItem[] = [];
      const immediateState: Record<number, BlockTranslationState> = {};

      for (const blk of blocks) {
        if (!blk.translatable) continue;

        // If paragraph is already confidently in target language, preserve as-is without wasting API call
        if (!options.bypassCache && blk.text.length >= 26) {
          const guessed = inferLanguageFromUnicodeScripts(blk.text);
          if (guessed && isSameTargetLanguageFamily(guessed, targetLang)) {
            immediateState[blk.id] = { status: 'done', text: blk.text };
            continue;
          }
        }

        const cacheKey = `${ activeService.id }::${ targetLang }::${ blk.text }`;
        if (!options.bypassCache) {
          const hit = translationMemoryRef.current.get(cacheKey);
          if (hit) {
            immediateState[blk.id] = {
              status: 'done',
              text: hit.text,
              serviceName: hit.serviceName,
            };
            continue;
          }
        }

        const itemId = nextItemIdRef.current++;
        itemRouteMapRef.current.set(itemId, {
          pageNumber,
          blockId: blk.id,
          cacheKey,
        });
        immediateState[blk.id] = { status: 'loading', text: '' };
        batchItems.push({
          id: itemId,
          text: blk.text,
          plainText: blk.text,
        });
      }

      if (Object.keys(immediateState).length > 0) {
        setTranslations((prev) => ({
          ...prev,
          [pageNumber]: {
            ...(prev[pageNumber] ?? {}),
            ...immediateState,
          },
        }));
      }

      if (batchItems.length === 0) return;

      const requestId = `pdf_${ pageNumber }_${ Date.now() }_${ Math.random().toString(36).slice(2, 6) }`;
      activeRequestIdsRef.current.add(requestId);
      setInFlightCount(activeRequestIdsRef.current.size);

      const port = ensurePort();
      const payload: StreamPortClientMessage = {
        type: 'TRANSLATE_BATCH',
        requestId,
        serviceId: activeService.id,
        docTitle: fileName,
        sourceLang: curSettings.sourceLang,
        targetLang,
        items: batchItems,
      };
      port.postMessage(payload);
    },
    [ensurePort, fileName],
  );

  const handleRequestPageTranslate = useCallback(
    (pageNumber: number, blocks: PdfTextBlock[]) => {
      const curSettings = settingsRef.current;
      const activeService = resolvePrimaryService(curSettings);
      const pageKey = `${ activeService.id }::${ curSettings.targetLang }::p${ pageNumber }`;
      if (requestedPagesRef.current.has(pageKey)) return;
      requestedPagesRef.current.add(pageKey);
      dispatchBlocksTranslation(pageNumber, blocks);
    },
    [dispatchBlocksTranslation],
  );

  const handleRetranslateBlock = useCallback(
    (pageNumber: number, block: PdfTextBlock) => {
      dispatchBlocksTranslation(pageNumber, [block], { bypassCache: true });
    },
    [dispatchBlocksTranslation],
  );

  const handleLayoutReady = useCallback(
    (pageNumber: number, layout: PdfPageLayout) => {
      layoutCacheRef.current.set(pageNumber, layout);
    },
    [],
  );

  // Re-trigger already-hydrated pages when user switches target language or primary service
  const activeService = resolvePrimaryService(settings);
  useEffect(() => {
    if (sourceState !== 'ready' || !recognition?.hasRecognizableText) return;
    cancelAllInFlight();
    requestedPagesRef.current.clear();

    for (const [pageNum, cached] of layoutCacheRef.current.entries()) {
      const translatable = cached.blocks.filter((b) => b.translatable);
      if (translatable.length > 0) {
        const pageKey = `${ activeService.id }::${ settings.targetLang }::p${ pageNum }`;
        requestedPagesRef.current.add(pageKey);
        dispatchBlocksTranslation(pageNum, translatable);
      }
    }
  }, [
    activeService.id,
    settings.targetLang,
    sourceState,
    recognition?.hasRecognizableText,
    cancelAllInFlight,
    dispatchBlocksTranslation,
  ]);

  const openPdfBytes = useCallback(
    async (bytes: Uint8Array, name: string, password?: string) => {
      cancelAllInFlight();
      setSourceState('loading');
      setErrorMsg('');
      setIsLocalFileBlocked(false);
      setFileName(name);
      setTranslateAllActive(false);
      rawBytesRef.current = bytes;

      if (!password) {
        layoutCacheRef.current.clear();
        requestedPagesRef.current.clear();
        setTranslations({});
        setCurrentPage(1);
      }

      try {
        const loadingTask = pdfjsLib.getDocument({
          data: bytes.slice(0),
          password,
          fontExtraProperties: true,
          useSystemFonts: true,
          disableWorkerRendering: true,
        });
        const doc = await loadingTask.promise;

        const firstPage = await doc.getPage(1);
        const vp1 = firstPage.getViewport({ scale: 1 });
        setDefaultPageSize({ width: vp1.width, height: vp1.height });

        // Sample up to first 8 pages to check whether recognizable text exists
        const sampleCount = Math.min(doc.numPages, 8);
        const samples: string[] = [];
        for (let p = 1; p <= sampleCount; p++) {
          const pg = p === 1 ? firstPage : await doc.getPage(p);
          const tc = await pg.getTextContent();
          const pageText = tc.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ');
          samples.push(pageText);
        }

        const recSummary = analyzeRecognizableText(samples);
        setPdfDoc((prev) => {
          if (prev && prev !== doc) {
            void prev.loadingTask?.destroy();
          }
          return doc;
        });
        setNumPages(doc.numPages);
        setRecognition(recSummary);
        setPasswordIncorrect(false);
        setPasswordInput('');
        setSourceState('ready');
        document.title = `${ name } · Bo Translation PDF`;
      } catch (err) {
        if (isPasswordError(err)) {
          setPasswordIncorrect(Boolean(password));
          setSourceState('password');
          return;
        }
        setErrorMsg(
          err instanceof Error ? err.message : '无法解析此 PDF 文件，请确认文件未损坏。',
        );
        setSourceState('error');
      }
    },
    [cancelAllInFlight],
  );

  const loadFromFile = useCallback(
    async (file: File) => {
      const buf = await file.arrayBuffer();
      await openPdfBytes(new Uint8Array(buf), file.name || 'document.pdf');
    },
    [openPdfBytes],
  );

  const loadFromUrl = useCallback(
    async (rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return;

      cancelAllInFlight();
      setSourceState('loading');
      setErrorMsg('');
      setIsLocalFileBlocked(false);
      const inferredName = extractFileNameFromUrl(trimmed);
      setFileName(inferredName);

      try {
        const res = await fetch(trimmed, { credentials: 'include' });
        if (!res.ok) {
          throw new Error(`HTTP ${ res.status } ${ res.statusText }`);
        }
        const buf = await res.arrayBuffer();
        await openPdfBytes(new Uint8Array(buf), inferredName);
      } catch (err) {
        if (trimmed.startsWith('file://')) {
          setIsLocalFileBlocked(true);
          setErrorMsg(
            '受浏览器本地文件路径权限限制，请直接点击下方按钮选择该本地 PDF 文件，或将其拖入窗口即可开始双语对照。',
          );
        } else {
          setErrorMsg(
            `无法拉取在线 PDF（${ err instanceof Error ? err.message : '网络请求失败' }），您可以将文件下载到本地后拖入此处打开。`,
          );
        }
        setSourceState('error');
      }
    },
    [cancelAllInFlight, openPdfBytes],
  );

  // Auto-open `?url=...` passed from Popup / Content Script / Context Menu
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialUrl = params.get('url');
    if (initialUrl) {
      setUrlInput(initialUrl);
      void loadFromUrl(initialUrl);
    }
  }, [loadFromUrl]);

  // Selection lookup keyboard shortcut (`Alt+D` by default)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || isEditableTarget(e.target)) return;
      if (matchesShortcut(e, settings.shortcuts.selectionLookup)) {
        const sel = (window.getSelection()?.toString() ?? '').trim();
        if (sel) {
          e.preventDefault();
          setLookupSignal((n) => n + 1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [settings.shortcuts.selectionLookup]);

  const canTranslate = Boolean(recognition?.hasRecognizableText);
  const paneCount = canTranslate ? 2 : 1;
  const fitPaneWidth = useMemo(() => {
    const horizontalChrome = paneCount === 2 ? 64 : 40;
    const raw = Math.floor((containerWidth - horizontalChrome) / paneCount);
    return Math.max(320, Math.min(760, raw));
  }, [containerWidth, paneCount]);

  const targetPaneWidth =
    zoomValue === 'fit'
      ? fitPaneWidth
      : Math.round(defaultPageSize.width * zoomValue);

  const effectiveScalePct = Math.round(
    (targetPaneWidth / Math.max(1, defaultPageSize.width)) * 100,
  );

  const stepZoom = (delta: number) => {
    const currentRatio = targetPaneWidth / Math.max(1, defaultPageSize.width);
    const nextRatio = Math.min(
      2.2,
      Math.max(0.55, Math.round((currentRatio + delta) * 10) / 10),
    );
    setZoomValue(nextRatio);
  };

  const jumpToPage = (p: number) => {
    const target = Math.max(1, Math.min(numPages, p));
    setCurrentPage(target);
    document
      .getElementById(`pdf-page-${ target }`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openOptions = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('/options.html') });
  };

  if (settingsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-xs text-slate-500">
        正在加载阅读器…
      </div>
    );
  }

  const enabledServices = settings.services.filter((s) => s.enabled);
  const targetLangOptions = LANGUAGE_OPTIONS.filter((l) => l.code !== 'auto');

  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) {
          setDraggingFile(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDraggingFile(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDraggingFile(false);
        const dropped = Array.from(e.dataTransfer.files).find(
          (f) =>
            f.type === 'application/pdf' ||
            f.name.toLowerCase().endsWith('.pdf'),
        );
        if (dropped) {
          void loadFromFile(dropped);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) {
            void loadFromFile(picked);
          }
          e.currentTarget.value = '';
        }}
      />

      {/* Studio Top Bar */}
      <header className="z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200/90 bg-[oklch(0.985_0.003_250)] px-4 dark:border-zinc-800 dark:bg-[oklch(0.205_0.005_250)]">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src="/icon/128.png"
            alt="Bo Translation"
            className="h-6 w-6 shrink-0 select-none"
          />
          <span className="text-xs font-semibold tracking-tight whitespace-nowrap">
            PDF 双语对照
          </span>

          {sourceState === 'ready' && (
            <>
              <span className="text-slate-300 dark:text-zinc-700">/</span>
              <span
                className="max-w-52 truncate text-xs text-slate-600 dark:text-zinc-300"
                title={fileName}
              >
                {fileName}
              </span>
              <div className="ml-1 flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900">
                <input
                  type="number"
                  min={1}
                  max={numPages}
                  value={currentPage}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) jumpToPage(v);
                  }}
                  className="w-8 bg-transparent text-center font-mono outline-none"
                  aria-label="当前页码"
                />
                <span className="text-slate-400">/ {numPages}</span>
              </div>
            </>
          )}

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <FolderOpen size={13} />
            <span>打开 PDF</span>
          </button>
        </div>

        {/* Center View & Zoom Controls */}
        {sourceState === 'ready' && (
          <div className="hidden items-center gap-2 lg:flex">
            {canTranslate && (
              <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                <button
                  type="button"
                  onClick={() => setLayoutMode('replica')}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    layoutMode === 'replica'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                  title="保留原 PDF 图表、公式、分栏坐标与字体配色"
                >
                  版式复刻
                </button>
                <button
                  type="button"
                  onClick={() => setLayoutMode('flow')}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    layoutMode === 'flow'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                  title="按阅读顺序流式排版，保留标题字号与字重"
                >
                  纯净流式
                </button>
              </div>
            )}

            <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900">
              <button
                type="button"
                onClick={() => stepZoom(-0.15)}
                className="rounded p-1 text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title="缩小页面"
              >
                <Minus size={13} />
              </button>
              <button
                type="button"
                onClick={() => setZoomValue('fit')}
                className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                  zoomValue === 'fit'
                    ? 'bg-slate-100 font-semibold text-blue-600 dark:bg-zinc-800 dark:text-blue-400'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-300'
                }`}
                title="点击自动适应双栏宽度"
              >
                {zoomValue === 'fit' ? `适应 (${ effectiveScalePct }%)` : `${ effectiveScalePct }%`}
              </button>
              <button
                type="button"
                onClick={() => stepZoom(0.15)}
                className="rounded p-1 text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title="放大页面"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>
        )}

        {/* Right Service & Language Controls */}
        <div className="flex items-center gap-2">
          {inFlightCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-blue-600" />
              正在翻译
            </span>
          )}

          <div className="flex items-center gap-1.5">
            <Sparkles size={13} className="text-slate-400" />
            <select
              value={activeService.id}
              onChange={(e) =>
                patchSettings({ primaryServiceId: e.target.value })
              }
              aria-label="主翻译服务"
              className="h-7 max-w-44 rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {enabledServices.map((svc) => (
                <option key={svc.id} value={svc.id}>
                  {svc.name} · {svc.model}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            <Languages size={13} className="text-slate-400" />
            <select
              value={settings.targetLang}
              onChange={(e) =>
                patchSettings({
                  targetLang: e.target.value as TargetLanguageCode,
                })
              }
              aria-label="目标语言"
              className="h-7 rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {targetLangOptions.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          {sourceState === 'ready' && canTranslate && numPages > 2 && (
            <button
              type="button"
              onClick={() => setTranslateAllActive(true)}
              disabled={translateAllActive}
              className="hidden rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 md:inline-flex dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              title="后台预加载并翻译全部页面"
            >
              {translateAllActive ? '已开启全文预译' : '翻译全文'}
            </button>
          )}

          <button
            type="button"
            onClick={openOptions}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title="打开翻译服务与术语设置"
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* Non-text / Scanned PDF Notice Banner */}
      {sourceState === 'ready' && recognition && !recognition.hasRecognizableText && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle size={14} className="shrink-0 text-amber-600" />
          <span>
            {recognition.garbledRatio > 0.55
              ? '该 PDF 缺少有效的字体字符映射（提取文本存在乱码），暂无法生成可靠译文，已为您展示原始文档。'
              : '未在此 PDF 中识别到可提取的文字层（可能为扫描图片版 PDF），暂无法进行翻译，已为您展示原始文档。'}
          </span>
        </div>
      )}

      {/* Main Workspace */}
      <main
        ref={workspaceRef}
        className="relative flex-1 overflow-auto px-4 py-6"
      >
        {draggingFile && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-blue-950/25 backdrop-blur-[1px]">
            <div className="flex items-center gap-3 rounded-2xl border border-blue-400 bg-white px-6 py-4 text-sm font-semibold text-blue-700 shadow-lg dark:bg-zinc-900 dark:text-blue-300">
              <FileUp size={20} />
              <span>松开鼠标即可打开并对照翻译此 PDF</span>
            </div>
          </div>
        )}

        {sourceState === 'idle' && (
          <div className="mx-auto mt-10 flex max-w-xl flex-col gap-6">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="group flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-8 py-12 text-center transition hover:border-blue-500 hover:bg-blue-50/30 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-blue-500 dark:hover:bg-blue-950/20"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600 transition group-hover:scale-105 dark:bg-blue-950/60 dark:text-blue-400">
                <Columns2 size={24} />
              </div>
              <div className="space-y-1">
                <div className="text-base font-semibold">
                  选择或拖入本地 PDF 文件开始左右对照翻译
                </div>
                <p className="max-w-md text-xs leading-relaxed text-slate-500 dark:text-zinc-400">
                  自动检测可识别文字层，左侧呈现原版 PDF，右侧保留图表与公式并模仿原文档分栏、字号、字体和色彩实时流式翻译。所有文档均在浏览器本地解析。
                </p>
              </div>
              <span className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow-xs group-hover:bg-blue-700">
                <FileText size={14} />
                <span>选择本地 PDF 文件</span>
              </span>
            </button>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void loadFromUrl(urlInput);
              }}
              className="flex items-center gap-2 rounded-xl border border-slate-200/90 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <Link2 size={15} className="ml-2 shrink-0 text-slate-400" />
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="或粘贴在线 PDF 链接（如 https://arxiv.org/pdf/1706.03762.pdf）"
                className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
              <button
                type="submit"
                disabled={!urlInput.trim()}
                className="h-8 shrink-0 rounded-lg bg-slate-900 px-3.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                加载链接
              </button>
            </form>
          </div>
        )}

        {sourceState === 'loading' && (
          <div className="mx-auto mt-20 flex max-w-sm flex-col items-center gap-3 text-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
            <div className="text-xs font-medium text-slate-600 dark:text-zinc-300">
              正在解析 {fileName || 'PDF 文档'} 并检测可识别文字…
            </div>
          </div>
        )}

        {sourceState === 'password' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (rawBytesRef.current && passwordInput) {
                void openPdfBytes(rawBytesRef.current, fileName, passwordInput);
              }
            }}
            className="mx-auto mt-16 flex max-w-sm flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Lock size={16} className="text-blue-600" />
              <span>此 PDF 受密码保护</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              请输入文档阅读密码以在本地解锁并提取文字翻译：
            </p>
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="输入 PDF 密码"
              autoFocus
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
            {passwordIncorrect && (
              <div className="text-xs text-red-600">密码不正确，请重试。</div>
            )}
            <button
              type="submit"
              className="h-9 rounded-lg bg-blue-600 text-xs font-medium text-white hover:bg-blue-700"
            >
              解锁并翻译
            </button>
          </form>
        )}

        {sourceState === 'error' && (
          <div className="mx-auto mt-16 flex max-w-md flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-start gap-2.5">
              <AlertTriangle
                size={18}
                className="mt-0.5 shrink-0 text-amber-600"
              />
              <div className="space-y-1">
                <div className="text-sm font-semibold">
                  {isLocalFileBlocked
                    ? '需要手动选择该本地 PDF 文件'
                    : '打开 PDF 失败'}
                </div>
                <p className="text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
                  {errorMsg}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700"
              >
                <FolderOpen size={14} />
                <span>选择本地 PDF 文件</span>
              </button>
              <button
                type="button"
                onClick={() => setSourceState('idle')}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300"
              >
                返回首页
              </button>
            </div>
          </div>
        )}

        {sourceState === 'ready' && pdfDoc && (
          <div className="flex flex-col gap-5 pb-12">
            {Array.from({ length: numPages }, (_, idx) => idx + 1).map(
              (pageNum) => (
                <PdfPageRow
                  key={pageNum}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  defaultPageSize={defaultPageSize}
                  targetPaneWidth={targetPaneWidth}
                  layoutMode={layoutMode}
                  canTranslate={canTranslate}
                  forceActivate={translateAllActive}
                  pageTranslations={translations[pageNum] ?? {}}
                  cachedLayout={layoutCacheRef.current.get(pageNum)}
                  onLayoutReady={handleLayoutReady}
                  onRequestPageTranslate={handleRequestPageTranslate}
                  onRetranslateBlock={handleRetranslateBlock}
                  onPageVisible={setCurrentPage}
                />
              ),
            )}
          </div>
        )}
      </main>

      {/* Reuse existing contextual word/phrase SelectionPopover & Glossary quick-add */}
      <div className="bo-ui-root">
        <SelectionPopover settings={settings} shortcutSignal={lookupSignal} />
      </div>
    </div>
  );
};
