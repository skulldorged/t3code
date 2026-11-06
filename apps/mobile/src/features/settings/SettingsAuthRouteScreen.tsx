import { useAuth } from "../cloud/cloudAuth";
import {
  AuthView,
  type UserProfileCustomPage,
  UserProfileView,
} from "@clerk/expo/native-components";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SelfHostedDevices } from "../cloud/SelfHostedDevices";
import {
  selfHostedAuth,
  selfHostedAuthEnabled,
  signInSelfHosted,
  signOutSelfHosted,
} from "../cloud/selfHostedAuth";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";

const USER_PROFILE_CUSTOM_PAGES = [
  {
    path: "t3-connect",
    label: "T3 Connect",
    icon: "globe",
    content: <T3ConnectProfilePage />,
  },
] satisfies UserProfileCustomPage[];

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen() {
  return hasCloudPublicConfig() ? (
    selfHostedAuthEnabled ? (
      <SelfHostedSettingsAuthRouteScreen />
    ) : (
      <ConfiguredSettingsAuthRouteScreen />
    )
  ) : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const handleHostBack = () => navigation.goBack();
  // Once signed in, stay on the profile view so signing out pops back instead of
  // flashing the sign-in form.
  const [hasBeenSignedIn, setHasBeenSignedIn] = useState(isSignedIn === true);
  if (isSignedIn && !hasBeenSignedIn) setHasBeenSignedIn(true);

  // Clerk reports sign-out only through its auth store (the native profile view
  // and the T3 Connect page can both sign out), so this follows that store.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when Clerk's auth store reports a sign-out from the profile view or Connect page
  useEffect(() => {
    if (hasBeenSignedIn && isLoaded && isSignedIn === false) {
      navigation.goBack();
    }
  }, [hasBeenSignedIn, isLoaded, isSignedIn, navigation]);

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      {isLoaded ? (
        hasBeenSignedIn ? (
          <UserProfileView
            customPages={USER_PROFILE_CUSTOM_PAGES}
            isDismissible={false}
            onHostBack={handleHostBack}
          />
        ) : (
          <AuthView isDismissible={false} onHostBack={handleHostBack} />
        )
      ) : null}
    </View>
  );
}

function SelfHostedSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth();
  const authState = useSyncExternalStore(selfHostedAuth.subscribe, selfHostedAuth.getSnapshot);
  const navigation = useNavigation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (operation: () => Promise<void>) => {
    setPending(true);
    setError(null);
    void operation()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "T3 Connect sign-in failed.");
      })
      .finally(() => setPending(false));
  };
  const accountControls = (
    <View className="gap-4 px-6 py-6">
      <AppText className="text-lg font-semibold text-foreground">
        {isSignedIn ? "Signed in to T3 Connect" : "Sign in to T3 Connect"}
      </AppText>
      {!isSignedIn ? (
        <AppText className="text-base text-foreground-muted">
          Continue in your browser to sign in. Your sign-in is remembered on this device.
        </AppText>
      ) : null}
      {error || authState.error ? (
        <AppText className="text-base text-danger-foreground">{error ?? authState.error}</AppText>
      ) : null}
      <Button
        label={
          !isLoaded
            ? "Retry loading sign-in"
            : isSignedIn
              ? "Sign out of this device"
              : "Continue to sign in"
        }
        loading={pending}
        tone={isSignedIn ? "danger" : "primary"}
        onPress={() =>
          run(!isLoaded ? selfHostedAuth.load : isSignedIn ? signOutSelfHosted : signInSelfHosted)
        }
      />
    </View>
  );
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title="T3 Connect" onBack={() => navigation.goBack()} />
      {isSignedIn ? (
        <T3ConnectProfilePage header={accountControls} footer={<SelfHostedDevices />} />
      ) : (
        accountControls
      )}
    </View>
  );
}
