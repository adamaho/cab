import { Effect, Stream, type Cause } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import type { HistoryError } from "./history";
import { Router } from "./router";
import type { RouterState } from "./state";

/**
 * Browser-backed atom runtime for router UI bindings.
 *
 * **Details**
 *
 * The runtime builds `Router.layerBrowser`, so browser consumers can read router
 * atoms without manually providing the `Router` service.
 *
 * @category atoms
 * @since 0.0.0
 */
export const routerRuntimeAtom: Atom.AtomRuntime<Router, HistoryError> = Atom.runtime(
  Router.layerBrowser,
);

/**
 * Atom-backed view of the current router state.
 *
 * **Details**
 *
 * The atom subscribes to `Router.stateChanges`, which emits the seeded state and
 * each later committed navigation state.
 *
 * @category atoms
 * @since 0.0.0
 */
export const routerStateAtom: Atom.Atom<
  AsyncResult.AsyncResult<RouterState, HistoryError | Cause.NoSuchElementError>
> = routerRuntimeAtom.atom(
  Stream.unwrap(
    Effect.gen(function* () {
      const router = yield* Router;
      return router.stateChanges;
    }),
  ),
);

/**
 * Atom function for navigating to an href from UI bindings.
 *
 * **Details**
 *
 * Writing an href to this atom function runs `Router.navigate`. Navigation push
 * failures are recorded in the router journal by the service; construction of
 * the browser-backed runtime can still fail with `HistoryError`.
 *
 * @category atoms
 * @since 0.0.0
 */
export const routerNavigateAtom: Atom.AtomResultFn<string, void, HistoryError> =
  routerRuntimeAtom.fn<string>()((href: string) =>
    Effect.gen(function* () {
      const router = yield* Router;
      yield* router.navigate(href);
    }),
  );
