import { Context, Data, Effect, Layer, PubSub, Ref, Stream } from "effect";

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
 * Service shape for reading and mutating the current browser location.
 *
 * @category models
 * @since 0.0.0
 */
export interface HistoryShape {
  readonly push: (href: string) => Effect.Effect<void, HistoryError>;
  readonly current: Effect.Effect<string, HistoryError>;
  readonly changes: Stream.Stream<string>;
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
 * constructed outside a browser-like environment.
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
      };
    }),
  ),
};

/**
 * Memory history handle with inspection effects.
 *
 * @category models
 * @since 0.0.0
 */
export interface MemoryHistory {
  readonly layer: Layer.Layer<History>;
  readonly pushes: Effect.Effect<ReadonlyArray<string>>;
  readonly current: Effect.Effect<string>;
  readonly observe: (href: string) => Effect.Effect<void>;
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
    const changesPubSub = yield* PubSub.unbounded<string>();
    const current = Ref.get(locationRef);
    const observe = Effect.fn("@cab/router/MemoryHistory.observe")(function* (href: string) {
      yield* Ref.set(locationRef, href);
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
      }),
      pushes: Ref.get(pushesRef),
      current,
      observe,
    };
  }),
};
