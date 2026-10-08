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
  const metadata = { id: 42, tag_name: version, draft: false, prerelease: false, body: undefined as unknown,
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
  fault?: (operation: string, path: string, value?: string) => void;
  delays: number[] = [];
  diagnostics: UpdateError[] = [];
  constructor(version = "1.0.1") {
    for (const name of UPDATE_FILES) this.files.set(`${DIRECTORY}/${name}`, payload(version)[name]);
    this.files.set(`${DIRECTORY}/data.json`, '{"settings":{"keep":true}}');
    this.files.set(`${DIRECTORY}/pending-conflicts/device/record.json`, "pending");
    this.files.set("Notes/Topic.mtn.md", "protected note");
  }
  async exists(path: string) { return this.files.has(path) || this.directories.has(path); }
  async read(path: string) { this.fault?.("read", path); if (!this.files.has(path)) throw new Error(`Missing ${path}`); return this.files.get(path)!; }
  async write(path: string, value: string) {
    this.fault?.("write", path, value);
    this.calls.push(`write:${path}`); this.files.set(path, value);
    this.fault?.("after-write", path, value);
  }
  async process(path: string, update: (value: string) => string) {
    this.fault?.("process", path);
    this.beforeProcess?.(path);
    if (this.failProcess && path === `${DIRECTORY}/${this.failProcess}`) { this.failProcess = undefined; throw new Error("disk full"); }
    const result = update(await this.read(path));
    await this.write(path, result);
    this.fault?.("after-process", path);
    return result;
  }
  async mkdir(path: string) { this.directories.add(path); }
  async remove(path: string) { this.fault?.("remove", path); this.calls.push(`remove:${path}`); this.files.delete(path); }
  async list(path: string) {
    const direct = (entry: string) => entry.startsWith(path + "/") && !entry.slice(path.length + 1).includes("/");
    return { files: [...this.files.keys()].filter(direct), folders: [...this.directories].filter(direct) };
  }
  async rmdir(path: string, recursive: boolean) {
    this.fault?.("rmdir", path);
    assert.equal(recursive, false);
    assert.ok(![...this.files.keys()].some((file) => file.startsWith(`${path}/`)));
    this.directories.delete(path);
  }
  store() { return new UpdateStore(this, { load: () => this.pointer, save: (value) => { this.pointer = value; } }, DIRECTORY, "device-A",
    { delay: async (milliseconds) => { this.delays.push(milliseconds); }, diagnose: (error) => this.diagnostics.push(error) }); }
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
  assert.equal(remote.calls.length, 4);
  assert.equal(remote.calls.filter((url) => url.endsWith("/manifest.json")).length, 1);
  remote.files["main.js"] += "tampered";
  await assert.rejects(remote.client.download(release), code("integrity"));
});

test("release notes preserve author Markdown and use the existing metadata request", async () => {
  for (const body of ["\n## 更新\n\n- **Fix**\n\n", "", " \t\r\n", undefined, null, 42, false, {}, ["notes"]]) {
    const remote = await channel();
    remote.metadata.body = body;
    const release = await remote.client.latest();
    assert.equal(release.notes, typeof body === "string" && body.trim() ? body : "");
    assert.equal(remote.calls.length, 2);
    assert.equal(remote.calls.filter((url) => url.endsWith("/latest")).length, 1);
    assert.ok(remote.calls[1]!.endsWith("/manifest.json"));
  }
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
  const client = new ReleaseClient(() => gate.promise, () => true, false, 5, 5, async () => undefined);
  await assert.rejects(client.latest(), code("timeout"));
  gate.resolve(await (await channel()).request("https://api.github.com/ignored/latest"));
});

test("update stages, atomically compares each file, verifies and cleans only its own temporary files", async () => {
  const disk = new MemoryUpdateDisk(); const store = disk.store();
  await store.stage(payload("1.0.2"), "1.0.1", "1.0.2"); disk.assertVersion("1.0.1");
  assert.ok(disk.pointer);
  await store.install();
  disk.assertVersion("1.0.2");
  await store.commit(); await store.cleanup();
  assert.equal(disk.pointer, null);
  assert.ok(![...disk.files.keys()].some((path) => path.includes("/.updates/")));
  disk.assertProtected();
});

