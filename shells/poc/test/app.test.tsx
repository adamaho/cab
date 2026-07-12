import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/app.tsx";
import { StoreProvider } from "../src/app/context.tsx";
import { createStore } from "../src/store/store.ts";

const todos = [{ id: 14, title: "Test todo", completed: false }] as const;
function setup(fetchTodos = async () => todos) {
  const store = createStore(() => "now");
  render(() => (
    <StoreProvider store={store} fetchTodos={fetchTodos}>
      <App />
    </StoreProvider>
  ));
  return store;
}
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("POC application", () => {
  it("runs initial refresh through the command and renders fetched rows", async () => {
    const store = setup();
    expect(store.journal()[0]?.name).toBe("RefreshRequested");
    expect(await screen.findByText("Test todo")).toBeTruthy();
    expect(store.journal()[1]?.name).toBe("RefreshCompleted");
  });

  it("navigates through commands and applies event-sourced settings", async () => {
    const store = setup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
    expect(document.querySelector(".app")?.classList.contains("dark")).toBe(true);
    expect(store.journal().map((fact) => fact.name)).toEqual(
      expect.arrayContaining(["Navigated", "ThemeChanged"]),
    );
  });

  it("journals validated table interactions", async () => {
    const store = setup();
    await screen.findByText("Test todo");
    fireEvent.click(screen.getByText("Test todo"));
    fireEvent.click(screen.getByLabelText("Toggle Test todo"));
    expect(store.journal().map((fact) => fact.name)).toEqual(
      expect.arrayContaining(["TodoSelected", "TodoToggled"]),
    );
  });

  it("scrubs route and disables writes until Live", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    fireEvent.input(screen.getByLabelText("Journal sequence"), { target: { value: "0" } });
    expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  });

  it("explains and fences destructive branch continuation", async () => {
    let resolve!: (value: typeof todos) => void;
    const fetchTodos = vi.fn(() => new Promise<typeof todos>((done) => (resolve = done)));
    const store = setup(fetchTodos);
    await waitFor(() => expect(fetchTodos).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    fireEvent.input(screen.getByLabelText("Journal sequence"), { target: { value: "0" } });
    expect(screen.getByRole("note").textContent).toBe(
      "Continuing creates a new runtime branch. Already completed external work is not undone.",
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Continue from here" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete 2 future events and continue from here? This cannot be undone.",
    );
    await waitFor(() => {
      expect(store.journal()).toHaveLength(0);
      expect(store.invocations()).toHaveLength(0);
      expect(store.isLive()).toBe(true);
      expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
    });

    resolve(todos);
    await tick();
    expect(store.journal()).toHaveLength(0);
    expect(store.cachedPayloadCount()).toBe(0);
  });

  it("runs ordered navigate, filter, toggle, and theme agent events", async () => {
    const store = setup();
    await screen.findByText("Test todo");
    fireEvent.click(screen.getByRole("button", { name: "Simulate agent" }));
    await waitFor(() => {
      const names = store
        .journal()
        .filter((fact) => fact.actor.kind === "agent")
        .map((fact) => fact.name);
      expect(names).toEqual(["Navigated", "TodosFiltered", "TodoToggled", "ThemeChanged"]);
    });
    expect(screen.getAllByText(/Agent bot/)).toHaveLength(4);
  });

  it("shows a readable agent failure when refresh fails", async () => {
    setup(async () => Promise.reject(new Error("offline")));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Simulate agent" }));
    expect(await screen.findByText("Todo refresh failed: offline")).toBeTruthy();
  });

  it("never replays on scrub or target remount and replays one selected invocation with consent", async () => {
    const store = setup();
    await screen.findByText("Test todo");
    const original = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      fireEvent.click(screen.getByRole("tab", { name: "Screen context" }));
      fireEvent.click(screen.getByRole("button", { name: "Test scroll to todo" }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const invocation = store
        .invocations()
        .find((item) => item.definition === "todos.scrollToAnchor")!;

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Todos" }));
      await tick();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
      fireEvent.input(screen.getByLabelText("Journal sequence"), { target: { value: "0" } });
      fireEvent.click(screen.getByRole("button", { name: "Live" }));
      await tick();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("tab", { name: "Effects" }));
      expect(screen.getByRole("heading", { name: "Invocation telemetry" })).toBeTruthy();
      expect(screen.getByText("todos.scrollToAnchor")).toBeTruthy();
      expect(screen.getByText(invocation.id)).toBeTruthy();
      const replay = screen.getByRole("button", { name: "Replay this invocation" });
      expect(replay.hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByLabelText("Enable manual presentation replay"));
      expect(replay.hasAttribute("disabled")).toBe(false);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      fireEvent.click(replay);
      expect(confirm).toHaveBeenCalledWith(
        `Replay todos.scrollToAnchor for invocation ${invocation.id}? This runs presentation work again but does not dispatch an outcome.`,
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      const factCount = store.journal().length;
      confirm.mockReturnValue(true);
      fireEvent.click(replay);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
      expect(store.journal()).toHaveLength(factCount);
      await waitFor(() =>
        expect(screen.getByLabelText(`Executions for ${invocation.id}`).textContent).toMatch(
          /manual-replay · succeeded/,
        ),
      );
      expect(
        store
          .executions()
          .filter((execution) => execution.invocationId === invocation.id)
          .map((execution) => execution.mode),
      ).toEqual(["live", "manual-replay"]);
    } finally {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: original,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("describes namespaced page commands, possible effects, and visible content for agents", async () => {
    const store = setup();
    await screen.findByText("Test todo");
    fireEvent.click(screen.getByRole("tab", { name: "Screen context" }));

    expect(screen.getByText("Available on todos")).toBeTruthy();
    expect(screen.getByText("todos.scrollTo")).toBeTruthy();
    expect(screen.getByText(/"possibleEffects": \[/)).toBeTruthy();
    expect(screen.getByText(/#todo-14/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test scroll to todo" }));
    expect(store.journal().at(-1)).toMatchObject({
      name: "TodoScrollRequested",
      args: { id: 14 },
    });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Available on settings")).toBeTruthy();
    expect(screen.queryByText("todos.scrollTo")).toBeNull();
    expect(screen.getByText("settings.setTheme")).toBeTruthy();
  });

  it("exposes only public namespaced command descriptions and schemas", () => {
    setup();
    fireEvent.click(screen.getByRole("tab", { name: "Command palette" }));
    expect(screen.getByText("todos.toggle")).toBeTruthy();
    expect(screen.getByText("Set a todo completion override.")).toBeTruthy();
    expect(screen.queryByText("todos.completeRefresh")).toBeNull();
    expect(screen.queryByText("todos.failRefresh")).toBeNull();
  });
});
