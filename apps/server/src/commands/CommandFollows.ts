// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off -- follows are small files beside the jobs.
// Fork: a t3_run job that outlasts its call wakes the thread that started it
// when it ends, here or on a linked machine. Each follow is a file until its
// notice is posted, so a follow outlives a restart of either machine, and a
// machine that is asleep is waited on, backing off.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  type EnvironmentId,
  MessageId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Tool } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { forkParked } from "../serverActivation.ts";
import * as CommandJobs from "./CommandJobs.ts";

/** How much of the output's end a notice carries. */
const NOTICE_TAIL_BYTES = 3_000;
/** One wait on a job there; t3_run_output waits at most this long. */
const REMOTE_WAIT_SECONDS = 45;
const LOCAL_WAIT = Duration.minutes(10);
const RETRY = Schedule.exponential(Duration.seconds(5)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(5))),
  ),
);

/** `t3_run_output` there, as much of it as a follow reads. */
const RemoteRunOutputTool = Tool.make("t3_run_output", {
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    jobId: Schema.String,
    maxBytes: Schema.optional(Schema.Number),
    waitSeconds: Schema.optional(Schema.Number),
  }),
  success: Schema.Struct({
    command: Schema.String,
    status: CommandJobs.CommandJobStatus,
    exitCode: Schema.NullOr(Schema.Number),
    startedAt: Schema.String,
    finishedAt: Schema.NullOr(Schema.String),
    output: Schema.String,
    outputBytes: Schema.Number,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});

const Follow = Schema.Struct({
  threadId: ThreadId,
  /** Absent for a job here. */
  environmentId: Schema.optional(Schema.String),
  jobId: Schema.String,
  command: Schema.String,
});
type Follow = typeof Follow.Type;
const decodeFollow = Schema.decodeUnknownOption(Schema.fromJsonString(Follow));

type Ended = typeof RemoteRunOutputTool.successSchema.Type;

