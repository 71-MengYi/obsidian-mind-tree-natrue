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
