export const CHAIN_BROKEN_ICON = "mtn-fa-chain-broken";

// Font Awesome's broken-chain metaphor is not part of Obsidian's built-in
// Lucide icon set. Register a matching custom icon so menu rendering remains
// consistent across Obsidian versions and does not depend on an external font.
// Obsidian renders registered custom icons in a 100 × 100 viewBox; keep the
// geometry in that coordinate system or the icon looks tiny next to 24 × 24 ones.
export const CHAIN_BROKEN_ICON_SVG = [
  '<path d="M42 58 32 68a15 15 0 0 1-21-21l14-14a15 15 0 0 1 21 0l4 4" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="m58 42 10-10a15 15 0 0 1 21 21L75 67a15 15 0 0 1-21 0l-4-4" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M34 50H19M50 34V19M66 50h15M50 66v15" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>',
].join("");
