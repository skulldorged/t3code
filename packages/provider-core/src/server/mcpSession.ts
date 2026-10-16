import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/**
 * Variables that tell the commands a harness runs which thread they belong to
 * and how to reach T3's MCP endpoint as that thread, so a tool the agent
 * starts (a job runner that reports back when a build ends, for example) can
 * post to the thread or ask the user something on its behalf.
 */
export function threadCommandEnvironment(
  threadId: ThreadId,
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader"> | undefined,
): Record<string, string> {
  return {
    T3_THREAD_ID: threadId,
    ...(session === undefined
      ? {}
      : { T3_MCP_URL: session.endpoint, T3_MCP_AUTHORIZATION: session.authorizationHeader }),
  };
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
