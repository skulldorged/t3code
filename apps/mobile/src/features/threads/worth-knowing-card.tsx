import {
  worthKnowingAgentPrompt,
  worthKnowingClosedLabel,
  worthKnowingComposerFinding,
  worthKnowingFindingsForRun,
} from "@t3tools/client-runtime/state/worth-knowing";
import type {
  EnvironmentId,
  RunId,
  ThreadId,
  WorthKnowingFinding,
  WorthKnowingFindingAction,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { worthKnowing } from "../../state/worthKnowing";

const EMPTY_FINDINGS: ReadonlyArray<WorthKnowingFinding> = [];
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/**
 * The latest run once it finished with a final answer, whose card under that
 * answer holds its findings instead of the composer.
 */
export function settledRunId(
  latestRun: {
    readonly runId: RunId;
    readonly status: string;
    readonly assistantMessageId: string | null;
  } | null,
): RunId | null {
  return latestRun !== null &&
    TERMINAL_RUN_STATUSES.has(latestRun.status) &&
    latestRun.assistantMessageId !== null
    ? latestRun.runId
    : null;
}

// The thread screen owns the composer draft; cards deep in the feed reach it
// through this registry rather than a provider around the whole screen.
const askHandlers = new Map<ThreadId, (text: string) => void>();

/** Lets this thread's findings append to its composer draft while the screen is open. */
export function useRegisterWorthKnowingAsk(
  threadId: ThreadId,
  appendToDraft: (text: string) => void,
): void {
  useEffect(() => {
    askHandlers.set(threadId, appendToDraft);
    return () => {
      if (askHandlers.get(threadId) === appendToDraft) askHandlers.delete(threadId);
    };
  }, [threadId, appendToDraft]);
}

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

function useWorthKnowingActions(environmentId: EnvironmentId) {
  const updateFinding = useAtomCommand(worthKnowing.updateFinding, {
    label: "update worth knowing finding",
  });
  const update = useCallback(
    (finding: WorthKnowingFinding, action: WorthKnowingFindingAction) => {
      void updateFinding({ environmentId, input: { findingId: finding.id, action } });
    },
    [environmentId, updateFinding],
  );
  return useMemo(
    () => ({
      update,
      askAgent: (finding: WorthKnowingFinding) => {
        const appendToDraft = askHandlers.get(finding.threadId);
        if (appendToDraft === undefined) return;
        appendToDraft(worthKnowingAgentPrompt(finding));
        update(finding, "ask");
      },
    }),
    [update],
  );
}

/** Findings are a few plain sentences or bullets; drop the markdown marks. */
function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

function tagLabel(finding: WorthKnowingFinding): string {
  return finding.tag === "heads_up" ? "Heads up" : "You should know";
}

function TextAction(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={props.onPress}
      className="active:opacity-60"
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">{props.label}</Text>
    </Pressable>
  );
}

