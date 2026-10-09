import type { MindTreeTheme } from "../../types";

/**
 * Structural subset of a rendered menu row. The DOM order mapping is pure logic
 * and is unit tested with plain objects, so it must not depend on HTMLElement.
 */
export interface MenuRowLike {
  readonly matches: (selector: string) => boolean;
  readonly classList: { contains: (token: string) => boolean };
}

/** Hover callbacks for the live theme preview. */
export interface ThemeMenuHoverHandlers {
  readonly onEnter: (theme: MindTreeTheme, row: HTMLElement) => void;
  readonly onLeave: () => void;
}

/** Obsidian renders title-only rows with the `is-label` class; they hold no choice. */
export function isMenuLabelRow(row: MenuRowLike): boolean {
  return row.classList.contains("is-label") || row.matches(".is-label");
}

/**
 * Pair rows with themes in DOM order, skipping label rows. When the two lists
 * differ in length only the matched prefix is returned, so callers can detect a
 * mismatch and degrade silently instead of highlighting the wrong row.
 */
export function matchThemeRows<TRow extends MenuRowLike, TTheme>(
  rows: readonly TRow[],
  themes: readonly TTheme[],
  skipLabel: (row: TRow) => boolean = isMenuLabelRow
): Array<{ readonly theme: TTheme; readonly row: TRow }> {
  const matched: Array<{ theme: TTheme; row: TRow }> = [];
  let index = 0;
  for (const row of rows) {
    if (index >= themes.length) break;
    if (skipLabel(row)) continue;
    const theme = themes[index];
    if (theme === undefined) break;
    matched.push({ theme, row });
    index += 1;
  }
  return matched;
}

/**
 * True only when the rendered rows mirror the theme list exactly. Any extra or
 * missing row means the DOM is not the expected list, so nothing may ever be
 * mapped to a theme; this is re-checked per event because rows can be rebuilt.
 */
export function isCompleteThemeRowMapping(rows: readonly MenuRowLike[], themes: readonly MindTreeTheme[]): boolean {
  if (themes.length === 0) return false;
  return rows.filter((row) => !isMenuLabelRow(row)).length === themes.length;
}

/**
 * Observe hover on the menu container instead of on individual rows. Obsidian
 * attaches rows through `Menu.sort()` and defers `Menu.load()` to a timer, so a
 * one-shot per-row binding can attach to nothing or outlive a rebuild; the
 * container itself lasts for the whole menu lifetime and the rows are re-read on
 * every pointer event, which also keeps a wrong row count from mapping at all.
 */
export function bindThemeMenuHover(
  menu: HTMLElement,
  themes: readonly MindTreeTheme[],
  handlers: ThemeMenuHoverHandlers
): void {
  // A hover preview is meaningless where the platform cannot report hover.
  if (!supportsHover(menu)) return;
  // The row the pointer is currently on, to collapse repeated pointerover events.
  let current: HTMLElement | undefined;
  menu.addEventListener("pointerover", (event) => {
    // Touch input also emits pointer events; a tap is not a hover preview.
    if (event.pointerType === "touch") return;
    const entry = resolveThemeEntry(menu, themes, event.target);
    // Child nodes of the same row also emit pointerover; enter only on a new row.
    if (!entry || entry.row === current) return;
    current = entry.row;
    handlers.onEnter(entry.theme, entry.row);
  });
  menu.addEventListener("pointerout", (event) => {
    if (event.pointerType === "touch") return;
    if (!resolveThemeEntry(menu, themes, event.target)) return;
    // Moving to another theme row (or to a child of the same row) keeps the
    // preview: the following pointerover swaps the theme in place, so the menu
    // never needs a hide/show cycle that would blink.
    if (resolveThemeEntry(menu, themes, event.relatedTarget)) return;
    current = undefined;
    handlers.onLeave();
  });
  // Scroll events do not bubble, so a capture listener is required; once the list
  // scrolls, the preview anchor no longer matches the row under the pointer.
  menu.addEventListener("scroll", () => {
    current = undefined;
    handlers.onLeave();
  }, { capture: true });
}

/** Collect the rows rendered inside a menu element right now, in DOM order. */
export function queryMenuRows(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(".menu-item"));
}

/**
 * Obsidian's Menu does not expose its DOM, so the submenu element is located by
 * diffing `.menu` elements around the show call. Returns undefined when nothing
 * new appeared (for example a native desktop menu), which the caller treats as
 * "no hover support" and skips silently.
 */
export function captureShownMenuElement(ownerDocument: Document, show: () => void): HTMLElement | undefined {
  const before = new Set<Element>(ownerDocument.querySelectorAll(".menu"));
  show();
  const menus = ownerDocument.querySelectorAll<HTMLElement>(".menu");
  // The newest menu is appended last; scanning backwards also tolerates an
  // implementation that inserts the new menu before older siblings.
  for (let index = menus.length - 1; index >= 0; index -= 1) {
    const candidate = menus[index];
    if (candidate && !before.has(candidate)) return candidate;
  }
  return undefined;
}

/** Map the row under a pointer event to its theme, using the rows rendered now. */
function resolveThemeEntry(
  menu: HTMLElement,
  themes: readonly MindTreeTheme[],
  target: EventTarget | null
): { readonly theme: MindTreeTheme; readonly row: HTMLElement } | undefined {
  const node = closestMenuRow(target);
  if (!node) return undefined;
  // Rows may have been rebuilt since binding (sort detaches and re-attaches
  // them), so the live list decides the mapping instead of a bind-time snapshot.
  const rows = queryMenuRows(menu);
  if (!isCompleteThemeRowMapping(rows, themes)) return undefined;
  return matchThemeRows(rows, themes).find((entry) => entry.row === node);
}

/** Structural view of a node that can walk up to its owning menu row. */
interface RowClimber {
  closest(selector: string): EventTarget | null;
}

function isRowClimber(value: EventTarget | null): value is EventTarget & RowClimber {
  return value !== null && typeof value === "object" && "closest" in value && typeof value.closest === "function";
}

/** Realm-independent row lookup: pop-out windows and test doubles are not `instanceof Element`. */
function closestMenuRow(target: EventTarget | null): Node | undefined {
  if (!isRowClimber(target)) return undefined;
  const row = target.closest(".menu-item");
  return isNodeLike(row) ? row : undefined;
}

/** `(any-hover: hover)` is false on touch-only devices; a missing matchMedia means yes. */
function supportsHover(menu: HTMLElement): boolean {
  const view = menu.ownerDocument?.defaultView;
  if (!view || typeof view.matchMedia !== "function") return true;
  const query = view.matchMedia("(any-hover: hover)");
  return query?.matches !== false;
}

/** Cross-realm safe Node check: pop-out windows own a different Node constructor. */
function isNodeLike(target: EventTarget | null): target is Node {
  return target !== null && typeof target === "object" && "nodeType" in target && typeof target.nodeType === "number";
}
