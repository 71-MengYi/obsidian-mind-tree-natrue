/**
 * OAuth sign-in for the model-provider settings.
 *
 * Credentials are device-local secrets: this module never touches `data.json`
 * and never imports Obsidian. Everything the outside world owns — HTTP, secret
 * storage, opening a browser window, and (optionally) the loopback callback
 * server — arrives through the injected `AiOAuthHost`.
 *
 * The flow shapes and public client constants are ported from obsidian-yolo
 * (MIT), which in turn follows the Codex / Gemini CLI / VS Code Copilot
 * clients. Those clients are the only ones the providers' OAuth servers accept.
 *
 * The manager is deliberately synchronous where the UI needs it: `status()`
 * and `credential()` read the stored secret directly, while `begin()` /
 * `complete()` own the network conversation.
 */
import {
  MAX_AI_SECRET_LENGTH,
  type AiConnectStart,
  type AiOAuthAuthorization,
  type AiOAuthCredential,
  type AiOAuthStatus,
  type AiProviderConfig
} from "./contracts";
import { presetOAuth } from "./presets";

/* -------------------------------------------------------------------------- */
/* OAuth client constants (ported from obsidian-yolo, MIT)                     */
/* -------------------------------------------------------------------------- */

/** Codex CLI's OAuth app; the device and browser endpoints only accept it. */
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_DEVICE_VERIFICATION_URI = `${CHATGPT_ISSUER}/codex/device`;
const CHATGPT_DEVICE_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
const CHATGPT_BROWSER_SCOPE = "openid profile email offline_access";
/** Keep in sync with the Codex OAuth redirect URI allow-list. */
const CHATGPT_BROWSER_PORTS = [1455, 1457] as const;
const CHATGPT_BROWSER_CALLBACK_PATH = "/auth/callback";
const CHATGPT_BROWSER_REDIRECT_HOST = "localhost";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
].join(" ");
const GEMINI_CALLBACK_PORT = 8085;
const GEMINI_CALLBACK_PATH = "/oauth2callback";
const GEMINI_CALLBACK_HOST = "127.0.0.1";

/** VS Code Copilot's OAuth app; the only client id `copilot_internal` accepts. */
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_SCOPE = "read:user";
const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
const COPILOT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_DEFAULT_VERIFICATION_URI = "https://github.com/login/device";
const COPILOT_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const COPILOT_DEFAULT_POLL_INTERVAL_MS = 5_000;
const COPILOT_SLOW_DOWN_INCREMENT_MS = 5_000;
const COPILOT_DEVICE_CODE_TTL_MS = 900_000;
/** Re-exchange once the Copilot token has less than this left. */
const COPILOT_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "Editor-Version": "vscode/1.120.0",
  "Editor-Plugin-Version": "copilot-chat/0.70.0",
  "User-Agent": "GitHubCopilotChat/0.70.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2026-08-01"
};

const OAUTH_USER_AGENT = "mind-tree-nature/oauth";
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
/** Hard stop so a broken server cannot keep a flow polling forever. */
const DEVICE_AUTH_MAX_POLLS = 180;
const BROWSER_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_STORAGE_PREFIX = "ai-oauth:";

/* -------------------------------------------------------------------------- */
/* Injectable ports                                                            */
/* -------------------------------------------------------------------------- */

export interface AiHttpResponse {
  status: number;
  text: string;
  json?: unknown;
}

export interface AiHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Every outbound request goes through this port; the host owns `requestUrl`. */
export interface AiHttpPort {
  request(request: AiHttpRequest): Promise<AiHttpResponse>;
}

/** Device-local key/value storage; the host scopes keys by plugin id. */
export interface AiSecretStorage {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
  remove(key: string): void;
}

/** What the loopback server saw on the redirect. */
export interface AiOAuthCallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** A one-shot loopback callback listener, owned by the flow until it closes. */
export interface AiOAuthCallbackServer {
  /** The exact `redirect_uri` the authorization URL must carry. */
  readonly redirectUri: string;
  /** Resolves on the redirect; `close()` resolves a pending wait as cancelled. */
  wait(): Promise<AiOAuthCallbackResult>;
  close(): void;
}

export interface AiOAuthCallbackServerOptions {
  /** Ports to try in order; the first free one wins. */
  ports: readonly number[];
  path: string;
  bindHost: string;
  /** Host name the redirect URI advertises (may differ from the bind host). */
  redirectHost: string;
}

export type AiOAuthCallbackServerFactory = (
  options: AiOAuthCallbackServerOptions
) => Promise<AiOAuthCallbackServer>;

export interface AiOAuthHost {
  http: AiHttpPort;
  storage: AiSecretStorage;
  openExternal(url: string): void;
  isDesktop(): boolean;
  logger?(message: string): void;
  /**
   * Optional loopback server factory. The default binds a `node:http` server
   * through the desktop runtime's require; tests inject a fake so no socket is
   * opened.
   */
  callbackServer?: AiOAuthCallbackServerFactory;
}

/** Optional knobs the settings UI does not need but the host may pass. */
export interface AiOAuthBeginOptions {
  /** ChatGPT defaults to its device flow; `"browser"` opts into PKCE. */
  mode?: "device" | "browser";
  /**
   * A redirect URI the caller already serves. When set, no loopback server is
   * started and `complete()` expects the caller to pass `code`.
   */
  redirectUri?: string;
}

