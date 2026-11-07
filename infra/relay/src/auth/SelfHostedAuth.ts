import { and, eq, gt, lt, sql } from "drizzle-orm";
import * as oauth from "oauth4webapi";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { relayAuthGrants } from "../persistence/schema.ts";

export type SelfHostedAuthPayload = {
  redirectUri?: string | undefined;
  challenge?: string | undefined;
  verifier?: string | undefined;
  nonce?: string | undefined;
  state?: string | undefined;
  cookie?: boolean | undefined;
  userId?: string | undefined;
  sessionId?: string | undefined;
  createdAt?: string | undefined;
  label?: string | undefined;
  deviceUserCode?: string | undefined;
  approved?: boolean | undefined;
  ciphertext?: string | undefined;
  clientState?: string | undefined;
};
type Payload = SelfHostedAuthPayload;

export interface SelfHostedAuthSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: Redacted.Redacted<string> | undefined;
  readonly allowedSubject: string;
  readonly accountId: string;
  readonly accountEmail?: string | undefined;
  readonly redirectUris: ReadonlyArray<string>;
  readonly sessionDays: number;
}
class AuthenticationFailed extends Schema.TaggedError<AuthenticationFailed>()(
  "SelfHostedAuthenticationFailed",
  {},
) {}
export class SelfHostedAuthUnavailable extends Schema.TaggedError<SelfHostedAuthUnavailable>()(
  "SelfHostedAuthUnavailable",
  { cause: Schema.Defect() },
) {}
const reject = (): never => {
  throw new AuthenticationFailed({});
};
const random = (prefix: string) => prefix + oauth.generateRandomCodeVerifier();
const digest = async (value: string) => oauth.calculatePKCECodeChallenge(value);
const cookieName = "__Secure-t3-connect";
const cookie = (value: string, days: number) =>
  `${cookieName}=${value}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(days * 86400)}`;
const bodyString = (body: Record<string, unknown>, name: string) =>
  typeof body[name] === "string" ? (body[name] as string) : "";

export class AuthRateLimiter extends Context.Service<
  AuthRateLimiter,
  {
    readonly allow: (key: string) => Effect.Effect<boolean>;
  }
>()("t3code-relay/auth/SelfHostedAuth/AuthRateLimiter") {}

