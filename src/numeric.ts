/**
 * Numeric helpers shared across layers. This module deliberately imports
 * nothing so both DOM code and pure domain/format code can depend on it
 * without pulling Obsidian or the UI layer along.
 */

/**
 * Clamp `value` into `[minimum, maximum]`.
 *
 * The evaluation order is load-bearing and preserved from the former local
 * copies: the lower bound is applied last, so when `minimum > maximum` the
 * lower bound wins instead of the upper one.
 */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
