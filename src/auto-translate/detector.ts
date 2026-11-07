import type { TargetLanguageCode } from '../types';

export interface LanguageDetectResult {
  languages: Array<{ language: string; percentage: number }>;
}

export type BrowserLanguageDetector = (
  text: string,
) => Promise<LanguageDetectResult>;

const SKIP_SAMPLE_SELECTOR = [
  'bo-trans',
  'bo-trans-ui',
  'bo-subtitle-overlay',
  'script',
  'style',
  'noscript',
  'pre',
  'code',
  'textarea',
  'input',
  'select',
  'button',
  'nav',
  'header',
  'footer',
  'aside',
  '[contenteditable="true"]',
  '[hidden]',
  '[aria-hidden="true"]',
].join(', ');

/**
 * Maps BCP-47 language codes (`zh-CN`, `en-US`, `ja-JP`, etc.) to canonical primary language families.
 */
export function getLanguageFamily(code: string): string {
  const clean = code.trim().toLowerCase().replace(/_/g, '-');
  if (!clean || clean === 'auto' || clean === 'und') return '';
  if (clean.startsWith('zh')) {
    // Distinguish Traditional vs Simplified if both sides specify script/region, else 'zh'
    if (
      clean.includes('tw') ||
      clean.includes('hk') ||
      clean.includes('hant')
    ) {
      return 'zh-hant';
    }
    return 'zh-hans';
  }
  return clean.split('-')[0] ?? '';
}

export function isSameTargetLanguageFamily(
  detectedLang: string,
  targetLang: TargetLanguageCode,
): boolean {
  const detFam = getLanguageFamily(detectedLang);
  const tgtFam = getLanguageFamily(targetLang);
  if (!detFam || !tgtFam) return false;
  if (detFam === tgtFam) return true;
  // `chrome.i18n.detectLanguage` often returns generic `"zh"` without `-CN`/`-TW`
  if (
    detectedLang.trim().toLowerCase() === 'zh' &&
    (tgtFam === 'zh-hans' || tgtFam === 'zh-hant')
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts up to `maxChars` of visible prose from `<main>`/`<article>`/`<body>` for zero-network language detection.
 */
export function sampleReadablePageText(
  doc: Document,
  maxChars = 4200,
): string {
  const mainCandidates = Array.from(
    doc.querySelectorAll('main, article, [role="main"]'),
  );
  const bestRoot =
    mainCandidates.sort(
      (a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0),
    )[0] ?? doc.body;

  if (!bestRoot) return '';

  const walker = doc.createTreeWalker(bestRoot, NodeFilter.SHOW_TEXT);
  let out = '';

  while (walker.nextNode() && out.length < maxChars) {
    const textNode = walker.currentNode;
    const raw = textNode.nodeValue?.trim();
    if (!raw) continue;
    const parent = textNode.parentElement;
    if (!parent || parent.closest(SKIP_SAMPLE_SELECTOR)) continue;
    out += `${ raw }\n`;
  }

  return out.slice(0, maxChars).trim();
}

/**
 * Pure Unicode script fallback detector when `chrome.i18n.detectLanguage` is unavailable or inconclusive.
 */
export function inferLanguageFromUnicodeScripts(
  sampleText: string,
  htmlLang = '',
): string {
  const letters = sampleText.match(/\p{L}/gu) ?? [];
  if (letters.length < 24) {
    return htmlLang.trim();
  }

  const total = letters.length;
  const han = (sampleText.match(/\p{Script=Han}/gu) ?? []).length;
  const kana = (
    sampleText.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []
  ).length;
  const hangul = (sampleText.match(/\p{Script=Hangul}/gu) ?? []).length;
  const cyrillic = (sampleText.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (sampleText.match(/\p{Script=Latin}/gu) ?? []).length;

  if (kana / total >= 0.08) return 'ja';
  if (hangul / total >= 0.35) return 'ko';
  if (han / total >= 0.45) return 'zh';
  if (cyrillic / total >= 0.5) return 'ru';

  if (latin / total >= 0.7) {
    const htmlFam = getLanguageFamily(htmlLang);
    if (htmlFam && !htmlFam.startsWith('zh') && htmlFam !== 'ja' && htmlFam !== 'ko') {
      return htmlLang.trim();
    }
    return 'en';
  }

  return htmlLang.trim();
}

/**
 * Determines whether a page sample is confidently in a foreign language relative to `targetLang`.
 * Zero network calls: uses browser-local `chrome.i18n.detectLanguage` (>= 70% confidence) + Unicode script & `<html lang>` heuristics.
 */
export async function detectIsForeignPage(params: {
  sampleText: string;
  htmlLang: string;
  targetLang: TargetLanguageCode;
  browserDetect?: BrowserLanguageDetector;
}): Promise<boolean> {
  const { sampleText, htmlLang, targetLang, browserDetect } = params;
  const trimmed = sampleText.trim();
  if (trimmed.length < 40) {
    return false;
  }

  let detected = '';
  const detector =
    browserDetect ??
    (typeof chrome !== 'undefined' &&
    typeof chrome.i18n?.detectLanguage === 'function'
      ? (t: string) => chrome.i18n.detectLanguage(t)
      : undefined);

  if (detector) {
    try {
      const res = await detector(trimmed);
      const best = res?.languages?.[0];
      if (best && best.percentage >= 70 && best.language !== 'und') {
        detected = best.language;
      }
    } catch {
      // fall through to local script heuristic
    }
  }

  if (!detected) {
    detected = inferLanguageFromUnicodeScripts(trimmed, htmlLang);
  }

  if (!detected || detected === 'und') {
    return false;
  }

  return !isSameTargetLanguageFamily(detected, targetLang);
}
