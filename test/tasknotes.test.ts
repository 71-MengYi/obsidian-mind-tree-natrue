import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TASKNOTES_PLUGIN_ID,
  TaskNotesMoveUnavailableError,
  TaskNotesService,
  TaskNotesUnavailableError,
  findTaskNotesPlugin,
  pluginRegistryOf,
  resolveTaskNotesApi,
  type TaskNotesMutationContext,
  type TaskNotesRuntimeApi
} from "../src/services/tasknotes";
import { translate, type TranslationKey } from "../src/i18n/catalog";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

interface CreateCall {
  title: string;
  context?: TaskNotesMutationContext;
}

interface MoveCall {
  path: string;
  targetFolder: string;
  context?: TaskNotesMutationContext;
}

function validApi(calls: CreateCall[], moves: MoveCall[] = []): TaskNotesRuntimeApi {
  return {
    apiVersion: 1,
    hasCapability: (capability) => capability === "tasks.write" || capability === "tasks.move",
    tasks: {
      create: async (data, context) => {
        calls.push({ title: data.title, context });
        return { path: `Tasks/${data.title}.md` };
      },
      move: async (path, targetFolder, context) => {
        moves.push({ path, targetFolder, context });
        const name = path.split("/").pop() ?? path;
        return { path: targetFolder ? `${targetFolder}/${name}` : name };
      }
    }
  };
}

function serviceWith(registry: unknown): TaskNotesService {
  return new TaskNotesService(
    () => registry,
    () => "mind-tree-nature",
    () => "correlation-1"
  );
}

test("TaskNotes is found through Obsidian's plugin getter or the raw plugin map", () => {
  const plugin = { api: {} };
  assert.equal(findTaskNotesPlugin({ getPlugin: (id: string) => id === TASKNOTES_PLUGIN_ID ? plugin : undefined }), plugin);
  assert.equal(findTaskNotesPlugin({ plugins: { [TASKNOTES_PLUGIN_ID]: plugin } }), plugin);
  // A registry call that fails or answers nothing must not hide the map fallback.
  assert.equal(findTaskNotesPlugin({
    getPlugin: () => { throw new Error("host cannot enumerate plugins"); },
    plugins: { [TASKNOTES_PLUGIN_ID]: plugin }
  }), plugin);
  assert.equal(findTaskNotesPlugin({ getPlugin: () => null, plugins: {} }), undefined);
  for (const registry of [undefined, null, "plugins", 42]) {
    assert.equal(findTaskNotesPlugin(registry), undefined);
  }
});

test("the app registry accessor tolerates hosts without a plugin registry", () => {
  const registry = { plugins: { [TASKNOTES_PLUGIN_ID]: {} } };
  assert.equal(pluginRegistryOf({ plugins: registry }), registry);
  assert.equal(pluginRegistryOf({}), undefined);
  assert.equal(pluginRegistryOf(undefined), undefined);
});

test("only runtime API v1 with task-write capability is accepted", () => {
  const calls: CreateCall[] = [];
  assert.ok(resolveTaskNotesApi({ api: validApi(calls) }));
  const rejected: unknown[] = [
    undefined,
    null,
    {},
    { api: null },
    { api: {} },
    { api: { apiVersion: 2, hasCapability: () => true, tasks: { create: async () => ({ path: "a.md" }) } } },
    { api: { apiVersion: "1", hasCapability: () => true, tasks: { create: async () => ({ path: "a.md" }) } } },
    { api: { apiVersion: 1, hasCapability: () => false, tasks: { create: async () => ({ path: "a.md" }) } } },
    { api: { apiVersion: 1, hasCapability: () => { throw new Error("unavailable"); }, tasks: { create: async () => ({ path: "a.md" }) } } },
    { api: { apiVersion: 1, hasCapability: () => true } },
    { api: { apiVersion: 1, hasCapability: () => true, tasks: {} } }
  ];
  for (const plugin of rejected) {
    assert.equal(resolveTaskNotesApi(plugin), undefined);
  }
});

