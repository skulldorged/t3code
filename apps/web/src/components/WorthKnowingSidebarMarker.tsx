import type { EnvironmentId, ThreadId, WorthKnowingThreadSummary } from "@t3tools/contracts";
import { LightbulbIcon } from "lucide-react";

import { useEnvironmentQuery } from "~/state/query";
import { worthKnowing } from "~/state/worthKnowing";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const EMPTY_SUMMARIES: ReadonlyArray<WorthKnowingThreadSummary> = [];

/** One environment's open-finding summaries, shared by every sidebar row. */
function useWorthKnowingSummaries(
  environmentId: EnvironmentId | null,
): ReadonlyArray<WorthKnowingThreadSummary> {
  const query = useEnvironmentQuery(
    environmentId === null ? null : worthKnowing.summaries({ environmentId, input: {} }),
  );
  return query.data?.summaries ?? EMPTY_SUMMARIES;
}

/** Marks a thread whose observer raised something since the user last looked. */
export function WorthKnowingSidebarMarker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lastVisitedAt: string | null | undefined;
  readonly isActive: boolean;
}) {
  const summary = useWorthKnowingSummaries(props.environmentId).find(
    (candidate) => candidate.threadId === props.threadId,
  );
  if (
    summary === undefined ||
    props.isActive ||
    (props.lastVisitedAt != null && summary.latestOpenAt <= props.lastVisitedAt)
  ) {
    return null;
  }
  const label =
    summary.openCount === 1 ? "1 thing worth knowing" : `${summary.openCount} things worth knowing`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 items-center"
            data-testid={`sidebar-worth-knowing-${props.threadId}`}
          />
        }
      >
        <LightbulbIcon aria-hidden className="size-3.5 text-muted-foreground/80" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
