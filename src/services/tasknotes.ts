/**
 * Optional TaskNotes companion-plugin integration.
 *
 * TaskNotes exposes its runtime API on the loaded plugin instance
 * (`app.plugins.getPlugin("tasknotes").api`). Nothing here imports Obsidian: the
 * registry is injected as a port so the lookup and the creation call stay pure
 * data tests, and an absent, disabled or outdated TaskNotes is a normal state
 * rather than an error.
 */

export const TASKNOTES_PLUGIN_ID = "tasknotes";
export const TASKNOTES_RUNTIME_API_VERSION = 1;
export const TASKNOTES_WRITE_CAPABILITY = "tasks.write";
export const TASKNOTES_MOVE_CAPABILITY = "tasks.move";

/** The subset of TaskNotes' `TaskCreationData` this integration relies on. */
export interface TaskNotesTaskCreationData {
  readonly title: string;
}

export interface TaskNotesCreatedTask {
  readonly path: string;
}

/** Attached to TaskNotes events so companion writes stay identifiable. */
export interface TaskNotesMutationContext {
  readonly source?: string;
  readonly correlationId?: string;
  readonly reason?: string;
}

/** The subset of TaskNotes runtime API v1 that creates and places one task note. */
export interface TaskNotesRuntimeApi {
  readonly apiVersion: number;
  hasCapability(capability: string): boolean;
  readonly tasks: {
    create(
      data: TaskNotesTaskCreationData,
      context?: TaskNotesMutationContext
    ): Promise<TaskNotesCreatedTask>;
    /**
     * Optional because the capability was added to runtime API v1 over time; a
     * target folder therefore requires it explicitly before a note is created.
     * An empty target folder means the vault root.
     */
    move?(
      path: string,
      targetFolder: string,
      context?: TaskNotesMutationContext
    ): Promise<TaskNotesCreatedTask>;
  };
}

export interface CreateTaskNoteOptions {
  /** Vault-relative folder; an empty string means the vault root. */
  readonly targetFolder?: string;
}

/** The note TaskNotes actually created, and whether it reached the target folder. */
export interface CreatedTaskNote {
  /** Final vault-relative path, after any requested move. */
  readonly path: string;
  /** True when a requested target folder was reached. */
  readonly moved: boolean;
  /** Present only when the note was created but moving it into the folder failed. */
  readonly moveError?: unknown;
}

export class TaskNotesUnavailableError extends Error {
  constructor() {
    super("TaskNotes runtime API v1 is not available.");
    this.name = "TaskNotesUnavailableError";
  }
}

/** A target folder requires `tasks.move`, which this TaskNotes version lacks. */
export class TaskNotesMoveUnavailableError extends TaskNotesUnavailableError {
  constructor() {
    super();
    this.name = "TaskNotesMoveUnavailableError";
    this.message = "TaskNotes runtime API v1 cannot move task notes.";
  }
}

/** Obsidian's plugin registry is undocumented; accept both known shapes. */
interface TaskNotesPluginRegistry {
  getPlugin?(id: string): unknown;
  plugins?: Record<string, unknown>;
}

/**
 * Obsidian's plugin registry is not part of the public `App` type, so callers
 * pass the app as an unknown value through this single accessor.
 */
export function pluginRegistryOf(app: unknown): unknown {
  return (app as { plugins?: unknown } | null | undefined)?.plugins;
}

/** Prefer the supported `getPlugin` lookup, then fall back to the raw map. */
export function findTaskNotesPlugin(registry: unknown): unknown {
  if (!registry || typeof registry !== "object") return undefined;
  const candidate = registry as TaskNotesPluginRegistry;
  if (typeof candidate.getPlugin === "function") {
    try {
      const plugin = candidate.getPlugin(TASKNOTES_PLUGIN_ID);
      if (plugin) return plugin;
    } catch {
      // A host that cannot answer the registry call still gets the map fallback.
    }
  }
  return candidate.plugins?.[TASKNOTES_PLUGIN_ID];
}

