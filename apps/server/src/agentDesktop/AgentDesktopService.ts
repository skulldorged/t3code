// @effect-diagnostics nodeBuiltinImport:off - VNC is a raw TCP protocol.
/**
 * VNC desktops agents registered with their threads, and who controls each.
 *
 * An agent's tooling (fleet) registers a desktop's loopback VNC port through
 * MCP. Viewers attach through `/api/agent-desktop/ws`, which carries the VNC
 * bytes unchanged except that a viewer's input is dropped unless that viewer
 * took control. While someone has control, `status` tells the agent's tooling
 * to hold its own input, and handing control back posts a notice to the
 * threads that were waiting.
 *
 * @module AgentDesktopService
 */
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type {
  AgentDesktopController,
  AgentDesktopId,
  AgentDesktopRegisterInput,
  AgentDesktopState,
  AgentDesktopStreamStatus,
  AgentDesktopSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { makeRfbInputFilter } from "./rfbInputFilter.ts";

/** How long control survives its viewer's last connection closing, for reconnects. */
const RELEASE_GRACE = "15 seconds";
const LIVENESS_INTERVAL = "30 seconds";
const PROBE_TIMEOUT_MS = 3_000;

export type AgentDesktopViewerOutput =
  | { readonly _tag: "data"; readonly data: Uint8Array }
  | ({ readonly _tag: "status" } & AgentDesktopStreamStatus)
  /** The VNC connection dropped while the desktop is still registered; the viewer reconnects. */
  | { readonly _tag: "reconnect" }
  | { readonly _tag: "gone" };

export interface AgentDesktopViewer {
  readonly output: Queue.Queue<AgentDesktopViewerOutput>;
  /** VNC client bytes from the viewer. */
  readonly send: (data: Uint8Array) => void;
  readonly takeControl: Effect.Effect<void>;
  readonly releaseControl: Effect.Effect<void>;
}

/** A thread's wait for control to come back, and the notice that answers it. */
export interface AgentDesktopHandBack {
  readonly desktopId: AgentDesktopId;
  readonly title: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

export class AgentDesktopNotRegisteredError extends Data.TaggedError(
  "AgentDesktopNotRegisteredError",
)<{ readonly message: string }> {}

export class AgentDesktopNoVncError extends Data.TaggedError("AgentDesktopNoVncError")<{
  readonly message: string;
}> {}

export class AgentDesktopService extends Context.Service<
  AgentDesktopService,
  {
    readonly state: Effect.Effect<AgentDesktopState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<AgentDesktopState>, never, Scope.Scope>;
    /** Fails when nothing on the port speaks VNC. */
    readonly register: (
      threadId: ThreadId,
      input: AgentDesktopRegisterInput,
    ) => Effect.Effect<AgentDesktopSummary, AgentDesktopNoVncError>;
    readonly unregister: (threadId: ThreadId, desktopId: AgentDesktopId) => Effect.Effect<void>;
    /**
     * Who may send input now. A thread asking while the user has control is
     * told when they hand it back.
     */
    readonly status: (
      threadId: ThreadId,
      desktopId: AgentDesktopId,
    ) => Effect.Effect<{
      readonly registered: boolean;
      readonly controlledBy: AgentDesktopController;
    }>;
    /** Asks the user to look; their clients float the desktop open. */
    readonly request: (
      threadId: ThreadId,
      desktopId: AgentDesktopId,
      reason: string,
    ) => Effect.Effect<void, AgentDesktopNotRegisteredError>;
    readonly attachViewer: (input: {
      readonly desktopId: string;
      /** Stable across a client's reconnects, so control survives a dropped socket. */
      readonly viewerKey: string;
      readonly canOperate: boolean;
    }) => Effect.Effect<AgentDesktopViewer, AgentDesktopNotRegisteredError, Scope.Scope>;
    readonly handBacks: Stream.Stream<AgentDesktopHandBack>;
  }
>()("t3/agentDesktop/AgentDesktopService") {}

interface Entry {
  summary: AgentDesktopSummary;
  readonly vncPort: number;
  /** viewerKey of whoever took control. */
  owner: string | null;
  releaseFiber: Fiber.Fiber<void> | null;
  /** Threads to tell when control comes back. */
  waiting: Set<ThreadId>;
  readonly viewers: Set<ViewerConnection>;
}

interface ViewerConnection {
  readonly key: string;
  readonly canOperate: boolean;
  readonly output: Queue.Queue<AgentDesktopViewerOutput>;
  readonly releaseInput: () => void;
}

interface StoredDesktop {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly vncPort: number;
  readonly threadIds: ReadonlyArray<string>;
  readonly registeredAt: string;
}

/** Whether a VNC server answers on the loopback port. */
const probeVnc = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    let greeting = "";
    const finish = (ok: boolean) => {
      socket.destroy();
      resume(Effect.succeed(ok));
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (chunk) => {
      greeting += chunk.toString("latin1");
      if (greeting.length >= 12) finish(/^RFB \d{3}\.\d{3}\n/.test(greeting));
    });
    return Effect.sync(() => socket.destroy());
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serviceScope = yield* Effect.scope;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storePath = NodePath.join(config.stateDir, "agent-desktops.json");
  const entries = new Map<string, Entry>();
  const pubsub = yield* PubSub.unbounded<AgentDesktopState>();
  const handBackPubSub = yield* PubSub.unbounded<AgentDesktopHandBack>();
  let requestSequence = 0;

  const snapshot = (): AgentDesktopState => ({
    desktops: [...entries.values()].map((entry) => entry.summary),
  });

  const persist = () => {
    const stored: StoredDesktop[] = [...entries.values()].map((entry) => ({
      id: entry.summary.id,
      title: entry.summary.title,
      width: entry.summary.width,
      height: entry.summary.height,
      vncPort: entry.vncPort,
      threadIds: entry.summary.threadIds,
      registeredAt: entry.summary.registeredAt,
    }));
    try {
      NodeFs.mkdirSync(NodePath.dirname(storePath), { recursive: true });
      NodeFs.writeFileSync(storePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Registrations still work for this run; fleet registers again when used.
    }
  };

  const publish = Effect.suspend(() => {
    persist();
    return PubSub.publish(pubsub, snapshot());
  }).pipe(Effect.asVoid);

  const controlFor = (entry: Entry, viewer: ViewerConnection): AgentDesktopStreamStatus => ({
    type: "control",
    state: entry.owner === null ? "agent" : entry.owner === viewer.key ? "you" : "another-viewer",
  });

  const broadcastControl = (entry: Entry) => {
    entry.summary = { ...entry.summary, controlledBy: entry.owner === null ? "agent" : "user" };
    for (const viewer of entry.viewers) {
      Queue.offerUnsafe(viewer.output, { _tag: "status", ...controlFor(entry, viewer) });
    }
  };

  const cancelRelease = (entry: Entry) =>
    Effect.suspend(() => {
      const fiber = entry.releaseFiber;
      entry.releaseFiber = null;
      return fiber === null ? Effect.void : Fiber.interrupt(fiber);
    });

  /** Hands control back to the agent and tells the threads that waited. */
  const giveBack = Effect.fnUntraced(function* (entry: Entry) {
    // The grace timer may be what called this, so it is dropped, not interrupted.
    entry.releaseFiber = null;
    if (entry.owner === null) return;
    const owner = entry.owner;
    for (const viewer of entry.viewers) if (viewer.key === owner) viewer.releaseInput();
    entry.owner = null;
    const waiting = new Set(entry.waiting);
    if (entry.summary.request !== undefined) waiting.add(entry.summary.request.threadId);
    entry.waiting.clear();
    const { request: _request, ...summary } = entry.summary;
    entry.summary = summary;
    broadcastControl(entry);
    yield* publish;
    if (waiting.size > 0) {
      yield* PubSub.publish(handBackPubSub, {
        desktopId: entry.summary.id,
        title: entry.summary.title,
        threadIds: [...waiting],
      });
    }
  });

  const remove = Effect.fnUntraced(function* (id: string) {
    const entry = entries.get(id);
    if (entry === undefined) return;
    yield* cancelRelease(entry);
    entries.delete(id);
    for (const viewer of entry.viewers) Queue.offerUnsafe(viewer.output, { _tag: "gone" });
    yield* publish;
  });

  // Desktops from before a restart come back if their VNC still answers.
  const stored = (() => {
    try {
      const parsed: unknown = JSON.parse(NodeFs.readFileSync(storePath, "utf8"));
      return Array.isArray(parsed) ? (parsed as StoredDesktop[]) : [];
    } catch {
      return [];
    }
  })();
  for (const desktop of stored) {
    if (!(yield* probeVnc(desktop.vncPort))) continue;
    entries.set(desktop.id, {
      summary: {
        id: desktop.id as AgentDesktopId,
        title: desktop.title,
        width: desktop.width,
        height: desktop.height,
        threadIds: desktop.threadIds as ThreadId[],
        controlledBy: "agent",
        registeredAt: desktop.registeredAt,
      },
      vncPort: desktop.vncPort,
      owner: null,
      releaseFiber: null,
      waiting: new Set(),
      viewers: new Set(),
    });
  }
  persist();

  // A stopped desktop's VNC stops answering; drop it then.
  yield* Effect.gen(function* () {
    for (const entry of [...entries.values()]) {
      if (!(yield* probeVnc(entry.vncPort))) yield* remove(entry.summary.id);
    }
  }).pipe(Effect.repeat(Schedule.spaced(LIVENESS_INTERVAL)), Effect.forkScoped);

  const register: AgentDesktopService["Service"]["register"] = Effect.fnUntraced(
    function* (threadId, input) {
      if (!(yield* probeVnc(input.vncPort))) {
        return yield* new AgentDesktopNoVncError({
          message: `Nothing on 127.0.0.1:${input.vncPort} answers as a VNC server.`,
        });
      }
      const title = input.title?.trim() || input.desktopId;
      const existing = entries.get(input.desktopId);
      if (existing !== undefined && existing.vncPort === input.vncPort) {
        existing.summary = {
          ...existing.summary,
          title,
          width: input.width,
          height: input.height,
          threadIds: existing.summary.threadIds.includes(threadId)
            ? existing.summary.threadIds
            : [...existing.summary.threadIds, threadId],
        };
        yield* publish;
        return existing.summary;
      }
      if (existing !== undefined) yield* remove(input.desktopId);
      const entry: Entry = {
        summary: {
          id: input.desktopId,
          title,
          width: input.width,
          height: input.height,
          threadIds: [threadId],
          controlledBy: "agent",
          registeredAt: yield* nowIso,
        },
        vncPort: input.vncPort,
        owner: null,
        releaseFiber: null,
        waiting: new Set(),
        viewers: new Set(),
      };
      entries.set(input.desktopId, entry);
      yield* publish;
      return entry.summary;
    },
  );

  const unregister: AgentDesktopService["Service"]["unregister"] = Effect.fnUntraced(
    function* (threadId, desktopId) {
      const entry = entries.get(desktopId);
      if (entry === undefined) return;
      const threadIds = entry.summary.threadIds.filter((id) => id !== threadId);
      if (threadIds.length > 0 && (yield* probeVnc(entry.vncPort))) {
        entry.summary = { ...entry.summary, threadIds };
        yield* publish;
        return;
      }
      yield* remove(desktopId);
    },
  );

  const status: AgentDesktopService["Service"]["status"] = (threadId, desktopId) =>
    Effect.sync(() => {
      const entry = entries.get(desktopId);
      if (entry === undefined) return { registered: false, controlledBy: "agent" as const };
      if (entry.owner !== null) entry.waiting.add(threadId);
      return { registered: true, controlledBy: entry.summary.controlledBy };
    });

  const request: AgentDesktopService["Service"]["request"] = Effect.fnUntraced(
    function* (threadId, desktopId, reason) {
      const entry = entries.get(desktopId);
      if (entry === undefined) {
        return yield* new AgentDesktopNotRegisteredError({
          message: `Desktop ${desktopId} isn't registered with T3.`,
        });
      }
      requestSequence += 1;
      const requestedAt = yield* nowIso;
      entry.summary = {
        ...entry.summary,
        threadIds: entry.summary.threadIds.includes(threadId)
          ? entry.summary.threadIds
          : [...entry.summary.threadIds, threadId],
        request: {
          threadId,
          reason: reason.trim(),
          requestedAt,
          sequence: requestSequence,
        },
      };
      yield* publish;
    },
  );

  const attachViewer: AgentDesktopService["Service"]["attachViewer"] = Effect.fnUntraced(
    function* (input) {
      const entry = entries.get(input.desktopId);
      if (entry === undefined) {
        return yield* new AgentDesktopNotRegisteredError({
          message: `Desktop ${input.desktopId} isn't registered.`,
        });
      }
      const output = yield* Queue.unbounded<AgentDesktopViewerOutput>();
      const vnc = NodeNet.connect({ host: "127.0.0.1", port: entry.vncPort });
      vnc.setNoDelay(true);
      const filter = makeRfbInputFilter({
        forward: (bytes) => vnc.write(bytes),
        mayControl: () => input.canOperate && entry.owner === input.viewerKey,
        fail: () => vnc.destroy(),
      });
      const viewer: ViewerConnection = {
        key: input.viewerKey,
        canOperate: input.canOperate,
        output,
        releaseInput: filter.releaseHeldInput,
      };
      vnc.on("data", (chunk: Buffer) =>
        Queue.offerUnsafe(output, {
          _tag: "data",
          data: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        }),
      );
      vnc.on("close", () =>
        Queue.offerUnsafe(output, {
          _tag: entries.get(entry.summary.id) === entry ? "reconnect" : "gone",
        }),
      );
      vnc.on("error", () => vnc.destroy());
      entry.viewers.add(viewer);
      // A reconnect of the viewer that has control keeps it.
      if (entry.owner === input.viewerKey) yield* cancelRelease(entry);
      Queue.offerUnsafe(output, { _tag: "status", ...controlFor(entry, viewer) });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          vnc.destroy();
          entry.viewers.delete(viewer);
          if (entry.owner !== input.viewerKey) return;
          if ([...entry.viewers].some((other) => other.key === input.viewerKey)) return;
          filter.releaseHeldInput();
          yield* cancelRelease(entry);
          entry.releaseFiber = yield* Effect.sleep(RELEASE_GRACE).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                entries.get(entry.summary.id) === entry ? giveBack(entry) : Effect.void,
              ),
            ),
            Effect.forkIn(serviceScope),
          );
        }),
      );

      return {
        output,
        send: filter.receive,
        takeControl: Effect.gen(function* () {
          if (!input.canOperate || entries.get(entry.summary.id) !== entry) return;
          if (entry.owner === input.viewerKey) return;
          yield* cancelRelease(entry);
          for (const other of entry.viewers) if (other.key === entry.owner) other.releaseInput();
          entry.owner = input.viewerKey;
          broadcastControl(entry);
          yield* publish;
        }),
        releaseControl: Effect.suspend(() =>
          entry.owner === input.viewerKey ? giveBack(entry) : Effect.void,
        ),
      } satisfies AgentDesktopViewer;
    },
  );

  return AgentDesktopService.of({
    state: Effect.sync(snapshot),
    subscribe: PubSub.subscribe(pubsub),
    register,
    unregister,
    status,
    request,
    attachViewer,
    handBacks: Stream.fromPubSub(handBackPubSub),
  });
});

export const layer = Layer.effect(AgentDesktopService, make);

/** State stream for WS subscribers: current snapshot first, then every change. */
export const stateStream = (
  service: AgentDesktopService["Service"],
): Stream.Stream<AgentDesktopState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);