export class SelfHostedAuth extends Context.Service<
  SelfHostedAuth,
  {
    readonly enabled: boolean;
    readonly verify: (
      token: string,
    ) => Effect.Effect<{ sub: string; sessionId: string } | null, SelfHostedAuthUnavailable>;
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3code-relay/auth/SelfHostedAuth") {}

export class LegacyTokenVerifier extends Context.Service<
  LegacyTokenVerifier,
  { readonly verify: (token: string) => Effect.Effect<{ sub: string }, SelfHostedAuthUnavailable> }
>()("t3code-relay/auth/SelfHostedAuth/LegacyTokenVerifier") {}

export const layer = Layer.effect(
  SelfHostedAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const db = yield* RelayDb.RelayDb;
    const limiter = yield* AuthRateLimiter;
    const legacyTokens = yield* LegacyTokenVerifier;
    const settings = config.selfHostedAuth;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const clock = yield* Clock.Clock;
    const secureRandom = yield* SecureRandom.SecureRandom;
    const now = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
    const future = (seconds: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe() + seconds * 1000));
    const get = async (hash: string, kind: string) =>
      (
        await run(
          db
            .select()
            .from(relayAuthGrants)
            .where(
              and(
                eq(relayAuthGrants.hash, hash),
                eq(relayAuthGrants.kind, kind),
                gt(relayAuthGrants.expiresAt, now()),
              ),
            ),
        )
      )[0];
    const consume = async (hash: string, kind: string) =>
      (
        await run(
          db
            .delete(relayAuthGrants)
            .where(
              and(
                eq(relayAuthGrants.hash, hash),
                eq(relayAuthGrants.kind, kind),
                gt(relayAuthGrants.expiresAt, now()),
              ),
            )
            .returning(),
        )
      )[0];
    const insert = (
      hash: string,
      kind: string,
      payload: Payload,
      seconds: number,
      accessHash?: string,
    ) =>
      run(
        db.insert(relayAuthGrants).values({
          hash,
          kind,
          payload,
          expiresAt: future(seconds),
          accessHash: accessHash ?? null,
        }),
      );
    let metadata: oauth.AuthorizationServer | undefined;
    const discover = async () => {
      if (!settings) return reject();
      if (metadata) return metadata;
      const issuer = new URL(settings.issuer);
      if (issuer.protocol !== "https:") return reject();
      const response = await oauth.discoveryRequest(issuer, { signal: AbortSignal.timeout(8000) });
      const discovered = await oauth.processDiscoveryResponse(issuer, response);
      if (!discovered.authorization_endpoint || !discovered.token_endpoint) return reject();
      for (const endpoint of [
        discovered.authorization_endpoint,
        discovered.token_endpoint,
        discovered.jwks_uri,
      ]) {
        if (endpoint && new URL(endpoint).protocol !== "https:") return reject();
      }
      metadata = discovered;
      return discovered;
    };
    const originAllowed = (origin: string | undefined) => {
      if (!origin || !settings) return true;
      if (origin === "t3code://app" || origin === new URL(config.relayIssuer).origin) return true;
      return settings.redirectUris.some((uri) => {
        const url = new URL(uri);
        return url.protocol === "https:" && url.origin === origin;
      });
    };
    const validRedirect = (uri: string, native: boolean) => {
      if (!settings) return false;
      if (
        settings.redirectUris.includes(uri) ||
        uri === new URL("/auth/device", config.relayIssuer).href
      )
        return true;
      if (!native) return false;
      const url = new URL(uri);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port !== "" &&
        Number(url.port) >= 1024 &&
        ["/auth/callback", "/connect-auth/callback", "/callback"].includes(url.pathname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    };
    const account = () => ({
      id: settings!.accountId,
      ...(settings!.accountEmail ? { email: settings!.accountEmail } : {}),
    });
    const sealingKey = awaitKey();
    function awaitKey() {
      return crypto.subtle
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            Redacted.value(config.cloudMintPrivateKey) + "/refresh-grace/v1",
          ),
        )
        .then((bytes) =>
          crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
        );
    }
    const seal = async (value: unknown) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await sealingKey,
        new TextEncoder().encode(JSON.stringify(value)),
      );
      return btoa(String.fromCharCode(...iv, ...new Uint8Array(encrypted)));
    };
    const unseal = async (ciphertext: string) => {
      const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        await sealingKey,
        bytes.slice(12),
      );
      return JSON.parse(new TextDecoder().decode(decrypted)) as {
        accessToken: string;
        refreshToken: string;
        expiresAt: string;
        cookie: boolean;
      };
    };
    const sessionExists = async (sessionId: string) =>
      (
        await run(
          db
            .select({ hash: relayAuthGrants.hash })
            .from(relayAuthGrants)
            .where(
              and(
                eq(relayAuthGrants.kind, "session"),
                gt(relayAuthGrants.expiresAt, now()),
                sql`${relayAuthGrants.payload}->>'sessionId' = ${sessionId}`,
              ),
            ),
        )
      )[0] !== undefined;
    const responseFor = (
      tokens: { accessToken: string; refreshToken: string; expiresAt: string; cookie: boolean },
      oauthFormat = false,
    ) => {
      const data = oauthFormat
        ? {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expires_in: 300,
            token_type: "Bearer",
          }
        : {
            account: account(),
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            ...(tokens.cookie ? {} : { refreshToken: tokens.refreshToken }),
          };
      return HttpServerResponse.jsonUnsafe(data, {
        headers: {
          "cache-control": "no-store",
          ...(tokens.cookie
            ? { "set-cookie": cookie(tokens.refreshToken, settings!.sessionDays) }
            : {}),
        },
      });
    };
    const graceResponse = async (hash: string, oauthFormat = false) => {
      const previous = await get(hash, "rotation");
      if (
        !previous?.payload.ciphertext ||
        !previous.payload.sessionId ||
        !(await sessionExists(previous.payload.sessionId))
      )
        return reject();
      return responseFor(await unseal(previous.payload.ciphertext), oauthFormat);
    };
    const sessionResponse = async (payload: Payload, oldHash?: string, oauthFormat = false) => {
      await run(db.delete(relayAuthGrants).where(lt(relayAuthGrants.expiresAt, now())));
      if (!settings || payload.userId !== settings.accountId || !payload.sessionId) return reject();
      const accessToken = random("t3s_");
      const refreshToken = random("t3r_");
      const expiresAt = future(300);
      const tokens = { accessToken, refreshToken, expiresAt, cookie: payload.cookie === true };
      const values = {
        hash: await digest(refreshToken),
        kind: "session",
        payload,
        expiresAt: future(settings.sessionDays * 86400),
      };
      const access = {
        hash: await digest(accessToken),
        kind: "access",
        payload: { userId: payload.userId, sessionId: payload.sessionId },
        expiresAt,
      };
      const previous = oldHash
        ? {
            hash: oldHash,
            kind: "rotation",
            payload: {
              sessionId: payload.sessionId,
              userId: payload.userId,
              cookie: payload.cookie,
              ciphertext: await seal(tokens),
            },
            expiresAt: future(30),
          }
        : undefined;
      const changed = await run(
        db.$client.withTransaction(
          Effect.gen(function* () {
            if (oldHash) {
              const rows = yield* db
                .update(relayAuthGrants)
                .set(values)
                .where(
                  and(
                    eq(relayAuthGrants.hash, oldHash),
                    eq(relayAuthGrants.kind, "session"),
                    gt(relayAuthGrants.expiresAt, now()),
                  ),
                )
                .returning({ hash: relayAuthGrants.hash });
              if (rows.length !== 1) return false;
            } else yield* db.insert(relayAuthGrants).values(values);
            yield* db.insert(relayAuthGrants).values(access);
            if (previous) yield* db.insert(relayAuthGrants).values(previous);
            return true;
          }),
        ),
      );
      return changed ? responseFor(tokens, oauthFormat) : graceResponse(oldHash!, oauthFormat);
    };
    const verify = Effect.fn("relay.self_hosted_auth.verify")(function* (token: string) {
      if (!settings || !token.startsWith("t3s_")) return null;
      return yield* Effect.tryPromise({
        try: async () => {
          const row = await get(await digest(token), "access");
          return row &&
            row.payload.userId === settings.accountId &&
            row.payload.sessionId &&
            (await sessionExists(row.payload.sessionId))
            ? { sub: settings.accountId, sessionId: row.payload.sessionId }
            : null;
        },
        catch: (cause) => new SelfHostedAuthUnavailable({ cause }),
      });
    });
    const handle = Effect.fn("relay.self_hosted_auth.handle")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const origin = request.headers.origin;
      const cors =
        origin && originAllowed(origin)
          ? {
              "access-control-allow-origin": origin,
              "access-control-allow-credentials": "true",
              "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
              "access-control-allow-headers": "content-type, authorization",
              vary: "Origin",
            }
          : {};
      const response = yield* Effect.tryPromise({
        try: async () => {
          const url = new URL(request.url, config.relayIssuer);
          if (!originAllowed(origin)) return HttpServerResponse.empty({ status: 403 });
          if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204 });
          if (request.method === "GET" && url.pathname === "/auth/config")
            return HttpServerResponse.jsonUnsafe(
              { enabled: Boolean(settings) },
              { headers: { "cache-control": "no-store" } },
            );
          if (!settings) return HttpServerResponse.empty({ status: 404 });
          if (
            ["/auth/start", "/auth/device_authorization", "/auth/device/approve"].includes(
              url.pathname,
            )
          ) {
            const address = request.headers["cf-connecting-ip"] ?? "unknown";
            if (!(await run(limiter.allow("self-auth:" + (await digest(address))))))
              return HttpServerResponse.jsonUnsafe(
                { error: "slow_down" },
                { status: 429, headers: { "retry-after": "60" } },
              );
          }
          const client: oauth.Client = { client_id: settings.clientId };
          if (request.method === "GET" && url.pathname === "/auth/callback") {
            const state = url.searchParams.get("state");
            if (!state) return reject();
            const row = await consume(await digest(state), "login");
            if (!row) return reject();
            const payload = row.payload;
            const as = await discover();
            const params = oauth.validateAuthResponse(as, client, url, payload.state);
            const auth = settings.clientSecret
              ? oauth.ClientSecretPost(Redacted.value(settings.clientSecret))
              : oauth.None();
            const tokenResponse = await oauth.authorizationCodeGrantRequest(
              as,
              client,
              auth,
              params,
              new URL("/auth/callback", config.relayIssuer).href,
              payload.verifier!,
              { signal: AbortSignal.timeout(8000) },
            );
            const tokens = await oauth.processAuthorizationCodeResponse(as, client, tokenResponse, {
              expectedNonce: payload.nonce!,
              requireIdToken: true,
            });
            await oauth.validateApplicationLevelSignature(as, tokenResponse, {
              signal: AbortSignal.timeout(8000),
            });
            const claims = oauth.getValidatedIdTokenClaims(tokens);
            if (!claims || claims.sub !== settings.allowedSubject) {
              await run(
                Effect.logWarning("Self-hosted sign-in rejected an account that is not allowed", {
                  subject: claims?.sub ?? null,
                }),
              );
              return reject();
            }
            const code = random("t3c_");
            await insert(
              await digest(code),
              "code",
              {
                redirectUri: payload.redirectUri,
                challenge: payload.challenge,
                cookie: payload.cookie,
                userId: settings.accountId,
                clientState: payload.clientState,
              },
              120,
            );
            const target = new URL(payload.redirectUri!);
            target.searchParams.set("code", code);
            if (payload.clientState) target.searchParams.set("state", payload.clientState);
            return HttpServerResponse.redirect(target.href, {
              headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
            });
          }
          if (request.method === "GET" && url.pathname === "/auth/device") {
            return HttpServerResponse.text(devicePage(new URL(config.relayIssuer).origin), {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy":
                  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
                "referrer-policy": "no-referrer",
              },
            });
          }
          const authorization = request.headers.authorization ?? "";
          if (url.pathname === "/auth/sessions" || url.pathname.startsWith("/auth/sessions/")) {
            const principal = await run(verify(authorization.replace(/^Bearer /i, "")));
            if (!principal) return reject();
            if (request.method === "GET" && url.pathname === "/auth/sessions") {
              const rows = await run(
                db
                  .select()
                  .from(relayAuthGrants)
                  .where(
                    and(
                      eq(relayAuthGrants.kind, "session"),
                      gt(relayAuthGrants.expiresAt, now()),
                      sql`${relayAuthGrants.payload}->>'userId' = ${principal.sub}`,
                    ),
                  ),
              );
              return HttpServerResponse.jsonUnsafe(
                {
                  sessions: rows
                    .filter((r) => r.payload.userId === principal.sub)
                    .map((r) => ({
                      id: r.payload.sessionId,
                      createdAt: r.payload.createdAt,
                      expiresAt: r.expiresAt,
                      label: r.payload.label,
                      current: r.payload.sessionId === principal.sessionId,
                    })),
                },
                { headers: { "cache-control": "no-store" } },
              );
            }
            if (request.method === "DELETE") {
              const sessionId = decodeURIComponent(url.pathname.slice("/auth/sessions/".length));
              await run(
                db
                  .delete(relayAuthGrants)
                  .where(
                    and(
                      sql`${relayAuthGrants.payload}->>'sessionId' = ${sessionId}`,
                      sql`${relayAuthGrants.payload}->>'userId' = ${principal.sub}`,
                    ),
                  ),
              );
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }
            return HttpServerResponse.empty({ status: 405 });
          }
          if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
          const raw = (request.headers["content-type"] ?? "").includes(
            "application/x-www-form-urlencoded",
          )
            ? Object.fromEntries(new URLSearchParams(await run(request.text)))
            : await run(request.json);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject();
          const body = raw as Record<string, unknown>;
          if (
            url.pathname === "/auth/token" &&
            body.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange"
          ) {
            if (
              body.client_id !== "t3-connect-cli" ||
              body.subject_token_type !== "urn:ietf:params:oauth:token-type:access_token"
            )
              return reject();
            const token = bodyString(body, "subject_token");
            if (!token || token.startsWith("t3s_")) return reject();
            const address = request.headers["cf-connecting-ip"] ?? "unknown";
            if (!(await run(limiter.allow("auth-migrate:" + (await digest(address)))))) {
              return HttpServerResponse.jsonUnsafe(
                { error: "slow_down" },
                {
                  status: 429,
                  headers: { "retry-after": "60" },
                },
              );
            }
            const principal = await run(legacyTokens.verify(token));
            if (principal.sub !== settings.accountId) return reject();
            return sessionResponse(
              {
                userId: principal.sub,
                sessionId: await run(secureRandom.uuidV4()),
                createdAt: now(),
                cookie: false,
                label: "T3 Code CLI",
              },
              undefined,
              true,
            );
          }
          if (url.pathname === "/auth/device_authorization") {
            const deviceCode = random("t3d_");
            const userCode = (await run(secureRandom.uuidV4()))
              .replaceAll("-", "")
              .slice(0, 12)
              .toUpperCase();
            await run(db.delete(relayAuthGrants).where(lt(relayAuthGrants.expiresAt, now())));
            await insert(await digest(deviceCode), "device", { deviceUserCode: userCode }, 600);
            const verificationUri = new URL("/auth/device", config.relayIssuer).href;
            return HttpServerResponse.jsonUnsafe(
              {
                device_code: deviceCode,
                user_code: userCode,
                verification_uri: verificationUri,
                verification_uri_complete: verificationUri + "?user_code=" + userCode,
                expires_in: 600,
                interval: 5,
              },
              { headers: { "cache-control": "no-store" } },
            );
          }
          if (url.pathname === "/auth/device/approve") {
            const principal = await run(verify(authorization.replace(/^Bearer /i, "")));
            if (!principal) return reject();
            const userCode = bodyString(body, "userCode").replaceAll("-", "").toUpperCase();
            if (!/^[A-F0-9]{12}$/.test(userCode)) return reject();
            const row = (
              await run(
                db
                  .select()
                  .from(relayAuthGrants)
                  .where(
                    and(
                      eq(relayAuthGrants.kind, "device"),
                      gt(relayAuthGrants.expiresAt, now()),
                      sql`${relayAuthGrants.payload}->>'deviceUserCode' = ${userCode}`,
                    ),
                  ),
              )
            )[0];
            if (!row) return reject();
            await run(
              db
                .update(relayAuthGrants)
                .set({ payload: { ...row.payload, approved: true, userId: principal.sub } })
                .where(eq(relayAuthGrants.hash, row.hash)),
            );
            return HttpServerResponse.jsonUnsafe({ ok: true });
          }
          if (
            url.pathname === "/auth/token" &&
            body.grant_type === "urn:ietf:params:oauth:grant-type:device_code"
          ) {
            const row = await get(await digest(bodyString(body, "device_code")), "device");
            if (!row)
              return HttpServerResponse.jsonUnsafe({ error: "expired_token" }, { status: 400 });
            if (!row.payload.approved)
              return HttpServerResponse.jsonUnsafe(
                { error: "authorization_pending" },
                { status: 400 },
              );
            if (!(await consume(row.hash, "device"))) return reject();
            return sessionResponse(
              {
                userId: settings.accountId,
                sessionId: await run(secureRandom.uuidV4()),
                createdAt: now(),
                cookie: false,
                label: "T3 Code CLI",
              },
              undefined,
              true,
            );
          }
          if (url.pathname === "/auth/start") {
            const redirectUri = bodyString(body, "redirectUri");
            const challenge = bodyString(body, "codeChallenge");
            const native = body.clientKind === "native" || body.clientKind === "cli";
            if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !validRedirect(redirectUri, native))
              return reject();
            const state = random("t3o_");
            const verifier = oauth.generateRandomCodeVerifier();
            const nonce = oauth.generateRandomNonce();
            const as = await discover();
            const authUrl = new URL(as.authorization_endpoint!);
            for (const [key, value] of Object.entries({
              client_id: settings.clientId,
              redirect_uri: new URL("/auth/callback", config.relayIssuer).href,
              response_type: "code",
              scope: "openid",
              state,
              nonce,
              code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
              code_challenge_method: "S256",
            }))
              authUrl.searchParams.set(key, value);
            await run(db.delete(relayAuthGrants).where(lt(relayAuthGrants.expiresAt, now())));
            await insert(
              await digest(state),
              "login",
              {
                redirectUri,
                challenge,
                verifier,
                nonce,
                state,
                cookie: body.clientKind === "web",
                clientState: bodyString(body, "state"),
              },
              600,
            );
            return HttpServerResponse.jsonUnsafe(
              { authorizationUrl: authUrl.href },
              { headers: { "cache-control": "no-store" } },
            );
          }
          if (
            url.pathname === "/auth/exchange" ||
            (url.pathname === "/auth/token" && body.grant_type === "authorization_code")
          ) {
            const code = bodyString(body, "code");
            const row = await get(await digest(code), "code");
            const verifier = bodyString(body, "codeVerifier") || bodyString(body, "code_verifier");
            if (
              !row ||
              !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
              row.payload.redirectUri !==
                (bodyString(body, "redirectUri") || bodyString(body, "redirect_uri")) ||
              row.payload.challenge !== (await digest(verifier))
            )
              return reject();
            if (!(await consume(row.hash, "code"))) return reject();
            return sessionResponse(
              {
                userId: settings.accountId,
                sessionId: await run(secureRandom.uuidV4()),
                createdAt: now(),
                cookie: row.payload.cookie,
                label: (request.headers["user-agent"] ?? "T3 Code").slice(0, 200),
              },
              undefined,
              url.pathname === "/auth/token",
            );
          }
          const cookieRefresh = request.headers.cookie
            ?.split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith(cookieName + "="))
            ?.slice(cookieName.length + 1);
          const refresh =
            bodyString(body, "refreshToken") ||
            bodyString(body, "refresh_token") ||
            cookieRefresh ||
            "";
          if (!refresh.startsWith("t3r_")) return reject();
          const hash = await digest(refresh);
          let row = await get(hash, "session");
          if (!row) row = await get(hash, "rotation");
          if (!row || !row.payload.sessionId || !(await sessionExists(row.payload.sessionId)))
            return reject();
          if (row.payload.cookie && (!origin || !originAllowed(origin))) return reject();
          if (
            url.pathname === "/auth/refresh" ||
            (url.pathname === "/auth/token" && body.grant_type === "refresh_token")
          )
            return row.kind === "rotation"
              ? graceResponse(hash, url.pathname === "/auth/token")
              : sessionResponse(row.payload, hash, url.pathname === "/auth/token");
          if (url.pathname === "/auth/logout") {
            await run(
              db
                .delete(relayAuthGrants)
                .where(sql`${relayAuthGrants.payload}->>'sessionId' = ${row.payload.sessionId}`),
            );
            return HttpServerResponse.jsonUnsafe(
              { ok: true },
              { headers: { "set-cookie": cookie("", 0), "cache-control": "no-store" } },
            );
          }
          return HttpServerResponse.empty({ status: 404 });
        },
        catch: (cause) =>
          Schema.is(AuthenticationFailed)(cause) ? cause : new SelfHostedAuthUnavailable({ cause }),
      }).pipe(
        Effect.catch((error) =>
          (Schema.is(AuthenticationFailed)(error)
            ? Effect.void
            : Effect.logError("Self-hosted auth request failed", {
                path: new URL(request.url, config.relayIssuer).pathname,
                cause: error.cause instanceof Error ? error.cause.stack : String(error.cause),
              })
          ).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe(
                {
                  error: Schema.is(AuthenticationFailed)(error)
                    ? "authentication_failed"
                    : "temporarily_unavailable",
                },
                {
                  status: Schema.is(AuthenticationFailed)(error) ? 401 : 503,
                  headers: { "cache-control": "no-store" },
                },
              ),
            ),
          ),
        ),
      );
      const oauthResponse =
        new URL(request.url, config.relayIssuer).pathname === "/auth/token" &&
        response.status === 401
          ? HttpServerResponse.jsonUnsafe(
              { error: "invalid_grant" },
              { status: 400, headers: { "cache-control": "no-store" } },
            )
          : response;
      return HttpServerResponse.setHeaders(oauthResponse, cors);
    });
    return SelfHostedAuth.of({ enabled: Boolean(settings), verify, handle });
  }),
);

