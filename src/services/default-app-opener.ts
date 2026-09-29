import type { FileResourceRef, ResourceRef } from "../types";

/** A deliberately small interface: never execute a command string or use file URLs. */
export interface DefaultAppShell {
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}

export type DefaultAppOpenErrorCode =
  | "desktop-only" | "target-changed" | "file-not-found" | "unsupported-adapter"
  | "invalid-url" | "unsafe-url" | "open-failed";

export class DefaultAppOpenError extends Error {
  constructor(readonly code: DefaultAppOpenErrorCode, readonly detail = "") {
    super(detail || code);
    this.name = "DefaultAppOpenError";
  }
}

export interface DefaultAppOpenPorts<T> {
  isDesktopApp(): boolean;
  loadShell(): DefaultAppShell | Promise<DefaultAppShell>;
  resolveFile(reference: Readonly<FileResourceRef>): T | undefined | Promise<T | undefined>;
  getFullPath(file: T): string | undefined;
}

/**
 * This function is not invoked at module evaluation or view creation. Mobile
 * keeps loading the same plugin bundle without ever requiring Electron.
 */
export function loadDesktopShell(): DefaultAppShell {
  const electron = require("electron") as { shell?: DefaultAppShell };
  if (typeof electron.shell?.openPath !== "function" || typeof electron.shell.openExternal !== "function") {
    throw new DefaultAppOpenError("open-failed", "The desktop shell is unavailable.");
  }
  return electron.shell;
}

/** Read-only opening, isolated from document mutation, history and viewport code. */
export class DefaultAppOpener<T> {
  constructor(private readonly ports: DefaultAppOpenPorts<T>) {}

  async open(reference: Readonly<ResourceRef>, isTargetCurrent: () => boolean): Promise<void> {
    if (!this.ports.isDesktopApp()) throw new DefaultAppOpenError("desktop-only");
    const requireCurrent = (): void => {
      if (!isTargetCurrent()) throw new DefaultAppOpenError("target-changed");
    };
    requireCurrent();
    let url: string | undefined;
    if (reference.type === "url") {
      let parsed: URL;
      try { parsed = new URL(reference.url); }
      catch { throw new DefaultAppOpenError("invalid-url"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DefaultAppOpenError("unsafe-url");
      url = parsed.toString();
    }

    try {
      const shell = await this.ports.loadShell();
      requireCurrent();
      if (reference.type === "url") {
        await shell.openExternal(url!);
        return;
      }
      // Resolve after the asynchronous boundary so moves/renames use the live
      // TFile, never the stale pathHint stored when the context menu opened.
      const file = await this.ports.resolveFile(reference);
      if (!file) throw new DefaultAppOpenError("file-not-found", reference.pathHint);
      const path = this.ports.getFullPath(file);
      if (!path) throw new DefaultAppOpenError("unsupported-adapter");
      requireCurrent();
      const errorMessage = await shell.openPath(path);
      // Electron reports many failures as a resolved string, not a rejection.
      if (errorMessage) throw new DefaultAppOpenError("open-failed", errorMessage);
    } catch (error) {
      if (error instanceof DefaultAppOpenError) throw error;
      throw new DefaultAppOpenError("open-failed", error instanceof Error ? error.message : String(error));
    }
  }
}
