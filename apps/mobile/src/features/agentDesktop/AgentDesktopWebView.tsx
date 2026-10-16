import agentDesktopStreamScript from "@t3tools/mobile-agent-desktop-stream";
import {
  type AgentDesktopControl,
  agentDesktopControlLabel,
} from "@t3tools/client-runtime/agent-desktop/control";
import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText } from "../../components/ui/AppText";
import { useAgentDesktopStreamAccess } from "../../state/agentDesktop";
import {
  type AgentDesktopStreamCommand,
  agentDesktopDocument,
  agentDesktopMessage,
} from "./agent-desktop-document";

/** Tickets are short-lived; a refused stream gets a fresh one this many times in a row. */
const MAX_REFUSALS = 3;

// One key per desktop for the app's lifetime, so control survives reopening the screen.
const viewerKeys = new Map<string, string>();
const viewerKeyFor = (environmentId: EnvironmentId, desktopId: string) => {
  const id = `${environmentId}:${desktopId}`;
  let key = viewerKeys.get(id);
  if (key === undefined) {
    key = Crypto.randomUUID();
    viewerKeys.set(id, key);
  }
  return key;
};

export function AgentDesktopWebView(props: {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly interactive: boolean;
  readonly background: string;
  /** The floating player shows only the screen. */
  readonly compact?: boolean;
  readonly paused?: boolean;
  readonly onGone?: () => void;
}) {
  const { access, refresh } = useAgentDesktopStreamAccess(props.environmentId);
  const webView = useRef<WebView>(null);
  const refusals = useRef(0);
  const [control, setControl] = useState<AgentDesktopControl | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const configuration = useMemo(() => {
    if (access === null) return null;
    const query = new URLSearchParams({
      desktopId: props.desktopId,
      viewer: viewerKeyFor(props.environmentId, props.desktopId),
      ...(props.interactive ? {} : { interactive: "false" }),
    });
    return JSON.stringify({
      url: withDeviceHubQuery(`${access.wsBase}/ws?${query.toString()}`, access),
      interactive: props.interactive,
      background: props.background,
    });
  }, [access, props.background, props.desktopId, props.environmentId, props.interactive]);
  const source = useMemo(
    () =>
      configuration === null
        ? null
        : {
            html: agentDesktopDocument(configuration, agentDesktopStreamScript),
            baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
          },
    [configuration],
  );
  useEffect(() => {
    const view = webView.current;
    return () => view?.injectJavaScript("window.T3AgentDesktopStream?.stop(); true;");
  }, [source]);
  const command = (input: AgentDesktopStreamCommand) =>
    webView.current?.injectJavaScript(
      `window.T3AgentDesktopStream?.command(${JSON.stringify(input)}); true;`,
    );
  const youHaveControl = control?.controller === "you";

  return (
    <View className="flex-1" style={{ backgroundColor: props.background }}>
      {!props.compact ? (
        <View className="flex-row items-center gap-2 border-b border-secondary-border px-3 py-2">
          <AppText className="flex-1 text-xs text-foreground-muted">
            {agentDesktopControlLabel(control)}
          </AppText>
          {youHaveControl ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full border border-secondary-border bg-secondary px-3 py-2"
              onPress={() => command({ type: "keyboard" })}
            >
              <AppText className="text-xs text-secondary-foreground">Keyboard</AppText>
            </Pressable>
          ) : null}
          {control?.canOperate ? (
            <Pressable
              accessibilityRole="button"
              disabled={control.controller === "another-viewer"}
              accessibilityState={{ disabled: control.controller === "another-viewer" }}
              className="rounded-full border border-secondary-border bg-secondary px-3 py-2"
              onPress={() => command({ type: youHaveControl ? "releaseControl" : "takeControl" })}
            >
              <AppText className="text-xs text-secondary-foreground">
                {youHaveControl ? "Give back to agent" : "Take control"}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {problem !== null ? (
        <View className="flex-1 items-center justify-center p-6">
          <AppText className="text-center text-sm text-foreground-muted">{problem}</AppText>
        </View>
      ) : source === null || props.paused ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <WebView<object>
          ref={webView}
          source={source}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
          contentInsetAdjustmentBehavior="never"
          setSupportMultipleWindows={false}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          style={{ flex: 1, backgroundColor: props.background }}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === source.baseUrl
          }
          onMessage={(event) => {
            const message = agentDesktopMessage(event.nativeEvent.data);
            if (message === null) return;
            if (message.type === "control") {
              setControl({ canOperate: message.canOperate, controller: message.controller });
              return;
            }
            switch (message.status) {
              case "live":
                refusals.current = 0;
                return;
              case "gone":
                setProblem("This desktop has stopped.");
                props.onGone?.();
                return;
              case "refused":
                if (refusals.current < MAX_REFUSALS) {
                  refusals.current += 1;
                  refresh();
                } else setProblem("Couldn't connect to this desktop.");
                return;
              case "error":
                setProblem("The desktop viewer stopped. Close it and open it again.");
                return;
              case "connecting":
                return;
            }
          }}
        />
      )}
    </View>
  );
}
