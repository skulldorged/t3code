import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { resolveCloudPublicConfig } from "./publicConfig";

interface Account {
  readonly id: string;
  readonly email?: string;
}
interface StoredSession {
  readonly account: Account;
  readonly refreshToken: string;
  readonly relayUrl?: string;
}
interface SessionResponse extends StoredSession {
  readonly accessToken: string;
  readonly expiresAt: string;
}
interface AuthState {
  readonly loaded: boolean;
  readonly account: Account | null;
  readonly error: string | null;
}

const storageKey = "t3-connect-self-hosted-session-v1";
const storageOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
let state: AuthState = { loaded: false, account: null, error: null };
let stored: StoredSession | null = null;
let access: { readonly token: string; readonly expiresAt: number } | null = null;
let loadOperation: Promise<void> | null = null;
let refreshOperation: Promise<string | null> | null = null;
let signInOperation: Promise<void> | null = null;
let epoch = 0;
let storageOperation: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export const selfHostedAuthEnabled = resolveCloudPublicConfig().relay.authMode === "self-hosted";

function publish(account: Account | null) {
  state = { loaded: true, account, error: null };
  for (const listener of listeners) listener();
}

function relayUrl(path: string): string {
  const base = resolveCloudPublicConfig().relay.url;
  if (!base) throw new Error("T3 Connect is not configured.");
  return new URL(path, base).toString();
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(relayUrl(path), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function request(path: string, body: unknown): Promise<Response> {
  return authFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function decodeSession(value: unknown): SessionResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid sign-in response.");
  const session = value as Partial<SessionResponse>;
  if (
    typeof session.account?.id !== "string" ||
    !session.account.id ||
    typeof session.refreshToken !== "string" ||
    !session.refreshToken ||
    typeof session.accessToken !== "string" ||
    !session.accessToken ||
    typeof session.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(session.expiresAt))
  )
    throw new Error("Invalid sign-in response.");
  return session as SessionResponse;
}

function changeStorage(operation: () => Promise<void>): Promise<void> {
  const next = storageOperation.then(operation);
  storageOperation = next.catch(() => undefined);
  return next;
}

async function save(session: SessionResponse, operationEpoch: number) {
  if (operationEpoch !== epoch) return;
  const next = {
    account: session.account,
    refreshToken: session.refreshToken,
    relayUrl: resolveCloudPublicConfig().relay.url ?? undefined,
  };
  await changeStorage(async () => {
    if (operationEpoch === epoch)
      await SecureStore.setItemAsync(storageKey, JSON.stringify(next), storageOptions);
  });
  if (operationEpoch !== epoch) return;
  stored = next;
  access = { token: session.accessToken, expiresAt: Date.parse(session.expiresAt) };
  publish(session.account);
}

async function clear(operationEpoch: number = epoch) {
  if (operationEpoch !== epoch) return;
  stored = null;
  access = null;
  publish(null);
  await changeStorage(async () => {
    if (operationEpoch === epoch) await SecureStore.deleteItemAsync(storageKey);
  });
}

export function loadSelfHostedAuth(): Promise<void> {
  if (loadOperation) return loadOperation;
  loadOperation = (async () => {
    const operationEpoch = epoch;
    await storageOperation;
    const raw = await SecureStore.getItemAsync(storageKey, storageOptions);
    if (operationEpoch !== epoch) return;
    if (raw) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      if (value && typeof value === "object" && "account" in value && "refreshToken" in value) {
        const candidate = value as Partial<StoredSession>;
        if (
          typeof candidate.account?.id === "string" &&
          typeof candidate.refreshToken === "string" &&
          candidate.relayUrl === resolveCloudPublicConfig().relay.url
        ) {
          stored = candidate as StoredSession;
        }
      }
    }
    publish(stored?.account ?? null);
  })().catch((error) => {
    loadOperation = null;
    state = { ...state, error: "Could not read the saved sign-in on this device." };
    for (const listener of listeners) listener();
    throw error;
  });
  return loadOperation;
}

