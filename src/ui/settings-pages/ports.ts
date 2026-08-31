import type { MindTreeSettings } from "../../settings-model";

/** Settings pages mutate only the supplied model and named persistence ports. */
export interface SettingsPagePort {
  readonly settings: MindTreeSettings;
  readonly save: () => Promise<void>;
  readonly refreshOpenLayouts: () => void;
}

export interface SettingsPageObject {
  readonly element: HTMLElement;
}
