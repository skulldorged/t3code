import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { useAgentDesktopState } from "../../state/agentDesktop";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { AgentDesktopWebView } from "./AgentDesktopWebView";

type AgentDesktopRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly desktopId: string;
}>;

export function AgentDesktopRouteScreen({ route }: AgentDesktopRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const { desktops } = useAgentDesktopState(environmentId);
  const desktop = desktops.find((entry) => entry.id === route.params.desktopId);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  const background = themeVariables["--color-sheet-solid"];
  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="flex-row items-center gap-3 px-4 py-3">
        <View className="flex-1">
          <AppText className="text-base font-semibold" numberOfLines={1}>
            {desktop?.title ?? route.params.desktopId}
          </AppText>
          {desktop?.request ? (
            <AppText className="text-xs text-foreground-muted" numberOfLines={2}>
              {desktop.request.reason}
            </AppText>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close desktop"
          hitSlop={8}
          onPress={onClose}
          className="size-8 items-center justify-center rounded-full bg-secondary"
        >
          <SymbolView
            name="xmark"
            size={13}
            tintColor={themeVariables["--color-foreground"]}
            type="monochrome"
          />
        </Pressable>
      </View>
      <AgentDesktopWebView
        environmentId={environmentId}
        desktopId={route.params.desktopId}
        interactive
        background={background}
        paused={!foreground}
      />
    </View>
  );
}
