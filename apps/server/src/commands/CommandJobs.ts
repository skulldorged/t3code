// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off -- jobs are detached host processes with files on disk, timed by the wall clock their wrapper also uses.
// Fork: commands agents run on this machine, here or for a linked environment
// (`t3_run`). Each job keeps its command, output and exit status in its own
// folder, and a small POSIX wrapper writes the exit status, so a job outlives
// the server: on Linux in its own systemd scope (outside the agents slice the
// server clears on restart), elsewhere as a detached process group.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/** How much output one read returns at most. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/** Finished jobs older than this are removed when the service starts. */
const KEEP_FINISHED = Duration.days(7);
const POLL_INTERVAL = Duration.millis(250);
const STOP_GRACE = Duration.seconds(5);
/** Variables the server runs with that would change how a job's tools behave. */
const SERVER_ONLY_VARIABLES = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"];

export const CommandJobStatus = Schema.Literals(["running", "exited", "stopped", "lost"]);
export type CommandJobStatus = typeof CommandJobStatus.Type;

const JobRecord = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.String,
  runner: Schema.Literals(["systemd", "detached"]),
  unit: Schema.optional(Schema.String),
  pid: Schema.Number,
  bootId: Schema.String,
  stoppedAt: Schema.optional(Schema.String),
});
type JobRecord = typeof JobRecord.Type;

const ExitRecord = Schema.Struct({ exitCode: Schema.Number, finishedAt: Schema.String });

const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(JobRecord));
const decodeExit = Schema.decodeUnknownOption(Schema.fromJsonString(ExitRecord));

export class CommandJobError extends Schema.TaggedError<CommandJobError>()("CommandJobError", {
  reason: Schema.Literals(["not_found", "invalid_request", "unsupported", "failed"]),
  message: Schema.String,
}) {}

/** What one read of a job returns: its state and a slice of its output. */
export interface CommandJobRead {
  readonly jobId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: CommandJobStatus;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Output from byte `outputFrom` up to `cursor`. */
  readonly output: string;
  readonly outputFrom: number;
  /** Pass as `since` to read on from here. */
  readonly cursor: number;
  /** Total output so far, in bytes. */
  readonly outputBytes: number;
}

