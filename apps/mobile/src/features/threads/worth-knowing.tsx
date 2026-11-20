import {
  worthKnowingAgentPrompt,
  worthKnowingClosedLabel,
  worthKnowingFindingsForRun,
} from "@t3tools/client-runtime/state/worth-knowing";
import type {
  EnvironmentId,
  RunId,
  ThreadId,
  WorthKnowingFinding,
  WorthKnowingFindingAction,
  WorthKnowingFindingId,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ColorValue, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Sheet } from "../../components/ui/Sheet";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { worthKnowing } from "../../state/worthKnowing";

const EMPTY_FINDINGS: ReadonlyArray<WorthKnowingFinding> = [];
const engagedFindingIds = new Set<string>();

// The thread screen owns the composer draft; sheets opened deep in the feed
// reach it through this registry rather than a provider around the whole screen.
const askHandlers = new Map<ThreadId, (text: string) => void>();

/** Lets this thread's findings append to its composer draft while the screen is open. */
export function useRegisterWorthKnowingAsk(
  threadId: ThreadId,
  appendToDraft: (text: string) => void,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds this thread's registry entry while the screen is mounted
  useEffect(() => {
    askHandlers.set(threadId, appendToDraft);
    return () => {
      if (askHandlers.get(threadId) === appendToDraft) askHandlers.delete(threadId);
    };
  }, [threadId, appendToDraft]);
}

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

