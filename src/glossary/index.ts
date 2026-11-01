import type { GlossaryEntry } from '../types';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTermRegex(source: string, caseSensitive: boolean): RegExp {
  const trimmed = source.trim();
  const escaped = escapeRegExp(trimmed);
  const startsWord = /^[A-Za-z0-9_]/.test(trimmed);
  const endsWord = /[A-Za-z0-9_]$/.test(trimmed);
  const prefix = startsWord ? '(?<![A-Za-z0-9_])' : '';
  const suffix = endsWord ? '(?![A-Za-z0-9_])' : '';
  const flags = caseSensitive ? 'g' : 'gi';
  return new RegExp(`${ prefix }${ escaped }${ suffix }`, flags);
}

/**
 * Filter enabled glossary entries to ONLY those actually appearing in the given texts.
 * Longer terms are sorted first so multi-word phrases take priority over sub-words.
 */
export function matchGlossaryEntries(
  texts: string[],
  glossary: GlossaryEntry[],
): GlossaryEntry[] {
  const combined = texts.join('\n');
  if (!combined.trim() || glossary.length === 0) return [];

  const active = glossary
    .filter((entry) => entry.enabled && entry.source.trim().length > 0)
    .sort((a, b) => b.source.length - a.source.length);

  return active.filter((entry) => {
    const regex = buildTermRegex(entry.source, entry.caseSensitive);
    return regex.test(combined);
  });
}

export interface LockedGlossaryResult {
  lockedText: string;
  keepMap: Map<string, string>;
}

/**
 * Replace `strategy === 'keep'` terms with opaque `{{K0}}` tokens outside existing `{{...}}` or `<...>` tags.
 */
export function lockKeepGlossaryTerms(
  serializedText: string,
  matchedEntries: GlossaryEntry[],
): LockedGlossaryResult {
  const keepEntries = matchedEntries.filter((e) => e.strategy === 'keep');
  const keepMap = new Map<string, string>();
  if (keepEntries.length === 0 || !serializedText) {
    return { lockedText: serializedText, keepMap };
  }

  let counter = 0;
  // Split by existing placeholders {{...}} and inline tags <...> so we never corrupt markup tokens
  const tokenSplitter = /(\{\{[^}]+\}\}|<\/?[a-zA-Z0-9-]+>)/g;
  const parts = serializedText.split(tokenSplitter);

  const processed = parts
    .map((part) => {
      if (
        (part.startsWith('{{') && part.endsWith('}}')) ||
        (part.startsWith('<') && part.endsWith('>'))
      ) {
        return part;
      }
      let segment = part;
      for (const entry of keepEntries) {
        const regex = buildTermRegex(entry.source, entry.caseSensitive);
        segment = segment.replace(regex, (matched) => {
          const token = `{{K${ counter++ }}}`;
          keepMap.set(token, matched);
          return token;
        });
      }
      return segment;
    })
    .join('');

  return { lockedText: processed, keepMap };
}

export function unlockKeepGlossaryTerms(
  translatedText: string,
  keepMap: Map<string, string>,
): string {
  if (keepMap.size === 0 || !translatedText) return translatedText;
  let result = translatedText;
  for (const [token, original] of keepMap.entries()) {
    result = result.split(token).join(original);
  }
  return result;
}

export function buildGlossaryPromptSection(matchedEntries: GlossaryEntry[]): string {
  if (matchedEntries.length === 0) return '';

  const lines = matchedEntries.map((entry) => {
    if (entry.strategy === 'keep') {
      return `- "${ entry.source }" -> keep original "${ entry.source }" untranslated`;
    }
    return `- "${ entry.source }" -> "${ entry.target }"`;
  });

  return [
    'Required Terminology (strictly apply these exact translations when matched):',
    ...lines,
  ].join('\n');
}

export function exportGlossaryJson(entries: GlossaryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

function escapeCsvCell(val: string): string {
  if (/[",\n\r]/.test(val)) {
    return `"${ val.replace(/"/g, '""') }"`;
  }
  return val;
}

export function exportGlossaryCsv(entries: GlossaryEntry[]): string {
  const header = 'source,target,strategy,caseSensitive,note';
  const rows = entries.map((e) =>
    [
      escapeCsvCell(e.source),
      escapeCsvCell(e.target),
      escapeCsvCell(e.strategy),
      e.caseSensitive ? 'true' : 'false',
      escapeCsvCell(e.note ?? ''),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function parseGlossaryImport(content: string): GlossaryEntry[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item) => item && typeof item.source === 'string' && item.source.trim())
      .map((item, idx) => ({
        id:
          typeof item.id === 'string' && item.id
            ? item.id
            : `gls_imp_${ Date.now() }_${ idx }`,
        source: item.source.trim(),
        target: typeof item.target === 'string' ? item.target.trim() : '',
        strategy: item.strategy === 'keep' || !item.target ? 'keep' : 'translate',
        caseSensitive: Boolean(item.caseSensitive),
        note: typeof item.note === 'string' ? item.note : '',
        enabled: item.enabled !== false,
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now() + idx,
      }));
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const firstCells = parseCsvLine(lines[0] ?? '').map((c) => c.trim().toLowerCase());
  const hasHeader =
    firstCells.includes('source') || firstCells[0] === '原文' || firstCells[0] === 'term';
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const entries: GlossaryEntry[] = [];
  dataLines.forEach((line, idx) => {
    const [rawSource = '', rawTarget = '', rawStrategy = '', rawCase = '', rawNote = ''] =
      parseCsvLine(line);
    const source = rawSource.trim();
    if (!source) return;
    const target = rawTarget.trim();
    const strategy =
      rawStrategy.trim().toLowerCase() === 'keep' || !target ? 'keep' : 'translate';
    entries.push({
      id: `gls_csv_${ Date.now() }_${ idx }`,
      source,
      target: strategy === 'keep' ? '' : target,
      strategy,
      caseSensitive: rawCase.trim().toLowerCase() === 'true',
      note: rawNote.trim(),
      enabled: true,
      createdAt: Date.now() + idx,
    });
  });

  return entries;
}
