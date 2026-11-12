import test from "node:test";
import assert from "node:assert/strict";
import type { AiApiType, AiOAuthCredential, AiProviderConfig, AiProviderPreset } from "../src/services/ai/contracts";
import {
  AiOAuthError,
  AiOAuthManager,
  oauthStorageKey,
  type AiHttpPort,
  type AiHttpRequest,
  type AiHttpResponse,
  type AiOAuthCallbackResult,
  type AiOAuthCallbackServer,
  type AiOAuthCallbackServerOptions,
  type AiOAuthHost,
  type AiSecretStorage
} from "../src/services/ai/oauth";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type Responder = AiHttpResponse | ((request: AiHttpRequest) => AiHttpResponse | Promise<AiHttpResponse>);

interface FakeCallback {
  server: AiOAuthCallbackServer;
  resolve(result: AiOAuthCallbackResult): void;
  readonly closed: boolean;
}

interface Harness {
  manager: AiOAuthManager;
  requests: AiHttpRequest[];
  storage: Map<string, unknown>;
  opened: string[];
  callbacks: FakeCallback[];
  enqueue(...responses: Responder[]): void;
}

function jsonResponse(status: number, body: unknown): AiHttpResponse {
  return { status, text: JSON.stringify(body), json: body };
}

function createHarness(input: { isDesktop?: boolean } = {}): Harness {
  const requests: AiHttpRequest[] = [];
  const queue: Responder[] = [];
  const storage = new Map<string, unknown>();
  const opened: string[] = [];
  const callbacks: FakeCallback[] = [];

  const http: AiHttpPort = {
    request: async (request) => {
      requests.push(request);
      const next = queue.shift();
      if (!next) throw new Error(`Unexpected request: ${request.url}`);
      return typeof next === "function" ? next(request) : next;
    }
  };

  const secrets: AiSecretStorage = {
    load: (key) => storage.get(key),
    save: (key, value) => {
      storage.set(key, value);
    },
    remove: (key) => {
      storage.delete(key);
    }
  };

  const createCallback = async (options: AiOAuthCallbackServerOptions): Promise<AiOAuthCallbackServer> => {
    let resolveWait: (result: AiOAuthCallbackResult) => void = () => undefined;
    const waitPromise = new Promise<AiOAuthCallbackResult>((resolve) => {
      resolveWait = resolve;
    });
    let closed = false;
    const server: AiOAuthCallbackServer = {
      redirectUri: `http://${options.redirectHost}:${options.ports[0]}${options.path}`,
      wait: () => waitPromise,
      close: () => {
        closed = true;
        resolveWait({ error: "cancelled" });
      }
    };
    callbacks.push({
      server,
      resolve: resolveWait,
      get closed() {
        return closed;
      }
    });
    return server;
  };

  const host: AiOAuthHost = {
    http,
    storage: secrets,
    openExternal: (url) => {
      opened.push(url);
    },
    isDesktop: () => input.isDesktop ?? true,
    callbackServer: createCallback
  };

  return {
    manager: new AiOAuthManager(host),
    requests,
    storage,
    opened,
    callbacks,
    enqueue: (...responses) => {
      queue.push(...responses);
    }
  };
}

const PRESET_API_TYPE: Record<string, AiApiType> = {
  "chatgpt-oauth": "openai-responses",
  "gemini-oauth": "gemini",
  "claude-oauth": "anthropic",
  "github-copilot": "openai-compatible",
  openai: "openai-responses"
};

