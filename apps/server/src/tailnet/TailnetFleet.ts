// Fork: a connection straight from an untagged node of this server's own
// Tailscale account is the owner. Drop this directory once upstream's
// pingdotgg/t3code#26757 lands.
import { EnvironmentId } from "@t3tools/contracts";
import { isTailnetHost } from "@t3tools/shared/hostClassification";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export interface TailnetDevice {
  readonly name: string;
}

export interface TailnetMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  /** This server. */
  readonly self: boolean;
}

export class TailnetFleet extends Context.Service<
  TailnetFleet,
  {
    /**
     * The owner's device a direct peer address belongs to: an untagged node of
     * this server's Tailscale account that routes no other network. This
     * machine's own node does not count, so local processes still pair.
     */
    readonly ownDevice: (
      address: string | undefined,
    ) => Effect.Effect<Option.Option<TailnetDevice>>;
    /** T3 Code servers on the owner's online machines, this one included. */
    readonly machines: Effect.Effect<ReadonlyArray<TailnetMachine>>;
  }
>()("t3/tailnet/TailnetFleet") {}

const WhoisJson = Schema.Struct({
  Node: Schema.Struct({
    Name: Schema.String,
    ComputedName: Schema.optional(Schema.String),
    Tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    Addresses: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    AllowedIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  UserProfile: Schema.Struct({ LoginName: Schema.String }),
});
type WhoisJson = typeof WhoisJson.Type;

const StatusPeer = Schema.Struct({
  DNSName: Schema.optional(Schema.String),
  TailscaleIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  Tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  Online: Schema.optional(Schema.Boolean),
  OS: Schema.optional(Schema.String),
});
const StatusJson = Schema.Struct({
  Self: Schema.optional(StatusPeer),
  Peer: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, StatusPeer))),
});
type StatusJson = typeof StatusJson.Type;

const decodeWhois = Schema.decodeUnknownEffect(Schema.fromJsonString(WhoisJson));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusJson));
const Descriptor = Schema.Struct({ environmentId: EnvironmentId, label: Schema.String });

const WHOIS_TTL = Duration.seconds(30);
const STATUS_TTL = Duration.minutes(1);
const MACHINES_TTL = Duration.minutes(1);
// Exit nodes advertise the default routes, but they never forward other
// devices into the tailnet, so they stay the owner's device.
const DEFAULT_ROUTES = new Set(["0.0.0.0/0", "::/0"]);
// Phones and tablets do not run T3 Code servers; probing them only waits.
const CLIENT_ONLY_OS = new Set(["android", "iOS"]);

const isTailnetAddress = (address: string) =>
  isTailscaleIpv4Address(address) || isTailnetHost(address);

const routesOnlyItself = (node: WhoisJson["Node"]) => {
  const own = new Set(node.Addresses ?? []);
  return (node.AllowedIPs ?? []).every((prefix) => own.has(prefix) || DEFAULT_ROUTES.has(prefix));
};

const dnsHost = (dnsName: string | undefined) =>
  dnsName === undefined || dnsName === "" ? undefined : dnsName.replace(/\.$/, "");

