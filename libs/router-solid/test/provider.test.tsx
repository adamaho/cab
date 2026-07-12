import {
  History,
  HistoryError,
  RouterCommand,
  type RouterEvent,
  RouterModel,
  type HistoryShape,
} from "@cab/router";
import type { Sequenced } from "@cab/store";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Deferred, Effect, Layer, Stream } from "effect";
import { createComponent, createEffect, createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRouterDispatch, useRouterNavigate, useRouterState } from "../src/hooks";
import { RouterProvider, useRouter } from "../src/provider";
import {
  createBrowserRouter,
  createMemoryRouter,
  makeSolidRouter,
  type MemoryRouter,
} from "../src/router";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function Probe(props: { readonly expectedRouter?: MemoryRouter["router"] }) {
  const router = useRouter();
  const state = useRouterState();
  const href = useRouterState({ select: (s) => s.href });
  const navigate = useRouterNavigate();
  const dispatch = useRouterDispatch();

  return (
    <div>
      <span data-testid="href">{state().href}</span>
      <span data-testid="selected-href">{href()}</span>
      <span data-testid="same-router">{String(router === props.expectedRouter)}</span>
      <button onClick={() => navigate("/settings")} type="button">
        Settings
      </button>
      <button
        onClick={() => dispatch(RouterCommand.NavigationRequested({ href: "/billing" }))}
        type="button"
      >
        Billing
      </button>
    </div>
  );
}

function HrefProbe(props: { readonly testId: string }) {
  const state = useRouterState();

  return <span data-testid={props.testId}>{state().href}</span>;
}

function renderWithRouter(memory: MemoryRouter) {
  return render(() => (
    <RouterProvider router={memory.router}>
      <Probe expectedRouter={memory.router} />
    </RouterProvider>
  ));
}

function EffectNavigateProbe() {
  const state = useRouterState();
  const navigate = useRouterNavigate();

  createEffect((fired) => {
    if (!fired && state().href === "/first") {
      navigate("/second");
      return true;
    }

    return fired;
  }, false);

  return (
    <>
      <button onClick={() => navigate("/first")} type="button">
        First
      </button>
      <span data-testid="href">{state().href}</span>
    </>
  );
}

function MountNavigateProbe(props: { readonly href?: string }) {
  const state = useRouterState();
  const navigate = useRouterNavigate();

  createEffect((fired) => {
    if (!fired) {
      navigate(props.href ?? "/mounted-effect");
      return true;
    }

    return fired;
  }, false);

  return <span data-testid="href">{state().href}</span>;
}

function CaptureNavigateProbe(props: {
  readonly onNavigate: (navigate: (href: string) => void) => void;
}) {
  const navigate = useRouterNavigate();
  props.onNavigate(navigate);

  return <span data-testid="capture-ready">ready</span>;
}

function SelectorProbe(props: { readonly select: (state: { readonly href: string }) => string }) {
  const href = useRouterState({ select: props.select });
  return <span data-testid="selected-href">{href()}</span>;
}