export type AiOAuthErrorCode =
  | "unsupported"
  | "not-desktop"
  | "network"
  | "invalid-response"
  | "denied"
  | "expired"
  | "cancelled"
  | "invalid-token"
  | "storage";

export class AiOAuthError extends Error {
  constructor(
    readonly code: AiOAuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AiOAuthError";
  }
}

/* -------------------------------------------------------------------------- */
/* Little helpers                                                              */
/* -------------------------------------------------------------------------- */

interface PendingOAuthFlow {
  kind: "chatgpt-device" | "chatgpt-browser" | "gemini-browser" | "copilot-device";
  userCode?: string;
  verificationUri?: string;
  intervalMs?: number;
  deviceAuthId?: string;
  deviceCode?: string;
  codeVerifier?: string;
  state?: string;
  redirectUri?: string;
  authorizationUrl?: string;
  expiresAt?: number;
  callback?: AiOAuthCallbackServer;
  cancelled?: boolean;
  wake?: () => void;
}

interface PkceCodes {
  verifier: string;
  challenge: string;
}

const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jsonObject(response: AiHttpResponse): Record<string, unknown> | undefined {
  const value = response.json;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof response.text !== "string" || response.text.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(response.text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function responseSuffix(response: AiHttpResponse): string {
  const text = typeof response.text === "string" ? response.text.trim() : "";
  return text === "" ? "" : ` - ${text.slice(0, 300)}`;
}

function secondsToMs(value: unknown, fallbackMs: number): number {
  const seconds = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(Math.max(Math.round(seconds), 1), 3600) * 1000;
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) {
    result += PKCE_ALPHABET[byte % PKCE_ALPHABET.length] ?? "A";
  }
  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePkce(): Promise<PkceCodes> {
  const verifier = randomToken(43);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function parseJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed: unknown = JSON.parse(globalThis.atob(padded));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractChatGPTAccountId(accessToken: string, idToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const claims = parseJwtPayload(token);
    if (!claims) continue;

    const direct = textValue(claims["chatgpt_account_id"]);
    if (direct) return direct;

    const auth = claims["https://api.openai.com/auth"];
    if (auth !== null && typeof auth === "object") {
      const nested = textValue((auth as Record<string, unknown>)["chatgpt_account_id"]);
      if (nested) return nested;
    }

    const organizations = claims["organizations"];
    if (Array.isArray(organizations)) {
      const first = organizations[0];
      if (first !== null && typeof first === "object") {
        const id = textValue((first as Record<string, unknown>)["id"]);
        if (id) return id;
      }
    }
  }
  return undefined;
}

function connectedStatus(credential: AiOAuthCredential): AiOAuthStatus {
  const account = credential.email ?? credential.accountId;
  return {
    state: "connected",
    ...(account ? { account } : {}),
    ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {})
  };
}

function pendingStatus(flow: PendingOAuthFlow): AiOAuthStatus {
  return {
    state: "pending",
    userCode: flow.userCode ?? "",
    verificationUri: flow.verificationUri ?? flow.authorizationUrl ?? ""
  };
}

function normalizeCredential(value: unknown): AiOAuthCredential | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const accessToken = textValue(record["accessToken"]);
  if (!accessToken) return undefined;
  return {
    accessToken,
    updatedAt: numberValue(record["updatedAt"]) ?? Date.now(),
    ...(textValue(record["refreshToken"]) ? { refreshToken: textValue(record["refreshToken"]) } : {}),
    ...(numberValue(record["expiresAt"]) !== undefined ? { expiresAt: numberValue(record["expiresAt"]) } : {}),
    ...(textValue(record["accountId"]) ? { accountId: textValue(record["accountId"]) } : {}),
    ...(textValue(record["email"]) ? { email: textValue(record["email"]) } : {}),
    ...(textValue(record["projectId"]) ? { projectId: textValue(record["projectId"]) } : {}),
    ...(textValue(record["managedProjectId"]) ? { managedProjectId: textValue(record["managedProjectId"]) } : {}),
    ...(textValue(record["copilotToken"]) ? { copilotToken: textValue(record["copilotToken"]) } : {}),
    ...(numberValue(record["copilotExpiresAt"]) !== undefined
      ? { copilotExpiresAt: numberValue(record["copilotExpiresAt"]) }
      : {}),
    ...(textValue(record["copilotApiBaseUrl"]) ? { copilotApiBaseUrl: textValue(record["copilotApiBaseUrl"]) } : {})
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Desktop loopback callback server                                           */
/* -------------------------------------------------------------------------- */

type NodeRequire = (specifier: string) => unknown;

function desktopRequire(): NodeRequire {
  const globalRequire = (globalThis as { require?: NodeRequire }).require;
  if (typeof globalRequire === "function") return globalRequire;
  const indirect = Function(
    'return typeof require === "function" ? require : undefined'
  )() as NodeRequire | undefined;
  if (typeof indirect === "function") return indirect;
  throw new AiOAuthError(
    "unsupported",
    "Node.js modules are unavailable in this Obsidian runtime."
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function respondHtml(
  res: { writeHead(status: number, headers: Record<string, string>): void; end(body?: string): void },
  status: number,
  message: string
): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
  res.end(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`);
}

const nodeCallbackServer: AiOAuthCallbackServerFactory = async (options) => {
  const http = desktopRequire()("node:http") as typeof import("node:http");
  const failures: string[] = [];

  for (const port of options.ports) {
    try {
      return await new Promise<AiOAuthCallbackServer>((resolve, reject) => {
        let server: import("node:http").Server | undefined;
        let settled = false;
        let resolveWait: ((result: AiOAuthCallbackResult) => void) | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const waitPromise = new Promise<AiOAuthCallbackResult>((res) => {
          resolveWait = res;
        });

        const finish = (result: AiOAuthCallbackResult): void => {
          if (settled) return;
          settled = true;
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          resolveWait?.(result);
          server?.close();
        };

        server = http.createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://${options.redirectHost}:${port}`);
          if (url.pathname !== options.path) {
            respondHtml(res, 404, "Not found");
            return;
          }
          const result: AiOAuthCallbackResult = {
            ...(url.searchParams.get("code") ? { code: url.searchParams.get("code") ?? undefined } : {}),
            ...(url.searchParams.get("state") ? { state: url.searchParams.get("state") ?? undefined } : {}),
            ...(url.searchParams.get("error") ? { error: url.searchParams.get("error") ?? undefined } : {}),
            ...(url.searchParams.get("error_description")
              ? { errorDescription: url.searchParams.get("error_description") ?? undefined }
              : {})
          };
          respondHtml(
            res,
            200,
            result.error
              ? `Authorization failed: ${result.errorDescription ?? result.error}`
              : "Authorization complete. You can close this window."
          );
          finish(result);
        });

        server.once("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
        server.listen(port, options.bindHost, () => {
          // A forgotten flow must not hold the port forever.
          idleTimer = setTimeout(() => finish({ error: "timeout" }), BROWSER_CALLBACK_TIMEOUT_MS);
          resolve({
            redirectUri: `http://${options.redirectHost}:${port}${options.path}`,
            wait: () => waitPromise,
            close: () => finish({ error: "cancelled" })
          });
        });
      });
    } catch (error) {
      failures.push(`${options.bindHost}:${port} - ${describeError(error)}`);
    }
  }

  throw new AiOAuthError(
    "unsupported",
    `Failed to start local OAuth callback server: ${failures.join("; ")}`
  );
};

