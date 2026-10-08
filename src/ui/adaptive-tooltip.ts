import { setTooltip } from "obsidian";
import { DisposerBag } from "./components/ui-object";
import { chooseTooltipPlacement, fitTooltip, TOOLTIP_MAX_WIDTH, TOOLTIP_MARGIN, type TooltipRect } from "./tooltip-placement";

const BUTTONS = "button[aria-label], [role=button][aria-label]";
const owners = new WeakMap<HTMLElement, AdaptiveTooltipController>();
const activeWindows = new WeakMap<Document, AdaptiveTooltipController>();
const NATIVE_HIDDEN = "mtn-native-tooltip-hidden";

/** One delegated binding per plugin surface; no host controls or global styles are changed. */
export class AdaptiveTooltipController {
  private readonly cleanup = new DisposerBag();
  private readonly adopted = new Set<HTMLElement>();
  private readonly doc: Document;
  private readonly win: Window & typeof globalThis;
  private active?: HTMLElement;
  private tooltip?: HTMLElement;
  private text?: HTMLElement;
  private timer?: number;
  private frame?: number;
  private resize?: ResizeObserver;
  private geometry = "";
  private pointerFocus = false;

  constructor(private readonly root: HTMLElement, private readonly standalone = false) {
    this.doc = root.ownerDocument;
    this.win = this.doc.defaultView!;
    this.adoptTree(root);
    const observer = new this.win.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") this.adopt(record.target as HTMLElement);
        for (const node of record.addedNodes) if (node.nodeType === 1) this.adoptTree(node as HTMLElement);
        for (const node of record.removedNodes) if (node.nodeType === 1) this.releaseTree(node as HTMLElement);
      }
      if (this.active && !this.usable(this.active)) this.hide();
      this.geometry = "";
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
    this.cleanup.add(() => observer.disconnect());
    this.listen(root, "pointerover", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType !== "mouse" || pointer.buttons) return;
      const button = this.target(event.target);
      if (button) this.begin(button, false);
    }, true);
    this.listen(root, "pointerout", (event) => {
      if (this.active && !this.active.contains((event as PointerEvent).relatedTarget as Node | null)) this.hide();
    }, true);
    this.listen(root, "focusin", (event) => {
      const button = this.target(event.target);
      if (button && !this.pointerFocus && button.matches(":focus-visible")) this.begin(button, true);
    }, true);
    this.listen(root, "focusout", () => this.hide(), true);
    this.listen(this.doc, "pointerdown", () => { this.pointerFocus = true; this.hide(); }, true);
    this.listen(this.doc, "click", () => this.hide(), true);
    this.listen(this.doc, "keydown", (event) => {
      this.pointerFocus = false;
      if ((event as KeyboardEvent).key === "Escape") this.hide();
    }, true);
    this.listen(this.doc, "visibilitychange", () => { if (this.doc.hidden) this.hide(); });
    this.listen(this.win, "blur", () => this.hide());
  }

  destroy(): void {
    this.hide();
    this.cleanup.dispose();
    for (const button of this.adopted) this.release(button);
  }

  private adopt(button: HTMLElement): void {
    if (owners.get(button) === this && !button.getAttribute("aria-label")) { this.release(button); return; }
    if (!button.matches(BUTTONS) && !(this.standalone && button === this.root && button.hasAttribute("aria-label"))) return;
    const owner = owners.get(button);
    if (owner === this) return;
    if (owner?.root.contains(button)) return;
    owner?.release(button);
    const label = button.getAttribute("aria-label");
    if (!label) return;
    // The native copy stays hidden even before the first pointer event.
    setTooltip(button, label, { classes: [NATIVE_HIDDEN] });
    owners.set(button, this);
    this.adopted.add(button);
  }
  private adoptTree(element: HTMLElement): void {
    this.adopt(element);
    for (const button of element.querySelectorAll<HTMLElement>(BUTTONS)) this.adopt(button);
  }
  private release(button: HTMLElement): void {
    if (owners.get(button) !== this) return;
    if (this.active === button) this.hide();
    owners.delete(button); this.adopted.delete(button);
    const label = button.getAttribute("aria-label");
    if (label !== null) setTooltip(button, label, { classes: [] });
  }
  private releaseTree(element: HTMLElement): void {
    // Moving a button within the same surface does not invalidate ownership.
    if (this.root.contains(element)) return;
    this.release(element);
    for (const button of element.querySelectorAll<HTMLElement>(BUTTONS)) this.release(button);
  }
  private target(target: EventTarget | null): HTMLElement | undefined {
    if (!target || !("nodeType" in target) || target.nodeType !== 1) return;
    const element = target as HTMLElement;
    const button = element.closest<HTMLElement>(BUTTONS) ?? (this.standalone && this.root.contains(element) ? this.root : undefined);
    if (!button || !this.root.contains(button)) return;
    this.adopt(button);
    return owners.get(button) === this ? button : undefined;
  }
  private usable(button: HTMLElement): boolean {
    return button.isConnected && this.root.contains(button) && button.ownerDocument === this.doc
      && !!button.getAttribute("aria-label") && button.getClientRects().length > 0;
  }
  private begin(button: HTMLElement, immediate: boolean): void {
    if (this.cleanup.isDisposed || !this.usable(button)) return;
    if (this.active === button && (!immediate || this.tooltip)) return;
    activeWindows.get(this.doc)?.hide();
    this.active = button;
    activeWindows.set(this.doc, this);
    if (immediate) this.show();
    else this.timer = this.win.setTimeout(() => { this.timer = undefined; this.show(); }, 300);
    this.track();
  }
  private show(): void {
    if (!this.active || !this.usable(this.active)) { this.hide(); return; }
    this.tooltip = this.doc.createElement("div");
    this.tooltip.className = "mtn-adaptive-tooltip";
    this.tooltip.setAttribute("role", "tooltip");
    // aria-label already provides the full accessible name; avoid announcing it twice.
    this.tooltip.setAttribute("aria-hidden", "true");
    this.tooltip.style.visibility = "hidden";
    this.text = this.doc.createElement("div");
    this.text.className = "mtn-adaptive-tooltip-text";
    this.tooltip.append(this.text);
    this.doc.body.append(this.tooltip);
    this.geometry = "";
    this.resize = new this.win.ResizeObserver(() => { this.geometry = ""; });
    this.resize.observe(this.active); this.resize.observe(this.tooltip);
    this.update();
  }
  private viewport(): TooltipRect {
    const viewport = this.win.visualViewport;
    return viewport ? { left: viewport.offsetLeft, top: viewport.offsetTop,
      right: viewport.offsetLeft + viewport.width, bottom: viewport.offsetTop + viewport.height }
      : { left: 0, top: 0, right: this.win.innerWidth, bottom: this.win.innerHeight };
  }
  private track(): void {
    if (!this.active || this.frame !== undefined) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = undefined;
      if (!this.active || !this.usable(this.active)) { this.hide(); return; }
      // Includes transforms/animations and ancestor scrolling, which do not resize a button.
      if (this.tooltip) this.update();
      this.track();
    });
  }
  private update(): void {
    const button = this.active!, tooltip = this.tooltip!, text = this.text!;
    const anchor = button.getBoundingClientRect(), viewport = this.viewport();
    if (anchor.right <= viewport.left || anchor.left >= viewport.right || anchor.bottom <= viewport.top || anchor.top >= viewport.bottom) {
      this.hide(); return;
    }
    const label = button.getAttribute("aria-label") ?? "";
    const geometry = [anchor.left, anchor.top, anchor.right, anchor.bottom,
      viewport.left, viewport.top, viewport.right, viewport.bottom, label].join("|");
    if (geometry === this.geometry) return;
    this.geometry = geometry;
    if (text.textContent !== label) text.textContent = label;
    tooltip.style.maxWidth = Math.max(0, Math.min(TOOLTIP_MAX_WIDTH, viewport.right - viewport.left - 2 * TOOLTIP_MARGIN)) + "px";
    text.style.maxHeight = "none";
    const style = this.win.getComputedStyle(text);
    const fontSize = parseFloat(style.fontSize) || 12;
    const lineHeight = parseFloat(style.lineHeight) || 1.4 * fontSize;
    const minimum = {
      height: lineHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      width: fontSize + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    };
    const choice = chooseTooltipPlacement(anchor, tooltip.getBoundingClientRect(), viewport, minimum);
    tooltip.style.maxWidth = choice.maxWidth + "px";
    // Remeasure wrapped text in the chosen region, then fit without flipping back.
    const size = tooltip.getBoundingClientRect();
    const layout = fitTooltip(anchor, size, viewport, choice.side);
    if (layout.maxHeight < minimum.height || layout.maxWidth < minimum.width) {
      tooltip.style.visibility = "hidden"; return;
    }
    text.style.maxHeight = layout.maxHeight + "px";
    tooltip.style.left = layout.left + "px"; tooltip.style.top = layout.top + "px";
    tooltip.dataset.side = layout.side;
    const vertical = layout.side === "top" || layout.side === "bottom";
    const offset = vertical ? (anchor.left + anchor.right) / 2 - layout.left : (anchor.top + anchor.bottom) / 2 - layout.top;
    const extent = vertical ? layout.width : layout.height;
    tooltip.style.setProperty("--mtn-tooltip-arrow", Math.max(4, Math.min(offset, extent - 4)) + "px");
    tooltip.style.visibility = "visible";
  }
  private hide(): void {
    if (this.timer !== undefined) this.win.clearTimeout(this.timer);
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.timer = this.frame = undefined;
    this.resize?.disconnect(); this.resize = undefined;
    this.tooltip?.remove(); this.tooltip = this.text = undefined;
    this.active = undefined; this.geometry = "";
    if (activeWindows.get(this.doc) === this) activeWindows.delete(this.doc);
  }
  private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture);
    this.cleanup.add(() => target.removeEventListener(type, listener, capture));
  }
}
