import { worthKnowingComposerFinding } from "@t3tools/client-runtime/state/worth-knowing";
import type {
  EnvironmentId,
  RunId,
  ScopedThreadRef,
  ThreadId,
  WorthKnowingFinding,
} from "@t3tools/contracts";
import { LightbulbIcon } from "lucide-react";
import { useMemo } from "react";

import { InlineButton } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  useThreadWorthKnowing,
  useWorthKnowingActions,
  worthKnowingTagLabel,
} from "./WorthKnowingCard";

/** The banner's one line of detail, with the quoted source when there is one. */
function bannerDescription(finding: WorthKnowingFinding): string {
  if (finding.evidence === null) return finding.learn;
  const from = finding.evidence.label === null ? "" : ` (${finding.evidence.label})`;
  return `${finding.learn} Source${from}: “${finding.evidence.quote}”`;
}

/**
 * The finding waiting for an answer, above the composer so the user can steer
 * while the run works. It stays until answered or passed over, except while
 * the card under its run's final answer sits right above the composer.
 */
export function useWorthKnowingBannerItems(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** The latest run, once it finished with a final answer to hold its card. */
  readonly settledRunId: RunId | null;
  readonly composerTarget: ScopedThreadRef | null;
}): ReadonlyArray<ComposerBannerStackItem> {
  const findings = useThreadWorthKnowing(input.environmentId, input.threadId);
  const actions = useWorthKnowingActions(input.environmentId, input.composerTarget);
  return useMemo(
    () =>
      [worthKnowingComposerFinding(findings, input.settledRunId)]
        .filter((finding) => finding !== undefined)
        .map((finding): ComposerBannerStackItem => ({
          id: `worth-knowing:${finding.id}`,
          variant: finding.tag === "heads_up" ? "warning" : "info",
          icon: <LightbulbIcon />,
          title: `${worthKnowingTagLabel(finding)}: ${finding.title}`,
          description: bannerDescription(finding),
          actions: (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {actions.askAgent === null ? null : (
                <InlineButton tone="muted" onClick={() => actions.askAgent?.(finding)}>
                  Ask agent
                </InlineButton>
              )}
              <InlineButton tone="muted" onClick={() => actions.update(finding, "known")}>
                Knew this
              </InlineButton>
            </div>
          ),
          dismissLabel: "Dismiss",
          onDismiss: () => actions.update(finding, "dismiss"),
        })),
    [actions, findings, input.settledRunId],
  );
}
