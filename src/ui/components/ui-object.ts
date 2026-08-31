/** A tiny, framework-free lifecycle shared by every imperative UI object. */
export interface UiObject {
  readonly element: HTMLElement;
  destroy(): void;
}

/**
 * Owns arbitrary cleanup callbacks and guarantees reverse-order, idempotent
 * disposal. Keeping this class independent from the DOM makes lifecycle rules
 * directly unit-testable.
 */
export class DisposerBag {
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  get isDisposed(): boolean { return this.disposed; }

  add(disposer: () => void): void {
    if (this.disposed) {
      disposer();
      return;
    }
    this.disposers.push(disposer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let index = this.disposers.length - 1; index >= 0; index -= 1) {
      try {
        this.disposers[index]?.();
      } catch {
        // One faulty third-party cleanup must not leave the remaining listeners.
      }
    }
    this.disposers.length = 0;
  }
}

/** Base class for command-style DOM components used by the mind-tree view. */
export abstract class DisposableUiObject implements UiObject {
  protected readonly cleanup = new DisposerBag();
  abstract readonly element: HTMLElement;

  protected listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): void {
    target.addEventListener(type, listener, options);
    this.cleanup.add(() => target.removeEventListener(type, listener, options));
  }

  protected own(disposer: () => void): void {
    this.cleanup.add(disposer);
  }

  destroy(): void {
    this.cleanup.dispose();
    this.element.remove();
  }
}
