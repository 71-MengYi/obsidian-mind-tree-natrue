import { t } from "../../i18n";
import type { UpdateState } from "./update-coordinator";

/** All internal failure codes are translated at the UI boundary. */
export function updateMessage(state: UpdateState): string {
  if (state.error) return t(`update.error.${state.error.code}`, {
    detail: state.error.detail, path: state.backupPath ?? state.error.detail
  });
  return t(`update.state.${state.phase}`, {
    current: state.currentVersion, version: state.latestVersion ?? state.currentVersion
  });
}
