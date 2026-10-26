import {
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

/**
 * Approvals asked by something outside the provider, such as a privilege
 * broker acting for the agent. The request appears in the thread like a
 * provider's approval, only the user's clients can answer it, and the asker
 * reads the decision back instead of a provider receiving it.
 */
export class ExternalApprovalError extends Schema.TaggedError<ExternalApprovalError>()(
  "ExternalApprovalError",
  {
    reason: Schema.Literals(["no-running-turn", "not-found", "unexpected-failure"]),
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-running-turn":
        return "Approvals can only be requested while the thread has a running turn.";
      case "not-found":
        return "The approval request was not found in this thread.";
      case "unexpected-failure":
        return "The approval request could not be recorded.";
    }
  }
}

export interface ExternalApprovalStatus {
  readonly requestId: RuntimeRequestId;
  readonly status: OrchestrationV2RuntimeRequest["status"];
  readonly decision?: ProviderApprovalDecision;
}

export interface ExternalApprovalsShape {
  readonly raise: (input: {
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly appName?: string;
    readonly options?: ReadonlyArray<ProviderApprovalOption>;
  }) => Effect.Effect<ExternalApprovalStatus, ExternalApprovalError>;
  readonly status: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
  }) => Effect.Effect<ExternalApprovalStatus, ExternalApprovalError>;
}

export class ExternalApprovals extends Context.Service<ExternalApprovals, ExternalApprovalsShape>()(
  "t3/orchestration-v2/ExternalApprovals",
) {}

export const layer: Layer.Layer<
  ExternalApprovals,
  never,
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  ExternalApprovals,
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

    const fail =
      (threadId: ThreadId, reason: ExternalApprovalError["reason"] = "unexpected-failure") =>
      (cause: unknown) =>
        new ExternalApprovalError({ reason, threadId, cause });

    const raise: ExternalApprovalsShape["raise"] = Effect.fnUntraced(function* (input) {
      const { threadId } = input;
      const { run, providerThread, providerTurn } = yield* projections
        .getRunningTurnContext(threadId)
        .pipe(Effect.mapError(fail(threadId)));
      const providerSessionId = providerThread?.providerSessionId;
      if (
        run === undefined ||
        providerThread === undefined ||
        providerTurn === undefined ||
        providerSessionId == null
      ) {
        return yield* new ExternalApprovalError({ reason: "no-running-turn", threadId });
      }
      const driver = providerThread.driver;
      const requestId = yield* ids.allocate
        .runtimeRequest({
          driver,
          providerTurnId: providerTurn.id,
          nativeRequestId: `external:${yield* randomUuidV4}`,
        })
        .pipe(Effect.mapError(fail(threadId)));
      const nodeId = ids.derive.approvalNode({ requestId });
      const turnItemId = ids.derive.approvalTurnItem({ requestId });
      const ordinal = yield* positions
        .allocate({ threadId, turnItemId, runId: run.id })
        .pipe(Effect.mapError(fail(threadId)));
      const now = yield* DateTime.now;

      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId,
        runId: run.id,
        parentNodeId: providerTurn.nodeId,
        rootNodeId: run.rootNodeId ?? providerTurn.nodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn.id,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const request: OrchestrationV2RuntimeRequest = {
        id: requestId,
        nodeId,
        providerTurnId: providerTurn.id,
        nativeRequestRef: null,
        kind: "permission",
        status: "pending",
        responseCapability: { type: "external" },
        createdAt: now,
        resolvedAt: null,
      };
      const turnItem: OrchestrationV2TurnItem = {
        id: turnItemId,
        threadId,
        runId: run.id,
        nodeId,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn.id,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId,
        requestKind: "permission",
        prompt: input.prompt,
        ...(input.appName === undefined ? {} : { appName: input.appName }),
        ...(input.options === undefined ? {} : { options: input.options }),
      };

      const common = {
        providerSessionId,
        providerInstanceId: providerThread.providerInstanceId,
        threadId,
        runId: run.id,
        nodeId,
      };
      for (const event of [
        { type: "node.updated" as const, driver, node },
        { type: "turn_item.updated" as const, driver, turnItem },
        { type: "runtime_request.updated" as const, driver, threadId, runtimeRequest: request },
      ]) {
        yield* ingestor
          .ingestNormalized({ ...common, event })
          .pipe(Effect.mapError(fail(threadId)));
      }
      return { requestId, status: request.status };
    });

    const status: ExternalApprovalsShape["status"] = Effect.fnUntraced(function* (input) {
      const request = yield* projections
        .getRuntimeRequest(input.threadId, input.requestId)
        .pipe(Effect.mapError(fail(input.threadId)));
      if (request === undefined || request.responseCapability.type !== "external") {
        return yield* new ExternalApprovalError({
          reason: "not-found",
          threadId: input.threadId,
        });
      }
      return {
        requestId: request.id,
        status: request.status,
        ...(request.decision === undefined ? {} : { decision: request.decision }),
      };
    });

    return ExternalApprovals.of({ raise, status });
  }),
);
