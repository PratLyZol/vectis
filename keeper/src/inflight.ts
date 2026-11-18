// Per-key mutual exclusion for async handlers. While a key is running, further calls for it do
// not start a second run; they ask for exactly one re-run after the current one finishes, so a
// trigger that arrives mid-flight (stream and RPC paths racing, or a close right after an open)
// is neither executed concurrently nor lost.
export class InFlight {
  private readonly running = new Map<string, boolean>(); // key -> re-run requested

  has(key: string): boolean {
    return this.running.has(key);
  }

  /** Returns true if this call executed `fn`, false if it was folded into a run already in flight. */
  async run(key: string, fn: () => Promise<void>): Promise<boolean> {
    if (this.running.has(key)) {
      this.running.set(key, true);
      return false;
    }
    this.running.set(key, false);
    try {
      do {
        this.running.set(key, false);
        await fn();
      } while (this.running.get(key) === true);
    } finally {
      this.running.delete(key);
    }
    return true;
  }
}
