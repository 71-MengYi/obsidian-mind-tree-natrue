import type { NavigationArrow } from "../keyboard-navigation";
import { shouldHandleStructuralCreationKey } from "../keyboard-navigation";

export interface KeyboardActions {
  readonly hasPrimarySelection: () => boolean;
  readonly save: () => void;
  readonly moveSibling: (direction: "up" | "down") => void;
  readonly navigate: (key: NavigationArrow) => void;
  readonly selectAll: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly copy: () => void;
  readonly cut: () => void;
  readonly createNote: () => void;
  readonly addParent: () => void;
  readonly addChild: () => void;
  readonly editAtEnd: () => void;
  readonly addSibling: (position: "before" | "after") => void;
  readonly deleteSelection: () => void;
  readonly cancel: () => void;
}

/** Maps canvas key events to named operations without knowing the document. */
export class KeyboardController {
  constructor(private readonly actions: KeyboardActions) {}

  keyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault(); this.actions.save(); return;
    }
    if (isTextEditingTarget(event.target)) return;
    const hasPrimary = this.actions.hasPrimarySelection();
    if (command && !event.altKey && !event.shiftKey
      && (event.key === "ArrowUp" || event.key === "ArrowDown") && hasPrimary) {
      event.preventDefault(); this.actions.moveSibling(event.key === "ArrowUp" ? "up" : "down"); return;
    }
    if (!command && !event.altKey && !event.shiftKey && isNavigationArrow(event.key) && hasPrimary) {
      event.preventDefault(); this.actions.navigate(event.key); return;
    }
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault(); this.actions.selectAll(); return;
    }
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault(); event.shiftKey ? this.actions.redo() : this.actions.undo(); return;
    }
    if (command && event.key.toLowerCase() === "c") {
      event.preventDefault(); this.actions.copy(); return;
    }
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault(); this.actions.cut(); return;
    }
    if (command && event.key.toLowerCase() === "e" && hasPrimary) {
      event.preventDefault(); this.actions.createNote(); return;
    }
    if (event.key === "Tab" && hasPrimary) {
      event.preventDefault();
      if (!shouldHandleStructuralCreationKey(event.key, event.repeat)) return;
      event.shiftKey ? this.actions.addParent() : this.actions.addChild();
      return;
    }
    if (!command && !event.altKey && event.key === " " && hasPrimary) {
      event.preventDefault(); this.actions.editAtEnd();
    } else if (event.key === "Enter" && hasPrimary) {
      event.preventDefault();
      if (!shouldHandleStructuralCreationKey(event.key, event.repeat)) return;
      this.actions.addSibling(event.shiftKey ? "before" : "after");
    } else if ((event.key === "Delete" || event.key === "Backspace") && hasPrimary) {
      event.preventDefault(); this.actions.deleteSelection();
    } else if (event.key === "Escape") this.actions.cancel();
  }
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return Boolean(element && typeof element.matches === "function"
    && (element.matches("input, textarea, [contenteditable='true']") || element.closest(".modal")));
}

function isNavigationArrow(key: string): key is NavigationArrow {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}
