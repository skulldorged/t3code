// Fork: commands and file copies on this machine or a linked one, so the
// link list is the fleet an agent works across.
import {
  EnvironmentId,
  NonNegativeInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as CommandFollows from "../../../commands/CommandFollows.ts";
import * as CommandJobs from "../../../commands/CommandJobs.ts";
import * as FileTransfer from "../../../commands/FileTransfer.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CommandJobs.CommandJobs,
    CommandFollows.CommandFollows,
    FileTransfer.FileTransfer,
  ],
};

const JobId = TrimmedNonEmptyString.check(Schema.isMaxLength(32)).annotate({
  description: "From t3_run, on the machine it ran on.",
});
const JobStatus = CommandJobs.CommandJobStatus.annotate({
  description: "lost: the machine restarted while it ran, so how it ended is unknown.",
});

const JobState = {
  jobId: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: JobStatus,
  exitCode: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
};
const JobRead = Schema.Struct({
  ...JobState,
  output: Schema.String,
  outputFrom: Schema.Number,
  cursor: Schema.Number.annotate({ description: "Pass as `since` to read on from here." }),
  outputBytes: Schema.Number,
});

const RunTool = Tool.make("t3_run", {
  ...shared,
  description:
    "Run a shell command on this machine or a linked one (environmentId from t3_environment_links), as the user, with their login PATH and no sandbox. Output is stdout and stderr together. Returns when it ends or after waitSeconds (default 30, max 45); still running, it carries on in the background, survives T3 restarting, and a notice wakes this thread when it ends. Read it meanwhile with t3_run_output. Live full-access/default caller thread and a full-access link only. Not on Windows machines.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)).annotate({
      description: "Run by bash (sh without it), not a login shell. Stdin is empty.",
    }),
    cwd: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "On that machine; `~` and relative paths start at its home. Default: home.",
      }),
    ),
    env: Schema.optional(
      Schema.Record(Schema.String, Schema.String).annotate({
        description: "Variables to add for this command.",
      }),
    ),
    waitSeconds: Schema.optional(NonNegativeInt.annotate({ description: "Default 30, max 45." })),
    notify: Schema.optional(
      Schema.Boolean.annotate({
        description: "Wake this thread when a background run ends. Default true.",
      }),
    ),
  }),
  success: Schema.Struct({
    ...JobRead.fields,
    notifies: Schema.Boolean.annotate({
      description: "Whether a notice will wake this thread when it ends.",
    }),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const RunOutputTool = Tool.make("t3_run_output", {
  ...shared,
  description:
    "Read a t3_run job's status and output. Without `since`, the last maxBytes; with it, from there on. waitSeconds (max 45) waits for output past `since`, or without `since` for the job to end.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    jobId: JobId,
    since: Schema.optional(NonNegativeInt),
    maxBytes: Schema.optional(
      NonNegativeInt.annotate({ description: "Default and max 65536. 0 reads only the status." }),
    ),
    waitSeconds: Schema.optional(NonNegativeInt.annotate({ description: "Default 0, max 45." })),
  }),
  success: JobRead,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const RunStopTool = Tool.make("t3_run_stop", {
  ...shared,
  description:
    "Stop a running t3_run job and what it started: TERM, then KILL after 5 seconds. A stopped job sends no notice.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget, jobId: JobId }),
  success: JobRead,
}).annotate(Tool.Destructive, true);

const RunListTool = Tool.make("t3_run_list", {
  ...shared,
  description:
    "List t3_run jobs on this machine or a linked one, newest first. Finished jobs are kept for a week.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    status: Schema.optional(JobStatus),
  }),
  success: Schema.Struct({ jobs: Schema.Array(Schema.Struct(JobState)) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CopyEnd = Schema.Struct({
  environmentId: Schema.optional(
    EnvironmentId.annotate({ description: "A linked machine. Omit for this one." }),
  ),
  path: TrimmedNonEmptyString.annotate({
    description: "On that machine; `~` and relative paths start at its home.",
  }),
});

const CopyTool = Tool.make("t3_copy", {
  ...shared,
  description:
    "Copy a file or folder between this machine and a linked one, or between two linked ones (through here). A folder is copied whole, with its permissions; symlinks are kept as links. `to` is the new path itself, not a folder to put it in, and it must not exist yet unless overwrite. Live full-access/default caller thread and full-access links only.",
  parameters: Schema.Struct({
    from: CopyEnd,
    to: CopyEnd,
    overwrite: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace what is at `to`. Default false." }),
    ),
  }),
  success: Schema.Struct({
    kind: Schema.Literals(["file", "directory"]),
    bytes: Schema.Number.annotate({ description: "Bytes sent; a folder goes as a tar.gz." }),
    from: Schema.String,
    to: Schema.String,
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const CommandsToolkit = Toolkit.make(
  RunTool,
  RunOutputTool,
  RunStopTool,
  RunListTool,
  CopyTool,
);
