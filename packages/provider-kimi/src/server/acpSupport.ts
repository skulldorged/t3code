import type * as EffectAcpSchema from "effect-acp/compat";
import {
  KIMI_DEFAULT_MODEL,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
  type RuntimeMode,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { KimiSettings } from "../settings.ts";

type KimiAcpRuntimeSettings = Pick<KimiSettings, "binaryPath">;

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Kimi enforces every runtime mode itself except edit-only approval, which
 * stays on Kimi's manual mode and lets T3's policy approve the edits.
 */
export const KIMI_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** Kimi's native session mode for a runtime mode. Plan mode is applied by the ACP adapter. */
export function kimiSessionMode(runtimeMode: RuntimeMode | undefined): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto":
      return "auto";
    default:
      return "default";
  }
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    env: { ...environment },
  };
}

export const makeKimiAcpRuntime = Effect.fn("makeKimiAcpRuntime")(function* (
  input: KimiAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const { kimiSettings, environment, childProcessSpawner, ...options } = input;
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...options,
      spawn: buildKimiAcpSpawnInput(kimiSettings, input.cwd, environment),
    }).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

/**
 * Deletes a session T3 opened only to read configuration or generate text, so
 * it stays out of Kimi's session list. Kimi speaks ACP v1 yet supports
 * `session/delete`, which the typed client offers only on v2.
 */
export const deleteKimiSession = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
) => runtime.request("session/delete", { sessionId }).pipe(Effect.asVoid);

function kimiModelOptions(configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) {
  const model = configOptions.find((option) => option.category === "model");
  if (model?.type !== "select") return { configId: undefined, current: undefined, values: [] };
  return {
    configId: model.id,
    current: model.currentValue,
    values: model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options)),
  };
}

/**
 * Applies a thread's model. The default alias keeps the model Kimi's config
 * selects and is never sent. A saved model the account no longer offers fails
 * with a message rather than silently running on another model.
 */
