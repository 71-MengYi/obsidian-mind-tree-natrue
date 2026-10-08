/** Fixed distribution channel. Remote metadata never supplies local paths. */
export const UPDATE_REPOSITORY = "71-MengYi/obsidian-mind-tree-natrue";
export const UPDATE_PLUGIN_ID = "mind-tree-nature";
export const UPDATE_FILES = ["styles.css", "main.js", "manifest.json"] as const;
export type UpdateFile = typeof UPDATE_FILES[number];
export const UPDATE_LIMITS: Record<UpdateFile, number> = {
  "manifest.json": 64 * 1024, "main.js": 10 * 1024 * 1024, "styles.css": 2 * 1024 * 1024
};

export type UpdateErrorCode = "network" | "timeout" | "release" | "version" | "identity" | "compatibility"
  | "asset" | "integrity" | "crypto" | "reload" | "busy" | "save" | "changed" | "storage" | "recovery" | "cancelled";
export type UpdateStage = "checking" | "downloading" | "preparing" | "backup" | "installing" | "rollback" | "reloading" | "cleanup" | "recovery";
export class UpdateError extends Error {
  readonly stage?: UpdateStage;
  readonly target?: string;
  constructor(readonly code: UpdateErrorCode, readonly detail = "", options?: { stage?: UpdateStage; cause?: unknown; target?: string }) {
    super(code + ": " + detail, options);
    this.stage = options?.stage;
    this.target = options?.target;
  }
}
export function updateFailure(error: unknown, stage: UpdateStage, detail = "", code: UpdateErrorCode = "storage"): UpdateError {
  return new UpdateError(error instanceof UpdateError ? error.code : code,
    error instanceof UpdateError && error.detail ? error.detail : detail,
    { stage: error instanceof UpdateError && error.stage ? error.stage : stage, cause: error,
      target: error instanceof UpdateError && error.target ? error.target : detail || undefined });
}
export type UpdateDelay = (milliseconds: number) => Promise<void>;
export const updateDelay: UpdateDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const UPDATE_RETRY_DELAYS = [1_000, 3_000] as const;

export interface UpdateManifest {
  id: string; version: string; minAppVersion: string; isDesktopOnly: boolean;
}
export interface ReleaseAsset {
  readonly name: UpdateFile; readonly url: string; readonly size: number; readonly hash: string;
}
export interface PluginRelease {
  readonly id: number; readonly version: string;
  readonly notes: string;
  readonly assets: Readonly<Record<UpdateFile, ReleaseAsset>>;
  readonly manifest: Readonly<UpdateManifest>;
  readonly manifestText: string;
}
export type UpdatePayload = Record<UpdateFile, string>;
export interface UpdateResponse { status: number; arrayBuffer: ArrayBuffer }
export type UpdateRequest = (url: string) => Promise<UpdateResponse>;

/** Strict three-component versions avoid lexicographic sorting and coercion. */
export function versionParts(value: unknown): number[] {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new UpdateError("version", String(value));
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new UpdateError("version", value);
  return parts;
}
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpdateError("release");
  return value as Record<string, unknown>;
}
export function readUpdateManifest(source: string): UpdateManifest {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(source)); }
  catch (error) { throw new UpdateError("asset", "manifest.json", { cause: error }); }
  if (raw.id !== UPDATE_PLUGIN_ID) throw new UpdateError("identity");
  versionParts(raw.version); versionParts(raw.minAppVersion);
  if (typeof raw.isDesktopOnly !== "boolean" || typeof raw.name !== "string" || !raw.name.trim()
    || typeof raw.author !== "string" || typeof raw.description !== "string") throw new UpdateError("asset", "manifest.json");
  return raw as unknown as UpdateManifest;
}

