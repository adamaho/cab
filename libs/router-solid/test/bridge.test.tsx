import { Store } from "@cab/store";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";
import { createEffect } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouterBridge } from "../src/bridge";

type State = {
  readonly count: number;
  readonly label: string;
};

type Command =
  | { readonly _tag: "SetCount"; readonly count: number }
  | { readonly _tag: "SetLabel"; readonly label: string };

const slice = Store.defineSlice<State, Command, Command>({
  name: "RouterSolidBridgeTest",
  initial: { count: 0, label: "zero" },
  decide: (_state, command) => [command],
  reduce: (state, event) =>
    event._tag === "SetCount" ? { ...state, count: event.count } : { ...state, label: event.label },
});

describe("RouterBridge", () => {
  afterEach(() => cleanup());

  it("adapts a generic two-key store without rerunning unrelated selectors", async () => {
    const store = Store.makeSync(slice);
    const selectCount = vi.fn((state: State) => state.count);

    function Probe() {
      const count = RouterBridge.make(store.reader).select(selectCount);
      return <span data-testid="count">{count()}</span>;
    }

    const screen = render(() => <Probe />);

    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(selectCount).toHaveBeenCalledTimes(2);

    await Effect.runPromise(store.dispatch({ _tag: "SetLabel", label: "one" }));

    expect(selectCount).toHaveBeenCalledTimes(2);

    await Effect.runPromise(store.dispatch({ _tag: "SetCount", count: 1 }));

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1");
    });
    expect(selectCount).toHaveBeenCalledTimes(3);
  });

  it("delegates custom equality to the store", async () => {
    const store = Store.makeSync(slice);
    const observed = vi.fn();

    function Probe() {
      const selected = RouterBridge.make(store.reader).select(
        (state) => ({ parity: state.count % 2 }),
        { equals: (previous, next) => previous.parity === next.parity },
      );
      createEffect(() => observed(selected()));
      return <span data-testid="parity">{selected().parity}</span>;
    }

    render(() => <Probe />);
    expect(observed).toHaveBeenCalledTimes(1);

    await Effect.runPromise(store.dispatch({ _tag: "SetCount", count: 2 }));
    expect(observed).toHaveBeenCalledTimes(1);

    await Effect.runPromise(store.dispatch({ _tag: "SetCount", count: 3 }));
    await waitFor(() => expect(observed).toHaveBeenCalledTimes(2));
  });

  it("stores function-valued selections as values", async () => {
    const store = Store.makeSync(slice);

    function Probe() {
      const selected = RouterBridge.make(store.reader).select((state) => {
        const label = state.label;
        const count = state.count;
        return () => `${label}:${count}`;
      });
      return <span data-testid="value">{selected()()}</span>;
    }

    const screen = render(() => <Probe />);
    expect(screen.getByTestId("value").textContent).toBe("zero:0");

    await Effect.runPromise(store.dispatch({ _tag: "SetLabel", label: "one" }));
    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("one:0");
    });
  });
});
