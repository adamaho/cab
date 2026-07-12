import { afterEach, describe, expect, it, vi } from "vitest";
import { connectBrowserMcp } from "../src/agent/browser-mcp.ts";
import {
  completeTodosRefresh,
  failTodosRefresh,
  refreshTodos,
} from "../src/features/ingest/feature.ts";
import { navigate } from "../src/features/router/feature.ts";
import { setPageSize, setTheme } from "../src/features/settings/feature.ts";
import { scrollToTodo } from "../src/features/todos/feature.ts";
import { createStore } from "../src/store/store.ts";

const originalModelContext = (navigator as Navigator & { modelContext?: unknown }).modelContext;

afterEach(() => {
  Object.defineProperty(navigator, "modelContext", {
    configurable: true,
    value: originalModelContext,
  });
});

describe("browser MCP", () => {
  it("registers discovery and only public namespaced commands with the browser", () => {
    const registerTool = vi.fn();
    const unregisterTool = vi.fn();
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool, unregisterTool },
    });
    const store = createStore();

    const mcp = connectBrowserMcp(store);
    const names = mcp.tools.map((tool) => tool.name);

    expect(names).toEqual(["discoverScreen", ...store.describe().map((command) => command.name)]);
    expect(names).toContain(refreshTodos.name);
    expect(names).not.toContain(completeTodosRefresh.name);
    expect(names).not.toContain(failTodosRefresh.name);
    expect(registerTool).toHaveBeenCalledTimes(store.describe().length + 1);
    mcp.disconnect();
    expect(unregisterTool).toHaveBeenCalledTimes(store.describe().length + 1);
  });

  it("discovers possible effects and returns structured async command results", async () => {
    const store = createStore(() => "now");
    const mcp = connectBrowserMcp(store, "mcp-test");

    const observation = await mcp.call("discoverScreen");
    expect(observation).toMatchObject({
      screen: "todos",
      mode: "live",
      content: { page: 1 },
    });
    expect(
      (
        observation as { capabilities: readonly { command: string; possibleEffects: unknown }[] }
      ).capabilities.find((capability) => capability.command === scrollToTodo.name),
    ).toEqual({
      command: scrollToTodo.name,
      description: "Scroll a visible todo anchor into view",
      argsSchema: expect.any(Object),
      possibleEffects: [{ name: "todos.scrollToAnchor", phase: "after-render", replay: "manual" }],
    });

    const accepted = await mcp.call(navigate.name, { route: "settings" });
    expect(accepted).toMatchObject({
      ok: true,
      status: "accepted",
      commandId: expect.stringMatching(/^command-/),
      commitId: expect.stringMatching(/^commit-/),
      factIds: [expect.stringMatching(/^fact-/)],
      effectInvocationIds: [],
    });
    expect(store.journal().at(-1)).toMatchObject({
      name: "Navigated",
      actor: { kind: "agent", id: "mcp-test" },
    });

    await expect(mcp.call(setTheme.name, { theme: "light" })).resolves.toEqual({
      ok: true,
      status: "noop",
      reason: "That theme is already active",
    });
    await expect(mcp.call(setPageSize.name, { size: "huge" })).resolves.toMatchObject({
      ok: false,
      rejection: {
        code: "runtime.command.invalid-args",
        message: expect.stringContaining('Expected number, got "huge"'),
      },
    });
  });

  it("fails loudly for unknown tools", async () => {
    const mcp = connectBrowserMcp(createStore());
    await expect(mcp.call("missing.tool")).rejects.toThrow(
      'Unknown browser MCP tool "missing.tool"',
    );
  });
});
