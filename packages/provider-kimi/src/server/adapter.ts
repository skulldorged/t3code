import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { KimiSettings } from "../settings.ts";
import {
  applyKimiAcpModelSelection,
  extractKimiElicitationForm,
  extractKimiPermissionQuestion,
  kimiPromptFailure,
  kimiSessionMode,
  kimiSilentTurnError,
  makeKimiAcpRuntime,
} from "./acpSupport.ts";
import type { KimiLiveState } from "./liveState.ts";
import { exhaustedKimiWindow, readKimiUsageLimits } from "./usage.ts";

export const KIMI_PROVIDER = ProviderDriverKind.make("kimi");
export const KIMI_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(KIMI_PROVIDER);
const DEFAULT_KIMI_SETTINGS = Schema.decodeSync(KimiSettings)({});

const KimiProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // Kimi switches its permission mode on the live session.
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

// Updates that show a turn did something. Kimi sends usage and title updates
// even for a turn its model never answered.
const TURN_OUTPUT_UPDATES: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

const UNKNOWN_SILENT_TURN_MESSAGE =
  "Kimi Code ended the turn without replying. It reports model errors only in its own interface; run `kimi` in a terminal to see what failed.";

function silentTurnError(usageLimits: ServerProviderUsageLimits) {
  const exhausted = exhaustedKimiWindow(usageLimits);
  return exhausted === undefined
    ? kimiSilentTurnError({ message: UNKNOWN_SILENT_TURN_MESSAGE, usageLimit: false })
    : kimiSilentTurnError({
        message: `Kimi Code's ${exhausted.label.toLowerCase()} usage limit is reached.`,
        usageLimit: true,
        resetAt: exhausted.resetsAt,
      });
}

/**
 * Kimi's ACP server settles a turn whose model request failed (a spent plan
 * quota, a provider error) as a normal `end_turn` with no output. After each
 * turn the plan usage is read, while Kimi's token is fresh, and a silent turn
 * fails with the limit that stopped it when there is one.
 */
const withKimiTurnChecks = Effect.fn("withKimiTurnChecks")(function* (input: {
  readonly makeRuntime: (
    transformSessionUpdate: (
      notification: EffectAcpSchema.SessionNotification,
    ) => EffectAcpSchema.SessionNotification,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly readUsageLimits: Effect.Effect<ServerProviderUsageLimits>;
  readonly liveState: KimiLiveState | undefined;
}) {
  let outputUpdates = 0;
  const runtime = yield* input.makeRuntime((notification) => {
    if (TURN_OUTPUT_UPDATES.has(notification.update.sessionUpdate)) outputUpdates += 1;
    return notification;
  });
  const prompt = Effect.fn("KimiAcpRuntime.prompt")(function* (
    payload: Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"]>[0],
    options?: Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"]>[1],
  ): Effect.fn.Return<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> {
    const before = outputUpdates;
    const result = yield* runtime.prompt(payload, options);
    const usageLimits = yield* input.readUsageLimits;
    if (usageLimits.unavailable === undefined && input.liveState !== undefined) {
      yield* input.liveState.publishUsageLimits(usageLimits);
    }
    if (result.stopReason === "end_turn" && outputUpdates === before) {
      return yield* silentTurnError(usageLimits);
    }
    return result;
  });
  return { ...runtime, prompt } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
});

export interface KimiAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: KimiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Reads the plan usage after a turn; fully provided by the caller. */
  readonly readUsageLimits: Effect.Effect<ServerProviderUsageLimits>;
  /** Publishes each live session's models, commands and usage to the instance snapshot. */
  readonly liveState?: KimiLiveState;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
}

function makeKimiAcpAdapterFlavor(
  options: KimiAdapterV2Options & {
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
): AcpAdapterV2Flavor {
  const liveState = options.liveState;
  return {
    driver: KIMI_PROVIDER,
    runtimeHarness: "Kimi Code",
    capabilities: KimiProviderCapabilitiesV2,
    supportsCompaction: true,
    makeRuntime: ({
      runtimePolicy: _runtimePolicy,
      processEnvironment,
      ...input
    }: AcpAdapterV2RuntimeInput) =>
      withKimiTurnChecks({
        makeRuntime: (transformSessionUpdate) =>
          makeKimiAcpRuntime({
            ...input,
            kimiSettings: options.settings,
            environment: { ...options.environment, ...processEnvironment },
            childProcessSpawner: options.childProcessSpawner,
            transformSessionUpdate,
          }),
        readUsageLimits: options.readUsageLimits,
        liveState,
      }),
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyKimiAcpModelSelection({
        runtime,
        model: modelSelection.model,
        mapError: (cause) => cause,
      }),
    sessionModeForPolicy: (policy) => kimiSessionMode(policy.runtimeMode),
    extractElicitationForm: extractKimiElicitationForm,
    extractPermissionQuestion: extractKimiPermissionQuestion,
    promptFailure: kimiPromptFailure,
    ...(liveState === undefined
      ? {}
      : {
          onAvailableCommandsUpdate: liveState.publishCommands,
          onSessionConfigurationUpdate: liveState.publishConfiguration,
        }),
  };
}

export const makeKimiAdapterV2 = Effect.fn("makeKimiAdapterV2")(function* (
  options: KimiAdapterV2Options,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeKimiAcpAdapterFlavor({ ...options, childProcessSpawner }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});

export type KimiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

/** Builds an instance's adapter; the driver passes the instance's live state. */
export const createKimiAdapterV2 = Effect.fn("KimiAdapterV2Driver.create")(
  function* (
    input: ProviderAdapterDriverCreateInput<KimiSettings> & {
      readonly liveState?: KimiLiveState;
    },
  ) {
    const hostEnvironment = yield* HostProcess.Environment;
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const environment = yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* makeKimiAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment,
      selfInvocation,
      continuationRequests,
      readUsageLimits: readKimiUsageLimits(environment).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      ...(input.liveState === undefined ? {} : { liveState: input.liveState }),
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: KIMI_PROVIDER,
          threadId,
        }),
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: KIMI_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create Kimi Code ACP adapter.",
            cause,
          }),
      ),
    ),
);

export const KimiAdapterV2Driver: ProviderAdapterDriver<KimiSettings, KimiAdapterV2DriverEnv> = {
  driverKind: KIMI_PROVIDER,
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => DEFAULT_KIMI_SETTINGS,
  create: (input) => createKimiAdapterV2(input),
};
