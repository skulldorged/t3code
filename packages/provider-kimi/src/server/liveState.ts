import type {
  ProviderOptionDescriptor,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpSchema from "effect-acp/compat";

const MAX_MODELS = 128;
const MAX_COMMANDS = 256;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 1_024;

const boundedText = (value: string | null | undefined): string =>
  (value ?? "").trim().slice(0, MAX_TEXT_LENGTH);

const boundedId = (value: string): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= MAX_ID_LENGTH ? value : undefined;

export interface KimiLiveModel {
  readonly id: string;
  readonly name: string;
}

/** The model list and session options the latest Kimi session advertised. */
export interface KimiLiveConfiguration {
  readonly models: ReadonlyArray<KimiLiveModel>;
  readonly configOptions: ReadonlyArray<ProviderOptionDescriptor>;
}

/** The latest Kimi command advertisement, split into T3's `/` and `$` menus. */
export interface KimiAvailableCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface KimiLiveStateValue {
  readonly configuration: KimiLiveConfiguration | undefined;
  readonly commands: KimiAvailableCommands | undefined;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
}

function normalizeKimiLiveConfiguration(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState: AcpSessionModeState | undefined,
): KimiLiveConfiguration {
  const modelOption = configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const seen = new Set<string>();
  const models: Array<KimiLiveModel> = [];
  if (modelOption?.type === "select") {
    for (const entry of modelOption.options.flatMap((candidate) =>
      "value" in candidate ? [candidate] : candidate.options,
    )) {
      const id = boundedId(entry.value);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: boundedText(entry.name) || id });
      if (models.length === MAX_MODELS) break;
    }
  }
  return { models, configOptions: acpProviderOptionDescriptors({ configOptions, modeState }) };
}

export function normalizeKimiCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): KimiAvailableCommands {
  const seen = new Set<string>();
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const name = boundedId(command.name);
    if (name === undefined || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const description = boundedText(command.description);
    const hint = command.input ? boundedText(command.input.hint) : "";
    if (name.startsWith("$")) {
      const skillName = boundedId(name.slice(1));
      if (skillName === undefined) continue;
      skills.push({
        name: skillName,
        ...(description ? { description } : {}),
        path: `acp://skill/${encodeURIComponent(skillName)}`,
        scope: "agent",
        enabled: true,
      });
    } else {
      slashCommands.push({
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }
    if (slashCommands.length + skills.length === MAX_COMMANDS) break;
  }
  return { slashCommands, skills };
}

/**
 * What live sessions of one Kimi instance advertised, and the plan usage read
 * after their turns. Kimi lists models, options, and commands only inside a
 * session, and its usage token is fresh only after a turn, so the instance's
 * snapshot follows its sessions between status checks.
 */
export interface KimiLiveState {
  readonly get: Effect.Effect<KimiLiveStateValue>;
  readonly changes: Stream.Stream<KimiLiveStateValue>;
  readonly publishConfiguration: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    modeState: AcpSessionModeState | undefined,
  ) => Effect.Effect<void>;
  readonly publishCommands: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly publishUsageLimits: (usageLimits: ServerProviderUsageLimits) => Effect.Effect<void>;
}

export const makeKimiLiveState: Effect.Effect<KimiLiveState> = Effect.map(
  SubscriptionRef.make<KimiLiveStateValue>({
    configuration: undefined,
    commands: undefined,
    usageLimits: undefined,
  }),
  (ref) => ({
    get: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    publishConfiguration: (configOptions, modeState) =>
      SubscriptionRef.update(ref, (state) => ({
        ...state,
        configuration: normalizeKimiLiveConfiguration(configOptions, modeState),
      })),
    publishCommands: (commands) =>
      SubscriptionRef.update(ref, (state) => ({
        ...state,
        commands: normalizeKimiCommands(commands),
      })),
    publishUsageLimits: (usageLimits) =>
      SubscriptionRef.update(ref, (state) => ({ ...state, usageLimits })),
  }),
);
