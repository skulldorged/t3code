import { DesktopShellThreadsSchema } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PUBLISH_SHELL_THREADS_CHANNEL } from "../channels.ts";

const encodeShellThreads = Schema.encodeEffect(Schema.fromJsonString(DesktopShellThreadsSchema));

/**
 * Writes the sidebar's open threads to `$XDG_RUNTIME_DIR/t3code/threads.json`,
 * where a desktop shell on the same login can watch it. The runtime directory
 * belongs to the user and is cleared at logout; without one nothing is written.
 */
export const installShellThreads = Effect.fn("desktop.ipc.installShellThreads")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const app = yield* ElectronApp.ElectronApp;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = (yield* HostProcess.Environment).XDG_RUNTIME_DIR;
  const target = runtimeDir ? path.join(runtimeDir, "t3code", "threads.json") : null;
  // One write at a time, so a slow one never lands over a newer list.
  const writes = yield* Semaphore.make(1);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const write = (threads: typeof DesktopShellThreadsSchema.Type) =>
    target === null
      ? Effect.void
      : writes
          .withPermits(1)(
            Effect.gen(function* () {
              const encoded = yield* encodeShellThreads(threads);
              const temp = `${target}.tmp`;
              yield* fileSystem.makeDirectory(path.dirname(target), {
                recursive: true,
                mode: 0o700,
              });
              yield* fileSystem.writeFileString(temp, `${encoded}\n`, { mode: 0o600 });
              yield* fileSystem.rename(temp, target);
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not publish threads for the desktop shell", cause),
            ),
          );
  // A list left behind after quitting would show threads as still open.
  const remove =
    target === null ? Effect.void : fileSystem.remove(target, { force: true }).pipe(Effect.ignore);

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: PUBLISH_SHELL_THREADS_CHANNEL,
      payload: DesktopShellThreadsSchema,
      result: Schema.Void,
      handler: write,
    }),
  );
  yield* app.on("before-quit", () => {
    void runPromise(remove);
  });
  yield* Effect.addFinalizer(() => remove);
});
