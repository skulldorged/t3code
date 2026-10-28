/**
 * The conversation the Worth knowing observer reads, rendered from T3's own
 * record of the thread, so it looks the same whichever harness ran it: what
 * the user and the agent said, and each tool call with its result.
 *
 * @module worthKnowing/WorthKnowingTranscript
 */
import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { turnItemText } from "../mcp/OrchestratorMcpService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** About 80k tokens: room for a long session without paying for all of it. */
const MAX_TRANSCRIPT_CHARS = 320_000;
/**
 * Once a thread outgrows the cap, it is cut back to this share of it and
 * keeps that start until it fills up again, so successive checks share a
 * prefix the provider can serve from its prompt cache.
 */
const TRIMMED_SHARE = 0.75;
const MAX_ITEM_CHARS = 8_000;
const ITEM_HEAD_CHARS = 6_000;
const ITEM_TAIL_CHARS = 1_500;
const PAGE_SIZE = 200;
const MAX_REMEMBERED_STARTS = 500;

/** Hidden reasoning and checkpoints are not part of the conversation the user follows. */
const SKIPPED_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "reasoning",
  "checkpoint",
]);
const FINISHED_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function clip(text: string): string {
  if (text.length <= MAX_ITEM_CHARS) return text;
  const cut = text.length - ITEM_HEAD_CHARS - ITEM_TAIL_CHARS;
  return `${text.slice(0, ITEM_HEAD_CHARS)}\n[… ${cut} characters cut …]\n${text.slice(-ITEM_TAIL_CHARS)}`;
}

function renderItem(item: OrchestrationV2TurnItem): string | null {
  if (SKIPPED_TYPES.has(item.type)) return null;
  const text = turnItemText(item)?.trim();
  if (text === undefined || text.length === 0) return null;
  switch (item.type) {
    case "user_message":
      return `<user>\n${clip(text)}\n</user>`;
    case "assistant_message":
      return `<agent>\n${clip(text)}\n</agent>`;
    default: {
      const status = FINISHED_STATUSES.has(item.status)
        ? item.status === "completed"
          ? ""
          : ` status="${item.status}"`
        : ` status="still running"`;
      const title = item.title === null ? "" : ` title="${item.title.replaceAll('"', "'")}"`;
      return `<${item.type}${title}${status}>\n${clip(text)}\n</${item.type}>`;
    }
  }
}

export interface WorthKnowingTranscript {
  readonly text: string;
  /** The items the transcript shows, oldest first, for matching a finding's evidence. */
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
}

export const makeTranscriptReader = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
) => {
  // Where each thread's transcript starts, once it has outgrown the cap.
  const starts = new Map<ThreadId, number>();

  return Effect.fn("WorthKnowingTranscript.read")(function* (threadId: ThreadId) {
    const total = (yield* threads.getTimelinePage(threadId, { view: "activity", limit: 0 }))
      .totalItems;
    const remembered = starts.get(threadId);
    const kept = remembered !== undefined && remembered < total ? remembered : undefined;
    // Newest first until the start is reached or the cap is passed.
    const rendered: Array<{
      readonly position: number;
      readonly item: OrchestrationV2TurnItem;
      readonly text: string;
    }> = [];
    const floor = kept ?? 0;
    let size = 0;
    let end = total;
    while (end > floor && size <= MAX_TRANSCRIPT_CHARS) {
      const from = Math.max(floor, end - PAGE_SIZE);
      const page = yield* threads.getTimelinePage(threadId, {
        view: "activity",
        afterPosition: from - 1,
        limit: end - from,
      });
      for (const row of page.items.toReversed()) {
        // Subagents' own steps are theirs; the observer sees their results.
        if (row.item.parentItemId !== null) continue;
        const text = renderItem(row.item);
        if (text === null) continue;
        rendered.push({ position: row.position, item: row.item, text });
        size += text.length + 2;
      }
      end = from;
    }

    let shown = rendered;
    if (size > MAX_TRANSCRIPT_CHARS) {
      let budget = MAX_TRANSCRIPT_CHARS * TRIMMED_SHARE;
      const count = rendered.findIndex((entry) => (budget -= entry.text.length + 2) < 0);
      shown = rendered.slice(0, count === -1 ? rendered.length : Math.max(1, count));
      starts.delete(threadId);
      starts.set(threadId, shown.at(-1)?.position ?? total);
      if (starts.size > MAX_REMEMBERED_STARTS) {
        const oldest = starts.keys().next();
        if (!oldest.done) starts.delete(oldest.value);
      }
    }
    const oldestFirst = shown.toReversed();
    const omitted = oldestFirst.length > 0 && oldestFirst[0]!.position > 0;
    return {
      text: [
        ...(omitted ? ["[Earlier parts of the session are not shown.]"] : []),
        ...oldestFirst.map((entry) => entry.text),
      ].join("\n\n"),
      items: oldestFirst.map((entry) => entry.item),
    } satisfies WorthKnowingTranscript;
  });
};