function EqualityProbe(props: {
  readonly onRender: (value: { readonly stable: boolean }) => void;
}) {
  const selected = useRouterState({
    select: (state) => ({ stable: state.href.startsWith("/external") }),
    equals: (a, b) => a.stable === b.stable,
  });

  createEffect(() => props.onRender(selected()));

  return <span data-testid="selected">{String(selected().stable)}</span>;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("router-solid provider and hooks", () => {
  // @solidjs/testing-library only auto-registers cleanup when vitest globals
  // are enabled; this repo runs with globals: false.
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads the real model snapshot on the first render", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/start" }));
    const screen = renderWithRouter(memory);

    expect(screen.getByTestId("href").textContent).toBe("/start");
  });

  it("selects a router state slice", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/start" }));
    const screen = renderWithRouter(memory);

    expect(screen.getByTestId("selected-href").textContent).toBe("/start");
  });

  it("returns the current router instance from useRouter", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = renderWithRouter(memory);

    expect(screen.getByTestId("same-router").textContent).toBe("true");
  });

  it("updates rendered state after navigation via useRouterNavigate", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = renderWithRouter(memory);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/settings");
    });

    expect(await Effect.runPromise(memory.history.pushes)).toEqual(["/settings"]);
  });

  it("updates rendered state after dispatch via useRouterDispatch", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = renderWithRouter(memory);

    fireEvent.click(screen.getByRole("button", { name: "Billing" }));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/billing");
    });

    expect(await Effect.runPromise(memory.history.pushes)).toEqual(["/billing"]);
  });

  it("updates rendered state for externally observed navigation", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = renderWithRouter(memory);

    await Effect.runPromise(memory.history.simulate("/external"));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/external");
    });

    expect(await Effect.runPromise(memory.history.pushes)).toEqual([]);
  });

  it("delivers initial history catch-up to state hooks and onEvent", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/seed", onEvent: (event) => events.push(event) }),
    );

    await Effect.runPromise(memory.history.simulate("/drift"));

    const screen = renderWithRouter(memory);
    expect(screen.getByTestId("href").textContent).toBe("/seed");

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/drift");
    });
    expect(events).toEqual([
      expect.objectContaining({
        sequence: 0,
        event: expect.objectContaining({ _tag: "NavigationObserved", href: "/drift" }),
      }),
    ]);
  });

  it("delivers journal facts to onEvent while the provider is mounted", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const screen = renderWithRouter(memory);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(events.map((event) => event.event._tag)).toContain("NavigationCommitted");
    });

    expect(events[0]).toMatchObject({
      sequence: 0,
      event: { _tag: "NavigationRequested", href: "/settings" },
    });
  });

  it("stops selector, journal, history, and runtime work after provider unmount", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const select = vi.fn((state: { readonly href: string }) => state.href);
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const screen = render(() => (
      <RouterProvider router={memory.router}>
        <SelectorProbe select={select} />
      </RouterProvider>
    ));

    await Effect.runPromise(memory.history.simulate("/mounted"));

    await waitFor(() => {
      expect(screen.getByTestId("selected-href").textContent).toBe("/mounted");
    });

    const countBeforeUnmount = events.length;
    const selectionsBeforeUnmount = select.mock.calls.length;
    screen.unmount();

    await Effect.runPromise(memory.history.simulate("/after-unmount"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(countBeforeUnmount);
    expect(select).toHaveBeenCalledTimes(selectionsBeforeUnmount);
  });

  it("produces no post-unmount outcome for a deferred navigation", async () => {
    const finishPush = await Effect.runPromise(Deferred.make<void>());
    const events: Array<Sequenced<RouterEvent>> = [];
    let href = "/";
    const history: HistoryShape = {
      push: (nextHref) =>
        Effect.gen(function* () {
          yield* Deferred.await(finishPush);
          href = nextHref;
        }),
      current: Effect.sync(() => href),
      changes: Stream.never,
      observe: Effect.succeed({ initialHref: href, changes: Stream.never }),
    };
    const router = makeSolidRouter(
      RouterModel.make("/"),
      Layer.succeed(History, history),
      (event) => events.push(event),
    );
    const screen = render(() => (
      <RouterProvider router={router}>
        <Probe />
      </RouterProvider>
    ));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => {
      expect(events.map((event) => event.event._tag)).toEqual(["NavigationRequested"]);
    });

    screen.unmount();
    await Effect.runPromise(Deferred.succeed(finishPush, undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.map((event) => event.event._tag)).toEqual(["NavigationRequested"]);
  });

  it("allows effects reacting to router state to dispatch navigation", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const screen = render(() => (
      <RouterProvider router={memory.router}>
        <EffectNavigateProbe />
      </RouterProvider>
    ));

    fireEvent.click(screen.getByRole("button", { name: "First" }));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/second");
    });

    await waitFor(() => {
      expect(events).toMatchObject([
        { sequence: 0, event: { _tag: "NavigationRequested", href: "/first" } },
        { sequence: 1, event: { _tag: "NavigationCommitted", href: "/first" } },
        { sequence: 2, event: { _tag: "NavigationRequested", href: "/second" } },
        { sequence: 3, event: { _tag: "NavigationCommitted", href: "/second" } },
      ]);
    });
  });

  it("delivers the first child-effect navigation to onEvent", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const screen = render(() => (
      <RouterProvider router={memory.router}>
        <MountNavigateProbe />
      </RouterProvider>
    ));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/mounted-effect");
    });

    await waitFor(() => {
      expect(events[0]).toMatchObject({
        sequence: 0,
        event: { _tag: "NavigationRequested", href: "/mounted-effect" },
      });
    });
  });

  it("throws when mounting the same router instance twice", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));

    expect(() =>
      render(() => (
        <>
          <RouterProvider router={memory.router}>
            <HrefProbe testId="first-href" />
          </RouterProvider>
          <RouterProvider router={memory.router}>
            <HrefProbe testId="second-href" />
          </RouterProvider>
        </>
      )),
    ).toThrow(/already mounted/);
  });

  it("remounts the same router with preserved state and journal sequence", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const first = render(() => (
      <RouterProvider router={memory.router}>
        <Probe />
      </RouterProvider>
    ));

    fireEvent.click(first.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(first.getByTestId("href").textContent).toBe("/settings"));
    first.unmount();

    const second = renderWithRouter(memory);
    expect(second.getByTestId("href").textContent).toBe("/settings");

    fireEvent.click(second.getByRole("button", { name: "Billing" }));
    await waitFor(() => expect(second.getByTestId("href").textContent).toBe("/billing"));

    expect(events.map((event) => [event.sequence, event.event._tag])).toEqual([
      [0, "NavigationRequested"],
      [1, "NavigationCommitted"],
      [2, "NavigationRequested"],
      [3, "NavigationCommitted"],
    ]);
  });

  it("throws when a stale navigate function is called after provider unmount", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    let navigate: ((href: string) => void) | undefined;
    const screen = render(() => (
      <RouterProvider router={memory.router}>
        <CaptureNavigateProbe onNavigate={(nextNavigate) => (navigate = nextNavigate)} />
      </RouterProvider>
    ));

    expect(screen.getByTestId("capture-ready").textContent).toBe("ready");
    screen.unmount();

    expect(() => navigate?.("/after-unmount")).toThrow(/stale router callback/);
    expect(await Effect.runPromise(memory.history.pushes)).toEqual([]);
  });

  it("reconciles drift while unmounted exactly once on remount", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const first = render(() => (
      <RouterProvider router={memory.router}>
        <HrefProbe testId="href" />
      </RouterProvider>
    ));
    first.unmount();

    await Effect.runPromise(memory.history.simulate("/drift"));
    expect(events).toEqual([]);

    const second = render(() => (
      <RouterProvider router={memory.router}>
        <HrefProbe testId="href" />
      </RouterProvider>
    ));
    expect(second.getByTestId("href").textContent).toBe("/");

    await waitFor(() => expect(second.getByTestId("href").textContent).toBe("/drift"));
    expect(events.map((event) => event.event._tag)).toEqual(["NavigationObserved"]);
  });

  it("waits for prior disposal before rapid remount startup", async () => {
    const firstStartupStarted = await Effect.runPromise(Deferred.make<void>());
    const continueFirstStartup = await Effect.runPromise(Deferred.make<void>());
    const secondStartupStarted = await Effect.runPromise(Deferred.make<void>());
    const events: Array<Sequenced<RouterEvent>> = [];
    let startup = 0;
    const history: HistoryShape = {
      push: () => Effect.void,
      current: Effect.succeed("/"),
      changes: Stream.never,
      observe: Effect.gen(function* () {
        startup += 1;

        if (startup === 1) {
          yield* Deferred.succeed(firstStartupStarted, undefined);
          yield* Effect.uninterruptible(Deferred.await(continueFirstStartup));
        } else {
          yield* Deferred.succeed(secondStartupStarted, undefined);
        }

        return { initialHref: "/", changes: Stream.never };
      }),
    };
    const router = makeSolidRouter(
      RouterModel.make("/"),
      Layer.succeed(History, history),
      (event) => events.push(event),
    );
    const first = render(() => (
      <RouterProvider router={router}>
        <MountNavigateProbe href="/generation-1" />
      </RouterProvider>
    ));

    await Effect.runPromise(Deferred.await(firstStartupStarted));
    first.unmount();

    const second = render(() => (
      <RouterProvider router={router}>
        <MountNavigateProbe href="/generation-2" />
      </RouterProvider>
    ));

    expect(events).toEqual([]);
    expect(await Effect.runPromise(Deferred.isDone(secondStartupStarted))).toBe(false);

    await Effect.runPromise(Deferred.succeed(continueFirstStartup, undefined));
    await Effect.runPromise(Deferred.await(secondStartupStarted));

    await waitFor(() => {
      expect(events.map((fact) => fact.event)).toMatchObject([
        { _tag: "NavigationRequested", href: "/generation-2" },
        { _tag: "NavigationCommitted", href: "/generation-2" },
      ]);
    });
    expect(events).toHaveLength(2);
    expect(second.getByTestId("href").textContent).toBe("/generation-2");
  });

  it("reports disposal failure and waits before remount startup", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const firstAcquired = await Effect.runPromise(Deferred.make<void>());
    const releaseStarted = await Effect.runPromise(Deferred.make<void>());
    const finishRelease = await Effect.runPromise(Deferred.make<void>());
    const secondAcquired = await Effect.runPromise(Deferred.make<void>());
    const disposalError = new Error("history release failed");
    let acquisition = 0;
    const history: HistoryShape = {
      push: () => Effect.void,
      current: Effect.succeed("/"),
      changes: Stream.never,
      observe: Effect.succeed({ initialHref: "/", changes: Stream.never }),
    };
    const historyLayer = Layer.effect(
      History,
      Effect.acquireRelease(
        Effect.gen(function* () {
          acquisition += 1;
          yield* Deferred.succeed(acquisition === 1 ? firstAcquired : secondAcquired, undefined);
          return { history, acquisition };
        }),
        ({ acquisition: releasedAcquisition }) =>
          releasedAcquisition === 1
            ? Effect.gen(function* () {
                yield* Deferred.succeed(releaseStarted, undefined);
                yield* Deferred.await(finishRelease);
                return yield* Effect.die(disposalError);
              })
            : Effect.void,
      ).pipe(Effect.map(({ history: acquiredHistory }) => acquiredHistory)),
    );
    const router = makeSolidRouter(RouterModel.make("/"), historyLayer);
    const first = render(() => (
      <RouterProvider router={router}>
        <HrefProbe testId="first-href" />
      </RouterProvider>
    ));

    await Effect.runPromise(Deferred.await(firstAcquired));
    first.unmount();

    render(() => (
      <RouterProvider router={router}>
        <HrefProbe testId="second-href" />
      </RouterProvider>
    ));

    await Effect.runPromise(Deferred.await(releaseStarted));
    expect(await Effect.runPromise(Deferred.isDone(secondAcquired))).toBe(false);

    await Effect.runPromise(Deferred.succeed(finishRelease, undefined));
    await Effect.runPromise(Deferred.await(secondAcquired));
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));

    expect(reportError.mock.calls[0]?.[0]).toMatchObject({
      message: "@cab/router-solid: router runtime disposal failed.",
      cause: disposalError,
    });
  });

  it("keeps generation-one callbacks stale after generation two mounts", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    let staleNavigate: ((href: string) => void) | undefined;
    const first = render(() => (
      <RouterProvider router={memory.router}>
        <CaptureNavigateProbe onNavigate={(navigate) => (staleNavigate = navigate)} />
      </RouterProvider>
    ));
    first.unmount();

    const second = renderWithRouter(memory);
    expect(second.getByTestId("href").textContent).toBe("/");
    expect(() => staleNavigate?.("/stale")).toThrow(/stale router callback/);
    expect(await Effect.runPromise(memory.history.pushes)).toEqual([]);
  });

  it("throws when nesting router providers", async () => {
    const outer = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const inner = await Effect.runPromise(createMemoryRouter({ initialHref: "/inner" }));

    expect(() =>
      render(() => (
        <RouterProvider router={outer.router}>
          <RouterProvider router={inner.router}>
            <HrefProbe testId="href" />
          </RouterProvider>
        </RouterProvider>
      )),
    ).toThrow(/nested <RouterProvider>/);
  });

  it("uses custom equality for selected router state", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const onRender = vi.fn();
    render(() => (
      <RouterProvider router={memory.router}>
        <EqualityProbe onRender={onRender} />
      </RouterProvider>
    ));

    expect(onRender).toHaveBeenCalledTimes(1);

    await Effect.runPromise(memory.history.simulate("/settings"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRender).toHaveBeenCalledTimes(1);

    await Effect.runPromise(memory.history.simulate("/external"));

    await waitFor(() => {
      expect(onRender).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps two router instances independent in one tree", async () => {
    const first = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const second = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = render(() => (
      <>
        <RouterProvider router={first.router}>
          <Probe expectedRouter={first.router} />
        </RouterProvider>
        <RouterProvider router={second.router}>
          <HrefProbe testId="second-href" />
        </RouterProvider>
      </>
    ));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/settings");
    });

    expect(screen.getByTestId("second-href").textContent).toBe("/");
    expect(await Effect.runPromise(first.history.pushes)).toEqual(["/settings"]);
    expect(await Effect.runPromise(second.history.pushes)).toEqual([]);
  });

  it("converges browser routers on the shared document location", async () => {
    window.history.replaceState(null, "", "/shared-start");
    const first = createBrowserRouter();
    const second = createBrowserRouter();
    const screen = render(() => (
      <>
        <RouterProvider router={first}>
          <Probe />
        </RouterProvider>
        <RouterProvider router={second}>
          <HrefProbe testId="second-href" />
        </RouterProvider>
      </>
    ));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByTestId("href").textContent).toBe("/settings"));
    expect(screen.getByTestId("second-href").textContent).toBe("/shared-start");

    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => {
      expect(screen.getByTestId("second-href").textContent).toBe("/settings");
    });
  });

  it("keeps the model readable after startup failure and allows a later remount", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    let attempts = 0;
    let href = "/readable";
    const history: HistoryShape = {
      push: (nextHref) => Effect.sync(() => void (href = nextHref)),
      current: Effect.sync(() => href),
      changes: Stream.never,
      observe: Effect.sync(() => ({ initialHref: href, changes: Stream.never })),
    };
    const historyLayer = Layer.effect(
      History,
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new HistoryError({ reason: "window-unavailable" }))
          : Effect.succeed(history);
      }),
    );
    const router = makeSolidRouter(RouterModel.make(href), historyLayer);
    let navigate: ((href: string) => void) | undefined;
    const first = render(() => (
      <RouterProvider router={router}>
        <MountNavigateProbe />
        <CaptureNavigateProbe onNavigate={(nextNavigate) => (navigate = nextNavigate)} />
      </RouterProvider>
    ));

    expect(first.getByTestId("href").textContent).toBe("/readable");
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({
      message: "@cab/router-solid: queued router command was not dispatched.",
    });
    expect(() => navigate?.("/after-failure")).toThrow(/runtime failed to start/);
    first.unmount();

    const second = render(() => (
      <RouterProvider router={router}>
        <Probe />
      </RouterProvider>
    ));
    fireEvent.click(second.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(second.getByTestId("href").textContent).toBe("/settings"));
    expect(attempts).toBe(2);
  });

  it("isolates onEvent exceptions and continues later delivery", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const delivered: Array<string> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({
        initialHref: "/",
        onEvent: (fact) => {
          delivered.push(fact.event._tag);
          if (delivered.length === 1) throw new Error("observer failed");
        },
      }),
    );
    const screen = renderWithRouter(memory);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(delivered).toHaveLength(2));

    expect(delivered).toEqual(["NavigationRequested", "NavigationCommitted"]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("renders initialHref on the server without runtime, onEvent, or history acquisition", async () => {
    vi.stubGlobal("window", undefined);
    const onEvent = vi.fn();
    let historyAcquisitions = 0;
    const historyLayer = Layer.effect(
      History,
      Effect.sync(() => {
        historyAcquisitions += 1;
        return {
          push: () => Effect.void,
          current: Effect.succeed("/browser"),
          changes: Stream.never,
          observe: Effect.sync(() => {
            historyAcquisitions += 1;
            return { initialHref: "/browser", changes: Stream.never };
          }),
        } satisfies HistoryShape;
      }),
    );
    const router = makeSolidRouter(RouterModel.make("/request?server=true"), historyLayer, onEvent);
    let renderedHref: string | undefined;
    let navigate: ((href: string) => void) | undefined;
    let dispose: (() => void) | undefined;

    createRoot((rootDispose) => {
      dispose = rootDispose;
      createComponent(RouterProvider, {
        router,
        get children() {
          const state = useRouterState();
          navigate = useRouterNavigate();
          renderedHref = state().href;
          return undefined;
        },
      });
    });

    expect(renderedHref).toBe("/request?server=true");
    expect(onEvent).not.toHaveBeenCalled();
    expect(historyAcquisitions).toBe(0);
    expect(() => navigate?.("/client-only")).toThrow(/active browser/);

    await Promise.resolve();
    expect(historyAcquisitions).toBe(0);

    dispose?.();
    await Promise.resolve();
    expect(historyAcquisitions).toBe(0);
  });

  it("seeds createBrowserRouter from the browser location", () => {
    window.history.replaceState(null, "", "/browser?tab=one#hash");
    const router = createBrowserRouter();
    const screen = render(() => (
      <RouterProvider router={router}>
        <HrefProbe testId="href" />
      </RouterProvider>
    ));

    expect(screen.getByTestId("href").textContent).toBe("/browser?tab=one#hash");
  });

  it("throws a descriptive error when hooks are used without a provider", () => {
    expect(() => render(() => <Probe />)).toThrow(/RouterProvider/);
  });
});