export const layerRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* SelfHostedAuth;
    return HttpRouter.add(
      "*",
      "/auth/*",
      Effect.flatMap(HttpServerRequest.HttpServerRequest, service.handle),
    );
  }),
);

function devicePage(origin: string) {
  const safeOrigin = JSON.stringify(origin).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize T3 Connect</title><style>body{font:16px system-ui;max-width:30rem;margin:10vh auto;padding:1.5rem;color:#eee;background:#15151b}input,button{font:inherit;padding:.7rem;margin:.5rem 0}button{cursor:pointer}#status{white-space:pre-wrap}</style><h1>Connect this device</h1><p>Approve only a code shown by a T3 command you just ran.</p><label>Device code <input id="code" autocomplete="off"></label><br><button id="login">Sign in</button><button id="approve" hidden>Authorize device</button><p id="status"></p><script>
const origin=${safeOrigin},field=document.getElementById('code'),status=document.getElementById('status'),login=document.getElementById('login'),approve=document.getElementById('approve');
let access=null;field.value=new URL(location.href).searchParams.get('user_code')||sessionStorage.getItem('t3-device-code')||'';
const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const post=async(path,body,token)=>{const r=await fetch(origin+path,{method:'POST',credentials:'include',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});if(!r.ok)throw Error('Authorization failed. Please start again.');return r.json()};
login.onclick=async()=>{try{sessionStorage.setItem('t3-device-code',field.value);const verifier=encode(crypto.getRandomValues(new Uint8Array(32)));sessionStorage.setItem('t3-device-verifier',verifier);const challenge=encode(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));const result=await post('/auth/start',{redirectUri:origin+'/auth/device',codeChallenge:challenge,clientKind:'web'});location.assign(result.authorizationUrl)}catch(e){status.textContent=e.message}};
approve.onclick=async()=>{try{await post('/auth/device/approve',{userCode:field.value},access);sessionStorage.removeItem('t3-device-code');status.textContent='Device authorized. Return to your terminal.';approve.disabled=true}catch(e){status.textContent=e.message}};
(async()=>{const code=new URL(location.href).searchParams.get('code');if(!code)return;try{history.replaceState(null,'','/auth/device');const verifier=sessionStorage.getItem('t3-device-verifier');sessionStorage.removeItem('t3-device-verifier');const result=await post('/auth/exchange',{code,codeVerifier:verifier,redirectUri:origin+'/auth/device',clientKind:'web'});access=result.accessToken;login.hidden=true;approve.hidden=false;status.textContent='Signed in. Confirm the device code, then authorize.'}catch(e){status.textContent=e.message}})();
</script>`;
}
