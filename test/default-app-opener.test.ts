import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyDocument, getNode } from "../src/domain/tree";
import { DocumentSession } from "../src/services/document-session";
import { DefaultAppOpenError, DefaultAppOpener, type DefaultAppOpenPorts, type DefaultAppShell } from "../src/services/default-app-opener";
import { isResourceTargetCurrent, type ResourceTarget } from "../src/ui/association-target";
import type { FileResourceRef, ResourceRef } from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

function fixture() {
  const files = new Map<string, { path: string }>();
  const paths: string[] = [];
  const urls: string[] = [];
  let loads = 0;
  const shell: DefaultAppShell = {
    openPath: async (path) => { paths.push(path); return ""; },
    openExternal: async (url) => { urls.push(url); }
  };
  const ports: DefaultAppOpenPorts<{ path: string }> = {
    isDesktopApp: () => true,
    loadShell: () => { loads++; return shell; },
    resolveFile: (reference) => files.get(reference.resourceId),
    getFullPath: (file) => `D:\\仓库 Folder\\${file.path.replaceAll("/", "\\")}`
  };
  const opener = new DefaultAppOpener(ports);
  return { files, paths, urls, shell, ports, opener, get loads() { return loads; } };
}

const fileReference: FileResourceRef = { type: "file", resourceId: "stable-id", pathHint: "old/path.pdf", fileKind: "attachment" };
const webReference: ResourceRef = { type: "url", url: "HTTPS://EXAMPLE.COM/学习?q=one%20two&next=three#part" };

function hasCode(code: DefaultAppOpenError["code"]) {
  return (error: unknown): boolean => error instanceof DefaultAppOpenError && error.code === code;
}

test("default-app opener loads no desktop code until explicitly invoked and rejects mobile before loading", async () => {
  const f = fixture();
  assert.equal(f.loads, 0);
  f.ports.isDesktopApp = () => false;
  for (const resource of [fileReference, webReference]) {
    await assert.rejects(f.opener.open(resource, () => true), hasCode("desktop-only"));
  }
  assert.equal(f.loads, 0);
  assert.deepEqual(f.paths, []);
  assert.deepEqual(f.urls, []);
});

test("default-app opening resolves every vault file kind by identity and passes the live full path literally", async () => {
  for (const [path, fileKind] of [
    ["Notes/新 笔记.md", "note"], ["Notes/Tree.mtn.md", "note"], ["Notes/绘图.excalidraw.md", "note"],
    ["Assets/图片@Ab123.png", "image"], ["Assets/PDF%aB123.pdf", "attachment"],
    ["Assets/A.canvas", "attachment"], ["Assets/A.zip", "attachment"], ["Assets/README", "attachment"]
  ] as const) {
    const f = fixture();
    const reference = { ...fileReference, fileKind };
    f.files.set(reference.resourceId, { path });
    await f.opener.open(reference, () => true);
    assert.deepEqual(f.paths, [`D:\\仓库 Folder\\${path.replaceAll("/", "\\")}`]);
    assert.deepEqual(f.urls, []);
    assert.equal(reference.pathHint, "old/path.pdf");
  }
});

test("native paths containing spaces and shell metacharacters are forwarded as a single argument", async () => {
  for (const path of ["C:\\Notes & files\\学习 @ 1.pdf", "/Users/user/Notes/$(text); a'b.md", "/home/user/库/one two.pdf"]) {
    const f = fixture();
    f.files.set(fileReference.resourceId, { path: "A.pdf" });
    f.ports.getFullPath = () => path;
    await f.opener.open(fileReference, () => true);
    assert.deepEqual(f.paths, [path]);
    assert.deepEqual(f.urls, []);
  }
});

test("HTTP/HTTPS use the default browser without file resolution or protocol rewriting", async () => {
  const f = fixture();
  f.ports.resolveFile = () => { throw new Error("A web resource must not resolve a file"); };
  f.ports.getFullPath = () => { throw new Error("A web resource must not ask for a path"); };
  await f.opener.open(webReference, () => true);
  await f.opener.open({ type: "url", url: "http://example.org/?a=1&b=2" }, () => true);
  assert.deepEqual(f.urls, [new URL(webReference.url).toString(), "http://example.org/?a=1&b=2"]);
  assert.deepEqual(f.paths, []);
});

test("malformed and non-HTTP URLs are rejected before loading the desktop shell", async () => {
  const f = fixture();
  for (const url of ["", "not a URL", "https://", "http://[invalid"]) {
    await assert.rejects(f.opener.open({ type: "url", url }, () => true), hasCode("invalid-url"));
  }
  for (const url of ["javascript:alert(1)", "data:text/html,content", "file:///etc/passwd", "ftp://example.com", "mailto:a@example.com", "obsidian://open"]) {
    await assert.rejects(f.opener.open({ type: "url", url }, () => true), hasCode("unsafe-url"));
  }
  assert.equal(f.loads, 0);
  assert.deepEqual(f.urls, []);
});

