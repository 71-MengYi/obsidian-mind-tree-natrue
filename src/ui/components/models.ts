export type SaveIndicatorState = "saved" | "dirty" | "error";

export interface TopToolbarState {
  readonly zoom: number;
}

export interface BottomStatusBarState {
  readonly topicLabel: string;
  readonly noteLabel: string;
  readonly depthLabel: string;
  readonly saveLabel: string;
  readonly saveState: SaveIndicatorState;
  readonly saveBusy: boolean;
  readonly scanBusy: boolean;
  readonly scanEnabled: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface BottomStatusBarModelInput {
  readonly topicCount: number;
  readonly noteCount: number;
  readonly depth: number;
  readonly saveState: SaveIndicatorState;
  readonly saveBusy: boolean;
  readonly scanBusy: boolean;
  readonly scanEnabled: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly text: {
    readonly topics: (count: number) => string;
    readonly notes: (count: number) => string;
    readonly depth: (count: number) => string;
    readonly saved: string;
    readonly unsaved: string;
  };
}

/** Convert domain statistics/session flags into an immutable component model. */
export function createBottomStatusBarState(input: BottomStatusBarModelInput): BottomStatusBarState {
  return {
    topicLabel: input.text.topics(input.topicCount),
    noteLabel: input.text.notes(input.noteCount),
    depthLabel: input.text.depth(input.depth),
    saveLabel: input.saveState === "saved" ? input.text.saved : input.text.unsaved,
    saveState: input.saveState,
    saveBusy: input.saveBusy,
    scanBusy: input.scanBusy,
    scanEnabled: input.scanEnabled,
    canUndo: input.canUndo,
    canRedo: input.canRedo
  };
}

export interface StatusMessageState {
  readonly message: string;
  readonly kind: "normal" | "warning" | "error";
}
