import { Effect, PubSub, Ref, Semaphore, Stream, SubscriptionRef } from "effect";

import type { Sequenced } from "./event";
import { defineSlice, type SliceDefinition } from "./slice";
import { batch, computed, effect, signal, untracked, type Signal } from "./reactive";

const MAX_CASCADE_COMMANDS = 1000;

/**
 * Configures change detection for a selector subscription.
 *
 * @category models
 * @since 0.0.0
 */
export interface SelectorSubscriptionOptions<TSelected> {
  /** Returns whether two consecutive selected values are equivalent. */
  readonly equals?: (previous: TSelected, next: TSelected) => boolean;
}

/**
 * Read, subscription, and journal surface of a store.
 *
 * **Details**
 *
 * A reader intentionally excludes `dispatch`, so process-manager domains can
 * hand out the full read surface while preserving their write boundary.
 *
 * @category models
 * @since 0.0.0
 */
export interface StoreReader<TState extends Record<string, unknown>, TEvent> {
  /** Reads the current folded snapshot without registering a signal dependency. */
  readonly state: Effect.Effect<TState>;

  /** Streams the seeded snapshot and each later reference-changed folded snapshot. */
  readonly stateChanges: Stream.Stream<TState>;

  /** Reads one top-level key and tracks it inside reactive computations. */
  readonly read: <K extends keyof TState>(key: K) => TState[K];

  /** Builds a memoized reactive selector over synchronous `read` calls. */
  readonly select: <T>(selector: () => T) => () => T;

  /**
   * Subscribes to change-only notifications for one top-level key.
   *
   * **Gotchas**
   *
   * Listeners are invoked synchronously during dispatch. Dispatching from a
   * listener is supported: the command is enqueued and applied in FIFO order
   * before the boundary dispatch returns. From the listener's perspective, that
   * dispatch is fire-and-forget, so reads immediately after it still see the
   * pre-command state. Cascades should converge naturally when `decide` returns
   * an empty event array; a cascade exceeding 1000 commands fails with a
   * descriptive defect.
   */
  readonly subscribe: <K extends keyof TState>(
    key: K,
    listener: (value: TState[K]) => void,
  ) => () => void;

  /** Reads the retained in-memory journal snapshot. */
  readonly journal: Effect.Effect<ReadonlyArray<Sequenced<TEvent>>>;

  /** Streams newly appended journal facts. */
  readonly journalChanges: Stream.Stream<Sequenced<TEvent>>;

  /** Returns the exact current folded snapshot synchronously and untracked. */
  readonly getSnapshot: () => TState;

  /**
   * Subscribes to change-only selected output.
   *
   * **Details**
   *
   * The selector runs once to establish its baseline without notifying the
   * listener. Top-level state dependencies are rediscovered on every later
   * evaluation, and equality defaults to `Object.is`.
   */
  readonly subscribeSelector: <TSelected>(
    selector: (state: TState) => TSelected,
    listener: (selected: TSelected) => void,
    options?: SelectorSubscriptionOptions<TSelected>,
  ) => () => void;

  /** Subscribes synchronously to newly committed journal facts. */
  readonly subscribeJournal: (listener: (fact: Sequenced<TEvent>) => void) => () => void;
}

/**
 * Event-sourced reactive store for one slice.
 *
 * @category models
 * @since 0.0.0
 */
export interface Store<
  TState extends Record<string, unknown>,
  TCommand,
  TEvent,
> extends StoreReader<TState, TEvent> {
  /**
   * Dispatches a command through decide, fold, append, and batched signal writes.
   *
   * **Gotchas**
   *
   * Dispatching from a subscriber listener is supported: the command is enqueued
   * and applied in FIFO order before the boundary dispatch returns. From the
   * listener's perspective, that dispatch is fire-and-forget, so reads
   * immediately after it still see the pre-command state. Cascades should
   * converge naturally when `decide` returns an empty event array; a cascade
   * exceeding 1000 commands fails with a descriptive defect.
   */
  readonly dispatch: (command: TCommand) => Effect.Effect<void>;

  /** This store without `dispatch`, for guarded hand-out by domain services. */
  readonly reader: StoreReader<TState, TEvent>;
}

type SignalMap<TState extends Record<string, unknown>> = {
  [K in keyof TState]: Signal<TState[K]>;
};

function makeSignals<TState extends Record<string, unknown>>(state: TState): SignalMap<TState> {
  const entries = Object.keys(state).map((key) => [key, signal(state[key])] as const);

  return Object.fromEntries(entries) as SignalMap<TState>;
}

function writeSignals<TState extends Record<string, unknown>>(
  signals: SignalMap<TState>,
  state: TState,
): void {
  for (const key of Object.keys(signals) as Array<keyof TState>) {
    signals[key](state[key]);
  }
}

/**
 * Builds a complete store synchronously from a slice definition.
 *
 * **Details**
 *
 * This is the primary in-memory constructor. Store state, subscriptions, and
 * the journal are ready before the function returns.
 *
 * @category constructors
 * @since 0.0.0
 */
