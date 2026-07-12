import {
  History,
  type HistoryError,
  MemoryHistory,
  type MemoryHistory as MemoryHistoryHandle,
  Router,
  type RouterCommand,
  type RouterEvent,
  RouterModel,
  type RouterShape,
  type RouterState,
  WindowHistory,
} from "@cab/router";
import type { Sequenced } from "@cab/store";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { onCleanup, type Accessor } from "solid-js";

import { RouterBridge } from "./bridge";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Solid-facing router instance created by `createBrowserRouter` or
 * `createMemoryRouter`.
 *
 * **Details**
 *
 * The instance owns a stable router model. Each provider mount creates a fresh
 * process runtime around that model, while state, journal facts, sequence, and
 * reader identity survive sequential remounts.
 *
 * @see {@link createBrowserRouter} for browser-backed construction
 * @see {@link createMemoryRouter} for memory-backed construction in tests
 * @category models
 * @since 0.0.0
 */
export class SolidRouter {
  declare private readonly _SolidRouter: void;

  private constructor() {}
}

/**
 * Memory-backed router handle for tests and examples.
 *
 * @category models
 * @since 0.0.0
 */
export interface MemoryRouter {
  readonly router: SolidRouter;
  readonly history: MemoryHistoryHandle;
}

/**
 * Construction options shared by the router constructors.
 *
 * **Details**
 *
 * `onEvent` observes newly committed journal facts during each mounted browser
 * lifetime. Callback failures are reported diagnostically and never alter
 * dispatch or later event delivery.
 *
 * @category models
 * @since 0.0.0
 */
export interface RouterOptions {
  readonly onEvent?: (event: Sequenced<RouterEvent>) => void;
}

/**
 * Browser router construction options.
 *
 * **Details**
 *
 * `initialHref` provides an explicit synchronous seed for server rendering. In
 * a browser, omitting it reads the current document location.
 *
 * @category models
 * @since 0.0.0
 */
export interface BrowserRouterOptions extends RouterOptions {
  readonly initialHref?: string;
}

type RouterBridgeInstance = ReturnType<typeof RouterBridge.make<RouterState, RouterEvent>>;
type RouterRuntime = ManagedRuntime.ManagedRuntime<Router, HistoryError>;

type SolidRouterStartResult =
  | { readonly _tag: "Running"; readonly runtime: RouterRuntime; readonly service: RouterShape }
  | { readonly _tag: "Server" }
  | { readonly _tag: "Failed"; readonly cause: unknown }
  | { readonly _tag: "Cancelled" };

interface SolidRouterMount {
  readonly generation: number;
  status: "starting" | "running" | "server" | "failed" | "cancelled";
  readonly ready: Promise<SolidRouterStartResult>;
  readonly resolveReady: (result: SolidRouterStartResult) => void;
  startup: Promise<void>;
  runtime?: RouterRuntime;
  service?: RouterShape;
  unsubscribeJournal?: () => void;
  startupError?: unknown;
}

interface SolidRouterImpl {
  readonly model: RouterModel;
  readonly historyLayer: Layer.Layer<History, HistoryError>;
  readonly bridge: RouterBridgeInstance;
  readonly onEvent?: (event: Sequenced<RouterEvent>) => void;
  generation: number;
  activeMount?: SolidRouterMount;
  disposalTail: Promise<void>;
}

const routerImpls = new WeakMap<SolidRouter, SolidRouterImpl>();

function getImpl(router: SolidRouter): SolidRouterImpl {
  const impl = routerImpls.get(router);

  if (impl === undefined) {
    throw new Error(
      "@cab/router-solid: invalid router instance. Construct routers with createBrowserRouter() or createMemoryRouter().",
    );
  }

  return impl;
}

export function makeSolidRouter(
  model: RouterModel,
  historyLayer: Layer.Layer<History, HistoryError>,
  onEvent?: (event: Sequenced<RouterEvent>) => void,
): SolidRouter {
  const router = Object.create(SolidRouter.prototype) as SolidRouter;
  routerImpls.set(router, {
    model,
    historyLayer,
    bridge: RouterBridge.make(model.reader),
    generation: 0,
    disposalTail: Promise.resolve(),
    ...(onEvent === undefined ? {} : { onEvent }),
  });
  return router;
}

