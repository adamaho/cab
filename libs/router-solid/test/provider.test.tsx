import { RouterCommand, type RouterEvent } from "@cab/router";
import { RegistryProvider } from "@effect/atom-solid";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

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
    <RegistryProvider>
      <RouterProvider router={memory.router}>
        <Probe expectedRouter={memory.router} />
      </RouterProvider>
    </RegistryProvider>
  ));
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
    const events: Array<RouterEvent> = [];
    const memory = await Effect.runPromise(
      createMemoryRouter({ initialHref: "/", onEvent: (event) => events.push(event) }),
    );
    const screen = renderWithRouter(memory);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(events.map((event) => event._tag)).toContain("NavigationCommitted");
    });
  });

  it("keeps two router instances independent in one registry", async () => {
    const first = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const second = await Effect.runPromise(createMemoryRouter({ initialHref: "/" }));
    const screen = render(() => (
      <RegistryProvider>
        <RouterProvider router={first.router}>
          <Probe expectedRouter={first.router} />
        </RouterProvider>
        <RouterProvider router={second.router}>
          <HrefProbe testId="second-href" />
        </RouterProvider>
      </RegistryProvider>
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
      <RegistryProvider>
        <RouterProvider router={router}>
          <HrefProbe testId="href" />
        </RouterProvider>
      </RegistryProvider>
    ));

    expect(screen.getByTestId("href").textContent).toBe("/browser?tab=one#hash");
  });

  it("throws a descriptive error when hooks are used without a provider", () => {
    expect(() => render(() => <Probe />)).toThrow(/RouterProvider/);
  });
});
