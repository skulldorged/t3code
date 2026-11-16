// @effect-diagnostics nodeBuiltinImport:off -- a copy's file is streamed from disk.
// Fork: this machine's side of `t3_copy` for linked machines, behind the
// /mcp credential and the same full-access check as `t3_run`.
import * as NodeFS from "node:fs";

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { layerMcpAuthentication } from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, loadCaller } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as FileTransfer from "./FileTransfer.ts";

const fullAccessRequired =
  "Copies need a full-access link and a live full-access/default calling thread.";

/** Why the caller may not copy, or undefined when it may. */
const refusal = Effect.fn("CommandsHttp.refusal")(
  function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (scope.client?.access === "read-only") return fullAccessRequired;
    const caller = yield* loadCaller();
    yield* assertLiveCaller(caller);
    yield* assertFullAccess(caller, fullAccessRequired);
    return undefined;
  },
  Effect.catch((error) => Effect.succeed(error.message)),
);

const authorizeWith = (threads: ThreadManagement.ThreadManagementService["Service"]) =>
  refusal().pipe(Effect.provideService(ThreadManagement.ThreadManagementService, threads));

const queryOf = (request: HttpServerRequest.HttpServerRequest) =>
  Option.match(HttpServerRequest.toURL(request), {
    onNone: () => new URLSearchParams(),
    onSome: (url) => url.searchParams,
  });

const failure = (error: FileTransfer.TransferError) =>
  HttpServerResponse.text(error.message, { status: error.status });

const routes = (
  transfer: FileTransfer.FileTransfer["Service"],
  threads: ThreadManagement.ThreadManagementService["Service"],
) => {
  const authorize = authorizeWith(threads);
  const layerServe = HttpRouter.add(
    "GET",
    FileTransfer.FILES_ROUTE,
    Effect.gen(function* () {
      const refused = yield* authorize;
      if (refused !== undefined) return HttpServerResponse.text(refused, { status: 403 });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = queryOf(request).get("path");
      if (path === null || path.trim().length === 0) {
        return HttpServerResponse.text("Pass a path.", { status: 400 });
      }
      const served = yield* transfer.serve(path).pipe(Effect.result);
      if (served._tag === "Failure") return failure(served.failure);
      const { kind, mode, file, size, cleanup } = served.success;
      const body = NodeStream.fromReadable<Uint8Array>({
        evaluate: () => NodeFS.createReadStream(file),
      }).pipe(Stream.ensuring(cleanup));
      return HttpServerResponse.stream(body, {
        contentType: "application/octet-stream",
        contentLength: size,
        headers: {
          [FileTransfer.headers.kind]: kind,
          [FileTransfer.headers.mode]: mode.toString(8),
        },
      });
    }),
  );

  const layerReceive = HttpRouter.add(
    "POST",
    FileTransfer.FILES_ROUTE,
    Effect.gen(function* () {
      const refused = yield* authorize;
      if (refused !== undefined) return HttpServerResponse.text(refused, { status: 403 });
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = queryOf(request);
      const path = query.get("path");
      const kind = query.get("kind");
      const mode = Number.parseInt(query.get("mode") ?? "", 8);
      const offset = Number(query.get("offset") ?? "");
      if (
        path === null ||
        path.trim().length === 0 ||
        (kind !== "file" && kind !== "directory") ||
        !Number.isInteger(mode) ||
        mode < 0 ||
        mode > 0o7777 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      ) {
        return HttpServerResponse.text("Bad copy request.", { status: 400 });
      }
      // Keep the request stream in the route scope until the response is sent.
      const bodyPull = yield* Stream.toPull(request.stream);
      const received = yield* transfer
        .receive({
          path,
          kind,
          mode,
          transfer: query.get("transfer") ?? "",
          offset,
          final: query.get("final") === "1",
          overwrite: query.get("overwrite") === "1",
          body: Stream.toAsyncIterable(Stream.fromPull(Effect.succeed(bodyPull))),
        })
        .pipe(Effect.result);
      if (received._tag === "Failure") return failure(received.failure);
      return HttpServerResponse.jsonUnsafe(received.success);
    }),
  );

  return Layer.mergeAll(layerServe, layerReceive);
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const transfer = yield* FileTransfer.FileTransfer;
    const threads = yield* ThreadManagement.ThreadManagementService;
    return routes(transfer, threads);
  }),
).pipe(Layer.provide(layerMcpAuthentication()));
