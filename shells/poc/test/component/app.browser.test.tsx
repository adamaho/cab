import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/app.tsx";
import { StoreProvider } from "../../src/app/context.tsx";
import { sortTodos } from "../../src/features/todos/feature.ts";
import { createStore } from "../../src/store/store.ts";
import type { Todo } from "../../src/store/types.ts";
import "../../src/styles.css";

const todos: readonly Todo[] = Array.from({ length: 25 }, (_, index) => ({
  id: index + 1,
  title: `Task ${index + 1}`,
  completed: index % 3 === 0,
}));

function setup(options?: {
  readonly data?: readonly Todo[];
  readonly fetchTodos?: () => Promise<readonly Todo[]>;
}) {
  const store = createStore(() => "2026-07-11T00:00:00.000Z");
  render(() => (
    <StoreProvider
      store={store}
      fetchTodos={options?.fetchTodos ?? (async () => options?.data ?? todos)}
    >
      <App />
    </StoreProvider>
  ));
  return store;
}

async function loaded() {
  await screen.findByRole("cell", { name: "Task 1" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("POC browser components", () => {
  describe("data and todo interactions", () => {
    it("loads external-shaped data through journaled intent and outcome", async () => {
      const store = setup();
      expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

      await loaded();

      expect(
        store
          .journal()
          .map((fact) => fact.name)
          .slice(0, 2),
      ).toEqual(["RefreshRequested", "RefreshCompleted"]);
      expect(screen.getByText("Showing 10 of 25 matching todos.")).toBeVisible();
      expect(JSON.stringify(store.journal())).not.toContain("Task 1");
    });

    it("sorts, filters, selects, and toggles rows through commands", async () => {
      const store = setup();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Title" }));
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "incomplete" } });
      const task = await screen.findByRole("cell", { name: "Task 2" });
      fireEvent.click(task);
      expect(document.querySelector("#todo-2")?.classList.contains("selected")).toBe(true);
      fireEvent.click(screen.getByLabelText("Toggle Task 2"));

      expect(store.journal().map((fact) => fact.name)).toEqual(
        expect.arrayContaining(["TodosSorted", "TodosFiltered", "TodoSelected", "TodoToggled"]),
      );
      expect(store.state().selectedId).toBe(2);
      expect(store.state().toggles[2]).toBe(true);
      expect(document.querySelector("#todo-2")).toBeNull();
    });

    it("paginates rendered rows and exposes stable semantic anchors", async () => {
      const store = setup();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Next" }));

      expect(await screen.findByText("Page 2 of 3")).toBeVisible();
      expect(screen.getByRole("cell", { name: "Task 11" })).toBeVisible();
      expect(document.querySelector("#todo-11")).toBeInstanceOf(HTMLTableRowElement);
      expect(screen.queryByRole("cell", { name: "Task 1" })).toBeNull();
      expect(store.state().page).toBe(2);
    });

    it("dispatches semantic scrolling only when requested", async () => {
      const store = setup();
      await loaded();
      const scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      fireEvent.click(screen.getByRole("tab", { name: "Screen context" }));

      fireEvent.click(screen.getByRole("button", { name: "Test scroll to todo" }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      store.dispatch(sortTodos.make({ by: "title" }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(store.journal().at(-2)?.name).toBe("TodoScrollRequested");
    });
  });

  describe("screen context and settings", () => {
    it("shows only capabilities relevant to the current screen", async () => {
      setup();
      await loaded();
      fireEvent.click(screen.getByRole("tab", { name: "Screen context" }));

      expect(screen.getByText("Available on todos")).toBeVisible();
      expect(screen.getByText("todos.scrollTo")).toBeVisible();
      expect(screen.getByText(/#todo-1/)).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByText("Available on settings")).toBeVisible();
      expect(screen.getByText("settings.setTheme")).toBeVisible();
      expect(screen.queryByText("todos.scrollTo")).toBeNull();
    });

    it("applies event-sourced theme and page-size settings", async () => {
      const store = setup();
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));

      fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
      fireEvent.change(screen.getByLabelText("Table page size"), { target: { value: "5" } });

      expect(document.querySelector(".app")).toHaveClass("dark");
      expect(store.state()).toMatchObject({ theme: "dark", pageSize: 5 });
      expect(store.journal().map((fact) => fact.name)).toEqual(
        expect.arrayContaining(["ThemeChanged", "PageSizeChanged"]),
      );
    });

    it("collapses and restores the floating theatre panel", async () => {
      setup();
      await loaded();

      fireEvent.click(screen.getByRole("button", { name: "Hide theatre mode" }));
      expect(screen.queryByRole("heading", { name: "Theatre mode" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open theatre mode" }));
      expect(screen.getByRole("heading", { name: "Theatre mode" })).toBeVisible();
    });
  });

  describe("theatre mode", () => {
    it("replays route and settings state before returning to Live", async () => {
      const store = setup();
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
      fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
      const head = store.journal().length;

      fireEvent.input(screen.getByLabelText("Journal sequence"), {
        target: { value: String(head - 2) },
      });

      expect(screen.getByRole("heading", { name: "Todos" })).toBeVisible();
      expect(document.querySelector(".app")).not.toHaveClass("dark");
      expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Live" }));
      expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
      expect(document.querySelector(".app")).toHaveClass("dark");
    });

    it("explains and confirms destructive branch continuation without undoing completed work", async () => {
      const store = setup();
      await loaded();
      expect(store.cachedPayloadCount()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "About" }));
      fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
      fireEvent.input(screen.getByLabelText("Journal sequence"), { target: { value: "0" } });
      expect(screen.getByRole("note")).toHaveTextContent(
        "Continuing creates a new runtime branch. Already completed external work is not undone.",
      );
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

      fireEvent.click(screen.getByRole("button", { name: "Continue from here" }));

      expect(confirm).toHaveBeenCalledWith(
        "Delete 3 future events and continue from here? This cannot be undone.",
      );
      await waitFor(() => {
        expect(store.journal()).toHaveLength(0);
        expect(store.invocations()).toHaveLength(0);
        expect(store.cachedPayloadCount()).toBe(1);
        expect(store.isLive()).toBe(true);
        expect(screen.getByRole("heading", { name: "Todos" })).toBeVisible();
      });
    });

    it("runs the attributed agent sequence and exposes it in the timeline", async () => {
      const store = setup();
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "Simulate agent" }));

      await waitFor(() => {
        expect(
          store
            .journal()
            .filter((fact) => fact.actor.kind === "agent")
            .map((fact) => fact.name),
        ).toEqual(["Navigated", "TodosFiltered", "TodoToggled", "ThemeChanged"]);
      });
      expect(screen.getAllByText(/Agent bot/)).toHaveLength(4);
    });

    it("does not replay on scrub or target remount and replays only the consented invocation", async () => {
      const store = setup();
      await loaded();
      const scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      fireEvent.click(screen.getByRole("tab", { name: "Screen context" }));
      fireEvent.click(screen.getByRole("button", { name: "Test scroll to todo" }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const invocation = store
        .invocations()
        .find((item) => item.definition === "todos.scrollToAnchor")!;

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Todos" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
      fireEvent.input(screen.getByLabelText("Journal sequence"), { target: { value: "0" } });
      fireEvent.click(screen.getByRole("button", { name: "Live" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("tab", { name: "Effects" }));
      expect(screen.getByText("todos.scrollToAnchor")).toBeVisible();
      expect(screen.getByText(invocation.id)).toBeVisible();
      const replay = screen.getByRole("button", { name: "Replay this invocation" });
      expect(replay).toBeDisabled();
      fireEvent.click(screen.getByLabelText("Enable manual presentation replay"));
      expect(replay).toBeEnabled();
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
        expect(screen.getByLabelText(`Executions for ${invocation.id}`)).toHaveTextContent(
          /manual-replay · succeeded/,
        ),
      );
      expect(
        store
          .executions()
          .filter((execution) => execution.invocationId === invocation.id)
          .map((execution) => execution.mode),
      ).toEqual(["live", "manual-replay"]);
    });

    it("renders fetch failures and keeps the failed outcome attributed", async () => {
      const store = setup({ fetchTodos: async () => Promise.reject(new Error("offline")) });

      expect(await screen.findByRole("alert")).toHaveTextContent("offline");
      expect(store.journal().at(-1)).toMatchObject({
        name: "RefreshFailed",
        actor: { kind: "human", id: "adam" },
      });
    });
  });
});
