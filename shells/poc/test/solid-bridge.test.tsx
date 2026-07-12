import { describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import { createRoot } from "solid-js";
import { createSolidCabHandle, createSolidEffectsHandle } from "../src/runtime/solid.tsx";
import { navigate } from "../src/features/router/feature.ts";
import type { Store } from "../src/store/store.ts";
import { initialState, type AppState } from "../src/store/types.ts";

function makeStore() {
  let state: AppState = initialState;
  let sequence = 0;
  let revision = 0;
  let executions: readonly never[] = [];
  const listeners = new Set<() => void>();
  const dispatch = vi.fn();
  const dispatchEffect = vi.fn(() => Effect.succeed({ _tag: "Noop" as const } as never));
  const replayEffect = vi.fn(async () => ({ executionId: "replay-1" }));
  const definitions = [
    {
      name: "test.effect",
      version: 1,
      description: "Test effect",
      phase: "after-commit" as const,
      replay: "manual" as const,
      authority: "client" as const,
      concurrency: "Every" as const,
    },
  ];

  const store = {
    state: () => state,
    journal: () => [],
    viewingSequence: () => sequence,
    revision: () => revision,
    executions: () => executions,
    dispatch,
    dispatchEffect,
    acknowledgeRender: vi.fn(),
    replayEffect,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    describeRuntime: () => ({
      features: ["test"],
      commands: [],
      events: [],
      effects: definitions,
    }),
  } as unknown as Store;

  return {
    store,
    dispatch,
    dispatchEffect,
    replayEffect,
    listenerCount: () => listeners.size,
    update(next: Partial<Pick<AppState, "route" | "theme">>) {
      state = { ...state, ...next };
      sequence += 1;
      revision += 1;
      listeners.forEach((listener) => listener());
    },
    setExecutions(next: readonly never[]) {
      executions = next;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("Solid Cab bridge", () => {
  it("queues startup dispatches and flushes them exactly once after subscription", () => {
    const fixture = makeStore();
    createRoot((dispose) => {
      const bridge = createSolidCabHandle(fixture.store);
      bridge.dispatch(navigate.make({ route: "settings" }));

      expect(fixture.dispatch).not.toHaveBeenCalled();
      bridge.start();
      bridge.start();

      expect(fixture.listenerCount()).toBe(1);
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
      expect(fixture.dispatch).toHaveBeenCalledWith(
        navigate.make({ route: "settings" }),
        undefined,
      );
      dispose();
    });
  });

  it("projects store revisions through stable Solid accessors", () => {
    const fixture = makeStore();
    createRoot((dispose) => {
      const bridge = createSolidCabHandle(fixture.store);
      const stateAccessor = bridge.state;
      bridge.start();

      fixture.update({ route: "about", theme: "dark" });

      expect(bridge.state).toBe(stateAccessor);
      expect(bridge.state()).toMatchObject({ route: "about", theme: "dark" });
      expect(bridge.sequence()).toBe(1);
      expect(bridge.revision()).toBe(1);
      dispose();
    });
  });

  it("forwards awaitable dispatch Effects without running them in the bridge", () => {
    const fixture = makeStore();
    createRoot((dispose) => {
      const bridge = createSolidCabHandle(fixture.store);
      const invocation = navigate.make({ route: "about" });
      const effect = bridge.dispatchEffect(invocation);

      expect(fixture.dispatchEffect).toHaveBeenCalledWith(invocation);
      expect(Effect.isEffect(effect)).toBe(true);
      dispose();
    });
  });

  it("unsubscribes and drops queued or later convenience dispatches on dispose", () => {
    const fixture = makeStore();
    createRoot((dispose) => {
      const bridge = createSolidCabHandle(fixture.store);
      bridge.dispatch(navigate.make({ route: "settings" }));
      bridge.dispose();
      bridge.start();
      bridge.dispatch(navigate.make({ route: "about" }));

      expect(fixture.listenerCount()).toBe(0);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      dispose();
    });
  });
});

describe("Solid effects bridge", () => {
  it("exposes definitions and execution accessors without exposing direct effect dispatch", () => {
    const fixture = makeStore();
    createRoot((dispose) => {
      const bridge = createSolidCabHandle(fixture.store);
      const effects = createSolidEffectsHandle(fixture.store, bridge);
      bridge.start();

      expect(effects.definitions()).toEqual([
        expect.objectContaining({ name: "test.effect", replay: "manual" }),
      ]);
      expect(effects.executions).toBe(bridge.executions);
      expect("dispatch" in effects).toBe(false);
      dispose();
    });
  });

  it.effect("forwards explicit invocation replay consent to the store", () =>
    Effect.gen(function* () {
      const fixture = makeStore();
      let result: unknown;
      createRoot((dispose) => {
        const bridge = createSolidCabHandle(fixture.store);
        const effects = createSolidEffectsHandle(fixture.store, bridge);
        result = effects.replay("invocation-1", true);
        dispose();
      });

      expect(yield* Effect.promise(() => result as Promise<unknown>)).toEqual({
        executionId: "replay-1",
      });
      expect(fixture.replayEffect).toHaveBeenCalledWith("invocation-1", true);
    }),
  );
});
