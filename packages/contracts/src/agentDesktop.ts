/**
 * Agent desktops - VNC desktops an agent registered with its thread, such as
 * a headless desktop running a GUI app or a headed browser. The environment
 * server proxies each one's VNC so clients can watch it in the right panel
 * and take control of it, the way they take control of a server browser tab.
 *
 * @module AgentDesktop
 */
import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Clients reach a desktop's VNC through `${base}/ws?desktopId=...`. */
export const AGENT_DESKTOP_STREAM_BASE_PATH = "/api/agent-desktop";
/** The stream closes with this when the desktop is no longer registered. */
export const AGENT_DESKTOP_GONE_CODE = 4404;

export const AgentDesktopId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);
export type AgentDesktopId = typeof AgentDesktopId.Type;

/** Who may send input: the agent, or the person who took control. */
export const AgentDesktopController = Schema.Literals(["agent", "user"]);
export type AgentDesktopController = typeof AgentDesktopController.Type;

/** An agent's request for the user to look at the desktop, such as a CAPTCHA. */
export const AgentDesktopRequest = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.String,
  requestedAt: Schema.String,
  /** Increases with each request, so clients float the desktop open once per request. */
  sequence: Schema.Int,
});
export type AgentDesktopRequest = typeof AgentDesktopRequest.Type;

export const AgentDesktopSummary = Schema.Struct({
  id: AgentDesktopId,
  title: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  /** Threads that registered the desktop; it shows in each one's panel. */
  threadIds: Schema.Array(ThreadId),
  controlledBy: AgentDesktopController,
  request: Schema.optional(AgentDesktopRequest),
  registeredAt: Schema.String,
});
export type AgentDesktopSummary = typeof AgentDesktopSummary.Type;

export const AgentDesktopState = Schema.Struct({
  desktops: Schema.Array(AgentDesktopSummary),
});
export type AgentDesktopState = typeof AgentDesktopState.Type;

/** Text frames the desktop stream sends beside the VNC bytes. */
export type AgentDesktopStreamStatus = {
  readonly type: "control";
  readonly state: "agent" | "you" | "another-viewer";
};

/** Text frames a viewer sends; binary frames are VNC client messages. */
export type AgentDesktopStreamCommand =
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" };

export const AgentDesktopRegisterInput = Schema.Struct({
  desktopId: AgentDesktopId.annotate({ description: "The desktop's id, such as desk-3f2a1c." }),
  title: Schema.optional(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "A short name for the panel tab. Defaults to the id.",
    }),
  ),
  vncPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).annotate({
    description: "The loopback TCP port of the desktop's VNC server, without a password.",
  }),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
});
export type AgentDesktopRegisterInput = typeof AgentDesktopRegisterInput.Type;

export const AgentDesktopTargetInput = Schema.Struct({
  desktopId: AgentDesktopId,
});
export type AgentDesktopTargetInput = typeof AgentDesktopTargetInput.Type;

export const AgentDesktopRequestInput = Schema.Struct({
  desktopId: AgentDesktopId,
  reason: Schema.String.check(Schema.isMaxLength(500)).annotate({
    description: "What the user should do, such as solving a CAPTCHA, in one sentence.",
  }),
});
export type AgentDesktopRequestInput = typeof AgentDesktopRequestInput.Type;

export const AgentDesktopStatusResult = Schema.Struct({
  registered: Schema.Boolean,
  controlledBy: AgentDesktopController,
});
export type AgentDesktopStatusResult = typeof AgentDesktopStatusResult.Type;

export class AgentDesktopToolError extends Schema.TaggedError<AgentDesktopToolError>()(
  "AgentDesktopToolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
