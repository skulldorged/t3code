import {
  worthKnowingClosedLabel,
  worthKnowingContextRecord,
  worthKnowingCurrentFinding,
  worthKnowingFindingsForRun,
} from "@t3tools/client-runtime/state/worth-knowing";
import type {
  EnvironmentId,
  RunId,
  ScopedThreadRef,
  ThreadId,
  WorthKnowingFinding,
  WorthKnowingFindingAction,
} from "@t3tools/contracts";
import { LightbulbIcon } from "lucide-react";
import { T, useGT } from "gt-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { worthKnowing } from "~/state/worthKnowing";
import ChatMarkdown from "../ChatMarkdown";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ThreadNowItem } from "./ThreadNow";

const EMPTY_FINDINGS: ReadonlyArray<WorthKnowingFinding> = [];
const engagedFindingIds = new Set<string>();

/** The thread's findings, newest first, kept live while the thread is open. */
export function useThreadWorthKnowing(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<WorthKnowingFinding> {
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : worthKnowing.threadFindings({ environmentId, input: { threadId } }),
  );
  return query.data?.findings ?? EMPTY_FINDINGS;
}

/** Finding actions, plus handing a finding to the agent through the composer. */
function useWorthKnowingActions(
  environmentId: EnvironmentId,
  composerTarget: ScopedThreadRef | null,
) {
  const updateFinding = useAtomCommand(worthKnowing.updateFinding, {
    label: "update worth knowing finding",
  });
  const update = (finding: WorthKnowingFinding, action: WorthKnowingFindingAction) => {
    // Hovering reopens the explanation often; the server only needs to hear it once.
    if (action === "engaged") {
      if (engagedFindingIds.has(finding.id)) return;
      engagedFindingIds.add(finding.id);
    }
    void updateFinding({ environmentId, input: { findingId: finding.id, action } });
  };
  const askAgent = (finding: WorthKnowingFinding) => {
    if (composerTarget === null) return;
    useComposerDraftStore
      .getState()
      .addWorthKnowingContexts(composerTarget, [worthKnowingContextRecord(environmentId, finding)]);
    update(finding, "ask");
  };
  return { update, askAgent: composerTarget === null ? null : askAgent };
}

type WorthKnowingActions = ReturnType<typeof useWorthKnowingActions>;

export interface WorthKnowingContext {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}

/** The explanation behind a finding: what it is, why, and the line it points to. */
export function WorthKnowingDetails({
  finding,
  context,
}: {
  readonly finding: {
    readonly title: string;
    readonly learn: string;
    readonly body: string;
    readonly evidence: { readonly quote: string; readonly label: string | null } | null;
  };
  readonly context: WorthKnowingContext;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <p className="flex min-w-0 items-start gap-2 font-medium text-foreground">
        <LightbulbIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{finding.title}</span>
      </p>
      {finding.body.length > 0 ? (
        <div className="text-secondary-label">
          <ChatMarkdown
            text={finding.body}
            cwd={context.cwd}
            environmentId={context.environmentId}
            threadRef={context.threadRef ?? undefined}
            isStreaming={false}
            headingLevelOffset={3}
          />
        </div>
      ) : (
        <p className="text-secondary-label">{finding.learn}</p>
      )}
      {finding.evidence === null ? null : (
        <figure className="flex flex-col gap-1 border-l-2 border-border pl-2.5 text-xs">
          <blockquote className="whitespace-pre-wrap break-words font-mono text-secondary-label">
            {finding.evidence.quote}
          </blockquote>
          {finding.evidence.label === null ? null : (
            <figcaption className="text-muted-foreground">{finding.evidence.label}</figcaption>
          )}
        </figure>
      )}
    </div>
  );
}

