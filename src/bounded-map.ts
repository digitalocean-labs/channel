/**
 * A `Map` with a maximum size. When the size goes above the maximum, the
 * map removes the oldest entries. The channel uses this map for
 * pending-response callbacks. Thus requests that never get a response do
 * not collect without limit.
 *
 * "Oldest" means the entry with the oldest *write*. JavaScript `Map`s
 * iterate in insertion order, and `set` (below) always moves the key to
 * the end. Thus each write refreshes the position of an entry. Reads
 * (`get`) do not. This map is not a full LRU cache. The channel does not
 * need one: the channel writes each pending response one time and reads
 * it one time.
 */
export class BoundedMap<T, U> extends Map<T, U> {
  #maxSize: number;

  constructor(maxSize: number) {
    super();

    if (maxSize <= 0) {
      throw new Error("maxSize must be greater than 0");
    }

    this.#maxSize = maxSize;
  }

  /*
   * Each method that can insert an entry has an override that prunes
   * afterwards. Thus the limit holds for each insertion path that callers
   * use. `getOrInsert` and `getOrInsertComputed` are the very new
   * "Map upsert" additions to the standard library. They do not call
   * `set()` internally, so an override of `set` alone does not include
   * them.
   */

  override set(key: T, value: U) {
    /*
     * A plain Map.set on a key that exists keeps the initial position of
     * the key. A delete before the set inserts the key again at the end.
     * Thus the entries with the most recent writes are always the last
     * entries that the map removes.
     */
    this.delete(key);
    super.set(key, value);

    this.#prune();

    return this;
  }

  override getOrInsert(key: T, defaultValue: U): U {
    const result = super.getOrInsert(key, defaultValue);

    this.#prune();

    return result;
  }

  override getOrInsertComputed(key: T, callback: (key: T) => U): U {
    const result = super.getOrInsertComputed(key, callback);

    this.#prune();

    return result;
  }

  #prune() {
    while (this.size > this.#maxSize) {
      /*
       * The first key from the iterator is the oldest entry. The non-null
       * assertion is safe: size > maxSize >= 1 makes sure that at least
       * one entry exists.
       */
      const oldest = this.keys().next().value;
      this.delete(oldest!);
    }
  }
}
