import { Store, type StoreReader } from "@cab/store";
import { Context, Effect, Layer, Semaphore, Stream } from "effect";

import { History, type HistoryError, WindowHistory } from "./history";
import {
  RouterCommand,
  RouterSliceCommand,
  RouterSlice,
  type RouterEvent,
  type RouterState,
} from "./slice";

/**
 * Service shape for dispatching navigation commands and observing router state.
 *
 * **Details**
 *
 * `dispatch` and `navigate` accept user navigation intent through the router
 * saga. Consumers observe the folded state projection and journal facts through
 * `reader`.
 *
 * @category models
 * @since 0.0.0
 */
export interface RouterShape {
  /**
   * Dispatches a user-originated router command.
   *
   * **Details**
   *
   * Dispatch serializes navigation commands, records requested and outcome facts
   * in the journal, and updates projected state only after committed navigation.
   */
  readonly dispatch: (command: RouterCommand) => Effect.Effect<void>;

  /**
   * Navigates to an href by dispatching a navigation request command.
   */
  readonly navigate: (href: string) => Effect.Effect<void>;

  /** Read-only store surface for observing router state and journal facts. */
  readonly reader: StoreReader<RouterState, RouterEvent>;
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
      const store = yield* Store.make(RouterSlice.make(currentHref));
      const semaphore = yield* Semaphore.make(1);

      const observeCurrent = Effect.fn("@cab/router/Router.observeCurrent")(function* () {
        yield* semaphore.withPermit(
          history.current.pipe(
            Effect.matchEffect({
              onFailure: () => Effect.void,
              onSuccess: (href) =>
                Effect.gen(function* () {
                  yield* store.dispatch(RouterSliceCommand.NavigationObserved({ href }));
                }),
            }),
          ),
        );
      });

      yield* history.changes.pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() => observeCurrent()),
        Effect.forkScoped,
      );

      const dispatch = Effect.fn("@cab/router/Router.dispatch")(function* (command: RouterCommand) {
        yield* semaphore.withPermit(
          Effect.gen(function* () {
            switch (command._tag) {
              case "NavigationRequested": {
                const before = (yield* store.journal).length;

                yield* store.dispatch(command);

                const after = (yield* store.journal).length;

                if (after === before) return;

                yield* history.push(command.href).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.gen(function* () {
                        yield* store.dispatch(
                          RouterSliceCommand.NavigationFailed({
                            href: command.href,
                            reason: error.reason,
                            ...(error.cause === undefined ? {} : { cause: error.cause }),
                          }),
                        );
                      }),
                    onSuccess: () =>
                      Effect.gen(function* () {
                        yield* store.dispatch(
                          RouterSliceCommand.NavigationCommitted({
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
        reader: store.reader,
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
