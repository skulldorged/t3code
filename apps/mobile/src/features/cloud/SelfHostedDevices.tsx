import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  listSelfHostedSessions,
  revokeSelfHostedSession,
  type SelfHostedDeviceSession,
} from "./selfHostedAuth";

export function SelfHostedDevices() {
  const [sessions, setSessions] = useState<ReadonlyArray<SelfHostedDeviceSession>>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setPending(true);
    setError(null);
    try {
      setSessions(await listSelfHostedSessions());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load devices.");
    } finally {
      setPending(false);
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the relay's device sessions when the account page mounts
  useEffect(() => {
    void refresh();
  }, []);
  const revoke = async (id: string) => {
    setPending(true);
    setError(null);
    try {
      await revokeSelfHostedSession(id);
      setSessions((current) => current.filter((session) => session.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke device.");
    } finally {
      setPending(false);
    }
  };
  return (
    <View className="gap-3 px-6 pb-6">
      <AppText className="text-base font-semibold text-foreground">Signed-in devices</AppText>
      {error ? <AppText className="text-sm text-danger-foreground">{error}</AppText> : null}
      {sessions.map((session) => (
        <View key={session.id} className="gap-2">
          <AppText className="text-base text-foreground">
            {session.label || "T3 Connect device"}
          </AppText>
          <AppText className="text-sm text-foreground-muted">
            Signed in {new Date(session.createdAt).toLocaleDateString()}
          </AppText>
          <Button
            label="Revoke session"
            tone="danger"
            size="compact"
            disabled={pending}
            onPress={() => {
              void revoke(session.id);
            }}
          />
        </View>
      ))}
      <Button
        label="Refresh devices"
        size="compact"
        loading={pending}
        onPress={() => {
          void refresh();
        }}
      />
    </View>
  );
}
