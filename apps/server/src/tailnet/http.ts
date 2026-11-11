// Fork: routes the owner's own Tailscale devices use to find this fleet's
// machines and pair with them without a code. See TailnetFleet.ts.
import { AuthMcpClientAccess, mcpClientScopes } from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import { TailnetFleet } from "./TailnetFleet.ts";

const TAILNET_MACHINES_ROUTE = "/api/tailnet/machines";
export const TAILNET_PAIRING_ROUTE = "/api/tailnet/pairing";

const NO_STORE = { "cache-control": "no-store" };

const refuse = (status: number, message: string) =>
  HttpServerResponse.json({ message }, { status, headers: NO_STORE });

const PairingRequest = Schema.Struct({ access: Schema.optional(AuthMcpClientAccess) });
const decodePairingRequest = Schema.decodeUnknownEffect(PairingRequest);

const requestHost = (request: HttpServerRequest.HttpServerRequest) => {
  const host = request.headers.host ?? "";
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  return bracketed ? bracketed[1]! : host.replace(/:\d+$/, "");
};

/**
 * Who is asking, when it may be answered at all. Browser pages are refused:
 * any site the owner visits on a trusted device could otherwise fetch a
 * pairing code, and a rebound DNS name fails the host check. The desktop app's
 * own renderer is not a web page.
 */
const callerWith = Effect.fn("TailnetHttp.caller")(function* (fleet: TailnetFleet["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const origin = request.headers.origin;
  if (origin !== undefined && !DESKTOP_RENDERER_ORIGINS.some((allowed) => allowed === origin)) {
    return { _tag: "Refused" as const, response: refuse(403, "Browsers cannot use this route.") };
  }
  const host = requestHost(request);
  const address = deriveAuthClientMetadata({ request }).ipAddress;
  const loopback =
    isLocalLoopbackHost(host) && address !== undefined && isLocalLoopbackHost(address);
  if (!loopback && !isTailnetHost(host) && !isTailscaleIpv4Address(host)) {
    return {
      _tag: "Refused" as const,
      response: refuse(403, "Use this machine's Tailscale address."),
    };
  }
  const device = yield* fleet.ownDevice(address);
  return { _tag: "Allowed" as const, loopback, device };
});

const routes = (
  fleet: TailnetFleet["Service"],
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) => {
  const caller = callerWith(fleet);
  const machinesRoute = HttpRouter.add(
    "GET",
    TAILNET_MACHINES_ROUTE,
    Effect.gen(function* () {
      const asking = yield* caller;
      if (asking._tag === "Refused") return yield* asking.response;
      if (!asking.loopback && Option.isNone(asking.device)) {
        return yield* refuse(
          403,
          "Only the owner's own Tailscale devices can list these machines.",
        );
      }
      const machines = yield* fleet.machines;
      return yield* HttpServerResponse.json(
        {
          machines: machines.map(({ environmentId, label, httpBaseUrl }) => ({
            environmentId,
            label,
            httpBaseUrl,
          })),
        },
        { headers: NO_STORE },
      );
    }),
  );

  const MAX_BODY_BYTES = 4 * 1024;

  const pairingRoute = HttpRouter.add(
    "POST",
    TAILNET_PAIRING_ROUTE,
    Effect.gen(function* () {
      const asking = yield* caller;
      if (asking._tag === "Refused") return yield* asking.response;
      if (Option.isNone(asking.device)) {
        return yield* refuse(403, "Only the owner's other Tailscale devices can pair this way.");
      }
      const device = asking.device.value;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
        Effect.flatMap(decodePairingRequest),
        Effect.option,
      );
      if (Option.isNone(body)) return yield* refuse(400, "The request was not valid.");
      const access = body.value.access;
      return yield* auth
        // A peer link signs in with a plain code that carries its access level's
        // scopes; an app approval code (issuePairingCredential with access) is refused.
        .createPairingLink({
          label: `Tailscale · ${device.name}`,
          ...(access === undefined ? {} : { scopes: mcpClientScopes(access) }),
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("Issued a pairing code to a Tailscale device", {
              device: device.name,
              access: access ?? "client",
            }),
          ),
          Effect.flatMap((issued) =>
            HttpServerResponse.json(
              { credential: issued.credential, expiresAt: DateTime.formatIso(issued.expiresAt) },
              { headers: NO_STORE },
            ),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Could not issue a Tailscale pairing code", { error }).pipe(
              Effect.andThen(refuse(500, "This machine could not issue a pairing code.")),
            ),
          ),
        );
    }),
  );

  // The T3 Connect fleet key, for the owner's devices that are not provisioned with it (the
  // phone). Machines that run a T3 Code server are provisioned, so they, and the agents on
  // them, are refused.
  const connectKeyRoute = HttpRouter.add(
    "GET",
    "/api/tailnet/connect-key",
    Effect.gen(function* () {
      const asking = yield* caller;
      if (asking._tag === "Refused") return yield* asking.response;
      if (Option.isNone(asking.device)) {
        return yield* refuse(403, "Only the owner's other Tailscale devices can fetch this.");
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const address = deriveAuthClientMetadata({ request }).ipAddress;
      if ((yield* fleet.machines).some((machine) => machine.address === address)) {
        return yield* refuse(403, "Machines that run T3 Code are provisioned with this key.");
      }
      const key = yield* secrets.get("connect-fleet-key").pipe(Effect.option);
      if (Option.isNone(key) || Option.isNone(key.value)) {
        return yield* refuse(404, "This machine has no T3 Connect fleet key.");
      }
      yield* Effect.logInfo("Handed the T3 Connect fleet key to a Tailscale device", {
        device: asking.device.value.name,
      });
      return yield* HttpServerResponse.json(
        { key: new TextDecoder().decode(key.value.value).trim() },
        { headers: NO_STORE },
      );
    }),
  );

  return Layer.mergeAll(machinesRoute, pairingRoute, connectKeyRoute);
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    return routes(
      yield* TailnetFleet,
      yield* EnvironmentAuth.EnvironmentAuth,
      yield* ServerSecretStore.ServerSecretStore,
    );
  }),
);
