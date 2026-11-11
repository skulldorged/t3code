// Fork: saves every T3 Code machine on the owner's tailnet and pairs again when
// a credential stops working, using apps/server/src/tailnet's routes. Drop this
// once upstream's pingdotgg/t3code#26757 lands.
import type { EnvironmentId } from "@t3tools/contracts";
import { isSharedAddressSpaceHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionBlockedError } from "./model.ts";
import { connectionRoutes } from "./routes.ts";

/** The port T3 Code servers listen on when a typed tailnet host names none. */
const DEFAULT_TAILNET_PORT = "3773";
const REQUEST_TIMEOUT = Duration.seconds(10);
const RECONCILE_EVERY = Duration.minutes(2);
const FIRST_RECONCILE_AFTER = Duration.seconds(3);
// A machine that refuses is asked again later, not on every pass.
const RETRY_AFTER = Duration.minutes(5);

const MachinesResponse = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      label: Schema.String,
      httpBaseUrl: Schema.String,
    }),
  ),
});
const PairingResponse = Schema.Struct({ credential: Schema.String });

export interface TailnetMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

const isTailnetHostname = (hostname: string) =>
  isTailnetHost(hostname) || isSharedAddressSpaceHost(hostname);

/**
 * The server a typed address names, when it is a tailnet host given without a
 * pairing code: "polaris", "polaris.example.ts.net", or with a scheme and port.
 */
export function tailnetBaseUrlFor(input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): string | undefined {
  if ((input.pairingCode ?? "").trim() !== "") return undefined;
  const raw = (input.pairingUrl ?? input.host ?? "").trim();
  if (raw === "" || raw.includes("#") || raw.includes("?")) return undefined;
  const parsed = URL.parse(raw.includes("://") ? raw : `http://${raw}`);
  if (parsed === null || parsed.protocol !== "http:" || !isTailnetHostname(parsed.hostname)) {
    return undefined;
  }
  return `http://${parsed.hostname}:${parsed.port || DEFAULT_TAILNET_PORT}`;
}

const statusOk = Effect.map(HttpClient.HttpClient, HttpClient.filterStatusOk);

/** A one-time pairing code from the machine at `httpBaseUrl`, for this device. */
export const fetchTailnetPairingCode = Effect.fn("clientRuntime.tailnet.fetchPairingCode")(
  function* (httpBaseUrl: string) {
    const client = yield* statusOk;
    const response = yield* HttpClientRequest.post(`${httpBaseUrl}/api/tailnet/pairing`).pipe(
      HttpClientRequest.bodyJsonUnsafe({}),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PairingResponse)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    return response.credential;
  },
  (effect, httpBaseUrl) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("A tailnet machine refused a pairing code", { httpBaseUrl, cause }),
      ),
      Effect.mapError(
        () =>
          new ConnectionBlockedError({
            reason: "authentication",
            detail:
              "That machine did not hand out a pairing code. Check that it runs this T3 Code build and that this device is on its Tailscale account.",
          }),
      ),
    ),
);

const fetchTailnetMachines = Effect.fn("clientRuntime.tailnet.fetchMachines")(function* (
  httpBaseUrl: string,
) {
  const client = yield* statusOk;
  const response = yield* client
    .get(`${httpBaseUrl}/api/tailnet/machines`)
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(MachinesResponse)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
  return response.machines as ReadonlyArray<TailnetMachine>;
});

const origin = (url: string) => URL.parse(url)?.origin;

const ConnectKeyResponse = Schema.Struct({ key: Schema.String });

/** Where a client keeps the T3 Connect fleet key it fetches from one of the owner's machines. */
export interface TailnetFleetKeyReceiver {
  readonly wants: () => Promise<boolean>;
  readonly adopt: (key: string) => Promise<void>;
}
let fleetKeyReceiver: TailnetFleetKeyReceiver | undefined;
/** Clients without a provisioned fleet key (the phone) register where to keep one. */
export function setTailnetFleetKeyReceiver(receiver: TailnetFleetKeyReceiver) {
  fleetKeyReceiver = receiver;
}

const fetchConnectKey = Effect.fn("clientRuntime.tailnet.fetchConnectKey")(function* (
  httpBaseUrl: string,
) {
  const client = yield* statusOk;
  const response = yield* client
    .get(`${httpBaseUrl}/api/tailnet/connect-key`)
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ConnectKeyResponse)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
  return response.key;
});

