import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

// Kimi Code's managed plan endpoints, by the region `kimi login` stored.
const KIMI_CODE_BASE_URLS = {
  "mainland-cn": "https://api.kimi.com/coding/v1",
  global: "https://api.kimi.ai/coding/v1",
} as const;

const KimiCredentials = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
});
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(KimiCredentials));

const KimiQuotaEntry = Schema.Struct({
  used_ratio: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  reset_time: Schema.optional(Schema.String),
});
const KimiUsageResponse = Schema.Struct({
  usages: Schema.optional(
    Schema.Struct({
      limit_5h: Schema.optional(KimiQuotaEntry),
      limit_7d: Schema.optional(KimiQuotaEntry),
      limit_month_total: Schema.optional(KimiQuotaEntry),
    }),
  ),
});

const WINDOWS = [
  { key: "limit_5h", id: "5h", kind: "session", label: "5-hour", windowDurationMins: 300 },
  { key: "limit_7d", id: "7d", kind: "weekly", label: "Weekly", windowDurationMins: 10_080 },
  { key: "limit_month_total", id: "month", kind: "monthly", label: "Monthly" },
] as const;

export function kimiUsageResponseToLimits(
  response: typeof KimiUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows: Array<ServerProviderUsageWindow> = [];
  for (const spec of WINDOWS) {
    const entry = response.usages?.[spec.key];
    const ratio = Number(entry?.used_ratio);
    if (entry === undefined || !Number.isFinite(ratio)) continue;
    const reset = entry.reset_time ? DateTime.make(entry.reset_time) : Option.none();
    windows.push({
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      usedPercent: clampPercent(ratio * 100),
      ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      ...("windowDurationMins" in spec ? { windowDurationMins: spec.windowDurationMins } : {}),
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

/** The exhausted window that blocks work longest, if any. */
export function exhaustedKimiWindow(
  limits: ServerProviderUsageLimits,
): ServerProviderUsageWindow | undefined {
  return limits.windows
    .filter((window) => window.usedPercent >= 100)
    .toSorted((left, right) => (right.resetsAt ?? "").localeCompare(left.resetsAt ?? ""))[0];
}

const readOptionalFile = Effect.fn("readOptionalKimiFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
    }),
  );
});

/**
 * Reads the plan's usage windows with the token `kimi login` stores. Kimi Code
 * refreshes that token itself and it lives 15 minutes, so a stale token reports
 * a failed probe (keeping the last bars) rather than refreshing it here: a
 * second refresher could rotate the token out from under the CLI.
 */
export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Kimi Code could not read usage limits.",
  });
  return yield* Effect.gen(function* () {
    const path = yield* Path.Path;
    const home =
      environment.KIMI_CODE_HOME?.trim() ||
      path.join(
        environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".kimi-code",
      );
    const credentialsFile = yield* readOptionalFile(
      path.join(home, "credentials", "kimi-code.json"),
    );
    // No Kimi account login: the CLI runs on its own API-key providers.
    if (Option.isNone(credentialsFile)) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const credentials = yield* decodeCredentials(credentialsFile.value);
    const token = credentials.access_token?.trim();
    const nowSeconds = Date.parse(checkedAt) / 1000;
    if (!token || (credentials.expires_at !== undefined && credentials.expires_at <= nowSeconds)) {
      return probeFailed;
    }
    const region = Option.getOrUndefined(yield* readOptionalFile(path.join(home, "region")));
    const baseUrl = (
      environment.KIMI_CODE_BASE_URL?.trim() ||
      (region?.trim() === "global"
        ? KIMI_CODE_BASE_URLS.global
        : KIMI_CODE_BASE_URLS["mainland-cn"])
    ).replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${baseUrl}/usages`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(KimiUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return kimiUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => probeFailed),
  );
});
