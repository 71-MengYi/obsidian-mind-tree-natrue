import { DisposerBag } from "../components/ui-object";

export interface VisibleRect { left: number; top: number; right: number; bottom: number }

/** Smallest translation that keeps the field (or an oversized field's caret) visible. */
export function keyboardAvoidanceDelta(
  field: VisibleRect, caret: VisibleRect, visible: VisibleRect, margin = 12
): { x: number; y: number } {
  const left = visible.left + margin;
  const right = visible.right - margin;
  const top = visible.top + margin;
  const bottom = visible.bottom - margin;
  if (right <= left || bottom <= top) return { x: 0, y: 0 };
  const horizontal = field.right - field.left <= right - left ? field : caret;
  const vertical = field.bottom - field.top <= bottom - top ? field : caret;
  return {
    x: horizontal.left < left ? left - horizontal.left : horizontal.right > right ? right - horizontal.right : 0,
    y: vertical.top < top ? top - vertical.top : vertical.bottom > bottom ? bottom - vertical.bottom : 0
  };
}

/** Automatic offsets are separate from user navigation and never persisted. */
export class KeyboardAvoidanceOffset {
  x = 0;
  y = 0;
  add(x: number, y: number): void { this.x += x; this.y += y; }
  userNavigated(): void { this.x = 0; this.y = 0; }
  takeRestoration(): { x: number; y: number } {
    const delta = { x: -this.x, y: -this.y };
    this.userNavigated();
    return delta;
  }
}

/**
 * Observes real visual-viewport geometry, never guesses a keyboard height.
 * It moves only this canvas and preserves the document, selection and zoom.
 */
export class KeyboardAvoidanceController {
  private readonly disposers = new DisposerBag();
  private editorDisposers?: DisposerBag;
  private readonly offset = new KeyboardAvoidanceOffset();
  private readonly ownerWindow: Window;
  private editor?: HTMLTextAreaElement;
  private baselineHeight = 0;
  private layoutWidth = 0;
  private frame?: number;
  private destroyed = false;

  constructor(private readonly canvas: HTMLElement, private readonly panBy: (x: number, y: number) => void) {
    this.ownerWindow = canvas.ownerDocument.defaultView!;
    const viewport = this.ownerWindow.visualViewport;
    if (viewport) {
      for (const name of ["resize", "scroll"]) {
        const listener = (): void => this.schedule();
        viewport.addEventListener(name, listener);
        this.disposers.add(() => viewport.removeEventListener(name, listener));
      }
    }
    const onResize = (): void => this.schedule();
    this.ownerWindow.addEventListener("resize", onResize);
    this.disposers.add(() => this.ownerWindow.removeEventListener("resize", onResize));
  }

  watch(editor: HTMLTextAreaElement): void {
    if (!this.ownerWindow.visualViewport || !this.ownerWindow.navigator.maxTouchPoints) return;
    if (!this.editor && this.offset.x === 0 && this.offset.y === 0) {
      this.baselineHeight = this.ownerWindow.visualViewport.height;
      this.layoutWidth = this.ownerWindow.innerWidth;
    }
    this.editorDisposers?.dispose();
    this.editorDisposers = new DisposerBag();
    this.editor = editor;
    for (const name of ["input", "focus", "select", "click", "keyup", "scroll"]) {
      const listener = (): void => this.schedule();
      editor.addEventListener(name, listener);
      this.editorDisposers.add(() => editor.removeEventListener(name, listener));
    }
    const onSelection = (): void => { if (editor.ownerDocument.activeElement === editor) this.schedule(); };
    editor.ownerDocument.addEventListener("selectionchange", onSelection);
    this.editorDisposers.add(() => editor.ownerDocument.removeEventListener("selectionchange", onSelection));
    this.schedule();
  }

  end(): void {
    this.editorDisposers?.dispose();
    this.editorDisposers = undefined;
    this.editor = undefined;
    this.schedule();
  }

  /** Manual navigation absorbs the current position; never undo that decision. */
  userNavigated(): void { this.offset.userNavigated(); }

  reset(): void {
    this.end();
    this.offset.userNavigated();
    if (this.frame !== undefined) this.ownerWindow.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.baselineHeight = 0;
    this.layoutWidth = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reset();
    this.disposers.dispose();
  }

