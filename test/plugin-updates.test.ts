import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareVersions, ReleaseClient, sha256, UPDATE_FILES, UPDATE_LIMITS, UPDATE_REPOSITORY,
  UpdateError, type UpdateFile, type UpdatePayload } from "../src/services/updates/release-client";
import { UpdateStore, type UpdateStorage } from "../src/services/updates/update-store";
import { UpdateCoordinator, updateRuntime, type UpdateHost, type UpdateState } from "../src/services/updates/update-coordinator";
import { UpdateActivity } from "../src/services/updates/update-activity";
import { PluginReloadBridge } from "../src/services/updates/plugin-reload-bridge";
import { normalizePluginData } from "../src/plugin-data";

const DIRECTORY = ".obsidian/plugins/mind-tree-nature";
function payload(version: string): UpdatePayload {
  return {
    "manifest.json": JSON.stringify({ id: "mind-tree-nature", name: "Mind Tree Nature", version,
      minAppVersion: "1.8.7", isDesktopOnly: false, author: "Meng Yi", description: "Test" }),
    "main.js": `/* ${version} */ module.exports = {};`, "styles.css": `/* ${version} */ .mtn-node { color: gray; }`
  };
}
const buffer = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const code = (expected: string) => (error: unknown) => error instanceof UpdateError && error.code === expected;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function channel(version = "1.0.2", files = payload(version)) {
  const root = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${version}/`;
  const metadata = { id: 42, tag_name: version, draft: false, prerelease: false,
    assets: await Promise.all(UPDATE_FILES.map(async (name) => ({ name, state: "uploaded",
      browser_download_url: root + name, size: buffer(files[name]).byteLength, digest: `sha256:${await sha256(files[name])}` }))) };
  const calls: string[] = [];
  let status = 200;
  const request = async (url: string) => {
    calls.push(url);
    return { status, arrayBuffer: buffer(url.endsWith("/latest") ? JSON.stringify(metadata)
      : files[url.slice(root.length) as UpdateFile] ?? "not found") };
  };
  return { metadata, files, calls, request, setStatus: (value: number) => { status = value; },
    client: new ReleaseClient(request, () => true, false) };
}

class MemoryUpdateDisk implements UpdateStorage {
  files = new Map<string, string>();
  directories = new Set<string>([".obsidian", ".obsidian/plugins", DIRECTORY]);
  calls: string[] = [];
  pointer: unknown = null;
  failProcess?: UpdateFile;
  beforeProcess?: (path: string) => void;
  constructor(version = "1.0.1") {
    for (const name of UPDATE_FILES) this.files.set(`${DIRECTORY}/${name}`, payload(version)[name]);
    this.files.set(`${DIRECTORY}/data.json`, '{"settings":{"keep":true}}');
    this.files.set(`${DIRECTORY}/pending-conflicts/device/record.json`, "pending");
    this.files.set("Notes/Topic.mtn.md", "protected note");
  }
  async exists(path: string) { return this.files.has(path) || this.directories.has(path); }
  async read(path: string) { if (!this.files.has(path)) throw new Error(`Missing ${path}`); return this.files.get(path)!; }
  async write(path: string, value: string) { this.calls.push(`write:${path}`); this.files.set(path, value); }
  async process(path: string, update: (value: string) => string) {
    this.beforeProcess?.(path);
    if (this.failProcess && path === `${DIRECTORY}/${this.failProcess}`) { this.failProcess = undefined; throw new Error("disk full"); }
    const result = update(await this.read(path));
    await this.write(path, result);
    return result;
  }
  async mkdir(path: string) { this.directories.add(path); }
  async remove(path: string) { this.calls.push(`remove:${path}`); this.files.delete(path); }
  async rmdir(path: string, recursive: boolean) {
    assert.equal(recursive, false);
    assert.ok(![...this.files.keys()].some((file) => file.startsWith(`${path}/`)));
    this.directories.delete(path);
  }
  store() { return new UpdateStore(this, { load: () => this.pointer, save: (value) => { this.pointer = value; } }, DIRECTORY, "device-A"); }
  assertProtected() {
    assert.equal(this.files.get(`${DIRECTORY}/data.json`), '{"settings":{"keep":true}}');
    assert.equal(this.files.get(`${DIRECTORY}/pending-conflicts/device/record.json`), "pending");
    assert.equal(this.files.get("Notes/Topic.mtn.md"), "protected note");
    assert.ok(this.calls.every((call) => !/data\.json|pending-conflicts|Topic\.mtn/.test(call)));
  }
  assertVersion(version: string) {
    for (const name of UPDATE_FILES) assert.equal(this.files.get(`${DIRECTORY}/${name}`), payload(version)[name]);
  }
}

test("update settings remain opt-in and are the only new persisted preference", () => {
  for (const value of [undefined, null, "true", 1, {}]) {
    assert.equal(normalizePluginData({ settings: { autoCheckUpdates: value } }).settings.autoCheckUpdates, false);
  }
  assert.equal(normalizePluginData({ settings: { autoCheckUpdates: true } }).settings.autoCheckUpdates, true);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.1.0", "1.0.0"), -1);
  for (const value of ["v1.0.0", "01.0.0", "1.0", "1.0.0-beta", "1.0.99999999999999999"]) {
    assert.throws(() => compareVersions(value, "1.0.0"), code("version"));
  }
});

test("official three assets are verified before installation and preserve exact UTF-8 bytes", async () => {
  const remote = await channel();
  const release = await remote.client.latest();
  assert.equal(release.version, "1.0.2");
  assert.deepEqual(await remote.client.download(release), payload("1.0.2"));
  assert.equal(remote.calls.length, 5);
  remote.files["main.js"] += "tampered";
  await assert.rejects(remote.client.download(release), code("integrity"));
});

test("drafts, prereleases, incomplete, oversized, untrusted and duplicate assets fail closed", async () => {
  const cases: Array<(remote: Awaited<ReturnType<typeof channel>>) => void> = [
    (r) => { r.metadata.draft = true; }, (r) => { r.metadata.prerelease = true; },
    (r) => { r.metadata.assets.pop(); }, (r) => { r.metadata.assets.push(r.metadata.assets[0]!); },
    (r) => { r.metadata.assets[0]!.digest = ""; },
    (r) => { r.metadata.assets[0]!.browser_download_url = "https://evil.invalid/main.js"; },
    (r) => { r.metadata.assets[0]!.state = "new"; },
    (r) => { r.metadata.assets[0]!.size = UPDATE_LIMITS["styles.css"] + 1; }
  ];
  for (const alter of cases) { const remote = await channel(); alter(remote); await assert.rejects(remote.client.latest(), UpdateError); }
});

test("manifest identity, release-version mismatch and both platform gates reject before writes", async () => {
  for (const [change, expected] of [
    [{ id: "other-plugin" }, "identity"], [{ version: "0.1.0" }, "version"]
  ] as const) {
    const files = payload("1.0.0");
    files["manifest.json"] = JSON.stringify({ ...JSON.parse(files["manifest.json"]), ...change });
    await assert.rejects((await channel("1.0.0", files)).client.latest(), code(expected));
  }
  const remote = await channel();
  await assert.rejects(new ReleaseClient(remote.request, () => false, false).latest(), code("compatibility"));
  const files = payload("1.0.2");
  files["manifest.json"] = files["manifest.json"].replace('"isDesktopOnly":false', '"isDesktopOnly":true');
  const desktopOnly = await channel("1.0.2", files);
  await assert.rejects(new ReleaseClient(desktopOnly.request, () => true, true).latest(), code("compatibility"));
  await new ReleaseClient(remote.request, () => true, true).latest();
});

test("HTTP failure and timeouts do not accept late responses", async () => {
  const remote = await channel(); remote.setStatus(403);
  await assert.rejects(remote.client.latest(), code("network"));
  const gate = deferred<{ status: number; arrayBuffer: ArrayBuffer }>();
  const client = new ReleaseClient(() => gate.promise, () => true, false, 5);
  await assert.rejects(client.latest(), code("timeout"));
  gate.resolve(await (await channel()).request("https://api.github.com/ignored/latest"));
});

test("update stages, atomically compares each file, verifies and cleans only its own temporary files", async () => {
  const disk = new MemoryUpdateDisk(); const store = disk.store();
  await store.stage(payload("1.0.2"), "1.0.1"); disk.assertVersion("1.0.1");
  assert.ok(disk.pointer);
  let validations = 0;
  await store.install(async () => { validations++; });
  assert.equal(validations, 3); disk.assertVersion("1.0.2");
  await store.commit(); await store.cleanup();
  assert.equal(disk.pointer, null);
  assert.ok(![...disk.files.keys()].some((path) => path.includes("/.updates/")));
  disk.assertProtected();
});

test("each installation write failure rolls back without touching user data", async () => {
  for (const name of UPDATE_FILES) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1"); disk.failProcess = name;
    await assert.rejects(store.install(async () => undefined));
    await store.rollback(); await store.cleanup(); disk.assertVersion("1.0.1"); disk.assertProtected();
  }
});

test("changes in atomic callback and foreign rollback bytes are never overwritten", async () => {
  const disk = new MemoryUpdateDisk(); const store = disk.store();
  await store.stage(payload("1.0.2"), "1.0.1");
  disk.beforeProcess = (path) => {
    if (path.endsWith("/main.js")) { disk.files.set(path, "third-party change"); disk.beforeProcess = undefined; }
  };
  await assert.rejects(store.install(async () => undefined), code("changed"));
  await assert.rejects(store.rollback(), code("recovery"));
  assert.equal(disk.files.get(`${DIRECTORY}/main.js`), "third-party change");
  assert.ok(disk.pointer); disk.assertProtected();
});

test("restart rolls back prepared and partially/fully installed transactions, never committed ones", async () => {
  for (const phase of ["prepared", "partial", "installed", "committed"] as const) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1");
    if (phase === "partial") { disk.failProcess = "main.js"; await assert.rejects(store.install(async () => undefined)); }
    if (phase === "installed" || phase === "committed") await store.install(async () => undefined);
    if (phase === "committed") await store.commit();
    const recovery = await disk.store().recover();
    const version = phase === "committed" ? "1.0.2" : "1.0.1";
    assert.equal(recovery?.version, version);
    assert.equal(recovery?.rolledBack, phase !== "committed");
    disk.assertVersion(version); disk.assertProtected(); assert.equal(disk.pointer, null);
  }
});

test("corrupt journal, backup, unsafe paths and storage capacity failures stop safely", async () => {
  assert.throws(() => new UpdateStore(new MemoryUpdateDisk(), { load: () => null, save: () => undefined }, "../other", "client"));
  for (const corrupt of ["backup", "journal"]) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1");
    disk.files.set(`${store.backupPath}/${corrupt === "backup" ? "before-main.js" : "transaction.json"}`, "broken");
    await assert.rejects(disk.store().recover(), code("recovery")); disk.assertVersion("1.0.1"); disk.assertProtected();
    assert.ok(disk.pointer);
  }
  const disk = new MemoryUpdateDisk();
  const store = new UpdateStore(disk, { load: () => null, save: () => { throw new Error("quota"); } }, DIRECTORY, "client");
  await assert.rejects(store.stage(payload("1.0.2"), "1.0.1")); disk.assertVersion("1.0.1"); disk.assertProtected();
});

async function coordinatorFixture(fail?: "save" | "load" | "restore") {
  const remote = await channel(); const disk = new MemoryUpdateDisk(); const phases: string[] = [];
  const notices: UpdateState[] = [];
  let failed = false;
  const host: UpdateHost = { assertSupported() {}, async prepare() {
    phases.push("prepare"); if (fail === "save") throw new UpdateError("save");
    return {
      async assertSafe() { phases.push("safe"); }, async unload() { phases.push("unload"); },
      async load(version) { phases.push(`load:${version}`); if (fail === "load" && version === "1.0.2") throw new UpdateError("reload"); },
      async restore() { phases.push("restore"); if (fail === "restore" && !failed) { failed = true; throw new UpdateError("reload"); } },
      resume() { phases.push("resume"); }
    };
  } };
  const runtime = updateRuntime({});
  const coordinator = new UpdateCoordinator(remote.client, disk.store(), host, runtime, "1.0.1", (state) => notices.push(state));
  return { remote, disk, phases, notices, runtime, coordinator };
}

test("one check/install task, unsubscribed UI, and successful verified reload", async () => {
  const f = await coordinatorFixture();
  assert.equal(f.coordinator.check(), f.coordinator.check()); await f.coordinator.check();
  let updates = 0;
  const unsubscribe = f.coordinator.subscribe(() => updates++); unsubscribe();
  const install = f.coordinator.install(); assert.equal(install, f.coordinator.install()); await install;
  assert.equal(updates, 1); f.disk.assertVersion("1.0.2"); f.disk.assertProtected();
  assert.equal(f.coordinator.state.phase, "updated"); assert.equal(f.runtime.installing, false);
  assert.ok(f.phases.indexOf("prepare") < f.phases.indexOf("unload"));
  assert.ok(f.phases.indexOf("load:1.0.2") < f.phases.indexOf("restore"));
});

test("save, load and restore failures retain or reload the old program, never discard notes", async () => {
  for (const failure of ["save", "load", "restore"] as const) {
    const f = await coordinatorFixture(failure);
    await f.coordinator.check(); await f.coordinator.install();
    f.disk.assertVersion("1.0.1"); f.disk.assertProtected();
    assert.equal(f.coordinator.state.phase, "error"); assert.equal(f.runtime.installing, false);
    if (failure === "save") assert.ok(!f.phases.includes("unload"));
    else assert.ok(f.phases.includes("load:1.0.1"));
  }
});

test("startup checks once per application, without downloads or automatic installation", async () => {
  const f = await coordinatorFixture();
  f.coordinator.startup(false); f.coordinator.startup(true);
  assert.equal(f.remote.calls.length, 0);
  const enabled = await coordinatorFixture();
  enabled.coordinator.startup(true); await enabled.coordinator.check();
  enabled.coordinator.startup(true); assert.equal(enabled.remote.calls.length, 2);
  assert.equal(enabled.notices.length, 1); enabled.disk.assertVersion("1.0.1");
  const object = {}; assert.equal(updateRuntime(object), updateRuntime(object));
  const later = new UpdateCoordinator(enabled.remote.client, enabled.disk.store(), {} as UpdateHost,
    enabled.runtime, "1.0.1", () => assert.fail());
  later.startup(true); assert.equal(enabled.remote.calls.length, 2);
});

test("same and older releases never install, and failed automatic checks do not notify", async () => {
  for (const installed of ["1.0.2", "2.0.0"]) {
    const remote = await channel(); const disk = new MemoryUpdateDisk(installed);
    const updater = new UpdateCoordinator(remote.client, disk.store(), {} as UpdateHost, updateRuntime({}), installed, () => assert.fail());
    await updater.check(true); await updater.install(); assert.equal(updater.state.phase, "current"); assert.equal(disk.calls.length, 0);
  }
  const f = await coordinatorFixture(); f.remote.setStatus(429);
  await f.coordinator.check(true); assert.equal(f.notices.length, 0); assert.equal(f.coordinator.state.phase, "error");
});

test("activity barrier waits for nested continuations and releases instrumentation", async () => {
  const gate = deferred(); const activity = new UpdateActivity(); const order: string[] = [];
  const target = { async create() { await gate.promise; await this.associate(); }, async associate() { order.push("associated"); } };
  const original = target.create;
  const restore = activity.observe(target, ["create", "associate"]);
  const task = target.create(); const settled = activity.settle().then(() => order.push("settled"));
  assert.deepEqual(order, []); gate.resolve(); await Promise.all([task, settled]);
  assert.deepEqual(order, ["associated", "settled"]); restore(); assert.equal(target.create, original);
});

test("reload bridge checks capabilities, awaits unload and verifies new readiness/version", async () => {
  const calls: string[] = [];
  const plugins: Record<string, unknown> = { "mind-tree-nature": {
    manifest: { version: "1.0.1" }, waitForUpdateUnload: async () => { calls.push("settled"); }
  } };
  const app = { plugins: {
    plugins, async disablePlugin(id: string) { calls.push("disable"); delete plugins[id]; },
    async loadManifests() { calls.push("manifest"); },
    async enablePlugin(id: string) { calls.push("enable"); plugins[id] = { manifest: { version: "1.0.2" }, updateReady: true }; }
  } };
  const bridge = new PluginReloadBridge(app as never);
  await bridge.load("1.0.2"); assert.deepEqual(calls, ["disable", "settled", "manifest", "enable"]);
  await assert.rejects(bridge.load("3.0.0"), code("reload"));
  assert.throws(() => new PluginReloadBridge({} as never).assertSupported(), code("reload"));
});

test("updater wiring keeps HTTP opt-in, reload baselines and UI cleanup explicit", () => {
  const main = readFileSync("src/main.ts", "utf8"); const view = readFileSync("src/ui/mind-tree-view.ts", "utf8");
  assert.match(main, /updates\.startup\(this\.settings\.autoCheckUpdates\)/);
  assert.match(view, /updateRuntime\.baselines\?\.get/);
  assert.match(view, /updateActivity\.settle\(\)/);
  assert.match(view, /rootEl\.inert = true/);
  assert.match(readFileSync("src/ui/settings-pages/plugin-update-section.ts", "utf8"), /destroy\(\).*this\.unsubscribe\(\)/);
});
