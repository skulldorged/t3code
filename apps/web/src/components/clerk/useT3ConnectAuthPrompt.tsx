import { isSelfHostedConnect, selfHostedAuth } from "../../cloud/selfHostedAuth";
import { openSelfHostedAccount } from "../../cloud/SelfHostedAuthShell";
import { useClerk } from "@clerk/react";

import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

function useClerkT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { openAuthPrompt };
}

function useSelfHostedAuthPrompt() {
  return {
    openAuthPrompt: () => {
      void selfHostedAuth.bootstrap();
      openSelfHostedAccount();
    },
  };
}
export const useT3ConnectAuthPrompt = isSelfHostedConnect()
  ? useSelfHostedAuthPrompt
  : useClerkT3ConnectAuthPrompt;