test("each installation write failure rolls back without touching user data", async () => {
  for (const name of UPDATE_FILES) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1", "1.0.2"); disk.failProcess = name;
    await assert.rejects(store.install());
    await store.rollback(); await store.cleanup(); disk.assertVersion("1.0.1"); disk.assertProtected();
  }
});

test("changes in atomic callback and foreign rollback bytes are never overwritten", async () => {
  const disk = new MemoryUpdateDisk(); const store = disk.store();
  await store.stage(payload("1.0.2"), "1.0.1", "1.0.2");
  disk.beforeProcess = (path) => {
    if (path.endsWith("/main.js")) { disk.files.set(path, "third-party change"); disk.beforeProcess = undefined; }
  };
  await assert.rejects(store.install(), code("changed"));
  await assert.rejects(store.rollback(), code("recovery"));
  assert.equal(disk.files.get(`${DIRECTORY}/main.js`), "third-party change");
  assert.ok(disk.pointer); disk.assertProtected();
});

test("restart recognizes untouched, mixed and fully installed transactions by the actual files", async () => {
  for (const phase of ["prepared", "partial", "installed", "committed"] as const) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1", "1.0.2");
    if (phase === "partial") { disk.failProcess = "main.js"; await assert.rejects(store.install()); }
    if (phase === "installed" || phase === "committed") await store.install();
    if (phase === "committed") await store.commit();
    const recovery = await disk.store().recover();
    const version = phase === "committed" || phase === "installed" ? "1.0.2" : "1.0.1";
    assert.equal(recovery?.version, version);
    assert.equal(recovery?.rolledBack, phase === "partial");
    disk.assertVersion(version); disk.assertProtected(); assert.equal(disk.pointer, null);
  }
});

test("corrupt journal, backup, unsafe paths and storage capacity failures stop safely", async () => {
  assert.throws(() => new UpdateStore(new MemoryUpdateDisk(), { load: () => null, save: () => undefined }, "../other", "client"));
  for (const corrupt of ["backup", "journal"]) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1", "1.0.2");
    if (corrupt === "backup") { disk.failProcess = "main.js"; await assert.rejects(store.install()); }
    disk.files.set(`${store.backupPath}/${corrupt === "backup" ? "before-main.js" : "transaction.json"}`, "broken");
    const program = UPDATE_FILES.map((name) => disk.files.get(DIRECTORY + "/" + name));
    await assert.rejects(disk.store().recover(), code("recovery")); disk.assertProtected();
    assert.deepEqual(UPDATE_FILES.map((name) => disk.files.get(DIRECTORY + "/" + name)), program);
    assert.ok(disk.pointer);
  }
  const disk = new MemoryUpdateDisk();
  const store = new UpdateStore(disk, { load: () => null, save: () => { throw new Error("quota"); } }, DIRECTORY, "client");
  await assert.rejects(store.stage(payload("1.0.2"), "1.0.1", "1.0.2")); disk.assertVersion("1.0.1"); disk.assertProtected();
});

