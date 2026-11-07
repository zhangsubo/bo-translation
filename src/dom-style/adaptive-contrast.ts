import type { TranslationColorMode } from '../types';

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const WHITE: RgbaColor = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: RgbaColor = { r: 0, g: 0, b: 0, a: 1 };

let canvasCtx: CanvasRenderingContext2D | null | undefined;
const parsedCache = new Map<string, RgbaColor>();

function clampChannel(val: number): number {
  return Math.max(0, Math.min(255, Number.isFinite(val) ? val : 0));
}

export function parseCssColor(raw: string): RgbaColor | null {
  const value = raw.trim();
  if (!value || value === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const cached = parsedCache.get(value);
  if (cached) return cached;

  // #rgb or #rrggbb
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const r = parseInt(value[1]! + value[1]!, 16);
    const g = parseInt(value[2]! + value[2]!, 16);
    const b = parseInt(value[3]! + value[3]!, 16);
    return { r, g, b, a: 1 };
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const r = parseInt(value.slice(1, 3), 16);
    const g = parseInt(value.slice(3, 5), 16);
    const b = parseInt(value.slice(5, 7), 16);
    return { r, g, b, a: 1 };
  }

  // rgb(...) / rgba(...)
  const rgbMatch = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
  );
  if (rgbMatch) {
    const alphaRaw = rgbMatch[4];
    let alpha = 1;
    if (alphaRaw !== undefined) {
      const parsedAlpha = Number.parseFloat(alphaRaw);
      alpha = alphaRaw.endsWith('%') ? parsedAlpha / 100 : parsedAlpha;
    }
    const color: RgbaColor = {
      r: clampChannel(Number(rgbMatch[1])),
      g: clampChannel(Number(rgbMatch[2])),
      b: clampChannel(Number(rgbMatch[3])),
      a: Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1)),
    };
    if (parsedCache.size >= 256) parsedCache.clear();
    parsedCache.set(value, color);
    return color;
  }

  // Browser canvas fallback for modern oklch() / lab() / color(display-p3 ...)
  if (
    typeof document !== 'undefined' &&
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('color', value) &&
    typeof CanvasRenderingContext2D !== 'undefined'
  ) {
    try {
      if (canvasCtx === undefined) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (canvasCtx) {
        canvasCtx.clearRect(0, 0, 1, 1);
        canvasCtx.fillStyle = value;
        canvasCtx.fillRect(0, 0, 1, 1);
        const data = canvasCtx.getImageData(0, 0, 1, 1).data;
        const color: RgbaColor = {
          r: data[0] ?? 0,
          g: data[1] ?? 0,
          b: data[2] ?? 0,
          a: (data[3] ?? 255) / 255,
        };
        if (parsedCache.size >= 256) parsedCache.clear();
        parsedCache.set(value, color);
        return color;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function compositeRgba(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  const outA = fg.a + bg.a * (1 - fg.a);
  if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / outA,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / outA,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / outA,
    a: outA,
  };
}

export function relativeLuminance(color: RgbaColor): number {
  const lin = (ch: number): number => {
    const s = ch / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
}

export function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixColors(from: RgbaColor, to: RgbaColor, amount: number): RgbaColor {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1,
  };
}

function mixUntilContrast(
  color: RgbaColor,
  pole: RgbaColor,
  bg: RgbaColor,
  minRatio: number,
): RgbaColor {
  if (contrastRatio(color, bg) >= minRatio) return color;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const candidate = mixColors(color, pole, mid);
    if (contrastRatio(candidate, bg) >= minRatio) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return mixColors(color, pole, high);
}

function colorDistance(a: RgbaColor, b: RgbaColor): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/**
 * Walks up the ancestor chain to compute the composited opaque RGB background behind `element`.
 */
export function getEffectiveBackgroundColor(element: Element): string {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return 'rgb(255, 255, 255)';
  }

  const layers: RgbaColor[] = [];
  let cur: Element | null = element;
  while (cur) {
    try {
      const bgStr = window.getComputedStyle(cur).backgroundColor;
      const parsed = parseCssColor(bgStr);
      if (parsed && parsed.a > 0) {
        layers.push(parsed);
        if (parsed.a >= 0.995) break;
      }
    } catch {
      // ignore
    }
    cur = cur.parentElement;
  }

  // Detect dark root canvas when page sets `color-scheme: dark` with transparent body
  let rootCanvas: RgbaColor = WHITE;
  try {
    const docEl = element.ownerDocument?.documentElement;
    if (docEl) {
      const scheme = window.getComputedStyle(docEl).colorScheme || '';
      if (scheme.includes('dark') && layers.length === 0) {
        rootCanvas = { r: 18, g: 18, b: 20, a: 1 };
      }
    }
  } catch {
    // ignore
  }

  let composited = rootCanvas;
  for (let i = layers.length - 1; i >= 0; i--) {
    composited = compositeRgba(layers[i]!, composited);
  }

  return `rgb(${ Math.round(composited.r) }, ${ Math.round(composited.g) }, ${ Math.round(composited.b) })`;
}

/**
 * Computes an accessible, reading-friendly secondary text color for bilingual translations:
 * - `'inherit'`: returns `null` so translation inherits exact source text color ("原色对照")
 * - `'adaptive'`: guarantees WCAG AA >= 4.6:1 contrast on both dark and light backgrounds while
 *   keeping a subtle visual distinction from source text ("双色智能提亮/压暗").
 */
export function resolveAdaptiveTranslationColor(
  sourceColorCss: string,
  backgroundCss: string,
  mode: TranslationColorMode = 'adaptive',
): string | null {
  if (mode === 'inherit') {
    return null;
  }

  const src = parseCssColor(sourceColorCss);
  const bgRaw = parseCssColor(backgroundCss);
  if (!src || !bgRaw) return null;

  const bg = compositeRgba(bgRaw, WHITE);
  const opaqueSource = compositeRgba(src, bg);

  const isDarkBg = contrastRatio(WHITE, bg) > contrastRatio(BLACK, bg);
  const contrastPole = isDarkBg ? WHITE : BLACK;

  // Reading-friendly cool slate-blue / teal accent that feels calm on long technical docs
  const accent: RgbaColor = isDarkBg
    ? { r: 148, g: 210, b: 255, a: 1 }
    : { r: 30, g: 78, b: 140, a: 1 };

  let mapped = mixUntilContrast(
    mixColors(opaqueSource, accent, 0.56),
    contrastPole,
    bg,
    4.6,
  );

  // If source text itself was already blue/teal so distance < 42, shift toward warm slate/cyan
  if (colorDistance(mapped, opaqueSource) < 42) {
    const altAccent: RgbaColor = isDarkBg
      ? { r: 94, g: 234, b: 212, a: 1 }
      : { r: 15, g: 118, b: 110, a: 1 };
    mapped = mixUntilContrast(
      mixColors(opaqueSource, altAccent, 0.72),
      contrastPole,
      bg,
      4.6,
    );
  }

  return `rgb(${ Math.round(mapped.r) }, ${ Math.round(mapped.g) }, ${ Math.round(mapped.b) })`;
}
