import { setIcon } from "obsidian";
import {
  addCustomMarkerDefinition,
  cleanCustomMarkerValue,
  createCustomMarkerId,
  customMarkerDefinitionsByKind,
  customMarkerMaxLength,
  MAX_CUSTOM_MARKER_ENTRIES,
  moveCustomMarkerDefinition,
  removeCustomMarkerDefinition,
  validateCustomMarkerValue,
  type CustomMarkerDefinition,
  type CustomMarkerKind,
  type CustomMarkerValidationErrorCode
} from "../../domain/custom-markers";
import { t, type TranslationKey } from "../../i18n";
import type { SettingsPageObject, SettingsPagePort } from "./ports";

/**
 * Localized message for one rejection code. Typed as a total map over the
 * domain codes so a new code cannot silently reach the user as an empty
 * message and no call site has to cast the key.
 */
function validationErrorKey(code: CustomMarkerValidationErrorCode | "ok"): TranslationKey | undefined {
  switch (code) {
    case "empty": return "settings.customMarkers.error.empty";
    case "too-long": return "settings.customMarkers.error.tooLong";
    case "unsafe": return "settings.customMarkers.error.unsafe";
    case "duplicate": return "settings.customMarkers.error.duplicate";
    case "limit": return "settings.customMarkers.error.limit";
    // "ok" has nothing to report; callers only ask after a failure.
    default: return undefined;
  }
}

/** A reorder that changes nothing must not touch `data.json`. */
function sameCustomMarkerOrder(
  left: readonly CustomMarkerDefinition[],
  right: readonly CustomMarkerDefinition[]
): boolean {
  return left.length === right.length
    && left.every((definition, index) => definition.id === right[index]?.id
      && definition.kind === right[index]?.kind
      && definition.value === right[index]?.value);
}

/**
 * "Manage markers" tab: the user-managed half of the marker tool.
 *
 * Built-in progress / priority / highlight markers are product rules and are
 * deliberately not listed here. This page only edits the two custom groups,
 * and every change refreshes open trees so the canvas matches the palette
 * without a document mutation or an undo entry.
 *
 * Every listener this page registers belongs to an element it created inside
 * the settings panel, so dropping the panel releases all of them. There is no
 * document- or window-level listener, which is why `SettingsPageObject.destroy`
 * is intentionally left unimplemented.
 */
