import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import type { MindTreeDocument } from "../../types";
import type { TreeSnapshot, TreeSnapshotEntry } from "../../services/snapshot-store";
import { ReadOnlyTreePreview, type TreePreviewOptions } from "../components/read-only-tree-preview";

export interface VersionHistoryPorts {
  /** Metadata rows, newest first. Must not throw for a damaged entry. */
  readonly list: () => Promise<readonly TreeSnapshotEntry[]>;
  /** Full source for one row; `undefined` when the file is damaged. */
  readonly load: (entry: TreeSnapshotEntry) => Promise<TreeSnapshot | undefined>;
  /** Parse a snapshot for the read-only preview; `undefined` when unreadable. */
  readonly parse: (source: string) => MindTreeDocument | undefined;
  /**
   * Apply the selected snapshot to the live session. Returning true closes the
   * modal; the port owns validation, the undo step and the Notice.
   */
  readonly restore: (snapshot: TreeSnapshot) => boolean;
  /** Rendering rules shared with the live canvas (badges, images, wrapping). */
  readonly preview: TreePreviewOptions;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return t("snapshot.sizeBytes", { count: bytes });
  if (bytes < 1024 * 1024) return t("snapshot.sizeKb", { count: Math.max(1, Math.round(bytes / 1024)) });
  return t("snapshot.sizeMb", { count: (bytes / (1024 * 1024)).toFixed(1) });
}

/**
 * Browse locally captured tree versions. The left side is metadata only; the
 * right side is the same `ReadOnlyTreePreview` used by version comparison, so a
 * preview can never open resources, edit nodes or write a file.
 */
export class VersionHistoryModal extends Modal {
  private readonly entryButtons = new Map<string, HTMLButtonElement>();
  private listEl!: HTMLElement;
  private previewHost!: HTMLElement;
  private statusEl!: HTMLElement;
  private restoreButton!: HTMLButtonElement;
  private preview?: ReadOnlyTreePreview;
  private selectedFile?: string;
  private selectedSnapshot?: TreeSnapshot;
  private loadToken = 0;
  private opened = false;
  private restoring = false;

  constructor(app: App, private readonly ports: VersionHistoryPorts) {
    super(app);
  }

  onOpen(): void {
    this.opened = true;
    this.titleEl.setText(t("snapshot.title"));
    this.modalEl.addClass("mtn-snapshot-modal");
    const layout = this.contentEl.createDiv("mtn-snapshot-layout");
    this.listEl = layout.createDiv("mtn-snapshot-list");
    const previewPane = layout.createDiv("mtn-snapshot-preview-pane");
    this.previewHost = previewPane.createDiv("mtn-snapshot-preview");
    this.statusEl = previewPane.createDiv({ cls: "mtn-snapshot-status", attr: { role: "status", "aria-live": "polite" } });
    this.statusEl.setText(t("snapshot.select"));
    const actions = this.contentEl.createDiv("mtn-snapshot-actions");
    actions.createEl("button", { text: t("modal.cancel"), attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    this.restoreButton = actions.createEl("button", {
      cls: "mod-cta", text: t("snapshot.restore"), attr: { type: "button" }
    });
    this.restoreButton.disabled = true;
    this.restoreButton.addEventListener("click", () => this.restoreSelected());
    void this.loadEntries();
  }

  onClose(): void {
    this.opened = false;
    this.loadToken += 1;
    this.clearPreview();
    this.entryButtons.clear();
    this.contentEl.empty();
  }

  private async loadEntries(): Promise<void> {
    let entries: readonly TreeSnapshotEntry[] = [];
    try {
      entries = await this.ports.list();
    } catch {
      if (this.opened) this.statusEl.setText(t("snapshot.listFailed"));
      return;
    }
    if (!this.opened) return;
    this.renderEntries(entries);
  }

  private renderEntries(entries: readonly TreeSnapshotEntry[]): void {
    this.listEl.empty();
    this.entryButtons.clear();
    this.selectedFile = undefined;
    this.selectedSnapshot = undefined;
    this.restoreButton.disabled = true;
    if (!entries.length) {
      this.listEl.createDiv({ cls: "mtn-snapshot-empty", text: t("snapshot.empty") });
      return;
    }
    for (const entry of entries) {
      const button = this.listEl.createEl("button", {
        cls: "mtn-snapshot-entry",
        attr: { type: "button", "aria-pressed": "false" }
      });
      button.createSpan({ cls: "mtn-snapshot-entry-time", text: formatTime(entry.capturedAt) });
      button.createSpan({
        cls: "mtn-snapshot-entry-meta",
        text: t("snapshot.entryMeta", { nodes: entry.nodeCount, size: formatSize(entry.size) })
      });
      button.setAttribute("aria-label", t("snapshot.entryLabel", {
        time: formatTime(entry.capturedAt), nodes: entry.nodeCount, size: formatSize(entry.size)
      }));
      button.addEventListener("click", () => void this.choose(entry));
      this.entryButtons.set(entry.file, button);
    }
  }

  private async choose(entry: TreeSnapshotEntry): Promise<void> {
    if (this.selectedFile === entry.file) return;
    this.selectedFile = entry.file;
    this.selectedSnapshot = undefined;
    this.restoreButton.disabled = true;
    for (const [file, button] of this.entryButtons) {
      const selected = file === entry.file;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    this.statusEl.setText(t("snapshot.loading"));
    const token = ++this.loadToken;
    const snapshot = await this.ports.load(entry);
    if (!this.opened || token !== this.loadToken) return;
    if (!snapshot) {
      this.clearPreview();
      this.statusEl.setText(t("snapshot.invalid"));
      return;
    }
    const document = this.ports.parse(snapshot.source);
    if (!document) {
      this.clearPreview();
      this.statusEl.setText(t("snapshot.invalid"));
      return;
    }
    if (!this.preview) this.preview = new ReadOnlyTreePreview(this.previewHost, t("snapshot.previewLabel"), this.ports.preview);
    this.preview.update(document);
    this.selectedSnapshot = snapshot;
    this.statusEl.setText(t("snapshot.selected", {
      time: formatTime(snapshot.capturedAt), nodes: snapshot.nodeCount, size: formatSize(entry.size)
    }));
    this.restoreButton.disabled = false;
  }

  private restoreSelected(): void {
    const snapshot = this.selectedSnapshot;
    if (!snapshot || this.restoring) return;
    this.restoring = true;
    this.restoreButton.disabled = true;
    // The port performs every validation and owns the user-facing Notice; this
    // modal only closes after the session accepted the replace.
    try {
      if (this.ports.restore(snapshot)) {
        this.close();
        return;
      }
    } catch (error) {
      this.statusEl.setText(t("snapshot.restoreFailed", {
        message: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      this.restoring = false;
      if (this.opened) this.restoreButton.disabled = this.selectedSnapshot === undefined;
    }
  }

  private clearPreview(): void {
    this.preview?.destroy();
    this.preview = undefined;
    this.previewHost?.empty();
  }
}
