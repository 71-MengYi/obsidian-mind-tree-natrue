import { DisposerBag } from "../components/ui-object";
import { wheelDeltaToPixels } from "../viewport";

/** The modal owns the DOM; this controller owns only its interaction state. */
export interface DeleteDetailTarget {
  readonly trigger: HTMLElement;
  readonly detail: HTMLElement;
}

interface DetailState extends DeleteDetailTarget {
  hovered: boolean;
  scrollTop: number;
}

/**
 * A deletion preview is deliberately not an interactive popover. Only its
 * summary card can keep it open; the body-mounted list never receives pointer
 * listeners or focus. One controller coordinates both cards in a single modal.
 */
export class DeleteDetailsController {
  private readonly cleanup = new DisposerBag();
  private active?: DetailState;

  constructor(
    targets: readonly DeleteDetailTarget[],
    private readonly position: (trigger: HTMLElement, detail: HTMLElement) => void
  ) {
    for (const target of targets) {
      const state: DetailState = { ...target, hovered: false, scrollTop: 0 };
      this.listen(state.trigger, "mouseenter", () => {
        state.hovered = true;
        this.show(state);
      });
      this.listen(state.trigger, "mouseleave", () => {
        state.hovered = false;
        // A click may have left focus on this card. Mouse departure still wins:
        // neither that focus nor entering the preview may extend its lifetime.
        this.hide(state);
      });
      this.listen(state.trigger, "focus", () => this.show(state));
      this.listen(state.trigger, "blur", () => this.hide(state));
      this.listen(state.trigger, "wheel", (event) => this.scroll(state, event as WheelEvent), { passive: false });
    }
  }

  destroy(): void {
    if (this.cleanup.isDisposed) return;
    if (this.active) this.hide(this.active);
    this.cleanup.dispose();
  }

  private show(state: DetailState): void {
    if (this.cleanup.isDisposed || this.active === state) return;
    if (this.active) this.hide(this.active);
    this.active = state;
    state.detail.classList.add("is-visible");
    this.position(state.trigger, state.detail);
    // Some browsers expose scrollTop=0 while display:none. Restore only after
    // showing/measuring, so each card retains its independent position.
    state.detail.scrollTop = state.scrollTop;
  }

  private hide(state: DetailState): void {
    if (this.active !== state) return;
    state.scrollTop = state.detail.scrollTop;
    state.detail.classList.remove("is-visible");
    this.active = undefined;
  }

  private scroll(state: DetailState, event: WheelEvent): void {
    if (this.cleanup.isDisposed || this.active !== state || !state.hovered) return;
    const maximum = state.detail.scrollHeight - state.detail.clientHeight;
    const delta = wheelDeltaToPixels(event.deltaY, event.deltaMode, state.detail.clientHeight);
    if (maximum <= 0 || delta === 0 || !Number.isFinite(delta)) return;
    // Consume even at either boundary: a long list must not start scrolling the
    // modal/host after reaching its first or last item. Short lists stay native.
    event.preventDefault();
    event.stopPropagation();
    state.detail.scrollTop = Math.max(0, Math.min(maximum, state.detail.scrollTop + delta));
    state.scrollTop = state.detail.scrollTop;
  }

  private listen(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(type, listener, options);
    this.cleanup.add(() => target.removeEventListener(type, listener, options));
  }
}
