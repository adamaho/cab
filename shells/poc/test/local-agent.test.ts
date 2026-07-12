import { describe, expect, it, vi } from "vitest";
import { connectBrowserMcp } from "../src/agent/browser-mcp.ts";
import { runLocalAgent, type BrowserLanguageModelSession } from "../src/agent/local-agent.ts";
import { navigate } from "../src/features/router/feature.ts";
import { setTheme } from "../src/features/settings/feature.ts";
import { createStore } from "../src/store/store.ts";

function model(...responses: string[]): BrowserLanguageModelSession {
  return {
    prompt: vi.fn(async (_input, onProgress) => {
      const response = responses.shift() ?? '{"done":true}';
      onProgress?.(response.length);
      return response;
    }),
  };
}

describe("local browser agent", () => {
  it("observes, executes namespaced commands, and stops when the goal is complete", async () => {
    const store = createStore(() => "now");
    const session = model(
      JSON.stringify({ command: navigate.name, args: { route: "settings" } }),
      JSON.stringify({ command: setTheme.name, args: { theme: "dark" } }),
      '{"done":true,"summary":"Dark mode is active"}',
    );
    const onStatus = vi.fn();

    const result = await runLocalAgent({
      goal: "Switch to dark mode",
      mcp: connectBrowserMcp(store, "local-test"),
      createModel: async () => session,
      onStatus,
    });

    expect(result).toMatchObject({ status: "completed", message: "Dark mode is active" });
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]?.result).toMatchObject({
      ok: true,
      status: "accepted",
      commandId: expect.any(String),
      commitId: expect.any(String),
      factIds: [expect.any(String)],
      effectInvocationIds: [],
    });
    expect(store.state()).toMatchObject({ route: "settings", theme: "dark" });
    expect(store.journal().every((fact) => fact.actor.id === "local-test")).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith("Model ready. Observing the current screen…");
    expect(onStatus).toHaveBeenCalledWith("Model ready. Thinking through step 1 of 12…");
    expect(onStatus).toHaveBeenCalledWith(
      expect.stringMatching(/^Generating decision for step 1 of 12… \d+ characters$/),
    );
    expect(onStatus).toHaveBeenCalledWith(`Executing ${navigate.name}…`);
  });

  it("rejects hallucinated namespaced commands before execution", async () => {
    const store = createStore();
    const hallucinated = "todos.deleteEverything";
    const result = await runLocalAgent({
      goal: "Do something impossible",
      mcp: connectBrowserMcp(store),
      createModel: async () => model(JSON.stringify({ command: hallucinated, args: {} })),
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain(`unavailable command "${hallucinated}"`);
    expect(store.journal()).toHaveLength(0);
  });

  it("fails safely on malformed output and at the step limit", async () => {
    const malformed = await runLocalAgent({
      goal: "Navigate",
      mcp: connectBrowserMcp(createStore()),
      createModel: async () => model("not json"),
    });
    expect(malformed.status).toBe("failed");

    const limited = await runLocalAgent({
      goal: "Keep navigating",
      mcp: connectBrowserMcp(createStore()),
      createModel: async () =>
        model(JSON.stringify({ command: navigate.name, args: { route: "about" } })),
      maxSteps: 1,
    });
    expect(limited).toMatchObject({
      status: "failed",
      message: "Agent reached the 1-step safety limit",
    });
  });

  it("interrupts generation that exceeds the safety timeout", async () => {
    const interrupt = vi.fn();
    const result = await runLocalAgent({
      goal: "Navigate",
      mcp: connectBrowserMcp(createStore()),
      createModel: async () => ({
        prompt: async () => new Promise<string>(() => undefined),
        interrupt,
      }),
      generationTimeoutMs: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.message).toBe("The local model did not finish within 1 seconds");
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("does not start without a goal", async () => {
    const createModel = vi.fn(async () => model('{"done":true}'));
    const result = await runLocalAgent({
      goal: "  ",
      mcp: connectBrowserMcp(createStore()),
      createModel,
    });
    expect(result.message).toBe("Enter a goal for the agent");
    expect(createModel).not.toHaveBeenCalled();
  });
});
