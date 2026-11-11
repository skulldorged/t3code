// Fork: keeps a full-access peer link to every other T3 Code machine on the
// owner's tailnet. Link sessions last 30 days, so each is renewed a week early.
import { type EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "../peer/PeerLinks.ts";
import { TAILNET_PAIRING_ROUTE } from "./http.ts";
import { TailnetFleet, type TailnetMachine } from "./TailnetFleet.ts";

const RECONCILE_EVERY = Duration.minutes(10);
const FIRST_RECONCILE_AFTER = Duration.seconds(30);
const RENEW_WITHIN = Duration.days(7);
// A peer that refuses (an older build, the beta off there) is asked again later, not every run.
const RETRY_FAILED_AFTER = Duration.hours(1);

const PairingResponse = Schema.Struct({ credential: Schema.String });

const make = Effect.gen(function* () {
  const fleet = yield* TailnetFleet;
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const failedAt = new Map<EnvironmentId, number>();

  const pairingCode = (machine: TailnetMachine) =>
    HttpClientRequest.post(`${machine.httpBaseUrl}${TAILNET_PAIRING_ROUTE}`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ access: "full-access" }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PairingResponse)),
      Effect.map((response) => response.credential),
      Effect.timeout(Duration.seconds(15)),
    );

  const needsLink = Effect.fn("TailnetPeerLinker.needsLink")(function* (machine: TailnetMachine) {
    const existing = yield* links
      .get(machine.environmentId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(existing)) return true;
    const link = existing.value;
    const now = yield* DateTime.now;
    return (
      link.access !== "full-access" ||
      DateTime.isLessThan(link.expiresAt, DateTime.addDuration(now, RENEW_WITHIN))
    );
  });

  const linkTo = Effect.fn("TailnetPeerLinker.linkTo")(function* (machine: TailnetMachine) {
    const code = yield* pairingCode(machine);
    yield* links.link({
      url: machine.httpBaseUrl,
      pairingCode: code,
      access: "full-access",
      expectedEnvironmentId: machine.environmentId,
      expectedLabel: machine.label,
    });
  });

  const reconcile = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const machines = yield* fleet.machines;
    for (const machine of machines) {
      if (machine.self) continue;
      const now = yield* Clock.currentTimeMillis;
      const failed = failedAt.get(machine.environmentId);
      if (failed !== undefined && now - failed < Duration.toMillis(RETRY_FAILED_AFTER)) continue;
      if (!(yield* needsLink(machine))) continue;
      const linked = yield* linkTo(machine).pipe(Effect.result);
      if (linked._tag === "Success") {
        failedAt.delete(machine.environmentId);
        yield* Effect.logInfo("Linked a machine on the tailnet", { machine: machine.label });
      } else {
        failedAt.set(machine.environmentId, now);
        yield* Effect.logWarning("Could not link a machine on the tailnet", {
          machine: machine.label,
          cause: linked.failure,
        });
      }
    }
  });

  yield* reconcile.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Tailnet linking failed; trying again later", { cause }),
    ),
    Effect.repeat(Schedule.spaced(RECONCILE_EVERY)),
    Effect.delay(FIRST_RECONCILE_AFTER),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
