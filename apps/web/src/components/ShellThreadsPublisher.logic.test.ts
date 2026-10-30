import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
    now,
  }).threads.map(
    (listed) => `${listed.environment}/${listed.id}${listed.parent ? " (child)" : ""}`,
  );
}

describe("collectShellThreads", () => {
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