export function readSelfHostedToken(): Promise<string | null> {
  if (refreshOperation) return refreshOperation;
  const operationEpoch = epoch;
  const operation = (async () => {
    await loadSelfHostedAuth();
    if (operationEpoch !== epoch || !stored) return null;
    if (access && access.expiresAt > Date.now() + 60_000) return access.token;
    const response = await request("/auth/refresh", { refreshToken: stored.refreshToken });
    if (operationEpoch !== epoch) return null;
    if (response.status === 401 || response.status === 403) {
      epoch += 1;
      await clear();
      return null;
    }
    if (!response.ok)
      throw new Error("T3 Connect could not refresh your sign-in. Try again shortly.");
    const session = decodeSession(await response.json());
    await save(session, operationEpoch);
    return operationEpoch === epoch ? session.accessToken : null;
  })();
  refreshOperation = operation.finally(() => {
    refreshOperation = null;
  });
  return refreshOperation;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function signInSelfHosted(): Promise<void> {
  if (signInOperation) return signInOperation;
  const operation = (async () => {
    const operationEpoch = ++epoch;
    const codeVerifier = base64Url(Crypto.getRandomBytes(32));
    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      codeVerifier,
      {
        encoding: Crypto.CryptoEncoding.BASE64,
      },
    );
    const codeChallenge = digest.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const schemes = Constants.expoConfig?.scheme;
    const scheme = Array.isArray(schemes) ? schemes[0] : schemes;
    if (!scheme) throw new Error("This app has no sign-in callback configured.");
    const redirectUri = `${scheme}://connect-auth/callback`;
    const start = await request("/auth/start", { redirectUri, codeChallenge });
    if (!start.ok) throw new Error("T3 Connect could not start sign-in.");
    const body: unknown = await start.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("authorizationUrl" in body) ||
      typeof body.authorizationUrl !== "string"
    ) {
      throw new Error("Invalid sign-in response.");
    }
    const authorizationUrl = new URL(body.authorizationUrl);
    if (authorizationUrl.protocol !== "https:") throw new Error("Sign-in requires HTTPS.");
    const result = await WebBrowser.openAuthSessionAsync(authorizationUrl.toString(), redirectUri);
    if (result.type !== "success") return;
    const callback = new URL(result.url);
    if (`${callback.protocol}//${callback.host}${callback.pathname}` !== redirectUri) {
      throw new Error("Unexpected sign-in callback.");
    }
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Sign-in was not completed.");
    const response = await request("/auth/exchange", { code, codeVerifier, redirectUri });
    if (!response.ok) throw new Error("T3 Connect could not complete sign-in.");
    await save(decodeSession(await response.json()), operationEpoch);
  })();
  signInOperation = operation.finally(() => {
    signInOperation = null;
  });
  return signInOperation;
}

export async function signOutSelfHosted(): Promise<void> {
  const operationEpoch = ++epoch;
  const refreshToken = stored?.refreshToken;
  if (refreshToken) {
    const response = await request("/auth/logout", { refreshToken });
    if (!response.ok && response.status !== 401)
      throw new Error("Could not revoke this device. Try signing out again.");
  }
  await clear(operationEpoch);
}

export const selfHostedAuth = {
  get loaded() {
    return state.loaded;
  },
  get session() {
    return state.account
      ? { user: state.account, getToken: (_options?: unknown) => readSelfHostedToken() }
      : null;
  },
  load: loadSelfHostedAuth,
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  addListener(listener: (resources: { readonly user?: { readonly id: string } | null }) => void) {
    const notify = () => {
      if (state.loaded) listener({ user: state.account });
    };
    const release = this.subscribe(notify);
    if (state.loaded) notify();
    return release;
  },
};

export interface SelfHostedDeviceSession {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export async function listSelfHostedSessions(): Promise<ReadonlyArray<SelfHostedDeviceSession>> {
  const token = await readSelfHostedToken();
  if (!token) throw new Error("Sign in to manage your devices.");
  const response = await authFetch("/auth/sessions", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not load signed-in devices.");
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("sessions" in value) ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("Invalid signed-in device response.");
  }
  return value.sessions.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("label" in entry) ||
      typeof entry.label !== "string" ||
      !("createdAt" in entry) ||
      typeof entry.createdAt !== "string" ||
      !("expiresAt" in entry) ||
      typeof entry.expiresAt !== "string"
    ) {
      throw new Error("Invalid signed-in device response.");
    }
    return {
      id: entry.id,
      label: entry.label,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  });
}

export async function revokeSelfHostedSession(id: string): Promise<void> {
  const token = await readSelfHostedToken();
  if (!token) throw new Error("Sign in to manage your devices.");
  const response = await authFetch(`/auth/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Could not revoke the device session.");
}
