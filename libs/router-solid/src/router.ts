import {
  type HistoryError,
  MemoryHistory,
  Router,
  type RouterCommand,
  type RouterEvent,
  type RouterState,
  initial,
} from "@cab/router";
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-solid";
import { Effect, Layer, Stream, type Cause } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { createMemo, type Accessor } from "solid-js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Solid-facing router instance created by `createBrowserRouter` or
 * `createMemoryRouter`.
 *
 * **Details**
 *
 * Each instance owns its reactive wiring, so two routers in one atom registry
 * are fully independent. The atom details are intentionally private; consumers
 * interact with the instance through `RouterProvider` and the Solid hooks.
 *
 * @see {@link createBrowserRouter} for browser-backed construction
 * @see {@link createMemoryRouter} for memory-backed construction in tests
 * @category models
 * @since 0.0.0
 */
export class SolidRouter {
  readonly #impl: SolidRouterImpl;

  private constructor(impl: SolidRouterImpl) {
    this.#impl = impl;
  }

  static make(
    layer: Layer.Layer<Router, HistoryError>,
    initialState: RouterState,
    onEvent?: (event: RouterEvent) => void,
  ): SolidRouter {
    // Each router instance gets its own Layer.MemoMap. The module-level
    // Atom.runtime factory memoizes layers by reference in a shared MemoMap, so
    // two instances built from the same layer object (Router.layer,
    // Router.layerBrowser) would silently share one Router service.
    const factory = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() });
    const runtimeAtom = factory(layer);

    const stateAtom = runtimeAtom.atom(
      Stream.unwrap(
        Effect.gen(function* () {
          const router = yield* Router;
          return router.stateChanges;
        }),
      ),
      { initialValue: initialState },
    );

    const navigateAtom = runtimeAtom.fn<string>()((href: string) =>
      Effect.gen(function* () {
        const router = yield* Router;
        yield* router.navigate(href);
      }),
    );

    const dispatchAtom = runtimeAtom.fn<RouterCommand>()((command: RouterCommand) =>
      Effect.gen(function* () {
        const router = yield* Router;
        yield* router.dispatch(command);
      }),
    );

    const journalTapAtom =
      onEvent === undefined
        ? undefined
        : runtimeAtom.atom(
            Stream.unwrap(
              Effect.gen(function* () {
                const router = yield* Router;
                return router.journalChanges.pipe(
                  Stream.tap((event) => Effect.sync(() => onEvent(event))),
                );
              }),
            ),
          );

    return new SolidRouter({
      runtimeAtom,
      stateAtom,
      navigateAtom,
      dispatchAtom,
      initialState,
      ...(journalTapAtom === undefined ? {} : { journalTapAtom }),
    });
  }

  static mountProvider(router: SolidRouter): void {
    useAtomMount(() => router.#impl.runtimeAtom);
    useAtomMount(() => router.#impl.stateAtom);

    const journalTapAtom = router.#impl.journalTapAtom;

    if (journalTapAtom !== undefined) {
      useAtomMount(() => journalTapAtom);
    }
  }

  static useState(router: SolidRouter): Accessor<RouterState>;
  static useState<TSelected>(
    router: SolidRouter,
    options: { readonly select: (state: RouterState) => TSelected },
  ): Accessor<TSelected>;
  static useState<TSelected>(
    router: SolidRouter,
    options?: { readonly select: (state: RouterState) => TSelected },
  ): Accessor<RouterState | TSelected> {
    const result = useAtomValue(() => router.#impl.stateAtom);

    if (options === undefined) {
      return createMemo<RouterState>((previous) => {
        const current = result();
        return AsyncResult.isSuccess(current) ? current.value : previous;
      }, router.#impl.initialState);
    }

    const select = options.select;

    return createMemo<TSelected>((previous) => {
      const current = result();
      return AsyncResult.isSuccess(current) ? select(current.value) : previous;
    }, select(router.#impl.initialState));
  }

  static useNavigate(router: SolidRouter): (href: string) => void {
    const navigate = useAtomSet(() => router.#impl.navigateAtom);

    return (href: string) => {
      navigate(href);
    };
  }

  static useDispatch(router: SolidRouter): (command: RouterCommand) => void {
    const dispatch = useAtomSet(() => router.#impl.dispatchAtom);

    return (command: RouterCommand) => {
      dispatch(command);
    };
  }
}

/**
 * Memory-backed router handle for tests and examples.
 *
 * **Details**
 *
 * `history` is the `MemoryHistory` inspection handle: `pushes` records
 * router-owned navigation for assertions and `observe` drives external
 * navigation the way browser back/forward would.
 *
 * @category models
 * @since 0.0.0
 */
export interface MemoryRouter {
  readonly router: SolidRouter;
  readonly history: MemoryHistory;
}

/**
 * Construction options shared by the router constructors.
 *
 * **Details**
 *
 * `onEvent` observes every journal fact the router appends — requested,
 * committed, observed, and failed navigation — for the lifetime of the mounted
 * `RouterProvider`. Use it for console logging, devtools, and analytics. The
 * journal itself stays in `@cab/router` (`router.journal`,
 * `router.journalChanges`) for Effect-land consumers.
 *
 * @category models
 * @since 0.0.0
 */
export interface RouterOptions {
  readonly onEvent?: (event: RouterEvent) => void;
}

/**
 * Private per-instance atoms and seed state backing a `SolidRouter`.
 */
interface SolidRouterImpl {
  readonly runtimeAtom: Atom.AtomRuntime<Router, HistoryError>;
  readonly stateAtom: Atom.Atom<
    AsyncResult.AsyncResult<RouterState, HistoryError | Cause.NoSuchElementError>
  >;
  readonly navigateAtom: Atom.AtomResultFn<string, void, HistoryError>;
  readonly dispatchAtom: Atom.AtomResultFn<RouterCommand, void, HistoryError>;
  readonly initialState: RouterState;
  readonly journalTapAtom?: Atom.Atom<
    AsyncResult.AsyncResult<RouterEvent, HistoryError | Cause.NoSuchElementError>
  >;
}

function windowHref(): string {
  if (typeof window === "undefined") {
    return "/";
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Creates a browser-backed Solid router instance.
 *
 * **Details**
 *
 * Construction is synchronous and seeds the initial `RouterState` from the
 * current `window.location`, so `useRouterState` always has a value before the
 * runtime and state stream start. Outside a browser the seed falls back to
 * `"/"`. Pass `onEvent` to observe journal facts while the provider is mounted.
 *
 * @see {@link RouterProvider} for providing the instance to an application
 * @category constructors
 * @since 0.0.0
 */
export function createBrowserRouter(options?: RouterOptions): SolidRouter {
  return SolidRouter.make(Router.layerBrowser, initial(windowHref()), options?.onEvent);
}

/**
 * Creates a memory-backed Solid router instance for tests and examples.
 *
 * **Details**
 *
 * Construction is effectful because the `MemoryHistory` handle must be
 * allocated and returned alongside the router: tests assert on
 * `history.pushes` and drive external navigation with `history.observe`.
 *
 * @see {@link createBrowserRouter} for browser construction
 * @category constructors
 * @since 0.0.0
 */
export const createMemoryRouter: (
  options: RouterOptions & { readonly initialHref: string },
) => Effect.Effect<MemoryRouter> = Effect.fn("@cab/router-solid/createMemoryRouter")(function* (
  options: RouterOptions & { readonly initialHref: string },
) {
  const history = yield* MemoryHistory.make(options.initialHref);
  const router = SolidRouter.make(
    Router.layer.pipe(Layer.provide(history.layer)),
    initial(options.initialHref),
    options.onEvent,
  );

  return { router, history };
});
