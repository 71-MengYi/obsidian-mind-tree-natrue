import { t, type TranslationKey } from "../../i18n";
import type { UpdateState } from "./update-coordinator";

/** All internal failure codes are translated at the UI boundary. */
export function updateMessage(state: UpdateState): string {
  if (state.error) {
    const error = state.error;
    let key: TranslationKey = `update.error.${error.code}`;
    if (error.code === "storage") {
      let cause: unknown = error, systemCode: unknown;
      for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
        if ("code" in cause && ["EACCES", "EPERM", "ENOSPC", "EDQUOT"].includes(String(cause.code))) {
          systemCode = cause.code; break;
        }
        cause = "cause" in cause ? cause.cause : undefined;
      }
      if (systemCode === "EACCES" || systemCode === "EPERM") key = "update.error.permission";
      else if (systemCode === "ENOSPC" || systemCode === "EDQUOT") key = "update.error.noSpace";
      else if (error.stage === "backup") key = "update.error.backup";
      else if (error.stage === "installing") key = "update.error.write";
    }
    return t(key, {
      detail: [...new Set([error.target, error.detail].filter(Boolean))].join("\n"),
      path: error.code === "recovery" ? state.backupPath ?? error.detail : error.target || error.detail || state.backupPath || ""
    }).trim();
  }
  if (state.phase === "idle") return "";
  return t(`update.state.${state.phase}`, {
    current: state.currentVersion, version: state.installedVersion ?? state.latestVersion ?? state.currentVersion
  });
}
