import type {
  MindTreeConnectionStyle,
  MindTreeTheme,
  ResolvedMindTreeConnectionStyle
} from "../types";

export interface ThemeConnectionPreset {
  /** Geometry used when the global line setting is “Follow theme”. */
  style: ResolvedMindTreeConnectionStyle;
  /** Theme-specific dash rhythm; ignored by solid styles. */
  dash: string;
  opacity: number;
  lineCap: "round" | "square";
  lineJoin: "round" | "miter";
  shadow: string;
}

export interface MindTreeThemePreset {
  canvas: string;
  surface: string;
  text: string;
  root: string;
  rootText: string;
  /** Light Mindmap supplies twelve accents; root child order selects a slot. */
  branches: readonly string[];
  connection: ThemeConnectionPreset;
  /** Optional tier palette for themes whose nodes must not inherit branch colors. */
  nodes?: {
    levelOne: string;
    levelOneText: string;
    descendant: string;
    descendantText: string;
    /** CSS filter values are also valid SVG filters during export. */
    shadow: string;
    rootShadow: string;
  };
}

export interface ResolvedThemeConnection extends ThemeConnectionPreset {
  style: ResolvedMindTreeConnectionStyle;
  width: number;
  dash: string;
}

/**
 * Palettes are adapted from ninglg/light-mindmap (MIT). Root fills remain flat
 * to honor Mind Tree Nature's established no-gradient requirement. Connection
 * presets turn each theme into a complete visual language instead of a recolor.
 */
