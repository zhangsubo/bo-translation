import type { TargetLanguageCode } from '../../../src/types';

export const BO_TRANS_TAG = 'bo-trans';
export const BO_UI_HOST_TAG = 'bo-trans-ui';
export const BO_SUBTITLE_HOST_TAG = 'bo-subtitle-overlay';

export const HARD_NON_CONTENT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'HEAD',
  'META',
  'LINK',
  'BO-TRANS',
  'BO-TRANS-UI',
  'BO-SUBTITLE-OVERLAY',
]);

export const KNOWN_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'MATH',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

export const KNOWN_INLINE_TAGS = new Set([
  'ABBR',
  'ACRONYM',
  'AUDIO',
  'B',
  'BDI',
  'BDO',
  'BIG',
  'BR',
  'BUTTON',
  'CANVAS',
  'CITE',
  'CODE',
  'DATA',
  'DATALIST',
  'DEL',
  'DFN',
  'EM',
  'I',
  'IMG',
  'INPUT',
  'INS',
  'KBD',
  'LABEL',
  'MAP',
  'MARK',
  'METER',
  'OUTPUT',
  'PICTURE',
  'PROGRESS',
  'Q',
  'RP',
  'RT',
  'RUBY',
  'S',
  'SAMP',
  'SELECT',
  'SLOT',
  'SMALL',
  'STRONG',
  'SUB',
  'SUP',
  'SVG',
  'TIME',
  'U',
  'TT',
  'VAR',
  'VIDEO',
  'WBR',
]);

export const DEFAULT_IGNORE_SELECTOR = [
  BO_TRANS_TAG,
  BO_UI_HOST_TAG,
  BO_SUBTITLE_HOST_TAG,
  '.html5-video-player',
  '.bpx-player-container',
  '#bilibili-player',
  'pre',
  'button',
  'nav',
  'footer',
  'svg',
  'canvas',
  'input',
  'select',
  'option',
  'textarea',
  'math',
  '.math-block',
  '.MathJax',
  'span.katex-display',
  '.prism-code',
  '.enlighter-code',
  '.rc-CodeBlock',
  '[role="code"]',
  'table.highlight',
  'div[class^="codeBlockContent"]',
  'div[class^="codeBlockLines"]',
  'div[class^="token-line"]',
  '.monaco-editor',
  '.cm-editor',
  '.CodeMirror',
  '#ace-editor',
  '.material-icons',
  '[class^="material-symbols-"]',
  'i.fa',
  'i[class^="fa-"]',
  '.notranslate',
  '[translate="no"]',
  '[contenteditable="true"]',
].join(', ');

export const KEEP_INLINE_TAGS = new Set([
  'CODE',
  'KBD',
  'SAMP',
  'VAR',
  'TT',
  'SUB',
  'SUP',
  'IMG',
  'SVG',
  'MATH',
]);

export const KEEP_INLINE_SELECTOR = [
  'code',
  'kbd',
  'samp',
  'var',
  'tt',
  'sub',
  'sup',
  'img',
  'svg',
  'math',
  '.math',
  'span.katex',
  '.mwe-math-element',
  '[translate="no"]',
  '.notranslate',
].join(', ');

export const TRANSLATABLE_INLINE_WRAPPER_TAGS = new Set([
  'A',
  'STRONG',
  'B',
  'EM',
  'I',
  'SPAN',
  'MARK',
  'U',
  'S',
  'DEL',
  'INS',
  'SMALL',
  'Q',
  'CITE',
  'ABBR',
]);

export interface BuiltinDomainRule {
  domains: string[];
  autoScan: boolean;
  selectors?: string;
  rootsSelector?: string;
  extraIgnoreSelector?: string;
}

