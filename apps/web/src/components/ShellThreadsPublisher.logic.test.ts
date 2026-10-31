import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { collectShellThreads } from "./ShellThreadsPublisher.logic";

const here = EnvironmentId.make("environment-here");
const there = EnvironmentId.make("environment-there");
const now = "2026-10-30T12:00:00.000Z";

function thread(id: string, environmentId = here, overrides: Partial<Thread> = {}): Thread {
  return { ...makeThreadFixture({ id: ThreadId.make(id), environmentId }), ...overrides };
}

function delegatedFrom(parent: Thread): Partial<Thread> {
  return {
    delegatedFrom: {
      environmentId: parent.environmentId,
      threadId: parent.id,
      title: parent.title,
    },
  };
}

function collect(threads: ReadonlyArray<Thread>) {
  // As the sidebar has it: delegated tasks whose parent it lists show under that parent.
  const delegatedUnderParent = new Set(
    threads
      .filter((candidate) => candidate.delegatedFrom)
      .map((candidate) =>
        threadKey({ environmentId: candidate.environmentId, threadId: candidate.id }),
      ),
  );
  return collectShellThreads({
    threads,
    delegatedUnderParent,
    environmentLabels: new Map([
      [here, "navis"],
      [there, "argo"],
    ]),
    projectTitles: new Map(),
    localLastVisitedAt: {},
    now,
  }).threads.map(
    (listed) => `${listed.environment}/${listed.id}${listed.parent ? " (child)" : ""}`,
  );
}

function finished(status: "completed" | "failed", lastVisitedAt: string | null): Partial<Thread> {
  return {
    lastVisitedAt,
    latestRun: {
      runId: RunId.make(`run-${status}`),
      status,
      requestedAt: "2026-10-30T11:00:00.000Z",
      startedAt: "2026-10-30T11:00:00.000Z",
      completedAt: "2026-10-30T11:30:00.000Z",
      assistantMessageId: null,
    },
  };
}

describe("collectShellThreads", () => {
  it("marks threads that finished since they were last opened, as the sidebar does", () => {
    // A server that predates visit tracking sends no watermark at all.
    const { lastVisitedAt: _untracked, ...legacy } = thread(
      "local",
      here,
      finished("completed", null),
    );
    const unseen = (threads: ReadonlyArray<Thread>) =>
      collectShellThreads({
        threads,
        delegatedUnderParent: new Set(),
        environmentLabels: new Map(),
        projectTitles: new Map(),
        localLastVisitedAt: {
          [scopedThreadKey({ environmentId: here, threadId: ThreadId.make("local") })]:
            "2026-10-30T11:10:00.000Z",
        },
        now,
      }).threads.map((listed) => `${listed.id}${listed.unseen ? " unseen" : ""}`);

    expect(
      unseen([
        thread("done", here, finished("completed", "2026-10-30T11:10:00.000Z")),
        thread("checked", here, finished("completed", "2026-10-30T11:40:00.000Z")),
        // Completions in threads never opened stay quiet; failures do not.
        thread("unopened", here, finished("completed", null)),
        thread("failed", here, finished("failed", null)),
        // Then this client's own watermark decides.
        legacy,
      ]).toSorted(),
    ).toEqual(["checked", "done unseen", "failed unseen", "local unseen", "unopened"]);
  });

  it("counts a task as seen once its thread was opened after the task finished", () => {
    const unseen = (parentVisit: string | null) => {
      const parent = thread("parent", there, { lastVisitedAt: parentVisit });
      const task = thread("task", here, {
        ...delegatedFrom(parent),
        ...finished("failed", null),
      });
      return collectShellThreads({
        threads: [parent, task],
        delegatedUnderParent: new Set([threadKey({ environmentId: here, threadId: task.id })]),
        environmentLabels: new Map(),
        projectTitles: new Map(),
        localLastVisitedAt: {},
        now,
      }).threads.find((listed) => listed.id === "task")?.unseen;
    };

    // The task failed at 11:30; never opened itself, it is seen through its thread.
    expect(unseen(null)).toBe(true);
    expect(unseen("2026-10-30T11:10:00.000Z")).toBe(true);
    expect(unseen("2026-10-30T11:40:00.000Z")).toBe(false);
  });

  it("lists open threads and leaves settled and snoozed ones out", () => {
    expect(
      collect([
        thread("open"),
        thread("settled", here, { settledOverride: "settled" }),
        thread("snoozed", here, { snoozedUntil: "2026-10-31T00:00:00.000Z" }),
      ]),
    ).toEqual(["navis/open"]);
  });

  it("lists a delegated task under its open parent, and drops it once the parent settles", () => {
    const parent = thread("parent", there);
    const task = thread("task", here, delegatedFrom(parent));
    expect(collect([parent, task])).toEqual(["argo/parent", "navis/task (child)"]);

    const settledParent = thread("parent", there, { settledOverride: "settled" });
    expect(collect([settledParent, thread("task", here, delegatedFrom(settledParent))])).toEqual(
      [],
    );
  });

  it("leaves provider-native subagents out", () => {
    const parent = thread("parent");
    const native = makeThreadFixture({
      id: ThreadId.make("native"),
      environmentId: here,
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    expect(
      collect([parent, { ...native, source: { ...native.source, creationSource: "provider" } }]),
    ).toEqual(["navis/parent"]);
  });
});
