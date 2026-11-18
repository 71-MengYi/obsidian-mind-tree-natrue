import { markSettingsEdited, type TreeSettingKey } from "../../document-settings-state";
import type {
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeDocumentSettings,
  MindTreeLayoutMode,
  MindTreeNodeShape,
  MindTreeTheme
} from "../../types";

/**
 * Everything the tree-settings commands need from the view. Getters return
 * live state so a clear/re-parse observed between commands still invalidates
 * the write exactly like the original inline methods.
 */
export interface SettingsOpsHost {
  getDocument(): MindTreeDocument | undefined;
  /** The view's single user-command mutation path: undo step, render, save. */
  commit(mutator: (draft: MindTreeDocument) => void): void;
  /**
   * Drop the per-open folder-scan cache and rescan the current file on the next
   * tick. The view owns the timer and the scan command.
   */
  rescanCurrentFile(): void;
}

/**
 * Per-tree settings commands, extracted verbatim from the view. The view keeps
 * thin same-name wrappers so menu and command-palette wiring stay in place;
 * every write still runs through the host's `commit`, so undo anchors, render
 * order and save scheduling are unchanged.
 */
export class SettingsOps {
  constructor(private readonly host: SettingsOpsHost) {}

  /** Commands change only the tree displayed by this view. */
  setLayoutMode(layoutMode: MindTreeLayoutMode): void {
    if (!this.host.getDocument()) return;
    this.updateDocumentSettings((settings) => { settings.layoutMode = layoutMode; }, false, "layoutMode");
  }

  /** Theme changes belong to this document and are persisted in YAML. */
  setTheme(theme: MindTreeTheme): void {
    if (!this.host.getDocument()) return;
    this.updateDocumentSettings((settings) => { settings.theme = theme; }, false, "theme");
  }

  /** Connection geometry is stored per tree; the plugin setting only supplies the unset default. */
  setConnectionStyle(connectionStyle: MindTreeConnectionStyle): void {
    if (!this.host.getDocument()) return;
    this.updateDocumentSettings((settings) => { settings.connectionStyle = connectionStyle; }, false, "connectionStyle");
  }

  /** Node shape is tree-specific; the plugin setting only supplies the unset default. */
  setNodeShape(nodeShape: MindTreeNodeShape): void {
    if (!this.host.getDocument()) return;
    this.updateDocumentSettings((settings) => { settings.nodeShape = nodeShape; }, false, "nodeShape");
  }

  /** Commit YAML-backed settings through the same undo/save path as tree edits. */
  updateDocumentSettings(
    mutator: (settings: MindTreeDocumentSettings) => void,
    rescan = false,
    property?: TreeSettingKey
  ): void {
    this.host.commit((draft) => {
      mutator(draft.settings);
      if (property) markSettingsEdited(draft, [property]);
    });
    if (!rescan) return;
    this.host.rescanCurrentFile();
  }
}
