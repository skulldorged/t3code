import { useAuth as useClerkAuth, useUser as useClerkUser } from "@clerk/expo";
import { useSyncExternalStore } from "react";

import {
  readSelfHostedToken,
  selfHostedAuth,
  selfHostedAuthEnabled,
  signOutSelfHosted,
} from "./selfHostedAuth";

function useSelfHostedAuth(_options?: unknown) {
  const state = useSyncExternalStore(selfHostedAuth.subscribe, selfHostedAuth.getSnapshot);
  return {
    isLoaded: state.loaded,
    isSignedIn: state.account !== null,
    userId: state.account?.id ?? null,
    getToken: (_options?: unknown) => readSelfHostedToken(),
    signOut: signOutSelfHosted,
  };
}

export const useAuth = selfHostedAuthEnabled ? useSelfHostedAuth : useClerkAuth;

function useSelfHostedUser() {
  const state = useSyncExternalStore(selfHostedAuth.subscribe, selfHostedAuth.getSnapshot);
  return {
    isLoaded: state.loaded,
    isSignedIn: state.account !== null,
    user: state.account
      ? {
          id: state.account.id,
          primaryEmailAddress: state.account.email ? { emailAddress: state.account.email } : null,
        }
      : null,
  };
}

export const useUser = selfHostedAuthEnabled ? useSelfHostedUser : useClerkUser;
