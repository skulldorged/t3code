import type { AnyRouter } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { LightbulbIcon } from "lucide-react";

import { getClientSettings } from "../hooks/useSettings";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";
import { worthKnowing } from "../state/worthKnowing";

/**
 * Notifies when the observer raises a heads-up finding in a thread the user
 * is not looking at. Other findings stay quiet: the sidebar marker and the
 * card are enough.
 */
export function watchWorthKnowingNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
  environmentId: EnvironmentId,
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void,
): () => void {
  // Null until the first snapshot, which only records what was already raised.
  let previous: Map<ThreadId, string> | null = null;

  return registry.subscribe(
    worthKnowing.summaries({ environmentId, input: {} }),
    (result) => {
      // While (re)connecting there is no snapshot; keep the last one so a
      // reconnect does not announce everything again.
      const summaries = Option.getOrUndefined(AsyncResult.value(result))?.summaries;
      if (summaries === undefined) return;
      const next = new Map<ThreadId, string>();
      for (const summary of summaries) {
        if (summary.latestHeadsUpAt !== null) next.set(summary.threadId, summary.latestHeadsUpAt);
      }
      const prior = previous;
      previous = next;
      if (prior === null) return;
      const shell = registry.get(environmentShell.stateValueAtom(environmentId));
      const threads =
        shell.status === "live" && Option.isSome(shell.snapshot)
          ? shell.snapshot.value.threads
          : [];
      const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
      const active = (router.state.matches.at(-1)?.params ?? {}) as {
        environmentId?: string;
        threadId?: string;
      };
      for (const summary of summaries) {
        const raisedAt = summary.latestHeadsUpAt;
        const before = prior.get(summary.threadId);
        if (raisedAt === null || (before !== undefined && raisedAt <= before)) continue;
        const threadTitle =
          threads.find((thread) => thread.id === summary.threadId)?.title ?? "A thread";
        const findingTitle = summary.latestHeadsUpTitle ?? "Something worth knowing";
        const openThread = () =>
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: summary.threadId },
          });
        const focused = document.visibilityState === "visible" && document.hasFocus();
        if (focused && active.environmentId === environmentId && active.threadId === summary.threadId) {
          continue;
        }
        if (hasNotificationSound(mode)) {
          void playNotificationSound("input", () =>
            hasNotificationSound(getClientSettings().notificationMode),
          );
        }
        if (focused) {
          if (!inAppNotificationsEnabled) continue;
          const toastId = toastManager.add({
            type: "warning",
            title: `Heads up: ${findingTitle}`,
            description: threadTitle,
            data: {
              hideCopyButton: true,
              leadingIcon: <LightbulbIcon aria-hidden className="size-4 text-warning-foreground" />,
            },
            actionProps: {
              children: "Open thread",
              onClick: () => {
                toastManager.close(toastId);
                openThread();
              },
            },
          });
          continue;
        }
        if (
          !hasDesktopNotifications(mode) ||
          typeof Notification === "undefined" ||
          Notification.permission !== "granted"
        ) {
          continue;
        }
        try {
          const notification = new Notification(`Heads up: ${findingTitle}`, {
            body: threadTitle,
            tag: `${environmentId}:${summary.threadId}:worth-knowing`,
            silent: true,
          });
          onNotification(environmentId, notification);
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            openThread();
          });
        } catch {
          // Some browsers expose Notification but reject desktop presentation.
        }
      }
    },
    { immediate: true },
  );
}
