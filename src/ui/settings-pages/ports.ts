import type { MindTreeSettings } from "../../settings-model";
import type { ResourceIndexProgress, ResourceIndexReport } from "../../services/resource-catalog";
import type { UpdateState } from "../../services/updates/update-coordinator";

/** Settings pages mutate only the supplied model and named persistence ports. */
export interface SettingsPagePort {
  readonly settings: MindTreeSettings;
  readonly save: () => Promise<void>;
  readonly refreshOpenLayouts: () => void;
  readonly rebuildResourceIndex: (progress?: (value: ResourceIndexProgress) => void) => Promise<ResourceIndexReport>;
  readonly updates: {
    check(): Promise<void>;
    showAvailable(): void;
    subscribe(listener: (state: UpdateState) => void): () => void;
  };
}

export interface SettingsPageObject {
  readonly element: HTMLElement;
  destroy?(): void;
}
