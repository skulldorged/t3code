import { useIsFocused } from "@react-navigation/native";
import type { AgentDesktopSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { AgentDesktopWebView } from "./AgentDesktopWebView";

const PLAYER_WIDTH = 184;
/** An unanswered request this recent still floats open when the thread opens. */
const RECENT_REQUEST_MS = 10 * 60_000;
const PLAYER_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const PLAYER_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/** Floats a desktop over the thread when its agent asks the user to look. */
export function AgentDesktopFloat(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly desktops: ReadonlyArray<AgentDesktopSummary>;
  readonly loaded: boolean;
  readonly top: number;
  readonly onOpen: (desktopId: string) => void;
}) {
  const [desktopId, setDesktopId] = useState<string | null>(null);
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!props.loaded) return;
    const previous = seen.current;
    seen.current = new Map(
      props.desktops.map((desktop) => [desktop.id, desktop.request?.sequence ?? 0]),
    );
    // The first list is a baseline, so reopening a thread does not resurface old
    // requests, except one made moments ago, perhaps while the app was closed.
    const asked = props.desktops.findLast(
      (desktop) =>
        desktop.request !== undefined &&
        desktop.request.threadId === props.threadId &&
        (previous === null
          ? Date.now() - Date.parse(desktop.request.requestedAt) < RECENT_REQUEST_MS
          : desktop.request.sequence > (previous.get(desktop.id) ?? 0)),
    );
    if (asked !== undefined) setDesktopId(asked.id);
  }, [props.desktops, props.loaded, props.threadId]);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  const { themeVariables } = useAppearancePreferences();
  const desktop = props.desktops.find((entry) => entry.id === desktopId) ?? null;
  if (desktop === null || !focused) return null;
  const width = PLAYER_WIDTH;
  const height = Math.round(width / Math.min(Math.max(desktop.width / desktop.height, 0.5), 2));
  const background = themeVariables["--color-sheet-solid"];
  const close = () => setDesktopId(null);
  return (
    <Animated.View
      entering={PLAYER_ENTERING}
      exiting={PLAYER_EXITING}
      className="absolute right-3 z-30 overflow-hidden rounded-2xl border border-border shadow-md shadow-black/20"
      style={{ top: props.top, width, backgroundColor: background }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open desktop ${desktop.title}`}
        accessibilityHint="Opens the desktop full screen, where you can take control"
        onPress={() => {
          close();
          props.onOpen(desktop.id);
        }}
      >
        <View pointerEvents="none" style={{ height }}>
          <AgentDesktopWebView
            environmentId={props.environmentId}
            desktopId={desktop.id}
            interactive={false}
            background={background}
            compact
            paused={!foreground}
            onGone={close}
          />
        </View>
        {desktop.request ? (
          <AppText className="px-2.5 py-2 text-xs text-foreground" numberOfLines={3}>
            {desktop.request.reason}
          </AppText>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close floating desktop"
        hitSlop={8}
        onPress={close}
        className="absolute right-1.5 top-1.5 size-6 items-center justify-center rounded-full bg-black/55"
      >
        <SymbolView name="xmark" size={11} tintColor="#ffffff" type="monochrome" />
      </Pressable>
    </Animated.View>
  );
}