async function coordinatorFixture(fail?: "save" | "load" | "restore" | "unsupported", notify?: (state: UpdateState) => void) {
  const remote = await channel(); const disk = new MemoryUpdateDisk(); const phases: string[] = [];
  const notices: UpdateState[] = [];
  let failed = false;
  const host: UpdateHost = { canReload: () => fail !== "unsupported", async prepare() {
    phases.push("prepare"); if (fail === "save") throw new UpdateError("save");
    return {
      async assertSafe() { phases.push("safe"); }, async unload() {
        disk.assertVersion("1.0.2");
        assert.equal(JSON.parse(disk.files.get(DIRECTORY + "/.updates/device-A/" + disk.pointer + "/transaction.json")!).phase, "committed");
        phases.push("unload");
      },
      async load(version) { phases.push(`load:${version}`); if (fail === "load" && version === "1.0.2") throw new UpdateError("reload"); },
      async restore() { phases.push("restore"); if (fail === "restore" && !failed) { failed = true; throw new UpdateError("reload"); } },
      resume() { phases.push("resume"); }
    };
  } };
  const runtime = updateRuntime({});
  const coordinator = new UpdateCoordinator(remote.client, disk.store(), host, runtime, "1.0.1", (state) => {
    notices.push(state); notify?.(state);
  }, (error) => disk.diagnostics.push(error));
  return { remote, disk, phases, notices, runtime, coordinator, host };
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

test("save failure preserves the old program; reload and restore failures keep the installed version", async () => {
  for (const failure of ["save", "load", "restore", "unsupported"] as const) {
    const f = await coordinatorFixture(failure);
    await f.coordinator.check(); await f.coordinator.install();
    f.disk.assertVersion(failure === "save" ? "1.0.1" : "1.0.2"); f.disk.assertProtected();
    assert.equal(f.coordinator.state.phase, failure === "save" ? "error" : "restart-required"); assert.equal(f.runtime.installing, false);
    assert.equal(f.coordinator.state.currentVersion, failure === "restore" ? "1.0.2" : "1.0.1");
    if (failure === "save") assert.ok(!f.phases.includes("unload"));
    else assert.equal(f.coordinator.state.installedVersion, "1.0.2");
    assert.ok(!f.phases.includes("load:1.0.1"));
  }
});

test("startup checks once per application, without downloading the program or installing", async () => {
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
  const restarted = new UpdateCoordinator(enabled.remote.client, enabled.disk.store(), {} as UpdateHost,
    updateRuntime({}), "1.0.1", (state) => enabled.notices.push(state));
  restarted.startup(true); await restarted.check();
  assert.equal(enabled.notices.length, 2); enabled.disk.assertVersion("1.0.1");
});

test("automatic and manual checks share one notification and can remind again", async () => {
  const f = await coordinatorFixture();
  f.remote.metadata.body = "## Latest release";
  f.coordinator.startup(true);
  const first = f.coordinator.check();
  assert.equal(first, f.coordinator.check());
  await first;
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0]!.availableRelease, f.coordinator.state.availableRelease);
  assert.equal(f.notices[0]!.availableRelease!.notes, "## Latest release");
  assert.equal(f.notices[0]!.availableRelease!.version, f.coordinator.state.latestVersion);
  const previous = f.coordinator.state.availableRelease;
  await f.coordinator.check();
  assert.equal(f.notices.length, 2);
  assert.notEqual(f.coordinator.state.availableRelease, previous);
  f.disk.assertVersion("1.0.1"); assert.equal(f.disk.calls.length, 0);
});

test("the notification can install immediately after the check releases its task", async () => {
  let install: Promise<void> | undefined;
  const f = await coordinatorFixture(undefined, (state) => {
    if (state.availableRelease) install = f.coordinator.install(state.availableRelease);
  });
  const check = f.coordinator.check();
  await check;
  assert.ok(install);
  assert.notEqual(install, check);
  await install;
  assert.equal(f.coordinator.state.phase, "updated");
  f.disk.assertVersion("1.0.2"); f.disk.assertProtected();
});

test("rechecking invalidates the previous release, even for another result with the same version", async () => {
  const f = await coordinatorFixture();
  await f.coordinator.check();
  const previous = f.coordinator.state.availableRelease!;
  const check = f.coordinator.check();
  assert.equal(f.coordinator.state.availableRelease, undefined);
  assert.equal(f.coordinator.state.phase, "checking");
  await f.coordinator.install(previous); await check;
  const fresh = f.coordinator.state.availableRelease!;
  assert.notEqual(fresh, previous);
  await f.coordinator.install(previous);
  f.disk.assertVersion("1.0.1"); assert.equal(f.disk.calls.length, 0);
  assert.equal(f.coordinator.state.phase, "available");
  await f.coordinator.install(fresh);
  f.disk.assertVersion("1.0.2");
});

