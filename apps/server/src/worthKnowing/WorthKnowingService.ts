/**
 * "Worth knowing", T3's take on Claude Code's "You should know" plugin: every
 * few steps of a working run, a hidden, tool-less fork of the thread's own
 * provider session is asked whether there is one thing the user should know
 * but probably missed. The fork shares the conversation's cached prefix, so
 * it sees everything the agent saw. When to check, what to ask, and when to
 * back off follow the plugin; findings are kept per thread and streamed to
 * clients.
 *
 * @module worthKnowing/WorthKnowingService
 */
import {
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RunId,
  type ThreadId,
  WorthKnowingError,
  type WorthKnowingFinding,
  WorthKnowingFindingId,
  type WorthKnowingSummariesResult,
  type WorthKnowingThreadResult,
  type WorthKnowingUpdateFindingInput,
  type WorthKnowingUpdateFindingResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { turnItemText } from "../mcp/OrchestratorMcpService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildWorthKnowingPrompt, parseWorthKnowingReply } from "./WorthKnowingPrompt.ts";
import * as WorthKnowingStore from "./WorthKnowingStore.ts";

/**
 * A working run is checked at every sixth step (model request), never at its
 * first, as the plugin does. There is no check after the final answer.
 */
const STEPS_PER_CHECK = 6;
/**
 * Drivers checked only when a run ends. A Codex fork is a new conversation to
 * the prompt cache, so every check re-sends the whole thread uncached.
 */
const END_OF_RUN_ONLY_DRIVERS: ReadonlySet<string> = new Set(["codex"]);
/** How many recently offered and known topics the prompt lists, as the plugin keeps. */
const TOPICS_IN_PROMPT = 50;
/** Forks running at once across all threads; each is a provider process or request. */
const MAX_CONCURRENT_CHECKS = 2;
/** A check that runs longer than this is abandoned. */
const CHECK_TIMEOUT = "5 minutes";
/** How many run and message ids the event watcher remembers. */
const MAX_REMEMBERED_IDS = 5_000;
/** Working runs whose steps are being counted. */
const MAX_REMEMBERED_RUNS = 200;

const TOOL_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
]);
/** What a model request produces: its reasoning, its text, and the tools it calls. */
const STEP_OUTPUT_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "reasoning",
  "assistant_message",
  ...TOOL_ITEM_TYPES,
]);
const FINISHED_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Where a working run is: its current step, and the output that step began with. */
interface RunSteps {
  step: number;
  latest: { readonly id: string; readonly isTool: boolean; finished: boolean } | undefined;
  readonly seen: Set<string>;
}

interface CheckRequest {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly stillWorking: boolean;
}

