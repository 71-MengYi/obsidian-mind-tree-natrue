import { getLanguage } from "obsidian";
import { translate, type TranslationKey, type TranslationVariables } from "./catalog";

// UI modules can stay coupled to the i18n facade instead of importing the catalog directly.
export type { TranslationKey } from "./catalog";

export function t(key: TranslationKey, variables?: TranslationVariables): string {
  return translate(key, getLanguage(), variables);
}
