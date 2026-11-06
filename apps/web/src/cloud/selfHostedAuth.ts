import type { SelfHostedConnectSession } from "@t3tools/contracts";
import { resolveCloudPublicConfig } from "./publicConfig";

export const isSelfHostedConnect = () => resolveCloudPublicConfig().authMode === "self-hosted";
type State = {
  readonly isLoaded: boolean;
  readonly session: SelfHostedConnectSession | null;
  readonly error: string | null;
};
function readAccountMetadata(): SelfHostedConnectSession | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("t3.connect.account") ?? "null");
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
      return null;
    return {
      account: value as SelfHostedConnectSession["account"],
      accessToken: "",
      expiresAt: new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}
let state: State = {
  isLoaded: false,
  session: typeof window === "undefined" ? null : readAccountMetadata(),
  error: null,
};
const listeners = new Set<() => void>();
const accountListeners = new Set<(resources: { user: { id: string } | null }) => void>();
let pending: Promise<SelfHostedConnectSession | null> | null = null;
let initialized: Promise<void> | null = null;
let generation = 0;
function publish(session: SelfHostedConnectSession | null, error: string | null = null) {
  state = { isLoaded: true, session, error };
  try {
    if (session) localStorage.setItem("t3.connect.account", JSON.stringify(session.account));
    else localStorage.removeItem("t3.connect.account");
  } catch {}
  for (const listener of listeners) listener();
  for (const listener of accountListeners) listener({ user: session?.account ?? null });
}
const relay = () => resolveCloudPublicConfig().relayUrl!;
async function post(route: string, payload: unknown) {
  const response = await fetch(new URL(`/auth/${route}`, relay()), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("T3 Connect authentication is temporarily unavailable.");
  return response.json();
}
function decodeSession(value: unknown): SelfHostedConnectSession | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !("accessToken" in value) ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !("account" in value) ||
    !value.account ||
    typeof value.account !== "object" ||
    !("id" in value.account) ||
    typeof value.account.id !== "string" ||
    !value.account.id
  )
    throw new Error("Invalid T3 Connect session response.");
  return value as SelfHostedConnectSession;
}
async function refresh() {
  if (state.session && Date.parse(state.session.expiresAt) > Date.now() + 30_000)
    return state.session;
  if (pending) return pending;
  const epoch = generation;
  pending = (async () => {
    const session = window.desktopBridge
      ? await window.desktopBridge.refreshSelfHostedConnect(relay())
      : decodeSession(await post("refresh", { mode: "cookie", clientKind: "web" }));
    if (epoch === generation) publish(session);
    return epoch === generation ? session : null;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}
async function bootstrap() {
  if (initialized) return initialized;
  initialized = (async () => {
    const url = new URL(window.location.href);
    const flow = sessionStorage.getItem("t3.connect.auth-flow");
    if (!window.desktopBridge && url.pathname === "/auth/connect/callback" && flow) {
      sessionStorage.removeItem("t3.connect.auth-flow");
      const saved = JSON.parse(flow) as {
        verifier: string;
        redirectUri: string;
        returnUrl: string;
      };
      window.history.replaceState(null, "", saved.returnUrl);
      const code = url.searchParams.get("code");
      if (!code) throw new Error("T3 Connect sign-in did not complete.");
      publish(
        decodeSession(
          await post("exchange", {
            code,
            codeVerifier: saved.verifier,
            redirectUri: saved.redirectUri,
            mode: "cookie",
            clientKind: "web",
          }),
        ),
      );
      return;
    }
    await refresh();
  })().catch((error: unknown) => {
    state = {
      ...state,
      isLoaded: true,
      error: error instanceof Error ? error.message : "Could not load T3 Connect sign-in.",
    };
    for (const listener of listeners) listener();
    if (state.session)
      for (const listener of accountListeners) listener({ user: state.session.account });
  });
  return initialized;
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
async function signIn() {
  if (window.desktopBridge) {
    const session = await window.desktopBridge.signInSelfHostedConnect(relay());
    generation += 1;
    publish(session);
    return;
  }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const redirectUri = `${window.location.origin}/auth/connect/callback`;
  const start = await post("start", { redirectUri, codeChallenge: challenge, clientKind: "web" });
  if (
    !start ||
    typeof start.authorizationUrl !== "string" ||
    new URL(start.authorizationUrl).protocol !== "https:"
  )
    throw new Error("Invalid T3 Connect sign-in URL.");
  sessionStorage.setItem(
    "t3.connect.auth-flow",
    JSON.stringify({ verifier, redirectUri, returnUrl: window.location.href }),
  );
  window.location.assign(start.authorizationUrl);
}
async function signOut() {
  if (window.desktopBridge) await window.desktopBridge.signOutSelfHostedConnect(relay());
  else await post("logout", { mode: "cookie", clientKind: "web" });
  generation += 1;
  publish(null);
}
export const selfHostedAuth = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  addListener: (listener: (resources: { user: { id: string } | null }) => void) => {
    accountListeners.add(listener);
    if (state.isLoaded && (state.session || state.error === null))
      listener({ user: state.session?.account ?? null });
    return () => {
      accountListeners.delete(listener);
    };
  },
  bootstrap,
  signIn,
  signOut,
  getToken: async (_options?: unknown) => (await refresh())?.accessToken ?? null,
};