export interface CommandJobSummary {
  readonly jobId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: CommandJobStatus;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface CommandJobReadOptions {
  /** Read on from this byte; omitted, the read returns the output's end. */
  readonly since?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export class CommandJobs extends Context.Service<
  CommandJobs,
  {
    readonly start: (input: {
      readonly command: string;
      readonly cwd?: string | undefined;
      readonly env?: Readonly<Record<string, string>> | undefined;
    }) => Effect.Effect<CommandJobRead, CommandJobError>;
    readonly read: (
      jobId: string,
      options?: CommandJobReadOptions,
    ) => Effect.Effect<CommandJobRead, CommandJobError>;
    /** Returns once the job has output past `since`, ends, or `timeout` passes. */
    readonly wait: (
      jobId: string,
      options: CommandJobReadOptions & {
        readonly timeout: Duration.Duration;
        /** Wait for the job to end, not for new output. */
        readonly untilDone?: boolean | undefined;
      },
    ) => Effect.Effect<CommandJobRead, CommandJobError>;
    readonly stop: (jobId: string) => Effect.Effect<CommandJobRead, CommandJobError>;
    readonly list: Effect.Effect<ReadonlyArray<CommandJobSummary>, CommandJobError>;
  }
>()("t3/commands/CommandJobs") {}

const JOB_ID = /^[a-z0-9]{12}$/;
const JOB_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** The command, its exit status and finish time, written by the job itself. */
const WRAPPER = `#!/bin/sh
# Written by T3 Code for t3_run. $1: job folder, $2: shell, $3: working directory.
dir="$1"
finish() {
  printf '{"exitCode":%d,"finishedAt":"%s"}\\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/exit.tmp" &&
    mv "$dir/exit.tmp" "$dir/exit.json"
}
if ! cd "$3" 2>>"$dir/output.log"; then
  finish 126
  exit 126
fi
"$2" "$dir/command.sh" >>"$dir/output.log" 2>&1 </dev/null
rc=$?
finish "$rc"
exit "$rc"
`;

const failed = (message: string) => (cause: unknown) =>
  new CommandJobError({
    reason: "failed",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

/** The part of `bytes` that decodes whole: no continuation bytes in front (when `bytes`
 * starts mid-file) and no character cut short at the end. */
const wholeCharacters = (bytes: Uint8Array, startsMidFile: boolean) => {
  const continuation = (index: number) => ((bytes[index] ?? 0) & 0xc0) === 0x80;
  let start = 0;
  if (startsMidFile) while (start < 3 && start < bytes.length && continuation(start)) start++;
  let end = bytes.length;
  let lead = end - 1;
  while (lead > start && end - lead < 4 && continuation(lead)) lead--;
  if (lead >= start) {
    const byte = bytes[lead] ?? 0;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (lead + length > end) end = lead;
  }
  return { start, end };
};

/** Expands `~` and resolves a relative path against `home`. */
export const resolveUserPath = (input: string, home: string) => {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return NodePath.join(home, trimmed.slice(2));
  return NodePath.resolve(home, trimmed);
};

/** What `run` resolves to, or `fallback` when it fails. */
const orElse = <A>(run: () => Promise<A>, fallback: A) =>
  Effect.promise(() => run().catch(() => fallback));

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: failed(message) });

/** Spawns and resolves once it exits, whatever the outcome. */
const runQuietly = (command: string, args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<boolean>((done) => {
        const child = NodeChildProcess.spawn(command, args, { stdio: "ignore" });
        child.once("error", () => done(false));
        child.once("exit", (code) => done(code === 0));
      }),
  );

const readBootId = (platform: NodeJS.Platform) =>
  orElse(async () => {
    if (platform === "linux") {
      return (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    }
    // Boot time is good enough elsewhere: a reboot is what invalidates a recorded pid.
    return String(Math.round(Date.now() / 1000 - NodeOS.uptime()));
  }, "unknown");

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const jobsDir = NodePath.join(stateDir, "commands", "jobs");
  const bootId = yield* readBootId(platform);

  const resolve = (command: string) =>
    Effect.promise(async () => {
      for (const entry of (environment.PATH ?? "").split(NodePath.delimiter)) {
        if (entry.length === 0) continue;
        const candidate = NodePath.join(entry, command);
        try {
          await NodeFSP.access(candidate, NodeFSP.constants.X_OK);
          return candidate;
        } catch {
          // Not here.
        }
      }
      return null;
    });

  const shell = (yield* resolve("bash")) ?? "/bin/sh";

  /** systemd-run and systemctl when this user has a systemd manager that starts scopes. */
  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      if (platform !== "linux") return undefined;
      const runtimeDir = environment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run");
      const systemctl = yield* resolve("systemctl");
      if (systemdRun === null || systemctl === null) return undefined;
      const probe = yield* runQuietly(systemdRun, [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        "true",
      ]);
      return probe ? { systemdRun, systemctl } : undefined;
    }),
  );

  const jobDir = (jobId: string) => NodePath.join(jobsDir, jobId);

  const loadJob = Effect.fn("CommandJobs.loadJob")(function* (jobId: string) {
    if (!JOB_ID.test(jobId)) {
      return yield* new CommandJobError({ reason: "not_found", message: `No job ${jobId}.` });
    }
    const text = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(NodePath.join(jobDir(jobId), "job.json"), "utf8"),
      catch: (cause) =>
        isMissing(cause)
          ? new CommandJobError({
              reason: "not_found",
              message: `No job ${jobId} on this machine.`,
            })
          : failed(`Could not read job ${jobId}`)(cause),
    });
    return yield* Effect.try({
      try: () => decodeJob(text),
      catch: failed(`Job ${jobId} is unreadable`),
    });
  });

  const writeJob = (job: JobRecord) =>
    attempt("Could not record the job", async () => {
      const target = NodePath.join(jobDir(job.id), "job.json");
      await NodeFSP.writeFile(`${target}.tmp`, `${JSON.stringify(job)}\n`);
      await NodeFSP.rename(`${target}.tmp`, target);
    });

  const readExit = (jobId: string) =>
    orElse(async () => {
      const text = await NodeFSP.readFile(NodePath.join(jobDir(jobId), "exit.json"), "utf8");
      return Option.getOrUndefined(decodeExit(text));
    }, undefined);

  const alive = (job: JobRecord) => job.bootId === bootId && processAlive(job.pid);

  const statusOf = Effect.fn("CommandJobs.statusOf")(function* (job: JobRecord) {
    const exit = yield* readExit(job.id);
    if (exit !== undefined)
      return { status: "exited" as const, exitCode: exit.exitCode, finishedAt: exit.finishedAt };
    if (job.stoppedAt !== undefined)
      return { status: "stopped" as const, exitCode: null, finishedAt: job.stoppedAt };
    if (alive(job)) return { status: "running" as const, exitCode: null, finishedAt: null };
    // The wrapper writes its status after the command; give a job that just ended a moment.
    yield* Effect.sleep(POLL_INTERVAL);
    const late = yield* readExit(job.id);
    if (late !== undefined)
      return { status: "exited" as const, exitCode: late.exitCode, finishedAt: late.finishedAt };
    return { status: "lost" as const, exitCode: null, finishedAt: null };
  });

  const outputSize = (jobId: string) =>
    orElse(async () => (await NodeFSP.stat(NodePath.join(jobDir(jobId), "output.log"))).size, 0);

  const readOutput = (jobId: string, from: number, to: number) =>
    orElse(
      async () => {
        if (to <= from) return { text: "", from, to: from };
        const handle = await NodeFSP.open(NodePath.join(jobDir(jobId), "output.log"), "r");
        try {
          const buffer = Buffer.alloc(to - from);
          const { bytesRead } = await handle.read(buffer, 0, to - from, from);
          const bytes = buffer.subarray(0, bytesRead);
          const whole = wholeCharacters(bytes, from > 0);
          return {
            text: bytes.subarray(whole.start, whole.end).toString("utf8"),
            from: from + whole.start,
            to: from + whole.end,
          };
        } finally {
          await handle.close();
        }
      },
      { text: "", from, to: from },
    );

  const read: CommandJobs["Service"]["read"] = Effect.fn("CommandJobs.read")(
    function* (jobId, options) {
      const job = yield* loadJob(jobId);
      const state = yield* statusOf(job);
      const size = yield* outputSize(jobId);
      const maxBytes = Math.max(
        0,
        Math.min(options?.maxBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
      );
      const since = options?.since;
      const from =
        since === undefined ? Math.max(0, size - maxBytes) : Math.max(0, Math.min(since, size));
      const to = Math.min(size, from + maxBytes);
      const output = yield* readOutput(jobId, from, to);
      return {
        jobId: job.id,
        command: job.command,
        cwd: job.cwd,
        status: state.status,
        exitCode: state.exitCode,
        startedAt: job.startedAt,
        finishedAt: state.finishedAt,
        output: output.text,
        outputFrom: output.from,
        cursor: output.to,
        outputBytes: size,
      } satisfies CommandJobRead;
    },
  );

  const wait: CommandJobs["Service"]["wait"] = Effect.fn("CommandJobs.wait")(
    function* (jobId, options) {
      const job = yield* loadJob(jobId);
      const deadline = Date.now() + Duration.toMillis(options.timeout);
      while (Date.now() < deadline) {
        const exit = yield* readExit(job.id);
        if (exit !== undefined || job.stoppedAt !== undefined || !alive(job)) break;
        if (!options.untilDone && options.since !== undefined) {
          if ((yield* outputSize(jobId)) > options.since) break;
        }
        yield* Effect.sleep(POLL_INTERVAL);
      }
      return yield* read(jobId, options);
    },
  );

  const start: CommandJobs["Service"]["start"] = Effect.fn("CommandJobs.start")(function* (input) {
    if (platform === "win32") {
      return yield* new CommandJobError({
        reason: "unsupported",
        message: "t3_run does not run commands on Windows machines yet.",
      });
    }
    if (input.command.trim().length === 0) {
      return yield* new CommandJobError({
        reason: "invalid_request",
        message: "Pass a command to run.",
      });
    }
    const cwd = resolveUserPath(input.cwd ?? "~", home);
    const isDirectory = yield* orElse(async () => (await NodeFSP.stat(cwd)).isDirectory(), false);
    if (!isDirectory) {
      return yield* new CommandJobError({
        reason: "invalid_request",
        message: `${cwd} is not a directory on this machine.`,
      });
    }
    const id = Array.from(NodeCrypto.randomBytes(12), (byte) => JOB_ALPHABET[byte % 36]).join("");
    const dir = jobDir(id);
    yield* attempt("Could not prepare the job", async () => {
      await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(dir, "command.sh"), `${input.command}\n`, {
        mode: 0o600,
      });
      await NodeFSP.writeFile(NodePath.join(dir, "run.sh"), WRAPPER, { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(dir, "output.log"), "", { mode: 0o600 });
    });

    const env: NodeJS.ProcessEnv = { ...process.env, ...input.env, T3_RUN_JOB_ID: id };
    for (const name of SERVER_ONLY_VARIABLES) delete env[name];
    const units = yield* systemd;
    const unit = `t3-run-${id}`;
    const [executable, args] =
      units === undefined
        ? ["/bin/sh", [NodePath.join(dir, "run.sh"), dir, shell, cwd]]
        : [
            units.systemdRun,
            [
              "--user",
              "--scope",
              "--quiet",
              "--collect",
              `--unit=${unit}`,
              "--property=TimeoutStopSec=10s",
              "--",
              "/bin/sh",
              NodePath.join(dir, "run.sh"),
              dir,
              shell,
              cwd,
            ],
          ];
    const pid = yield* attempt(
      "Could not start the command",
      () =>
        new Promise<number>((done, fail) => {
          const child = NodeChildProcess.spawn(executable, args as Array<string>, {
            cwd: dir,
            env,
            detached: true,
            stdio: "ignore",
          });
          child.once("error", fail);
          child.once("spawn", () => {
            child.unref();
            if (child.pid === undefined) fail(new Error("no process id"));
            else done(child.pid);
          });
        }),
    );
    yield* writeJob({
      id,
      command: input.command,
      cwd,
      startedAt: new Date().toISOString(),
      runner: units === undefined ? "detached" : "systemd",
      ...(units === undefined ? {} : { unit: `${unit}.scope` }),
      pid,
      bootId,
    });
    return yield* read(id);
  });

  const signalGroup = (pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };

  const stop: CommandJobs["Service"]["stop"] = Effect.fn("CommandJobs.stop")(function* (jobId) {
    const job = yield* loadJob(jobId);
    const state = yield* statusOf(job);
    if (state.status !== "running") return yield* read(jobId);
    const units = yield* systemd;
    if (job.runner === "systemd" && job.unit !== undefined && units !== undefined) {
      yield* runQuietly(units.systemctl, ["--user", "stop", job.unit]);
    }
    if (alive(job)) {
      signalGroup(job.pid, "SIGTERM");
      const deadline = Date.now() + Duration.toMillis(STOP_GRACE);
      while (alive(job) && Date.now() < deadline) yield* Effect.sleep(POLL_INTERVAL);
      if (alive(job)) signalGroup(job.pid, "SIGKILL");
    }
    if ((yield* readExit(jobId)) === undefined) {
      yield* writeJob({ ...job, stoppedAt: new Date().toISOString() });
    }
    return yield* read(jobId);
  });

  const list: CommandJobs["Service"]["list"] = Effect.gen(function* () {
    const names = yield* orElse(() => NodeFSP.readdir(jobsDir), [] as Array<string>);
    const jobs: Array<CommandJobSummary> = [];
    for (const name of names) {
      if (!JOB_ID.test(name)) continue;
      const job = yield* loadJob(name).pipe(Effect.option);
      if (job._tag === "None") continue;
      const state = yield* statusOf(job.value);
      jobs.push({
        jobId: job.value.id,
        command: job.value.command,
        cwd: job.value.cwd,
        status: state.status,
        exitCode: state.exitCode,
        startedAt: job.value.startedAt,
        finishedAt: state.finishedAt,
      });
    }
    return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  });

  // Finished jobs stay readable for a week, then their folders go.
  yield* Effect.gen(function* () {
    const cutoff = Date.now() - Duration.toMillis(KEEP_FINISHED);
    for (const job of yield* list) {
      if (job.status === "running" || job.finishedAt === null) continue;
      if (Date.parse(job.finishedAt) >= cutoff) continue;
      yield* orElse(
        () => NodeFSP.rm(jobDir(job.jobId), { recursive: true, force: true }),
        undefined,
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not prune old command jobs", { cause })),
    Effect.forkScoped,
  );

  return CommandJobs.of({ start, read, wait, stop, list });
});

export const layer = Layer.effect(CommandJobs, make);