/* -------------------------------------------------------------------------- */
/* Manager                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs OAuth sign-in for one provider at a time per provider id.
 *
 * Storage keys are `ai-oauth:<providerId>`; the host prefixes its own plugin id
 * (main.ts does), so the manager never needs to know the plugin identity.
 */
export class AiOAuthManager {
  private readonly host: AiOAuthHost;
  private readonly pending = new Map<string, PendingOAuthFlow>();
  private readonly errors = new Map<string, string>();
  private readonly completions = new Map<string, Promise<AiOAuthStatus>>();
  private readonly copilotExchanges = new Map<string, Promise<void>>();

  constructor(host: AiOAuthHost) {
    this.host = host;
  }

  /** Synchronous login state for the provider card. */
  status(provider: AiProviderConfig): AiOAuthStatus {
    const oauth = presetOAuth(provider.preset);
    if (!oauth) return { state: "disconnected" };

    const error = this.errors.get(provider.id);
    if (error) return { state: "error", message: error };

    const pending = this.pending.get(provider.id);
    if (pending) return pendingStatus(pending);

    const credential = this.readCredential(provider.id);
    if (!credential) return { state: "disconnected" };

    // Copilot tokens are short-lived; status is the one place the settings page
    // touches on refresh, so trigger the re-exchange from here.
    if (oauth === "copilot") this.refreshCopilotIfNeeded(provider.id, credential);
    return connectedStatus(credential);
  }

  credential(providerId: string): AiOAuthCredential | undefined {
    return this.readCredential(providerId);
  }

  async begin(provider: AiProviderConfig, options: AiOAuthBeginOptions = {}): Promise<AiConnectStart> {
    const oauth = presetOAuth(provider.preset);
    this.errors.delete(provider.id);
    this.dropPending(provider.id);

    switch (oauth) {
      case null:
        throw new AiOAuthError("unsupported", "This provider does not use OAuth.");
      case "claude":
        return { mode: "manual" };
      case "chatgpt":
        return options.mode === "browser"
          ? this.beginChatGPTBrowser(provider, options.redirectUri)
          : this.beginChatGPTDevice(provider);
      case "gemini":
        return this.beginGeminiBrowser(provider, options.redirectUri);
      case "copilot":
        return this.beginCopilotDevice(provider);
    }
  }

  /**
   * Finishes the flow started by `begin()`.
   *
   * Device flows poll here; browser flows wait for the loopback callback (or
   * the caller-supplied code). Flow failures resolve to an `error` status; only
   * programmer errors (not an OAuth preset) reject.
   */
  async complete(provider: AiProviderConfig, authorization: AiOAuthAuthorization = {}): Promise<AiOAuthStatus> {
    const existing = this.completions.get(provider.id);
    if (existing) return existing;

    const run = this.runComplete(provider, authorization);
    this.completions.set(provider.id, run);
    try {
      return await run;
    } finally {
      if (this.completions.get(provider.id) === run) this.completions.delete(provider.id);
    }
  }

