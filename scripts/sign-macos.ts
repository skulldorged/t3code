import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  const identity = process.env.T3CODE_MACOS_SELF_SIGN_IDENTITY;
  if (identity) {
    const keychain = process.env.T3CODE_MACOS_SELF_SIGN_KEYCHAIN;
    if (!/^[0-9A-F]{40}$/.test(identity) || !keychain) {
      throw new Error(
        "Project signing requires a pinned certificate fingerprint and keychain.",
      );
    }
    await signApplication({
      ...options,
      identity,
      keychain,
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      strictVerify: true,
      optionsForFile: (file, context) => ({
        ...options.optionsForFile?.(file, context),
        hardenedRuntime: false,
        timestamp: "none",
      }),
      batchCodesignCalls: true,
    });
    return;
  }
  await signApplication({ ...options, batchCodesignCalls: true });
}
