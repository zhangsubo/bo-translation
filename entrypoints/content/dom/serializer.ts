import {
  isKeepInlineElement,
  TRANSLATABLE_INLINE_WRAPPER_TAGS,
} from './rules';

export interface SerializedNodeGroup {
  /** Text sent to LLM containing `{{0}}` opaque tokens and `<a0>...</a0>` inline wrappers */
  serializedText: string;
  /** Natural-language text with opaque code blocks stripped (used for skip-guard checks) */
  translatablePlainText: string;
  /** Full human-readable plain text (including inline code text, used for glossary/context) */
  fullPlainText: string;
  opaqueMap: Map<string, string>;
  wrapperMap: Map<string, { openTag: string; closeTag: string }>;
}

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractOpenAndCloseTag(el: Element): {
  openTag: string;
  closeTag: string;
} {
  const shallowClone = el.cloneNode(false) as Element;
  const html = shallowClone.outerHTML;
  const closeMatch = html.match(/(<\/[a-zA-Z0-9:-]+>)$/);
  if (closeMatch && closeMatch[1] && closeMatch.index !== undefined) {
    return {
      openTag: html.slice(0, closeMatch.index),
      closeTag: closeMatch[1],
    };
  }
  const tag = el.tagName.toLowerCase();
  return { openTag: `<${ tag }>`, closeTag: `</${ tag }>` };
}

export function serializeNodeGroup(nodes: ChildNode[]): SerializedNodeGroup {
  const opaqueMap = new Map<string, string>();
  const wrapperMap = new Map<string, { openTag: string; closeTag: string }>();
  let opaqueIdx = 0;
  let wrapperIdx = 0;
  let translatablePlainText = '';
  let fullPlainText = '';

  const walk = (nodeList: Iterable<ChildNode>): string => {
    let out = '';

    for (const node of nodeList) {
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue ?? '';
        out += val;
        translatablePlainText += val;
        fullPlainText += val;
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const el = node as Element;
      if (el.tagName === 'BR') {
        out += '<br>';
        translatablePlainText += '\n';
        fullPlainText += '\n';
        continue;
      }

      if (isKeepInlineElement(el)) {
        const token = `{{${ opaqueIdx++ }}}`;
        opaqueMap.set(token, el.outerHTML);
        out += token;
        fullPlainText += el.textContent ?? '';
        continue;
      }

      if (TRANSLATABLE_INLINE_WRAPPER_TAGS.has(el.tagName)) {
        const reservedIdx = wrapperIdx++;
        const inner = walk(Array.from(el.childNodes));
        if (!inner.trim()) {
          out += inner;
          continue;
        }
        const key = `a${ reservedIdx }`;
        wrapperMap.set(key, extractOpenAndCloseTag(el));
        out += `<${ key }>${ inner }</${ key }>`;
        continue;
      }

      // Unknown inline element: preserve opaquely if no text, else walk children
      if (!(el.textContent ?? '').trim()) {
        const token = `{{${ opaqueIdx++ }}}`;
        opaqueMap.set(token, el.outerHTML);
        out += token;
      } else {
        out += walk(Array.from(el.childNodes));
      }
    }

    return out;
  };

  const serializedText = walk(nodes).replace(/\s+/g, ' ').trim();

  return {
    serializedText,
    translatablePlainText: translatablePlainText.replace(/\s+/g, ' ').trim(),
    fullPlainText: fullPlainText.replace(/\s+/g, ' ').trim(),
    opaqueMap,
    wrapperMap,
  };
}

/**
 * Safely restore translated text containing `<a0>...</a0>`, `<br>`, and `{{0}}` into rich HTML.
 * - Escapes stray `<` / `>` in LLM prose
 * - Restores nested `<a0><a1>...</a1></a0>` bottom-up via DOMParser
 * - Substitutes `{{0}}` opaque HTML tokens last so code snippets are 100% untouched
 */
export function restoreRichTranslation(
  translatedText: string,
  meta: Pick<SerializedNodeGroup, 'opaqueMap' | 'wrapperMap'>,
): string {
  if (!translatedText) return '';

  // 1. Protect valid <br> and known <aN> / </aN> markers before HTML-escaping raw text
  const validTagTokens = new Map<string, string>();
  let tagSeq = 0;

  const protectedStage = translatedText.replace(
    /<br\s*\/?>|<(\/?)(a\d+)>/gi,
    (full, slash: string | undefined, wrapperKey: string | undefined) => {
      if (/^<br/i.test(full)) {
        const marker = `__BO_BR_${ tagSeq++ }__`;
        validTagTokens.set(marker, '<br>');
        return marker;
      }
      const normalizedKey = (wrapperKey ?? '').toLowerCase();
      if (meta.wrapperMap.has(normalizedKey)) {
        const marker = `__BO_WRAP_${ tagSeq++ }__`;
        const replacement = slash
          ? '</span>'
          : `<span data-bo-restore="${ normalizedKey }">`;
        validTagTokens.set(marker, replacement);
        return marker;
      }
      // Stray unknown <a99> dropped cleanly
      return '';
    },
  );

  // 2. Escape any raw HTML characters in prose (`a < b && c > d`)
  let htmlStage = escapeHtmlText(protectedStage);

  // 3. Put back safe `<br>` and `<span data-bo-restore="aN">`
  for (const [marker, safeHtml] of validTagTokens.entries()) {
    htmlStage = htmlStage.split(marker).join(safeHtml);
  }

  // 4. Parse with DOMParser and restore original openTag/closeTag bottom-up (.reverse())
  if (meta.wrapperMap.size > 0 && htmlStage.includes('data-bo-restore=')) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${ htmlStage }</body>`, 'text/html');
    const spans = Array.from(doc.body.querySelectorAll('span[data-bo-restore]')).reverse();

    for (const span of spans) {
      const key = span.getAttribute('data-bo-restore') ?? '';
      const pair = meta.wrapperMap.get(key);
      if (!pair) {
        span.replaceWith(...Array.from(span.childNodes));
        continue;
      }
      const wrapperFrag = parser.parseFromString(
        `<body>${ pair.openTag }${ span.innerHTML }${ pair.closeTag }</body>`,
        'text/html',
      );
      span.replaceWith(...Array.from(wrapperFrag.body.childNodes));
    }

    htmlStage = doc.body.innerHTML;
  }

  // 5. Substitute opaque `{{n}}` tokens with exact original outerHTML (`<code>`, `<a href><code>`, etc.)
  for (const [token, exactOuterHtml] of meta.opaqueMap.entries()) {
    htmlStage = htmlStage.split(token).join(exactOuterHtml);
  }

  return htmlStage;
}
