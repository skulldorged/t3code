import { useAuth as useClerkAuth } from "@clerk/react";
import { useSyncExternalStore } from "react";
import { isSelfHostedConnect, selfHostedAuth } from "./selfHostedAuth";
function useSelfHostedAuth(_options?: unknown) {
  const state = useSyncExternalStore(selfHostedAuth.subscribe, selfHostedAuth.getSnapshot);
  return {
    isLoaded: state.isLoaded,
    isSignedIn: state.session !== null,
    userId: state.session?.account.id ?? null,
    getToken: selfHostedAuth.getToken,
    signOut: selfHostedAuth.signOut,
  };
}
export const useAuth = isSelfHostedConnect() ? useSelfHostedAuth : useClerkAuth;