test("a disposed updater ignores a late check result", async () => {
  const remote = await channel(); const disk = new MemoryUpdateDisk(); const gate = deferred();
  const client = new ReleaseClient(async (url) => { await gate.promise; return remote.request(url); }, () => true, false);
  const updater = new UpdateCoordinator(client, disk.store(), {} as UpdateHost, updateRuntime({}), "1.0.1", () => assert.fail());
  const check = updater.check();
  updater.dispose(); gate.resolve(); await check;
  assert.equal(updater.state.availableRelease, undefined);
  await updater.install(); assert.equal(disk.calls.length, 0);
});

test("same and older releases never install, and failed checks do not notify", async () => {
  for (const installed of ["1.0.2", "2.0.0"]) {
    const remote = await channel(); const disk = new MemoryUpdateDisk(installed);
    const updater = new UpdateCoordinator(remote.client, disk.store(), {} as UpdateHost, updateRuntime({}), installed, () => assert.fail());
    await updater.check(); await updater.install(); assert.equal(updater.state.phase, "current"); assert.equal(disk.calls.length, 0);
    assert.equal(updater.state.availableRelease, undefined);
  }
  const f = await coordinatorFixture(); f.remote.setStatus(429);
  await f.coordinator.check(); assert.equal(f.notices.length, 0); assert.equal(f.coordinator.state.phase, "error");
  assert.equal(f.coordinator.state.availableRelease, undefined);
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
  assert.equal(new PluginReloadBridge({} as never).canReload(), false);
  assert.equal(bridge.canReload(), true);
});

test("updater wiring keeps HTTP opt-in, reload baselines and UI cleanup explicit", () => {
  const main = readFileSync("src/main.ts", "utf8"); const view = readFileSync("src/ui/mind-tree-view.ts", "utf8");
  assert.match(main, /updates\.startup\(this\.settings\.autoCheckUpdates\)/);
  assert.match(view, /updateRuntime\.baselines\?\.get/);
  assert.match(view, /updateActivity\.settle\(\)/);
  assert.match(view, /rootEl\.inert = true/);
  assert.match(readFileSync("src/ui/settings-pages/plugin-update-section.ts", "utf8"), /destroy\(\).*this\.unsubscribe\(\)/);
});

const systemError = (code: string) => Object.assign(new Error(code), { code });

test("only transient HTTP and transport failures retry, with two bounded delays", async () => {
  for (const failure of [408, 500, 503, 599, "offline"]) {
    const remote = await channel(); const delays: number[] = []; let attempts = 0;
    const client = new ReleaseClient(async (url) => {
      if (url.endsWith("/latest") && ++attempts < 3) {
        if (failure === "offline") throw new Error("connection reset");
        return { status: failure as number, arrayBuffer: buffer("") };
      }
      return remote.request(url);
    }, () => true, false, 15_000, 60_000, async (milliseconds) => { delays.push(milliseconds); });
    assert.equal((await client.latest()).version, "1.0.2");
    assert.equal(attempts, 3); assert.deepEqual(delays, [1000, 3000]);
  }
  for (const status of [400, 401, 403, 404, 429]) {
    let attempts = 0;
    const client = new ReleaseClient(async () => { attempts++; return { status, arrayBuffer: buffer("") }; },
      () => true, false, 5, 5, async () => assert.fail("permanent HTTP failure must not retry"));
    await assert.rejects(client.latest(), code("network")); assert.equal(attempts, 1);
  }
  let attempts = 0; const delays: number[] = [];
  const offline = new ReleaseClient(async () => { attempts++; throw systemError("ECONNRESET"); },
    () => true, false, 5, 5, async (milliseconds) => { delays.push(milliseconds); });
  await assert.rejects(offline.latest(), (error: unknown) => {
    assert.ok(error instanceof UpdateError);
    assert.equal(error.stage, "checking"); assert.ok(error.cause); return true;
  });
  assert.equal(attempts, 3); assert.deepEqual(delays, [1000, 3000]);
});

