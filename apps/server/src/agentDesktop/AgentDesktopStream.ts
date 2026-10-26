import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AGENT_DESKTOP_GONE_CODE,
  AGENT_DESKTOP_STREAM_BASE_PATH,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as AgentDesktopService from "./AgentDesktopService.ts";

/** A viewer this far behind is cut off; it reconnects and gets a fresh screen. */
const MAX_SOCKET_BUFFER_BYTES = 32 * 1024 * 1024;

const parseCommand = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * `GET /api/agent-desktop/ws?desktopId&viewer[&interactive=false]`: the
 * desktop's VNC as binary frames, with JSON text frames for who has control.
 */
const makeHandler = Effect.fnUntraced(function* (
  desktops: AgentDesktopService.AgentDesktopService["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (
    Option.isNone(url) ||
    url.value.pathname !== `${AGENT_DESKTOP_STREAM_BASE_PATH}/ws` ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const session = yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const params = url.value.searchParams;
  const desktopId = params.get("desktopId") ?? "";
  const viewerKey = params.get("viewer") ?? "";
  if (desktopId.length === 0 || viewerKey.length === 0 || viewerKey.length > 128) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const canOperate =
    session.scopes.includes(AuthOrchestrationOperateScope) && params.get("interactive") !== "false";
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const attached = yield* desktops
        .attachViewer({ desktopId, viewerKey, canOperate })
        .pipe(Effect.option);
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      // VNC encodings are already compressed.
      delete incoming.headers["sec-websocket-extensions"];
      const transport = incoming.socket;
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const gone = writer.write(new Socket.CloseEvent(AGENT_DESKTOP_GONE_CODE, "desktop gone"));
      if (Option.isNone(attached)) {
        yield* gone;
        return HttpServerResponse.empty();
      }
      const viewer = attached.value;
      const write = (data: Uint8Array | string) =>
        Effect.suspend(() => {
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
            return Effect.sync(() => transport.destroy()).pipe(Effect.andThen(Effect.interrupt));
          }
          return writer.write(data);
        });
      const sendOutput = Queue.take(viewer.output).pipe(
        Effect.flatMap((output) => {
          switch (output._tag) {
            case "data":
              return write(output.data);
            case "status": {
              const { _tag, ...status } = output;
              return write(JSON.stringify(status));
            }
            case "gone":
              return gone.pipe(Effect.andThen(Effect.interrupt));
            case "reconnect":
              return writer
                .write(new Socket.CloseEvent(1012, "reconnect"))
                .pipe(Effect.andThen(Effect.interrupt));
          }
        }),
      );
      const receive = Effect.fnUntraced(function* (chunk: Uint8Array | string) {
        if (typeof chunk !== "string") {
          viewer.send(chunk);
          return;
        }
        const command = parseCommand(chunk);
        if (typeof command !== "object" || command === null || !("type" in command)) return;
        if (command.type === "takeControl") yield* viewer.takeControl;
        else if (command.type === "releaseControl") yield* viewer.releaseControl;
      });
      const receiveInput = reader.pull.pipe(
        Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
      );
      return yield* Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receiveInput));
    }),
  ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const desktops = yield* AgentDesktopService.AgentDesktopService;
    yield* router.add("GET", `${AGENT_DESKTOP_STREAM_BASE_PATH}/*`, makeHandler(desktops));
  }),
);
