import { Effect, PubSub, Ref, Semaphore, Stream, SubscriptionRef } from "effect";

import type { Sequenced } from "./event";
import { defineSlice, type SliceDefinition } from "./slice";
import { batch, computed, effect, signal, untracked, type Signal } from "./reactive";

const MAX_CASCADE_COMMANDS = 1000;

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

  /** Streams the seeded snapshot and each later folded snapshot. */
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
   * Dispatches a command through decide, append, fold, and batched signal writes.
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
 * Builds a store instance from a slice definition.
 *
 * @category constructors
 * @since 0.0.0
 */
export function make<TState extends Record<string, unknown>, TCommand, TEvent>(
  definition: SliceDefinition<TState, TCommand, TEvent>,
): Effect.Effect<Store<TState, TCommand, TEvent>> {
  return Effect.gen(function* () {
    const journalRef = yield* Ref.make<ReadonlyArray<Sequenced<TEvent>>>([]);
    const journalPubSub = yield* PubSub.unbounded<Sequenced<TEvent>>();
    const stateRef = yield* SubscriptionRef.make(definition.initial);
    const semaphore = yield* Semaphore.make(1);
    const signals = makeSignals(definition.initial);
    const pending: Array<TCommand> = [];

    const append = Effect.fn(`@cab/store/${definition.name}.append`)(function* (event: TEvent) {
      const sequence = yield* Ref.get(journalRef).pipe(Effect.map((journal) => journal.length));
      const fact: Sequenced<TEvent> = { sequence, event };

      yield* Ref.update(journalRef, (journal) => [...journal, fact]);
      yield* PubSub.publish(journalPubSub, fact);
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
                  `Cannot drain dispatch cascade for store "${definition.name}": exceeded 1000 commands without converging. A subscriber is likely dispatching a state-changing command on every notification.`,
                ),
              );
            }

            const state = yield* SubscriptionRef.get(stateRef);
            const events = definition.decide(state, nextCommand);

            if (events.length > 0) {
              for (const event of events) {
                yield* append(event);
              }

              const next = events.reduce(definition.reduce, state);

              yield* SubscriptionRef.set(stateRef, next);

              yield* Effect.sync(() => {
                notifying = true;
                batch(() => writeSignals(signals, next));
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

    const reader: StoreReader<TState, TEvent> = {
      state: SubscriptionRef.get(stateRef),
      stateChanges: SubscriptionRef.changes(stateRef),
      read,
      select,
      subscribe,
      journal: Ref.get(journalRef),
      journalChanges: Stream.fromPubSub(journalPubSub),
    };

    return {
      ...reader,
      dispatch,
      reader,
    };
  });
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
} as const;
