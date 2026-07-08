import {
  computed as alienComputed,
  effect as alienEffect,
  endBatch,
  setActiveSub,
  signal as alienSignal,
  startBatch,
} from "alien-signals";

export type Signal<T> = {
  (): T;
  (value: T): void;
};

export type Accessor<T> = () => T;

export type Dispose = () => void;

export function signal<T>(initial: T): Signal<T> {
  return alienSignal(initial);
}

export function computed<T>(selector: () => T): Accessor<T> {
  return alienComputed(selector);
}

export function effect(fn: () => void): Dispose {
  return alienEffect(fn);
}

export function batch(fn: () => void): void {
  startBatch();

  try {
    fn();
  } finally {
    endBatch();
  }
}

export function untracked<T>(fn: () => T): T {
  const previous = setActiveSub(undefined);

  try {
    return fn();
  } finally {
    setActiveSub(previous);
  }
}