test("creating a TaskNote passes the node title and reports the real task path", async () => {
  const calls: CreateCall[] = [];
  const service = serviceWith({ getPlugin: () => ({ api: validApi(calls) }) });
  assert.equal(service.installed(), true);
  assert.ok(service.resolveApi());
  const created = await service.createTask("Buy groceries tomorrow");
  assert.deepEqual(created, { path: "Tasks/Buy groceries tomorrow.md", moved: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "Buy groceries tomorrow");
  // Mutations identify this plugin as the source so TaskNotes events stay traceable.
  assert.equal(calls[0]?.context?.source, "mind-tree-nature");
  assert.equal(calls[0]?.context?.correlationId, "correlation-1");
  assert.equal(typeof calls[0]?.context?.reason, "string");
});

test("a TaskNote is moved into the mind tree folder through TaskNotes", async () => {
  const calls: CreateCall[] = [];
  const moves: MoveCall[] = [];
  const service = serviceWith({ getPlugin: () => ({ api: validApi(calls, moves) }) });
  const created = await service.createTask("Buy groceries", { targetFolder: "Projects/Plan" });
  assert.deepEqual(created, { path: "Projects/Plan/Buy groceries.md", moved: true });
  assert.equal(calls.length, 1);
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.path, "Tasks/Buy groceries.md");
  assert.equal(moves[0]?.targetFolder, "Projects/Plan");
  // Both mutations share one correlation id so TaskNotes events stay paired.
  assert.equal(moves[0]?.context?.correlationId, calls[0]?.context?.correlationId);
  assert.equal(moves[0]?.context?.source, "mind-tree-nature");
  assert.notEqual(moves[0]?.context?.reason, calls[0]?.context?.reason);
});

test("a tree at the vault root is expressed as an empty target folder", async () => {
  const moves: MoveCall[] = [];
  const service = serviceWith({ getPlugin: () => ({ api: validApi([], moves) }) });
  const created = await service.createTask("Root task", { targetFolder: "" });
  assert.deepEqual(created, { path: "Root task.md", moved: true });
  assert.equal(moves[0]?.targetFolder, "");
});

test("a TaskNotes without move support refuses a targeted creation before writing", async () => {
  const calls: CreateCall[] = [];
  const withoutMove = validApi(calls);
  delete withoutMove.tasks.move;
  const service = serviceWith({ getPlugin: () => ({ api: withoutMove }) });
  await assert.rejects(
    service.createTask("Task", { targetFolder: "Notes" }),
    (error: unknown) => error instanceof TaskNotesMoveUnavailableError
  );
  assert.equal(calls.length, 0);

  // A missing capability is also a refusal even if an unadvertised method exists.
  const noCapability = validApi(calls);
  noCapability.hasCapability = (capability) => capability === "tasks.write";
  const capabilityService = serviceWith({ getPlugin: () => ({ api: noCapability }) });
  await assert.rejects(
    capabilityService.createTask("Task", { targetFolder: "Notes" }),
    (error: unknown) => error instanceof TaskNotesMoveUnavailableError
  );
  assert.equal(calls.length, 0);
});

test("a failed move keeps the created note and reports where it stayed", async () => {
  const calls: CreateCall[] = [];
  const failure = new Error("A file named Task.md already exists");
  const api = validApi(calls);
  api.tasks.move = async () => { throw failure; };
  const service = serviceWith({ getPlugin: () => ({ api }) });
  const created = await service.createTask("Task", { targetFolder: "Tree" });
  assert.equal(created.path, "Tasks/Task.md");
  assert.equal(created.moved, false);
  assert.equal(created.moveError, failure);
  assert.equal(calls.length, 1);
});

test("a missing or outdated TaskNotes fails before any note is created", async () => {
  const missing = serviceWith({ plugins: {} });
  assert.equal(missing.installed(), false);
  assert.equal(missing.resolveApi(), undefined);
  await assert.rejects(missing.createTask("Task"), (error: unknown) => error instanceof TaskNotesUnavailableError);

  // Installed but incompatible: the view must be able to tell "install" from "update".
  const outdated = serviceWith({
    plugins: { [TASKNOTES_PLUGIN_ID]: { api: { apiVersion: 1, hasCapability: () => false } } }
  });
  assert.equal(outdated.installed(), true);
  assert.equal(outdated.resolveApi(), undefined);
  await assert.rejects(outdated.createTask("Task"), (error: unknown) => error instanceof TaskNotesUnavailableError);
});

