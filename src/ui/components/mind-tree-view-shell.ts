import type { BottomStatusBarActions, BottomStatusBarLabels } from "./bottom-status-bar";
import { BottomStatusBar } from "./bottom-status-bar";
import type { CanvasShellActions, CanvasShellLabels } from "./canvas-shell";
import { CanvasShell } from "./canvas-shell";
import { StatusIndicator } from "./status-indicator";
import type { TopToolbarActions, TopToolbarLabels } from "./top-toolbar";
import { TopToolbar } from "./top-toolbar";
import { DisposerBag } from "./ui-object";
import type { ViewMenuBarActions, ViewMenuBarLabels } from "./view-menu-bar";
import { ViewMenuBar } from "./view-menu-bar";
import { AdaptiveTooltipController } from "../adaptive-tooltip";

export interface MindTreeViewShellLabels {
  readonly menu: ViewMenuBarLabels;
  readonly toolbar: TopToolbarLabels;
  readonly bottom: BottomStatusBarLabels;
  readonly canvas: CanvasShellLabels;
}

export interface MindTreeViewShellActions {
  readonly menu: ViewMenuBarActions;
  readonly toolbar: TopToolbarActions;
  readonly bottom: BottomStatusBarActions;
  readonly canvas: CanvasShellActions;
}

/**
 * Composes the fixed view chrome. It deliberately knows nothing about the
 * document, plugin, vault or MindTreeView class.
 */
export class MindTreeViewShell {
  readonly element: HTMLElement;
  readonly menu: ViewMenuBar;
  readonly toolbar: TopToolbar;
  readonly status: StatusIndicator;
  readonly bottom: BottomStatusBar;
  readonly canvas: CanvasShell;
  private readonly cleanup = new DisposerBag();

  constructor(parent: HTMLElement, labels: MindTreeViewShellLabels, actions: MindTreeViewShellActions) {
    parent.empty();
    this.element = parent.createDiv("mtn-view");
    this.element.addClass("is-initializing-viewport");
    this.menu = new ViewMenuBar(this.element, labels.menu, actions.menu);
    this.toolbar = new TopToolbar(this.element, labels.toolbar, actions.toolbar);
    this.status = new StatusIndicator(this.element);
    this.bottom = new BottomStatusBar(this.element, labels.bottom, actions.bottom);
    this.canvas = new CanvasShell(this.element, labels.canvas, actions.canvas);
    // DisposerBag releases in reverse order: children first, root last.
    this.cleanup.add(() => this.element.remove());
    this.cleanup.add(() => this.menu.destroy());
    this.cleanup.add(() => this.toolbar.destroy());
    this.cleanup.add(() => this.status.destroy());
    this.cleanup.add(() => this.bottom.destroy());
    this.cleanup.add(() => this.canvas.destroy());
    const tooltips = new AdaptiveTooltipController(this.element);
    this.cleanup.add(() => tooltips.destroy());
  }

  destroy(): void {
    this.cleanup.dispose();
  }
}
