/**
 * The unversioned format shipped immediately before migrations were introduced
 * is defined as schema v1. Anything older is intentionally unsupported.
 */
export const EARLIEST_SUPPORTED_MIND_TREE_SCHEMA_VERSION = 1;
export const CURRENT_MIND_TREE_SCHEMA_VERSION = 2;
export const MIND_TREE_SCHEMA_VERSION_YAML_KEY = "schemaVersion";

export interface MindTreeMigrationState {
  frontmatter: Record<string, unknown>;
  machineData: Record<string, unknown>;
}

export interface MindTreeMigrationResult extends MindTreeMigrationState {
  sourceVersion: number;
  targetVersion: number;
  migrated: boolean;
}

type MindTreeMigration = (state: Readonly<MindTreeMigrationState>) => MindTreeMigrationState;

/** A single registry and sequential runner for every incompatible file change. */
export class MindTreeMigrationFactory {
  private readonly migrations = new Map<number, MindTreeMigration>();

  constructor() {
    // v2 makes the schema marker explicit. Optional presentation/operation
    // settings are intentionally absent here: the document-settings registry
    // fills any missing value from global defaults independently of versions.
    this.register(1, (state) => ({
      frontmatter: { ...state.frontmatter },
      machineData: { ...state.machineData }
    }));
  }

  /** Register the migration that upgrades `fromVersion` to the next integer. */
  register(fromVersion: number, migration: MindTreeMigration): this {
    if (!Number.isInteger(fromVersion) || fromVersion < EARLIEST_SUPPORTED_MIND_TREE_SCHEMA_VERSION) {
      throw new Error(`Invalid Mind Tree migration source version: ${fromVersion}`);
    }
    if (this.migrations.has(fromVersion)) {
      throw new Error(`Mind Tree migration ${fromVersion} is already registered.`);
    }
    this.migrations.set(fromVersion, migration);
    return this;
  }

  migrate(
    frontmatter: Readonly<Record<string, unknown>>,
    machineData: Readonly<Record<string, unknown>>
  ): MindTreeMigrationResult {
    const sourceVersion = readSchemaVersion(frontmatter[MIND_TREE_SCHEMA_VERSION_YAML_KEY]);
    if (sourceVersion < EARLIEST_SUPPORTED_MIND_TREE_SCHEMA_VERSION) {
      throw new Error(
        `Mind Tree schema v${sourceVersion} is older than the earliest supported v${EARLIEST_SUPPORTED_MIND_TREE_SCHEMA_VERSION}.`
      );
    }
    if (sourceVersion > CURRENT_MIND_TREE_SCHEMA_VERSION) {
      throw new Error(
        `Mind Tree schema v${sourceVersion} is newer than supported v${CURRENT_MIND_TREE_SCHEMA_VERSION}.`
      );
    }

    let version = sourceVersion;
    let state: MindTreeMigrationState = {
      frontmatter: { ...frontmatter },
      machineData: { ...machineData }
    };
    while (version < CURRENT_MIND_TREE_SCHEMA_VERSION) {
      const migration = this.migrations.get(version);
      if (!migration) throw new Error(`Missing Mind Tree migration from schema v${version}.`);
      state = migration(state);
      version += 1;
      state.frontmatter[MIND_TREE_SCHEMA_VERSION_YAML_KEY] = version;
    }

    return {
      ...state,
      sourceVersion,
      targetVersion: version,
      migrated: sourceVersion !== version
    };
  }
}

/** Missing schemaVersion identifies the current unversioned baseline (v1). */
function readSchemaVersion(value: unknown): number {
  if (value === undefined) return EARLIEST_SUPPORTED_MIND_TREE_SCHEMA_VERSION;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Mind Tree schemaVersion must be a non-negative integer.");
  }
  return value;
}

export const mindTreeMigrationFactory = new MindTreeMigrationFactory();
