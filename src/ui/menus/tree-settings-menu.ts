import { Menu } from "obsidian";
import { t } from "../../i18n";
import type {
  MindTreeCollectionMode, MindTreeConnectionStyle, MindTreeDocumentSettings,
  MindTreeLayoutMode, MindTreeNodeShape, MindTreeTheme
} from "../../types";
import {
  COLLECTION_MODE_OPTIONS, CONNECTION_OPTIONS, LAYOUT_OPTIONS, NODE_SHAPE_OPTIONS, THEME_OPTIONS
} from "../presentation";

interface Choice<T extends string | number> { readonly value: T; readonly label: string; }

export interface TreeSettingsMenuActions {
  readonly setLayout: (value: MindTreeLayoutMode) => void;
  readonly setTheme: (value: MindTreeTheme) => void;
  readonly setConnectionStyle: (value: MindTreeConnectionStyle) => void;
  readonly setNodeShape: (value: MindTreeNodeShape) => void;
  readonly setCollectionMode: (value: MindTreeCollectionMode) => void;
  readonly toggleRecursiveScan: () => void;
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
      this.settings.theme, this.actions.setTheme);
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
    menu.showAtMouseEvent(event);
  }

  private addChoice<T extends string | number>(
    menu: Menu,
    title: string,
    icon: string,
    choices: ReadonlyArray<Choice<T>>,
    current: T,
    onChange: (value: T) => void
  ): void {
    const currentLabel = choices.find((choice) => choice.value === current)?.label;
    menu.addItem((item) => item.setTitle(currentLabel ? `${title}: ${currentLabel}` : title).setIcon(icon)
      .onClick(() => this.showChoices(title, choices, current, onChange)));
  }

  private showChoices<T extends string | number>(
    title: string,
    choices: ReadonlyArray<Choice<T>>,
    current: T,
    onChange: (value: T) => void
  ): void {
    const menu = new Menu();
    addLabel(menu, title);
    for (const choice of choices) menu.addItem((item) => item.setTitle(choice.label)
      .setChecked(choice.value === current).onClick(() => onChange(choice.value)));
    const rect = this.anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right + 6, y: rect.top });
  }
}

function addLabel(menu: Menu, title: string): void {
  menu.addItem((item) => item.setTitle(title).setIsLabel(true));
}
