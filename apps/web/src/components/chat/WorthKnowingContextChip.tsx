import type { EnvironmentId, WorthKnowingContextRecord } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { LightbulbIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { WorthKnowingDetails } from "./WorthKnowing";

function WorthKnowingRecordDetails({
  record,
  environmentId,
}: {
  readonly record: WorthKnowingContextRecord;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <div className="max-h-80 overflow-y-auto">
      <WorthKnowingDetails
        finding={record}
        context={{
          environmentId,
          threadRef: { environmentId: record.environmentId, threadId: record.threadId },
          cwd: undefined,
        }}
      />
    </div>
  );
}

/** The finding the user is asking the agent about, as a chip in the composer. */
export function WorthKnowingComposerChip({
  record,
}: {
  readonly record: WorthKnowingContextRecord;
}) {
  const gt = useGT();
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <ContextChip
            kind="worth-knowing"
            tabIndex={0}
            aria-label={gt("Worth knowing, {title}", { title: record.title })}
          />
        }
      >
        <LightbulbIcon aria-hidden />
        <ContextChipLabel>{record.label}</ContextChipLabel>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <WorthKnowingRecordDetails record={record} environmentId={record.environmentId} />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The finding a sent message asks about, as a block above the user's words like a quoted
 * reply. It opens the explanation and source the agent was given.
 */
export function WorthKnowingMessageCard({
  record,
  environmentId,
  copyMarkdown,
  leading,
  trailing,
}: {
  readonly record: WorthKnowingContextRecord;
  readonly environmentId: EnvironmentId;
  readonly copyMarkdown: string;
  readonly leading: boolean;
  readonly trailing: boolean;
}) {
  const gt = useGT();
  return (
    <span
      data-markdown-copy={copyMarkdown}
      className={cn("block", !leading && "mt-[0.65rem]", !trailing && "mb-[0.65rem]")}
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-thread-find-ignore
              aria-label={gt("Worth knowing, {title}", { title: record.title })}
              className="block w-full min-w-0 cursor-pointer rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-sm text-muted-foreground wrap-break-word hover:bg-black/14 focus-visible:outline-2 focus-visible:outline-ring dark:bg-black/35 dark:hover:bg-black/50"
            />
          }
        >
          <ContextChip kind="worth-knowing" className="text-xs">
            <LightbulbIcon aria-hidden />
            <ContextChipLabel>{gt("Worth knowing")}</ContextChipLabel>
          </ContextChip>
          <span className="line-clamp-2" dir="auto">
            {record.title}
          </span>
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start" width="md" padding="compact">
          <WorthKnowingRecordDetails record={record} environmentId={environmentId} />
        </PopoverPopup>
      </Popover>
    </span>
  );
}
