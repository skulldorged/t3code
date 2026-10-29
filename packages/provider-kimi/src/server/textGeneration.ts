import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { KimiSettings } from "../settings.ts";
import { applyKimiAcpModelSelection, deleteKimiSession, makeKimiAcpRuntime } from "./acpSupport.ts";

const KIMI_TIMEOUT_MS = 180_000;
const THINKING_CONFIG_ID = "thinking";

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeKimiTextGeneration = Effect.fn("makeKimiTextGeneration")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runKimiJson: TextGenerationOperations.Runner = Effect.fn("KimiTextGeneration.runKimiJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const failed = (detail: string) => (cause: unknown) =>
        new TextGenerationError({ operation, detail, cause });

      const outputRef = yield* Ref.make("");
      const runtime = yield* makeKimiAcpRuntime({
        kimiSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        authenticateOnAuthRequired: false,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(outputRef, (current) => current + text);
      });
      // Text generation never runs tools or asks questions.
      yield* runtime.handleRequestPermission((params) => {
        const reject = params.options.find((option) => option.kind === "reject_once");
        return Effect.succeed(
          reject === undefined
            ? ({ outcome: { outcome: "cancelled" } } as const)
            : ({ outcome: { outcome: "selected", optionId: reject.optionId } } as const),
        );
      });
      yield* runtime.handleElicitation(() => Effect.succeed({ action: "cancel" } as const));

      const started = yield* runtime
        .start()
        .pipe(Effect.mapError(failed("Kimi Code did not start a session.")));
      const promptResult = yield* Effect.gen(function* () {
        yield* applyKimiAcpModelSelection({
          runtime,
          model: modelSelection.model,
          mapError: (cause) => cause,
        });
        const thinking = getModelSelectionStringOptionValue(modelSelection, THINKING_CONFIG_ID);
        if (thinking !== undefined) {
          yield* runtime.setConfigOption(THINKING_CONFIG_ID, thinking);
        }
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(KIMI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Kimi Code request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause) ? cause : failed("Kimi Code request failed.")(cause),
        ),
        // Text generation sessions are not conversations; keep Kimi's session list clean.
        Effect.ensuring(deleteKimiSession(runtime, started.sessionId).pipe(Effect.ignore)),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Kimi Code request was cancelled."
              : "Kimi Code returned no output. Its plan usage limit may be reached.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Kimi Code", trimmed);
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "Kimi Code text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "KimiTextGeneration",
    TextGenerationOperations.withoutInvestigation("Kimi Code", runKimiJson),
  );
});