function provider(preset: AiProviderPreset, id = preset): AiProviderConfig {
  return { id, preset, apiType: PRESET_API_TYPE[preset] ?? "openai-compatible" };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jwt(claims: unknown): string {
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(claims)}.signature`;
}

function parseBody(request: AiHttpRequest): URLSearchParams {
  return new URLSearchParams(request.body ?? "");
}

function parseUrl(value: string): URL {
  return new URL(value);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for the flow to progress");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* -------------------------------------------------------------------------- */
/* ChatGPT: device flow                                                        */
/* -------------------------------------------------------------------------- */

test("chatgpt device begin shows a user code and keeps the device id on the device", async () => {
  const harness = createHarness();
  harness.enqueue(jsonResponse(200, { device_auth_id: "dev-1", user_code: "USER-1", interval: "5" }));

  const result = await harness.manager.begin(provider("chatgpt-oauth"));

  assert.deepEqual(result, {
    mode: "device",
    userCode: "USER-1",
    verificationUri: "https://auth.openai.com/codex/device",
    intervalMs: 5_000
  });
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.equal(request?.url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.equal(request?.method, "POST");
  assert.deepEqual(JSON.parse(request?.body ?? "{}"), { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  assert.deepEqual(harness.manager.status(provider("chatgpt-oauth")), {
    state: "pending",
    userCode: "USER-1",
    verificationUri: "https://auth.openai.com/codex/device"
  });
  assert.equal(harness.opened.length, 0, "the device flow shows a code instead of opening a browser");
});

test("chatgpt device complete polls through pending and exchanges the authorization code", async () => {
  const harness = createHarness();
  harness.enqueue(
    jsonResponse(200, { device_auth_id: "dev-1", user_code: "USER-1", interval: "5" }),
    jsonResponse(403, { error: "authorization_pending" }),
    jsonResponse(200, {
      authorization_code: "code-1",
      code_verifier: "verifier-1"
    }),
    jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      id_token: jwt({ chatgpt_account_id: "account-1" })
    })
  );

  const chatgpt = provider("chatgpt-oauth");
  await harness.manager.begin(chatgpt);
  const status = await harness.manager.complete(chatgpt, { intervalMs: 1 });

  assert.deepEqual(status, {
    state: "connected",
    account: "account-1",
    expiresAt: status.state === "connected" ? status.expiresAt : undefined
  });
  assert.ok(status.state === "connected" && typeof status.expiresAt === "number");

  assert.equal(harness.requests.length, 4);
  assert.equal(harness.requests[1]?.url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.deepEqual(JSON.parse(harness.requests[1]?.body ?? "{}"), {
    device_auth_id: "dev-1",
    user_code: "USER-1"
  });

  const tokenRequest = harness.requests[3];
  assert.equal(tokenRequest?.url, "https://auth.openai.com/oauth/token");
  assert.equal(tokenRequest?.method, "POST");
  const body = parseBody(tokenRequest!);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "code-1");
  assert.equal(body.get("code_verifier"), "verifier-1");
  assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(body.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");

  const stored = harness.storage.get(oauthStorageKey("chatgpt-oauth")) as AiOAuthCredential;
  assert.equal(stored.accessToken, "access-1");
  assert.equal(stored.refreshToken, "refresh-1");
  assert.equal(stored.accountId, "account-1");
  assert.equal(harness.manager.credential("chatgpt-oauth")?.accessToken, "access-1");
  assert.equal(harness.manager.status(chatgpt).state, "connected");
});

test("chatgpt device denial returns an error status and never stores a credential", async () => {
  const harness = createHarness();
  harness.enqueue(
    jsonResponse(200, { device_auth_id: "dev-1", user_code: "USER-1" }),
    jsonResponse(400, { error: "access_denied", error_description: "User denied access" })
  );

  const chatgpt = provider("chatgpt-oauth");
  await harness.manager.begin(chatgpt);
  const status = await harness.manager.complete(chatgpt, { intervalMs: 1 });

  assert.equal(status.state, "error");
  assert.match(status.state === "error" ? status.message : "", /HTTP 400/);
  assert.equal(harness.manager.status(chatgpt).state, "error");
  assert.equal(harness.manager.credential("chatgpt-oauth"), undefined);
  assert.equal(harness.storage.size, 0);
});

test("cancelling during a device poll resolves complete as disconnected", async () => {
  const harness = createHarness();
  harness.enqueue(
    jsonResponse(200, { device_auth_id: "dev-1", user_code: "USER-1" }),
    jsonResponse(403, { error: "authorization_pending" })
  );

  const chatgpt = provider("chatgpt-oauth");
  await harness.manager.begin(chatgpt);
  const completion = harness.manager.complete(chatgpt, { intervalMs: 5_000 });
  await waitFor(() => harness.requests.length >= 2);

  harness.manager.cancel("chatgpt-oauth");

  assert.deepEqual(await completion, { state: "disconnected" });
  assert.equal(harness.manager.status(chatgpt).state, "disconnected");
  assert.equal(harness.storage.size, 0);
});

/* -------------------------------------------------------------------------- */
/* ChatGPT: browser PKCE                                                       */
/* -------------------------------------------------------------------------- */

test("chatgpt browser begin opens a PKCE authorize URL and complete exchanges the callback code", async () => {
  const harness = createHarness();
  const chatgpt = provider("chatgpt-oauth");

  const start = await harness.manager.begin(chatgpt, { mode: "browser" });
  assert.deepEqual(start, { mode: "browser" });
  assert.equal(harness.opened.length, 1);

  const authorize = parseUrl(harness.opened[0]!);
  assert.equal(authorize.origin + authorize.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("code_challenge")?.length, 43);
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  const state = authorize.searchParams.get("state");
  assert.ok(state);

  const pending = harness.manager.status(chatgpt);
  assert.equal(pending.state, "pending");
  assert.equal(pending.state === "pending" ? pending.verificationUri : "", authorize.toString());

  const callback = harness.callbacks[0]!;
  harness.enqueue(
    jsonResponse(200, {
      access_token: "access-browser",
      refresh_token: "refresh-browser",
      expires_in: 600,
      id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-browser" } })
    })
  );
  callback.resolve({ code: "code-browser", state: state ?? undefined });

  const status = await harness.manager.complete(chatgpt, {});
  assert.equal(status.state, "connected");
  assert.equal(status.state === "connected" ? status.account : undefined, "account-browser");
  assert.equal(callback.closed, true);

  const tokenRequest = harness.requests[0];
  assert.equal(tokenRequest?.url, "https://auth.openai.com/oauth/token");
  const body = parseBody(tokenRequest!);
  assert.equal(body.get("code"), "code-browser");
  assert.equal(body.get("code_verifier")?.length, 43);
  assert.equal(body.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(harness.manager.credential("chatgpt-oauth")?.accountId, "account-browser");
});

test("chatgpt browser sign-in is desktop-only and makes no request on mobile", async () => {
  const harness = createHarness({ isDesktop: false });

  await assert.rejects(
    () => harness.manager.begin(provider("chatgpt-oauth"), { mode: "browser" }),
    (error: unknown) => error instanceof AiOAuthError && error.code === "not-desktop"
  );
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.opened.length, 0);
  assert.equal(harness.callbacks.length, 0);
  assert.equal(harness.manager.status(provider("chatgpt-oauth")).state, "disconnected");
});

test("cancelling a browser sign-in resolves complete as disconnected and closes the listener", async () => {
  const harness = createHarness();
  const chatgpt = provider("chatgpt-oauth");
  await harness.manager.begin(chatgpt, { mode: "browser" });

  const completion = harness.manager.complete(chatgpt, {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  harness.manager.cancel("chatgpt-oauth");

  assert.deepEqual(await completion, { state: "disconnected" });
  assert.equal(harness.callbacks[0]?.closed, true);
  assert.equal(harness.manager.status(chatgpt).state, "disconnected");
});

test("a browser callback that carries an OAuth error becomes an error status", async () => {
  const harness = createHarness();
  const chatgpt = provider("chatgpt-oauth");
  await harness.manager.begin(chatgpt, { mode: "browser" });
  harness.callbacks[0]!.resolve({ error: "access_denied", errorDescription: "User denied access" });

  const status = await harness.manager.complete(chatgpt, {});
  assert.equal(status.state, "error");
  assert.match(status.state === "error" ? status.message : "", /User denied access/);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.storage.size, 0);
});

/* -------------------------------------------------------------------------- */
/* Gemini: browser PKCE                                                        */
/* -------------------------------------------------------------------------- */

test("gemini sign-in requires a user-configured Google OAuth client", async () => {
  const harness = createHarness();

  await assert.rejects(
    () => harness.manager.begin(provider("gemini-oauth")),
    (error: unknown) => error instanceof AiOAuthError
      && error.code === "unsupported"
      && /OAuth client ID and client secret/.test(error.message)
  );
  assert.equal(harness.opened.length, 0);
  assert.equal(harness.requests.length, 0);
});

test("gemini browser begin opens Google PKCE and complete reads the account e-mail", async () => {
  const harness = createHarness();
  const gemini = provider("gemini-oauth");
  gemini.additionalSettings = {
    oauthClientId: "test-google-client-id",
    oauthClientSecret: "test-google-client-secret"
  };

  const start = await harness.manager.begin(gemini);
  assert.deepEqual(start, { mode: "browser" });
  assert.equal(harness.opened.length, 1);

  const authorize = parseUrl(harness.opened[0]!);
  assert.equal(authorize.origin + authorize.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(authorize.searchParams.get("client_id"), "test-google-client-id");
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:8085/oauth2callback");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("scope")?.includes("cloud-platform"));
  const state = authorize.searchParams.get("state");

  harness.enqueue(
    jsonResponse(200, { access_token: "google-access", refresh_token: "google-refresh", expires_in: 3600 }),
    jsonResponse(200, { email: "person@example.com" })
  );
  harness.callbacks[0]!.resolve({ code: "google-code", state: state ?? undefined });

  const status = await harness.manager.complete(gemini, {});
  assert.equal(status.state, "connected");
  assert.equal(status.state === "connected" ? status.account : undefined, "person@example.com");

  const tokenRequest = harness.requests[0];
  assert.equal(tokenRequest?.url, "https://oauth2.googleapis.com/token");
  const body = parseBody(tokenRequest!);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "google-code");
  assert.equal(body.get("redirect_uri"), "http://127.0.0.1:8085/oauth2callback");
  assert.equal(body.get("client_id"), "test-google-client-id");
  assert.equal(body.get("client_secret"), "test-google-client-secret");
  assert.equal(body.get("code_verifier")?.length, 43);

  const userInfoRequest = harness.requests[1];
  assert.equal(userInfoRequest?.url, "https://www.googleapis.com/oauth2/v1/userinfo?alt=json");
  assert.equal(userInfoRequest?.headers?.["Authorization"], "Bearer google-access");

  const stored = harness.manager.credential("gemini-oauth");
  assert.equal(stored?.email, "person@example.com");
  assert.equal(stored?.refreshToken, "google-refresh");
});

test("gemini sign-in is desktop-only and makes no request on mobile", async () => {
  const harness = createHarness({ isDesktop: false });

  await assert.rejects(
    () => harness.manager.begin(provider("gemini-oauth")),
    (error: unknown) => error instanceof AiOAuthError && error.code === "not-desktop"
  );
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.opened.length, 0);
});

/* -------------------------------------------------------------------------- */
/* GitHub Copilot: device flow                                                 */
/* -------------------------------------------------------------------------- */

test("copilot device flow stores the GitHub token and exchanges the Copilot session", async () => {
  const harness = createHarness();
  const copilot = provider("github-copilot");
  harness.enqueue(
    jsonResponse(200, {
      device_code: "device-1",
      user_code: "GH-USER",
      verification_uri: "https://github.com/login/device",
      interval: 5,
      expires_in: 900
    }),
    jsonResponse(200, { error: "authorization_pending" }),
    jsonResponse(200, { access_token: "github-token" }),
    jsonResponse(200, {
      token: "copilot-token",
      expires_at: 4_102_444_800,
      endpoints: { api: "https://api.githubcopilot.com/" }
    })
  );

  const start = await harness.manager.begin(copilot);
  assert.deepEqual(start, {
    mode: "device",
    userCode: "GH-USER",
    verificationUri: "https://github.com/login/device",
    intervalMs: 5_000
  });
  const deviceRequest = harness.requests[0];
  assert.equal(deviceRequest?.url, "https://github.com/login/device/code");
  assert.equal(parseBody(deviceRequest!).get("client_id"), "Iv1.b507a08c87ecfe98");
  assert.equal(parseBody(deviceRequest!).get("scope"), "read:user");

  const status = await harness.manager.complete(copilot, { intervalMs: 1 });
  assert.equal(status.state, "connected");

  assert.equal(harness.requests[1]?.url, "https://github.com/login/oauth/access_token");
  assert.equal(harness.requests[2]?.url, "https://github.com/login/oauth/access_token");
  const copilotRequest = harness.requests[3];
  assert.equal(copilotRequest?.url, "https://api.github.com/copilot_internal/v2/token");
  assert.equal(copilotRequest?.headers?.["Authorization"], "token github-token");
  assert.equal(copilotRequest?.headers?.["Copilot-Integration-Id"], "vscode-chat");

  const stored = harness.manager.credential("github-copilot");
  assert.equal(stored?.accessToken, "github-token");
  assert.equal(stored?.copilotToken, "copilot-token");
  assert.equal(stored?.copilotExpiresAt, 4_102_444_800_000);
  assert.equal(stored?.copilotApiBaseUrl, "https://api.githubcopilot.com");
});

test("copilot denial returns an error status", async () => {
  const harness = createHarness();
  const copilot = provider("github-copilot");
  harness.enqueue(
    jsonResponse(200, {
      device_code: "device-1",
      user_code: "GH-USER",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 900
    }),
    jsonResponse(200, { error: "access_denied" })
  );

  await harness.manager.begin(copilot);
  const status = await harness.manager.complete(copilot, { intervalMs: 1 });
  assert.equal(status.state, "error");
  assert.match(status.state === "error" ? status.message : "", /declined/i);
  assert.equal(harness.manager.credential("github-copilot"), undefined);
});

test("copilot status re-exchanges an expired Copilot token in the background", async () => {
  const harness = createHarness();
  const copilot = provider("github-copilot");
  harness.storage.set(oauthStorageKey("github-copilot"), {
    accessToken: "github-old",
    copilotToken: "copilot-old",
    copilotExpiresAt: 1_000,
    copilotApiBaseUrl: "https://api.githubcopilot.com",
    updatedAt: 1
  });
  harness.enqueue(
    jsonResponse(200, {
      token: "copilot-new",
      expires_at: 4_102_444_800,
      endpoints: { api: "https://api.githubcopilot.com" }
    })
  );

  const status = harness.manager.status(copilot);
  assert.equal(status.state, "connected", "status stays readable while the refresh runs");
  await harness.manager.settle();

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.headers?.["Authorization"], "token github-old");
  const stored = harness.manager.credential("github-copilot");
  assert.equal(stored?.copilotToken, "copilot-new");
  assert.equal(stored?.accessToken, "github-old");
  assert.equal(harness.manager.status(copilot).state, "connected");
});

test("a fresh Copilot token is not exchanged again", async () => {
  const harness = createHarness();
  const copilot = provider("github-copilot");
  harness.storage.set(oauthStorageKey("github-copilot"), {
    accessToken: "github",
    copilotToken: "copilot-fresh",
    copilotExpiresAt: Date.now() + 3_600_000,
    copilotApiBaseUrl: "https://api.githubcopilot.com",
    updatedAt: 1
  });

  assert.equal(harness.manager.status(copilot).state, "connected");
  await harness.manager.settle();
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Claude manual token and lifecycle                                           */
/* -------------------------------------------------------------------------- */

test("claude-oauth begins in manual mode and stores a pasted token", async () => {
  const harness = createHarness();
  const claude = provider("claude-oauth");

  assert.deepEqual(await harness.manager.begin(claude), { mode: "manual" });
  const status = await harness.manager.saveManualToken("claude-oauth", "  sk-ant-oat01-example  ");

  assert.equal(status.state, "connected");
  assert.equal(harness.manager.credential("claude-oauth")?.accessToken, "sk-ant-oat01-example");
  assert.equal(harness.manager.status(claude).state, "connected");
  assert.equal(harness.storage.size, 1);
  assert.ok(harness.storage.has(oauthStorageKey("claude-oauth")));
});

test("a manual token must not be empty", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.manager.saveManualToken(provider("claude-oauth"), "   "),
    (error: unknown) => error instanceof AiOAuthError && error.code === "invalid-token"
  );
  assert.equal(harness.storage.size, 0);
});

test("disconnect removes the stored credential and returns to disconnected", async () => {
  const harness = createHarness();
  const claude = provider("claude-oauth");
  await harness.manager.saveManualToken(claude, "token-1");
  assert.equal(harness.manager.status(claude).state, "connected");

  await harness.manager.disconnect("claude-oauth");

  assert.equal(harness.manager.status(claude).state, "disconnected");
  assert.equal(harness.manager.credential("claude-oauth"), undefined);
  assert.equal(harness.storage.size, 0);
});

test("non-OAuth providers are rejected by begin", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.manager.begin(provider("openai")),
    (error: unknown) => error instanceof AiOAuthError && error.code === "unsupported"
  );
  assert.equal(harness.requests.length, 0);
});

test("a damaged stored credential reads as disconnected", () => {
  const harness = createHarness();
  for (const damaged of [null, 42, { accessToken: 7 }, { accessToken: "" }, { junk: true }]) {
    harness.storage.set(oauthStorageKey("claude-oauth"), damaged);
    assert.equal(harness.manager.credential("claude-oauth"), undefined);
    assert.equal(harness.manager.status(provider("claude-oauth")).state, "disconnected");
  }
});

test("complete with no pending flow reports an error status instead of throwing", async () => {
  const harness = createHarness();
  const status = await harness.manager.complete(provider("chatgpt-oauth"), {});
  assert.equal(status.state, "error");
  assert.match(status.state === "error" ? status.message : "", /started again/i);
  assert.equal(harness.requests.length, 0);
});
