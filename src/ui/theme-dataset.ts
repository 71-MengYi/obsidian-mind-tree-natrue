import type { MindTreeDocumentSettings } from "../types";

/**
 * Theme selection reaches CSS through data attributes so the canvas, the
 * read-only previews and the version comparison all render from one mapping.
 * One attribute set, four values: a new document setting must appear here only.
 */
export function applyMindTreeThemeDataset(element: HTMLElement, settings: MindTreeDocumentSettings): void {
  element.dataset.mtnTheme = settings.theme;
  element.dataset.mtnNodeShape = settings.nodeShape;
  element.dataset.mtnConnectionStyle = settings.connectionStyle;
  element.dataset.mtnLayout = settings.layoutMode;
}