export class WorthKnowingService extends Context.Service<
  WorthKnowingService,
  {
    /** Starts watching runs. Checks run in the background of the given scope. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly listThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<WorthKnowingFinding>, WorthKnowingError>;
    readonly subscribeThread: (
      threadId: ThreadId,
    ) => Stream.Stream<WorthKnowingThreadResult, WorthKnowingError>;
    readonly subscribeSummaries: () => Stream.Stream<
      WorthKnowingSummariesResult,
      WorthKnowingError
    >;
    readonly updateFinding: (
      input: WorthKnowingUpdateFindingInput,
    ) => Effect.Effect<WorthKnowingUpdateFindingResult, WorthKnowingError>;
  }
>()("t3/worthKnowing/WorthKnowingService") {}

/**
 * How many checks to skip after the user passed over findings `streak` times
 * in a row: none for the first two, then 1, 2, 4… up to 16, as Claude Code's
 * plugin does.
 */
export function checksToSkipAfterIgnoring(streak: number): number {
  return streak <= 2 ? 0 : Math.min(16, 2 ** (streak - 3));
}

/** Remembers an id, forgetting the oldest once the set is full. */
function remember<A>(set: Set<A>, value: A): void {
  set.add(value);
  if (set.size > MAX_REMEMBERED_IDS) {
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The plugin's test for a topic it already offered: same line, ignoring case and a final period. */
function sameTopic(a: string, b: string): boolean {
  const key = (line: string) => line.trim().toLowerCase().replace(/\.$/, "");
  return key(a) === key(b);
}

/** The item whose text contains the quote, preferring the latest. */
function findEvidenceItem(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  quote: string,
): OrchestrationV2TurnItem | undefined {
  const needles = [normalizeForMatch(quote)];
  if (needles[0]!.length > 60) needles.push(needles[0]!.slice(0, 60));
  for (const needle of needles) {
    if (needle.length < 8) continue;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      const text = turnItemText(item);
      if (text !== null && normalizeForMatch(text).includes(needle)) return item;
    }
  }
  return undefined;
}

/** `/bin/bash -lc './x.sh 3'` reads better as `./x.sh 3`. */
function unwrapShellCommand(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return wrapped?.[2] ?? command;
}

/** A short description of where evidence was found, for the card. */
function evidenceLabel(item: OrchestrationV2TurnItem): string | null {
  const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);
  switch (item.type) {
    case "command_execution":
      return `Output of ${clip(unwrapShellCommand(item.input.split("\n")[0] ?? item.input))}`;
    case "file_change":
      return `Change to ${item.fileName}`;
    case "assistant_message":
      return "The agent's message";
    case "dynamic_tool":
      return `Result of ${item.toolName}`;
    case "subagent":
      return "A subagent's result";
    case "web_search":
      return "A web search";
    case "file_search":
      return "A file search";
    case "error":
      return "An error";
    default:
      return item.title;
  }
}

const make = Effect.gen(function* () {
  const store = yield* WorthKnowingStore.WorthKnowingStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const runtimePolicies = yield* RuntimePolicy.RuntimePolicyV2;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<ThreadId>();
  const forkPermits = yield* Semaphore.make(MAX_CONCURRENT_CHECKS);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const notifyChanged = (threadId: ThreadId) =>
    PubSub.publish(changes, threadId).pipe(Effect.asVoid);

  const listThread: WorthKnowingService["Service"]["listThread"] = (threadId) =>
    store.listThread(threadId).pipe(Effect.map((rows) => rows.map((row) => row.finding)));

  const isEnabledFor = (projectId: ProjectId) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => resolveProjectSettings(settings, projectId).settings),
      Effect.map((settings) => settings.worthKnowingEnabled),
      Effect.orElseSucceed(() => false),
    );

  const check = Effect.fn("WorthKnowingService.check")(function* (request: CheckRequest) {
    const records = yield* threads.getThreadRecords(
      request.threadId,
      ["runs", "providerThreads", "turnItems"],
      { runIds: [request.runId], turnItemRunIds: [request.runId] },
    );
    const thread = records.thread;
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.lineage.relationshipToParent === "subagent"
    ) {
      return;
    }
    if (!(yield* isEnabledFor(thread.projectId))) return;

    const run = records.runs.find((candidate) => candidate.id === request.runId);
    if (run === undefined) return;
    if (!request.stillWorking && run.status !== "completed" && run.status !== "interrupted") {
      return;
    }

    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId ?? null;
    if (nativeThreadId === null) return;
    const instance = yield* providerInstances.getInstance(run.modelSelection.instanceId);
    const generateSideReply = instance?.textGeneration.generateSideReply;
    if (instance === undefined || generateSideReply === undefined) return;
    // Like the plugin, checks happen while a run works; Codex, which cannot
    // afford that, gets one check when the run ends instead.
    if (request.stillWorking === END_OF_RUN_ONLY_DRIVERS.has(instance.driverKind)) return;
    // A run that used no tools has nothing buried for the observer to dig out.
    if (
      !request.stillWorking &&
      !records.turnItems.some((item) => TOOL_ITEM_TYPES.has(item.type))
    ) {
      return;
    }

    // One finding at a time: none while one waits for an answer, and at most one per run.
    const prior = yield* store.listThread(request.threadId);
    if (prior.some((row) => row.finding.status === "open" || row.finding.runId === request.runId)) {
      return;
    }

    const backoff = yield* store.getBackoff;
    if (backoff.checksToSkip > 0) {
      yield* store.setBackoff({ ...backoff, checksToSkip: backoff.checksToSkip - 1 });
      return;
    }

    const runtimePolicy = yield* runtimePolicies.resolve({
      thread,
      modelSelection: run.modelSelection,
    });
    const project = yield* projects.get(thread.projectId);
    const cwd =
      runtimePolicy.cwd ??
      thread.worktreePath ??
      (Option.isSome(project) ? project.value.workspaceRoot : null);
    if (cwd === null) return;

    // Oldest first, as the plugin lists them.
    const seen = (yield* store.listRecent(TOPICS_IN_PROMPT))
      .map((finding) => finding.learn)
      .toReversed();
    const known = (yield* store.listKnown(TOPICS_IN_PROMPT))
      .map((finding) => finding.learn)
      .toReversed();

    const reply = yield* forkPermits
      .withPermit(
        generateSideReply({
          threadId: request.threadId,
          nativeThreadId,
          cwd,
          modelSelection: run.modelSelection,
          runtimePolicy,
          prompt: buildWorthKnowingPrompt({ stillWorking: request.stillWorking, seen, known }),
        }),
      )
      .pipe(
        // A runtime that cannot fork (OpenCode 2) is skipped quietly, not logged per run.
        Effect.catchTag("TextGenerationError", (error) =>
          error.detail === TextGeneration.SIDE_REPLY_UNSUPPORTED
            ? Effect.void
            : Effect.fail(error),
        ),
      );
    if (reply === undefined) return;
    const parsed = parseWorthKnowingReply(reply.text);
    if (parsed.finding === undefined && !/^\W*learn\W*:\s*none\b/im.test(reply.text)) {
      yield* Effect.logWarning("Worth knowing reply was not in the expected format", {
        threadId: request.threadId,
        runId: request.runId,
        reply: reply.text.slice(0, 1_500),
      });
    }

    const raised = parsed.finding;
    const outcome =
      raised === undefined
        ? "none"
        : [...seen, ...known].some((line) => sameTopic(line, raised.learn))
          ? "deduped"
          : "shown";
    if (raised !== undefined && outcome === "shown") {
      const now = yield* nowIso;
      const evidenceItem =
        raised.evidence === null ? undefined : findEvidenceItem(records.turnItems, raised.evidence);
      const id = WorthKnowingFindingId.make(`wk_${yield* crypto.randomUUIDv4()}`);
      yield* store.insert({
        id,
        threadId: request.threadId,
        projectId: thread.projectId,
        runId: request.runId,
        tag: raised.tag,
        learn: raised.learn,
        title: raised.title,
        body: raised.body,
        evidence:
          raised.evidence === null
            ? null
            : {
                quote: raised.evidence,
                itemId: evidenceItem?.id ?? null,
                runId: evidenceItem?.runId ?? null,
                label: evidenceItem === undefined ? null : evidenceLabel(evidenceItem),
              },
        status: "open",
        raisedMidRun: request.stillWorking,
        resolvedByRunId: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* notifyChanged(request.threadId);
    }

    yield* Effect.logInfo("Worth knowing check finished", {
      threadId: request.threadId,
      runId: request.runId,
      stillWorking: request.stillWorking,
      outcome,
      inputTokens: reply.usage?.inputTokens,
      cachedInputTokens: reply.usage?.cachedInputTokens,
      outputTokens: reply.usage?.outputTokens,
    });
  });

  // Like the plugin, a step that arrives while the thread's check is still
  // out is not checked at all, rather than queued.
  const checking = new Set<ThreadId>();

  const requestCheck = (scope: Scope.Scope, request: CheckRequest) =>
    Effect.suspend(() => {
      if (checking.has(request.threadId)) return Effect.void;
      checking.add(request.threadId);
      return check(request).pipe(
        Effect.timeout(CHECK_TIMEOUT),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Worth knowing check failed", {
                threadId: request.threadId,
                runId: request.runId,
                cause: Cause.pretty(cause),
              }),
        ),
        // Its own span, so the warning above is written out with it.
        Effect.withSpan("WorthKnowingService.runCheck"),
        Effect.ensuring(Effect.sync(() => checking.delete(request.threadId))),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  /**
   * A user message sent past an open finding the user never opened counts
   * toward passing it over; each finding passed over adds to the backoff.
   */
  const recordMessagePast = (threadId: ThreadId, sentAt: string) =>
    Effect.gen(function* () {
      const passedOver = yield* store.countMessagePast(threadId, sentAt, yield* nowIso);
      if (passedOver === 0) return;
      const backoff = yield* store.getBackoff;
      const ignoredStreak = backoff.ignoredStreak + passedOver;
      yield* store.setBackoff({
        ignoredStreak,
        checksToSkip: checksToSkipAfterIgnoring(ignoredStreak),
      });
      yield* notifyChanged(threadId);
    });

  const start: WorthKnowingService["Service"]["start"] = Effect.fn("WorthKnowingService.start")(
    function* () {
      const scope = yield* Effect.scope;
      const runSteps = new Map<RunId, RunSteps>();
      // Finished runs are announced again (checkpoints, delegated results); check each once.
      const finishedRuns = new Set<RunId>();
      const seenUserMessages = new Set<string>();
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          switch (event.type) {
            case "turn-item.updated": {
              const item = event.payload;
              // Subagents' own steps are not the run's, as in the plugin.
              if (
                item.runId === null ||
                item.parentItemId !== null ||
                !STEP_OUTPUT_ITEM_TYPES.has(item.type)
              ) {
                return Effect.void;
              }
              let steps = runSteps.get(item.runId);
              if (steps === undefined) {
                steps = { step: -1, latest: undefined, seen: new Set() };
                runSteps.set(item.runId, steps);
                // Runs that never report an end would otherwise stay here forever.
                if (runSteps.size > MAX_REMEMBERED_RUNS) {
                  const oldest = runSteps.keys().next();
                  if (!oldest.done) runSteps.delete(oldest.value);
                }
              }
              const finished = FINISHED_ITEM_STATUSES.has(item.status);
              if (steps.seen.has(item.id)) {
                if (steps.latest?.id === item.id && finished) steps.latest.finished = true;
                return Effect.void;
              }
              steps.seen.add(item.id);
              // The model only answers again once every tool it called has
              // finished, so new output after a finished tool call is a new step.
              const startsStep =
                steps.latest === undefined || (steps.latest.isTool && steps.latest.finished);
              steps.latest = { id: item.id, isTool: TOOL_ITEM_TYPES.has(item.type), finished };
              if (!startsStep) return Effect.void;
              steps.step += 1;
              return steps.step > 0 && steps.step % STEPS_PER_CHECK === 0
                ? requestCheck(scope, {
                    threadId: event.threadId,
                    runId: item.runId,
                    stillWorking: true,
                  })
                : Effect.void;
            }
            case "run.updated": {
              if (!ThreadManagementService.isTerminalRunStatus(event.payload.status)) {
                return Effect.void;
              }
              runSteps.delete(event.payload.id);
              if (finishedRuns.has(event.payload.id)) return Effect.void;
              remember(finishedRuns, event.payload.id);
              return event.payload.status === "completed" || event.payload.status === "interrupted"
                ? requestCheck(scope, {
                    threadId: event.threadId,
                    runId: event.payload.id,
                    stillWorking: false,
                  })
                : Effect.void;
            }
            case "message.updated": {
              const message = event.payload;
              if (
                message.role !== "user" ||
                message.createdBy !== "user" ||
                seenUserMessages.has(message.id)
              ) {
                return Effect.void;
              }
              remember(seenUserMessages, message.id);
              return recordMessagePast(
                message.threadId,
                DateTime.formatIso(message.createdAt),
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Worth knowing could not record passed-over findings", {
                    threadId: message.threadId,
                    cause,
                  }),
                ),
              );
            }
            case "thread.deleted":
              return store.deleteThread(event.threadId).pipe(
                Effect.andThen(notifyChanged(event.threadId)),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Worth knowing could not remove a deleted thread's findings", {
                    threadId: event.threadId,
                    cause,
                  }),
                ),
              );
            default:
              return Effect.void;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Worth knowing event stream stopped", { cause }),
          ),
        ),
      );
    },
  );

  const subscribeThread: WorthKnowingService["Service"]["subscribeThread"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change landing between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = listThread(threadId).pipe(
          Effect.map((findings) => ({ threadId, findings })),
        );
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.mapEffect(() => snapshot),
          ),
        );
      }),
    );

  const subscribeSummaries: WorthKnowingService["Service"]["subscribeSummaries"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = store.listOpenSummaries.pipe(Effect.map((summaries) => ({ summaries })));
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        );
      }),
    );

  const updateFinding: WorthKnowingService["Service"]["updateFinding"] = (input) =>
    Effect.gen(function* () {
      const stored = yield* store.get(input.findingId);
      if (stored === undefined) {
        return yield* new WorthKnowingError({ message: "That finding no longer exists." });
      }
      const status =
        input.action === "dismiss"
          ? "dismissed"
          : input.action === "known"
            ? "known"
            : input.action === "ask"
              ? "discussed"
              : input.action === "restore"
                ? "open"
                : stored.finding.status;
      const now = yield* nowIso;
      const finding: WorthKnowingFinding = {
        ...stored.finding,
        status,
        ...(input.action === "restore" ? { resolvedByRunId: null, restoredAt: now } : {}),
        updatedAt: now,
      };
      yield* store.update(finding, { engaged: true });
      // Any answer shows the user is reading findings, so checks stop backing off.
      yield* store.setBackoff({ ignoredStreak: 0, checksToSkip: 0 });
      yield* notifyChanged(finding.threadId);
      return { finding };
    });

  return WorthKnowingService.of({
    start,
    listThread,
    subscribeThread,
    subscribeSummaries,
    updateFinding,
  });
});

export const layer = Layer.effect(WorthKnowingService, make).pipe(
  Layer.provide(WorthKnowingStore.layer),
);