test("asset timeout has its own budget, preserves the target, and rejects late responses", async () => {
  const remote = await channel(); const gate = deferred<{ status: number; arrayBuffer: ArrayBuffer }>();
  const delays: number[] = []; let attempts = 0;
  const client = new ReleaseClient(async (url) => {
    if (url.endsWith("/manifest.json")) { attempts++; return gate.promise; }
    return remote.request(url);
  }, () => true, false, 100, 5, async (milliseconds) => { delays.push(milliseconds); });
  await assert.rejects(client.latest(), (error: unknown) => {
    assert.ok(error instanceof UpdateError);
    assert.equal(error.code, "timeout"); assert.equal(error.stage, "downloading");
    assert.equal(error.target, "manifest.json"); return true;
  });
  gate.resolve({ status: 200, arrayBuffer: buffer(remote.files["manifest.json"]) });
  assert.equal(attempts, 3); assert.deepEqual(delays, [1000, 3000]);
});

test("installation reuses the exact checked manifest and never retries invalid content", async () => {
  const remote = await channel(); const release = await remote.client.latest();
  const originalManifest = release.manifestText;
  remote.files["manifest.json"] = "changed after the check";
  assert.equal((await remote.client.download(release))["manifest.json"], originalManifest);
  assert.equal(remote.calls.filter((url) => url.endsWith("/manifest.json")).length, 1);
  remote.files["main.js"] = "<html>invalid download</html>";
  const calls = remote.calls.length;
  await assert.rejects(remote.client.download(release), code("integrity"));
  assert.equal(remote.calls.length - calls, 2); // CSS and one main.js request.
});

test("busy program writes retry at most three times and release their state for another update", async () => {
  for (const failures of [1, 2, 3]) {
    const f = await coordinatorFixture(); let attempts = 0;
    f.disk.fault = (operation, path) => {
      if (operation === "process" && path === DIRECTORY + "/main.js" && ++attempts <= failures) throw systemError("EBUSY");
    };
    await f.coordinator.check(); await f.coordinator.install();
    assert.equal(attempts, Math.min(failures + 1, 3));
    assert.deepEqual(f.disk.delays, failures === 1 ? [1000] : [1000, 3000]);
    f.disk.assertVersion(failures === 3 ? "1.0.1" : "1.0.2"); f.disk.assertProtected();
    if (failures === 3) {
      assert.equal(f.coordinator.state.error?.stage, "installing");
      assert.equal(f.coordinator.state.error?.target, DIRECTORY + "/main.js");
      f.disk.fault = undefined;
      await f.coordinator.check(); await f.coordinator.install();
      f.disk.assertVersion("1.0.2"); assert.equal(f.coordinator.state.phase, "updated");
    }
  }
});

test("permission and capacity failures do not retry or unload the running plugin", async () => {
  for (const errorCode of ["EACCES", "EPERM", "ENOSPC", "EDQUOT"]) {
    for (const stage of ["backup", "installing"]) {
      const f = await coordinatorFixture(); let attempts = 0;
      f.disk.fault = (operation, path) => {
        if (operation === "write" && (stage === "backup" ? path.endsWith("/before-main.js") : path === DIRECTORY + "/main.js")) {
          attempts++; throw systemError(errorCode);
        }
      };
      await f.coordinator.check(); await f.coordinator.install();
      assert.equal(attempts, 1); assert.deepEqual(f.disk.delays, []);
      f.disk.assertVersion("1.0.1"); f.disk.assertProtected();
      assert.ok(!f.phases.includes("unload")); assert.equal(f.runtime.frozen, false);
      assert.equal(f.coordinator.state.error?.stage, stage);
      assert.ok(f.coordinator.state.error?.cause);
    }
  }
});

test("write-then-error is reconciled by readback for backups, receipts and program files", async () => {
  for (const kind of ["backup", "receipt", "program"]) {
    const f = await coordinatorFixture(); let failures = 0;
    f.disk.fault = (operation, path) => {
      if (operation === "after-write" && !failures && (kind === "backup" ? path.endsWith("/before-main.js")
        : kind === "receipt" ? path.endsWith("/transaction.json") : path === DIRECTORY + "/main.js")) {
        failures++; throw systemError("EIO");
      }
    };
    await f.coordinator.check(); await f.coordinator.install();
    assert.equal(failures, 1); assert.deepEqual(f.disk.delays, []);
    assert.equal(f.coordinator.state.phase, "updated"); f.disk.assertVersion("1.0.2");
    assert.equal(f.disk.calls.filter((call) => call === "write:" + DIRECTORY + "/main.js").length, 1);
  }
});

