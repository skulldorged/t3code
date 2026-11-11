// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off -- This native I/O boundary owns the loopback callback deadline, HTTP exchange, and OS-encrypted token file.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { safeStorage, shell } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SelfHostedConnectSession } from "@t3tools/contracts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

class SessionRevokedError extends Schema.TaggedError<SessionRevokedError>()(
  "SessionRevokedError",
  {},
) {}

class SelfHostedConnectError extends Schema.TaggedError<SelfHostedConnectError>()(
  "SelfHostedConnectError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

type Session = SelfHostedConnectSession & { readonly refreshToken: string };
const sessionSchema = Schema.Struct({
  account: Schema.Struct({ id: Schema.String, email: Schema.optionalKey(Schema.String) }),
  accessToken: Schema.String,
  expiresAt: Schema.String,
});
const decodeSession = Schema.decodeUnknownSync(
  Schema.Struct({
    ...sessionSchema.fields,
    refreshToken: Schema.String,
  }),
);
const cache = new Map<string, Session>();
const pending = new Map<string, Promise<Session | null>>();
const operations = new Map<string, Promise<unknown>>();
function serialize<A>(origin: string, operation: () => Promise<A>): Promise<A> {
  const previous = operations.get(origin) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  operations.set(origin, current);
  return current.finally(() => {
    if (operations.get(origin) === current) operations.delete(origin);
  });
}
function originOf(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("A secure relay URL is required.");
  return url.origin;
}
function tokenPath(stateDir: string, origin: string) {
  return path.join(stateDir, "connect-auth", createHash("sha256").update(origin).digest("hex"));
}
async function saveSession(stateDir: string, origin: string, session: Session) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("OS secure storage is unavailable. T3 Connect cannot save this sign-in.");
  const file = tokenPath(stateDir, origin);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, safeStorage.encryptString(session.refreshToken), { mode: 0o600 });
  cache.set(origin, session);
  return publicSession(session);
}
function publicSession({ account, accessToken, expiresAt }: Session): SelfHostedConnectSession {
  return { account, accessToken, expiresAt };
}
async function readRefresh(stateDir: string, origin: string) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(await fs.readFile(tokenPath(stateDir, origin)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function post(origin: string, route: string, payload: unknown) {
  const response = await fetch(`${origin}/auth/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) throw new SessionRevokedError({});
  if (!response.ok) throw new Error("T3 Connect sign-in service is unavailable.");
  return response.json();
}
// Fork: a fleet key provisioned next to the server's secrets signs this app in for good.
const FLEET_KEY_EXPIRES_AT = "9999-12-31T23:59:59.000Z";
const decodeFleetAccount = Schema.decodeUnknownSync(
  Schema.Struct({ account: sessionSchema.fields.account }),
);
async function fleetSession(stateDir: string, origin: string): Promise<Session | null> {
  const key = await fs
    .readFile(path.join(stateDir, "secrets", "connect-fleet-key.bin"), "utf8")
    .then((value) => value.trim())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  if (!key.startsWith("t3f_")) return null;
  const response = await fetch(`${origin}/auth/session`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("T3 Connect did not accept this machine's fleet key.");
  const { account } = decodeFleetAccount(await response.json());
  const session: Session = {
    account,
    accessToken: key,
    expiresAt: FLEET_KEY_EXPIRES_AT,
    refreshToken: "",
  };
  cache.set(origin, session);
  return session;
}
async function refresh(stateDir: string, origin: string): Promise<Session | null> {
  const current = cache.get(origin);
  if (current && Date.parse(current.expiresAt) > Date.now() + 30_000) return current;
  const previous = pending.get(origin);
  if (previous) return previous;
  const operation = (async () => {
    const fleet = await fleetSession(stateDir, origin);
    if (fleet) return fleet;
    const refreshToken = await readRefresh(stateDir, origin);
    if (!refreshToken) return null;
    try {
      const session = decodeSession(await post(origin, "refresh", { refreshToken }));
      await saveSession(stateDir, origin, session);
      return session;
    } catch (error) {
      if (!Schema.is(SessionRevokedError)(error)) throw error;
      cache.delete(origin);
      await fs.unlink(tokenPath(stateDir, origin)).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
      });
      return null;
    }
  })();
  pending.set(origin, operation);
  try {
    return await operation;
  } finally {
    pending.delete(origin);
  }
}
async function signIn(stateDir: string, origin: string) {
  const fleet = await fleetSession(stateDir, origin);
  if (fleet) return publicSession(fleet);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let accept: (value: string) => void = () => {};
  const code = new Promise<string>((resolve) => {
    accept = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback" || !url.searchParams.get("code")) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
      .end("Signed in. You can return to T3 Code.");
    accept(url.searchParams.get("code")!);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not open the sign-in callback.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const start = (await post(origin, "start", {
      redirectUri,
      codeChallenge: challenge,
      clientKind: "native",
    })) as { authorizationUrl: string };
    if (
      typeof start.authorizationUrl !== "string" ||
      new URL(start.authorizationUrl).protocol !== "https:"
    )
      throw new Error("Invalid sign-in URL.");
    await shell.openExternal(start.authorizationUrl);
    const received = await Promise.race([
      code,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Sign-in timed out. Try again.")), 300_000);
      }),
    ]);
    const session = decodeSession(
      await post(origin, "exchange", {
        code: received,
        codeVerifier: verifier,
        redirectUri,
        clientKind: "native",
      }),
    );
    return await saveSession(stateDir, origin, session);
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}
function authHandler<A>(operation: (stateDir: string, origin: string) => Promise<A>) {
  return Effect.fn("desktop.ipc.selfHostedConnect")(function* (relayUrl: string) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => {
        const origin = originOf(relayUrl);
        return serialize(origin, () => operation(environment.stateDir, origin));
      },
      catch: (cause) =>
        new SelfHostedConnectError({
          detail: cause instanceof Error ? cause.message : "T3 Connect authentication failed.",
        }),
    });
  });
}
export const selfHostedConnectSignIn = makeIpcMethod({
  channel: IpcChannels.SELF_HOSTED_CONNECT_SIGN_IN,
  payload: Schema.String,
  result: sessionSchema,
  handler: authHandler(signIn),
});
export const selfHostedConnectRefresh = makeIpcMethod({
  channel: IpcChannels.SELF_HOSTED_CONNECT_REFRESH,
  payload: Schema.String,
  result: Schema.NullOr(sessionSchema),
  handler: authHandler(async (stateDir, origin) => {
    const session = await refresh(stateDir, origin);
    return session ? publicSession(session) : null;
  }),
});
export const selfHostedConnectSignOut = makeIpcMethod({
  channel: IpcChannels.SELF_HOSTED_CONNECT_SIGN_OUT,
  payload: Schema.String,
  result: Schema.Void,
  handler: authHandler(async (stateDir, origin) => {
    const refreshToken = await readRefresh(stateDir, origin);
    if (refreshToken)
      await post(origin, "logout", { refreshToken }).catch((cause: unknown) => {
        if (!Schema.is(SessionRevokedError)(cause)) throw cause;
      });
    cache.delete(origin);
    await fs.unlink(tokenPath(stateDir, origin)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }),
});
