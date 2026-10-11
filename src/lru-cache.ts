/**
 * Insertion-ordered eviction shared by every bounded `Map` cache. This module
 * deliberately imports nothing so pure domain/format code (node titles) can use
 * it alongside UI modules without creating a dependency edge.
 */

/**
 * Drop the oldest inserted entry when `cache` is already at `limit`, so the
 * caller can then insert one new entry and keep the size bounded.
 *
 * `Map` iterates in insertion order, so the first key is the oldest. Every
 * former call site checked the size *before* its own `set`, which is why the
 * comparison is `>=` and why this helper must be invoked before inserting.
 *
 * @returns `true` when an entry was removed.
 */
export function evictOldest<K, V>(cache: Map<K, V>, limit: number): boolean {
  if (cache.size < limit) return false;
  const oldest = cache.keys().next().value as K | undefined;
  if (oldest === undefined) return false;
  return cache.delete(oldest);
}
