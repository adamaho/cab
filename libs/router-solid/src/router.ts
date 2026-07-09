import {
  type HistoryError,
  MemoryHistory,
  Router,
  type RouterCommand,
  type RouterEvent,
  type RouterState,
  initial,
} from "@cab/router";
import type { Sequenced, StoreReader } from "@cab/store";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { onCleanup, type Accessor } from "solid-js";

import { createKeyAccessor } from "./bridge";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Solid-facing router instance created by `createBrowserRouter` or
 * `createMemoryRouter`.
 *
 * **Details**
 *
 * Each instance owns its Effect runtime and reactive bridge, so two routers are
 * fully independent. The runtime details are intentionally private; consumers
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
    onEvent?: (event: Sequenced<RouterEvent>) => void,
  ): SolidRouter {
    return new SolidRouter({
      runtime: ManagedRuntime.make(layer),
      initialState,
      reader: undefined,
      readerListeners: new Set(),
      status: "new",
      ...(onEvent === undefined ? {} : { onEvent }),
    });
  }

  static mountProvider(router: SolidRouter): void {
    const impl = router.#impl;

    if (impl.status === "mounted") {
      throw new Error(
        "@cab/router-solid: router instance is already mounted. Create a separate router instance for each <RouterProvider>.",
      );
    }

    if (impl.status === "disposed") {
      throw new Error(
        "@cab/router-solid: router instance has been disposed. Create a new router instance before mounting another <RouterProvider>.",
      );
    }

    impl.status = "mounted";

    let disposed = false;

    void impl.runtime
      .runPromise(Router)
      .then((service) => {
        if (disposed) return;

        impl.reader = service.reader;

        for (const listener of impl.readerListeners) {
          listener(service.reader);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;

        impl.startupError = error;
        impl.status = "disposed";
        impl.reader = undefined;
        impl.readerListeners.clear();
        disposeRuntime(impl);
      });

    const onEvent = impl.onEvent;

    if (onEvent !== undefined) {
      impl.runtime.runFork(
        Effect.gen(function* () {
          const service = yield* Router;
          yield* service.reader.journalChanges.pipe(
            Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
          );
        }),
      );
    }

    onCleanup(() => {
      disposed = true;
      impl.status = "disposed";
      impl.reader = undefined;
      impl.readerListeners.clear();
      disposeRuntime(impl);
    });
  }

  static useState(router: SolidRouter): Accessor<RouterState>;
  static useState<TSelected>(
    router: SolidRouter,
    options: {
      readonly select: (state: RouterState) => TSelected;
      readonly equals?: (prev: TSelected, next: TSelected) => boolean;
    },
  ): Accessor<TSelected>;
  static useState<TSelected>(
    router: SolidRouter,
    options?: {
      readonly select: (state: RouterState) => TSelected;
      readonly equals?: (prev: TSelected, next: TSelected) => boolean;
    },
  ): Accessor<RouterState | TSelected> {
    if (options === undefined) {
      return createKeyAccessor(
        () => router.#impl.reader,
        (listener) => router.#subscribeReader(listener),
        "href",
        router.#impl.initialState.href,
        (href) => ({ href }),
      );
    }

    const select = options.select;

    return createKeyAccessor(
      () => router.#impl.reader,
      (listener) => router.#subscribeReader(listener),
      "href",
      router.#impl.initialState.href,
      (href) => select({ href }),
      options.equals === undefined ? undefined : { equals: options.equals },
    );
  }

  static useNavigate(router: SolidRouter): (href: string) => void {
    return (href: string) => {
      const impl = router.#assertDispatchable();

      impl.runtime.runFork(
        Effect.gen(function* () {
          const service = yield* Router;
          yield* service.navigate(href);
        }),
      );
    };
  }

  static useDispatch(router: SolidRouter): (command: RouterCommand) => void {
    return (command: RouterCommand) => {
      const impl = router.#assertDispatchable();

      impl.runtime.runFork(
        Effect.gen(function* () {
          const service = yield* Router;
          yield* service.dispatch(command);
        }),
      );
    };
  }

  #assertDispatchable(): SolidRouterImpl {
    const impl = this.#impl;

    if (impl.startupError !== undefined) {
      throw new Error("@cab/router-solid: router runtime failed to start.", {
        cause: impl.startupError,
      });
    }

    if (impl.status === "disposed") {
      throw new Error(
        "@cab/router-solid: router instance has been disposed. Ignore stale hook callbacks after <RouterProvider> unmounts.",
      );
    }

    if (impl.status !== "mounted") {
      throw new Error(
        "@cab/router-solid: router instance is not mounted. Dispatch through hooks inside <RouterProvider>.",
      );
    }

    return impl;
  }

  #subscribeReader(listener: (reader: StoreReader<RouterState, RouterEvent>) => void): () => void {
    const reader = this.#impl.reader;

    if (reader !== undefined) {
      listener(reader);
      return () => {};
    }

    this.#impl.readerListeners.add(listener);

    return () => {
      this.#impl.readerListeners.delete(listener);
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
 * journal itself stays in `@cab/router` (`router.reader.journal`,
 * `router.reader.journalChanges`) for Effect-land consumers.
 *
 * @category models
 * @since 0.0.0
 */
export interface RouterOptions {
  readonly onEvent?: (event: Sequenced<RouterEvent>) => void;
}

/**
 * Private per-instance runtime and seed state backing a `SolidRouter`.
 */
interface SolidRouterImpl {
  readonly runtime: ManagedRuntime.ManagedRuntime<Router, HistoryError>;
  readonly initialState: RouterState;
  reader: StoreReader<RouterState, RouterEvent> | undefined;
  readonly readerListeners: Set<(reader: StoreReader<RouterState, RouterEvent>) => void>;
  status: "new" | "mounted" | "disposed";
  startupError?: unknown;
  readonly onEvent?: (event: Sequenced<RouterEvent>) => void;
}

function disposeRuntime(impl: SolidRouterImpl): void {
  void impl.runtime.dispose().catch(() => undefined);
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
