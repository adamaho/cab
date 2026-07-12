import { describe, expect, it, vi } from "vitest";
import {
  completeTodosRefresh,
  failTodosRefresh,
  refreshTodos,
} from "../src/features/ingest/feature.ts";
import { navigate } from "../src/features/router/feature.ts";
import { setPageSize, setTheme } from "../src/features/settings/feature.ts";
import {
  filterTodos,
  scrollToTodo,
  setTodoPage,
  toggleTodo,
} from "../src/features/todos/feature.ts";
import { hashTodos } from "../src/runtime/services.ts";
import { createStore } from "../src/store/store.ts";
import type { Todo } from "../src/store/types.ts";

const actor = { kind: "human", id: "test" } as const;
const todos: readonly Todo[] = [{ id: 1, title: "payload", completed: false }];
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("event store invariants", () => {
  it("refolds every journal prefix deterministically", () => {
    const store = createStore(() => "2026-01-01T00:00:00Z");
    store.dispatch(navigate.make({ route: "settings" }), actor);
    store.dispatch(setTheme.make({ theme: "dark" }), actor);
    store.dispatch(setPageSize.make({ size: 20 }), actor);
    const head = structuredClone(store.state());
    for (let sequence = 0; sequence <= store.journal().length; sequence += 1) {
      store.scrub(sequence);
      const first = structuredClone(store.state());
      store.live();
      store.scrub(sequence);
      expect(store.state()).toEqual(first);
    }
    store.live();
    expect(store.state()).toEqual(head);
  });

  it("returns a no-op without appending events when intent is already satisfied", () => {
    const store = createStore();
    const before = store.journal();
    const result = store.dispatch(filterTodos.make({ filter: "all" }));
    expect(result.result).toMatchObject({
      _tag: "Noop",
      reason: "That filter is already active",
    });
    expect(store.journal()).toBe(before);
  });

  it("returns a structured rejection for an unknown dynamic command", async () => {
    const store = createStore();
    await expect(store.dispatchUnknown("missing.command", {}, actor)).resolves.toMatchObject({
      _tag: "Rejected",
      rejection: {
        code: "runtime.command.unknown",
        message: 'Unknown command "missing.command"',
      },
    });
  });

  it("rejects schema-invalid arguments and IDs outside the cached visible domain", async () => {
    const store = createStore();
    await expect(
      store.dispatchUnknown(setPageSize.name, { size: "huge" }, actor),
    ).resolves.toMatchObject({
      _tag: "Rejected",
      rejection: { code: "runtime.command.invalid-args" },
    });
    expect(store.dispatch(toggleTodo.make({ id: 99, completed: true })).rejected).toMatch(
      /current dataset/,
    );
    expect(store.journal()).toHaveLength(0);
  });

  it("structured-clones every attributed fact", () => {
    const store = createStore(() => "now");
    store.dispatch(navigate.make({ route: "about" }), actor);
    store.dispatch(setTheme.make({ theme: "dark" }), actor);
    for (const fact of store.journal()) expect(structuredClone(fact)).toEqual(fact);
  });

  it("scrubs every prefix and blocks UI dispatch", () => {
    const store = createStore();
    store.dispatch(navigate.make({ route: "settings" }));
    store.dispatch(setTheme.make({ theme: "dark" }));
    for (let sequence = 0; sequence <= store.journal().length; sequence += 1) {
      store.scrub(sequence);
      const first = structuredClone(store.state());
      store.live();
      store.scrub(sequence);
      expect(store.state()).toEqual(first);
    }
    store.scrub(1);
    expect(store.dispatch(setPageSize.make({ size: 20 })).rejected).toMatch(/history/);
    store.live();
    expect(store.state()).toMatchObject({ route: "settings", theme: "dark" });
  });

  it("truncates the future and continues sequence numbering from the selected point", async () => {
    const store = createStore(() => "now");
    store.dispatch(navigate.make({ route: "settings" }));
    store.dispatch(setTheme.make({ theme: "dark" }));
    store.dispatch(setPageSize.make({ size: 20 }));
    store.scrub(1);

    await store.continueFrom();

    expect(store.isLive()).toBe(true);
    expect(store.journal().map((fact) => fact.name)).toEqual(["Navigated"]);
    expect(store.state()).toMatchObject({ route: "settings", theme: "light", pageSize: 10 });
    store.dispatch(navigate.make({ route: "about" }));
    expect(store.journal().at(-1)?.sequence).toBe(2);
  });

  it("fences an async outcome deleted by branch continuation", async () => {
    let resolve!: (value: readonly Todo[]) => void;
    const store = createStore();
    store.configure({ fetchTodos: () => new Promise((done) => (resolve = done)) });
    store.dispatch(navigate.make({ route: "settings" }));
    const retained = store.journal()[0]!;
    store.dispatch(refreshTodos.make({}), actor);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    store.scrub(1);
    await store.continueFrom();

    resolve(todos);
    await tick();

    expect(store.journal().map((fact) => fact.name)).toEqual(["Navigated"]);
    expect(store.cachedPayloadCount()).toBe(0);
    expect(store.state().loading).toBe(false);
    store.dispatch(navigate.make({ route: "about" }));
    const continued = store.journal().at(-1)!;
    expect(continued.sequence).toBe(2);
    expect(continued.branchId).not.toBe(retained.branchId);
    expect(continued.branchEpoch).toBe(retained.branchEpoch + 1);
  });

  it("pages todos and validates semantic scroll anchors", async () => {
    const manyTodos = Array.from(
      { length: 25 },
      (_, index): Todo => ({
        id: index + 1,
        title: `Todo ${index + 1}`,
        completed: false,
      }),
    );
    const store = createStore();
    store.configure({ fetchTodos: async () => manyTodos });
    store.dispatch(refreshTodos.make({}), actor);
    await vi.waitFor(() => expect(store.state().requestHash).toBeDefined());

    expect(store.dispatch(scrollToTodo.make({ id: 21 }), actor).rejected).toBe(
      "Todo 21 is on page 3; navigate there first",
    );
    expect(store.dispatch(setTodoPage.make({ page: 3 }), actor).rejected).toBeUndefined();
    expect(store.dispatch(scrollToTodo.make({ id: 21 }), actor).rejected).toBeUndefined();
    expect(store.state().page).toBe(3);
    expect(store.journal().at(-1)).toMatchObject({
      name: "TodoScrollRequested",
      args: { id: 21 },
    });
    expect(store.dispatch(setTodoPage.make({ page: 4 }), actor).rejected).toMatch(/last page is 3/);
  });

  it("fetches successfully once, caches by deterministic hash, and propagates actor", async () => {
    const store = createStore();
    const fetcher = vi.fn(async () => todos);
    store.configure({ fetchTodos: fetcher });
    store.dispatch(refreshTodos.make({}), actor);
    await vi.waitFor(() => expect(store.state().requestHash).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(1);
    store.dispatch(navigate.make({ route: "about" }));
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hashTodos(todos)).toBe(hashTodos(structuredClone(todos)));
    expect(store.todoPayload(hashTodos(todos))).toEqual(todos);
    expect(store.journal().map((fact) => fact.name)).toEqual([
      "RefreshRequested",
      "RefreshCompleted",
      "Navigated",
    ]);
    expect(store.journal()[1]?.actor).toEqual(actor);
    expect(JSON.stringify(store.journal())).not.toContain("payload");
  });

  it("journals readable fetch failure with the requesting actor", async () => {
    const store = createStore();
    store.configure({ fetchTodos: async () => Promise.reject(new Error("network down")) });
    store.dispatch(refreshTodos.make({}), actor);
    await vi.waitFor(() => expect(store.state().loading).toBe(false));
    expect(store.journal()[1]).toMatchObject({
      name: "RefreshFailed",
      args: { message: "network down" },
      actor,
    });
    expect(store.state().error).toBe("network down");
  });

  it("appends async completion to the live head while preserving a scrubbed view", async () => {
    let resolve!: (value: readonly Todo[]) => void;
    const store = createStore();
    store.configure({ fetchTodos: () => new Promise((done) => (resolve = done)) });
    store.dispatch(refreshTodos.make({}), actor);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    store.scrub(0);
    resolve(todos);
    await vi.waitFor(() => expect(store.journal().at(-1)?.name).toBe("RefreshCompleted"));
    expect(store.viewingSequence()).toBe(0);
    expect(store.state()).toMatchObject({ route: "todos", loading: false });
    expect(store.dispatch(navigate.make({ route: "about" })).rejected).toMatch(/history/);
    store.live();
    expect(store.state().requestHash).toBe(hashTodos(todos));
  });

  it("requires the exact render acknowledgement and explicit consent to replay one invocation", async () => {
    const store = createStore();
    const scroll = vi.fn();
    store.configure({ fetchTodos: async () => todos, scrollToAnchor: scroll });
    const staleToken = store.renderToken();
    store.dispatch(refreshTodos.make({}), actor);
    await vi.waitFor(() => expect(store.journal().at(-1)?.name).toBe("RefreshCompleted"));

    store.dispatch(scrollToTodo.make({ id: 1 }), actor);
    const invocation = store
      .invocations()
      .find((item) => item.definition === "todos.scrollToAnchor")!;
    expect(invocation).toMatchObject({
      args: { id: 1 },
      phase: "after-render",
      replay: "manual",
      status: "pending",
    });
    expect(scroll).not.toHaveBeenCalled();

    store.acknowledgeRender(staleToken);
    await tick();
    expect(scroll).not.toHaveBeenCalled();
    expect(invocation.renderToken).toEqual(store.renderToken());
    store.acknowledgeRender(store.renderToken());
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(scroll).toHaveBeenLastCalledWith("#todo-1", "smooth");

    store.dispatch(navigate.make({ route: "about" }));
    store.scrub(invocation.triggerSequence);
    await tick();
    expect(scroll).toHaveBeenCalledTimes(1);
    await expect(store.replayEffect(invocation.id, true)).rejects.toMatchObject({
      code: "render-not-acknowledged",
    });

    store.acknowledgeRender(store.renderToken());
    await tick();
    await expect(store.replayEffect(invocation.id, false)).rejects.toMatchObject({
      code: "consent-required",
    });
    await expect(store.replayEffect(invocation.id, true)).resolves.toMatchObject({
      invocationId: invocation.id,
    });
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
    expect(scroll).toHaveBeenLastCalledWith("#todo-1", "auto");

    await vi.waitFor(() => {
      expect(
        store
          .executions()
          .filter((execution) => execution.invocationId === invocation.id)
          .map(({ mode, status }) => ({ mode, status })),
      ).toEqual([
        { mode: "live", status: "succeeded" },
        { mode: "manual-replay", status: "succeeded" },
      ]);
    });
    expect(
      store
        .executions()
        .filter((execution) => execution.invocationId === invocation.id)
        .every(
          (execution) =>
            execution.commandId === invocation.commandId &&
            execution.commitId === invocation.commitId &&
            execution.correlationId === invocation.correlationId,
        ),
    ).toBe(true);
  });

  it("describes only public commands, schemas, and their possible effects", async () => {
    const store = createStore();
    const descriptions = store.describe();
    const names = descriptions.map((item) => item.name);
    expect(names).toContain(refreshTodos.name);
    expect(names).not.toContain(completeTodosRefresh.name);
    expect(names).not.toContain(failTodosRefresh.name);
    expect(descriptions.every((item) => Object.keys(item.argsSchema).length > 0)).toBe(true);
    expect(descriptions.find((item) => item.name === refreshTodos.name)?.possibleEffects).toEqual([
      { name: "todos.fetch", phase: "after-commit", replay: "never" },
    ]);
    expect(descriptions.find((item) => item.name === scrollToTodo.name)?.possibleEffects).toEqual([
      { name: "todos.scrollToAnchor", phase: "after-render", replay: "manual" },
    ]);
    expect(descriptions.find((item) => item.name === navigate.name)?.possibleEffects).toEqual([]);

    await expect(
      store.dispatchUnknown(
        completeTodosRefresh.name,
        { requestId: "request", requestHash: "hash", count: 1 },
        actor,
      ),
    ).resolves.toMatchObject({
      _tag: "Rejected",
      rejection: {
        code: "runtime.command.forbidden",
        message: `Command "${completeTodosRefresh.name}" is runtime-only`,
      },
    });
  });
});