export class CommandFollows extends Context.Service<
  CommandFollows,
  {
    /** Wakes `threadId` when the job ends. */
    readonly follow: (input: {
      readonly threadId: ThreadId;
      readonly environmentId?: EnvironmentId | undefined;
      readonly jobId: string;
      readonly command: string;
    }) => Effect.Effect<void>;
    /** Resumes follows saved before a restart. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/commands/CommandFollows") {}

const shortCommand = (command: string) => {
  const line = command.split("\n", 1)[0] ?? "";
  const cut = Array.from(line).slice(0, 80).join("");
  return cut.length < command.length ? `${cut}…` : cut;
};

const duration = (from: string, to: string | null) => {
  const ms = (to === null ? Date.now() : Date.parse(to)) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const jobs = yield* CommandJobs.CommandJobs;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const hereId = yield* environment.getEnvironmentId;
  const followers = yield* Scope.Scope;
  const followsDir = NodePath.join(stateDir, "commands", "follows");
  const running = new Set<string>();

  const keyOf = (follow: Follow) => `${follow.environmentId ?? "here"}-${follow.jobId}`;
  const fileOf = (follow: Follow) =>
    NodePath.join(followsDir, `${keyOf(follow).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

  const save = (follow: Follow) =>
    Effect.promise(async () => {
      await NodeFSP.mkdir(followsDir, { recursive: true, mode: 0o700 });
      const file = fileOf(follow);
      await NodeFSP.writeFile(`${file}.tmp`, `${JSON.stringify(follow)}\n`, { mode: 0o600 });
      await NodeFSP.rename(`${file}.tmp`, file);
    });

  const forget = (follow: Follow) =>
    Effect.promise(() => NodeFSP.rm(fileOf(follow), { force: true }));

  const labelOf = (follow: Follow) =>
    follow.environmentId === undefined
      ? environment.getDescriptor.pipe(
          Effect.map((descriptor) => descriptor.label),
          Effect.orElseSucceed(() => "this machine"),
        )
      : links.get(follow.environmentId as EnvironmentId).pipe(
          Effect.map((link) => (link._tag === "Some" ? link.value.label : follow.environmentId)),
          Effect.orElseSucceed(() => follow.environmentId as string),
        );

  /** How a follow reaches the job there: as the thread that started it. */
  const scopeFor = (
    follow: Follow,
  ): Effect.Effect<McpInvocationContext.McpThreadInvocationScope, OrchestratorMcpFailure> =>
    threads.getThreadShell(follow.threadId).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(
              new OrchestratorMcpFailure({ code: "thread_not_found", message: "Thread deleted." }),
            )
          : Effect.succeed({
              environmentId: hereId,
              requestNamespace: `t3-run:${follow.threadId}`,
              thread: {
                threadId: follow.threadId,
                providerSessionId: `t3-run:${follow.jobId}`,
                providerInstanceId: shell.providerInstanceId,
              },
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 0,
            } as McpInvocationContext.McpThreadInvocationScope),
      ),
    );

  /** One wait on the job; its state once it has ended, otherwise undefined. */
  const waitOnce = (follow: Follow): Effect.Effect<Ended | undefined, OrchestratorMcpFailure> =>
    (follow.environmentId === undefined
      ? jobs
          .wait(follow.jobId, { timeout: LOCAL_WAIT, untilDone: true, maxBytes: NOTICE_TAIL_BYTES })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: error.reason === "not_found" ? "task_not_found" : "orchestration_error",
                  message: error.message,
                }),
            ),
          )
      : scopeFor(follow).pipe(
          Effect.flatMap((scope) =>
            forwarding.call(scope, RemoteRunOutputTool, follow.environmentId as EnvironmentId, {
              jobId: follow.jobId,
              maxBytes: NOTICE_TAIL_BYTES,
              waitSeconds: REMOTE_WAIT_SECONDS,
            }),
          ),
        )
    ).pipe(Effect.map((state) => (state.status === "running" ? undefined : state)));

  const notify = (follow: Follow, text: string, summary: string, outcome: "completed" | "failed") =>
    threads.getThreadShell(follow.threadId).pipe(
      Effect.flatMap((shell) => {
        if (shell === null || shell.deletedAt !== null) return Effect.void;
        const id = `t3-run:${follow.threadId}:${keyOf(follow)}`;
        return threads
          .sendToThread({
            projectId: shell.projectId,
            commandId: CommandId.make(id),
            threadId: follow.threadId,
            messageId: MessageId.make(id),
            text,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "server",
            notification: { source: { kind: "command" }, outcome, summary },
          })
          .pipe(Effect.asVoid);
      }),
    );

  const reportEnded = Effect.fn("CommandFollows.reportEnded")(function* (
    follow: Follow,
    state: Ended,
  ) {
    // Stopping it was asked for; nobody needs waking for that.
    if (state.status === "stopped") return;
    const label = yield* labelOf(follow);
    const command = shortCommand(follow.command);
    const took = duration(state.startedAt, state.finishedAt);
    const how =
      state.status === "lost"
        ? `was lost: ${label} restarted while it ran`
        : `exited ${state.exitCode}`;
    const summary = `\`${command}\` on ${label} ${how}${took === undefined ? "" : ` after ${took}`}`;
    const target =
      follow.environmentId === undefined ? "" : `environmentId \`${follow.environmentId}\`, `;
    const tail =
      state.output.length === 0
        ? "It printed nothing."
        : `${state.outputBytes > NOTICE_TAIL_BYTES ? "The end of its output" : "Its output"}:\n\n\`\`\`\n${state.output.replace(/```/g, "``​`")}\n\`\`\``;
    const text = `${summary}.\n\n${tail}\n\nMore: t3_run_output with ${target}jobId \`${follow.jobId}\`.`;
    yield* notify(
      follow,
      text,
      Array.from(summary).slice(0, 200).join(""),
      state.status === "exited" && state.exitCode === 0 ? "completed" : "failed",
    );
  });

  const run = Effect.fn("CommandFollows.run")(
    function* (follow: Follow) {
      const ended = yield* waitOnce(follow).pipe(
        Effect.repeat({ until: (state) => state !== undefined }),
        Effect.retry({
          schedule: RETRY,
          // These will not change by waiting: the link or job is gone, or access was taken away.
          while: (error) =>
            error.code !== "capability_denied" &&
            error.code !== "invalid_request" &&
            error.code !== "task_not_found" &&
            error.code !== "thread_not_found",
        }),
        Effect.catch((error) =>
          error.code === "thread_not_found"
            ? Effect.undefined
            : labelOf(follow).pipe(
                Effect.flatMap((label) =>
                  notify(
                    follow,
                    `Following \`${shortCommand(follow.command)}\` (job \`${follow.jobId}\`) on ${label} stopped: ${error.message}`,
                    Array.from(`Lost track of \`${shortCommand(follow.command)}\` on ${label}`)
                      .slice(0, 200)
                      .join(""),
                    "failed",
                  ),
                ),
                Effect.as(undefined),
              ),
        ),
      );
      if (ended !== undefined) yield* reportEnded(follow, ended as Ended);
      yield* forget(follow);
    },
    (effect, follow) =>
      effect.pipe(
        Effect.ensuring(Effect.sync(() => running.delete(keyOf(follow)))),
        Effect.ignoreCause({ log: true }),
      ),
  );

  const launch = (follow: Follow) =>
    Effect.suspend(() => {
      if (running.has(keyOf(follow))) return Effect.void;
      running.add(keyOf(follow));
      return run(follow).pipe(Effect.forkIn(followers), Effect.asVoid);
    });

  const follow: CommandFollows["Service"]["follow"] = (input) => {
    const record: Follow = {
      threadId: input.threadId,
      ...(input.environmentId === undefined || input.environmentId === hereId
        ? {}
        : { environmentId: input.environmentId }),
      jobId: input.jobId,
      command: input.command,
    };
    return save(record).pipe(Effect.andThen(launch(record)));
  };

  const start: CommandFollows["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        const names = yield* Effect.promise(() =>
          NodeFSP.readdir(followsDir).catch(() => [] as Array<string>),
        );
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const text = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(followsDir, name), "utf8").catch(() => ""),
          );
          const saved = decodeFollow(text);
          yield* saved._tag === "Some"
            ? launch(saved.value)
            : Effect.promise(() => NodeFSP.rm(NodePath.join(followsDir, name), { force: true }));
        }
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return CommandFollows.of({ follow, start });
});

export const layer = Layer.effect(CommandFollows, make);