export function makeSync<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): Store<TState, TCommand, TEvent> {
  const journalRef = Ref.makeUnsafe<ReadonlyArray<Sequenced<TEvent>>>([]);
  const journalPubSub = Effect.runSync(PubSub.unbounded<Sequenced<TEvent>>());
  const stateRef = Effect.runSync(SubscriptionRef.make(definition.initial));
  const semaphore = Semaphore.makeUnsafe(1);
  const signals = makeSignals(definition.initial);
  const wholeSnapshot = signal(definition.initial);
  const stateKeys = Object.keys(definition.initial) as Array<keyof TState>;
  const stateKeySet = new Set<PropertyKey>(stateKeys);
  const journalListeners = new Set<(fact: Sequenced<TEvent>) => void>();
  const pending: Array<TCommand> = [];

  function getSnapshot(): TState {
    return SubscriptionRef.getUnsafe(stateRef);
  }

  const trackingState = new Proxy(Object.create(Object.getPrototypeOf(definition.initial)), {
    get(_target, property) {
      if (stateKeySet.has(property)) {
        return signals[property as keyof TState]();
      }

      return Reflect.get(getSnapshot(), property);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(getSnapshot(), property);

      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    has(_target, property) {
      if (stateKeySet.has(property)) {
        signals[property as keyof TState]();
      }

      return Reflect.has(getSnapshot(), property);
    },
    ownKeys() {
      for (const key of stateKeys) {
        signals[key]();
      }

      return Reflect.ownKeys(getSnapshot());
    },
  }) as TState;

  const append = Effect.fn(`@cab/store/${definition.name}.append`)(function* (
    facts: ReadonlyArray<Sequenced<TEvent>>,
  ) {
    yield* Ref.update(journalRef, (journal) => [...journal, ...facts]);

    for (const fact of facts) {
      yield* PubSub.publish(journalPubSub, fact);
    }
  });

  let notifying = false;

  const dispatch = Effect.fn(`@cab/store/${definition.name}.dispatch`)(function* (
    command: TCommand,
  ) {
    if (notifying) {
      pending.push(command);
      return;
    }

    yield* semaphore.withPermit(
      Effect.gen(function* () {
        const work: Array<TCommand> = [command];
        let drained = 0;

        while (work.length > 0) {
          const nextCommand = work.shift() as TCommand;
          drained += 1;

          if (drained > MAX_CASCADE_COMMANDS) {
            return yield* Effect.die(
              new Error(
                `Cannot drain dispatch cascade for store "${definition.name}": exceeded ${MAX_CASCADE_COMMANDS} commands without converging. A subscriber is likely dispatching a state-changing command on every notification.`,
              ),
            );
          }

          const state = SubscriptionRef.getUnsafe(stateRef);
          const events = definition.decide(state, nextCommand);

          if (events.length > 0) {
            const next = events.reduce(definition.reduce, state);
            const sequence = Ref.getUnsafe(journalRef).length;
            const facts = events.map(
              (event, offset): Sequenced<TEvent> => ({
                sequence: sequence + offset,
                event,
              }),
            );

            yield* append(facts);

            if (next !== state) {
              yield* SubscriptionRef.set(stateRef, next);
            }

            yield* Effect.sync(() => {
              notifying = true;

              if (next !== state) {
                batch(() => {
                  wholeSnapshot(next);
                  writeSignals(signals, next);
                });
              }

              for (const fact of facts) {
                for (const listener of journalListeners) {
                  listener(fact);
                }
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  notifying = false;
                }),
              ),
            );
          }

          work.push(...pending.splice(0));
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.length = 0;
          }),
        ),
      ),
    );
  });

  function read<K extends keyof TState>(key: K): TState[K] {
    return signals[key]();
  }

  function select<T>(selector: () => T): () => T {
    return computed(selector);
  }

  function subscribe<K extends keyof TState>(
    key: K,
    listener: (value: TState[K]) => void,
  ): () => void {
    let initialized = false;

    // The listener runs untracked so its own reads never widen the
    // subscription beyond the requested key.
    return effect(() => {
      const value = read(key);

      if (initialized) {
        untracked(() => listener(value));
      } else {
        initialized = true;
      }
    });
  }

  function subscribeSelector<TSelected>(
    selector: (state: TState) => TSelected,
    listener: (selected: TSelected) => void,
    options?: SelectorSubscriptionOptions<TSelected>,
  ): () => void {
    const equals = options?.equals ?? Object.is;
    let initialized = false;
    let previous: TSelected;
    const dispose = effect(() => {
      const result = selector(trackingState);
      const selected = Object.is(result, trackingState)
        ? (wholeSnapshot() as unknown as TSelected)
        : result;

      if (initialized) {
        untracked(() => {
          const changed = !equals(previous, selected);

          if (changed) {
            previous = selected;
            listener(selected);
          }
        });
      } else {
        previous = selected;
        initialized = true;
      }
    });
    let subscribed = true;

    return () => {
      if (subscribed) {
        subscribed = false;
        dispose();
      }
    };
  }

  function subscribeJournal(listener: (fact: Sequenced<TEvent>) => void): () => void {
    journalListeners.add(listener);
    let subscribed = true;

    return () => {
      if (subscribed) {
        subscribed = false;
        journalListeners.delete(listener);
      }
    };
  }

  const reader: StoreReader<TState, TEvent> = {
    state: SubscriptionRef.get(stateRef),
    stateChanges: SubscriptionRef.changes(stateRef),
    read,
    select,
    subscribe,
    journal: Ref.get(journalRef),
    journalChanges: Stream.fromPubSub(journalPubSub),
    getSnapshot,
    subscribeSelector,
    subscribeJournal,
  };

  return {
    ...reader,
    dispatch,
    reader,
  };
}

/**
 * Builds a store instance from a slice definition inside `Effect`.
 *
 * @category constructors
 * @since 0.0.0
 */
export function make<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): Effect.Effect<Store<TState, TCommand, TEvent>> {
  return Effect.sync(() => makeSync(definition));
}

/**
 * Public namespace for defining and constructing stores.
 *
 * @category constructors
 * @since 0.0.0
 */
export const Store = {
  defineSlice,
  make,
  makeSync,
} as const;
