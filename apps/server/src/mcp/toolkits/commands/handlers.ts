import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as CommandFollows from "../../../commands/CommandFollows.ts";
import * as CommandJobs from "../../../commands/CommandJobs.ts";
import * as FileTransfer from "../../../commands/FileTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CommandsToolkit } from "./tools.ts";

const MAX_WAIT_SECONDS = 45;
const DEFAULT_RUN_WAIT_SECONDS = 30;

const toFailure = (error: CommandJobs.CommandJobError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const waitFor = (seconds: number | undefined, fallback: number) =>
  Duration.seconds(Math.min(seconds ?? fallback, MAX_WAIT_SECONDS));

/** Wakes the calling thread when a job still running ends; false when nobody would be woken. */
const followIfRunning = Effect.fn("commands.followIfRunning")(function* (
  input: { readonly notify?: boolean | undefined },
  environmentId: EnvironmentId | undefined,
  job: { readonly jobId: string; readonly command: string; readonly status: string },
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (job.status !== "running" || input.notify === false || scope.thread === undefined) {
    return false;
  }
  const follows = yield* CommandFollows.CommandFollows;
  yield* follows.follow({
    threadId: scope.thread.threadId,
    environmentId,
    jobId: job.jobId,
    command: job.command,
  });
  return true;
});

export const layer = McpToolAccess.toLayer(CommandsToolkit, {
  t3_run: McpToolAccess.afterForwarding(
    McpToolAccess.writesEnvironment(
      (input) =>
        Effect.gen(function* () {
          const jobs = yield* CommandJobs.CommandJobs;
          const started = yield* jobs
            .start({ command: input.command, cwd: input.cwd, env: input.env })
            .pipe(Effect.mapError(toFailure));
          const read = yield* jobs
            .wait(started.jobId, {
              timeout: waitFor(input.waitSeconds, DEFAULT_RUN_WAIT_SECONDS),
              untilDone: true,
            })
            .pipe(Effect.mapError(toFailure));
          return { ...read, notifies: yield* followIfRunning(input, undefined, read) };
        }),
      { linkedCallers: "allowed" },
    ),
    // Answered there, where nobody is waiting on it: this thread is.
    (input, environmentId, result) =>
      followIfRunning(input, environmentId, result).pipe(
        Effect.map((notifies) => ({ ...result, notifies })),
      ),
  ),
  t3_run_output: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const jobs = yield* CommandJobs.CommandJobs;
        const options = { since: input.since, maxBytes: input.maxBytes };
        return yield* (
          (input.waitSeconds ?? 0) > 0
            ? jobs.wait(input.jobId, {
                ...options,
                timeout: waitFor(input.waitSeconds, 0),
                untilDone: input.since === undefined,
              })
            : jobs.read(input.jobId, options)
        ).pipe(Effect.mapError(toFailure));
      }),
    { linkedCallers: "allowed" },
  ),
  t3_run_stop: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const jobs = yield* CommandJobs.CommandJobs;
        return yield* jobs.stop(input.jobId).pipe(Effect.mapError(toFailure));
      }),
    { linkedCallers: "allowed" },
  ),
  t3_run_list: McpToolAccess.writesEnvironment(
    (input) =>
      Effect.gen(function* () {
        const jobs = yield* CommandJobs.CommandJobs;
        const listed = yield* jobs.list.pipe(Effect.mapError(toFailure));
        return {
          jobs:
            input.status === undefined
              ? listed
              : listed.filter((job) => job.status === input.status),
        };
      }),
    { linkedCallers: "allowed" },
  ),
  t3_copy: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const linked =
        (input.from.environmentId !== undefined &&
          input.from.environmentId !== caller.scope.environmentId) ||
        (input.to.environmentId !== undefined &&
          input.to.environmentId !== caller.scope.environmentId);
      if (linked && caller.scope.linkedEnvironments === false) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Linked environments is off on this machine, so nothing can be copied to or from another machine. The user can turn it on in Settings → Labs.",
        });
      }
      // A copy from a link's caller would use this machine's links as that caller.
      if (linked && caller.scope.client?.linked === true) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "A linked caller cannot copy through this machine to another one.",
        });
      }
      const transfer = yield* FileTransfer.FileTransfer;
      return yield* transfer.copy({
        from: input.from,
        to: input.to,
        overwrite: input.overwrite ?? false,
        hereId: caller.scope.environmentId,
        limits: caller.limits,
      });
    }),
  ),
});