export function useWorthKnowingActions(environmentId: EnvironmentId) {
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
      /** Opening findings again tells the server nothing new, so it hears once per finding. */
      engage: (findings: ReadonlyArray<WorthKnowingFinding>) => {
        for (const finding of findings) {
          if (finding.status !== "open" || engagedFindingIds.has(finding.id)) continue;
          engagedFindingIds.add(finding.id);
          update(finding, "engaged");
        }
      },
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

function TextAction(props: {
  readonly label: string;
  readonly muted?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={props.onPress}
      className="active:opacity-60"
    >
      <Text
        className={
          props.muted
            ? "font-t3-medium text-xs text-foreground-tertiary"
            : "font-t3-medium text-xs text-foreground-secondary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function OpenFinding(props: {
  readonly finding: WorthKnowingFinding;
  readonly canAsk: boolean;
  readonly onAsk: () => void;
  readonly onAnswer: (action: "known" | "dismiss") => void;
}) {
  const gt = useGT();
  const { finding } = props;
  return (
    <View className="gap-2">
      <View className="flex-row items-start gap-2">
        <View className="pt-0.5">
          <SymbolView name="lightbulb" size={13} tintColorClassName="accent-icon-muted" />
        </View>
        <Text selectable className="shrink font-t3-medium text-sm text-foreground">
          {finding.title}
        </Text>
      </View>
      <Text selectable className="text-sm text-foreground-secondary">
        {finding.body.length > 0 ? plainText(finding.body) : finding.learn}
      </Text>
      {finding.evidence === null ? null : (
        <View className="gap-1 border-l-2 border-border pl-2.5">
          <Text selectable className="font-mono text-xs text-foreground-secondary">
            {finding.evidence.quote}
          </Text>
          {finding.evidence.label === null ? null : (
            <Text className="text-xs text-foreground-tertiary">{finding.evidence.label}</Text>
          )}
        </View>
      )}
      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-2 pt-0.5">
        {props.canAsk ? <TextAction label={gt("Ask agent")} onPress={props.onAsk} /> : null}
        <TextAction muted label={gt("Knew this")} onPress={() => props.onAnswer("known")} />
        <TextAction muted label={gt("Dismiss")} onPress={() => props.onAnswer("dismiss")} />
      </View>
    </View>
  );
}

function ClosedFinding(props: {
  readonly finding: WorthKnowingFinding;
  readonly onRestore: () => void;
}) {
  const gt = useGT();
  return (
    <View className="flex-row items-center gap-3">
      <Text numberOfLines={1} className="flex-1 text-xs text-foreground-tertiary">
        {props.finding.title} · {worthKnowingClosedLabel(props.finding.status)}
      </Text>
      <TextAction muted label={gt("Restore")} onPress={props.onRestore} />
    </View>
  );
}

/**
 * A run's findings, or the one finding at the end of the thread when
 * `findingId` is set. Mount only while open.
 */
export function WorthKnowingSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly findingId?: WorthKnowingFindingId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const findings = useThreadWorthKnowing(props.environmentId, props.threadId);
  const actions = useWorthKnowingActions(props.environmentId);
  const shown =
    props.findingId !== undefined
      ? findings.filter((finding) => finding.id === props.findingId)
      : props.runId !== undefined
        ? worthKnowingFindingsForRun(findings, props.runId)
        : EMPTY_FINDINGS;
  const open = shown.filter((finding) => finding.status === "open");
  const closed = shown.filter((finding) => finding.status !== "open");
  const canAsk = askHandlers.has(props.threadId);
  return (
    <Sheet title={gt("Worth knowing")} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {open.map((finding, index) => (
          <View
            key={finding.id}
            className={index === 0 ? undefined : "border-t border-border pt-4"}
          >
            <OpenFinding
              finding={finding}
              canAsk={canAsk}
              onAsk={() => {
                props.onClose();
                actions.askAgent(finding);
              }}
              onAnswer={(action) => {
                actions.update(finding, action);
                // The single finding has nothing left to show once answered.
                if (props.findingId !== undefined) props.onClose();
              }}
            />
          </View>
        ))}
        {closed.length > 0 ? (
          <View className={open.length === 0 ? "gap-3" : "gap-3 border-t border-border pt-4"}>
            {closed.map((finding) => (
              <ClosedFinding
                key={finding.id}
                finding={finding}
                onRestore={() => actions.update(finding, "restore")}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

/**
 * What the observer flagged about one run, behind a bulb in its final
 * answer's action row. Answered findings stay in the sheet so they can be restored.
 */
export function WorthKnowingReplyButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
}) {
  const gt = useGT();
  const findings = useThreadWorthKnowing(props.environmentId, props.threadId);
  const actions = useWorthKnowingActions(props.environmentId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const runFindings = worthKnowingFindingsForRun(findings, props.runId);
  if (runFindings.length === 0) return null;
  const openCount = runFindings.filter((finding) => finding.status === "open").length;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          openCount === 0
            ? gt("Worth knowing")
            : gt(
                "{count, plural, one {{count} thing worth knowing} other {{count} things worth knowing}}",
                {
                  count: openCount,
                },
              )
        }
        hitSlop={8}
        onPress={() => {
          actions.engage(runFindings);
          setSheetOpen(true);
        }}
        className="flex-row items-center justify-center gap-1 active:opacity-50"
        style={{
          minWidth: props.buttonSize,
          height: props.buttonSize,
          paddingHorizontal: openCount > 0 ? 4 : 0,
        }}
      >
        <SymbolView
          name="lightbulb"
          size={props.iconSize}
          tintColor={props.iconColor}
          type="monochrome"
        />
        {openCount > 0 ? (
          <Text className="font-t3-medium text-xs tabular-nums" style={{ color: props.iconColor }}>
            {openCount}
          </Text>
        ) : null}
      </Pressable>
      {sheetOpen ? (
        <WorthKnowingSheet
          environmentId={props.environmentId}
          threadId={props.threadId}
          runId={props.runId}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Thread-list glyph for findings raised since the user last opened the thread. */
export function WorthKnowingListMarker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lastVisitedAt: string | null | undefined;
  readonly selected: boolean;
}) {
  const gt = useGT();
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
      accessibilityLabel={gt("Worth knowing")}
      tintColorClassName="accent-icon-muted"
      type="monochrome"
    />
  );
}