function reportDiagnostic(message: string, cause?: unknown): void {
  const error = new Error(message, cause === undefined ? undefined : { cause });

  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
  } else {
    globalThis.console.error(error);
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

async function startMount(
  impl: SolidRouterImpl,
  mount: SolidRouterMount,
  previousDisposal: Promise<void>,
): Promise<void> {
  try {
    await previousDisposal;

    if (impl.activeMount !== mount || mount.status !== "starting") {
      mount.resolveReady({ _tag: "Cancelled" });
      return;
    }

    const onEvent = impl.onEvent;
    if (onEvent !== undefined) {
      mount.unsubscribeJournal = impl.model.reader.subscribeJournal((fact) => {
        try {
          onEvent(fact);
        } catch (cause) {
          reportDiagnostic("@cab/router-solid: onEvent callback failed.", cause);
        }
      });
    }

    const runtime = ManagedRuntime.make(
      Router.layerFromModel(impl.model).pipe(Layer.provide(impl.historyLayer)),
    );
    mount.runtime = runtime;

    const context = await runtime.context();
    const service = Context.get(context, Router);

    if (impl.activeMount !== mount || mount.status !== "starting") {
      mount.resolveReady({ _tag: "Cancelled" });
      return;
    }

    mount.service = service;
    mount.status = "running";
    mount.resolveReady({ _tag: "Running", runtime, service });
  } catch (cause) {
    if (impl.activeMount !== mount || mount.status === "cancelled") {
      mount.resolveReady({ _tag: "Cancelled" });
      return;
    }

    mount.status = "failed";
    mount.startupError = cause;
    mount.resolveReady({ _tag: "Failed", cause });
  }
}

function disposeMount(impl: SolidRouterImpl, mount: SolidRouterMount): void {
  if (impl.activeMount !== mount) return;

  delete impl.activeMount;
  mount.status = "cancelled";
  mount.resolveReady({ _tag: "Cancelled" });
  mount.unsubscribeJournal?.();
  delete mount.unsubscribeJournal;

  impl.disposalTail = (async () => {
    try {
      await mount.runtime?.dispose();
    } catch (cause) {
      reportDiagnostic("@cab/router-solid: router runtime disposal failed.", cause);
    }

    await mount.startup;
  })();
}

function activeMount(router: SolidRouter): {
  readonly impl: SolidRouterImpl;
  readonly mount: SolidRouterMount;
} {
  const impl = getImpl(router);
  const mount = impl.activeMount;

  if (mount === undefined) {
    throw new Error(
      "@cab/router-solid: router instance is not mounted. Dispatch through hooks inside <RouterProvider>.",
    );
  }

  return { impl, mount };
}

function assertCurrentMount(impl: SolidRouterImpl, mount: SolidRouterMount): void {
  if (impl.activeMount !== mount) {
    throw new Error(
      "@cab/router-solid: stale router callback invoked after <RouterProvider> unmount. Capture a new callback from the active provider generation.",
    );
  }

  if (mount.status === "failed") {
    throw new Error("@cab/router-solid: router runtime failed to start.", {
      cause: mount.startupError,
    });
  }

  if (mount.status === "server") {
    throw new Error(
      "@cab/router-solid: navigation requires an active browser <RouterProvider> mount.",
    );
  }
}

function runCommand(
  impl: SolidRouterImpl,
  mount: SolidRouterMount,
  command: (service: RouterShape) => Effect.Effect<void>,
): void {
  assertCurrentMount(impl, mount);

  if (mount.status === "running") {
    mount.runtime?.runFork(command(mount.service as RouterShape));
    return;
  }

  void mount.ready.then((result) => {
    switch (result._tag) {
      case "Running": {
        if (impl.activeMount === mount && mount.status === "running") {
          result.runtime.runFork(command(result.service));
        }
        return;
      }
      case "Failed": {
        reportDiagnostic(
          "@cab/router-solid: queued router command was not dispatched.",
          result.cause,
        );
        return;
      }
      case "Server": {
        reportDiagnostic(
          "@cab/router-solid: queued navigation requires an active browser <RouterProvider> mount.",
        );
        return;
      }
      case "Cancelled":
        return;
    }
  });
}

// -----------------------------------------------------------------------------
// Package internals used by provider and hooks
// -----------------------------------------------------------------------------

export function mountRouterProvider(router: SolidRouter): void {
  const impl = getImpl(router);

  if (impl.activeMount !== undefined) {
    throw new Error(
      "@cab/router-solid: router instance is already mounted. A router supports only one active <RouterProvider>.",
    );
  }

  const generation = ++impl.generation;
  let resolveReady!: (result: SolidRouterStartResult) => void;
  const ready = new Promise<SolidRouterStartResult>((resolve) => {
    resolveReady = resolve;
  });
  const mount: SolidRouterMount = {
    generation,
    status: "starting",
    ready,
    resolveReady,
    startup: Promise.resolve(),
  };
  impl.activeMount = mount;

  onCleanup(() => disposeMount(impl, mount));

  if (!isBrowser()) {
    mount.status = "server";
    mount.resolveReady({ _tag: "Server" });
    return;
  }

  const previousDisposal = impl.disposalTail;
  mount.startup = startMount(impl, mount, previousDisposal);
}

export function selectRouterState(router: SolidRouter): Accessor<RouterState>;
export function selectRouterState<TSelected>(
  router: SolidRouter,
  options: {
    readonly select: (state: RouterState) => TSelected;
    readonly equals?: (previous: TSelected, next: TSelected) => boolean;
  },
): Accessor<TSelected>;
export function selectRouterState<TSelected>(
  router: SolidRouter,
  options?: {
    readonly select: (state: RouterState) => TSelected;
    readonly equals?: (previous: TSelected, next: TSelected) => boolean;
  },
): Accessor<RouterState | TSelected> {
  const bridge = getImpl(router).bridge;

  if (options === undefined) {
    return bridge.select((state) => state);
  }

  return bridge.select(
    options.select,
    options.equals === undefined ? undefined : { equals: options.equals },
  );
}

export function makeRouterNavigate(router: SolidRouter): (href: string) => void {
  const { impl, mount } = activeMount(router);
  return (href) => runCommand(impl, mount, (service) => service.navigate(href));
}

export function makeRouterDispatch(router: SolidRouter): (command: RouterCommand) => void {
  const { impl, mount } = activeMount(router);
  return (command) => runCommand(impl, mount, (service) => service.dispatch(command));
}

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

function windowHref(): string {
  if (!isBrowser()) return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Creates a browser-backed Solid router synchronously.
 *
 * **Details**
 *
 * Construction allocates the stable router model but performs no Effect runtime
 * work. Outside a browser, the default initial href is `"/"`; pass
 * `initialHref` to render a request URL on the server.
 *
 * @see {@link RouterProvider} for mounting the browser process
 * @category constructors
 * @since 0.0.0
 */
export function createBrowserRouter(options?: BrowserRouterOptions): SolidRouter {
  const model = RouterModel.make(options?.initialHref ?? windowHref());
  return makeSolidRouter(model, WindowHistory.layer, options?.onEvent);
}

/**
 * Creates a memory-backed Solid router instance for tests and examples.
 *
 * @see {@link createBrowserRouter} for synchronous browser construction
 * @category constructors
 * @since 0.0.0
 */
export const createMemoryRouter: (
  options: RouterOptions & { readonly initialHref: string },
) => Effect.Effect<MemoryRouter> = Effect.fn("@cab/router-solid/createMemoryRouter")(function* (
  options: RouterOptions & { readonly initialHref: string },
) {
  const history = yield* MemoryHistory.make(options.initialHref);
  const model = RouterModel.make(options.initialHref);
  const router = makeSolidRouter(model, history.layer, options.onEvent);

  return { router, history };
});
