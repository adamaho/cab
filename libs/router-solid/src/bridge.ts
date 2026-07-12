import type { StoreReader } from "@cab/store";
import { createSignal, onCleanup, type Accessor } from "solid-js";

export const RouterBridge = {
  make<TState extends Record<string, unknown>, TEvent>(reader: StoreReader<TState, TEvent>) {
    return {
      select<TSelected>(
        selector: (state: TState) => TSelected,
        options?: { readonly equals?: (previous: TSelected, next: TSelected) => boolean },
      ): Accessor<TSelected> {
        const [value, setValue] = createSignal(selector(reader.getSnapshot()), { equals: false });
        const unsubscribe = reader.subscribeSelector(
          selector,
          (next) => setValue(() => next),
          options,
        );

        onCleanup(unsubscribe);

        return value;
      },
    };
  },
} as const;
