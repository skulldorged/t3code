/**
 * Kimi Code instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-kimi/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const KimiSettings = makeProviderSettingsSchema(
  {
    // Off by default: Kimi Code is a separately installed CLI.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("kimi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Kimi Code CLI. T3 runs it as `kimi acp`.",
        providerSettingsForm: { placeholder: "kimi", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type KimiSettings = typeof KimiSettings.Type;
