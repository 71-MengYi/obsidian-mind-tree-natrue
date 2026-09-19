/** Reserved folder created beside a mind tree when a save conflict is preserved. */
export const MIND_TREE_RECOVERY_FOLDER = "_Mind Tree Recovery";

/** Matches the filesystem-safe millisecond timestamp emitted by recoveryTimestamp(). */
export const RECOVERY_TIMESTAMP_PATTERN = /^\d{8}-\d{6}-\d{3}$/;

export interface RecoveryReminderContext {
  readonly filePath: string;
  readonly sessionToken: string;
}

/**
 * Return the reserved recovery root beside an ordinary mind-tree file.
 * Opening a recovery copy itself must never start a recursive lookup.
 */
export function recoveryRootPathForFile(filePath: string): string | undefined {
  const parts = pathParts(filePath);
  if (parts.length === 0 || parts.includes(MIND_TREE_RECOVERY_FOLDER)) return undefined;
  return [...parts.slice(0, -1), MIND_TREE_RECOVERY_FOLDER].join("/");
}

/**
 * Select only exact same-name copies in one standard timestamp directory.
 * Paths are sorted newest-first because the timestamp format is lexical.
 */
export function findSameNameRecoveryPaths(
  currentFilePath: string,
  candidatePaths: readonly string[]
): string[] {
  const currentParts = pathParts(currentFilePath);
  const recoveryRoot = recoveryRootPathForFile(currentFilePath);
  if (!recoveryRoot || currentParts.length === 0) return [];

  const fileName = currentParts.at(-1)!;
  const rootParts = pathParts(recoveryRoot);
  return [...new Set(candidatePaths.map(normalizeVaultPath).filter((candidatePath) => {
    const candidateParts = pathParts(candidatePath);
    if (candidateParts.length !== rootParts.length + 2) return false;
    if (!rootParts.every((part, index) => candidateParts[index] === part)) return false;
    return RECOVERY_TIMESTAMP_PATTERN.test(candidateParts[rootParts.length] ?? "")
      && candidateParts.at(-1) === fileName;
  }))].sort((left, right) => right.localeCompare(left));
}

/** Cancel delayed reminders after a view switches to another file or session. */
export function isRecoveryReminderContextCurrent(
  captured: Readonly<RecoveryReminderContext>,
  currentFilePath: string | undefined,
  currentSessionToken: string
): boolean {
  return captured.sessionToken === currentSessionToken
    && normalizeVaultPath(captured.filePath) === normalizeVaultPath(currentFilePath ?? "");
}

function pathParts(value: string): string[] {
  return normalizeVaultPath(value).split("/").filter(Boolean);
}

function normalizeVaultPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
