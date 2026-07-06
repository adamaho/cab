import { Context, Effect, Layer, Ref, Semaphore, Stream, SubscriptionRef } from "effect";

import { RouterCommand, RouterEvent } from "./event";
import { History, type HistoryError, WindowHistory } from "./history";
import { initial, reduce, type RouterState } from "./state";

/**
 * Service shape for dispatching navigation commands and observing router state.
 *
 * **Details**
 *
 * `dispatch` accepts user commands only. The router assigns journal sequence
 * numbers, writes outcome events, and keeps `state` as the folded projection of
 * committed navigation events.
 *
 * @category models
 * @since 0.0.0
 */
export interface RouterShape {
  readonly dispatch: (command: RouterCommand) => Effect.Effect<void>;
  readonly navigate: (href: string) => Effect.Effect<void>;
  readonly state: Effect.Effect<RouterState>;
  readonly changes: Stream.Stream<RouterState>;
  readonly events: Effect.Effect<ReadonlyArray<RouterEvent>>;
}

/**
 * Effect service for event-sourced application navigation.
 *
 * @category services
 * @since 0.0.0
 */
export class Router extends Context.Service<Router, RouterShape>()("@cab/router/Router") {
  /**
   * Builds a router from a provided `History` service.
   *
   * @category layers
   * @since 0.0.0
   */
  static readonly layer: Layer.Layer<Router, HistoryError, History> = Layer.effect(
    Router,
    Effect.gen(function* () {
      const history = yield* History;
      const currentHref = yield* history.current;
      const journalRef = yield* Ref.make<ReadonlyArray<RouterEvent>>([]);
      const stateRef = yield* SubscriptionRef.make(initial(currentHref));
      const semaphore = yield* Semaphore.make(1);

      function append(event: RouterEvent) {
        return Ref.update(journalRef, (events) => [...events, event]);
      }

      const nextSequence = Ref.get(journalRef).pipe(Effect.map((events) => events.length));

      const commit = Effect.fn("@cab/router/Router.commit")(function* (event: RouterEvent) {
        yield* append(event);

        if (event._tag === "NavigationCommitted") {
          const state = yield* SubscriptionRef.get(stateRef);
          yield* SubscriptionRef.set(stateRef, reduce(state, event));
        }
      });

      const dispatch = Effect.fn("@cab/router/Router.dispatch")(function* (command: RouterCommand) {
        yield* semaphore.withPermit(
          Effect.gen(function* () {
            switch (command._tag) {
              case "NavigationRequested": {
                const state = yield* SubscriptionRef.get(stateRef);

                if (state.href === command.href) {
                  return;
                }

                yield* commit(
                  RouterEvent.NavigationRequested({
                    sequence: yield* nextSequence,
                    href: command.href,
                  }),
                );

                yield* history.push(command.href).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.gen(function* () {
                        yield* commit(
                          RouterEvent.NavigationFailed({
                            sequence: yield* nextSequence,
                            href: command.href,
                            reason: error.reason,
                            ...(error.cause === undefined ? {} : { cause: error.cause }),
                          }),
                        );
                      }),
                    onSuccess: () =>
                      Effect.gen(function* () {
                        yield* commit(
                          RouterEvent.NavigationCommitted({
                            sequence: yield* nextSequence,
                            href: command.href,
                          }),
                        );
                      }),
                  }),
                );
              }
            }
          }),
        );
      });

      const navigate = Effect.fn("@cab/router/Router.navigate")(function* (href: string) {
        yield* dispatch(RouterCommand.NavigationRequested({ href }));
      });

      return {
        dispatch,
        navigate,
        state: SubscriptionRef.get(stateRef),
        changes: SubscriptionRef.changes(stateRef),
        events: Ref.get(journalRef),
      };
    }),
  );

  /**
   * Builds a browser-backed router using `WindowHistory.layer`.
   *
   * @category layers
   * @since 0.0.0
   */
  static readonly layerBrowser: Layer.Layer<Router, HistoryError> = Router.layer.pipe(
    Layer.provide(WindowHistory.layer),
  );
}
