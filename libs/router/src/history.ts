import { Context, Data, Effect, Layer, PubSub, Queue, Ref, Scope, Stream } from "effect";

/**
 * Machine-readable reasons for history service failures.
 *
 * @category errors
 * @since 0.0.0
 */
export type HistoryErrorReason = "window-unavailable" | "push-failed";

/**
 * Typed history failures surfaced by router history services.
 *
 * @category errors
 * @since 0.0.0
 */
export class HistoryError extends Data.TaggedError("HistoryError")<{
  readonly reason: HistoryErrorReason;
  readonly cause?: unknown;
}> {}

/**
 * Initial history state and scoped wakeups for later external changes.
 *
 * **Details**
 *
 * `initialHref` is sampled after the change listener is installed. `changes`
 * contains lossless wakeups rather than captured hrefs, so consumers reread
 * `History.current` to observe the canonical location.
 *
 * @category models
 * @since 0.0.0
 */
export interface HistoryObservation {
  readonly initialHref: string;
  readonly changes: Stream.Stream<void>;
}

/**
 * Service shape for reading and mutating the current browser location.
 *
 * @category models
 * @since 0.0.0
 */
export interface HistoryShape {
  readonly push: (href: string) => Effect.Effect<void, HistoryError>;
  readonly current: Effect.Effect<string, HistoryError>;
  readonly changes: Stream.Stream<string>;

  /**
   * Acquires a scoped, listener-first observation of external history changes.
   *
   * **Details**
   *
   * `initialHref` is sampled after listener installation. Later changes are
   * lossless `void` wakeups, not captured hrefs; consumers must reread
   * `current`. Closing the caller's scope removes the listener.
   *
   * @category observations
   * @since 0.0.0
   */
  readonly observe: Effect.Effect<HistoryObservation, HistoryError, Scope.Scope>;
}

/**
 * Effect service for the router history boundary.
 *
 * @category services
 * @since 0.0.0
 */
export class History extends Context.Service<History, HistoryShape>()("@cab/router/History") {}

/**
 * Browser-backed history adapter using `window.history.pushState`.
 *
 * **Details**
 *
 * The layer fails with `HistoryError{ reason: "window-unavailable" }` when it is
 * constructed outside a browser-like environment. Scoped observations install
 * their `popstate` listener before sampling the initial href and remove it when
 * the caller's scope closes.
 *
 * @category adapters
 * @since 0.0.0
 */
export const WindowHistory: {
  readonly layer: Layer.Layer<History, HistoryError>;
} = {
  layer: Layer.effect(
    History,
    Effect.gen(function* () {
      if (typeof window === "undefined") {
        return yield* Effect.fail(new HistoryError({ reason: "window-unavailable" }));
      }

      const browserWindow = window;

      function currentHref() {
        return `${browserWindow.location.pathname}${browserWindow.location.search}${browserWindow.location.hash}`;
      }

      return {
        push: Effect.fn("@cab/router/WindowHistory.push")(function* (href: string) {
          return yield* Effect.try({
            try: () => browserWindow.history.pushState(null, "", href),
            catch: (cause) => new HistoryError({ reason: "push-failed", cause }),
          });
        }),
        current: Effect.sync(currentHref),
        changes: Stream.fromEventListener<PopStateEvent>(browserWindow, "popstate").pipe(
          Stream.map(() => currentHref()),
        ),
        observe: Effect.fn("@cab/router/WindowHistory.observe")(function* () {
          const wakeups = yield* Queue.unbounded<void>();
          function listener() {
            Queue.offerUnsafe(wakeups, undefined);
          }

          yield* Effect.acquireRelease(
            Effect.sync(() => browserWindow.addEventListener("popstate", listener)),
            () => Effect.sync(() => browserWindow.removeEventListener("popstate", listener)),
          );

          return {
            initialHref: currentHref(),
            changes: Stream.fromQueue(wakeups),
          };
        })(),
      };
    }),
  ),
};

/**
 * Memory history handle with inspection effects.
 *
 * **Details**
 *
 * `simulate` produces browser-originated navigation in tests. Scoped
 * observations install their listener before sampling the initial href and use
 * lossless wakeups without relying on replay timing. Late subscribers to the
 * compatibility `changes` stream receive the most recent href, which makes
 * memory-backed tests deterministic and intentionally differs from browser
 * `popstate`.
 *
 * @category models
 * @since 0.0.0
 */
export interface MemoryHistory {
  readonly layer: Layer.Layer<History>;
  readonly pushes: Effect.Effect<ReadonlyArray<string>>;
  readonly current: Effect.Effect<string>;

  /**
   * Simulates browser-originated navigation without recording a history push.
   *
   * @category testing
   * @since 0.0.0
   */
  readonly simulate: (href: string) => Effect.Effect<void>;
}

/**
 * Creates memory-backed `History` layers for tests and local adapters.
 *
 * @category constructors
 * @since 0.0.0
 */
export const MemoryHistory: {
  readonly make: (initialHref: string) => Effect.Effect<MemoryHistory>;
} = {
  make: Effect.fn("@cab/router/MemoryHistory.make")(function* (initialHref: string) {
    const locationRef = yield* Ref.make(initialHref);
    const pushesRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const changesPubSub = yield* PubSub.unbounded<string>({ replay: 1 });
    const observationListeners = new Set<() => void>();
    const current = Ref.get(locationRef);
    const simulate = Effect.fn("@cab/router/MemoryHistory.simulate")(function* (href: string) {
      yield* Ref.set(locationRef, href);
      yield* Effect.sync(() => {
        for (const listener of observationListeners) {
          listener();
        }
      });
      yield* PubSub.publish(changesPubSub, href);
    });

    return {
      layer: Layer.succeed(History, {
        push: Effect.fn("@cab/router/MemoryHistory.push")(function* (href: string) {
          yield* Ref.set(locationRef, href);
          yield* Ref.update(pushesRef, (pushes) => [...pushes, href]);
        }),
        current,
        changes: Stream.fromPubSub(changesPubSub),
        observe: Effect.fn("@cab/router/MemoryHistory.observe")(function* () {
          const wakeups = yield* Queue.unbounded<void>();
          function listener() {
            Queue.offerUnsafe(wakeups, undefined);
          }

          yield* Effect.acquireRelease(
            Effect.sync(() => observationListeners.add(listener)),
            () => Effect.sync(() => observationListeners.delete(listener)),
          );

          return {
            initialHref: yield* current,
            changes: Stream.fromQueue(wakeups),
          };
        })(),
      }),
      pushes: Ref.get(pushesRef),
      current,
      simulate,
    };
  }),
};
