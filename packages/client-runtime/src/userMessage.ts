import {
  type GuestMessageAttribution,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  ScheduledTaskId,
} from "@t3tools/contracts";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

export interface DelegatedTaskPresentation {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
}

function delegatedTaskStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    default:
      return "finished";
  }
}

/**
 * Completion messages retain task IDs for provider continuation, but chat only
 * needs the human-readable task title and terminal state.
 */
function delegatedCompletionPresentation(input: {
  readonly taskIds: ReadonlyArray<string>;
  readonly delegatedTasks: ReadonlyArray<DelegatedTaskPresentation>;
}): string {
  const tasksById = new Map(input.delegatedTasks.map((task) => [task.id, task]));
  const tasks = input.taskIds.map((id) => tasksById.get(id));
  if (tasks.length === 0) return "Delegated task finished.";
  if (tasks.length === 1 && tasks[0] === undefined) return "Delegated task finished.";

  const describe = (task: DelegatedTaskPresentation | undefined) => {
    if (task === undefined) return "another task finished";
    const title = task.title?.trim() || "Untitled delegated task";
    return `${delegatedTaskStatusLabel(task.status)}: ${title}`;
  };
  return tasks.length === 1
    ? `Delegated task ${describe(tasks[0]!)}`
    : `Delegated task updates: ${tasks.map(describe).join("; ")}`;
}

interface UserMessagePresentationInput {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
  readonly delegatedCompletion?: { readonly taskIds: ReadonlyArray<string> } | undefined;
  readonly delegatedTasks?: ReadonlyArray<DelegatedTaskPresentation>;
}

/**
 * Text and sender label for a user-role message. Older scheduled messages
 * stored their attribution in the prompt itself.
 */
export function resolveUserMessagePresentation(message: UserMessagePresentationInput): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  if (message.delegatedCompletion !== undefined) {
    return {
      text: delegatedCompletionPresentation({
        taskIds: message.delegatedCompletion.taskIds,
        delegatedTasks: message.delegatedTasks ?? [],
      }),
      attribution: null,
      scheduledTaskId: undefined,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    text: message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

/** Internal wake-ups still enter provider history as prompts, but are not user submissions. */
export function isInternalThreadMessage(message: UserMessagePresentationInput): boolean {
  return (
    message.role === "user" &&
    (message.delegatedCompletion !== undefined ||
      (message.createdBy === "agent" &&
        (message.creationSource === "server" || message.creationSource === "provider"))) &&
    resolveUserMessagePresentation(message).attribution !== "automation"
  );
}
