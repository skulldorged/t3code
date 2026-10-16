import {
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ScheduledTaskId,
} from "@t3tools/contracts";

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
  readonly delegatedCompletion?: { readonly taskIds: ReadonlyArray<string> } | undefined;
  readonly delegatedTasks?: ReadonlyArray<DelegatedTaskPresentation>;
}

/**
 * Text and sender label for a user-role message. Older scheduled messages
 * stored their attribution in the prompt itself.
 */
export function resolveUserMessagePresentation(message: UserMessagePresentationInput): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
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