test("TaskNotes answers without a path or throws are reported, never linked silently", async () => {
  const failure = new Error("task folder is read-only");
  const throwing = serviceWith({
    plugins: {
      [TASKNOTES_PLUGIN_ID]: {
        api: { apiVersion: 1, hasCapability: () => true, tasks: { create: async () => { throw failure; } } }
      }
    }
  });
  await assert.rejects(throwing.createTask("Task"), (error: unknown) => error === failure);

  const pathless = serviceWith({
    plugins: {
      [TASKNOTES_PLUGIN_ID]: {
        api: { apiVersion: 1, hasCapability: () => true, tasks: { create: async () => ({ path: "" }) } }
      }
    }
  });
  await assert.rejects(pathless.createTask("Task"), /did not return a task path/);
});

test("the node menu offers Create TaskNote below Add note only for unlinked nodes", () => {
  const contracts = source("ui/ui-contracts.ts");
  const menu = source("ui/menus/node-context-menu.ts");
  const view = source("ui/mind-tree-view.ts");
  const main = source("main.ts");
  // Ordering is the contract: the link row leads, the creation group follows,
  // and the TaskNote row sits directly under Add note inside that group.
  assert.match(contracts, /\["add-note", "create-task-note", "add-file-template", "create-tree"\]/);
  assert.match(contracts, /items\.push\("link-file", "create-from", "link-web"\)/);
  // A resource or a node link still suppresses every creation row, this one included.
  const guarded = contracts.slice(
    contracts.indexOf("if (!state.hasResource && !state.nodeLinked)"),
    contracts.indexOf("if (state.hasResource)")
  );
  assert.match(guarded, /"create-from"/);
  assert.match(menu, /case "create-task-note": return \{ title: t\("menu\.createTaskNote"\)/);
  assert.match(view, /createTaskNote: \(\) => void this\.createTaskNoteForNode\(nodeId\)/);
  assert.match(view, /private async createTaskNoteForNode\(nodeId: NodeId\)/);
  assert.match(view, /const taskNotes = this\.plugin\.taskNotes;/);
  // The note is created in TaskNotes' folder and then moved into the tree folder.
  const method = view.slice(
    view.indexOf("private async createTaskNoteForNode"),
    view.indexOf("private showTemplateFilePicker")
  );
  assert.match(method, /const treeDirectory = this\.file\?\.parent\?\.isRoot\(\) \? "" : this\.file\?\.parent\?\.path \?\? ""/);
  assert.match(method, /createTask\(title, \{ targetFolder: treeDirectory \}\)/);
  assert.match(method, /notice\.taskNoteMoveFailed/);
  assert.match(method, /error instanceof TaskNotesMoveUnavailableError/);
  // The row stays visible without TaskNotes so the install hint is reachable.
  assert.match(view, /taskNotes\.installed\(\) \? "notice\.taskNotesApiUnsupported" : "notice\.taskNotesMissing"/);
  assert.match(main, /new TaskNotesService\(/);
});

test("TaskNotes strings exist in both languages with matching placeholders", () => {
  const keys = [
    "menu.createTaskNote",
    "notice.createTaskNoteFailed",
    "notice.createdTaskNoteNotLinked",
    "notice.taskNotesMissing",
    "notice.taskNotesApiUnsupported",
    "notice.taskNotesMoveUnsupported",
    "notice.taskNoteMoveFailed",
    "notice.taskNoteFileMissing",
    "modal.createTaskNote.title",
    "modal.createTaskNote.placeholder"
  ] as const satisfies readonly TranslationKey[];
  const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
  for (const key of keys) {
    const english = translate(key, "en");
    const chinese = translate(key, "zh");
    assert.notEqual(english, key);
    assert.notEqual(chinese, english);
    assert.deepEqual(placeholders(chinese), placeholders(english));
  }
});
