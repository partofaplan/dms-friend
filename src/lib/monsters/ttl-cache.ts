/**
 * A small in-memory cache with a per-entry TTL and a hard size cap.
 *
 * Eviction is least-recently-used: a Map iterates in insertion order, so each
 * hit re-inserts its key at the end, and when a `set` would exceed `maxEntries`
 * the first (oldest) key is dropped. Expired entries are removed when read.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number; now?: () => number },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