/** Fetches the fleet key once, from the first tailnet machine that hands it out. */
const adoptFleetKey = Effect.fn("clientRuntime.tailnet.adoptFleetKey")(function* (
  servers: ReadonlyArray<string>,
) {
  const receiver = fleetKeyReceiver;
  if (receiver === undefined) return;
  if (!(yield* Effect.promise(() => receiver.wants().catch(() => false)))) return;
  for (const server of servers) {
    const hostname = URL.parse(server)?.hostname;
    if (hostname === undefined || !isTailnetHostname(hostname)) continue;
    const key = yield* fetchConnectKey(server).pipe(Effect.option);
    if (key._tag === "None") continue;
    yield* Effect.tryPromise({
      try: () => receiver.adopt(key.value),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "authentication",
          detail:
            cause instanceof Error ? cause.message : "Could not keep the T3 Connect fleet key.",
        }),
    });
    yield* Effect.logInfo("Signed in to T3 Connect with the fleet key", { from: server });
    return;
  }
});

/** Servers this client can already reach directly, to ask for the rest of the fleet. */
function knownServers(entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>) {
  const servers = new Set<string>();
  for (const entry of entries.values()) {
    for (const route of connectionRoutes(entry)) {
      if (route.target._tag === "PrimaryConnectionTarget") {
        servers.add(route.target.httpBaseUrl);
      } else if (
        Option.isSome(route.profile) &&
        route.profile.value._tag === "BearerConnectionProfile"
      ) {
        servers.add(route.profile.value.httpBaseUrl);
      }
    }
  }
  return [...servers];
}

/** Whether a saved environment already has a direct route to `machine` with its own credential. */
function hasOwnRoute(entry: ConnectionCatalogEntry, machine: TailnetMachine) {
  if (entry.target._tag === "PrimaryConnectionTarget") return true;
  const wanted = origin(machine.httpBaseUrl);
  return connectionRoutes(entry).some(
    (route) =>
      Option.isSome(route.profile) &&
      route.profile.value._tag === "BearerConnectionProfile" &&
      route.profile.value.authorization !== "t3-connect" &&
      origin(route.profile.value.httpBaseUrl) === wanted,
  );
}

/**
 * Keeps every machine of the owner's fleet saved and signed in. `pair` saves
 * a machine from a fresh code; `isSignedOut` says whether a saved one's
 * credential was refused.
 */
export const runTailnetFleet = Effect.fn("clientRuntime.tailnet.runFleet")(function* <E, R>(input: {
  readonly entries: SubscriptionRef.SubscriptionRef<
    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
  >;
  readonly isSignedOut: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
  readonly pair: (
    machine: TailnetMachine,
    options: { readonly saved: boolean },
  ) => Effect.Effect<void, E, R>;
}) {
  const attemptedAt = new Map<EnvironmentId, number>();

  const reconcile = Effect.gen(function* () {
    const entries = yield* SubscriptionRef.get(input.entries);
    const machines = new Map<EnvironmentId, TailnetMachine>();
    for (const server of knownServers(entries)) {
      const listed = yield* fetchTailnetMachines(server).pipe(Effect.orElseSucceed(() => []));
      for (const machine of listed) machines.set(machine.environmentId, machine);
    }
    yield* adoptFleetKey([
      ...knownServers(entries),
      ...[...machines.values()].map((machine) => machine.httpBaseUrl),
    ]).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not fetch the T3 Connect fleet key", { cause }),
      ),
    );
    for (const machine of machines.values()) {
      const saved = entries.get(machine.environmentId);
      const wanted =
        saved === undefined ||
        !hasOwnRoute(saved, machine) ||
        (saved.target._tag !== "PrimaryConnectionTarget" &&
          (yield* input.isSignedOut(machine.environmentId)));
      if (!wanted) continue;
      const now = yield* Clock.currentTimeMillis;
      const attempted = attemptedAt.get(machine.environmentId);
      if (attempted !== undefined && now - attempted < Duration.toMillis(RETRY_AFTER)) continue;
      attemptedAt.set(machine.environmentId, now);
      yield* input.pair(machine, { saved: saved !== undefined }).pipe(
        Effect.tap(() =>
          Effect.logInfo("Paired with a machine on the tailnet", { machine: machine.label }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not pair with a machine on the tailnet", {
            machine: machine.label,
            cause,
          }),
        ),
      );
    }
  });

  yield* reconcile.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Tailnet fleet check failed", { cause })),
    Effect.repeat(Schedule.spaced(RECONCILE_EVERY)),
    Effect.delay(FIRST_RECONCILE_AFTER),
  );
});