/**
 * Fail closed on anything other than runtime API v1 with task-write capability:
 * an older TaskNotes has no API object, and guessing at internal shapes would
 * let a half-compatible version write task files this plugin cannot describe.
 */
export function resolveTaskNotesApi(plugin: unknown): TaskNotesRuntimeApi | undefined {
  if (!plugin || typeof plugin !== "object") return undefined;
  const api = (plugin as { api?: unknown }).api;
  if (!api || typeof api !== "object") return undefined;
  const candidate = api as Partial<TaskNotesRuntimeApi> & Record<string, unknown>;
  if (candidate.apiVersion !== TASKNOTES_RUNTIME_API_VERSION) return undefined;
  if (typeof candidate.hasCapability !== "function") return undefined;
  try {
    if (!candidate.hasCapability(TASKNOTES_WRITE_CAPABILITY)) return undefined;
  } catch {
    return undefined;
  }
  const create = (candidate.tasks as { create?: unknown } | undefined)?.create;
  if (typeof create !== "function") return undefined;
  return api as TaskNotesRuntimeApi;
}

/**
 * Resolves the API on every use: TaskNotes can be enabled, updated or unloaded
 * while a tree stays open, so a cached instance would be wrong in both
 * directions (a missing plugin that just loaded, an unloaded one that stayed).
 */
export class TaskNotesService {
  constructor(
    private readonly registry: () => unknown,
    private readonly source: () => string,
    private readonly createCorrelationId: () => string = () => crypto.randomUUID()
  ) {}

  resolveApi(): TaskNotesRuntimeApi | undefined {
    return resolveTaskNotesApi(findTaskNotesPlugin(this.registry()));
  }

  /** True when a TaskNotes plugin is present, whether or not its API is usable. */
  installed(): boolean {
    return Boolean(findTaskNotesPlugin(this.registry()));
  }

  /**
   * Create one task note through TaskNotes' own creation service, then move it
   * into the requested folder through the same service. TaskNotes decides its
   * default folder from its own settings and its public create API has no folder
   * parameter, so `tasks.move` is the supported way to place the note.
   */
  async createTask(title: string, options: CreateTaskNoteOptions = {}): Promise<CreatedTaskNote> {
    const api = this.resolveApi();
    if (!api) throw new TaskNotesUnavailableError();
    const { targetFolder } = options;
    const tasks = api.tasks;
    // A requested folder is a promise: without the move operation the note would
    // land somewhere else, so refuse before creating anything.
    if (targetFolder !== undefined
      && (!tasks.move || !this.hasCapability(api, TASKNOTES_MOVE_CAPABILITY))) {
      throw new TaskNotesMoveUnavailableError();
    }
    const correlationId = this.createCorrelationId();
    const task = await tasks.create(
      { title },
      this.context(correlationId, "Create a TaskNote from a mind tree node")
    );
    const path = taskPath(task);
    if (targetFolder === undefined) return { path, moved: false };
    try {
      // TaskNotes treats a move to the current folder as a no-op and an empty
      // folder as the vault root, so no path comparison is needed here.
      const moved = await tasks.move!(path, targetFolder, this.context(
        correlationId, "Move the TaskNote into the mind tree folder"
      ));
      return { path: taskPath(moved), moved: true };
    } catch (moveError) {
      // The note exists; keep its real path so the view can still link it.
      return { path, moved: false, moveError };
    }
  }

  private hasCapability(api: TaskNotesRuntimeApi, capability: string): boolean {
    try { return api.hasCapability(capability); } catch { return false; }
  }

  private context(correlationId: string, reason: string): TaskNotesMutationContext {
    return { source: this.source(), correlationId, reason };
  }
}

function taskPath(task: TaskNotesCreatedTask | undefined): string {
  const path = typeof task?.path === "string" ? task.path.trim() : "";
  if (!path) throw new Error("TaskNotes did not return a task path.");
  return path;
}