test("cleanup failures after installation report success and are retried on startup", async () => {
  for (const endpoint of ["before-styles.css", "after-main.js", "transaction.json", "directory"]) {
    const f = await coordinatorFixture();
    f.disk.fault = (operation, path) => {
      if (endpoint === "directory" ? operation === "rmdir" : operation === "remove" && path.endsWith("/" + endpoint)) throw systemError("EBUSY");
    };
    await f.coordinator.check(); await f.coordinator.install();
    f.disk.assertVersion("1.0.2"); assert.equal(f.coordinator.state.phase, "updated");
    assert.equal(f.notices.at(-1)?.phase, "updated");
    assert.ok(f.disk.diagnostics.some((error) => error.stage === "cleanup"));
    await f.disk.store().recover(); // Still busy: startup must remain usable.
    f.disk.fault = undefined;
    await f.disk.store().recover();
    assert.equal(f.disk.pointer, null);
    assert.ok(![...f.disk.files.keys()].some((path) => path.includes("/.updates/")));
    assert.ok(![...f.disk.directories].some((path) => /\/device-A\/[^/]+$/.test(path)));
    f.disk.assertProtected();
  }
});

test("an interrupted abort cleanup never blocks another update or clears its newer pointer", async () => {
  const disk = new MemoryUpdateDisk(); const old = disk.store();
  await old.stage(payload("1.0.2"), "1.0.1", "1.0.2");
  const oldPath = old.backupPath;
  disk.fault = (operation, path) => { if (operation === "remove" && path === oldPath + "/after-main.js") throw systemError("EBUSY"); };
  await assert.rejects(old.cleanup());
  assert.equal(JSON.parse(disk.files.get(oldPath + "/transaction.json")!).phase, "rolled-back");
  assert.equal((await disk.store().recover())?.rolledBack, false);
  const next = disk.store(); await next.stage(payload("1.0.2"), "1.0.1", "1.0.2");
  const pointer = disk.pointer;
  disk.fault = undefined; await old.cleanup();
  assert.equal(disk.pointer, pointer);
  await next.install(); await next.commit(); await next.cleanup();
  disk.assertVersion("1.0.2"); disk.assertProtected();
});

test("legacy unfinished receipts recover intact old/new files even with missing backups", async () => {
  for (const installed of [false, true]) {
    const disk = new MemoryUpdateDisk(); const store = disk.store();
    await store.stage(payload("1.0.2"), "1.0.1", "1.0.2");
    if (installed) await store.install();
    const receiptPath = store.backupPath + "/transaction.json";
    const receipt = JSON.parse(disk.files.get(receiptPath)!);
    receipt.phase = installed ? "writing" : "prepared"; disk.files.set(receiptPath, JSON.stringify(receipt));
    for (const name of UPDATE_FILES) for (const side of ["before", "after"]) disk.files.delete(store.backupPath + "/" + side + "-" + name);
    const result = await disk.store().recover();
    assert.equal(result?.version, installed ? "1.0.2" : "1.0.1");
    assert.equal(result?.rolledBack, false); assert.equal(disk.pointer, null);
    disk.assertVersion(installed ? "1.0.2" : "1.0.1");
  }
});

test("a partial rollback is recoverable, while foreign program bytes are never replaced", async () => {
  const disk = new MemoryUpdateDisk(); const store = disk.store();
  await store.stage(payload("1.0.2"), "1.0.1", "1.0.2"); await store.install();
  disk.failProcess = "main.js"; await assert.rejects(store.rollback());
  assert.equal(JSON.parse(disk.files.get(DIRECTORY + "/manifest.json")!).version, "1.0.1");
  assert.equal((await disk.store().recover())?.rolledBack, true); disk.assertVersion("1.0.1");
  await store.stage(payload("1.0.2"), "1.0.1", "1.0.2");
  disk.files.set(DIRECTORY + "/main.js", "external change");
  const snapshot = UPDATE_FILES.map((name) => disk.files.get(DIRECTORY + "/" + name));
  await assert.rejects(disk.store().recover(), code("recovery"));
  assert.deepEqual(UPDATE_FILES.map((name) => disk.files.get(DIRECTORY + "/" + name)), snapshot);
});

