import { CommandId, MessageId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Messages that local tools leave for a thread as files in `<stateDir>/inbox`,
 * delivered as a notice in the thread (not a message from the user), queued
 * like `t3_thread_send` so an idle agent wakes up.
 * A file needs no credential and outlives server restarts, so a build that
 * ends hours after its agent's provider session closed still reaches the
 * thread. Writers create `<id>.json` atomically (write elsewhere, then rename)
 * as `{ "id": "...", "threadId": "...", "text": "..." }`, optionally with a
 * one-line `summary` for the notice (else the text's first line) and an
 * `outcome` (completed, failed, cancelled or updated). Delivered files are
 * removed; files that can never be delivered move to `inbox/failed`.
 */
const InboxMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  text: TrimmedNonEmptyString,
  summary: Schema.optional(TrimmedNonEmptyString),
  outcome: Schema.optional(Schema.Literals(["completed", "failed", "cancelled", "updated"])),
});

const SUMMARY_MAX_LENGTH = 200;

function noticeSummary(summary: string | undefined, text: string): string {
  const line = (summary ?? text).trim().split("\n")[0]!.trim();
  return line.length > SUMMARY_MAX_LENGTH ? `${line.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : line;
}
const decodeInboxMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(InboxMessage));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const inbox = path.join(config.stateDir, "inbox");
    const failed = path.join(inbox, "failed");
    yield* fs.makeDirectory(failed, { recursive: true }).pipe(Effect.ignore);

    const setAside = (file: string, name: string, reason: string) =>
      fs
        .rename(file, path.join(failed, name))
        .pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.logWarning("Inbox message could not be delivered", { name, reason }),
          ),
        );

    const deliver = Effect.fnUntraced(function* (name: string) {
      const file = path.join(inbox, name);
      const raw = yield* fs.readFileString(file).pipe(Effect.option);
      if (raw._tag === "None") return;
      const message = yield* decodeInboxMessage(raw.value).pipe(Effect.option);
      if (message._tag === "None") return yield* setAside(file, name, "not a valid message");
      const { id, threadId, text, summary, outcome } = message.value;
      const thread = yield* threads.getThreadShell(threadId).pipe(Effect.option);
      if (thread._tag === "None") return; // The store is busy; try again next sweep.
      if (thread.value === null || thread.value.deletedAt !== null) {
        return yield* setAside(file, name, "no such thread");
      }
      const sent = yield* threads
        .sendToThread({
          projectId: thread.value.projectId,
          commandId: CommandId.make(`inbox:${id}`),
          threadId,
          messageId: MessageId.make(`inbox:${id}`),
          text,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "command" },
            outcome: outcome ?? "updated",
            summary: noticeSummary(summary, text),
          },
        })
        .pipe(Effect.result);
      if (sent._tag === "Failure") {
        const tag = (sent.failure as { readonly _tag?: string })._tag;
        if (
          tag === "ThreadManagementThreadArchivedError" ||
          tag === "ThreadManagementThreadNotFoundError"
        ) {
          return yield* setAside(file, name, tag);
        }
        return; // Transient; the next sweep retries with the same command id.
      }
      yield* fs.remove(file).pipe(Effect.ignore);
    });

    const sweep = Effect.gen(function* () {
      const names = yield* fs.readDirectory(inbox).pipe(Effect.orElseSucceed(() => []));
      for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
        yield* deliver(name);
      }
    });
    yield* scheduler.register("local-inbox", sweep);
  }),
);
