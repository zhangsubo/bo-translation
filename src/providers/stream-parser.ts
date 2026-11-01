export interface LineStreamCallbacks {
  onDelta?: (id: number, fullText: string) => void;
  onDone?: (id: number, fullText: string) => void;
}

/**
 * Strip completed `<think>...</think>` blocks and hide any in-progress `<think>...` block during streaming.
 */
export function stripThinkingBlocks(raw: string): {
  clean: string;
  isInsideThink: boolean;
} {
  if (!raw) return { clean: '', isInsideThink: false };
  // Remove completed <think>...</think> blocks
  let text = raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  // Check if there is still an unclosed <think>
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1) {
    return {
      clean: text.slice(0, openIdx),
      isInsideThink: true,
    };
  }
  return { clean: text, isInsideThink: false };
}

function cleanCodeFences(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '');
}

/**
 * Incremental parser for `ID | translated_text` streamed output.
 * Handles multi-item line batches, thinking blocks, stray markdown fences,
 * and single-item prefix omission on smaller local models.
 */
export class BatchLineStreamParser {
  private buffer = '';
  private expectedSet: Set<number>;
  private singleFallbackId: number | null;
  private emittedValues = new Map<number, string>();
  private completedIds = new Set<number>();
  private activeId: number | null = null;
  private callbacks: LineStreamCallbacks;

  constructor(expectedIds: number[], callbacks: LineStreamCallbacks = {}) {
    this.expectedSet = new Set(expectedIds);
    this.singleFallbackId =
      expectedIds.length === 1 ? (expectedIds[0] ?? null) : null;
    this.callbacks = callbacks;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    this.process(false);
  }

  finalize(): Set<number> {
    this.process(true);
    return new Set(this.completedIds);
  }

  private process(isFinal: boolean): void {
    const { clean, isInsideThink } = stripThinkingBlocks(this.buffer);
    if (!clean.trim() && isInsideThink && !isFinal) {
      return;
    }

    const stripped = cleanCodeFences(clean);
    const lines = stripped.split(/\r?\n/);

    const parsedItems: Array<{ id: number; text: string }> = [];

    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s*\|\s?(.*)$/);
      if (match) {
        const candidateId = Number(match[1]);
        if (this.expectedSet.has(candidateId)) {
          parsedItems.push({ id: candidateId, text: match[2] ?? '' });
          continue;
        }
      }

      const last = parsedItems[parsedItems.length - 1];
      if (last) {
        // Continuation line belonging to the current item
        if (line.trim() || !isFinal) {
          last.text = last.text ? `${ last.text }<br>${ line }` : line;
        }
      } else if (this.singleFallbackId !== null) {
        // Single-segment fallback when a small model omits `0 | `
        const trimmedStart = stripped.trimStart();
        if (
          isFinal ||
          (trimmedStart.length > 5 && !/^\d+\s*\|?$/.test(trimmedStart))
        ) {
          parsedItems.push({
            id: this.singleFallbackId,
            text: stripped.trim(),
          });
          break;
        }
      }
    }

    for (let i = 0; i < parsedItems.length; i++) {
      const item = parsedItems[i];
      if (!item) continue;
      const isLastItem = i === parsedItems.length - 1;
      const trimmedText = isFinal || !isLastItem ? item.text.trim() : item.text;

      // If we moved on to a new ID, finalize the previous active ID
      if (!isLastItem && !this.completedIds.has(item.id)) {
        this.emittedValues.set(item.id, trimmedText);
        this.completedIds.add(item.id);
        this.callbacks.onDone?.(item.id, trimmedText);
        continue;
      }

      if (isLastItem) {
        this.activeId = item.id;
        if (isFinal) {
          if (!this.completedIds.has(item.id) && trimmedText.length > 0) {
            this.emittedValues.set(item.id, trimmedText);
            this.completedIds.add(item.id);
            this.callbacks.onDone?.(item.id, trimmedText);
          }
        } else {
          const prev = this.emittedValues.get(item.id);
          if (prev !== trimmedText && trimmedText.length > 0) {
            this.emittedValues.set(item.id, trimmedText);
            this.callbacks.onDelta?.(item.id, trimmedText);
          }
        }
      }
    }
  }
}
