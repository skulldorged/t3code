import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";

import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { collectShellThreads } from "./ShellThreadsPublisher.logic";

/**
 * Hands the sidebar's open threads to the desktop app, which publishes them for local desktop
 * shells. Only the desktop bridge offers this; elsewhere it does nothing.
 */
export function startShellThreadsPublisher(registry: AtomRegistry.AtomRegistry): () => void {
  const bridge = window.desktopBridge;
  if (!bridge?.publishShellThreads) return () => {};

  let published = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    timer = null;
    const environmentLabels = new Map<EnvironmentId, string>(
      registry
        .get(environmentSummaries.identitiesAtom)
        .map((identity) => [identity.environmentId, identity.label]),
    );
    const projectTitles = new Map<string, string>();
    for (const environmentId of environmentLabels.keys()) {
      const shell = registry.get(environmentShell.stateValueAtom(environmentId));
      if (Option.isNone(shell.snapshot)) continue;
      for (const project of shell.snapshot.value.projects) {
        projectTitles.set(`${environmentId}:${project.id}`, project.title);
      }
    }
    const threads = collectShellThreads({
      threads: registry.get(environmentThreadShells.threadShellsAtom),
      delegatedUnderParent: registry.get(environmentThreadShells.delegatedUnderParentAtom),
      environmentLabels,
      projectTitles,
      now: new Date().toISOString(),
    });
    // Running threads tick many times a second; only a changed list is sent.
    const serialized = JSON.stringify(threads);
    if (serialized === published) return;
    published = serialized;
    void bridge.publishShellThreads(threads).catch(() => {
      published = "";
    });
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(publish, 500);
  };

  const unsubscribers = [
    registry.subscribe(environmentThreadShells.threadShellsAtom, schedule, { immediate: true }),
    registry.subscribe(environmentThreadShells.delegatedUnderParentAtom, schedule),
    registry.subscribe(environmentSummaries.identitiesAtom, schedule),
  ];
  // Snoozed threads wake on their own clock.
  const wake = setInterval(schedule, 60_000);
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    clearInterval(wake);
    if (timer !== null) clearTimeout(timer);
  };
}
