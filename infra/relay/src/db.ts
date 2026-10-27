import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

/**
 * The fork's relay database: Postgres on argo, published through a Cloudflare
 * Tunnel behind an Access service token. Migrations run separately, with
 * scripts/migrate-self-hosted.sh, against the database itself.
 */
export const RelayDatabaseOrigin = Effect.gen(function* () {
  return {
    scheme: "postgres" as const,
    host: yield* Config.NonEmptyString("RELAY_DB_HOST"),
    database: yield* Config.NonEmptyString("RELAY_DB_NAME").pipe(Config.withDefault("t3relay")),
    user: yield* Config.NonEmptyString("RELAY_DB_USER").pipe(Config.withDefault("t3relay")),
    password: yield* Config.Redacted("RELAY_DB_PASSWORD"),
    accessClientId: yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_ID"),
    accessClientSecret: yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_SECRET"),
  };
}).pipe(Effect.orDie);

export const RelayHyperdrive = Effect.gen(function* () {
  const origin = yield* RelayDatabaseOrigin;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin,
    // Alchemy builds a local-development origin for every binding and cannot
    // use one behind Access; locally, argo's Postgres is reachable directly.
    dev: {
      scheme: "postgres",
      host: "127.0.0.1",
      port: 5433,
      database: origin.database,
      user: origin.user,
      password: origin.password,
      sslmode: "require",
    },
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
});
