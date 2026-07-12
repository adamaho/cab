import { describeScreen, type ScreenContext } from "../app/screen-context.ts";
import type { Store } from "../store/store.ts";

export interface BrowserMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly execute: (args: unknown) => unknown | Promise<unknown>;
}

export interface BrowserMcp {
  readonly tools: readonly BrowserMcpTool[];
  readonly call: (name: string, args?: unknown) => Promise<unknown>;
  readonly disconnect: () => void;
}

interface ModelContext {
  registerTool(tool: BrowserMcpTool): void;
  unregisterTool?(name: string): void;
}

function currentModelContext(): ModelContext | undefined {
  return (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
}

/** Connects public Cab commands to the browser model-context tool registry. @category agent @since 0.0.0 */
export function connectBrowserMcp(store: Store, agentId = "local-browser-agent"): BrowserMcp {
  const actor = { kind: "agent", id: agentId } as const;
  const commandTools: readonly BrowserMcpTool[] = store.describe().map((command) => ({
    name: command.name,
    description: command.description,
    inputSchema: command.argsSchema,
    execute: async (args: unknown) => {
      const result = await store.dispatchUnknown(command.name, args, actor);
      switch (result._tag) {
        case "Rejected":
          return { ok: false, rejection: result.rejection };
        case "Noop":
          return { ok: true, status: "noop", reason: result.reason };
        case "Accepted":
          return {
            ok: true,
            status: "accepted",
            commandId: result.command.id,
            commitId: result.commit.id,
            factIds: result.facts.map((fact) => fact.id),
            effectInvocationIds: result.effectInvocationIds,
          };
      }
    },
  }));
  const screenTool: BrowserMcpTool = {
    name: "discoverScreen",
    description:
      "Describe the selected screen, including visible content and route-relevant public commands",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: (): ScreenContext => describeScreen(store, store.state()),
  };
  const tools = [screenTool, ...commandTools];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const modelContext = currentModelContext();
  for (const tool of tools) modelContext?.registerTool(tool);

  return {
    tools,
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown browser MCP tool "${name}"`);
      return tool.execute(args);
    },
    disconnect() {
      for (const tool of tools) modelContext?.unregisterTool?.(tool.name);
    },
  };
}