function FindingRow(props: {
  readonly finding: WorthKnowingFinding;
  readonly actions: ReturnType<typeof useWorthKnowingActions>;
  readonly showDismiss: boolean;
}) {
  const { finding, actions } = props;
  const [expanded, setExpanded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  if (finding.status !== "open") {
    return (
      <View className="flex-row items-center gap-3">
        <Text numberOfLines={1} className="flex-1 text-xs text-foreground-secondary">
          {finding.title} · {worthKnowingClosedLabel(finding.status)}
        </Text>
        <TextAction label="Restore" onPress={() => actions.update(finding, "restore")} />
      </View>
    );
  }

  return (
    <View className="gap-1.5">
      <View className="flex-row flex-wrap items-center gap-2">
        <View
          className={
            finding.tag === "heads_up"
              ? "rounded bg-warning px-1.5 py-0.5"
              : "rounded bg-subtle px-1.5 py-0.5"
          }
        >
          <Text
            className={
              finding.tag === "heads_up"
                ? "font-t3-medium text-[11px] text-warning-foreground"
                : "font-t3-medium text-[11px] text-foreground-secondary"
            }
          >
            {tagLabel(finding)}
          </Text>
        </View>
        <Text className="shrink font-t3-medium text-sm text-foreground">{finding.title}</Text>
      </View>
      <Text className="text-sm text-foreground-secondary">{finding.learn}</Text>
      {expanded && finding.body.length > 0 ? (
        <Text className="text-sm text-foreground">{plainText(finding.body)}</Text>
      ) : null}
      {sourceOpen && finding.evidence !== null ? (
        <View className="gap-1 border-l-2 border-border pl-2.5">
          <Text selectable className="font-mono text-xs text-foreground-secondary">
            {finding.evidence.quote}
          </Text>
          {finding.evidence.label === null ? null : (
            <Text className="text-xs text-foreground-tertiary">{finding.evidence.label}</Text>
          )}
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-2 pt-0.5">
        {finding.body.length > 0 ? (
          <TextAction
            label={expanded ? "Less" : "Explain"}
            onPress={() => {
              if (!expanded) actions.update(finding, "engaged");
              setExpanded(!expanded);
            }}
          />
        ) : null}
        {finding.evidence === null ? null : (
          <TextAction
            label={sourceOpen ? "Hide source" : "Show source"}
            onPress={() => {
              if (!sourceOpen) actions.update(finding, "engaged");
              setSourceOpen(!sourceOpen);
            }}
          />
        )}
        <TextAction label="Ask agent" onPress={() => actions.askAgent(finding)} />
        <TextAction label="Knew this" onPress={() => actions.update(finding, "known")} />
        {props.showDismiss ? (
          <TextAction label="Dismiss" onPress={() => actions.update(finding, "dismiss")} />
        ) : null}
      </View>
    </View>
  );
}

function CardHeader(props: { readonly trailing?: ReactNode }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <SymbolView name="lightbulb" size={12} tintColorClassName="accent-icon-muted" />
      <Text className="font-t3-medium text-xs text-foreground-secondary">Worth knowing</Text>
      <View className="flex-1" />
      {props.trailing}
    </View>
  );
}

/** What the observer flagged about one run, under that run's final answer. */
export function WorthKnowingRunCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}) {
  const findings = useThreadWorthKnowing(props.environmentId, props.threadId);
  const actions = useWorthKnowingActions(props.environmentId);
  const [showClosed, setShowClosed] = useState(false);
  const runFindings = worthKnowingFindingsForRun(findings, props.runId);
  if (runFindings.length === 0) return null;
  const open = runFindings.filter((finding) => finding.status === "open");
  const closed = runFindings.filter((finding) => finding.status !== "open");
  return (
    <View className="mt-3 gap-3 rounded-xl border border-border p-3">
      <CardHeader
        trailing={
          closed.length > 0 ? (
            <TextAction
              label={showClosed ? "Hide closed" : `${closed.length} closed`}
              onPress={() => setShowClosed(!showClosed)}
            />
          ) : null
        }
      />
      {[...open, ...(showClosed ? closed : [])].map((finding) => (
        <FindingRow key={finding.id} finding={finding} actions={actions} showDismiss />
      ))}
    </View>
  );
}

/**
 * The finding waiting for an answer, above the composer so the user can steer
 * while the run works. It stays until answered or passed over, except while
 * the card under its run's final answer is the last thing in the thread.
 */
export function WorthKnowingLiveCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly settledRunId: RunId | null;
}) {
  const findings = useThreadWorthKnowing(props.environmentId, props.threadId);
  const actions = useWorthKnowingActions(props.environmentId);
  const finding = worthKnowingComposerFinding(findings, props.settledRunId);
  if (finding === undefined) return null;
  return (
    <View className="mx-3 mb-2 gap-3 rounded-xl border border-border bg-background p-3">
      <CardHeader />
      <FindingRow finding={finding} actions={actions} showDismiss />
    </View>
  );
}

/**
 * Thread-list glyph for findings raised since the user last opened the
 * thread. Heads-up findings get the warning tint.
 */
export function WorthKnowingListMarker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lastVisitedAt: string | null | undefined;
  readonly selected: boolean;
}) {
  const query = useEnvironmentQuery(
    worthKnowing.summaries({ environmentId: props.environmentId, input: {} }),
  );
  const summary = query.data?.summaries.find((candidate) => candidate.threadId === props.threadId);
  if (
    summary === undefined ||
    props.selected ||
    (props.lastVisitedAt != null && summary.latestOpenAt <= props.lastVisitedAt)
  ) {
    return null;
  }
  return (
    <SymbolView
      name="lightbulb"
      size={11}
      accessibilityLabel={summary.headsUpCount > 0 ? "Heads up worth knowing" : "Worth knowing"}
      tintColorClassName={
        summary.headsUpCount > 0 ? "accent-warning-foreground" : "accent-icon-muted"
      }
      type="monochrome"
    />
  );
}
