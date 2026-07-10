import type { StoreReader } from "@cab/store";
import { createSignal, onCleanup, type Accessor } from "solid-js";

interface KeyAccessorOptions<TSelected> {
  readonly equals?: (prev: TSelected, next: TSelected) => boolean;
}

export function createKeyAccessor<
  TState extends Record<string, unknown>,
  TEvent,
  K extends keyof TState,
  TSelected,
>(
  getReader: () => StoreReader<TState, TEvent> | undefined,
  onReader: (listener: (reader: StoreReader<TState, TEvent>) => void) => () => void,
  key: K,
  seed: TState[K],
  select: (value: TState[K]) => TSelected,
  options?: KeyAccessorOptions<TSelected>,
): Accessor<TSelected> {
  const reader = getReader();
  const initial = select(reader === undefined ? seed : reader.read(key));
  const [value, setValue] =
    options?.equals === undefined
      ? createSignal(initial)
      : createSignal(initial, { equals: options.equals });
  let unsubscribeKey: (() => void) | undefined;

  function subscribe(nextReader: StoreReader<TState, TEvent>): void {
    unsubscribeKey?.();
    unsubscribeKey = nextReader.subscribe(key, (next) => {
      setValue(() => select(next));
    });
    setValue(() => select(nextReader.read(key)));
  }

  if (reader === undefined) {
    const unsubscribeReader = onReader(subscribe);
    onCleanup(unsubscribeReader);
  } else {
    subscribe(reader);
  }

  onCleanup(() => {
    unsubscribeKey?.();
  });

  return value;
}