  /** Abandons a pending flow; an in-flight `complete()` resolves disconnected. */
  cancel(providerId: string): void {
    this.dropPending(providerId);
  }

  async disconnect(providerId: string): Promise<void> {
    this.dropPending(providerId);
    this.errors.delete(providerId);
    try {
      this.host.storage.remove(this.storageKey(providerId));
    } catch (error) {
      this.host.logger?.(`OAuth credential removal failed: ${describeError(error)}`);
      throw new AiOAuthError("storage", `Could not remove the saved credential: ${describeError(error)}`);
    }
  }

  /**
   * Stores a token the user pasted (Claude setup tokens, or a provider that
   * only hands out bearer tokens). Accepts the provider config or just its id.
   */
  async saveManualToken(provider: AiProviderConfig | string, token: string): Promise<AiOAuthStatus> {
    const providerId = typeof provider === "string" ? provider : provider.id;
    const accessToken = token.trim();
    if (!accessToken) throw new AiOAuthError("invalid-token", "The token is empty.");
    if (accessToken.length > MAX_AI_SECRET_LENGTH) {
      throw new AiOAuthError("invalid-token", "The token is too long.");
    }

    this.dropPending(providerId);
    this.errors.delete(providerId);
    const credential: AiOAuthCredential = { accessToken, updatedAt: Date.now() };
    this.storeCredential(providerId, credential);
    return connectedStatus(credential);
  }

  /** Waits for background Copilot token exchanges (hosts and tests only). */
  async settle(): Promise<void> {
    await Promise.all([...this.copilotExchanges.values()]);
  }

  /* ---------------------------------------------------------------------- */
  /* Flow implementations                                                   */
  /* ---------------------------------------------------------------------- */

