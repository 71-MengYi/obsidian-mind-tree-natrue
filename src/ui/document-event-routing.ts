export interface PasteTargetState {
  /** The owning Mind Tree leaf is Obsidian's currently active/recent leaf. */
  viewActive: boolean;
  /** The event target is inside this view rather than stale DOM from a prior tab. */
  targetInView: boolean;
  /** The event target belongs to an input, textarea, or contenteditable region. */
  targetEditable: boolean;
  /** An editable target outside this view is currently rendered to the user. */
  targetVisible: boolean;
  /** A visible modal/menu/custom editor owns the gesture even without an input target. */
  nativePasteSurfaceVisible?: boolean;
}

/**
 * Only the active tree may capture paste. Native paste always wins in the
 * tree's title editor and in visible modal/settings inputs. A hidden editor
 * left focused by a previous tab must not swallow the active tree's paste.
 */
export function shouldHandleMindTreePaste(state: Readonly<PasteTargetState>): boolean {
  if (!state.viewActive) return false;
  if (state.nativePasteSurfaceVisible) return false;
  if (!state.targetEditable) return true;
  return !state.targetInView && !state.targetVisible;
}

export interface StaleKeyTargetState {
  /** The mind-tree view itself is painted, so the user is looking at it. */
  viewVisible: boolean;
  /** The key was delivered to a text surface outside this view. */
  targetOutsideEditable: boolean;
  /** That text surface is painted, so the user really is typing in it. */
  targetVisible: boolean;
  /** A visible modal, menu, or custom editor owns the gesture. */
  nativeSurfaceVisible?: boolean;
}

/**
 * Only a rendered tree may recover a structural key from an invisible editor.
 * Obsidian can leave the DOM focus in the editor of a tab that is no longer
 * painted; without this the next Tab indents that unseen note instead of
 * reaching the canvas. Visible inputs always keep their native behaviour.
 */
export function shouldHandleMindTreeStaleKey(state: Readonly<StaleKeyTargetState>): boolean {
  if (!state.viewVisible) return false;
  if (state.nativeSurfaceVisible) return false;
  return state.targetOutsideEditable && !state.targetVisible;
}