/** One value per key, reloaded once it is older than `ttl`. */
const memoize = <K, A>(ttl: Duration.Duration, load: (key: K) => Effect.Effect<A>) => {
  const values = new Map<K, { readonly at: number; readonly value: A }>();
  const ttlMillis = Duration.toMillis(ttl);
  return Effect.fnUntraced(function* (key: K) {
    const now = yield* Clock.currentTimeMillis;
    const cached = values.get(key);
    if (cached !== undefined && now - cached.at < ttlMillis) return cached.value;
    const value = yield* load(key);
    values.set(key, { at: now, value });
    return value;
  });
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const executable = (yield* HostProcess.Platform) === "win32" ? "tailscale.exe" : "tailscale";

  const tailscale = (args: ReadonlyArray<string>) =>
    runner
      .run({ command: executable, args, timeout: Duration.seconds(5) })
      .pipe(
        Effect.flatMap((output) =>
          Number(output.code) === 0 ? Effect.succeed(output.stdout) : Effect.fail(output),
        ),
      );

  const whois = memoize(WHOIS_TTL, (address: string) =>
    tailscale(["whois", "--json", address]).pipe(Effect.flatMap(decodeWhois), Effect.option),
  );

  const status = memoize(STATUS_TTL, (_: "status") =>
    tailscale(["status", "--json"]).pipe(
      Effect.flatMap(decodeStatus),
      Effect.tapError((cause) => Effect.logWarning("Could not read Tailscale status", { cause })),
      Effect.option,
    ),
  );

  const selfAddresses = status("status").pipe(
    Effect.map((current) =>
      Option.match(current, {
        onNone: () => [] as ReadonlyArray<string>,
        onSome: (value) => value.Self?.TailscaleIPs ?? [],
      }),
    ),
  );

  // Login names, not user ids: the ids exceed what a JSON number holds exactly.
  const ownerLogin = Effect.gen(function* () {
    const address = (yield* selfAddresses).find(isTailscaleIpv4Address);
    if (address === undefined) return Option.none<string>();
    return Option.map(yield* whois(address), (self) => self.UserProfile.LoginName);
  });

  const ownDevice: TailnetFleet["Service"]["ownDevice"] = Effect.fn("TailnetFleet.ownDevice")(
    function* (address) {
      if (address === undefined || !isTailnetAddress(address)) return Option.none();
      if ((yield* selfAddresses).includes(address)) return Option.none();
      const owner = yield* ownerLogin;
      const peer = yield* whois(address);
      if (Option.isNone(owner) || Option.isNone(peer)) return Option.none();
      const node = peer.value.Node;
      if (
        peer.value.UserProfile.LoginName !== owner.value ||
        (node.Tags ?? []).length > 0 ||
        !routesOnlyItself(node)
      ) {
        return Option.none();
      }
      return Option.some({ name: node.ComputedName ?? dnsHost(node.Name) ?? address });
    },
  );

  const baseUrl = (host: string) => `http://${host}:${config.port}`;

  /** The T3 Code environment answering at `url`, if any. Sends no credential. */
  const describe = (url: string) =>
    httpClient
      .get(`${url}/.well-known/t3/environment`)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Descriptor)),
        Effect.timeout(Duration.seconds(10)),
        Effect.option,
      );

  const loadMachines = Effect.gen(function* () {
    const current = yield* status("status");
    if (Option.isNone(current)) return [];
    const selfHost = dnsHost(current.value.Self?.DNSName);
    const candidates: Array<{ readonly host: string; readonly self: boolean }> = [];
    if (selfHost !== undefined) candidates.push({ host: selfHost, self: true });
    for (const peer of Object.values(current.value.Peer ?? {})) {
      const host = dnsHost(peer.DNSName);
      const address = (peer.TailscaleIPs ?? []).find(isTailscaleIpv4Address);
      if (
        host === undefined ||
        address === undefined ||
        peer.Online !== true ||
        (peer.Tags ?? []).length > 0 ||
        CLIENT_ONLY_OS.has(peer.OS ?? "")
      ) {
        continue;
      }
      if (Option.isSome(yield* ownDevice(address))) candidates.push({ host, self: false });
    }
    const found = yield* Effect.forEach(
      candidates,
      (candidate) =>
        describe(baseUrl(candidate.host)).pipe(
          Effect.map(
            Option.map((described): TailnetMachine => ({
              environmentId: described.environmentId,
              label: described.label,
              httpBaseUrl: baseUrl(candidate.host),
              self: candidate.self,
            })),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return found.flatMap((machine) => (Option.isSome(machine) ? [machine.value] : []));
  });

  const machines = memoize(MACHINES_TTL, (_: "machines") => loadMachines);

  return TailnetFleet.of({ ownDevice, machines: machines("machines") });
});

export const layer = Layer.effect(TailnetFleet, make).pipe(Layer.provide(ProcessRunner.layer));
