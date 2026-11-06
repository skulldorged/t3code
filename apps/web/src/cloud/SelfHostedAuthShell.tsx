import { createCloudAccountService } from "@t3tools/client-runtime/relay";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  cleanUpManagedRelayAccount,
} from "./managedAuth";
import { resolveCloudPublicConfig } from "./publicConfig";
import { selfHostedAuth } from "./selfHostedAuth";
import { T3_CONNECT_ACCOUNT_PAGES } from "../components/clerk/T3ConnectAccountPages";

export const SELF_HOSTED_ACCOUNT_EVENT = "t3:connect-account";
export function openSelfHostedAccount(page?: string) {
  window.dispatchEvent(new CustomEvent(SELF_HOSTED_ACCOUNT_EVENT, { detail: page }));
}
const accountService = createCloudAccountService<typeof selfHostedAuth>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: cleanUpManagedRelayAccount,
  activate: ({ accountId }) =>
    activateManagedRelayAuthentication(accountId, selfHostedAuth.getToken),
});
interface DeviceSession {
  readonly id: string;
  readonly label?: string;
  readonly createdAt?: string;
  readonly lastSeenAt?: string;
  readonly current?: boolean;
}
async function sessionRequest(path = "", method = "GET") {
  const token = await selfHostedAuth.getToken();
  if (!token) throw new Error("Sign in to manage your devices.");
  const response = await fetch(
    new URL(`/auth/sessions${path}`, resolveCloudPublicConfig().relayUrl!),
    { method, headers: { authorization: `Bearer ${token}` }, credentials: "include" },
  );
  if (!response.ok) throw new Error("Could not update device sessions.");
  return response.json();
}
export default function SelfHostedAuthShell({
  children,
}: {
  readonly children: ReactNode;
  readonly publishableKey?: string;
}) {
  const state = useSyncExternalStore(selfHostedAuth.subscribe, selfHostedAuth.getSnapshot);
  const [page, setPage] = useState<string | null>(null);
  const [devices, setDevices] = useState<readonly DeviceSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the external account lifecycle and app-owned account dialog requests
  useEffect(() => {
    const detach = accountService.attach(selfHostedAuth);
    const open = (event: Event) => setPage((event as CustomEvent<string>).detail ?? "t3-connect");
    window.addEventListener(SELF_HOSTED_ACCOUNT_EVENT, open);
    return () => {
      detach();
      window.removeEventListener(SELF_HOSTED_ACCOUNT_EVENT, open);
    };
  }, []);
  const refreshDevices = async () => {
    const result = (await sessionRequest()) as { sessions: DeviceSession[] };
    setDevices(result.sessions);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the relay's device list when its account dialog opens
  useEffect(() => {
    if (page === "devices" && state.session)
      void refreshDevices().catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load devices."),
      );
  }, [page, state.session?.account.id]);
  const run = async (operation: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete the request.");
    } finally {
      setBusy(false);
    }
  };
  const selected = T3_CONNECT_ACCOUNT_PAGES.find((item) => item.url === page);
  return (
    <>
      {children}
      <Dialog
        open={page !== null}
        onOpenChange={(open) => {
          if (!open) setPage(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>T3 Connect</DialogTitle>
            <DialogDescription>
              {state.session?.account.email ??
                (state.session
                  ? "Manage your account and devices."
                  : "Sign in using your account server.")}
            </DialogDescription>
          </DialogHeader>
          {(error ?? state.error) ? <p role="alert">{error ?? state.error}</p> : null}
          {state.session ? (
            <>
              <div className="flex flex-wrap gap-2">
                {T3_CONNECT_ACCOUNT_PAGES.map((item) => (
                  <Button key={item.url} variant="outline" onClick={() => setPage(item.url)}>
                    {item.label}
                  </Button>
                ))}
                <Button variant="outline" onClick={() => setPage("devices")}>
                  Signed-in devices
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await selfHostedAuth.signOut();
                      setPage(null);
                    })
                  }
                >
                  Sign out
                </Button>
              </div>
              {page === "devices" ? (
                <div className="space-y-3">
                  {devices.map((device) => (
                    <div key={device.id} className="flex items-center justify-between gap-3">
                      <div>
                        <p>
                          {device.label ?? "Signed-in device"}
                          {device.current ? " (this device)" : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {device.lastSeenAt ?? device.createdAt ?? ""}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await sessionRequest(`/${encodeURIComponent(device.id)}`, "DELETE");
                            if (device.current) {
                              await selfHostedAuth.signOut();
                              setPage(null);
                            } else await refreshDevices();
                          })
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                  {devices.length === 0 ? <p>No signed-in devices.</p> : null}
                </div>
              ) : (
                selected?.content
              )}
            </>
          ) : (
            <Button disabled={busy} onClick={() => void run(selfHostedAuth.signIn)}>
              Sign in
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
