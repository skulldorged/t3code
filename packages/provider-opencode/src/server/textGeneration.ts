import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TextGenerationError } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateReviewGuide",
  "generateSideReply",
]);

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
) {
  const host = yield* ProviderHost.ProviderHost;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(
    input: TextGenerationOperations.Request<S>,
  ) {
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: host.resolveAttachmentPath,
    });

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (
        server: Pick<
          OpenCodeRuntime.OpenCodeServerConnection,
          "url" | "serverPassword" | "version"
        >,
      ) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: input.cwd,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const session = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              title: `T3 Code ${input.operation}`,
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            }),
          catch: (cause) =>
            new OpenCodeTextGenerationSessionRequestError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
            }),
        });
        if (!session.data) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.data.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* Effect.tryPromise({
          try: () =>
            client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(selectedVariant ? { variant: selectedVariant } : {}),
              parts: [{ type: "text", text: input.prompt }, ...fileParts],
            }),
          catch: (cause) =>
            new OpenCodeTextGenerationPromptRequestError({
              ...promptContext,
              cause,
            }),
        });
        const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result.data?.parts ?? [];
        const rawText = getOpenCodeTextResponse(responseParts);
        if (rawText.length === 0) {
          return yield* new OpenCodeTextGenerationEmptyOutputError({
            ...promptContext,
            responsePartCount: responseParts.length,
            textPartCount: responseParts.filter(isOpenCodeTextPart).length,
          });
        }
        return rawText;
      },
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
      }),
    );

    const serverOutput =
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer);
    const rawOutput = yield* serverOutput.pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    return yield* TextGenerationOperations.decodeJsonReply(input, "OpenCode", rawOutput);
  });

  // Forks the thread's session on the server, denies the fork every tool,
  // asks it once and removes it, so the thread's own session is untouched.
  const generateSideReply: NonNullable<ProviderTextGeneration["generateSideReply"]> = Effect.fn(
    "OpenCodeTextGeneration.generateSideReply",
  )(function* (input) {
    const operation = "generateSideReply";
    const fail = (detail: string, cause?: unknown) =>
      new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* fail("OpenCode model selection must use the 'provider/model' format.");
    }
    const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
    const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");

    const runAgainstServer = (
      server: Pick<OpenCodeRuntime.OpenCodeServerConnection, "url" | "serverPassword" | "version">,
    ) =>
      Effect.gen(function* () {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: input.cwd,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const forked = yield* Effect.tryPromise({
          try: (signal) => client.session.fork({ sessionID: input.nativeThreadId }, { signal }),
          catch: (cause) => fail("OpenCode session.fork request failed.", cause),
        });
        const forkId = forked.data?.id;
        if (forkId === undefined) {
          return yield* fail("OpenCode session.fork returned no session.");
        }
        const removeFork = Effect.promise(() =>
          client.session.delete({ sessionID: forkId }).catch(() => undefined),
        );
        return yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: (signal) =>
              client.session.update(
                {
                  sessionID: forkId,
                  permission: [{ permission: "*", pattern: "*", action: "deny" }],
                },
                { signal },
              ),
            catch: (cause) => fail("OpenCode could not restrict the forked session.", cause),
          });
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              client.session.prompt(
                {
                  sessionID: forkId,
                  model: parsedModel,
                  ...(selectedAgent ? { agent: selectedAgent } : {}),
                  ...(selectedVariant ? { variant: selectedVariant } : {}),
                  parts: [{ type: "text", text: input.prompt }],
                },
                { signal },
              ),
            catch: (cause) => fail("OpenCode session.prompt request failed.", cause),
          });
          const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
          if (promptFailure) return yield* fail(promptFailure.message);
          const text = getOpenCodeTextResponse(result.data?.parts);
          if (text.length === 0) return yield* fail("OpenCode returned empty output.");
          const tokens = result.data?.info?.tokens;
          return {
            text,
            ...(tokens === undefined
              ? {}
              : {
                  usage: {
                    inputTokens: tokens.input + tokens.cache.read + tokens.cache.write,
                    cachedInputTokens: tokens.cache.read,
                    outputTokens: tokens.output,
                  },
                }),
          };
        }).pipe(Effect.ensuring(removeFork));
      });

    return yield* (
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer)
    ).pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(fail(OpenCodeRuntime.openCodeRuntimeErrorDetail(cause), cause)),
      }),
    );
  });

  return {
    ...TextGenerationOperations.fromRunner(
      "OpenCodeTextGeneration",
      TextGenerationOperations.withoutInvestigation("OpenCode", runOpenCodeJson),
    ),
    generateSideReply,
  };
});
