import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { KimiSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { resolveUsageLimitsAfterProbe } from "@t3tools/provider-core/server/usageLimits";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { createKimiAdapterV2, type KimiAdapterV2DriverEnv } from "./adapter.ts";
import { makeKimiLiveState, type KimiLiveStateValue } from "./liveState.ts";
import {
  applyKimiLiveState,
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  enrichKimiSnapshot,
} from "./status.ts";
import { makeKimiTextGeneration } from "./textGeneration.ts";
import { readKimiUsageLimits } from "./usage.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const DRIVER_KIND = ProviderDriverKind.make("kimi");
// Kimi Code updates itself (`kimi upgrade`); T3 does not manage the install.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "kimi-code",
});

/** Adds a session's usage read to a snapshot, keeping the last good bars. */
function withLiveUsage<P extends ServerProvider | ServerProviderDraft>(
  provider: P,
  state: KimiLiveStateValue,
): P {
  if (state.usageLimits === undefined) return provider;
  if (provider.usageLimits === undefined) return { ...provider, usageLimits: state.usageLimits };
  const usageLimits = resolveUsageLimitsAfterProbe({
    published: state.usageLimits,
    probed: provider.usageLimits,
  });
  return usageLimits === undefined ? provider : { ...provider, usageLimits };
}

export type KimiDriverEnv =
  | KimiAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderLatestVersions.ProviderLatestVersions;

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kimi Code",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: Effect.fn("KimiDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies KimiSettings;
    const liveState = yield* makeKimiLiveState;
    const orchestrationAdapter = yield* createKimiAdapterV2({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
      liveState,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Kimi Code orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeKimiTextGeneration(effectiveConfig, processEnv);

    const readUsageLimits = readKimiUsageLimits(processEnv).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const checkProvider = checkKimiProviderStatus(effectiveConfig, processEnv, host.paths.cwd).pipe(
      Effect.filterOrElse(
        (draft) => !draft.enabled || !draft.installed || draft.status === "error",
        (draft) =>
          Effect.map(readUsageLimits, (usageLimits) => ({
            ...draft,
            usageLimits,
            // A stored Kimi login is what the usage read signs with.
            auth:
              usageLimits.unavailable?.reason === "unsupported"
                ? draft.auth
                : { status: "authenticated" as const, label: "Kimi account" },
          })),
      ),
      Effect.map((draft) => ({ ...stampIdentity(draft), supportsTextGeneration: true })),
      Effect.flatMap((provider) =>
        liveState.get.pipe(Effect.map((state) => withLiveUsage(provider, state))),
      ),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KimiSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialKimiProviderSnapshot(settings.provider).pipe(
          Effect.map((draft) => ({ ...stampIdentity(draft), supportsTextGeneration: true })),
        ),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, getSnapshot, publishSnapshot }) => {
        const publishAdvisory = enrichKimiSnapshot({
          snapshot: currentSnapshot,
          maintenanceCapabilities: MAINTENANCE,
          enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          publishSnapshot,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        );
        if (!currentSnapshot.installed) return publishAdvisory;
        // Republish whenever a live session advertises models or commands,
        // or a turn reads new plan usage.
        const followLiveState = liveState.changes.pipe(
          Stream.runForEach((state) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current: ServerProvider) =>
                  publishSnapshot(
                    withLiveUsage(
                      applyKimiLiveState(current, state, effectiveConfig.customModels),
                      state,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        return Effect.all([publishAdvisory, followLiveState], {
          concurrency: "unbounded",
          discard: true,
        });
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Kimi Code snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
