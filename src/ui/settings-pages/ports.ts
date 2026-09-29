import type { MindTreeSettings } from "../../settings-model";
import type { ResourceIndexProgress, ResourceIndexReport } from "../../services/resource-catalog";

/** Settings pages mutate only the supplied model and named persistence ports. */
export interface SettingsPagePort {
  readonly settings: MindTreeSettings;
  readonly save: () => Promise<void>;
  readonly refreshOpenLayouts: () => void;
  readonly rebuildResourceIndex: (progress?: (value: ResourceIndexProgress) => void) => Promise<ResourceIndexReport>;
}

export interface SettingsPageObject {
  readonly element: HTMLElement;
}
