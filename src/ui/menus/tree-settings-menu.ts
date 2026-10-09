import { Menu } from "obsidian";
import { t } from "../../i18n";
import type {
  MindTreeCollectionMode, MindTreeConnectionStyle, MindTreeDocumentSettings,
  MindTreeLayoutMode, MindTreeNodeShape, MindTreeTheme
} from "../../types";
import {
  COLLECTION_MODE_OPTIONS, CONNECTION_OPTIONS, LAYOUT_OPTIONS, NODE_SHAPE_OPTIONS, THEME_OPTIONS
} from "../presentation";
import { bindThemeMenuHover, captureShownMenuElement } from "./theme-menu-hover";

interface Choice<T extends string | number> { readonly value: T; readonly label: string; }

export interface TreeSettingsMenuActions {
  readonly setLayout: (value: MindTreeLayoutMode) => void;
  readonly setTheme: (value: MindTreeTheme) => void;
  readonly setConnectionStyle: (value: MindTreeConnectionStyle) => void;
  readonly setNodeShape: (value: MindTreeNodeShape) => void;
  readonly setCollectionMode: (value: MindTreeCollectionMode) => void;
  readonly toggleRecursiveScan: () => void;
  /**
   * Optional live preview for the theme list. Both callbacks must be supplied
   * together; without them this menu behaves exactly as it did before.
   */
  readonly previewTheme?: (theme: MindTreeTheme, anchor: HTMLElement) => void;
  readonly endThemePreview?: () => void;
}

/** YAML-backed choices that are intentionally allowed to differ per tree. */
export class TreeSettingsMenu {
  constructor(
    private readonly settings: Readonly<MindTreeDocumentSettings>,
    private readonly anchor: HTMLElement,
    private readonly actions: TreeSettingsMenuActions
  ) {}

  show(event: MouseEvent): void {
    const menu = new Menu();
    addLabel(menu, t("viewSettings.currentTree"));
    this.addChoice(menu, t("settings.layout.name"), "layout-template",
      LAYOUT_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      this.settings.layoutMode, this.actions.setLayout);
    this.addChoice(menu, t("viewSettings.theme"), "palette",
      THEME_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      this.settings.theme, this.actions.setTheme, THEME_OPTIONS.map((option) => option.value));
    this.addChoice(menu, t("viewSettings.connectionStyle"), "git-branch",
      CONNECTION_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      this.settings.connectionStyle, this.actions.setConnectionStyle);
    this.addChoice(menu, t("viewSettings.nodeShape"), "shapes",
      NODE_SHAPE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      this.settings.nodeShape, this.actions.setNodeShape);
    this.addChoice(menu, t("viewSettings.collectionMode"), "folder-input",
      COLLECTION_MODE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      this.settings.collectionMode, this.actions.setCollectionMode);
    menu.addItem((item) => item.setTitle(t("settings.recursive.name")).setIcon("folder-tree")
      .setChecked(this.settings.recursiveScan).onClick(this.actions.toggleRecursiveScan));
    // Closing the parent menu must also drop a preview started in its submenu.
    const endThemePreview = this.actions.endThemePreview;
    if (this.actions.previewTheme && endThemePreview) menu.onHide(() => endThemePreview());
    menu.showAtMouseEvent(event);
  }

  private addChoice<T extends string | number>(
    menu: Menu,
    title: string,
    icon: string,
    choices: ReadonlyArray<Choice<T>>,
    current: T,
    onChange: (value: T) => void,
    previewThemes?: readonly MindTreeTheme[]
  ): void {
    const currentLabel = choices.find((choice) => choice.value === current)?.label;
    menu.addItem((item) => item.setTitle(currentLabel ? `${title}: ${currentLabel}` : title).setIcon(icon)
      .onClick(() => this.showChoices(title, choices, current, onChange, previewThemes)));
  }

  private showChoices<T extends string | number>(
    title: string,
    choices: ReadonlyArray<Choice<T>>,
    current: T,
    onChange: (value: T) => void,
    previewThemes?: readonly MindTreeTheme[]
  ): void {
    const previewTheme = previewThemes ? this.actions.previewTheme : undefined;
    const endThemePreview = previewThemes ? this.actions.endThemePreview : undefined;
    const menu = new Menu();
    // Native desktop menus render no DOM rows, so hover cannot be observed.
    if (previewTheme && endThemePreview) menu.setUseNativeMenu(false);
    addLabel(menu, title);
    for (const choice of choices) menu.addItem((item) => item.setTitle(choice.label)
      .setChecked(choice.value === current).onClick(() => onChange(choice.value)));
    const rect = this.anchor.getBoundingClientRect();
    const position = { x: rect.right + 6, y: rect.top };
    if (!previewThemes || !previewTheme || !endThemePreview) {
      menu.showAtPosition(position);
      return;
    }
    // Every close route (choice, Escape, outside click) must drop the preview.
    menu.onHide(() => endThemePreview());
    const element = captureShownMenuElement(this.anchor.ownerDocument, () => { menu.showAtPosition(position); });
    // Missing DOM or unexpected rows degrade to a plain menu without hover.
    if (element) {
      bindThemeMenuHover(element, previewThemes, {
        onEnter: (theme, row) => previewTheme(theme, row),
        onLeave: () => endThemePreview()
      });
    }
  }
}

function addLabel(menu: Menu, title: string): void {
  menu.addItem((item) => item.setTitle(title).setIsLabel(true));
}