test("missing files and unsupported adapters do not fall back to stale paths or browser opening", async () => {
  const f = fixture();
  await assert.rejects(f.opener.open(fileReference, () => true), (error) => {
    assert.ok(error instanceof DefaultAppOpenError);
    assert.equal(error.code, "file-not-found");
    assert.equal(error.detail, fileReference.pathHint);
    return true;
  });
  f.files.set(fileReference.resourceId, { path: "New.pdf" });
  f.ports.getFullPath = () => undefined;
  await assert.rejects(f.opener.open(fileReference, () => true), hasCode("unsupported-adapter"));
  assert.deepEqual(f.paths, []);
  assert.deepEqual(f.urls, []);
});

test("openPath's resolved error string and shell exceptions are reported instead of treated as success", async () => {
  const f = fixture();
  f.files.set(fileReference.resourceId, { path: "New.pdf" });
  f.shell.openPath = async () => "No application is associated with this file";
  await assert.rejects(f.opener.open(fileReference, () => true), (error) => {
    assert.ok(error instanceof DefaultAppOpenError);
    assert.equal(error.code, "open-failed");
    assert.match(error.detail, /No application/);
    return true;
  });
  f.shell.openPath = async () => { throw new Error("Access denied"); };
  await assert.rejects(f.opener.open(fileReference, () => true), hasCode("open-failed"));
  f.shell.openExternal = async () => { throw new Error("Browser unavailable"); };
  await assert.rejects(f.opener.open(webReference, () => true), hasCode("open-failed"));
  f.ports.loadShell = () => { throw new Error("Electron unavailable"); };
  await assert.rejects(f.opener.open(webReference, () => true), hasCode("open-failed"));
  assert.deepEqual(f.paths, []);
  assert.deepEqual(f.urls, []);
});

test("a file moved while the shell loads opens from its new canonical path", async () => {
  const f = fixture();
  const ready = deferred<DefaultAppShell>();
  const file = { path: "Before.pdf" };
  f.files.set(fileReference.resourceId, file);
  f.ports.loadShell = () => ready.promise;
  const opening = f.opener.open(fileReference, () => true);
  file.path = "Moved/After.pdf";
  ready.resolve(f.shell);
  await opening;
  assert.deepEqual(f.paths, ["D:\\仓库 Folder\\Moved\\After.pdf"]);
});

test("a stale initial target or a switched/relinked/deleted target during shell loading never opens", async () => {
  const initial = fixture();
  await assert.rejects(initial.opener.open(fileReference, () => false), hasCode("target-changed"));
  assert.equal(initial.loads, 0);
  for (const change of ["switch", "delete", "relink", "unlink"]) {
    const f = fixture();
    const document = createEmptyDocument("Tree");
    getNode(document, document.rootId).resource = { ...fileReference };
    let token = "original";
    const target: ResourceTarget = { documentSessionToken: token, nodeId: document.rootId, resource: { ...fileReference } };
    const ready = deferred<DefaultAppShell>();
    f.ports.loadShell = () => ready.promise;
    f.files.set(fileReference.resourceId, { path: "A.pdf" });
    const opening = f.opener.open(fileReference, () => isResourceTargetCurrent(target, token, document));
    if (change === "switch") token = "new-file";
    if (change === "delete") delete document.nodes[document.rootId];
    if (change === "relink") getNode(document, document.rootId).resource = { type: "url", url: "https://example.com" };
    if (change === "unlink") delete getNode(document, document.rootId).resource;
    ready.resolve(f.shell);
    await assert.rejects(opening, hasCode("target-changed"));
    assert.deepEqual(f.paths, []);
    assert.deepEqual(f.urls, []);
  }
});

test("opening leaves document, selection, viewport, dirty state and undo history untouched", async () => {
  const f = fixture();
  const document = createEmptyDocument("Tree");
  getNode(document, document.rootId).resource = Object.freeze({ ...fileReference });
  const before = JSON.stringify(document);
  const session = new DocumentSession();
  session.load("baseline");
  const viewport = { x: 30, y: -22, zoom: 0.8 };
  const selection = [document.rootId];
  f.files.set(fileReference.resourceId, { path: "File.pdf" });
  await f.opener.open(document.nodes[document.rootId]!.resource!, () => true);
  assert.equal(JSON.stringify(document), before);
  assert.equal(session.dirty, false);
  assert.equal(session.canUndo, false);
  assert.equal(session.canRedo, false);
  assert.deepEqual(viewport, { x: 30, y: -22, zoom: 0.8 });
  assert.deepEqual(selection, [document.rootId]);
});
