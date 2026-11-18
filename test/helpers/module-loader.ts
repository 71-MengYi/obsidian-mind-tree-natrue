import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, createContext } from "node:vm";

/**
 * Load a TypeScript module graph as CommonJS inside a private VM realm.
 *
 * Several UI suites must run the real source against a minimal DOM and a fake
 * `obsidian` boundary, because Node cannot resolve (or execute) Obsidian
 * outside the app. This loader replaces the previous esbuild bundle step:
 * esbuild talks to its service over a child-process pipe, which fails with
 * `spawn EPERM` inside the confined workspace sandbox. It also keeps the graph
 * in a `vm` context so the fake DOM globals (`setTimeout`, `Event`, `CSS`,
 * `window`, ...) stay per-load instead of leaking through `globalThis`.
 *
 * The repository pins TypeScript 7's native compiler, whose package only
 * exposes the `tsc` CLI to JavaScript (`ts.transpileModule` belongs to the
 * older JS compiler API). When `transpileModule` is available it is used per
 * module. Otherwise the graph is emitted once with the local `tsc` CLI into the
 * repository's ignored `.mtn-test-build/` scratch folder; stdio is redirected to
 * a log file instead of a pipe so the confined sandbox permits the child process.
 *
 * Each `loadModule` call gets a fresh module cache and VM realm, mirroring one
 * esbuild bundle per entry: fixtures that build several plugin instances must
 * not share module-level state or the first fixture's `obsidian` stub.
 */
export interface LoadModuleOptions {
  /** Module returned for `require("obsidian")`; every suite owns its own stub. */
  readonly obsidian: Readonly<Record<string, unknown>>;
  /**
   * Extra VM globals. The loader does not pass the host's globals implicitly,
   * so a suite keeps the same realm surface it had with `runInNewContext`
   * (for example fake `setTimeout`, `Event`, `CSS`, or `structuredClone`).
   */
  readonly globals?: Readonly<Record<string, unknown>>;
}

type ModuleExports = Record<string, unknown>;
type RequireFunction = (specifier: string) => unknown;

interface Backend {
  /** Map the entry passed by a test to the file executed in the VM. */
  entryId(entryPath: string): string;
  /** Resolve a relative `require()` from an already loaded module. */
  resolve(from: string, specifier: string): string;
  load(id: string): string;
}

interface TranspileApi {
  transpileModule(
    input: string,
    options: { compilerOptions?: Record<string, unknown>; fileName?: string }
  ): { outputText: string };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = resolve(repositoryRoot, "src");
const repositoryRequire = createRequire(import.meta.url);

let backend: Backend | undefined;

/** TypeScript 7 (native) exposes no in-process transpiler; TypeScript 5 does. */
function detectTranspileApi(): TranspileApi | undefined {
  let typescript: unknown;
  try {
    typescript = repositoryRequire("typescript");
  } catch {
    return undefined;
  }
  if (typeof typescript !== "object" || typescript === null) return undefined;
  const candidate = typescript as { transpileModule?: unknown };
  if (typeof candidate.transpileModule !== "function") return undefined;
  return {
    transpileModule: candidate.transpileModule as TranspileApi["transpileModule"]
  };
}

function firstExisting(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  }
  return undefined;
}

function resolveTypeScriptCli(): string {
  const entry = repositoryRequire.resolve("typescript");
  const packageRoot = resolve(dirname(entry), "..");
  const cli = firstExisting([join(packageRoot, "bin", "tsc"), join(packageRoot, "bin", "tsc.js")]);
  if (cli === undefined) throw new Error(`Cannot find the TypeScript CLI next to ${entry}`);
  return cli;
}

function createTranspileBackend(api: TranspileApi): Backend {
  const resolveSource = (base: string): string | undefined => firstExisting([
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx")
  ]);

  return {
    entryId(entryPath: string): string {
      const absolute = isAbsolute(entryPath) ? entryPath : resolve(repositoryRoot, entryPath);
      const id = resolveSource(absolute);
      if (id === undefined) throw new Error(`Cannot find module entry: ${entryPath}`);
      return id;
    },
    resolve(from: string, specifier: string): string {
      const id = resolveSource(resolve(dirname(from), specifier));
      if (id === undefined) throw new Error(`Cannot resolve "${specifier}" from ${from}`);
      return id;
    },
    load(id: string): string {
      // ModuleKind.CommonJS = 1 and ScriptTarget.ES2022 = 9 are stable enum values.
      return api.transpileModule(readFileSync(id, "utf8"), {
        compilerOptions: { module: 1, target: 9, esModuleInterop: true },
        fileName: id
      }).outputText;
    }
  };
}

