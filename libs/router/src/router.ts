import { Store, type Store as WritableStore, type StoreReader } from "@cab/store";
import { Context, Effect, Layer, Semaphore, Stream } from "effect";

import {
  History,
  type HistoryError,
  type HistoryObservation,
  type HistoryShape,
  WindowHistory,
} from "./history";
import {
  RouterCommand,
  RouterSliceCommand,
  RouterSlice,
  type RouterEvent,
  type RouterState,
} from "./slice";

interface RouterModelImpl {
  readonly store: WritableStore<RouterState, RouterSliceCommand, RouterEvent>;
  processActive: boolean;
}

interface RouterProcessLease {
  readonly impl: RouterModelImpl;
  active: boolean;
}

const routerModelImpls = new WeakMap<RouterModel, RouterModelImpl>();

/**
 * Stable, synchronously constructed router state and journal model.
 *
 * **Details**
 *
 * The model owns one read-only store identity for its full lifetime. Mounted
 * router layers add history I/O around the model without replacing or disposing
 * its state, journal, sequence, or subscriptions.
 *
 * @category models
 * @since 0.0.0
 */
export class RouterModel {
  readonly #impl: RouterModelImpl;

  private constructor(impl: RouterModelImpl) {
    this.#impl = impl;
    routerModelImpls.set(this, impl);
    this.reader = this.#impl.store.reader;
  }

  /**
   * Constructs a complete router model synchronously from an initial href.
   *
   * @category constructors
   * @since 0.0.0
   */
  static make(initialHref: string): RouterModel {
    return new RouterModel({
      store: Store.makeSync(RouterSlice.make(initialHref)),
      processActive: false,
    });
  }

  /** Stable read-only state and journal surface for the full model lifetime. */
  readonly reader: StoreReader<RouterState, RouterEvent>;
}

function acquireModelProcess(model: RouterModel) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const impl = routerModelImpls.get(model);

      if (impl === undefined) {
        throw new Error("Cannot mount a RouterModel that was not constructed by RouterModel.make.");
      }

      if (impl.processActive) {
        throw new Error(
          "Cannot mount more than one router process for the same RouterModel at a time.",
        );
      }

      impl.processActive = true;
      const lease: RouterProcessLease = { impl, active: true };
      return lease;
    }),
    (lease) =>
      Effect.sync(() => {
        lease.active = false;
        lease.impl.processActive = false;
      }),
  );
}

function makeRouterService(
  lease: RouterProcessLease,
  history: HistoryShape,
  observation: HistoryObservation,
) {
  return Effect.gen(function* () {
    const store = lease.impl.store;
    const semaphore = yield* Semaphore.make(1);

    yield* store.dispatch(RouterSliceCommand.NavigationObserved({ href: observation.initialHref }));

    const observeCurrent = Effect.fn("@cab/router/Router.observeCurrent")(function* () {
      yield* semaphore.withPermit(
        history.current.pipe(
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: (href) => store.dispatch(RouterSliceCommand.NavigationObserved({ href })),
          }),
        ),
      );
    });

    yield* observation.changes.pipe(
      Stream.runForEach(() => observeCurrent()),
      Effect.forkScoped,
    );

    const dispatch = Effect.fn("@cab/router/Router.dispatch")(function* (command: RouterCommand) {
      yield* semaphore.withPermit(
        Effect.gen(function* () {
          if (!lease.active) {
            return yield* Effect.die(
              new Error(
                "Cannot dispatch through a router process after its layer has been released.",
              ),
            );
          }

          switch (command._tag) {
            case "NavigationRequested": {
              const before = (yield* store.journal).length;

              yield* store.dispatch(command);

              const after = (yield* store.journal).length;

              if (after === before) return;

              yield* history.push(command.href).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    store.dispatch(
                      RouterSliceCommand.NavigationFailed({
                        href: command.href,
                        reason: error.reason,
                        ...(error.cause === undefined ? {} : { cause: error.cause }),
                      }),
                    ),
                  onSuccess: () =>
                    store.dispatch(
                      RouterSliceCommand.NavigationCommitted({
                        href: command.href,
                      }),
                    ),
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
    } satisfies RouterShape;
  });
}

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
      const observation = yield* history.observe;
      const model = RouterModel.make(observation.initialHref);
      const lease = yield* acquireModelProcess(model);

      return yield* makeRouterService(lease, history, observation);
    }),
  );

  /**
   * Builds one mounted router process around an existing stable model.
   *
   * **Details**
   *
   * The layer catches the model up to listener-first history state before it
   * publishes the service. Only one process may use a model concurrently;
   * sequential layer lifetimes preserve the model reader, state, and journal.
   *
   * @category layers
   * @since 0.0.0
   */
  static layerFromModel(model: RouterModel): Layer.Layer<Router, HistoryError, History> {
    return Layer.effect(
      Router,
      Effect.gen(function* () {
        const history = yield* History;
        const lease = yield* acquireModelProcess(model);
        const observation = yield* history.observe;

        return yield* makeRouterService(lease, history, observation);
      }),
    );
  }

  /**
   * Builds a browser-backed router using `WindowHistory.layer`.
   *
   * @category layers
   * @since 0.0.0
   */
  static readonly layerBrowser: Layer.Layer<Router, HistoryError> = Router.layer.pipe(
    Layer.provide(WindowHistory.layer),
  );

  /**
   * Builds a browser-backed mounted process around an existing stable model.
   *
   * @category layers
   * @since 0.0.0
   */
  static layerBrowserFromModel(model: RouterModel): Layer.Layer<Router, HistoryError> {
    return Router.layerFromModel(model).pipe(Layer.provide(WindowHistory.layer));
  }
}