/** Uses Web Crypto on desktop and WKWebView; never loads Node/Electron. */
export async function sha256(value: string | ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new UpdateError("crypto");
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reject late results even on hosts whose HTTP API cannot cancel a request. */
export async function updateTimeout<T>(task: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UpdateError("timeout")), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export class ReleaseClient {
  constructor(private readonly request: UpdateRequest, private readonly compatible: (version: string) => boolean,
    private readonly mobile: boolean, private readonly timeoutMs = 15_000,
    private readonly assetTimeoutMs = 60_000, private readonly delay: UpdateDelay = updateDelay) {}

  private async get(url: string, limit: number, file?: UpdateFile): Promise<ArrayBuffer> {
    for (let attempt = 0; ; attempt++) {
      let retryable = false;
      try {
        let response: UpdateResponse;
        try { response = await updateTimeout(this.request(url), file ? this.assetTimeoutMs : this.timeoutMs); }
        catch (error) { retryable = true; throw error instanceof UpdateError ? error : new UpdateError("network", "", { cause: error }); }
        if (response.status !== 200) {
          retryable = response.status === 408 || (response.status >= 500 && response.status <= 599);
          throw new UpdateError("network", "HTTP " + response.status);
        }
        if (response.arrayBuffer.byteLength > limit) throw new UpdateError("asset", file);
        return response.arrayBuffer;
      } catch (error) {
        if (!retryable || attempt >= UPDATE_RETRY_DELAYS.length) {
          throw updateFailure(error, file ? "downloading" : "checking", file, "network");
        }
        await this.delay(UPDATE_RETRY_DELAYS[attempt]!);
      }
    }
  }

  async latest(): Promise<PluginRelease> {
    const bytes = await this.get(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, 1024 * 1024);
    let raw: Record<string, unknown>;
    try { raw = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch (error) { throw new UpdateError("release", "", { cause: error }); }
    if (!Number.isSafeInteger(raw.id) || Number(raw.id) <= 0 || raw.draft !== false || raw.prerelease !== false) {
      throw new UpdateError("release");
    }
    versionParts(raw.tag_name);
    const version = raw.tag_name as string;
    if (!Array.isArray(raw.assets)) throw new UpdateError("asset");
    const assets = {} as Record<UpdateFile, ReleaseAsset>;
    for (const name of UPDATE_FILES) {
      const matches = raw.assets.filter((value) => value && typeof value === "object" && value.name === name);
      if (matches.length !== 1) throw new UpdateError("asset", name);
      const asset = record(matches[0]);
      const url = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${version}/${name}`;
      if (asset.browser_download_url !== url || asset.state !== "uploaded" || !Number.isSafeInteger(asset.size)
        || Number(asset.size) < (name === "styles.css" ? 0 : 1) || Number(asset.size) > UPDATE_LIMITS[name]
        || typeof asset.digest !== "string" || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) {
        throw new UpdateError("asset", name);
      }
      assets[name] = { name, url, size: Number(asset.size), hash: asset.digest.slice(7).toLowerCase() };
    }
    const manifestText = await this.downloadAsset(assets["manifest.json"]);
    const manifest = readUpdateManifest(manifestText);
    this.validateManifest(manifest, version);
    const notes = typeof raw.body === "string" && raw.body.trim() ? raw.body : "";
    return { id: Number(raw.id), version, notes, assets, manifest, manifestText };
  }

  private validateManifest(manifest: UpdateManifest, version: string): void {
    if (manifest.version !== version) throw new UpdateError("version", `${version} / ${manifest.version}`);
    if (!this.compatible(manifest.minAppVersion) || (this.mobile && manifest.isDesktopOnly)) {
      throw new UpdateError("compatibility", manifest.minAppVersion);
    }
  }

  private async downloadAsset(asset: ReleaseAsset): Promise<string> {
    const bytes = await this.get(asset.url, UPDATE_LIMITS[asset.name], asset.name);
    if (bytes.byteLength !== asset.size || await sha256(bytes) !== asset.hash) throw new UpdateError("integrity", asset.name);
    // Byte-for-byte UTF-8 round trips are essential for digest verification on disk.
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) { throw new UpdateError("asset", asset.name, { cause: error }); }
    return text;
  }

  async download(release: PluginRelease): Promise<UpdatePayload> {
    const result = { "manifest.json": release.manifestText } as UpdatePayload;
    // Sequential transfers keep mobile peak memory bounded. Nothing is installed here.
    for (const name of UPDATE_FILES) if (name !== "manifest.json") result[name] = await this.downloadAsset(release.assets[name]);
    return result;
  }
}
