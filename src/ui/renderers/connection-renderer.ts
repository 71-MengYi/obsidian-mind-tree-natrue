import type { MindTreeDocumentSettings, NodeId, PositionedNode } from "../../types";
import { branchColorCss } from "../presentation";
import { connectionPath, type TreeLayout } from "../layout";
import { resolveThemeConnection } from "../theme-presets";

export interface ConnectionRenderState {
  readonly layout: TreeLayout;
  readonly settings: Readonly<MindTreeDocumentSettings>;
  readonly positions: ReadonlyMap<NodeId, PositionedNode>;
  readonly branchColorSlots: ReadonlyMap<NodeId, number>;
}

/** Renders connection geometry and theme styling into the existing SVG layer. */
export class ConnectionRenderer {
  constructor(readonly element: SVGSVGElement) {}

  render(state: ConnectionRenderState): void {
    const { element } = this;
    element.empty();
    element.setAttribute("width", String(state.layout.width));
    element.setAttribute("height", String(state.layout.height));
    element.setAttribute("viewBox", `0 0 ${state.layout.width} ${state.layout.height}`);
    for (const connection of state.layout.connections) {
      const from = state.positions.get(connection.from);
      const to = state.positions.get(connection.to);
      if (!from || !to) continue;
      const visual = resolveThemeConnection(state.settings.theme, state.settings.connectionStyle, to.depth);
      const path = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", connectionPath(from, to, state.settings.layoutMode, visual.style));
      path.classList.add("mtn-connection");
      path.dataset.fromNodeId = connection.from;
      path.dataset.toNodeId = connection.to;
      path.style.setProperty("--mtn-connection-color", branchColorCss(state.branchColorSlots.get(connection.to)));
      path.style.setProperty("--mtn-connection-width", `${visual.width}px`);
      path.style.setProperty("--mtn-connection-opacity", String(visual.opacity));
      path.style.setProperty("--mtn-connection-filter", visual.shadow);
      path.style.setProperty("--mtn-connection-linecap", visual.lineCap);
      path.style.setProperty("--mtn-connection-linejoin", visual.lineJoin);
      if (visual.dash) path.style.setProperty("--mtn-connection-dash", visual.dash);
      path.classList.toggle("is-dashed", Boolean(visual.dash));
      element.appendChild(path);
    }
  }

  destroy(): void { this.element.empty(); }
}
