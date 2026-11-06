import { isSelfHostedConnect } from "../../cloud/selfHostedAuth";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";
import { connectLoopbackRedirectUri } from "@t3tools/shared/connectAuth";
import { useClerk } from "@clerk/react";
import { useAuth } from "../../cloud/auth";
import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

const invalidLinkMessage = {
  context: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
} as const;

export function ConnectCliAuthorizeSurface() {
  return isSelfHostedConnect() ? <SelfHostedCliAuthorizeSurface /> : <ClerkCliAuthorizeSurface />;
}

function ClerkCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = () => {
    if (!request) {
      return;
    }
    clerk.openSignIn(
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  };
  const openSignInOnLoad = useEffectEvent(openSignIn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens Clerk sign-in or navigates the window to the authorize URL once Clerk has loaded
  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignInOnLoad();
      }
      return;
    }
    const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
    redirecting.current = true;
    window.location.assign(authorizeUrl);
  }, [isLoaded, isSignedIn, request]);

  if (!request) {
    return (
      <StandalonePage>
        <StandalonePageHeader {...invalidLinkMessage} />
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        context="Browser authorization"
        title="Connecting your terminal"
        description={
          isSignedIn
            ? "Redirecting to authorize T3 Connect for your CLI…"
            : "Sign in to continue authorizing T3 Connect for your CLI."
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      ) : null}
    </StandalonePage>
  );
}

function SelfHostedCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const authorize = async () => {
    if (!request) return;
    setError(null);
    const response = await fetch(new URL("/auth/start", resolveCloudPublicConfig().relayUrl!), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirectUri: connectLoopbackRedirectUri(request.loopbackPort),
        codeChallenge: request.challenge,
        clientKind: "cli",
        state: request.state,
      }),
    });
    if (!response.ok)
      throw new Error("Could not start terminal authorization. Retry from your terminal.");
    const result = (await response.json()) as { authorizationUrl: string };
    if (
      typeof result.authorizationUrl !== "string" ||
      new URL(result.authorizationUrl).protocol !== "https:"
    )
      throw new Error("Invalid authorization URL.");
    window.location.assign(result.authorizationUrl);
  };
  const authorizeOnLoad = useEffectEvent(authorize);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the terminal's PKCE authorization request to the account server once per page load
  useEffect(() => {
    if (request && !started.current) {
      started.current = true;
      void authorizeOnLoad().catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not authorize your terminal."),
      );
    }
  }, [request]);
  return (
    <StandalonePage>
      <StandalonePageHeader
        {...(request
          ? {
              context: "Browser authorization",
              title: "Connecting your terminal",
              description: "Sign in with your account server to authorize T3 Connect.",
            }
          : invalidLinkMessage)}
      />
      {error ? <p role="alert">{error}</p> : null}
      {request && error ? (
        <Button
          onClick={() =>
            void authorize().catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : "Could not authorize."),
            )
          }
        >
          Try again
        </Button>
      ) : null}
    </StandalonePage>
  );
}
