import {
  AgentDesktopRegisterInput,
  AgentDesktopRequestInput,
  AgentDesktopStatusResult,
  AgentDesktopSummary,
  AgentDesktopTargetInput,
  AgentDesktopToolError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as AgentDesktopService from "../../../agentDesktop/AgentDesktopService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AgentDesktopService.AgentDesktopService,
];

const AgentDesktopToolFailure = Schema.Union([AgentDesktopToolError, OrchestratorMcpFailure]);

/**
 * For tooling that runs desktops for agents (it calls these itself), not
 * for agents to drive desktops: they keep using their own tools for that.
 */
const AgentDesktopRegisterTool = Tool.make("agent_desktop_register", {
  description:
    "Register a VNC desktop you run (a loopback port with no password) with this thread, so the user can watch it in the thread's right panel and take control of it. Calling it again updates the title and size.",
  parameters: AgentDesktopRegisterInput,
  success: AgentDesktopSummary,
  failure: AgentDesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Register desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AgentDesktopUnregisterTool = Tool.make("agent_desktop_unregister", {
  description: "Remove a desktop from this thread's panel, for example after stopping it.",
  parameters: AgentDesktopTargetInput,
  success: Schema.Struct({}),
  failure: AgentDesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Unregister desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AgentDesktopStatusTool = Tool.make("agent_desktop_status", {
  description:
    'Whether the user has taken control of a registered desktop. While controlledBy is "user", send no input to it; this thread gets a notice when they hand it back.',
  parameters: AgentDesktopTargetInput,
  success: AgentDesktopStatusResult,
  failure: AgentDesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Desktop status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AgentDesktopRequestTool = Tool.make("agent_desktop_request", {
  description:
    "Ask the user to look at a registered desktop, for example to solve a CAPTCHA or approve a passkey prompt: it floats open for them with your reason. When they take control and hand it back, this thread gets a notice.",
  parameters: AgentDesktopRequestInput,
  success: Schema.Struct({}),
  failure: AgentDesktopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Ask the user about a desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const AgentDesktopToolkit = Toolkit.make(
  AgentDesktopRegisterTool,
  AgentDesktopUnregisterTool,
  AgentDesktopStatusTool,
  AgentDesktopRequestTool,
);
