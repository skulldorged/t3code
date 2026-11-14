import { useClerk } from "@clerk/react";
import { isSelfHostedConnect } from "../../cloud/selfHostedAuth";

function useClerkStatusLoadFailed() {
  return useClerk().status === "error";
}

// Self-hosted sign-in mounts no ClerkProvider, so useClerk would throw there.
export const useClerkLoadFailed = isSelfHostedConnect() ? () => false : useClerkStatusLoadFailed;

export function retryClerkLoad() {
  // Clerk caches its failed script load for the life of the page and never
  // retries, so a reload is the only recovery.
  window.location.reload();
}