  private schedule(): void {
    if (this.destroyed || this.frame !== undefined) return;
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = undefined;
      this.update();
    });
  }

  private update(): void {
    const viewport = this.ownerWindow.visualViewport;
    if (!viewport || this.destroyed) return;
    // Rotation / iPad split-view changes the layout itself. Do not interpret
    // the previous portrait height as a keyboard that can never be dismissed.
    if (this.layoutWidth && this.layoutWidth !== this.ownerWindow.innerWidth) {
      this.baselineHeight = Math.max(viewport.height, this.ownerWindow.innerHeight);
      this.layoutWidth = this.ownerWindow.innerWidth;
    }
    const editor = this.editor;
    const narrowed = viewport.height + 1 < this.baselineHeight
      || viewport.offsetTop + viewport.height + 1 < this.ownerWindow.innerHeight;
    if (!editor || !editor.isConnected) {
      // Wait for the keyboard animation to finish instead of jumping the node
      // underneath a still-visible keyboard as soon as blur fires.
      if (!narrowed) {
        const delta = this.offset.takeRestoration();
        if (delta.x || delta.y) this.panBy(delta.x, delta.y);
      }
      return;
    }
    if (editor.ownerDocument.activeElement !== editor) return;
    if (!narrowed) {
      const delta = this.offset.takeRestoration();
      if (delta.x || delta.y) this.panBy(delta.x, delta.y);
      return;
    }
    const canvas = this.canvas.getBoundingClientRect();
    const visible = {
      left: Math.max(canvas.left, viewport.offsetLeft),
      top: Math.max(canvas.top, viewport.offsetTop),
      right: Math.min(canvas.right, viewport.offsetLeft + viewport.width),
      bottom: Math.min(canvas.bottom, viewport.offsetTop + viewport.height)
    };
    const rect = editor.getBoundingClientRect();
    const oversized = rect.width > visible.right - visible.left - 24 || rect.height > visible.bottom - visible.top - 24;
    const delta = keyboardAvoidanceDelta(rect, oversized ? textareaCaretRect(editor) : rect, visible);
    if (delta.x || delta.y) {
      this.offset.add(delta.x, delta.y);
      this.panBy(delta.x, delta.y);
    }
  }
}

/**
 * A hidden text-only mirror gives the caret's actual wrapped line, including
 * spaces/IME text, without changing the textarea selection or its value.
 * Its unzoomed local coordinates are mapped back to the rendered canvas.
 */
function textareaCaretRect(editor: HTMLTextAreaElement): VisibleRect {
  const doc = editor.ownerDocument;
  const window = doc.defaultView!;
  const style = window.getComputedStyle(editor);
  const rect = editor.getBoundingClientRect();
  const scale = rect.width / Math.max(1, editor.offsetWidth);
  const mirror = doc.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "fixed", left: "0", top: "0", visibility: "hidden", pointerEvents: "none",
    whiteSpace: "break-spaces", overflowWrap: "anywhere", width: `${editor.offsetWidth}px`
  });
  for (const name of ["font-family", "font-size", "font-weight", "font-style", "font-stretch",
    "font-variant", "font-kerning", "letter-spacing", "word-spacing", "line-height", "padding",
    "border", "box-sizing", "text-align", "tab-size"]) mirror.style.setProperty(name, style.getPropertyValue(name));
  mirror.append(doc.createTextNode(editor.value.slice(0, editor.selectionStart)));
  const caret = doc.createElement("span");
  // Keeping the suffix preserves native word-wrapping around a mid-word caret.
  caret.textContent = editor.value.slice(editor.selectionStart) || "\u200b";
  mirror.append(caret);
  doc.body.append(mirror);
  try {
    const caretRect = caret.getClientRects()[0] ?? caret.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const left = rect.left + (caretRect.left - mirrorRect.left - editor.scrollLeft) * scale;
    const top = rect.top + (caretRect.top - mirrorRect.top - editor.scrollTop) * scale;
    return { left, right: left + Math.max(1, scale), top,
      bottom: top + (Number.parseFloat(style.lineHeight) || caretRect.height || 20) * scale };
  } finally { mirror.remove(); }
}
