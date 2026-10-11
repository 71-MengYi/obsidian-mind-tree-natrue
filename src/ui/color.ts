/**
 * Shared color helpers. They live in the UI layer because every caller writes
 * the returned literal into DOM/SVG output.
 */

/**
 * Pick a text color that stays readable on top of the `#rrggbb` background
 * `hex`. The channel weights are the classic 0.299/0.587/0.114 luminance
 * approximation, and the threshold of 150 keeps light fills on dark text.
 *
 * The live canvas and the SVG/PNG exporter must return the byte-identical
 * literal, so this is the single implementation.
 */
export function readableTextColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#1f2937" : "#ffffff";
}