export class CustomMarkersSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement, private readonly port: SettingsPagePort) {
    this.element = parent;
    parent.createEl("h3", { text: t("settings.tabs.customMarkers") });
    this.renderGroup(parent, "emoji");
    this.renderGroup(parent, "tag");
  }

  private renderGroup(parent: HTMLElement, kind: CustomMarkerKind): void {
    const headingKey = kind === "emoji" ? "settings.customMarkers.emoji.heading" : "settings.customMarkers.tag.heading";
    const descKey = kind === "emoji" ? "settings.customMarkers.emoji.desc" : "settings.customMarkers.tag.desc";
    const placeholderKey = kind === "emoji"
      ? "settings.customMarkers.emoji.placeholder"
      : "settings.customMarkers.tag.placeholder";
    const emptyKey = kind === "emoji" ? "settings.customMarkers.emoji.empty" : "settings.customMarkers.tag.empty";
    const maxLength = customMarkerMaxLength(kind);

    parent.createEl("h4", { text: t(headingKey) });
    parent.createEl("p", {
      cls: "setting-item-description",
      text: t(descKey, { count: MAX_CUSTOM_MARKER_ENTRIES, length: maxLength })
    });

    const grid = parent.createDiv({
      cls: `mtn-custom-marker-grid is-${kind}`,
      attr: { role: "list", "aria-label": t(headingKey) }
    });
    const empty = parent.createDiv({ cls: "mtn-custom-marker-empty", text: t(emptyKey) });
    const error = parent.createDiv({ cls: "mtn-setting-inline-error", attr: { role: "status", "aria-live": "polite" } });

    const addRow = parent.createDiv({ cls: "mtn-custom-marker-add" });
    const input = addRow.createEl("input", {
      type: "text",
      attr: {
        type: "text",
        maxlength: String(maxLength * 4),
        placeholder: t(placeholderKey),
        "aria-label": t(placeholderKey)
      }
    });
    const addButton = addRow.createEl("button", {
      text: t("settings.customMarkers.add"),
      attr: { type: "button" }
    });

    let dragId: string | undefined;

    const hideError = (): void => {
      error.empty();
      error.removeClass("is-visible");
    };
    const showError = (key: TranslationKey, variables?: Record<string, string | number>): void => {
      error.setText(t(key, variables));
      error.addClass("is-visible");
    };
    const definitions = (): CustomMarkerDefinition[] =>
      customMarkerDefinitionsByKind(this.port.settings.customMarkers, kind);

    /**
     * An open-tree refresh must never cost the user a settings write: `save()`
     * persists every setting, so a canvas that fails to re-render must not skip
     * it. Both failures are reported; a failed refresh is called out separately
     * because the change did reach `data.json` and only the canvas is stale.
     */
    const persist = async (): Promise<void> => {
      try {
        this.port.refreshOpenLayouts();
      } catch {
        showError("settings.customMarkers.error.refresh");
      }
      try {
        await this.port.save();
      } catch {
        showError("settings.customMarkers.error.save");
      }
    };

    const commit = (next: CustomMarkerDefinition[]): void => {
      // A drop on the tile's own slot resolves to the unchanged order. Skipping
      // the write keeps `data.json` untouched, so an accidental drag cannot
      // dirty the settings file or cost an extra save.
      if (sameCustomMarkerOrder(this.port.settings.customMarkers, next)) return;
      this.port.settings.customMarkers = next;
      render();
      void persist();
    };

    /** Drop target index is computed on the list without the dragged entry. */
    const dropIndexFor = (event: DragEvent, draggedId: string): number => {
      const tiles = [...grid.querySelectorAll<HTMLElement>(".mtn-custom-marker-tile")];
      const remaining = tiles.filter((tile) => tile.dataset.markerId !== draggedId);
      for (const [index, tile] of remaining.entries()) {
        const rect = tile.getBoundingClientRect();
        // Reading order over a wrapping grid: a row that starts below the
        // pointer is still "after" it, so the pointer must reach that row's
        // band before its midpoint decides. Without the first test a pointer in
        // an earlier row would jump into a later row and reorder a tile that
        // was dropped onto its own slot.
        if (event.clientY < rect.top) return index;
        // Inside the row: dropping on the right half lands after that tile,
        // which is what "the target and everything after it shifts back" means.
        if (event.clientY <= rect.bottom && event.clientX < rect.left + rect.width / 2) return index;
      }
      return remaining.length;
    };

    const clearDropTargets = (): void => {
      grid.removeClass("is-drop-end");
      for (const tile of grid.querySelectorAll(".mtn-custom-marker-tile")) {
        tile.removeClass("is-drop-target");
      }
    };

    /**
     * Focus the tile that now holds `index`, or the add input when the group is
     * empty. Deleting a tile destroys the focused element, and a browser moves
     * focus to the document body in that case, which would send the next Tab
     * back to the top of the dialog.
     */
    const focusTileAt = (index: number): void => {
      const tiles = [...grid.querySelectorAll<HTMLElement>(".mtn-custom-marker-tile")];
      const tile = tiles[Math.min(Math.max(index, 0), tiles.length - 1)];
      (tile ?? input).focus();
    };

    const render = (): void => {
      grid.empty();
      const items = definitions();
      const isEmpty = items.length === 0;
      grid.toggleClass("is-empty", isEmpty);
      // `hidden` keeps the empty note invisible without needing a stylesheet
      // rule, while `is-visible` stays in sync for a future display rule; the
      // note lives outside the grid so an empty grid can still collapse.
      empty.toggleClass("is-visible", isEmpty);
      empty.hidden = !isEmpty;
      for (const definition of items) {
        const tile = grid.createDiv({
          cls: `mtn-custom-marker-tile is-${kind}`,
          attr: {
            role: "listitem",
            // Tiles are draggable from the moment the pointer presses them, so
            // the keyboard path below is the accessible equivalent of a drag.
            draggable: "true",
            tabindex: "0",
            // The reorder shortcut has no visible counterpart, so name it for
            // assistive technology instead of leaving it undiscoverable.
            "aria-keyshortcuts": "Alt+ArrowLeft Alt+ArrowRight",
            "aria-label": t(kind === "emoji"
              ? "settings.customMarkers.dragEmoji"
              : "settings.customMarkers.dragTag", { value: definition.value })
          }
        });
        tile.dataset.markerId = definition.id;
        if (kind === "emoji") tile.setText(definition.value);
        else tile.createSpan({ cls: "mtn-custom-marker-tile-label", text: definition.value });

        const remove = tile.createEl("button", {
          cls: "clickable-icon mtn-custom-marker-remove",
          attr: {
            type: "button",
            "aria-label": t(kind === "emoji"
              ? "settings.customMarkers.removeEmoji"
              : "settings.customMarkers.removeTag", { value: definition.value })
          }
        });
        setIcon(remove, "x");
        remove.addEventListener("pointerdown", (event) => event.stopPropagation());
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideError();
          const removedIndex = definitions().findIndex((candidate) => candidate.id === definition.id);
          commit(removeCustomMarkerDefinition(this.port.settings.customMarkers, definition.id));
          focusTileAt(removedIndex);
        });

        tile.addEventListener("dragstart", (event) => {
          dragId = definition.id;
          tile.addClass("is-dragging");
          event.dataTransfer?.setData("text/plain", definition.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        tile.addEventListener("dragend", () => {
          dragId = undefined;
          clearDropTargets();
          for (const candidate of grid.querySelectorAll(".mtn-custom-marker-tile")) {
            candidate.removeClass("is-dragging");
          }
        });
        // Alt+Arrow is the keyboard equivalent of dragging a tile. The target
        // index is computed on the list *without* the dragged entry, so moving
        // one slot right means inserting after the entry that follows it.
        tile.addEventListener("keydown", (event) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          const items = definitions();
          const index = items.findIndex((candidate) => candidate.id === definition.id);
          if (index < 0) return;
          const withoutDragged = items.filter((candidate) => candidate.id !== definition.id);
          const target = event.key === "ArrowLeft" ? index - 1 : index + 1;
          // `withoutDragged.length` is a legal target: it appends the entry.
          if (target < 0 || target > withoutDragged.length) return;
          commit(moveCustomMarkerDefinition(this.port.settings.customMarkers, definition.id, target));
          grid.querySelector<HTMLElement>(`[data-marker-id="${CSS.escape(definition.id)}"]`)?.focus();
        });
      }
    };

    grid.addEventListener("dragover", (event) => {
      if (!dragId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      clearDropTargets();
      const tiles = [...grid.querySelectorAll<HTMLElement>(".mtn-custom-marker-tile")];
      const remaining = tiles.filter((tile) => tile.dataset.markerId !== dragId);
      const index = dropIndexFor(event, dragId);
      // Past the last tile there is no item to push back, so the marker moves
      // to the end of the grid instead of highlighting a wrong neighbour.
      if (index >= remaining.length) grid.addClass("is-drop-end");
      else remaining[index]?.addClass("is-drop-target");
    });
    grid.addEventListener("drop", (event) => {
      if (!dragId) return;
      event.preventDefault();
      const id = dragId;
      dragId = undefined;
      clearDropTargets();
      commit(moveCustomMarkerDefinition(this.port.settings.customMarkers, id, dropIndexFor(event, id)));
    });
    // Files dragged from the OS must never reach the vault handler behind the
    // settings modal, so every unfinished drag is cancelled here.
    grid.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && grid.contains(event.relatedTarget as Node)) return;
      clearDropTargets();
    });

    const addValue = (): void => {
      const raw = input.value;
      const kindDefinitions = definitions();
      const validation = validateCustomMarkerValue(
        kind,
        raw,
        kindDefinitions.map((definition) => definition.value)
      );
      if (!validation.ok) {
        const key = validationErrorKey(validation.code);
        if (key === undefined) return;
        // Only `too-long` takes a variable; every other message is rendered
        // without one so no unreplaced `{...}` can reach the user.
        showError(key, validation.code === "too-long" ? { length: maxLength } : undefined);
        return;
      }
      // The cap is per group, so only this group's length can block an add; the
      // other group keeps its own budget of MAX_CUSTOM_MARKER_ENTRIES entries.
      if (kindDefinitions.length >= MAX_CUSTOM_MARKER_ENTRIES) {
        showError("settings.customMarkers.error.limit", { count: MAX_CUSTOM_MARKER_ENTRIES });
        return;
      }
      const value = cleanCustomMarkerValue(raw);
      const next = addCustomMarkerDefinition(this.port.settings.customMarkers, {
        id: createCustomMarkerId(kind, value, this.port.settings.customMarkers),
        kind,
        value
      });
      if (next.length === this.port.settings.customMarkers.length) {
        showError("settings.customMarkers.error.duplicate");
        return;
      }
      input.value = "";
      hideError();
      commit(next);
    };

    addButton.addEventListener("click", (event) => {
      event.preventDefault();
      addValue();
    });
    input.addEventListener("keydown", (event) => {
      // Enter also confirms an IME candidate. Adding there would store a
      // half-composed value, so only a plain Enter adds.
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      addValue();
    });
    input.addEventListener("input", hideError);
    render();
  }
}