test("a pointer save failure after persistence aborts cleanly and permits retry", async () => {
  const disk = new MemoryUpdateDisk(); let fail = true;
  const store = new UpdateStore(disk, { load: () => disk.pointer, save(value) {
    disk.pointer = value;
    if (value && fail) { fail = false; throw systemError("EDQUOT"); }
  } }, DIRECTORY, "device-A", { diagnose: (error) => disk.diagnostics.push(error) });
  await assert.rejects(store.stage(payload("1.0.2"), "1.0.1", "1.0.2"), code("storage"));
  disk.assertVersion("1.0.1"); assert.equal(disk.pointer, null);
  await store.stage(payload("1.0.2"), "1.0.1", "1.0.2"); await store.install(); await store.commit(); await store.cleanup();
  disk.assertVersion("1.0.2");
});

test("terminal receipts never revert a newer program or clean another device's files", async () => {
  const disk = new MemoryUpdateDisk(); const store = disk.store();
  await store.stage(payload("1.0.2"), "1.0.1", "1.0.2"); await store.install(); await store.commit();
  for (const name of UPDATE_FILES) disk.files.set(DIRECTORY + "/" + name, payload("1.0.3")[name]);
  const foreign = DIRECTORY + "/.updates/other-device/transaction.json"; disk.files.set(foreign, "foreign");
  await disk.store().recover(); disk.assertVersion("1.0.3"); assert.equal(disk.files.get(foreign), "foreign");
});

test("pending restart blocks repeat installation and is cleared by a ready instance of the installed version", async () => {
  const f = await coordinatorFixture("unsupported");
  await f.coordinator.check(); const release = f.coordinator.state.availableRelease!;
  await f.coordinator.install(release);
  assert.equal(f.coordinator.state.phase, "restart-required");
  const writes = f.disk.calls.length, requests = f.remote.calls.length;
  await f.coordinator.check(); await f.coordinator.install(release);
  assert.equal(f.disk.calls.length, writes); assert.equal(f.remote.calls.length, requests);
  f.coordinator.dispose(); assert.equal(f.runtime.restartListeners?.size, 0);
  const loaded = new UpdateCoordinator(f.remote.client, f.disk.store(), f.host, f.runtime, "1.0.2", () => {});
  assert.equal(loaded.state.installedVersion, "1.0.2"); loaded.markReady();
  assert.equal(loaded.state.phase, "idle"); assert.equal(loaded.state.currentVersion, "1.0.2");
  assert.equal(f.runtime.pendingRestartVersion, undefined);
  loaded.dispose(); assert.equal(f.runtime.restartListeners?.size, 0);
});

test("a new plugin instance sees restart status when restoring its views fails after hot reload", async () => {
  const f = await coordinatorFixture("restore");
  const prepare = f.host.prepare.bind(f.host);
  let loaded: UpdateCoordinator | undefined;
  f.host.prepare = async () => {
    const prepared = await prepare();
    return { ...prepared, async unload() { await prepared.unload(); f.coordinator.dispose(); },
      async load(version) {
        await prepared.load(version);
        loaded = new UpdateCoordinator(f.remote.client, f.disk.store(), f.host, f.runtime, version, () => {});
      } };
  };
  await f.coordinator.check(); await f.coordinator.install();
  assert.equal(loaded?.state.phase, "restart-required");
  assert.equal(loaded?.state.currentVersion, "1.0.2"); assert.equal(loaded?.state.installedVersion, "1.0.2");
  assert.equal(f.runtime.restartListeners?.size, 1); loaded?.dispose();
});
