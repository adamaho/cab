import { RouterCommand, type RouterEvent } from "@cab/router";
import type { Sequenced } from "@cab/store";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";
import { createEffect } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRouterDispatch, useRouterNavigate, useRouterState } from "../src/hooks";
import { RouterProvider, useRouter } from "../src/provider";
import { createBrowserRouter, createMemoryRouter, type MemoryRouter } from "../src/router";

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

function MountNavigateProbe() {
  const state = useRouterState();
  const navigate = useRouterNavigate();

  createEffect((fired) => {
    if (!fired) {
      navigate("/mounted-effect");
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
  afterEach(() => cleanup());

  it("renders the seeded state synchronously", async () => {
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

    await Effect.runPromise(memory.history.observe("/external"));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/external");
    });

    expect(await Effect.runPromise(memory.history.pushes)).toEqual([]);
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

  it("stops subscriptions and journal taps after provider unmount", async () => {
    const events: Array<Sequenced<RouterEvent>> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const screen = renderWithRouter(memory);

    await Effect.runPromise(memory.history.observe("/mounted"));

    await waitFor(() => {
      expect(screen.getByTestId("href").textContent).toBe("/mounted");
    });

    const countBeforeUnmount = events.length;
    screen.unmount();

    await Effect.runPromise(memory.history.observe("/after-unmount"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(countBeforeUnmount);
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

  it("throws when remounting a disposed router instance", async () => {
    const memory = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = render(() => (
      <RouterProvider router={memory.router}>
        <HrefProbe testId="href" />
      </RouterProvider>
    ));

    screen.unmount();

    expect(() =>
      render(() => (
        <RouterProvider router={memory.router}>
          <HrefProbe testId="href" />
        </RouterProvider>
      )),
    ).toThrow(/disposed/);
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

    expect(() => navigate?.("/after-unmount")).toThrow(/disposed/);
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

    await Effect.runPromise(memory.history.observe("/settings"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRender).toHaveBeenCalledTimes(1);

    await Effect.runPromise(memory.history.observe("/external"));

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