export const applyKimiAcpModelSelection = Effect.fn("applyKimiAcpModelSelection")(function* <
  E,
>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | undefined, E> {
  const configOptions = yield* input.runtime.getConfigOptions;
  const { configId, current, values } = kimiModelOptions(configOptions);
  const requested = input.model?.trim();
  if (!requested || requested === KIMI_DEFAULT_MODEL || requested === current) return current;
  if (configId === undefined || !values.some((option) => option.value === requested)) {
    return yield* Effect.fail(
      input.mapError(
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Kimi model '${requested}' is not available. Select a model your Kimi Code account offers.`,
        ),
      ),
    );
  }
  yield* input.runtime.setConfigOption(configId, requested).pipe(Effect.mapError(input.mapError));
  return requested;
});

const MAX_QUESTION_TEXT_LENGTH = 20_000;

const KimiChoice = Schema.Struct({
  const: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
const KimiQuestionField = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("string"),
    title: Schema.String,
    description: Schema.optional(Schema.String),
    oneOf: Schema.Array(KimiChoice),
  }),
  Schema.Struct({
    type: Schema.Literal("array"),
    title: Schema.String,
    description: Schema.optional(Schema.String),
    items: Schema.Struct({ anyOf: Schema.Array(KimiChoice) }),
  }),
]);
const isKimiQuestionField = Schema.is(KimiQuestionField);

function answerValues(answer: unknown): ReadonlyArray<string> {
  const values = Array.isArray(answer) ? answer : [answer];
  return values.filter((value): value is string => typeof value === "string");
}

/**
 * Kimi asks its questions as one form whose fields are `q0`, `q1`, …: single
 * choices as `oneOf`, multiple choices as an array of `anyOf`. Kimi accepts only
 * its listed labels, so custom answers are not offered.
 */
export const extractKimiElicitationForm = (
  request: EffectAcpSchema.CreateElicitationRequest,
):
  | {
      readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
      readonly respond: (
        answers: ProviderUserInputAnswers,
      ) => EffectAcpSchema.CreateElicitationResponse;
    }
  | undefined => {
  if (request.mode !== "form" || !("requestedSchema" in request)) return undefined;
  const properties = (request.requestedSchema as { readonly properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.some(([id]) => !/^q\d+$/.test(id))) return undefined;
  // Kimi joins the question texts into the form message, one per line.
  const lines = request.message.split("\n");
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, [id, field]] of entries.entries()) {
    if (!isKimiQuestionField(field)) return undefined;
    const choices: ReadonlyArray<typeof KimiChoice.Type> =
      field.type === "string" ? field.oneOf : field.items.anyOf;
    const options = choices.flatMap((choice) => {
      const label = (choice.title ?? choice.const).trim();
      return label
        ? [{ label, description: choice.description?.trim() || label, value: choice.const }]
        : [];
    });
    if (options.length === 0) return undefined;
    const title = field.title.trim();
    const text =
      (entries.length === 1 ? request.message : lines.length === entries.length ? lines[index] : "")
        ?.trim()
        .slice(0, MAX_QUESTION_TEXT_LENGTH) || title;
    // Kimi titles a field with the question itself when the model gave no header.
    const header =
      title && title !== text ? title : entries.length === 1 ? "Question" : `Question ${index + 1}`;
    const description = field.description?.trim();
    questions.push({
      id,
      header: header.slice(0, 120),
      question: description && description !== text ? `${text}\n\n${description}` : text,
      options,
      ...(field.type === "array" ? { multiSelect: true } : {}),
      allowCustomAnswer: false,
    });
  }
  return {
    questions,
    respond: (answers) => {
      const content: Record<string, string | Array<string>> = {};
      for (const question of questions) {
        const known = new Set(question.options.map((option) => option.value ?? option.label));
        const picked = answerValues(answers[question.id]).filter((value) => known.has(value));
        if (picked.length === 0) continue;
        content[question.id] = question.multiSelect === true ? picked : picked[0]!;
      }
      return Object.keys(content).length === 0
        ? { action: "cancel" }
        : { action: "accept", content };
    },
  };
};

const PLAN_REVIEW_QUESTION_ID = "plan_review";

function planReviewMarkdown(request: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  for (const entry of request.toolCall.content ?? []) {
    if (entry.type !== "content" || entry.content.type !== "text") continue;
    const text = entry.content.text.trim();
    if (text && !text.startsWith("Requesting approval to ")) return text;
  }
  return undefined;
}

/**
 * Kimi ends plan mode with a review prompt instead of a plain approval: one
 * choice per approach it proposes (or a single Approve), Revise, and Reject
 * and Exit. T3 shows it as a question with the plan, so each choice reaches
 * Kimi as itself rather than collapsing to approve or decline.
 */
export const extractKimiPermissionQuestion = (
  request: EffectAcpSchema.RequestPermissionRequest,
):
  | {
      readonly question: OrchestrationV2UserInputQuestion;
      readonly respond: (
        answers: ProviderUserInputAnswers,
      ) => EffectAcpSchema.RequestPermissionResponse | undefined;
    }
  | undefined => {
  if (!request.options.some((option) => option.optionId === "plan_revise")) return undefined;
  const plan = planReviewMarkdown(request);
  const options = request.options.flatMap((option) => {
    const label = option.name.trim();
    if (!label) return [];
    const description =
      option.optionId === "plan_revise"
        ? "Keep planning with Kimi."
        : option.optionId === "plan_reject_and_exit"
          ? "Leave plan mode without carrying out the plan."
          : "Leave plan mode and carry out the plan.";
    return [{ label, description, value: option.optionId }];
  });
  if (options.length === 0) return undefined;
  const prompt = "Kimi finished planning. How should it continue?";
  return {
    question: {
      id: PLAN_REVIEW_QUESTION_ID,
      header: "Plan",
      question: plan ? `${prompt}\n\n${plan}`.slice(0, MAX_QUESTION_TEXT_LENGTH) : prompt,
      options,
      allowCustomAnswer: false,
    },
    respond: (answers) => {
      const [optionId] = answerValues(answers[PLAN_REVIEW_QUESTION_ID]);
      return optionId !== undefined && options.some((option) => option.value === optionId)
        ? { outcome: { outcome: "selected", optionId } }
        : undefined;
    },
  };
};

/** Raised when Kimi ends a turn without any output: its ACP server hides model errors. */
export const KIMI_SILENT_TURN_ERROR_TYPE = "kimi_silent_turn";

const KimiSilentTurnData = Schema.Struct({
  type: Schema.Literal(KIMI_SILENT_TURN_ERROR_TYPE),
  usageLimit: Schema.optional(Schema.Boolean),
  resetAt: Schema.optional(Schema.String),
});
const decodeKimiSilentTurnData = Schema.decodeUnknownOption(KimiSilentTurnData);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function kimiSilentTurnError(input: {
  readonly message: string;
  readonly usageLimit: boolean;
  readonly resetAt?: string | undefined;
}): EffectAcpErrors.AcpRequestError {
  return EffectAcpErrors.AcpRequestError.internalError(input.message, {
    type: KIMI_SILENT_TURN_ERROR_TYPE,
    usageLimit: input.usageLimit,
    ...(input.resetAt === undefined ? {} : { resetAt: input.resetAt }),
  });
}

export function kimiPromptFailure(cause: unknown): OrchestrationV2ProviderFailure {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  const data = decodeKimiSilentTurnData(cause.data);
  if (data._tag === "None") {
    return makeProviderFailure({ cause, message: cause.errorMessage, class: "provider_error" });
  }
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: KIMI_SILENT_TURN_ERROR_TYPE,
    class: data.value.usageLimit === true ? "usage_limit" : "provider_error",
    retryable: true,
    ...(data.value.resetAt === undefined ? {} : { resetAt: data.value.resetAt }),
  });
}
