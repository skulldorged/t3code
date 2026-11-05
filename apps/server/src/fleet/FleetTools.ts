// @effect-diagnostics nodeBuiltinImport:off - finding fleet's binary is a plain file check.
/**
 * Mars's fleet as T3 tools: the tools `fleet _tools` lists, each call run as
 * `fleet _tool NAME` in the calling thread's directory with its T3 variables.
 * fleet enters the agent sandbox itself, so a tool can't exceed the agent's shell.
 */
import * as NodeFS from "node:fs";

import { setHostToolInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export interface FleetToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
}

export type FleetToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface FleetToolResult {
  readonly isError: boolean;
  readonly content: ReadonlyArray<FleetToolContent>;
}

export class FleetToolCallError extends Schema.TaggedError<FleetToolCallError>()(
  "FleetToolCallError",
  { message: Schema.String },
) {}

const Catalog = Schema.Struct({
  version: Schema.Number,
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      description: Schema.String,
      inputSchema: Schema.Record(Schema.String, Schema.Unknown),
      readOnly: Schema.Boolean,
      destructive: Schema.Boolean,
    }),
  ),
});
const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(Catalog));

const Result = Schema.Struct({
  isError: Schema.Boolean,
  content: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.String,
        mimeType: Schema.String,
      }),
    ]),
  ),
});
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result));
const encodeArguments = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class FleetTools extends Context.Service<
  FleetTools,
  {
    /** Empty where there's no fleet, or one too old to list tools. */
    readonly tools: ReadonlyArray<FleetToolDefinition>;
    readonly call: (input: {
      readonly name: string;
      readonly arguments: unknown;
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
    }) => Effect.Effect<FleetToolResult, FleetToolCallError>;
  }
>()("t3/fleet/FleetTools") {}

/** Under the harnesses' 65-minute MCP timeout, so the agent hears why. */
const CALL_TIMEOUT = Duration.minutes(60);
const CATALOG_TIMEOUT = Duration.seconds(10);
/** The prompt is the host's declared facts, which change when its config does. */
const PROMPT_REFRESH = Duration.minutes(15);
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

const fleetBinary = (): string =>
  ["/run/current-system/sw/bin/fleet", "/opt/fleet/bin/fleet"].find((path) =>
    NodeFS.existsSync(path),
  ) ?? "fleet";

export const make = Effect.fn("FleetTools.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const binary = fleetBinary();
  const read = (args: ReadonlyArray<string>) =>
    runner.run({ command: binary, args, timeout: CATALOG_TIMEOUT }).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  const catalog = yield* read(["_tools"]);
  const tools =
    catalog === undefined
      ? []
      : Option.match(decodeCatalog(catalog), { onNone: () => [], onSome: ({ tools }) => tools });
  if (tools.length === 0) {
    return FleetTools.of({
      tools: [],
      call: Effect.fn("FleetTools.unavailable")(function* () {
        return yield* new FleetToolCallError({ message: "fleet isn't available here." });
      }),
    });
  }

  const refreshPrompt = read(["where", "--prompt"]).pipe(
    Effect.tap((prompt) =>
      Effect.sync(() => {
        if (prompt !== undefined) setHostToolInstructions(prompt);
      }),
    ),
  );
  yield* refreshPrompt;
  yield* refreshPrompt.pipe(Effect.repeat(Schedule.spaced(PROMPT_REFRESH)), Effect.forkScoped);
  yield* Effect.addFinalizer(() => Effect.sync(() => setHostToolInstructions(undefined)));

  const call: FleetTools["Service"]["call"] = Effect.fn("FleetTools.call")(function* (input) {
    const output = yield* runner
      .run({
        command: binary,
        args: ["_tool", input.name],
        cwd: input.cwd,
        env: { ...input.environment },
        stdin: encodeArguments(input.arguments ?? {}),
        timeout: CALL_TIMEOUT,
        maxOutputBytes: MAX_RESULT_BYTES,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (error) => new FleetToolCallError({ message: `fleet didn't run: ${error.message}` }),
        ),
      );
    if (output.timedOut) {
      return yield* new FleetToolCallError({
        message: `${input.name} was still running after 60 minutes and was stopped. Run long work with fleet_job_run.`,
      });
    }
    const result = decodeResult(output.stdout);
    if (result._tag === "None") {
      const detail = output.stderr.trim() || output.stdout.trim();
      return yield* new FleetToolCallError({
        message: `fleet failed (exit ${String(output.code)})${detail ? `: ${detail.slice(0, 2000)}` : "."}`,
      });
    }
    return result.value;
  });

  return FleetTools.of({ tools, call });
});

export const layer = Layer.effect(FleetTools, make()).pipe(Layer.provide(ProcessRunner.layer));