  private async beginChatGPTDevice(provider: AiProviderConfig): Promise<AiConnectStart> {
    const response = await this.request({
      url: `${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`,
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": OAUTH_USER_AGENT },
      body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID })
    });

    const data = this.requireJsonObject(response, "ChatGPT device authorization");
    const deviceAuthId = textValue(data["device_auth_id"]);
    const userCode = textValue(data["user_code"]);
    if (!deviceAuthId || !userCode) {
      throw new AiOAuthError("invalid-response", "ChatGPT device authorization returned an invalid payload.");
    }
    const intervalMs = secondsToMs(data["interval"], 5_000);

    this.pending.set(provider.id, {
      kind: "chatgpt-device",
      deviceAuthId,
      userCode,
      intervalMs,
      verificationUri: CHATGPT_DEVICE_VERIFICATION_URI
    });
    return {
      mode: "device",
      userCode,
      verificationUri: CHATGPT_DEVICE_VERIFICATION_URI,
      intervalMs
    };
  }

  private async beginChatGPTBrowser(
    provider: AiProviderConfig,
    explicitRedirectUri?: string
  ): Promise<AiConnectStart> {
    this.requireDesktop("ChatGPT browser sign-in");
    const callback = await this.openCallbackServer(
      {
        ports: CHATGPT_BROWSER_PORTS,
        path: CHATGPT_BROWSER_CALLBACK_PATH,
        bindHost: "127.0.0.1",
        redirectHost: CHATGPT_BROWSER_REDIRECT_HOST
      },
      explicitRedirectUri
    );
    const redirectUri = explicitRedirectUri ?? callback?.redirectUri;
    if (!redirectUri) {
      throw new AiOAuthError("invalid-response", "The OAuth callback server did not report a redirect URI.");
    }

    const pkce = await generatePkce();
    const state = randomToken(32);
    const authorizationUrl = this.buildChatGPTAuthorizeUrl(redirectUri, pkce.challenge, state);

    this.pending.set(provider.id, {
      kind: "chatgpt-browser",
      state,
      codeVerifier: pkce.verifier,
      redirectUri,
      authorizationUrl,
      verificationUri: authorizationUrl,
      ...(callback ? { callback } : {})
    });
    this.host.openExternal(authorizationUrl);
    return { mode: "browser" };
  }

  private async beginGeminiBrowser(
    provider: AiProviderConfig,
    explicitRedirectUri?: string
  ): Promise<AiConnectStart> {
    this.requireDesktop("Gemini browser sign-in");
    const credentials = this.geminiCredentials(provider);
    const callback = await this.openCallbackServer(
      {
        ports: [GEMINI_CALLBACK_PORT],
        path: GEMINI_CALLBACK_PATH,
        bindHost: GEMINI_CALLBACK_HOST,
        redirectHost: GEMINI_CALLBACK_HOST
      },
      explicitRedirectUri
    );
    const redirectUri = explicitRedirectUri ?? callback?.redirectUri;
    if (!redirectUri) {
      throw new AiOAuthError("invalid-response", "The OAuth callback server did not report a redirect URI.");
    }

    const pkce = await generatePkce();
    const state = randomToken(32);
    const authorizationUrl = this.buildGeminiAuthorizeUrl(
      credentials.clientId,
      redirectUri,
      pkce.challenge,
      state
    );

    this.pending.set(provider.id, {
      kind: "gemini-browser",
      state,
      codeVerifier: pkce.verifier,
      redirectUri,
      authorizationUrl,
      verificationUri: authorizationUrl,
      ...(callback ? { callback } : {})
    });
    this.host.openExternal(authorizationUrl);
    return { mode: "browser" };
  }

  private async beginCopilotDevice(provider: AiProviderConfig): Promise<AiConnectStart> {
    const response = await this.request({
      url: COPILOT_DEVICE_CODE_URL,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OAUTH_USER_AGENT
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        scope: COPILOT_SCOPE
      }).toString()
    });

    const data = this.requireJsonObject(response, "GitHub device authorization");
    const deviceCode = textValue(data["device_code"]);
    const userCode = textValue(data["user_code"]);
    if (!deviceCode || !userCode) {
      throw new AiOAuthError("invalid-response", "GitHub device authorization returned an invalid payload.");
    }
    const intervalMs = secondsToMs(data["interval"], COPILOT_DEFAULT_POLL_INTERVAL_MS);
    const expiresInMs = secondsToMs(data["expires_in"], COPILOT_DEVICE_CODE_TTL_MS);
    const verificationUri =
      textValue(data["verification_uri"]) ?? COPILOT_DEFAULT_VERIFICATION_URI;

    this.pending.set(provider.id, {
      kind: "copilot-device",
      deviceCode,
      userCode,
      intervalMs,
      verificationUri,
      expiresAt: Date.now() + expiresInMs
    });
    return { mode: "device", userCode, verificationUri, intervalMs };
  }

  private async runComplete(
    provider: AiProviderConfig,
    authorization: AiOAuthAuthorization
  ): Promise<AiOAuthStatus> {
    try {
      const oauth = presetOAuth(provider.preset);
      if (!oauth) {
        throw new AiOAuthError("unsupported", "This provider does not use OAuth.");
      }

      let credential: AiOAuthCredential;
      switch (oauth) {
        case "claude":
          // Manual token entry: `saveManualToken` is the completion step.
          return this.status(provider);
        case "chatgpt":
          credential = await this.completeChatGPT(provider, authorization);
          break;
        case "gemini":
          credential = await this.completeGemini(provider, authorization);
          break;
        case "copilot":
          credential = await this.completeCopilot(provider, authorization);
          break;
        default:
          throw new AiOAuthError("unsupported", "This provider does not use OAuth.");
      }

      this.storeCredential(provider.id, credential);
      this.dropPending(provider.id);
      this.errors.delete(provider.id);
      return connectedStatus(credential);
    } catch (error) {
      const cancelled = error instanceof AiOAuthError && error.code === "cancelled";
      this.dropPending(provider.id);
      if (cancelled) return { state: "disconnected" };
      const message = describeError(error);
      this.errors.set(provider.id, message);
      this.host.logger?.(`OAuth sign-in failed for "${provider.id}": ${message}`);
      return { state: "error", message };
    }
  }

  private async completeChatGPT(
    provider: AiProviderConfig,
    authorization: AiOAuthAuthorization
  ): Promise<AiOAuthCredential> {
    const flow = this.pending.get(provider.id);
    if (flow?.kind === "chatgpt-browser" || (!flow && authorization.code)) {
      return this.completeChatGPTBrowser(flow, authorization);
    }
    return this.completeChatGPTDevice(flow, authorization);
  }

  private async completeChatGPTBrowser(
    flow: PendingOAuthFlow | undefined,
    authorization: AiOAuthAuthorization
  ): Promise<AiOAuthCredential> {
    const codeVerifier = authorization.codeVerifier ?? flow?.codeVerifier;
    if (!codeVerifier) {
      throw new AiOAuthError("invalid-response", "ChatGPT sign-in must be restarted before it can finish.");
    }
    const redirectUri = flow?.redirectUri ?? this.defaultChatGPTRedirectUri();

    let code = authorization.code;
    if (!code) {
      const result = await this.awaitCallback(flow, "ChatGPT");
      code = result.code;
      if (result.state && flow?.state && result.state !== flow.state) {
        throw new AiOAuthError("denied", "The OAuth state returned by ChatGPT did not match this sign-in attempt.");
      }
    }
    if (!code) {
      throw new AiOAuthError("invalid-response", "ChatGPT did not return an authorization code.");
    }

    return this.exchangeChatGPTCode({ code, codeVerifier, redirectUri });
  }

  private async completeChatGPTDevice(
    flow: PendingOAuthFlow | undefined,
    authorization: AiOAuthAuthorization
  ): Promise<AiOAuthCredential> {
    const deviceAuthId = flow?.deviceAuthId ?? authorization.deviceCode;
    const userCode = flow?.userCode;
    if (!deviceAuthId || !userCode) {
      throw new AiOAuthError("invalid-response", "ChatGPT device sign-in must be started again.");
    }

    const intervalMs = authorization.intervalMs ?? flow?.intervalMs ?? 5_000;
    const deadline = Date.now() + DEVICE_AUTH_TIMEOUT_MS;

    for (let attempt = 0; attempt < DEVICE_AUTH_MAX_POLLS && Date.now() < deadline; attempt += 1) {
      this.throwIfCancelled(flow);
      const response = await this.request({
        url: `${CHATGPT_ISSUER}/api/accounts/deviceauth/token`,
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": OAUTH_USER_AGENT },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
      });

      if (isSuccess(response.status)) {
        const data = jsonObject(response);
        const code = textValue(data?.["authorization_code"]);
        const codeVerifier = textValue(data?.["code_verifier"]);
        if (!code || !codeVerifier) {
          throw new AiOAuthError("invalid-response", "ChatGPT device authorization returned an invalid token payload.");
        }
        return this.exchangeChatGPTCode({
          code,
          codeVerifier,
          redirectUri: CHATGPT_DEVICE_REDIRECT_URI
        });
      }

      // 403/404 mean "the user has not approved yet"; anything else is fatal.
      if (response.status !== 403 && response.status !== 404) {
        throw new AiOAuthError(
          "denied",
          `ChatGPT device authorization failed with HTTP ${response.status}${responseSuffix(response)}`
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleepFlow(flow, Math.min(intervalMs, remainingMs));
    }

    this.throwIfCancelled(flow);
    throw new AiOAuthError("expired", "ChatGPT device authorization timed out before it was approved.");
  }

  private async exchangeChatGPTCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<AiOAuthCredential> {
    const response = await this.request({
      url: `${CHATGPT_ISSUER}/oauth/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": OAUTH_USER_AGENT },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CHATGPT_CLIENT_ID,
        code_verifier: input.codeVerifier
      }).toString()
    });
    if (!isSuccess(response.status)) {
      throw new AiOAuthError(
        "denied",
        `ChatGPT token exchange failed with HTTP ${response.status}${responseSuffix(response)}`
      );
    }

    const data = jsonObject(response);
    const accessToken = textValue(data?.["access_token"]);
    if (!accessToken) {
      throw new AiOAuthError("invalid-response", "ChatGPT token exchange returned no access token.");
    }
    const idToken = textValue(data?.["id_token"]);
    const refreshToken = textValue(data?.["refresh_token"]);
    const expiresIn = numberValue(data?.["expires_in"]);
    const accountId = extractChatGPTAccountId(accessToken, idToken);

    return {
      accessToken,
      updatedAt: Date.now(),
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
      ...(accountId ? { accountId } : {})
    };
  }

  private async completeGemini(
    provider: AiProviderConfig,
    authorization: AiOAuthAuthorization
  ): Promise<AiOAuthCredential> {
    const credentials = this.geminiCredentials(provider);
    const flow = this.pending.get(provider.id);
    const codeVerifier = authorization.codeVerifier ?? flow?.codeVerifier;
    if (!codeVerifier) {
      throw new AiOAuthError("invalid-response", "Gemini sign-in must be restarted before it can finish.");
    }
    const redirectUri = flow?.redirectUri ?? this.defaultGeminiRedirectUri();

    let code = authorization.code;
    if (!code) {
      const result = await this.awaitCallback(flow, "Gemini");
      code = result.code;
      if (result.state && flow?.state && result.state !== flow.state) {
        throw new AiOAuthError("denied", "The OAuth state returned by Google did not match this sign-in attempt.");
      }
    }
    if (!code) {
      throw new AiOAuthError("invalid-response", "Google did not return an authorization code.");
    }

    const response = await this.request({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": OAUTH_USER_AGENT },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      }).toString()
    });
    if (!isSuccess(response.status)) {
      throw new AiOAuthError(
        "denied",
        `Gemini token exchange failed with HTTP ${response.status}${responseSuffix(response)}`
      );
    }

    const data = jsonObject(response);
    const accessToken = textValue(data?.["access_token"]);
    if (!accessToken) {
      throw new AiOAuthError("invalid-response", "Gemini token exchange returned no access token.");
    }
    const refreshToken = textValue(data?.["refresh_token"]);
    const expiresIn = numberValue(data?.["expires_in"]);
    const email = await this.fetchGoogleEmail(accessToken);

    return {
      accessToken,
      updatedAt: Date.now(),
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
      ...(email ? { email } : {})
    };
  }

  private async fetchGoogleEmail(accessToken: string): Promise<string | undefined> {
    try {
      const response = await this.request({
        url: GOOGLE_USERINFO_ENDPOINT,
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
      });
      if (!isSuccess(response.status)) return undefined;
      return textValue(jsonObject(response)?.["email"]);
    } catch (error) {
      // The e-mail is cosmetic: a failed userinfo call must not discard tokens.
      this.host.logger?.(`Gemini userinfo lookup failed: ${describeError(error)}`);
      return undefined;
    }
  }

  private async completeCopilot(
    provider: AiProviderConfig,
    authorization: AiOAuthAuthorization
  ): Promise<AiOAuthCredential> {
    const flow = this.pending.get(provider.id);
    const deviceCode = authorization.deviceCode ?? flow?.deviceCode;
    if (!deviceCode) {
      throw new AiOAuthError("invalid-response", "GitHub device sign-in must be started again.");
    }

    let intervalMs = authorization.intervalMs ?? flow?.intervalMs ?? COPILOT_DEFAULT_POLL_INTERVAL_MS;
    const deadline = flow?.expiresAt ?? Date.now() + COPILOT_DEVICE_CODE_TTL_MS;

    for (let attempt = 0; attempt < DEVICE_AUTH_MAX_POLLS && Date.now() < deadline; attempt += 1) {
      this.throwIfCancelled(flow);
      await sleepFlow(flow, Math.min(intervalMs, Math.max(deadline - Date.now(), 1)));

      const response = await this.request({
        url: COPILOT_ACCESS_TOKEN_URL,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": OAUTH_USER_AGENT
        },
        body: new URLSearchParams({
          client_id: COPILOT_CLIENT_ID,
          device_code: deviceCode,
          grant_type: COPILOT_DEVICE_GRANT_TYPE
        }).toString()
      });

      // GitHub reports pending/denied as HTTP 200 with an `error` body; RFC
      // 8628 servers use 400. Both carry the same JSON fields.
      const data = jsonObject(response);
      const accessToken = textValue(data?.["access_token"]);
      if (accessToken) {
        return this.exchangeCopilotToken(accessToken);
      }

      switch (data?.["error"]) {
        case "authorization_pending":
          continue;
        case "slow_down":
          intervalMs = numberValue(data?.["interval"]) !== undefined
            ? Math.max(numberValue(data?.["interval"]) ?? 0, 1) * 1000
            : intervalMs + COPILOT_SLOW_DOWN_INCREMENT_MS;
          continue;
        case "expired_token":
          throw new AiOAuthError("expired", "The GitHub device code expired before it was approved.");
        case "access_denied":
          throw new AiOAuthError("denied", "GitHub authorization was declined.");
        default:
          throw new AiOAuthError(
            "denied",
            `GitHub device authorization failed with HTTP ${response.status}${responseSuffix(response)}`
          );
      }
    }

    this.throwIfCancelled(flow);
    throw new AiOAuthError("expired", "The GitHub device code expired before it was approved.");
  }

  private async exchangeCopilotToken(githubToken: string): Promise<AiOAuthCredential> {
    const session = await this.fetchCopilotSession(githubToken);
    return {
      accessToken: githubToken,
      updatedAt: Date.now(),
      ...session
    };
  }

  private async fetchCopilotSession(githubToken: string): Promise<Pick<
    AiOAuthCredential,
    "copilotToken" | "copilotExpiresAt" | "copilotApiBaseUrl"
  >> {
    const response = await this.request({
      url: COPILOT_TOKEN_EXCHANGE_URL,
      method: "GET",
      headers: {
        Accept: "application/json",
        ...COPILOT_EDITOR_HEADERS,
        Authorization: `token ${githubToken}`
      }
    });

    if (response.status === 401) {
      throw new AiOAuthError("denied", "GitHub rejected the saved Copilot login; sign in again.");
    }
    if (response.status === 403) {
      throw new AiOAuthError("denied", "This GitHub account has no Copilot access.");
    }
    if (!isSuccess(response.status)) {
      throw new AiOAuthError(
        "network",
        `Copilot token exchange failed with HTTP ${response.status}${responseSuffix(response)}`
      );
    }

    const data = jsonObject(response);
    const copilotToken = textValue(data?.["token"]);
    const expiresAtSeconds = numberValue(data?.["expires_at"]);
    const endpoints = data?.["endpoints"];
    const api = endpoints !== null && typeof endpoints === "object"
      ? textValue((endpoints as Record<string, unknown>)["api"])
      : undefined;
    if (!copilotToken || expiresAtSeconds === undefined || !api) {
      throw new AiOAuthError("invalid-response", "Copilot token exchange returned an invalid payload.");
    }

    return {
      copilotToken,
      copilotExpiresAt: expiresAtSeconds * 1000,
      copilotApiBaseUrl: api.replace(/\/+$/, "")
    };
  }

  private refreshCopilotIfNeeded(providerId: string, credential: AiOAuthCredential): void {
    if (this.copilotExchanges.has(providerId)) return;
    const freshUntil = credential.copilotExpiresAt;
    if (
      credential.copilotToken &&
      freshUntil !== undefined &&
      freshUntil - Date.now() > COPILOT_TOKEN_REFRESH_MARGIN_MS
    ) {
      return;
    }

    const run = (async (): Promise<void> => {
      try {
        const session = await this.fetchCopilotSession(credential.accessToken);
        const current = this.readCredential(providerId);
        if (!current || current.accessToken !== credential.accessToken) return;
        this.storeCredential(providerId, { ...current, ...session, updatedAt: Date.now() });
        this.errors.delete(providerId);
      } catch (error) {
        // A login replaced while the exchange was running keeps its own state.
        const current = this.readCredential(providerId);
        if (!current || current.accessToken !== credential.accessToken) return;
        const message = describeError(error);
        this.errors.set(providerId, message);
        this.host.logger?.(`Copilot token refresh failed: ${message}`);
      }
    })();

    this.copilotExchanges.set(providerId, run);
    void run.then(() => {
      if (this.copilotExchanges.get(providerId) === run) this.copilotExchanges.delete(providerId);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Plumbing                                                               */
  /* ---------------------------------------------------------------------- */

  private buildChatGPTAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CHATGPT_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CHATGPT_BROWSER_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "opencode"
    });
    return `${CHATGPT_ISSUER}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Gemini OAuth runs through a Google OAuth client owned by the user: no
   * client credentials ship with this plugin, so the provider form must supply
   * them. Failing closed here keeps the browser from opening an unusable flow.
   */
  private geminiCredentials(provider: AiProviderConfig): { clientId: string; clientSecret: string } {
    const clientId = provider.additionalSettings?.oauthClientId?.trim() ?? "";
    const clientSecret = provider.additionalSettings?.oauthClientSecret?.trim() ?? "";
    if (!clientId || !clientSecret) {
      throw new AiOAuthError(
        "unsupported",
        "Gemini sign-in needs a Google OAuth client ID and client secret in this provider's settings."
      );
    }
    return { clientId, clientSecret };
  }

  private buildGeminiAuthorizeUrl(
    clientId: string,
    redirectUri: string,
    challenge: string,
    state: string
  ): string {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: GOOGLE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent"
    });
    return `${GOOGLE_ISSUER}/o/oauth2/v2/auth?${params.toString()}`;
  }

  private defaultChatGPTRedirectUri(): string {
    const port = CHATGPT_BROWSER_PORTS[0];
    return `http://${CHATGPT_BROWSER_REDIRECT_HOST}:${port}${CHATGPT_BROWSER_CALLBACK_PATH}`;
  }

  private defaultGeminiRedirectUri(): string {
    return `http://${GEMINI_CALLBACK_HOST}:${GEMINI_CALLBACK_PORT}${GEMINI_CALLBACK_PATH}`;
  }

  private async openCallbackServer(
    options: AiOAuthCallbackServerOptions,
    explicitRedirectUri?: string
  ): Promise<AiOAuthCallbackServer | undefined> {
    if (explicitRedirectUri) return undefined;
    const factory = this.host.callbackServer ?? nodeCallbackServer;
    return factory(options);
  }

  private async awaitCallback(
    flow: PendingOAuthFlow | undefined,
    label: string
  ): Promise<AiOAuthCallbackResult> {
    const callback = flow?.callback;
    if (!callback) {
      throw new AiOAuthError(
        "invalid-response",
        `${label} sign-in has no callback listener; pass the authorization code to complete the flow.`
      );
    }
    const result = await withTimeout(
      callback.wait(),
      BROWSER_CALLBACK_TIMEOUT_MS,
      { error: "timeout" }
    );
    if (result.error === "cancelled") {
      throw new AiOAuthError("cancelled", `${label} sign-in was cancelled.`);
    }
    if (result.error === "timeout") {
      throw new AiOAuthError("expired", `${label} sign-in timed out waiting for the browser callback.`);
    }
    if (result.error) {
      throw new AiOAuthError(
        "denied",
        result.errorDescription ?? result.error
      );
    }
    return result;
  }

  private requireDesktop(action: string): void {
    if (!this.host.isDesktop()) {
      throw new AiOAuthError("not-desktop", `${action} requires the desktop app.`);
    }
  }

  private throwIfCancelled(flow: PendingOAuthFlow | undefined): void {
    if (flow?.cancelled) {
      throw new AiOAuthError("cancelled", "OAuth sign-in was cancelled.");
    }
  }

  private dropPending(providerId: string): void {
    const flow = this.pending.get(providerId);
    if (!flow) return;
    this.pending.delete(providerId);
    flow.cancelled = true;
    flow.wake?.();
    flow.callback?.close();
  }

  private async request(request: AiHttpRequest): Promise<AiHttpResponse> {
    try {
      return await this.host.http.request(request);
    } catch (error) {
      throw new AiOAuthError("network", describeError(error));
    }
  }

  private requireJsonObject(response: AiHttpResponse, label: string): Record<string, unknown> {
    if (!isSuccess(response.status)) {
      throw new AiOAuthError(
        "network",
        `${label} failed with HTTP ${response.status}${responseSuffix(response)}`
      );
    }
    const data = jsonObject(response);
    if (!data) {
      throw new AiOAuthError("invalid-response", `${label} returned an invalid payload.`);
    }
    return data;
  }

  private storageKey(providerId: string): string {
    return `${OAUTH_STORAGE_PREFIX}${providerId}`;
  }

  private readCredential(providerId: string): AiOAuthCredential | undefined {
    try {
      return normalizeCredential(this.host.storage.load(this.storageKey(providerId)));
    } catch (error) {
      this.host.logger?.(`OAuth credential read failed: ${describeError(error)}`);
      return undefined;
    }
  }

  private storeCredential(providerId: string, credential: AiOAuthCredential): void {
    try {
      this.host.storage.save(this.storageKey(providerId), credential);
    } catch (error) {
      throw new AiOAuthError("storage", `Could not save the OAuth credential: ${describeError(error)}`);
    }
  }
}

/** Exported for hosts and tests that need the exact device-local key. */
export function oauthStorageKey(providerId: string): string {
  return `${OAUTH_STORAGE_PREFIX}${providerId}`;
}

function sleepFlow(flow: PendingOAuthFlow | undefined, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!flow) {
      setTimeout(resolve, ms);
      return;
    }
    if (flow.cancelled) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (flow.wake === finish) flow.wake = undefined;
      resolve();
    };
    timer = setTimeout(finish, ms);
    flow.wake = finish;
  });
}