export const BUILTIN_DOMAIN_RULES: BuiltinDomainRule[] = [
  {
    domains: ['github.com'],
    autoScan: false,
    selectors: [
      '.markdown-body h1',
      '.markdown-body h2',
      '.markdown-body h3',
      '.markdown-body h4',
      '.markdown-body h5',
      '.markdown-body h6',
      '.markdown-body p',
      '.markdown-body li',
      '.markdown-body blockquote',
      '.markdown-body td',
      '.markdown-body th',
      '.comment-body p',
      '.comment-body li',
      '[data-testid="issue-title"]',
      '.repo-description p',
      '.f4.my-3',
    ].join(', '),
    extraIgnoreSelector: '.blob-code, .blob-num, .file-header, .pl-c, .react-code-lines',
  },
  {
    domains: ['news.ycombinator.com'],
    autoScan: false,
    selectors: '.titleline > a, .commtext, .toptext',
    extraIgnoreSelector: '.sitebit, .subtext',
  },
  {
    domains: ['stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com'],
    autoScan: false,
    selectors:
      '.s-prose p, .s-prose li, .s-prose h1, .s-prose h2, .s-prose h3, .s-prose blockquote, #question-header h1 a, .comment-copy',
  },
  {
    domains: ['developer.mozilla.org'],
    autoScan: true,
    rootsSelector: 'main, article',
    extraIgnoreSelector: '.code-example, .interactive, .bc-table',
  },
];

export function findBuiltinDomainRule(hostname: string): BuiltinDomainRule | undefined {
  const clean = hostname.toLowerCase();
  return BUILTIN_DOMAIN_RULES.find((rule) =>
    rule.domains.some((d) => clean === d || clean.endsWith(`.${ d }`)),
  );
}

export function isKeepInlineElement(el: Element): boolean {
  if (KEEP_INLINE_TAGS.has(el.tagName)) return true;
  // API documentation symbol link protection: `a:has(code)`
  if (el.tagName === 'A' && el.querySelector('code') !== null) {
    return true;
  }
  try {
    return el.matches(KEEP_INLINE_SELECTOR);
  } catch {
    return false;
  }
}

const SKIP_PATTERNS: RegExp[] = [
  /^[\d\s.,:%$€£¥+\-*/=()[\]{}<>|\\#@!~`'"?&_—–]+$/, // pure numbers, currency, symbols
  /^v?\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?$/, // semver e.g. v1.2.3-beta.1
  /^https?:\/\/\S+$/i, // single URL
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, // email
  /^(\.{0,2}\/|~\/|[A-Za-z]:\\)[\w./\\-]+$/, // Unix or Windows path
  /^[\w-]+\.(js|ts|tsx|jsx|json|md|py|rs|go|java|cpp|c|h|css|html|yml|yaml|toml|sh|lock)$/i, // filename
  /^[0-9a-f]{7,64}$/i, // git sha / uuid / hex hash
  /^#[0-9a-f]{3,8}$/i, // hex color
  /^@[a-zA-Z0-9_.-]+$/, // @handle
];

const TABLE_CELL_SKIP_PATTERNS: RegExp[] = [
  /^[A-Z0-9_.-]{2,}$/, // ENV_VAR or ENUM_CONSTANT
  /^(\/[a-zA-Z0-9_.:{}-]+)+$/, // REST API route e.g. /v1/chat/completions
];

export function shouldSkipTextSegment(
  plainText: string,
  hostTagName: string,
  targetLang: TargetLanguageCode = 'zh-CN',
): boolean {
  const trimmed = plainText.trim();
  if (!trimmed || trimmed.length < 2) return true;

  // Must contain at least one letter from any script
  if (!/\p{L}/u.test(trimmed)) return true;

  for (const regex of SKIP_PATTERNS) {
    if (regex.test(trimmed)) return true;
  }

  if (hostTagName === 'TD' || hostTagName === 'TH') {
    for (const regex of TABLE_CELL_SKIP_PATTERNS) {
      if (regex.test(trimmed)) return true;
    }
  }

  // Skip when text is already predominantly in Chinese and target is Chinese
  if (targetLang === 'zh-CN' || targetLang === 'zh-TW') {
    const letters = trimmed.match(/\p{L}/gu) ?? [];
    if (letters.length >= 4) {
      const hanChars = trimmed.match(/\p{Script=Han}/gu) ?? [];
      if (hanChars.length / letters.length > 0.65) {
        return true;
      }
    }
  }

  return false;
}
