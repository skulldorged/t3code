import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import {
  isProviderNativeSubagentThread,
  type DesktopShellThread,
  type DesktopShellThreads,
  type EnvironmentId,
} from "@t3tools/contracts";

import {
  hasUnseenCompletion,
  hasUnseenFailure,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "./Sidebar.logic";

export interface ShellThreadsInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly projectTitles: ReadonlyMap<string, string>;
  /** This client's own visit watermarks, for servers that predate visit tracking. */
  readonly localLastVisitedAt: Readonly<Record<string, string>>;
  readonly now: string;
}

const key = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;

function listedParent(thread: EnvironmentThreadShell) {
  if (
    thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId !== null
  ) {
    return { environmentId: thread.environmentId, threadId: thread.lineage.parentThreadId };
  }
  return thread.delegatedFrom
    ? { environmentId: thread.delegatedFrom.environmentId, threadId: thread.delegatedFrom.threadId }
    : null;
}

/**
 * The sidebar's open threads: its top-level rows that are neither settled nor snoozed, and
 * the T3 tasks listed under them while they stay open. Provider-native subagents are left out,
 * as they never get rows of their own.
 */
export function collectShellThreads(input: ShellThreadsInput): DesktopShellThreads {
  const threads = input.threads.filter((thread) => thread.archivedAt === null);
  const open = new Map<string, EnvironmentThreadShell>();
  for (const thread of threads) {
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    if (isShownUnderParent(ref, thread.lineage, input.delegatedUnderParent)) continue;
    if (thread.settledOverride === "settled" || effectiveSnoozed(thread, { now: input.now })) {
      continue;
    }
    open.set(key(thread.environmentId, thread.id), thread);
  }
  // Children follow their parent: listed while it is open, gone once it settles.
  for (let grew = true; grew;) {
    grew = false;
    for (const thread of threads) {
      const threadKey = key(thread.environmentId, thread.id);
      if (open.has(threadKey) || thread.settledOverride === "settled") continue;
      if (isProviderNativeSubagentThread(thread.source)) continue;
      const parent = listedParent(thread);
      if (parent !== null && open.has(key(parent.environmentId, parent.threadId))) {
        open.set(threadKey, thread);
        grew = true;
      }
    }
  }

  const byKey = new Map(threads.map((thread) => [key(thread.environmentId, thread.id), thread]));
  const ownVisit = (thread: EnvironmentThreadShell) =>
    resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      input.localLastVisitedAt[
        scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id })
      ],
    );
  // A task is read from the thread it sits under, so opening that thread (or one above it)
  // after the task finished counts as seeing it. Otherwise a task never opened on its own
  // would keep a day-old failure unseen for good.
  const lastVisit = (thread: EnvironmentThreadShell) => {
    let latest = ownVisit(thread);
    const passed = new Set([key(thread.environmentId, thread.id)]);
    for (let ref = listedParent(thread); ref !== null;) {
      const refKey = key(ref.environmentId, ref.threadId);
      const above = byKey.get(refKey);
      if (above === undefined || passed.has(refKey)) break;
      passed.add(refKey);
      const visit = ownVisit(above);
      if (visit && (!latest || Date.parse(visit) > Date.parse(latest))) latest = visit;
      ref = listedParent(above);
    }
    return latest;
  };

  const describe = (thread: EnvironmentThreadShell): DesktopShellThread => {
    let status = resolveSidebarThreadStatus(thread);
    if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
    const parent = listedParent(thread);
    const visited = { ...thread, lastVisitedAt: lastVisit(thread) };
    return {
      environmentId: thread.environmentId,
      environment: input.environmentLabels.get(thread.environmentId) ?? thread.environmentId,
      id: thread.id,
      parent:
        parent !== null && open.has(key(parent.environmentId, parent.threadId)) ? parent : null,
      title: thread.title,
      project: input.projectTitles.get(key(thread.environmentId, thread.projectId)) ?? null,
      status,
      createdAt: thread.createdAt,
      startedAt: thread.latestRun?.startedAt ?? null,
      completedAt: thread.latestRun?.completedAt ?? null,
      unseen: hasUnseenFailure(visited) || hasUnseenCompletion(visited),
    };
  };
  const activity = (thread: DesktopShellThread) => thread.startedAt ?? thread.createdAt;
  const listed = [...open.values()].map(describe);
  const byParent = new Map<string, DesktopShellThread[]>();
  for (const thread of listed) {
    if (thread.parent === null) continue;
    const parentKey = key(thread.parent.environmentId, thread.parent.threadId);
    byParent.set(parentKey, [...(byParent.get(parentKey) ?? []), thread]);
  }
  // Most recent first, each thread's tasks right after it.
  const ordered: DesktopShellThread[] = [];
  const place = (thread: DesktopShellThread) => {
    ordered.push(thread);
    const children = byParent.get(key(thread.environmentId, thread.id)) ?? [];
    for (const child of children.toSorted((a, b) => activity(b).localeCompare(activity(a)))) {
      place(child);
    }
  };
  for (const thread of listed
    .filter((thread) => thread.parent === null)
    .toSorted((a, b) => activity(b).localeCompare(activity(a)))) {
    place(thread);
  }
  return { threads: ordered };
}
