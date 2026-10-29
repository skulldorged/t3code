import {
  type CustomModelSetting,
  KIMI_DEFAULT_MODEL,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import type * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { KimiSettings } from "../settings.ts";
import {
  deleteKimiSession,
  KIMI_SUPPORTED_RUNTIME_MODES,
  makeKimiAcpRuntime,
} from "./acpSupport.ts";
import {
  type KimiLiveConfiguration,
  type KimiLiveStateValue,
  makeKimiLiveState,
} from "./liveState.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi Code",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
  supportedRuntimeModes: KIMI_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// Kimi loads its config and opens a session store before answering.
const KIMI_PROBE_TIMEOUT_MS = 30_000;
// Commands arrive as a notification just after `session/new` answers.
const COMMAND_ADVERTISEMENT_GRACE_MS = 500;
const KIMI_INSTALL_HINT = "Install Kimi Code from https://moonshotai.github.io/kimi-code/.";
// T3's runtime mode and plan toggle own Kimi's session mode, so the session's
// own mode selector is not offered as a model option.
const KIMI_MODE_CONFIG_ID = "mode";

const KIMI_DEFAULT_MODEL_ENTRY: ServerProviderModel = {
  slug: KIMI_DEFAULT_MODEL,
  name: "Kimi default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

function kimiModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [KIMI_DEFAULT_MODEL_ENTRY],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * The models a Kimi session offers. The default alias stays first so a thread
 * that never picked a model keeps following `default_model` in Kimi's config.
 */
export function kimiModelsFromLiveConfiguration(
  configuration: KimiLiveConfiguration,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const optionDescriptors = configuration.configOptions.filter(
    (descriptor) => descriptor.id !== KIMI_MODE_CONFIG_ID,
  );
  const capabilities =
    optionDescriptors.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors });
  return kimiModelsFromSettings(customModels, [
    { ...KIMI_DEFAULT_MODEL_ENTRY, capabilities },
    ...configuration.models.map((model) => ({
      slug: model.id,
      name: model.name,
      isCustom: false,
      capabilities,
    })),
  ]);
}

/** Overlays what the instance's sessions advertised onto a status snapshot. */
export function applyKimiLiveState<P extends ServerProvider | ServerProviderDraft>(
  provider: P,
  state: KimiLiveStateValue,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): P {
  const commands = state.commands;
  const slashCommands =
    commands === undefined
      ? provider.slashCommands
      : commands.slashCommands.some((command) => command.name === COMPACT_SLASH_COMMAND.name)
        ? commands.slashCommands
        : [COMPACT_SLASH_COMMAND, ...commands.slashCommands];
  return {
    ...provider,
    ...(state.configuration === undefined
      ? {}
      : { models: kimiModelsFromLiveConfiguration(state.configuration, customModels) }),
    ...(commands === undefined ? {} : { slashCommands, skills: commands.skills }),
  };
}

export const buildInitialKimiProviderSnapshot = Effect.fn("buildInitialKimiProviderSnapshot")(
  function* (kimiSettings: KimiSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: kimiModelsFromSettings(kimiSettings.customModels),
      probe: {
        installed: kimiSettings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: kimiSettings.enabled
          ? "Checking Kimi Code..."
          : "Kimi Code is disabled in T3 Code settings.",
      },
    });
  },
);

/**
 * Opens one Kimi session to read the version, models, options, and commands,
 * then deletes it so status checks leave nothing in Kimi's session list. No
 * prompt is sent, so it spends no plan quota.
 */
const probeKimi = Effect.fn("probeKimi")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const live = yield* makeKimiLiveState;
  const commandsAdvertised = yield* Ref.make(false);
  const acp = yield* makeKimiAcpRuntime({
    kimiSettings,
    environment,
    childProcessSpawner,
    cwd,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    authenticateOnAuthRequired: false,
  });
  yield* acp.handleSessionUpdate((notification: EffectAcpSchema.SessionNotification) =>
    notification.update.sessionUpdate === "available_commands_update"
      ? live
          .publishCommands(notification.update.availableCommands)
          .pipe(Effect.andThen(Ref.set(commandsAdvertised, true)))
      : Effect.void,
  );
  const started = yield* acp.start();
  yield* live.publishConfiguration(yield* acp.getConfigOptions, yield* acp.getModeState);
  if (!(yield* Ref.get(commandsAdvertised))) {
    yield* Effect.sleep(COMMAND_ADVERTISEMENT_GRACE_MS);
  }
  yield* deleteKimiSession(acp, started.sessionId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not delete the Kimi status-check session.", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
  return {
    version: started.initializeResult.agentInfo?.version?.trim() || null,
    state: yield* live.get,
  };
}, Effect.scoped);

const isAuthRequired = (cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AcpRequestError" &&
    "code" in error &&
    error.code === -32000
  );
};

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = kimiModelsFromSettings(kimiSettings.customModels);

  if (!kimiSettings.enabled) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi Code is disabled in T3 Code settings.",
      },
    });
  }

  const probeExit = yield* probeKimi(kimiSettings, environment, cwd).pipe(
    Effect.timeoutOption(KIMI_PROBE_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isFailure(probeExit)) {
    const error = Option.getOrUndefined(Cause.findErrorOption(probeExit.cause));
    const missing = error?._tag === "AcpSpawnError" && isCommandMissingCause(error.cause);
    const signedOut = isAuthRequired(probeExit.cause);
    yield* Effect.logWarning("Kimi Code probe failed.", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: signedOut ? "unauthenticated" : "unknown" },
        message: missing
          ? `Kimi Code (\`${kimiSettings.binaryPath}\`) is not installed or not on PATH. ${KIMI_INSTALL_HINT}`
          : signedOut
            ? "Kimi Code is signed out. Run `kimi login` in a terminal."
            : "Kimi Code failed to start a session.",
      },
    });
  }

  if (Option.isNone(probeExit.value)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code timed out while starting a session.",
      },
    });
  }

  const probe = probeExit.value.value;
  return applyKimiLiveState(
    buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version: probe.version,
        status: "ready",
        // Kimi reports a missing login only when a prompt runs.
        auth: { status: "unknown" },
      },
    }),
    probe.state,
    kimiSettings.customModels,
  );
});

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
