export class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: Array<{
    run: () => void;
    reject: (reason?: unknown) => void;
    signal?: AbortSignal;
  }> = [];

  constructor(private limit: number) {}

  setLimit(nextLimit: number): void {
    this.limit = Math.max(1, nextLimit);
    this.drain();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    await new Promise<void>((resolve, reject) => {
      if (this.activeCount < this.limit) {
        this.activeCount++;
        resolve();
        return;
      }

      const entry = {
        run: () => {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        },
        reject,
        signal,
      };

      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
        }
        reject(new DOMException('Aborted', 'AbortError'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queue.push(entry);
    });

    try {
      return await fn();
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
    }
  }

  private drain(): void {
    while (this.activeCount < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        continue;
      }
      this.activeCount++;
      next.run();
    }
  }
}