function createEmittedBackend(): Backend {
  // The native compiler has no per-file API, so emit the whole source tree once
  // and load those CommonJS files. This is the TypeScript-7 fallback only.
  // `noCheck` is safe here: `tsc --noEmit` remains the suite's type gate, while
  // this emit only needs syntax and module transformation.
  // Keep the emit inside the repository's ignored scratch folder. The confined
  // DSH sandbox denies child-process writes to the OS temp directory, while the
  // checkout itself stays writable in both the sandbox and CI.
  const workRoot = join(repositoryRoot, ".mtn-test-build");
  mkdirSync(workRoot, { recursive: true });
  const workDirectory = mkdtempSync(join(workRoot, "module-loader-"));
  const outputDirectory = join(workDirectory, "out");
  const configPath = join(workDirectory, "tsconfig.json");
  const logPath = join(workDirectory, "tsc.log");
  const normalizedSourceRoot = sourceRoot.replaceAll("\\", "/");
  // Keep these emit options aligned with tsconfig.json; the fallback only needs
  // the module transform and class-field semantics, not the type checker.
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "bundler",
      esModuleInterop: true,
      useDefineForClassFields: true,
      skipLibCheck: true,
      noCheck: true,
      rootDir: normalizedSourceRoot,
      outDir: outputDirectory.replaceAll("\\", "/"),
      lib: ["DOM", "DOM.Iterable", "ES2022"],
      types: []
    },
    include: [`${normalizedSourceRoot}/**/*.ts`]
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const logFd = openSync(logPath, "w");
  let status: number | null;
  let error: Error | undefined;
  try {
    const result = spawnSync(process.execPath, [resolveTypeScriptCli(), "--project", configPath], {
      stdio: ["ignore", logFd, logFd]
    });
    status = result.status;
    error = result.error;
  } finally {
    closeSync(logFd);
  }

  const log = readFileSync(logPath, "utf8").trim();
  if (error !== undefined) {
    rmSync(workDirectory, { recursive: true, force: true });
    throw new Error(`TypeScript emit could not start: ${error.message}${log ? `\n${log}` : ""}`);
  }
  if (status !== 0) {
    rmSync(workDirectory, { recursive: true, force: true });
    throw new Error(`TypeScript emit failed with exit code ${status}:\n${log}`);
  }
  process.once("exit", () => {
    try {
      rmSync(workDirectory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS temp directory is allowed to collect stragglers.
    }
  });

  const emittedFile = (base: string): string | undefined => firstExisting([
    base,
    `${base}.js`,
    join(base, "index.js")
  ]);

  return {
    entryId(entryPath: string): string {
      const absolute = isAbsolute(entryPath) ? entryPath : resolve(repositoryRoot, entryPath);
      if (absolute !== sourceRoot && !absolute.startsWith(`${sourceRoot}${sep}`)) {
        throw new Error(`Module entry must live under src/: ${entryPath}`);
      }
      const relativeEntry = absolute.slice(sourceRoot.length + 1).replace(/\.tsx?$/, ".js");
      const emitted = emittedFile(join(outputDirectory, relativeEntry));
      if (emitted === undefined) throw new Error(`TypeScript did not emit ${entryPath}`);
      return emitted;
    },
    resolve(from: string, specifier: string): string {
      const id = emittedFile(resolve(dirname(from), specifier));
      if (id === undefined) throw new Error(`Cannot resolve "${specifier}" from ${from}`);
      return id;
    },
    load(id: string): string {
      return readFileSync(id, "utf8");
    }
  };
}

function getBackend(): Backend {
  if (backend !== undefined) return backend;
  const api = detectTranspileApi();
  backend = api !== undefined ? createTranspileBackend(api) : createEmittedBackend();
  return backend;
}

/**
 * Execute `entryPath` (repository-relative or absolute) and return its exports.
 *
 * Modules are cached by absolute path inside one call, with an empty `exports`
 * placeholder installed before evaluation so circular imports observe the same
 * semantics as CommonJS. Relative specifiers resolve without an extension and
 * through a directory `index.ts`; bare specifiers fall back to Node's resolver;
 * `obsidian` always comes from `options.obsidian`.
 */
export function loadModule<T extends object = ModuleExports>(
  entryPath: string,
  options: LoadModuleOptions
): T {
  const activeBackend = getBackend();
  const entry = activeBackend.entryId(entryPath);

  // A fresh context per entry keeps `setTimeout`, `Event`, `CSS`, ... scoped to
  // this fixture and gives every graph its own realm, like the old bundle.
  const context = createContext({ ...(options.globals ?? {}) });
  const cache = new Map<string, { exports: ModuleExports }>();

  const load = (id: string): ModuleExports => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached.exports;

    // Install the placeholder before evaluating so cycles see partial exports.
    const moduleRecord: { exports: ModuleExports } = { exports: {} };
    cache.set(id, moduleRecord);

    const localRequire: RequireFunction = (specifier: string): unknown => {
      if (specifier === "obsidian") return options.obsidian;
      if (specifier.startsWith(".")) return load(activeBackend.resolve(id, specifier));
      return repositoryRequire(specifier);
    };

    const evaluate = compileFunction(
      activeBackend.load(id),
      ["exports", "require", "module", "__filename", "__dirname"],
      { parsingContext: context, filename: id }
    );
    evaluate.call(moduleRecord.exports, moduleRecord.exports, localRequire, moduleRecord, id, dirname(id));
    return moduleRecord.exports;
  };

  return load(entry) as T;
}