function WorthKnowingFindingActions({
  finding,
  actions,
}: {
  readonly finding: WorthKnowingFinding;
  readonly actions: WorthKnowingActions;
}) {
  return (
    <>
      {actions.askAgent === null ? null : (
        <InlineButton onClick={() => actions.askAgent?.(finding)}>
          <T>Ask agent</T>
        </InlineButton>
      )}
      <InlineButton tone="muted" onClick={() => actions.update(finding, "known")}>
        <T>Knew this</T>
      </InlineButton>
      <InlineButton tone="muted" onClick={() => actions.update(finding, "dismiss")}>
        <T>Dismiss</T>
      </InlineButton>
    </>
  );
}

/**
 * The newest open finding, as a line at the end of the timeline. It stays
 * while the run works, so the user can steer, and until it is answered.
 */
export function useWorthKnowingNowItem(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly composerTarget: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}): ThreadNowItem | null {
  const findings = useThreadWorthKnowing(input.environmentId, input.threadId);
  const actions = useWorthKnowingActions(input.environmentId, input.composerTarget);
  const finding = worthKnowingCurrentFinding(findings);
  const { environmentId, composerTarget, cwd } = input;
  if (finding === undefined) return null;
  const context = { environmentId, threadRef: composerTarget, cwd };
  return {
    id: `worth-knowing:${finding.id}`,
    icon: <LightbulbIcon />,
    title: (
      <Popover
        onOpenChange={(open) => {
          if (open) actions.update(finding, "engaged");
        }}
      >
        <PopoverTrigger openOnHover render={<InlineButton />}>
          {finding.title}
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" width="md" padding="compact">
          <div className="max-h-80 overflow-y-auto">
            <WorthKnowingDetails finding={finding} context={context} />
          </div>
        </PopoverPopup>
      </Popover>
    ),
    description: finding.learn,
    actions: <WorthKnowingFindingActions finding={finding} actions={actions} />,
  };
}

/**
 * What the observer flagged about one run, behind a bulb in its final
 * answer's action row. Answered findings stay here so they can be restored.
 */
export function WorthKnowingReplyButton({
  environmentId,
  threadId,
  runId,
  threadRef,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}) {
  const gt = useGT();
  const findings = useThreadWorthKnowing(environmentId, threadId);
  const actions = useWorthKnowingActions(environmentId, threadRef);
  const runFindings = worthKnowingFindingsForRun(findings, runId);
  if (runFindings.length === 0) return null;
  const openFindings = runFindings.filter((finding) => finding.status === "open");
  const closedFindings = runFindings.filter((finding) => finding.status !== "open");
  const context = { environmentId, threadRef, cwd };
  const label =
    openFindings.length === 0
      ? gt("Worth knowing")
      : gt(
          "{count, plural, one {{count} thing worth knowing} other {{count} things worth knowing}}",
          {
            count: openFindings.length,
          },
        );

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return;
        for (const finding of openFindings) actions.update(finding, "engaged");
      }}
    >
      <PopoverTrigger
        render={<Button type="button" size="xs" variant="ghost" aria-label={label} />}
      >
        <LightbulbIcon aria-hidden className="size-3" />
        {openFindings.length > 0 ? (
          <span className="tabular-nums">{openFindings.length}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="md" padding="compact" aria-label={label}>
        <div className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto">
          {openFindings.map((finding) => (
            <div key={finding.id} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
              <WorthKnowingDetails finding={finding} context={context} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <WorthKnowingFindingActions finding={finding} actions={actions} />
              </div>
            </div>
          ))}
          {closedFindings.map((finding) => (
            <div
              key={finding.id}
              className="flex min-w-0 items-baseline gap-2 py-2 text-xs text-muted-foreground first:pt-0 last:pb-0"
            >
              <LightbulbIcon aria-hidden className="size-3 shrink-0 self-center opacity-60" />
              <span className="min-w-0 flex-1 truncate">
                {finding.title} · {worthKnowingClosedLabel(finding.status)}
              </span>
              <InlineButton tone="muted" onClick={() => actions.update(finding, "restore")}>
                <T>Restore</T>
              </InlineButton>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