export const MIND_TREE_THEME_PRESETS: Readonly<Record<MindTreeTheme, MindTreeThemePreset>> = {
  vibrant: {
    canvas: "#FFFFFF", surface: "#FFFFFF", text: "#1F2937",
    root: "#8B5CF6", rootText: "#FFFFFF",
    branches: ["#F87171", "#FB923C", "#FBBF24", "#A3E635", "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6", "#F43F5E", "#10B981", "#0EA5E9"],
    connection: { style: "smooth", dash: "", opacity: 0.9, lineCap: "round", lineJoin: "round", shadow: "drop-shadow(0 1px 2px rgb(0 0 0 / 10%))" }
  },
  classic: {
    canvas: "#FFFEF6", surface: "#FFFEF6", text: "#1F2937",
    root: "#FFB800", rootText: "#3B2A00",
    branches: ["#19807E", "#383B70", "#A05A2C", "#7B9BC6", "#C47A82", "#3A8A8C", "#B85C5C", "#5D6D7E", "#8B7355", "#4A6B8A", "#9C6B4F", "#6B7A8F"],
    connection: { style: "orthogonal", dash: "", opacity: 0.84, lineCap: "square", lineJoin: "miter", shadow: "none" }
  },
  fresh: {
    canvas: "#F0FDF4", surface: "#F8FFF9", text: "#0F172A",
    root: "#10B981", rootText: "#FFFFFF",
    branches: ["#10B981", "#22D3EE", "#84CC16", "#14B8A6", "#06B6D4", "#34D399", "#A3E635", "#0EA5E9", "#65A30D", "#0891B2", "#16A34A", "#0D9488"],
    connection: { style: "smooth", dash: "", opacity: 0.86, lineCap: "round", lineJoin: "round", shadow: "drop-shadow(0 1px 1px rgb(15 118 110 / 10%))" }
  },
  ocean: {
    canvas: "#EFF6FF", surface: "#F8FBFF", text: "#0F172A",
    root: "#2563EB", rootText: "#FFFFFF",
    branches: ["#0EA5E9", "#06B6D4", "#3B82F6", "#6366F1", "#8B5CF6", "#0891B2", "#0284C7", "#2563EB", "#4F46E5", "#7C3AED", "#0E7490", "#1E40AF"],
    connection: { style: "smooth-dashed", dash: "7 5", opacity: 0.88, lineCap: "round", lineJoin: "round", shadow: "drop-shadow(0 1px 2px rgb(37 99 235 / 12%))" }
  },
  sunset: {
    canvas: "#FFF7ED", surface: "#FFFBF7", text: "#1F2937",
    root: "#F43F5E", rootText: "#FFFFFF",
    branches: ["#F43F5E", "#F97316", "#FBBF24", "#EF4444", "#EC4899", "#FB923C", "#F59E0B", "#DC2626", "#DB2777", "#EA580C", "#D97706", "#BE185D"],
    connection: { style: "smooth", dash: "", opacity: 0.9, lineCap: "round", lineJoin: "round", shadow: "drop-shadow(0 1px 2px rgb(244 63 94 / 12%))" }
  },
  midnight: {
    canvas: "#202531", surface: "#252B38", text: "#E2E8F0",
    root: "#1799F3", rootText: "#FFFFFF",
    branches: ["#22D3EE", "#A78BFA", "#F472B6", "#34D399", "#FBBF24", "#60A5FA", "#FB923C", "#F87171", "#10B981", "#A3E635", "#8B5CF6", "#0EA5E9"],
    connection: { style: "orthogonal-dashed", dash: "6 4", opacity: 0.96, lineCap: "round", lineJoin: "round", shadow: "drop-shadow(0 0 3px rgb(34 211 238 / 20%))" }
  },
  slate: {
    canvas: "#2C3341", surface: "#323A49", text: "#CBD5E1",
    root: "#6366F1", rootText: "#FFFFFF",
    branches: ["#38BDF8", "#818CF8", "#22D3EE", "#2DD4BF", "#A78BFA", "#34D399", "#67E8F9", "#C084FC", "#5EEAD4", "#7DD3FC", "#93C5FD", "#6EE7B7"],
    connection: { style: "straight", dash: "", opacity: 0.9, lineCap: "square", lineJoin: "miter", shadow: "none" }
  },
  flat: {
    canvas: "#F7F3E8", surface: "#E2E0DB", text: "#2F2F2F",
    root: "#7C3AED", rootText: "#FFFFFF",
    branches: ["#F87171", "#FB923C", "#FBBF24", "#A3E635", "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6", "#F43F5E", "#10B981", "#0EA5E9"],
    connection: { style: "smooth", dash: "", opacity: 0.9, lineCap: "round", lineJoin: "round", shadow: "none" },
    nodes: { levelOne: "#4A4A4A", levelOneText: "#FFFFFF", descendant: "#E2E0DB", descendantText: "#2F2F2F", shadow: "none", rootShadow: "none" }
  },
  minimal: {
    canvas: "#F7F3E8", surface: "#E2E0DB", text: "#2F2F2F",
    root: "#7C3AED", rootText: "#FFFFFF",
    branches: ["#F87171", "#FB923C", "#FBBF24", "#A3E635", "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6", "#F43F5E", "#10B981", "#0EA5E9"],
    connection: { style: "smooth", dash: "", opacity: 0.9, lineCap: "round", lineJoin: "round", shadow: "none" },
    nodes: { levelOne: "#4A4A4A", levelOneText: "#FFFFFF", descendant: "#E2E0DB", descendantText: "#2F2F2F", shadow: "drop-shadow(0 2px 6px rgb(0 0 0 / 10%))", rootShadow: "drop-shadow(0 4px 12px rgb(0 0 0 / 14%))" }
  },
  floating: {
    canvas: "#F7F3E8", surface: "#E2E0DB", text: "#2F2F2F",
    root: "#7C3AED", rootText: "#FFFFFF",
    branches: ["#F87171", "#FB923C", "#FBBF24", "#A3E635", "#34D399", "#22D3EE", "#60A5FA", "#A78BFA", "#F472B6", "#F43F5E", "#10B981", "#0EA5E9"],
    connection: { style: "smooth", dash: "", opacity: 0.9, lineCap: "round", lineJoin: "round", shadow: "none" },
    nodes: { levelOne: "#4A4A4A", levelOneText: "#FFFFFF", descendant: "#E2E0DB", descendantText: "#2F2F2F", shadow: "drop-shadow(0 6px 18px rgb(0 0 0 / 20%))", rootShadow: "drop-shadow(0 10px 28px rgb(0 0 0 / 24%))" }
  }
};

export function getThemePreset(theme: MindTreeTheme): MindTreeThemePreset {
  return MIND_TREE_THEME_PRESETS[theme];
}

/** Resolve geometry and visual line details while retaining explicit overrides. */
export function resolveThemeConnection(
  theme: MindTreeTheme,
  configuredStyle: MindTreeConnectionStyle,
  _childDepth: number
): ResolvedThemeConnection {
  const preset = getThemePreset(theme).connection;
  const style = configuredStyle === "theme" ? preset.style : configuredStyle;
  const dashed = style.endsWith("dashed");
  return {
    ...preset,
    style,
    dash: dashed ? (configuredStyle === "theme" ? preset.dash || "6 4" : "8 6") : "",
    // Connection weight is intentionally independent from theme and depth.
    width: 1
  };
}
